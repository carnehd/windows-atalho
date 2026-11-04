// Analysis > Calls between microservices: the map of who calls whom (service-map.js gathers it). The microservices in
// columns, the callers on the left and what they call to their right; databases, brokers and other hosts last. An
// arrow for each call: solid when seen on the network while watching (how many times, or how many are open), dashed
// when only the configuration says it, yellow when it points at a port nothing listens on. A microservice chosen on the
// map shows what it calls and what calls it, and why each one is there.
// Relies on helpers from app.js ($, toast) and tools.js (tEl, toolHead, toolButton, toolCopy).

const CALLS_FILTER_KEY = 'callsFilter';
const CALLS_BOX = { w: 196, h: 58, gapX: 118, gapY: 30, pad: 18, head: 26 };
const CALLS_POLL_MS = 3000;

const callsEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const callsCut = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const callsPlural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "2 min 14 s", "41 s", "1 h 3 min"
function callsSpan(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

// What an arrow is: seen on the network, only in the configuration, or configured to a port nothing listens on.
function callsEdgeKind(e, byId) {
  const to = byId.get(e.to);
  if (e.seen) return 'seen';
  return to && to.kind === 'nothing' ? 'warn' : 'config';
}
// What is written on an arrow: how many times it was seen (or how many are open), its topics, or the port nothing
// listens on.
function callsEdgeLabel(e, byId) {
  const topics = e.topics && e.topics.length ? callsCut(e.topics.join(', '), 26) : '';
  if (e.seen) {
    const seen = e.seen.open > 0 && e.seen.open >= e.seen.count ? `${e.seen.open} open` : `${e.seen.count}×`;
    return topics ? `${topics} · ${seen}` : seen;
  }
  const to = byId.get(e.to);
  if (to && to.kind === 'nothing') return `nothing on :${to.port}`;
  return topics;
}

// The line under a node's name.
function callsNodeSub(n) {
  if (n.kind !== 'service') return n.sub || '';
  const r = n.running;
  if (!r) return `not running${n.port ? ` · :${n.port}` : ''}`;
  const how = r.how === 'container' ? `container (${String(r.engine || 'docker').toLowerCase()})` : r.how;
  const ports = (r.ports || []).length ? ` · :${r.ports[0]}${r.ports.length > 1 ? ` +${r.ports.length - 1}` : ''}` : n.port ? ` · :${n.port}` : '';
  return `${how}${ports}`;
}

// The nodes and arrows a filter shows: every arrow, those seen, or those of the configuration; the running
// microservices too (but for the configuration's).
function callsShown(data, filter) {
  const edges = data.edges.filter((e) => (filter === 'seen' ? Boolean(e.seen) : filter === 'config' ? e.config.length > 0 : true));
  const ids = new Set(edges.flatMap((e) => [e.from, e.to]));
  const nodes = data.nodes.filter((n) => ids.has(n.id) || (filter !== 'config' && n.kind === 'service' && n.running));
  return { nodes, edges };
}

// Where each node goes: the clients (Bruno, a browser) first, the microservices in columns by how deep in the calls
// they are (one no other calls first), what is not a microservice in a last column; in a column, next to what they are
// linked to (two sweeps).
function callsLayout(nodes, edges) {
  const B = CALLS_BOX;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isSvc = (id) => byId.has(id) && byId.get(id).kind === 'service';
  const svc = nodes.filter((n) => n.kind === 'service');
  const depth = new Map(svc.map((n) => [n.id, 0]));
  const svcEdges = edges.filter((e) => isSvc(e.from) && isSvc(e.to) && e.from !== e.to);
  for (let i = 0; i < svc.length; i++) {
    let moved = false;
    for (const e of svcEdges) {
      const d = depth.get(e.from) + 1;
      if (d > depth.get(e.to) && d < svc.length) {
        depth.set(e.to, d);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const maxD = svc.length ? Math.max(...depth.values()) : -1;
  const clients = nodes.some((n) => n.kind === 'client') ? 1 : 0;
  const rank = { infra: 0, outside: 1, nothing: 2 };
  const colOf = new Map(nodes.map((n) => [n.id, n.kind === 'client' ? 0 : n.kind === 'service' ? clients + depth.get(n.id) : clients + maxD + 1]));
  const cols = [];
  for (const n of [...nodes].sort((a, b) => (rank[a.kind] ?? -1) - (rank[b.kind] ?? -1) || a.name.localeCompare(b.name))) {
    const c = colOf.get(n.id);
    (cols[c] = cols[c] || []).push(n.id);
  }
  for (let c = 0; c < cols.length; c++) cols[c] = cols[c] || [];
  const at = new Map();
  const index = () => cols.forEach((col) => col.forEach((id, i) => at.set(id, i)));
  index();
  const links = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!links.has(e.from) || !links.has(e.to)) continue;
    links.get(e.from).push(e.to);
    links.get(e.to).push(e.from);
  }
  const sweep = (range, side) => {
    for (const c of range) {
      const centre = (id) => {
        const near = links.get(id).filter((o) => (side < 0 ? colOf.get(o) < c : colOf.get(o) > c));
        return near.length ? near.reduce((s, o) => s + at.get(o), 0) / near.length : at.get(id);
      };
      const score = new Map(cols[c].map((id) => [id, centre(id)]));
      cols[c].sort((a, b) => score.get(a) - score.get(b));
      index();
    }
  };
  const all = [...cols.keys()];
  sweep(all.slice(1), -1);
  sweep(all.slice(0, -1).reverse(), 1);
  const rows = Math.max(1, ...cols.map((c) => c.length));
  const pos = new Map();
  cols.forEach((col, c) => {
    const offset = ((rows - col.length) * (B.h + B.gapY)) / 2;
    col.forEach((id, i) => pos.set(id, { x: B.pad + c * (B.w + B.gapX), y: B.pad + B.head + offset + i * (B.h + B.gapY), col: c }));
  });
  return {
    pos,
    cols,
    clients,
    services: maxD + 1,
    width: B.pad * 2 + Math.max(1, cols.length) * B.w + Math.max(0, cols.length - 1) * B.gapX,
    height: B.pad * 2 + B.head + rows * (B.h + B.gapY) - B.gapY,
  };
}

// A point of a cubic curve.
function callsCurve(p, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p[0].x + 3 * u * u * t * p[1].x + 3 * u * t * t * p[2].x + t * t * t * p[3].x,
    y: u * u * u * p[0].y + 3 * u * u * t * p[1].y + 3 * u * t * t * p[2].y + t * t * t * p[3].y,
  };
}

// The arrows' curves: out of the right of a node into the left of one further right; back to the right of one further
// left; around the right side within a column. Arrows of a node spread along its side, in the order of where they go.
function callsPaths(edges, layout) {
  const B = CALLS_BOX;
  const { pos } = layout;
  const side = new Map(); // node -> its arrows on a side, to spread them
  const put = (id, s, e, y) => {
    const k = `${id}|${s}`;
    if (!side.has(k)) side.set(k, []);
    side.get(k).push({ e, y });
  };
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const forward = b.col > a.col;
    put(e.from, forward ? 'r' : b.col < a.col ? 'l' : 'r', e, b.y);
    put(e.to, forward ? 'l' : 'r', e, a.y);
  }
  const shift = new Map();
  for (const [k, list] of side) {
    list.sort((p, q) => p.y - q.y);
    const step = Math.min(9, (B.h - 16) / Math.max(1, list.length - 1));
    list.forEach((p, i) => shift.set(`${k}|${p.e.from}|${p.e.to}`, (i - (list.length - 1) / 2) * step));
  }
  const dy = (id, s, e) => shift.get(`${id}|${s}|${e.from}|${e.to}`) || 0;
  return edges.filter((e) => pos.get(e.from) && pos.get(e.to)).map((e) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    let pts;
    if (b.col > a.col) {
      const p0 = { x: a.x + B.w, y: a.y + B.h / 2 + dy(e.from, 'r', e) };
      const p3 = { x: b.x, y: b.y + B.h / 2 + dy(e.to, 'l', e) };
      const mx = (p0.x + p3.x) / 2;
      pts = [p0, { x: mx, y: p0.y }, { x: mx, y: p3.y }, p3];
    } else if (b.col < a.col) {
      const p0 = { x: a.x, y: a.y + B.h / 2 + dy(e.from, 'l', e) };
      const p3 = { x: b.x + B.w, y: b.y + B.h / 2 + dy(e.to, 'r', e) };
      const mx = (p0.x + p3.x) / 2;
      pts = [p0, { x: mx, y: p0.y }, { x: mx, y: p3.y }, p3];
    } else {
      const p0 = { x: a.x + B.w, y: a.y + B.h / 2 + dy(e.from, 'r', e) };
      const p3 = { x: b.x + B.w, y: b.y + B.h / 2 + dy(e.to, 'r', e) };
      const out = Math.min(B.gapX - 20, 40 + Math.abs(p3.y - p0.y) / 4);
      pts = [p0, { x: p0.x + out, y: p0.y }, { x: p3.x + out, y: p3.y }, p3];
    }
    return { e, pts };
  });
}

// The map as SVG: arrows under the nodes, their labels placed where they do not cover another one or a node.
function callsSvg(shown, layout, selected) {
  const B = CALLS_BOX;
  const byId = new Map(shown.nodes.map((n) => [n.id, n]));
  const paths = callsPaths(shown.edges, layout);
  const boxes = [...layout.pos.values()].map((p) => ({ x: p.x - 2, y: p.y - 2, w: B.w + 4, h: B.h + 4 }));
  const hits = (r) => boxes.some((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
  const colour = { seen: 'var(--accent)', config: 'var(--text-dim)', warn: 'var(--yellow)' };
  const arrows = [];
  const labels = [];
  for (const { e, pts } of paths) {
    const kind = callsEdgeKind(e, byId);
    const dash = kind === 'seen' ? '' : ' stroke-dasharray="6 5"';
    const linked = selected && (e.from === selected || e.to === selected);
    const faded = selected && !linked ? ' opacity="0.35"' : '';
    const d = `M${pts[0].x},${pts[0].y} C${pts[1].x},${pts[1].y} ${pts[2].x},${pts[2].y} ${pts[3].x - 2},${pts[3].y}`;
    arrows.push(`<path class="calls-arrow" d="${d}" fill="none" stroke="${colour[kind]}" stroke-width="${linked ? 2.2 : 1.6}"${dash}${faded} marker-end="url(#calls-head-${kind})"><title>${callsEsc(`${byId.get(e.from).name} → ${byId.get(e.to).name}`)}</title></path>`);
    const text = callsEdgeLabel(e, byId);
    if (!text) continue;
    const w = text.length * 6.4 + 14;
    let spot = null;
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78]) {
      const p = callsCurve(pts, t);
      const r = { x: p.x - w / 2, y: p.y - 10, w, h: 20 };
      if (!hits(r)) {
        spot = r;
        break;
      }
    }
    if (!spot) {
      const p = callsCurve(pts, 0.5);
      spot = { x: p.x - w / 2, y: p.y - 10, w, h: 20 };
    }
    boxes.push(spot);
    labels.push(`<g${faded}><rect x="${spot.x}" y="${spot.y + 0.5}" width="${w}" height="19" rx="9.5" fill="var(--bg-surface)" stroke="${colour[kind]}"${dash ? ' stroke-dasharray="3 3"' : ''}/><text x="${spot.x + w / 2}" y="${spot.y + 14}" text-anchor="middle" class="calls-label${kind === 'warn' ? ' calls-warn-text' : ''}">${callsEsc(text)}</text></g>`);
  }
  const heads = Object.entries(colour).map(([k, c]) => `<marker id="calls-head-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join('');
  const titles = [];
  if (layout.cols.length) {
    const x = (c) => B.pad + c * (B.w + B.gapX);
    const last = layout.cols.length - 1;
    const hasOther = layout.clients + layout.services < layout.cols.length;
    layout.cols.forEach((col, c) => {
      if (!col.length) return;
      let t;
      if (layout.clients && c === 0) t = 'CLIENTS';
      else if (hasOther && c === last) t = 'DATABASES, BROKERS, OTHER HOSTS';
      else if (layout.services <= 1) t = 'MICROSERVICES';
      else t = c === layout.clients ? 'CALLERS' : 'CALLED';
      titles.push(`<text x="${x(c)}" y="${B.pad + 8}" class="calls-col-title">${t}</text>`);
    });
  }
  const nodes = shown.nodes.map((n) => {
    const p = layout.pos.get(n.id);
    if (!p) return '';
    const state = n.kind === 'service' ? (n.running ? 'run' : 'off') : n.kind === 'nothing' ? 'warn' : n.kind === 'client' ? 'client' : 'ext';
    const sel = n.id === selected;
    const sub = callsNodeSub(n);
    return `<g class="calls-node calls-${state}${sel ? ' calls-selected' : ''}" data-id="${callsEsc(n.id)}" tabindex="0" role="button" aria-pressed="${sel}" aria-label="${callsEsc(`${n.name}, ${sub}`)}">
      <title>${callsEsc(`${n.name}\n${sub}`)}</title>
      <rect x="${p.x}" y="${p.y}" width="${B.w}" height="${B.h}" rx="9"/>
      <circle cx="${p.x + 16}" cy="${p.y + 21}" r="4.5"/>
      <text x="${p.x + 28}" y="${p.y + 25}" class="calls-name">${callsEsc(callsCut(n.name, 21))}</text>
      <text x="${p.x + 16}" y="${p.y + 45}" class="calls-sub">${callsEsc(callsCut(sub, 30))}</text>
    </g>`;
  }).join('');
  return `<svg class="calls-svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Calls between microservices"><defs>${heads}</defs>${titles.join('')}${arrows.join('')}${labels.join('')}${nodes}</svg>`;
}

// What the map shows as Mermaid (a README, a wiki page): solid arrows for what was seen, dotted for the configuration.
function callsMermaid(shown) {
  const byId = new Map(shown.nodes.map((n, i) => [n.id, { n, key: `n${i}` }]));
  const q = (s) => String(s).replace(/"/g, '#quot;');
  const lines = ['flowchart LR'];
  const shape = (n) => (n.kind === 'service' ? `["${q(n.name)}"]` : n.kind === 'client' ? `(["${q(n.name)}"])` : `[("${q(n.name)}")]`);
  for (const { n, key } of byId.values()) lines.push(`  ${key}${shape(n)}`);
  const plain = new Map(shown.nodes.map((n) => [n.id, n]));
  for (const e of shown.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const label = callsEdgeLabel(e, plain);
    lines.push(`  ${a.key} ${e.seen ? '-->' : '-.->'}${label ? `|${q(label)}|` : ''} ${b.key}`);
  }
  return `${lines.join('\n')}\n`;
}

// Why an arrow is there, in words: what was seen of it and what the configuration says.
function callsWhy(e) {
  const parts = [];
  if (e.seen) {
    const ago = callsSpan(Date.now() - e.seen.last);
    let seen = e.seen.open > 0 && e.seen.open >= e.seen.count ? `Seen: ${callsPlural(e.seen.open, 'connection')} open` : `Seen ${e.seen.count === 1 ? 'once' : `${e.seen.count} times`}, the last ${ago} ago`;
    const via = e.seen.via || [];
    if (via.includes('container-to-host')) seen += ', from its container through the host';
    else if (via.includes('between-containers')) seen += ', between containers';
    else if (via.includes('to-container')) seen += ', to its container';
    parts.push(seen);
  }
  if (e.config.length) parts.push(e.config.slice(0, 3).join('; ') + (e.config.length > 3 ? ` (and ${e.config.length - 3} more)` : ''));
  return parts.join(' · ');
}

function buildCallsAnalysis() {
  const box = tEl('div', 'tool calls-tool');
  let data = null;
  let selected = null;
  let filter = 'all';
  try {
    filter = ['all', 'seen', 'config'].includes(localStorage.getItem(CALLS_FILTER_KEY)) ? localStorage.getItem(CALLS_FILTER_KEY) : 'all';
  } catch {
    // the default
  }
  let timer = null;
  let started = false;
  let asking = false;
  let drawn = ''; // the map as last drawn, and the width it was drawn for
  let drawnRoom = 0;

  const head = toolHead('Calls between microservices', 'The connections the running microservices open (spring-boot:run, IntelliJ and containers alike), and the calls their configuration declares (URLs, Feign, Kafka). Nothing to install, nothing changed in their code.');
  // what watching is doing, and what acts on the whole map
  const live = tEl('span', 'calls-live');
  const pulse = tEl('span', 'calls-pulse');
  const liveText = tEl('span');
  live.append(pulse, liveText);
  const watchBtn = toolButton('Stop watching', async () => take(await window.calls.watch(!(data && data.watching))));
  const seg = tEl('span', 'calls-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Which arrows to show');
  const segs = [['all', 'Seen + configured'], ['seen', 'Only seen'], ['config', 'Only configured']].map(([id, label]) => {
    const b = tEl('button', 'calls-seg-btn', label);
    b.type = 'button';
    b.dataset.filter = id;
    b.addEventListener('click', () => {
      filter = id;
      try {
        localStorage.setItem(CALLS_FILTER_KEY, id);
      } catch {
        // only for this session
      }
      render();
    });
    seg.appendChild(b);
    return b;
  });
  const clearBtn = toolButton('Clear', async () => take(await window.calls.clear()));
  clearBtn.title = 'Forget the calls seen so far (the configuration stays)';
  const rescanBtn = toolButton('', async () => {
    rescanBtn.disabled = true;
    take(await window.calls.rescan());
    rescanBtn.disabled = false;
  }, 'btn-icon an-icon-btn');
  rescanBtn.innerHTML = AN_REFRESH_SVG;
  rescanBtn.title = 'Read again: the configuration and the code of the microservices';
  rescanBtn.setAttribute('aria-label', 'Read again');
  const mermaidBtn = toolButton('Copy as Mermaid', () => data && toolCopy(callsMermaid(callsShown(data, filter)), 'Mermaid diagram'));
  mermaidBtn.title = 'The map as a Mermaid diagram, for a README or a wiki page';
  const bar = tEl('div', 'calls-bar');
  bar.append(live, watchBtn, seg, tEl('span', 'calls-grow'), clearBtn, rescanBtn, mermaidBtn);
  const notes = tEl('div', 'calls-notes');
  // the map and its legend
  const card = tEl('div', 'calls-card calls-map');
  const scroll = tEl('div', 'calls-scroll');
  const legend = tEl('div', 'calls-legend');
  legend.innerHTML = [
    ['<svg width="26" height="8" aria-hidden="true"><path d="M1 4h24" stroke="var(--accent)" stroke-width="1.8"/></svg>', 'Seen on the network while watching (how many times)'],
    ['<svg width="26" height="8" aria-hidden="true"><path d="M1 4h24" stroke="var(--text-dim)" stroke-width="1.8" stroke-dasharray="5 4"/></svg>', 'In the configuration, not seen yet'],
    ['<svg width="26" height="8" aria-hidden="true"><path d="M1 4h24" stroke="var(--yellow)" stroke-width="1.8" stroke-dasharray="5 4"/></svg>', 'Configured, but nothing listens there'],
    ['<i class="calls-dot" style="background:var(--green)"></i>', 'Running'],
    ['<i class="calls-dot" style="background:var(--text-dim)"></i>', 'Not running'],
    ['<i class="calls-dot" style="background:var(--mauve)"></i>', 'Database, broker or other host'],
    ['<i class="calls-dot" style="background:var(--accent)"></i>', 'Client (Bruno, a browser, Postman...)'],
  ].map(([icon, text]) => `<span>${icon}${callsEsc(text)}</span>`).join('');
  card.append(scroll, legend);
  const empty = tEl('div', 'calls-empty hidden');
  const detail = tEl('div', 'calls-card calls-detail');
  box.append(head, bar, notes, card, empty, detail);

  scroll.addEventListener('click', (e) => {
    const g = e.target.closest('.calls-node');
    selected = g && g.dataset.id !== selected ? g.dataset.id : g ? null : selected;
    render();
  });
  scroll.addEventListener('keydown', (e) => {
    const g = e.target.closest('.calls-node');
    if (!g || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    selected = g.dataset.id === selected ? null : g.dataset.id;
    render();
    const again = [...scroll.querySelectorAll('.calls-node')].find((x) => x.dataset.id === g.dataset.id);
    if (again) again.focus();
  });

  function take(r) {
    if (!r) return;
    if (r.error) {
      toast(r.error, 'error');
      return;
    }
    data = r;
    render();
  }
  async function refresh() {
    if (asking) return;
    asking = true;
    try {
      take(await window.calls.snapshot());
    } finally {
      asking = false;
    }
  }

  function renderStatus() {
    const running = data ? data.nodes.filter((n) => n.kind === 'service' && n.running).length : 0;
    live.classList.toggle('calls-stopped', !(data && data.watching));
    if (!data) liveText.innerHTML = 'Reading the microservices…';
    else if (data.watching) liveText.innerHTML = `<b>Watching</b> ${callsPlural(running, 'running microservice')} · ${callsSpan(Date.now() - data.since)}`;
    else if (data.since) liveText.innerHTML = `<b>Stopped</b>${data.stoppedBy === 'time' ? ' after an hour' : ''} · what was seen stays`;
    else liveText.innerHTML = '<b>Not watching</b> · only the configuration';
    watchBtn.textContent = data && data.watching ? 'Stop watching' : 'Watch';
    watchBtn.title = data && data.watching ? 'Stop looking at the connections (what was seen stays on the map)' : 'Look at the connections the running microservices open, every few seconds';
    segs.forEach((b) => {
      b.classList.toggle('on', b.dataset.filter === filter);
      b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
    });
  }

  function render() {
    renderStatus();
    if (!data) return;
    notes.textContent = (data.notes || []).join(' · ');
    notes.classList.toggle('hidden', !(data.notes || []).length);
    const shown = callsShown(data, filter);
    if (selected && !shown.nodes.some((n) => n.id === selected)) selected = null;
    const nothing = !shown.nodes.length;
    card.classList.toggle('hidden', nothing);
    empty.classList.toggle('hidden', !nothing);
    if (nothing) {
      empty.textContent = !data.services
        ? 'No microservices in the list: add the folders of your microservices (with their pom.xml) to the list.'
        : filter === 'seen'
          ? 'No calls seen yet. Start microservices (the Maven page, Containers, IntelliJ) and use them: their calls show up here as they happen.'
          : `No calls in the configuration of the ${callsPlural(data.services, 'microservice')} of the list, and none seen yet. Start them and use them: their calls show up here as they happen.`;
      detail.classList.add('hidden');
      return;
    }
    const layout = callsLayout(shown.nodes, shown.edges);
    // drawn again only when it changed: a click or a hover on a node is not lost to a redraw every few seconds
    const room = scroll.clientWidth - 12;
    const html = callsSvg(shown, layout, selected);
    if (html !== drawn || room !== drawnRoom) {
      drawn = html;
      drawnRoom = room;
      const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.calls-node');
      const focusId = focused && scroll.contains(focused) ? focused.dataset.id : null;
      scroll.innerHTML = html;
      // a little wider than the page: made smaller to fit (not below 70%); much wider: as it is, scrolled
      if (room > 0 && layout.width > room && room / layout.width >= 0.7) {
        const svg = scroll.querySelector('svg');
        svg.setAttribute('width', String(room));
        svg.setAttribute('height', String(Math.round((layout.height * room) / layout.width)));
      }
      if (focusId) {
        const again = [...scroll.querySelectorAll('.calls-node')].find((x) => x.dataset.id === focusId);
        if (again) again.focus();
      }
    }
    renderDetail(shown);
  }

  function renderDetail(shown) {
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const n = selected && byId.get(selected);
    detail.classList.remove('hidden');
    detail.textContent = '';
    if (!n) {
      detail.appendChild(tEl('div', 'calls-hint', 'Choose a node on the map to see what it calls, what calls it, and why each arrow is there.'));
      return;
    }
    const h = tEl('h3', 'calls-detail-name', n.name);
    const r = n.running;
    const sub = n.kind !== 'service' ? n.sub || '' : !r ? `not running${n.port ? ` · its port :${n.port}` : ''}` : r.how === 'container' ? `in the container ${r.container} (${r.engine})${(r.ports || []).length ? ` on :${r.ports.join(', :')}` : ''}` : `${r.how}${(r.ports || []).length ? ` on :${r.ports.join(', :')}` : ''} · PID ${r.pid}`;
    h.appendChild(tEl('small', '', sub));
    detail.appendChild(h);
    const column = (title, list, other) => {
      const col = tEl('div', 'calls-detail-col');
      col.appendChild(tEl('div', 'calls-col-head', title));
      if (!list.length) col.appendChild(tEl('div', 'calls-why calls-none', 'Nothing'));
      for (const e of list) {
        const kind = callsEdgeKind(e, byId);
        const row = tEl('div', `calls-row calls-row-${kind}`);
        const icon = tEl('span', 'calls-row-icon');
        icon.setAttribute('aria-hidden', 'true');
        const o = byId.get(other(e));
        const name = tEl('span', 'calls-row-name', o ? o.name : other(e));
        if (o && o.kind !== 'service' && o.sub) name.appendChild(tEl('span', 'calls-row-sub', ` · ${o.sub}`));
        const why = tEl('span', 'calls-why', callsWhy(e) || '');
        if (kind === 'warn') why.textContent = `${callsWhy(e)} · nothing listens on :${o.port}: start what should be there, or check the port`;
        row.append(icon, name, why);
        col.appendChild(row);
      }
      return col;
    };
    const visible = new Set(shown.edges.map((e) => `${e.from}|${e.to}`));
    const mine = data.edges.filter((e) => visible.has(`${e.from}|${e.to}`));
    detail.append(column('Calls', mine.filter((e) => e.from === n.id), (e) => e.to), column('Called by', mine.filter((e) => e.to === n.id), (e) => e.from));
  }

  return {
    el: box,
    focus: watchBtn,
    shown(on) {
      if (!on) {
        clearInterval(timer);
        timer = null;
        return;
      }
      if (!started) {
        started = true;
        renderStatus();
        // watching starts with the page, and goes on behind the other pages till it is stopped (or after an hour)
        window.calls.watch(true).then(take);
      } else refresh();
      if (!timer) timer = setInterval(() => (data && data.watching ? refresh() : renderStatus()), CALLS_POLL_MS);
    },
  };
}
