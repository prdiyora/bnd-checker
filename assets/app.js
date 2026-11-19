// BND checker dashboard - reads the summary the checker commits to this repo.
const SUMMARY_URL =
  'https://raw.githubusercontent.com/prdiyora/bnd-checker/main/data/summary.json';

const $ = (sel) => document.querySelector(sel);

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function fmtDuration(start, end) {
  const mins = Math.round((new Date(end ?? Date.now()) - new Date(start)) / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function heartbeatBars(beats) {
  const rows = beats ?? [];
  if (!rows.length) return '<div class="bars"></div>';
  const max = Math.max(...rows.map((b) => b.ms ?? 0), 1);
  return (
    '<div class="bars">' +
    rows
      .map((b) => {
        const h = b.ms == null ? 18 : Math.max(15, Math.min(100, (b.ms / max) * 100));
        return `<span class="b ${b.s}" style="height:${h}%" title="${fmtTime(b.t)} - ${b.s}${b.ms != null ? ` - ${b.ms} ms` : ''}"></span>`;
      })
      .join('') +
    '</div>'
  );
}

function incidentRows(list) {
  if (!list?.length) return '<p class="empty">No incidents yet.</p>';
  return list
    .map((i) => {
      const open = !i.end;
      const badge = open
        ? '<span class="badge down">DOWN</span>'
        : '<span class="badge up">resolved</span>';
      const span = open
        ? `since ${fmtTime(i.start)} (${fmtDuration(i.start)} so far)`
        : `${fmtTime(i.start)} to ${fmtTime(i.end)} (${fmtDuration(i.start, i.end)})`;
      return `<div class="incident">${badge} <span class="when">${span}</span>${i.reason ? ` - ${esc(i.reason)}` : ''}</div>`;
    })
    .join('');
}

function render(data) {
  $('#updated').textContent = `Last check: ${fmtTime(data.generatedAt)} · refreshes every minute`;
  $('#app').innerHTML = data.monitors
    .map((m) => {
      const status = m.status ?? 'pending';
      return `
      <section class="monitor">
        <div class="mon-head">
          <div class="mon-name"><span class="dot ${status}"></span>${esc(m.name)}</div>
          <span class="pill ${status}">${status === 'up' ? 'Up' : status === 'down' ? 'Down' : 'Checking'}</span>
        </div>
        <p class="mon-url">${esc(m.url)} · every ${m.intervalMin} min</p>
        <div class="stats">
          <div class="stat"><div class="num">${m.uptime24h == null ? '—' : m.uptime24h + '%'}</div><div class="lbl">Uptime 24h</div></div>
          <div class="stat"><div class="num">${m.uptime7d == null ? '—' : m.uptime7d + '%'}</div><div class="lbl">Uptime 7d</div></div>
          <div class="stat"><div class="num">${m.lastLatencyMs == null ? '—' : m.lastLatencyMs + ' ms'}</div><div class="lbl">Response</div></div>
          <div class="stat"><div class="num">${fmtTime(m.since)}</div><div class="lbl">${status === 'down' ? 'Down since' : 'Up since'}</div></div>
        </div>
        ${heartbeatBars(m.heartbeats)}
        <div class="bars-caption"><span>24 hours ago</span><span>now</span></div>
        <div class="incidents">
          <h3>Incidents</h3>
          ${incidentRows(m.incidents)}
        </div>
      </section>`;
    })
    .join('');
}

async function load() {
  try {
    const res = await fetch(`${SUMMARY_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    $('#app').innerHTML = `<p class="empty">Could not load monitoring data yet (${esc(err.message)}). The first check may still be running.</p>`;
    $('#updated').textContent = '';
  }
}

load();
setInterval(load, 60_000);
