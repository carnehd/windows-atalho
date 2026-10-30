// Trace popup of the Logs page: every log of one request as a waterfall of spans (like Datadog), and the
// logs in order below it. Relies on logs.js (logsServiceTag, logsServiceHue, logsTime, logsPretty, runLogsSearch)
// and app.js / vault.js ($, vEl, toast, copyText). Everything from the logs goes on the page as text.
let logsTraceData = null;
let logsTraceSelected = null;
let logsTraceSetUp = false;

const LOG_TRACE_W3C = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i;
const LOG_TRACE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h6M5 7h7M7.5 10.5h6M3.5 13h4"/></svg>';

// The trace id of a log: traceId (or trace_id, trace.id), the W3C traceparent, or the same inside a JSON message.
function logsTraceIdOf(h) {
  const look = (f) => {
    if (!f || typeof f !== 'object') return null;
    const direct = f.traceId || f.trace_id || f['trace.id'] || (f.trace && f.trace.id);
    if (direct) return String(direct);
    const m = LOG_TRACE_W3C.exec(String(f.traceparent || ''));
    return m ? m[1] : null;
  };
  const fromRaw = look(h.raw);
  if (fromRaw) return fromRaw;
  if (h.json) return look(h.json); // the JSON in the message, read by the logs service
  const msg = String(h.message || '').trim();
  if (msg.startsWith('{') && msg.endsWith('}')) {
    try {
      return look(JSON.parse(msg));
    } catch {
      return null;
    }
  }
  return null;
}

// Every id of the request: the traceId and the W3C trace id of the traceparent, when they differ (Keycloak logs both).
function logsTraceIdsOf(h) {
  const ids = [];
  const look = (f) => {
    if (!f || typeof f !== 'object') return;
    for (const v of [f.traceId, f.trace_id, f['trace.id'], f.trace && f.trace.id]) if (v) ids.push(String(v));
    const m = LOG_TRACE_W3C.exec(String(f.traceparent || ''));
    if (m) ids.push(m[1]);
  };
  look(h.raw);
  const msg = String(h.message || '').trim();
  if (h.json) look(h.json);
  else if (msg.startsWith('{') && msg.endsWith('}')) {
    try {
      look(JSON.parse(msg));
    } catch {
      // not JSON after all
    }
  }
  return [...new Set(ids)];
}

const logsMs = (ms) => (ms <= 0 ? '0 ms' : ms < 1 ? '<1 ms' : ms < 10000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

async function openLogsTrace(h) {
  setupLogsTrace();
  const ids = logsTraceIdsOf(h);
  const traceId = ids[0];
  if (!traceId) {
    toast('This log has no trace id to follow', 'error');
    return;
  }
  $('#logsTraceId').dataset.ids = JSON.stringify(ids);
  $('#logsTraceId').title = ids.length > 1 ? `Logs with any of these ids:\n${ids.join('\n')}` : traceId;
  logsTraceData = null;
  logsTraceSelected = null;
  $('#logsTraceId').textContent = traceId;
  $('#logsTraceSummary').textContent = 'Looking for every log of this request...';
  $('#logsTraceBody').textContent = '';
  $('#logsTraceModal').classList.remove('hidden');
  $('#logsTraceClose').focus();
  const r = await window.logs.trace({ traceIds: ids, ts: h.ts });
  if ($('#logsTraceModal').classList.contains('hidden') || $('#logsTraceId').textContent !== traceId) return;
  if (r.error) {
    $('#logsTraceSummary').textContent = '';
    $('#logsTraceBody').appendChild(vEl('div', 'list-note logs-error', r.error));
    return;
  }
  logsTraceData = r;
  renderLogsTrace();
}

function closeLogsTrace() {
  $('#logsTraceModal').classList.add('hidden');
  logsTraceData = null;
}

function renderLogsTrace() {
  const t = logsTraceData;
  const summary = $('#logsTraceSummary');
  summary.textContent = '';
  const chip = (text, cls = '') => summary.appendChild(vEl('span', `logs-trace-chip ${cls}`.trim(), text));
  if (!t.logs.length) {
    summary.textContent = 'No logs found for this trace id in the two hours around the log.';
    return;
  }
  chip(logsMs(t.duration), 'strong');
  chip(`${t.spans.length} span${t.spans.length === 1 ? '' : 's'}`);
  chip(`${t.services} service${t.services === 1 ? '' : 's'}`);
  chip(`${t.logs.length} log${t.logs.length === 1 ? '' : 's'}`);
  chip(t.errors ? `${t.errors} error${t.errors === 1 ? '' : 's'}` : 'no errors', t.errors ? 'bad' : 'good');
  chip(`started ${logsTime(t.start)}`);
  if (t.truncated) chip(`only the first ${t.maxLogs} logs`, 'bad');

  const body = $('#logsTraceBody');
  body.textContent = '';
  const mixed = new Set(t.logs.map((l) => l.origin || 'openshift')).size > 1; // both origins: mark every line
  if (mixed) chip(`${logsOriginName('both')}`);
  const total = Math.max(1, t.duration);
  const pct = (v) => Math.max(0, Math.min(100, ((v - t.start) / total) * 100));

  // the waterfall
  const wf = vEl('div', 'lt-wf');
  const head = vEl('div', 'lt-row lt-head');
  head.appendChild(vEl('div', 'lt-name', 'Service · span'));
  const scale = vEl('div', 'lt-track lt-scale');
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const tick = vEl('span', 'lt-tick', logsMs(total * f));
    tick.style.left = `${f * 100}%`;
    scale.appendChild(tick);
  }
  head.appendChild(scale);
  head.appendChild(vEl('div', 'lt-dur', 'Duration'));
  wf.appendChild(head);
  const how = { parentSpanId: 'linked by parentSpanId', traceparent: 'linked by the W3C traceparent', time: 'linked by time (no ids)', root: 'first call', 'missing parent': 'its caller has no logs here' };
  for (const s of t.spans) {
    const row = vEl('div', `lt-row lt-span${s.error ? ' error' : ''}${logsTraceSelected === s.id ? ' selected' : ''}`);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.dataset.span = s.id;
    row.title = `${s.service} · ${s.name}\nStarts at +${logsMs(s.start - t.start)} and takes ${logsMs(s.duration)}${s.status ? ` · HTTP ${s.status}` : ''}\n${s.logs.length} log${s.logs.length === 1 ? '' : 's'} · ${how[s.linkedBy] || ''}\nClick to show only its logs below.`;
    const name = vEl('div', 'lt-name');
    name.style.paddingLeft = `${4 + s.depth * 16}px`;
    if (s.depth) name.appendChild(vEl('span', 'lt-elbow', '└'));
    if (mixed || s.origin === 'gcp') name.appendChild(logsOriginBadge(s.origin));
    name.appendChild(logsServiceTag(s.service));
    name.appendChild(vEl('span', 'lt-span-name', s.name));
    row.appendChild(name);
    const track = vEl('div', 'lt-track');
    const bar = vEl('div', 'lt-bar');
    bar.style.left = `${pct(s.start)}%`;
    bar.style.width = `${Math.max(0.4, pct(s.end) - pct(s.start))}%`;
    bar.style.setProperty('--svc-hue', String(logsServiceHue(s.service)));
    track.appendChild(bar);
    row.appendChild(track);
    row.appendChild(vEl('div', 'lt-dur', `${logsMs(s.duration)}${s.status ? ` · ${s.status}` : ''}`));
    const toggle = () => {
      logsTraceSelected = logsTraceSelected === s.id ? null : s.id;
      renderLogsTrace();
      const first = $('#logsTraceBody .lt-log.in-span');
      if (first) first.scrollIntoView({ block: 'nearest' });
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    wf.appendChild(row);
  }
  body.appendChild(wf);

  // the logs in order
  const selected = logsTraceSelected && t.spans.find((s) => s.id === logsTraceSelected);
  const inSpan = new Set(selected ? selected.logs : []);
  const title = vEl('div', 'lt-section', selected ? `Logs in order · ${selected.service} highlighted` : 'Logs in order');
  if (selected) {
    const all = vEl('button', 'logs-cell-link lt-show-all', 'Show all');
    all.type = 'button';
    all.addEventListener('click', () => { logsTraceSelected = null; renderLogsTrace(); });
    title.appendChild(all);
  }
  body.appendChild(title);
  const list = vEl('div', 'lt-logs');
  t.logs.forEach((l, i) => {
    const row = vEl('div', `lt-log logs-${l.level}${selected ? (inSpan.has(i) ? ' in-span' : ' dim') : ''}`);
    row.appendChild(vEl('span', 'lt-offset', `+${logsMs(l.ts - t.start)}`));
    const lv = vEl('span', `logs-level ${l.level}`, (l.levelRaw || l.level).toUpperCase().slice(0, 7));
    row.appendChild(lv);
    const who = vEl('span', 'lt-who');
    if (mixed || l.origin === 'gcp') who.appendChild(logsOriginBadge(l.origin));
    who.appendChild(logsServiceTag(l.service || '?'));
    row.appendChild(who);
    const msg = vEl('span', 'lt-msg', String(l.message).replace(/\s+/g, ' ').trim().slice(0, 400));
    msg.title = String(l.message).slice(0, 1000);
    row.appendChild(msg);
    row.addEventListener('click', () => {
      const next = row.nextElementSibling;
      if (next && next.classList.contains('lt-log-detail')) {
        next.remove();
        return;
      }
      // the message (its JSON first, when it has one), then the other fields; JSON inside values is opened too
      const messageName = (logsInfo && logsInfo.fields && logsInfo.fields.message) || 'message';
      const rest = { ...l.raw };
      if (l.json) delete rest[messageName];
      const pre = vEl('pre', 'logs-pre lt-log-detail', `${l.json ? JSON.stringify(logsDeepJson(l.json), null, 2) : logsPretty(l.message)}\n\n${JSON.stringify(logsDeepJson(rest), null, 2)}`);
      row.after(pre);
    });
    list.appendChild(row);
  });
  body.appendChild(list);
}

function setupLogsTrace() {
  if (logsTraceSetUp) return;
  logsTraceSetUp = true;
  $('#logsTraceClose').addEventListener('click', closeLogsTrace);
  $('#logsTraceModal').addEventListener('mousedown', (e) => {
    if (e.target.id === 'logsTraceModal') closeLogsTrace();
  });
  // on the whole page: a click on a log in the list takes the focus out of the popup
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#logsTraceModal').classList.contains('hidden')) {
      e.preventDefault();
      e.stopPropagation();
      closeLogsTrace();
    }
  }, true);
  $('#logsTraceCopy').addEventListener('click', () => copyText($('#logsTraceId').textContent, 'Trace id'));
  $('#logsTraceList').addEventListener('click', () => {
    let ids;
    try {
      ids = JSON.parse($('#logsTraceId').dataset.ids || '[]');
    } catch {
      ids = [];
    }
    if (!ids.length) ids = [$('#logsTraceId').textContent];
    // a trace across OpenShift and GCP is listed from both, as in the log-explorer
    const origins = new Set(((logsTraceData && logsTraceData.logs) || []).map((l) => l.origin || 'openshift'));
    if (origins.size > 1 && logsGcpOn() && !logsActiveWatch()) {
      logsOrigin = 'both';
      renderLogsOrigins();
    }
    closeLogsTrace();
    // the trace crosses services and error types, so it is shown on the All tab
    logsTab = { kind: 'all' };
    logsErrorType = '';
    renderLogsErrorChip();
    $('#logsQuery').value = ids.map((x) => `"${x}"`).join(' OR ');
    runLogsSearch();
  });
}
