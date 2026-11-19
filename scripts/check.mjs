// BND checker - uptime check runner.
// Reads data/monitors.json, checks every due monitor, writes state/history/incidents,
// sends DOWN and UP emails on status change (like UptimeRobot does).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const HISTORY_KEEP = 2016;          // 7 days at 5-minute checks
const RETRY_DELAY_MS = 20_000;      // confirm a failure once before calling it DOWN
const DRY_RUN = process.env.DRY_RUN === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA, file), 'utf8'));
  } catch {
    return fallback;
  }
}

async function attempt(monitor) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), monitor.timeoutMs ?? 30000);
    const res = await fetch(monitor.url, {
      method: monitor.method ?? 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'BND-checker/1.0 (+https://github.com/prdiyora/bnd-checker)' },
    });
    clearTimeout(timer);
    const ms = Date.now() - started;
    const expected = monitor.expectStatus ?? 200;
    if (res.status === expected) return { ok: true, ms, code: res.status };
    return { ok: false, ms, code: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    const ms = Date.now() - started;
    const reason = err.name === 'AbortError' ? 'timeout' : (err.cause?.code ?? err.message);
    return { ok: false, ms, error: String(reason) };
  }
}

async function check(monitor) {
  let result = await attempt(monitor);
  if (!result.ok) {
    // One retry so a single network blip never becomes a false DOWN alert.
    await sleep(RETRY_DELAY_MS);
    result = await attempt(monitor);
  }
  return result;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

function fmtDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} min`;
}

let transporter = null;
async function getTransporter() {
  if (DRY_RUN) return null;
  if (!transporter) {
    const { default: nodemailer } = await import('nodemailer');
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

async function sendMail(subject, text) {
  const to = process.env.ALERT_TO ?? process.env.GMAIL_USER;
  if (DRY_RUN) {
    console.log(`[dry-run] mail to ${to}: ${subject}`);
    return true;
  }
  try {
    const t = await getTransporter();
    await t.sendMail({ from: `BND checker <${process.env.GMAIL_USER}>`, to, subject, text });
    console.log(`mail sent to ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`mail failed (${err.message}); state change held, will retry on the next run`);
    return false;
  }
}

async function main() {
  const monitors = (await readJson('monitors.json', [])).filter((m) => m.enabled !== false);
  const state = await readJson('state.json', { monitors: {} });
  const incidents = await readJson('incidents.json', []);
  const now = new Date();

  for (const monitor of monitors) {
    const st = state.monitors[monitor.id] ?? { status: 'pending', lastCheck: null };
    if (st.lastCheck) {
      const due = new Date(st.lastCheck).getTime() + (monitor.intervalMin ?? 5) * 60000;
      if (Date.now() < due - 15_000) continue; // not due yet, skip this run
    }

    const result = await check(monitor);
    const status = result.ok ? 'up' : 'down';
    console.log(`${monitor.name}: ${status}${result.ms != null ? ` (${result.ms} ms)` : ''}${result.error ? ` - ${result.error}` : ''}`);

    // heartbeat history
    const histFile = path.join(DATA, 'history', `${monitor.id}.json`);
    let history = [];
    try { history = JSON.parse(await readFile(histFile, 'utf8')); } catch {}
    history.push({ t: now.toISOString(), s: status, ms: result.ms ?? null });
    if (history.length > HISTORY_KEEP) history = history.slice(-HISTORY_KEEP);
    await mkdir(path.join(DATA, 'history'), { recursive: true });
    await writeFile(histFile, JSON.stringify(history));

    // status change -> incident + email. The transition is only recorded once
    // the alert mail actually went out, so a mail failure is retried next run.
    const prev = st.status;
    if (status === 'down' && prev !== 'down') {
      const mailed = await sendMail(
        `DOWN: ${monitor.name}`,
        [
          `${monitor.name} is DOWN.`,
          ``,
          `URL: ${monitor.url}`,
          `Reason: ${result.error ?? 'no response'}`,
          `Since: ${fmtTime(now.toISOString())} IST`,
          ``,
          `BND checker will mail you again when it comes back up.`,
        ].join('\n'),
      );
      if (!mailed) continue;
      incidents.push({
        monitorId: monitor.id,
        name: monitor.name,
        start: now.toISOString(),
        end: null,
        reason: result.error ?? 'no response',
      });
    } else if (status === 'up' && prev === 'down') {
      const open = incidents.findLast((i) => i.monitorId === monitor.id && !i.end);
      let downtime = '';
      if (open) downtime = fmtDuration(now - new Date(open.start));
      const mailed = await sendMail(
        `UP again: ${monitor.name}`,
        [
          `${monitor.name} is back UP.`,
          ``,
          `URL: ${monitor.url}`,
          `Response time: ${result.ms} ms`,
          downtime ? `Downtime: ${downtime}` : null,
          ``,
          `- BND checker`,
        ].filter(Boolean).join('\n'),
      );
      if (!mailed) continue;
      if (open) open.end = now.toISOString();
    }

    state.monitors[monitor.id] = {
      status,
      since: prev === status ? (st.since ?? now.toISOString()) : now.toISOString(),
      lastCheck: now.toISOString(),
      lastLatencyMs: result.ms ?? null,
      lastError: result.ok ? null : (result.error ?? 'no response'),
    };
  }

  // summary.json for the dashboard
  const summary = { generatedAt: now.toISOString(), monitors: [] };
  for (const monitor of monitors) {
    const st = state.monitors[monitor.id];
    if (!st) continue;
    let history = [];
    try { history = JSON.parse(await readFile(path.join(DATA, 'history', `${monitor.id}.json`), 'utf8')); } catch {}
    const windowOf = (hours) => history.filter((h) => Date.now() - new Date(h.t) < hours * 3600_000);
    const uptimeOf = (rows) => rows.length ? +(100 * rows.filter((r) => r.s === 'up').length / rows.length).toFixed(2) : null;
    const day = windowOf(24);
    const lat = day.filter((r) => r.ms != null).map((r) => r.ms);
    summary.monitors.push({
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      intervalMin: monitor.intervalMin ?? 5,
      status: st.status,
      since: st.since,
      lastCheck: st.lastCheck,
      lastLatencyMs: st.lastLatencyMs,
      lastError: st.lastError,
      uptime24h: uptimeOf(day),
      uptime7d: uptimeOf(history),
      avgMs24h: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      heartbeats: history.slice(-288),
      incidents: incidents.filter((i) => i.monitorId === monitor.id).slice(-20).reverse(),
    });
  }

  await writeFile(path.join(DATA, 'state.json'), JSON.stringify(state, null, 2));
  await writeFile(path.join(DATA, 'incidents.json'), JSON.stringify(incidents, null, 2));
  await writeFile(path.join(DATA, 'summary.json'), JSON.stringify(summary));
  console.log('state, incidents and summary written');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
