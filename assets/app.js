// BND checker dashboard - reads the data the checker commits to this repo.
//
// config      - endpoints and intervals
// time utils  - IST day keys, clocks, durations
// data layer  - fetch + in-memory cache of summary/history JSON
// render      - summary strip, quick actions, monitor cards, day log, incidents
// main        - polling, visibility refresh, bottom-nav state

// ---------- config ----------
const SUMMARY_URL =
  'https://raw.githubusercontent.com/prdiyora/bnd-checker/main/data/summary.json';
const HISTORY_URL = (id) =>
  `https://raw.githubusercontent.com/prdiyora/bnd-checker/main/data/history/${id}.json`;
const REFRESH_MS = 60_000;
const ROW_BATCH = 100;

const $ = (sel) => document.querySelector(sel);
const BUCKETS = 48;                 // 48 x 30 min = 24 hours
const BUCKET_MS = 30 * 60 * 1000;

// ---------- time utils (all display times are Asia/Kolkata) ----------
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

// IST calendar-day key, e.g. 2026-11-20. Days on the day log are IST days.
function dayKey(t) {
  return new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fmtDayLabel(key) {
  return new Date(`${key}T12:00:00+05:30`).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- state ----------
let lastData = null;
const histories = {};               // monitor id -> [{t, s, ms}] from data/history/
const daylogDay = {};               // monitor id -> 'today' | 'yesterday'
const daylogFailuresOnly = {};      // monitor id -> bool
const daylogShown = {};             // monitor id -> rows currently rendered
let incidentsExpanded = false;

// ---------- summary strip ----------
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
  $('#overview').hidden = false;
  $('#overview').innerHTML = `
    <div class="sum-status">
      <div class="lbl">Overall system health</div>
      <div class="txt ${cls}">${txt}</div>
      <div class="sub">Monitoring ${total} endpoint${total === 1 ? '' : 's'}</div>
    </div>
    <div class="sum-cell"><div class="lbl">Monitors up</div><div class="num ok">${up}</div></div>
    <div class="sum-cell"><div class="lbl">Down</div><div class="num ${down ? 'bad' : ''}">${down}</div></div>
    <div class="sum-cell"><div class="lbl">Avg response</div><div class="num">${avg ?? '—'}${avg != null ? '<span class="unit">ms</span>' : ''}</div></div>`;
}

// ---------- quick action buttons ----------
function quickActions(monitors) {
  const links = monitors.flatMap((m) => m.links ?? []);
  if (!links.length) { $('#quick-actions').hidden = true; return; }
  // Base URL first, then health endpoint; both 56px one-tap targets.
  const sorted = [...links].sort((a, b) => (/base/i.test(b.label) ? 1 : 0) - (/base/i.test(a.label) ? 1 : 0));
  $('#quick-actions').hidden = false;
  $('#quick-actions').innerHTML = sorted.map((l) =>
    `<a class="qa-btn${/base/i.test(l.label) ? ' primary' : ''}" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>
       <span><strong>${esc(l.label.replace(/\s*↗\s*$/, ''))}</strong><small>${esc(new URL(l.url).hostname)}</small></span>
     </a>`).join('');
}

// ---------- heartbeat ----------
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
      <div class="hb-caption"><span>Last 24 hours</span></div>
      <div class="heartbeat">${bars}</div>
      <div class="hb-axis"><span>24h ago</span><span>now</span></div>
    </div>`;
}

// ---------- monitor card ----------
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
          <a class="mon-url" href="${esc(m.url)}" target="_blank" rel="noopener" title="${esc(m.url)}">${esc(m.url)}</a>
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
      <div class="mon-foot">${foot}<a href="#logs" class="view-checks" data-mon="${esc(m.id)}">View checks</a></div>
    </article>`;
}

// ---------- full day log ----------
function logRowsFor(m) {
  const mode = daylogDay[m.id] ?? 'today';
  const key = mode === 'today' ? dayKey(Date.now()) : dayKey(Date.now() - 24 * 3600 * 1000);
  const entries = (histories[m.id] ?? m.heartbeats ?? []).filter((e) => dayKey(e.t) === key);
  entries.sort((a, b) => new Date(b.t) - new Date(a.t));
  return { mode, key, entries };
}

function renderDaylog() {
  const box = $('#logs');
  if (!lastData?.monitors?.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `
    <h2>Full day log</h2>
    <p class="inc-note">Every single check, saved. Pick a day to see the complete record.</p>
    ${lastData.monitors.map((m) => {
      const { mode, key, entries } = logRowsFor(m);
      const up = entries.filter((e) => e.s === 'up').length;
      const down = entries.length - up;
      const pct = entries.length ? ((100 * up) / entries.length).toFixed(1) : null;
      const failOnly = !!daylogFailuresOnly[m.id];
      const visible = failOnly ? entries.filter((e) => e.s !== 'up') : entries;
      const shown = daylogShown[m.id] ?? ROW_BATCH;
      const rows = visible.slice(0, shown).map((e) => {
        const bad = e.s !== 'up';
        const resp = bad && e.ms >= 30000 ? 'timeout' : e.ms == null ? '—' : `${e.ms} ms`;
        return `<tr class="${bad ? 'is-down' : ''}">
          <td>${fmtClock(e.t)}</td>
          <td><span class="lg-st ${bad ? 'down' : 'up'}">${bad ? 'DOWN' : 'UP'}</span></td>
          <td>${resp}</td>
        </tr>`;
      }).join('');
      return `<div class="dl-mon">
        <div class="dl-head">
          <span class="dl-name">${esc(m.name)}</span>
          <span class="dl-tabs" role="tablist">
            <button class="dl-tab${mode === 'today' ? ' active' : ''}" data-mon="${esc(m.id)}" data-day="today">Today</button>
            <button class="dl-tab${mode === 'yesterday' ? ' active' : ''}" data-mon="${esc(m.id)}" data-day="yesterday">Yesterday</button>
          </span>
        </div>
        <div class="dl-chips">
          <div class="dl-chip"><div class="num">${entries.length}</div><div class="lbl">Checks</div></div>
          <div class="dl-chip"><div class="num ok">${up}</div><div class="lbl">Up</div></div>
          <div class="dl-chip"><div class="num ${down ? 'bad' : ''}">${down}</div><div class="lbl">Down</div></div>
          <div class="dl-chip"><div class="num">${pct == null ? '—' : pct + '%'}</div><div class="lbl">Uptime</div></div>
        </div>
        ${entries.length ? `
        <div class="dl-tools">
          <button class="dl-filter${failOnly ? ' active' : ''}" data-mon="${esc(m.id)}">${failOnly ? '✓ ' : ''}Failures only</button>
          <span class="dl-count">${visible.length === entries.length ? `${entries.length} rows` : `${visible.length} of ${entries.length}`}</span>
        </div>
        <div class="log-scroll" data-mon="${esc(m.id)}"><table class="log-table">
          <thead><tr><th>Time</th><th>Status</th><th>Response</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${visible.length > shown ? `<p class="dl-more">Showing ${shown} of ${visible.length} - scroll for more</p>` : ''}
        </div>
        <p class="dl-note">${fmtDayLabel(key)} · newest first · 7 days of checks stay on the site; the repo keeps every check forever.</p>`
        : `<p class="empty">No checks recorded for ${fmtDayLabel(key)}.</p>`}
      </div>`;
    }).join('')}`;

  box.querySelectorAll('.dl-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      daylogDay[btn.dataset.mon] = btn.dataset.day;
      daylogShown[btn.dataset.mon] = ROW_BATCH;
      renderDaylog();
    });
  });
  box.querySelectorAll('.dl-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      daylogFailuresOnly[btn.dataset.mon] = !daylogFailuresOnly[btn.dataset.mon];
      daylogShown[btn.dataset.mon] = ROW_BATCH;
      renderDaylog();
    });
  });
  // Incremental rendering: append the next batch near the bottom.
  box.querySelectorAll('.log-scroll').forEach((sc) => {
    sc.addEventListener('scroll', () => {
      if (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 200) return;
      const id = sc.dataset.mon;
      const { entries } = logRowsFor(id ? lastData.monitors.find((m) => m.id === id) ?? {} : {});
      if (!id) return;
      const failOnly = !!daylogFailuresOnly[id];
      const total = (failOnly ? entries.filter((e) => e.s !== 'up') : entries).length;
      const shown = daylogShown[id] ?? ROW_BATCH;
      if (shown < total) {
        daylogShown[id] = shown + ROW_BATCH;
        const pos = sc.scrollTop;
        renderDaylog();
        const sc2 = box.querySelector(`.log-scroll[data-mon="${id}"]`);
        if (sc2) sc2.scrollTop = pos;
      }
    }, { passive: true });
  });
}

// ---------- incidents ----------
function incidentsSection(monitors) {
  const all = monitors.flatMap((m) => (m.incidents ?? [])).sort((a, b) => new Date(b.start) - new Date(a.start));
  const box = $('#incidents');
  if (!all.length) { box.hidden = true; return; }
  box.hidden = false;
  const shown = incidentsExpanded ? all : all.slice(0, 5);
  box.innerHTML = `
    <h2>Alerts &amp; incidents</h2>
    <p class="inc-note">The same DOWN / UP events that go out by email.</p>
    ${shown.map((i) => {
      const open = !i.end;
      const span = open
        ? `since ${fmtTime(i.start)} · ongoing (${fmtDuration(i.start)})`
        : `${fmtTime(i.start)} → ${fmtTime(i.end)} · was down ${fmtDuration(i.start, i.end)}`;
      return `<div class="incident">
        <span class="inc-dot ${open ? 'down' : 'up'}"></span>
        <span><strong>${open ? 'DOWN' : 'UP again'}</strong> <span class="mon">${esc(i.name ?? i.monitorId)}</span> · <span class="when">${span}</span>${i.reason ? ` · ${esc(i.reason)}` : ''}</span>
      </div>`;
    }).join('')}
    ${all.length > 5 ? `<button class="show-more" id="show-more">${incidentsExpanded ? 'Show less' : `Show all ${all.length}`}</button>` : ''}`;
  const btn = $('#show-more');
  if (btn) btn.addEventListener('click', () => { incidentsExpanded = !incidentsExpanded; incidentsSection(monitors); });
}

// ---------- render ----------
function render(data) {
  summaryStrip(data.monitors);
  quickActions(data.monitors);
  $('#app').innerHTML = data.monitors.map(monitorCard).join('');
  renderDaylog();
  incidentsSection(data.monitors);
  document.querySelectorAll('.view-checks').forEach((a) => {
    a.addEventListener('click', () => {
      // Select this monitor's log tab; the anchor jump is native.
      if (a.dataset.mon) daylogShown[a.dataset.mon] = ROW_BATCH;
    });
  });
}

function tickUpdated() {
  if (!lastData) return;
  $('#updated').textContent = `Checked ${fmtAgo(lastData.generatedAt)}`;
}

// ---------- data layer ----------
async function load() {
  try {
    const res = await fetch(`${SUMMARY_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastData = await res.json();
    await Promise.all(lastData.monitors.map(async (m) => {
      try {
        const r = await fetch(`${HISTORY_URL(m.id)}?t=${Date.now()}`, { cache: 'no-store' });
        if (r.ok) histories[m.id] = await r.json();
      } catch { /* keep whatever history we had */ }
    }));
    render(lastData);
  } catch (err) {
    if (!lastData) {
      $('#app').innerHTML = `<p class="empty">Could not load monitoring data yet (${esc(err.message)}). The first check may still be running.</p>`;
    }
    // On later failures keep the last good data on screen.
  }
}

// ---------- main ----------
load();
tickUpdated();
setInterval(tickUpdated, 10_000);
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
// Phone browsers suspend background timers: refresh when the owner returns.
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

// Bottom-nav active state follows scroll.
const navItems = [...document.querySelectorAll('.bn-item')];
const sections = ['overview', 'logs', 'incidents'].map((id) => document.getElementById(id));
window.addEventListener('scroll', () => {
  let current = 'overview';
  for (const sec of sections) {
    if (sec && !sec.hidden && sec.getBoundingClientRect().top <= 120) current = sec.id;
  }
  navItems.forEach((n) => n.classList.toggle('active', n.dataset.nav === current));
}, { passive: true });
