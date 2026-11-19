// BND checker dashboard - reads the summary the checker commits to this repo.
const SUMMARY_URL =
  'https://raw.githubusercontent.com/prdiyora/bnd-checker/main/data/summary.json';

const $ = (sel) => document.querySelector(sel);
const BUCKETS = 48;                 // 48 x 30 min = 24 hours
const BUCKET_MS = 30 * 60 * 1000;

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function fmtAgo(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s} sec ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min ago`;
}

function fmtDuration(start, end) {
  const mins = Math.round((new Date(end ?? Date.now()) - new Date(start)) / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Fold the raw 5-minute heartbeats into 48 half-hour availability buckets.
function bucketize(beats) {
  const now = Date.now();
  const buckets = Array.from({ length: BUCKETS }, (_, i) => ({
    start: now - (BUCKETS - i) * BUCKET_MS,
    total: 0,
    up: 0,
  }));
  for (const b of beats ?? []) {
    const t = new Date(b.t).getTime();
    const idx = Math.floor((t - (now - BUCKETS * BUCKET_MS)) / BUCKET_MS);
    if (idx < 0 || idx >= BUCKETS) continue;
    buckets[idx].total++;
    if (b.s === 'up') buckets[idx].up++;
  }
  return buckets;
}

function heartbeatHtml(beats) {
  const buckets = bucketize(beats);
  const bars = buckets.map((bk, i) => {
    const state = bk.total === 0 ? 'unknown' : bk.up === bk.total ? 'up' : bk.up === 0 ? 'down' : 'partial';
    const pct = bk.total ? ((100 * bk.up) / bk.total).toFixed(1) + '% available' : 'no checks';
    const from = new Date(bk.start).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
    const to = new Date(bk.start + BUCKET_MS).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
    const latest = i === buckets.length - 1 ? ' latest' : '';
    return `<span class="hb-bar ${state}${latest}" title="${from}–${to} · ${pct}"></span>`;
  }).join('');
  return `
    <div class="hb-wrap">
      <div class="hb-caption"><span>24-hour heartbeat</span></div>
      <div class="heartbeat">${bars}</div>
      <div class="hb-axis"><span>24 hours ago</span><span>now</span></div>
    </div>`;
}

function monitorCard(m) {
  const status = m.status ?? 'pending';
  const resp = status === 'down' && m.lastError ? esc(m.lastError)
    : m.lastLatencyMs == null ? '—' : `${m.lastLatencyMs}<span class="unit"> ms</span>`;
  const downSince = status === 'down' ? fmtTime(m.since) : '—';
  const foot = status === 'down'
    ? `<span class="incident-live">Incident started ${fmtAgo(m.since)}</span>`
    : `<span>Last checked ${fmtAgo(m.lastCheck)}</span>`;
  return `
    <article class="monitor-card">
      <div class="mon-head">
        <div>
          <div class="mon-name"><span class="status-dot ${status}"></span>${esc(m.name)}</div>
          <p class="mon-url" title="${esc(m.url)}">${esc(m.url)}</p>
          ${(m.links ?? []).length ? `<p class="mon-links">${m.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}</p>` : ''}
        </div>
        <span class="pill ${status}">${status === 'up' ? 'Up' : status === 'down' ? 'Down' : 'Checking'}</span>
      </div>
      <div class="stats">
        <div class="stat"><div class="num">${m.uptime24h == null ? '—' : m.uptime24h + '%'}</div><div class="lbl">Uptime 24h</div></div>
        <div class="stat"><div class="num">${m.uptime7d == null ? '—' : m.uptime7d + '%'}</div><div class="lbl">Uptime 7d</div></div>
        <div class="stat"><div class="num">${resp}</div><div class="lbl">Response</div></div>
        <div class="stat"><div class="num" style="font-size:13px">${downSince}</div><div class="lbl">Down since</div></div>
      </div>
      ${heartbeatHtml(m.heartbeats)}
      <div class="mon-foot">${foot}<span>HTTPS · every ${m.intervalMin} min</span></div>
    </article>`;
}

function summaryStrip(monitors) {
  const up = monitors.filter((m) => m.status === 'up').length;
  const down = monitors.filter((m) => m.status === 'down').length;
  const lat = monitors.filter((m) => m.status === 'up' && m.lastLatencyMs != null).map((m) => m.lastLatencyMs);
  const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
  const total = monitors.length;
  const [txt, cls] = total === 0 ? ['Monitoring data unavailable', 'none']
    : down === 0 ? ['All systems operational', 'ok']
    : up === 0 ? ['All monitored services down', 'bad']
    : ['Service disruption detected', 'warn'];
  $('#summary').hidden = false;
  $('#summary').innerHTML = `
    <div class="sum-status">
      <div class="lbl">Overall system health</div>
      <div class="txt ${cls}">${txt}</div>
      <div class="sub">Monitoring ${total} endpoint${total === 1 ? '' : 's'}</div>
    </div>
    <div class="sum-cell"><div class="lbl">Monitors up</div><div class="num ok">${up}</div></div>
    <div class="sum-cell"><div class="lbl">Down</div><div class="num ${down ? 'bad' : ''}">${down}</div></div>
    <div class="sum-cell"><div class="lbl">Avg response</div><div class="num">${avg ?? '—'}${avg != null ? '<span class="unit">ms</span>' : ''}</div></div>`;
}

let incidentsExpanded = false;
function incidentsSection(monitors) {
  const all = monitors.flatMap((m) => (m.incidents ?? [])).sort((a, b) => new Date(b.start) - new Date(a.start));
  const box = $('#incidents');
  if (!all.length) { box.hidden = true; return; }
  box.hidden = false;
  const shown = incidentsExpanded ? all : all.slice(0, 5);
  box.innerHTML = `
    <h2>Recent incidents</h2>
    ${shown.map((i) => {
      const open = !i.end;
      const span = open
        ? `${fmtTime(i.start)} · ongoing (${fmtDuration(i.start)})`
        : `${fmtTime(i.start)} · ${fmtDuration(i.start, i.end)}`;
      return `<div class="incident">
        <span class="inc-dot ${open ? 'down' : 'up'}"></span>
        <span><strong>${open ? 'Down' : 'Recovered'}</strong> <span class="mon">${esc(i.name ?? i.monitorId)}</span> · <span class="when">${span}</span>${i.reason ? ` · ${esc(i.reason)}` : ''}</span>
      </div>`;
    }).join('')}
    ${all.length > 5 ? `<button class="show-more" id="show-more">${incidentsExpanded ? 'Show less' : `Show all ${all.length}`}</button>` : ''}`;
  const btn = $('#show-more');
  if (btn) btn.addEventListener('click', () => { incidentsExpanded = !incidentsExpanded; incidentsSection(monitors); });
}

function render(data) {
  $('#updated').textContent = `Last check: ${fmtTime(data.generatedAt)} · page refreshes every minute`;
  summaryStrip(data.monitors);
  $('#app').innerHTML = data.monitors.map(monitorCard).join('');
  incidentsSection(data.monitors);
}

async function load() {
  try {
    const res = await fetch(`${SUMMARY_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    $('#app').innerHTML = `<p class="empty">Could not load monitoring data yet (${esc(err.message)}). The first check may still be running.</p>`;
  }
}

load();
setInterval(load, 60_000);
