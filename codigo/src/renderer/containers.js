// Containers page (Docker or Podman): the containers on this PC, grouped by Compose project, with start, stop, logs, a shell
// inside and a form to create one. Relies on helpers from app.js ($, $$, toast, showLoading, hideLoading,
// openActionMenu, closeActionMenu, ACTION_ICONS, copyText, diffSpan, noteEl, plural, updateCrumb).
const DK_POLL_MS = 4000;
const DK_FILTER_KEY = 'dkFilter';
let dkState = { status: null, containers: [] };
let dkFilter = 'all';
let dkLogsId = null;
let dkLoading = false;
const dkBusy = new Map(); // container id -> what is being done to it ("Stopping...")

// Ready-made settings for the services microservices usually need. Passwords are local development defaults.
const DK_TEMPLATES = [
  { id: 'blank', label: 'Blank', image: '', name: '', ports: [], env: [], volumes: [] },
  {
    id: 'postgres', label: 'PostgreSQL', image: 'postgres:16', name: 'postgres',
    ports: [['5432', '5432']], env: [['POSTGRES_USER', 'postgres'], ['POSTGRES_PASSWORD', 'postgres'], ['POSTGRES_DB', 'app']],
    volumes: [['postgres-data', '/var/lib/postgresql/data']], restart: 'unless-stopped',
  },
  {
    id: 'mysql', label: 'MySQL', image: 'mysql:8', name: 'mysql',
    ports: [['3306', '3306']], env: [['MYSQL_ROOT_PASSWORD', 'root'], ['MYSQL_DATABASE', 'app']],
    volumes: [['mysql-data', '/var/lib/mysql']], restart: 'unless-stopped',
  },
  { id: 'redis', label: 'Redis', image: 'redis:7', name: 'redis', ports: [['6379', '6379']], env: [], volumes: [], restart: 'unless-stopped' },
  {
    id: 'mongo', label: 'MongoDB', image: 'mongo:7', name: 'mongo', ports: [['27017', '27017']], env: [],
    volumes: [['mongo-data', '/data/db']], restart: 'unless-stopped',
  },
  {
    id: 'rabbitmq', label: 'RabbitMQ', image: 'rabbitmq:3-management', name: 'rabbitmq',
    ports: [['5672', '5672'], ['15672', '15672']], env: [['RABBITMQ_DEFAULT_USER', 'guest'], ['RABBITMQ_DEFAULT_PASS', 'guest']],
    volumes: [], restart: 'unless-stopped',
  },
  {
    id: 'keycloak', label: 'Keycloak', image: 'quay.io/keycloak/keycloak:26.0', name: 'keycloak',
    ports: [['8180', '8080']], env: [['KC_BOOTSTRAP_ADMIN_USERNAME', 'admin'], ['KC_BOOTSTRAP_ADMIN_PASSWORD', 'admin']],
    volumes: [], command: 'start-dev',
  },
];

const DK_ICONS = {
  start: '<path d="M7 4v16l13 -8z"/>',
  stop: '<path d="M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z"/>',
  logs: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
  more: '<path d="M5 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M17 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>',
};

const dkRunning = (c) => ['running', 'restarting', 'paused'].includes(c.state);

function dkIconButton(icon, label, run) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-action dk-icon';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${DK_ICONS[icon]}</svg>`;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    run(b);
  });
  return b;
}

async function refreshContainers({ quiet = false } = {}) {
  if (dkLoading) return;
  dkLoading = true;
  let state;
  try {
    state = await window.containers.state();
  } catch (e) {
    state = { status: { installed: true, running: false, error: e.message }, containers: [] };
  } finally {
    dkLoading = false;
  }
  dkState = state;
  // an open menu is left alone (a redraw would take away the row it belongs to); the next round redraws
  if (quiet && $('#actionMenu')) return;
  renderContainers();
  if (currentMode === 'docker') updateCrumb();
}

// "Docker" or "Podman": the engine the list comes from (Docker until one answers).
function dkEngine() {
  return dkState.status && dkState.status.engine === 'podman' ? 'Podman' : 'Docker';
}

function renderContainers() {
  const { status, containers } = dkState;
  $('#dkTermPrompt').textContent = `${dkEngine().toLowerCase()} ❯`;
  const notice = $('#dkNotice');
  const down = !status || !status.running;
  notice.classList.toggle('hidden', !down);
  if (down && status) {
    const podman = status.engine === 'podman';
    $('#dkNoticeText').textContent = !status.installed
      ? status.error
      : podman
        ? 'Podman is not running. Start its machine and the list fills in by itself.'
        : 'Docker is not running. Start Docker Desktop and the list fills in by itself.';
    $('#dkNoticeText').title = status.installed && status.error ? status.error : '';
    $('#dkStartDesktopBtn').textContent = podman ? 'Start Podman' : 'Start Docker Desktop';
    $('#dkStartDesktopBtn').classList.toggle('hidden', !status.installed || window.git.platform === 'linux');
  }
  $('#dkNewBtn').disabled = down;

  const running = containers.filter(dkRunning).length;
  const counts = { all: containers.length, running, stopped: containers.length - running };
  $$('#dkFilters .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.filter === dkFilter);
    t.querySelector('.tab-count').textContent = counts[t.dataset.filter] || '';
  });

  const q = $('#dkSearch').value.trim().toLowerCase();
  const shown = containers.filter((c) => {
    if (dkFilter === 'running' && !dkRunning(c)) return false;
    if (dkFilter === 'stopped' && dkRunning(c)) return false;
    if (!q) return true;
    const ports = c.ports.map((p) => `${p.host || ''} ${p.container}`).join(' ');
    return [c.name, c.image, c.project, c.service, c.short, ports].join(' ').toLowerCase().includes(q);
  });

  const list = $('#dkList');
  const top = list.scrollTop;
  list.textContent = '';
  if (down) return;
  if (containers.length === 0) {
    list.appendChild(noteEl('No containers yet. Create one with New container.'));
    return;
  }
  if (shown.length === 0) {
    list.appendChild(noteEl(q ? `No container has "${q}"` : dkFilter === 'running' ? 'No container is running' : 'No stopped containers'));
    return;
  }
  const head = document.createElement('div');
  head.className = 'dk-row dk-head';
  head.setAttribute('role', 'row');
  for (const label of ['', 'Name', 'Image', 'Ports', 'Status', '']) head.appendChild(diffSpan('dk-th', label));
  list.appendChild(head);
  // Compose projects first, each under its name; the containers of no project after them
  const groups = new Map();
  for (const c of shown) {
    const k = c.project || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  const titled = keys.some((k) => k);
  for (const k of keys) {
    if (titled) {
      const items = groups.get(k);
      const title = document.createElement('div');
      title.className = 'dk-group';
      title.textContent = k ? `${k}` : 'Other containers';
      if (k) title.appendChild(diffSpan('dk-group-note', ` · ${items.every((c) => c.pod) ? 'Pod' : 'Compose'} · ${items.filter(dkRunning).length} of ${items.length} running`));
      list.appendChild(title);
    }
    for (const c of groups.get(k).sort((a, b) => a.name.localeCompare(b.name))) list.appendChild(dkRow(c));
  }
  list.scrollTop = top;
}

function dkRow(c) {
  const row = document.createElement('div');
  row.className = `dk-row${dkLogsId === c.id ? ' selected' : ''}`;
  row.setAttribute('role', 'row');
  row.dataset.id = c.id;
  const dot = diffSpan(`dk-dot ${c.state}`, '');
  dot.title = c.state;
  const name = document.createElement('div');
  name.className = 'dk-name';
  name.appendChild(diffSpan('dk-name-main', c.name));
  if (c.service && c.service !== c.name) name.appendChild(diffSpan('dk-name-sub', c.service));
  name.title = `${c.name}\n${c.id}`;
  const image = diffSpan('dk-image', c.image);
  image.title = c.image;
  const ports = document.createElement('div');
  ports.className = 'dk-ports';
  for (const p of c.ports) {
    if (p.host) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dk-port';
      chip.textContent = p.host === p.container ? `${p.host}` : `${p.host}→${p.container}`;
      chip.title = `Open http://localhost:${p.host} (container port ${p.container}/${p.proto})`;
      chip.addEventListener('click', async (e) => {
        e.stopPropagation();
        const r = await window.containers.openPort(p.host);
        if (r.error) toast(r.error, 'error');
      });
      ports.appendChild(chip);
    } else {
      const inner = diffSpan('dk-port-inner', `${p.container}/${p.proto}`);
      inner.title = 'Not published: only other containers reach it';
      ports.appendChild(inner);
    }
  }
  const busy = dkBusy.get(c.id);
  const status = diffSpan(`dk-status${busy ? ' busy' : ''}`, busy || c.status);
  status.title = c.created ? `Created ${c.created}` : '';
  const actions = document.createElement('div');
  actions.className = 'dk-actions';
  const toggle = dkRunning(c)
    ? dkIconButton('stop', `Stop ${c.name}`, () => dkAction(c, 'stop'))
    : dkIconButton('start', `Start ${c.name}`, () => dkAction(c, 'start'));
  toggle.disabled = Boolean(busy);
  actions.append(
    toggle,
    dkIconButton('logs', `Logs of ${c.name}`, () => openDkLogs(c)),
    dkIconButton('more', `More for ${c.name}`, (b) => openDkActions(c, b)),
  );
  row.append(dot, name, image, ports, status, actions);
  row.title = 'Click to see its details';
  row.addEventListener('click', () => openDkDetails(c));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openDkActions(c, null, e.clientX, e.clientY);
  });
  return row;
}

function openDkActions(c, anchor, x, y) {
  const on = dkRunning(c);
  openActionMenu({
    anchor, x, y,
    title: `${c.name} · ${c.image}`,
    items: [
      { icon: 'info', label: 'Details', run: () => openDkDetails(c) },
      on
        ? { icon: 'stop', label: 'Stop', run: () => dkAction(c, 'stop') }
        : { icon: 'start', label: 'Start', run: () => dkAction(c, 'start') },
      { icon: 'restart', label: 'Restart', disabled: !on, hint: on ? '' : 'It is not running', run: () => dkAction(c, 'restart') },
      { icon: 'logs', label: 'Logs', run: () => openDkLogs(c) },
      {
        icon: 'terminal', label: 'Open a terminal inside', disabled: !on,
        hint: on ? 'A shell in the container, in a separate window' : 'Start it first', run: () => dkTerminal(c),
      },
      { icon: 'copy', label: 'Copy id', run: () => copyText(c.id, 'Container id') },
      { icon: 'delete', label: 'Remove...', danger: true, run: () => dkRemove(c) },
    ],
  });
}

async function dkAction(c, verb) {
  const doing = { start: 'Starting...', stop: 'Stopping...', restart: 'Restarting...', remove: 'Removing...' }[verb];
  dkBusy.set(c.id, doing);
  renderContainers();
  const r = await window.containers.action(c.id, verb);
  dkBusy.delete(c.id);
  if (r.error) toast(r.error, 'error', { title: `Couldn't ${verb} ${c.name}` });
  else toast(`${{ start: 'Started', stop: 'Stopped', restart: 'Restarted', remove: 'Removed' }[verb]} ${c.name}`, 'success');
  if (verb === 'remove' && dkLogsId === c.id) closeDkLogs();
  await refreshContainers();
}

async function dkRemove(c) {
  const lines = [`Remove the container ${c.name}?`, dkRunning(c) ? 'It is running: it is stopped first.' : '', 'Its image and named volumes stay; anything written only inside the container is lost.'];
  if (!(await window.git.confirm(lines.filter(Boolean).join('\n')))) return;
  dkAction(c, 'remove');
}

async function dkTerminal(c) {
  const r = await window.containers.terminal(c.id);
  if (r.error) toast(r.error, 'error');
  else toast(`Opened a terminal in ${c.name}`, 'success');
}

// -- Details of one container, in a popup: what it is and how it runs (live usage while it runs), its environment,
// network, volumes and labels, and the whole "docker inspect". --
const DK_SECRET = /pass|secret|token|key|credential|pwd/i;
const DK_STATS_MS = 3000;
let dkDetail = null; // { id, name, data, json, tab, stats, reveal, envFilter }
let dkStatsTimer = null;

// Docker writes "0001-01-01T00:00:00Z" for a time that never happened.
const dkTime = (t) => (t && Date.parse(t) > 0 ? t : '');
const dkWhen = (t) => (dkTime(t) ? `${formatDate(t)} (${new Date(t).toLocaleString()})` : '');

function dkEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function dkSection(title, ...children) {
  const sec = dkEl('section', 'dk-sec');
  sec.appendChild(dkEl('h4', 'dk-sec-title', title));
  sec.append(...children);
  return sec;
}

// Label and value pairs; a value can be text or an element, empty ones are left out.
function dkPairs(pairs) {
  const box = dkEl('div', 'dk-kv');
  for (const [label, value, mono] of pairs) {
    if (value === '' || value === null || value === undefined) continue;
    box.appendChild(dkEl('div', 'dk-k', label));
    const v = typeof value === 'string' ? dkEl('div', `dk-v${mono ? ' mono' : ''}`, value) : value;
    if (typeof value !== 'string') v.classList.add('dk-v');
    box.appendChild(v);
  }
  return box;
}

function dkTable(heads, rows) {
  const table = dkEl('div', 'dk-table');
  table.style.gridTemplateColumns = heads.map((h) => h.width || 'minmax(0, 1fr)').join(' ');
  for (const h of heads) table.appendChild(dkEl('div', 'dk-tth', h.label));
  for (const row of rows) for (const cell of row) table.appendChild(typeof cell === 'string' ? dkEl('div', 'dk-td mono', cell) : cell);
  return table;
}

function dkCopyButton(value, what, sensitive) {
  const b = dkEl('button', 'icon-action dk-copy');
  b.type = 'button';
  b.title = `Copy ${what}`;
  b.setAttribute('aria-label', `Copy ${what}`);
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS.copy}</svg>`;
  b.addEventListener('click', async () => {
    if (!sensitive) {
      copyText(value, what);
      return;
    }
    // a password does not go into the clipboard history, and is cleared from the clipboard after a while
    const r = await window.vault.copySensitive(value);
    toast(r.error || `${what} copied (cleared in ${r.clearsInSeconds} s)`, r.error ? 'error' : 'success');
  });
  return b;
}

async function openDkDetails(c, tab = 'overview') {
  closeActionMenu();
  dkDetail = { id: c.id, name: c.name, data: null, json: '', tab, stats: null, reveal: new Set(), envFilter: '' };
  $('#dkDetailName').textContent = c.name;
  $('#dkDetailSub').textContent = `${c.image} · ${c.short}`;
  $('#dkDetailDot').className = `dk-dot ${c.state}`;
  $('#dkDetailActions').textContent = '';
  $('#dkDetailBody').textContent = '';
  $('#dkDetailBody').appendChild(noteEl('Loading...'));
  $('#dkDetailModal').classList.remove('hidden');
  $('#dkDetailClose').focus();
  await loadDkDetails();
}

function closeDkDetails() {
  clearInterval(dkStatsTimer);
  dkStatsTimer = null;
  dkDetail = null;
  $('#dkDetailModal').classList.add('hidden');
}

async function loadDkDetails() {
  const detail = dkDetail;
  if (!detail) return;
  const r = await window.containers.inspect(detail.id);
  if (detail !== dkDetail) return;
  if (r.error) {
    $('#dkDetailBody').textContent = '';
    $('#dkDetailBody').appendChild(noteEl(r.error));
    return;
  }
  detail.data = r.details;
  detail.json = r.json;
  renderDkDetailHead();
  renderDkDetailBody();
  clearInterval(dkStatsTimer);
  dkStatsTimer = null;
  if (detail.data.state.running) {
    refreshDkStats();
    dkStatsTimer = setInterval(() => {
      if (dkDetail === detail && detail.tab === 'overview' && !document.hidden) refreshDkStats();
    }, DK_STATS_MS);
  }
}

async function refreshDkStats() {
  const detail = dkDetail;
  if (!detail) return;
  const s = await window.containers.stats(detail.id);
  if (detail !== dkDetail || s.error) return;
  detail.stats = s;
  const tiles = $('#dkStatTiles');
  if (tiles) fillDkStats(tiles, s);
}

function fillDkStats(tiles, s) {
  tiles.textContent = '';
  const halves = (text) => String(text || '').split('/').map((x) => x.trim());
  const [netIn, netOut] = halves(s.net);
  const [diskIn, diskOut] = halves(s.disk);
  const [memUsed, memMax] = halves(s.memory);
  for (const [label, value, sub] of [
    ['CPU', s.cpu, ''],
    ['Memory', memUsed, memMax ? `${s.memoryPercent || ''} of ${memMax}`.trim() : ''],
    ['Network', `↓ ${netIn || '-'}`, `↑ ${netOut || '-'}`],
    ['Disk', `read ${diskIn || '-'}`, `write ${diskOut || '-'}`],
    ['Processes', String(s.pids || '-'), ''],
  ]) {
    const tile = dkEl('div', 'dk-stat');
    tile.append(dkEl('div', 'dk-stat-label', label), dkEl('div', 'dk-stat-value', value || '-'));
    if (sub) tile.appendChild(dkEl('div', 'dk-stat-sub', sub));
    tiles.appendChild(tile);
  }
}

function renderDkDetailHead() {
  const d = dkDetail.data;
  const c = { id: d.id, name: d.name, image: d.image, state: d.state.status };
  $('#dkDetailName').textContent = d.name;
  $('#dkDetailSub').textContent = `${d.image} · ${d.short}`;
  $('#dkDetailDot').className = `dk-dot ${d.state.status}`;
  const actions = $('#dkDetailActions');
  actions.textContent = '';
  const button = (label, run, cls = '') => {
    const b = dkEl('button', `btn btn-sm ${cls}`.trim(), label);
    b.type = 'button';
    b.addEventListener('click', run);
    actions.appendChild(b);
    return b;
  };
  const act = async (verb) => {
    await dkAction(c, verb);
    if (dkDetail) loadDkDetails();
  };
  if (d.state.running) button('Stop', () => act('stop'));
  else button('Start', () => act('start'));
  button('Restart', () => act('restart')).disabled = !d.state.running;
  button('Logs', () => {
    closeDkDetails();
    openDkLogs(c);
  });
  button('Terminal', () => dkTerminal(c)).disabled = !d.state.running;
  // the counts on the tabs
  $$('#dkDetailTabs .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === dkDetail.tab);
    const count = t.querySelector('.tab-count');
    if (count) count.textContent = { env: d.env.length, volumes: d.mounts.length, labels: d.labels.length }[t.dataset.tab] || '';
  });
}

function renderDkDetailBody() {
  const detail = dkDetail;
  const d = detail.data;
  const body = $('#dkDetailBody');
  body.textContent = '';
  $$('#dkDetailTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === detail.tab));
  const view = { overview: dkOverview, env: dkEnvView, network: dkNetworkView, volumes: dkVolumesView, labels: dkLabelsView, inspect: dkInspectView }[detail.tab];
  body.appendChild(view(d, detail));
  body.scrollTop = 0;
}

function dkOverview(d, detail) {
  const box = dkEl('div', 'dk-overview');
  if (d.state.running) {
    const tiles = dkEl('div', 'dk-stats');
    tiles.id = 'dkStatTiles';
    if (detail.stats) fillDkStats(tiles, detail.stats);
    else tiles.appendChild(dkEl('div', 'dk-stat-wait', 'Reading what it uses...'));
    box.appendChild(dkSection('Now', tiles));
  }
  const st = d.state;
  const status = st.running
    ? `Running, started ${dkWhen(st.startedAt)}`
    : `${st.status === 'created' ? 'Created, never started' : `Stopped with exit code ${st.exitCode}${dkTime(st.finishedAt) ? `, ${dkWhen(st.finishedAt)}` : ''}`}`;
  let health = '';
  if (st.health) {
    health = dkEl('div', 'dk-health');
    health.appendChild(dkEl('span', `dk-health-badge ${st.health.status}`, st.health.status));
    if (st.health.failingStreak) health.append(` ${plural(st.health.failingStreak, 'failed check')} in a row`);
    if (st.health.last) health.appendChild(dkEl('pre', 'dk-pre', st.health.last));
  }
  box.appendChild(dkSection('State', dkPairs([
    ['Status', status],
    ['Health', health],
    ['Restarts', String(st.restarts)],
    ['Restart policy', d.restart === 'no' ? 'Never' : d.restart],
    ['Out of memory', st.oomKilled ? 'Yes: it was stopped because it ran out of memory' : ''],
    ['Error', st.error],
  ])));
  const limits = [d.limits.memory ? `${Math.round(d.limits.memory / 1048576)} MiB memory` : '', d.limits.cpus ? `${d.limits.cpus} CPUs` : ''].filter(Boolean).join(', ') || 'No limits';
  const command = d.command ? dkEl('div', 'dk-v-copy') : '';
  if (command) command.append(dkEl('span', 'mono', d.command), dkCopyButton(d.command, 'Command'));
  box.appendChild(dkSection('Container', dkPairs([
    ['Image', `${d.image}  (${d.imageId})`, true],
    ['Created', dkWhen(d.created)],
    ['Command', command],
    ['Working folder', d.workingDir, true],
    ['User', d.user, true],
    ['Limits', limits],
  ])));
  if (d.compose) {
    const folder = d.compose.workingDir ? dkEl('div', 'dk-v-copy') : '';
    if (folder) {
      folder.appendChild(dkEl('span', 'mono', d.compose.workingDir));
      const repo = repos.find((r) => r.path.replace(/[\\/]+$/, '').toLowerCase() === d.compose.workingDir.replace(/[\\/]+$/, '').toLowerCase());
      if (repo) {
        const go = dkEl('button', 'btn btn-sm', 'Open the repository');
        go.type = 'button';
        go.title = `Open ${displayName(repo)} in Git`;
        go.addEventListener('click', () => {
          closeDkDetails();
          currentRepo = repo.path;
          activateMode('git');
          renderSidebar();
        });
        folder.appendChild(go);
      }
    }
    box.appendChild(dkSection('Compose', dkPairs([
      ['Project', d.compose.project],
      ['Service', d.compose.service],
      ['Folder', folder],
      ['Files', d.compose.files, true],
    ])));
  }
  if (d.ports.length) {
    const ports = dkEl('div', 'dk-ports');
    for (const p of d.ports) {
      if (!p.host.length) {
        const inner = dkEl('span', 'dk-port-inner', p.container);
        inner.title = 'Not published: only other containers reach it';
        ports.appendChild(inner);
      }
      for (const h of p.host) {
        const chip = dkEl('button', 'dk-port', `${h}→${p.container}`);
        chip.type = 'button';
        chip.title = `Open http://localhost:${h}`;
        chip.addEventListener('click', async () => {
          const r = await window.containers.openPort(h);
          if (r.error) toast(r.error, 'error');
        });
        ports.appendChild(chip);
      }
    }
    box.appendChild(dkSection('Ports', ports));
  }
  return box;
}

function dkEnvView(d, detail) {
  const box = dkEl('div', 'dk-env');
  const tools = dkEl('div', 'dk-env-tools');
  const search = dkEl('input', 'input dk-env-filter');
  search.type = 'search';
  search.placeholder = 'Filter variables';
  search.value = detail.envFilter;
  search.setAttribute('aria-label', 'Filter the variables');
  tools.append(search, dkEl('span', 'dk-env-note', 'Values of names with PASSWORD, SECRET, TOKEN or KEY are hidden: the eye shows them.'));
  const list = dkEl('div');
  const draw = () => {
    list.textContent = '';
    const q = detail.envFilter.toLowerCase();
    const rows = d.env.filter((e) => !q || e.key.toLowerCase().includes(q) || (!DK_SECRET.test(e.key) && e.value.toLowerCase().includes(q)));
    if (!rows.length) {
      list.appendChild(noteEl(d.env.length ? 'No variable matches' : 'No environment variables'));
      return;
    }
    list.appendChild(dkTable([{ label: 'Name', width: 'minmax(0, 0.9fr)' }, { label: 'Value', width: 'minmax(0, 1.6fr)' }, { label: '', width: 'auto' }], rows.map((e) => {
      const secret = DK_SECRET.test(e.key) && e.value;
      const shown = !secret || detail.reveal.has(e.key);
      const value = dkEl('div', `dk-td mono${shown ? '' : ' masked'}`, shown ? e.value : '••••••••');
      const tools2 = dkEl('div', 'dk-td dk-row-tools');
      if (secret) {
        const eye = dkEl('button', 'icon-action dk-copy');
        eye.type = 'button';
        eye.title = shown ? 'Hide the value' : 'Show the value';
        eye.setAttribute('aria-label', eye.title);
        eye.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/></svg>';
        eye.addEventListener('click', () => {
          if (detail.reveal.has(e.key)) detail.reveal.delete(e.key);
          else detail.reveal.add(e.key);
          draw();
        });
        tools2.appendChild(eye);
      }
      if (e.value) tools2.appendChild(dkCopyButton(e.value, e.key, Boolean(secret)));
      return [dkEl('div', 'dk-td mono dk-key', e.key), value, tools2];
    })));
  };
  search.addEventListener('input', () => {
    detail.envFilter = search.value.trim();
    draw();
  });
  draw();
  box.append(tools, list);
  return box;
}

function dkNetworkView(d) {
  const box = dkEl('div');
  box.appendChild(dkSection('Networks', d.networks.length
    ? dkTable([{ label: 'Network' }, { label: 'IP address' }, { label: 'Gateway' }, { label: 'Names other containers use', width: 'minmax(0, 1.4fr)' }],
      d.networks.map((n) => [n.name, n.ip || '-', n.gateway || '-', n.aliases.join(', ') || '-']))
    : noteEl('Not on any network')));
  box.appendChild(dkSection('Ports', d.ports.length
    ? dkTable([{ label: 'In the container' }, { label: 'On this PC', width: 'minmax(0, 2fr)' }],
      d.ports.map((p) => [p.container, p.host.length ? p.host.map((h) => `localhost:${h}`).join(', ') : 'not published']))
    : noteEl('No ports')));
  return box;
}

function dkVolumesView(d) {
  if (!d.mounts.length) return noteEl('Nothing mounted: what it writes lives only in the container.');
  return dkTable([{ label: 'Kind', width: '80px' }, { label: 'From', width: 'minmax(0, 1.3fr)' }, { label: 'In the container', width: 'minmax(0, 1fr)' }, { label: 'Access', width: '90px' }],
    d.mounts.map((m) => [m.type === 'volume' ? 'volume' : m.type === 'bind' ? 'folder' : m.type, m.source, m.target, m.rw ? 'read, write' : 'read only']));
}

function dkLabelsView(d) {
  if (!d.labels.length) return noteEl('No labels');
  return dkTable([{ label: 'Label', width: 'minmax(0, 1fr)' }, { label: 'Value', width: 'minmax(0, 1.4fr)' }], d.labels.map(([k, v]) => [k, v]));
}

function dkInspectView(d, detail) {
  const box = dkEl('div', 'dk-inspect');
  const tools = dkEl('div', 'dk-env-tools');
  tools.append(dkEl('span', 'dk-env-note', `Everything ${dkEngine().toLowerCase()} inspect says about it. It includes the environment, passwords too.`), dkCopyButton(detail.json, 'The JSON', true));
  box.append(tools, dkEl('pre', 'dk-pre dk-json', detail.json));
  return box;
}

// -- Logs of one container, followed live under the list. They are kept as entries (a line, with the stack trace
// lines that follow it), each with its level and, for errors, its kind, so a text and the tags can filter them. --
const DK_MAX_ENTRIES = 5000;
const DK_TAG_TYPES = 10; // kinds of error shown as tags, the most frequent first
let dkEntries = [];
let dkPartial = ''; // the end of the last chunk, when it was not a whole line
let dkLogFilter = { text: '', level: '', type: '' };
let dkLogTimer = null;

// The first level word in the line wins: "INFO ... ERROR count=0" is info. Plain text needs the word in capitals (a
// message saying "no error" is not an error); JSON and key=value logs say level=... in any case.
const DK_LEVELS = [
  ['error', /\b(?:ERROR|ERR|FATAL|SEVERE|CRITICAL|PANIC)\b/, /"(?:level|severity)"\s*:\s*"(?:error|err|fatal|critical|severe)"|\blevel=(?:error|err|fatal|critical)\b/i],
  ['warn', /\b(?:WARN|WARNING)\b/, /"(?:level|severity)"\s*:\s*"warn(?:ing)?"|\blevel=warn(?:ing)?\b/i],
  ['info', /\bINFO\b/, /"(?:level|severity)"\s*:\s*"info"|\blevel=info\b/i],
  ['debug', /\b(?:DEBUG|TRACE)\b/, /"(?:level|severity)"\s*:\s*"(?:debug|trace)"|\blevel=(?:debug|trace)\b/i],
];
const DK_LEVEL_LABELS = { error: 'Error', warn: 'Warn', info: 'Info', debug: 'Debug' };

function dkLevelOf(line) {
  let best = null;
  for (const [level, plain, keyed] of DK_LEVELS) {
    for (const re of [plain, keyed]) {
      const m = re.exec(line);
      if (m && (!best || m.index < best.index)) best = { level, index: m.index };
    }
  }
  return best ? best.level : '';
}

// A line that belongs to the entry above it: anything indented, and the lines of a stack trace (the exception
// itself, its "at" lines, "Caused by:").
const DK_CONTINUATION = /^(?:\s+\S|at\s|Caused by:|Suppressed:|\.\.\. \d+ (?:more|common frames)|(?:[a-z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error)\b)/;

// The kind of an error: its exception class, or its message with ids, numbers and quoted values replaced by #, so
// "Order 17 not found" and "Order 42 not found" are one kind.
function dkErrorType(text) {
  const ex = /((?:[a-z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error))\b/.exec(text);
  if (ex) return ex[1].split('.').pop();
  let first = text.split('\n')[0];
  if (first.trim().startsWith('{')) {
    try {
      const j = JSON.parse(first);
      first = String(j.message || j.msg || j.error || j.descricao || first);
    } catch {
      // not JSON after all
    }
  }
  // "2026-10-27 10:00:03 ERROR 1 --- [http-2] c.e.OrderService : Order 17 not found" -> "Order 17 not found": the
  // time and level, Spring Boot's process id, the thread and the logger go
  first = first.replace(/^.*?\b(?:ERROR|ERR|FATAL|SEVERE|CRITICAL|PANIC)\b[\s:\]|-]*/, '')
    .replace(/^\d+\s+---\s+/, '')
    .replace(/^(?:\[[^\]]*\]\s*)+/, '')
    .replace(/^[\w.$[\]/-]+\s+:\s+/, '');
  const type = first.replace(/"[^"]*"|'[^']*'/g, '"…"').replace(/[\w.:@/-]*\d[\w.:@/-]*/g, '#').replace(/\s+/g, ' ').trim();
  return type.slice(0, 80) || '(empty message)';
}

function dkAddLogText(text) {
  const lines = (dkPartial + text.replace(ANSI, '')).split(/\r?\n/);
  dkPartial = lines.pop();
  for (const line of lines) dkAddLine(line);
  if (dkEntries.length > DK_MAX_ENTRIES) dkEntries.splice(0, dkEntries.length - DK_MAX_ENTRIES);
}

function dkAddLine(line) {
  const last = dkEntries[dkEntries.length - 1];
  if (last && line && DK_CONTINUATION.test(line)) {
    last.text += `\n${line}`;
    if (last.level === 'error') last.type = dkErrorType(last.text);
    return;
  }
  const level = dkLevelOf(line);
  dkEntries.push({ text: line, level, type: level === 'error' ? dkErrorType(line) : '' });
}

const dkFiltering = () => Boolean(dkLogFilter.text || dkLogFilter.level || dkLogFilter.type);

function dkMatches(e) {
  const f = dkLogFilter;
  if (f.text && !e.text.toLowerCase().includes(f.text)) return false;
  if (f.type) return e.type === f.type;
  return !f.level || e.level === f.level;
}

// The tags: one per level found, then the most frequent kinds of error; a click shows only those, again shows all.
function renderDkLogTags() {
  const box = $('#dkLogTags');
  box.textContent = '';
  const levels = {};
  const types = new Map();
  for (const e of dkEntries) {
    if (e.level) levels[e.level] = (levels[e.level] || 0) + 1;
    if (e.type) types.set(e.type, (types.get(e.type) || 0) + 1);
  }
  const tag = (cls, label, count, on, click, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `dk-log-tag ${cls}${on ? ' on' : ''}`;
    b.append(diffSpan('dk-log-tag-label', label), diffSpan('dk-log-tag-count', count.toLocaleString()));
    b.title = title;
    b.setAttribute('aria-pressed', String(on));
    b.addEventListener('click', click);
    box.appendChild(b);
  };
  for (const level of ['error', 'warn', 'info', 'debug']) {
    if (!levels[level]) continue;
    const on = dkLogFilter.level === level && !dkLogFilter.type;
    tag(`lv-${level}`, DK_LEVEL_LABELS[level], levels[level], on, () => setDkLogFilter({ level: on ? '' : level, type: '' }), on ? 'Show every level again' : `Only ${DK_LEVEL_LABELS[level].toLowerCase()} lines`);
  }
  const kinds = [...types.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (kinds.length) box.appendChild(diffSpan('dk-log-tags-sep', 'Errors:'));
  for (const [type, count] of kinds.slice(0, DK_TAG_TYPES)) {
    const on = dkLogFilter.type === type;
    tag('kind', type, count, on, () => setDkLogFilter({ type: on ? '' : type, level: '' }), on ? 'Show every line again' : `Only the errors of this kind:\n${type}`);
  }
  if (kinds.length > DK_TAG_TYPES) box.appendChild(diffSpan('dk-log-tags-more', `+${kinds.length - DK_TAG_TYPES} more kinds`));
  box.classList.toggle('hidden', box.children.length === 0);
}

function setDkLogFilter(change) {
  Object.assign(dkLogFilter, change);
  renderDkLogTags();
  renderDkLogOutput();
}

// The entries to show; the text being looked for is marked in them.
function renderDkLogOutput() {
  const out = $('#dkLogsOutput');
  if (!dkFiltering()) {
    out.textContent = (dkEntries.map((e) => e.text).join('\n') + (dkPartial ? `\n${dkPartial}` : '')).slice(-MAX_OUTPUT_CHARS);
    $('#dkLogsState').textContent = dkLogsState;
    out.scrollTop = out.scrollHeight;
    return;
  }
  const shown = dkEntries.filter(dkMatches);
  const frag = document.createDocumentFragment();
  const needle = dkLogFilter.text;
  shown.forEach((e, i) => {
    const text = i ? `\n${e.text}` : e.text;
    if (!needle) {
      frag.append(text);
      return;
    }
    const low = text.toLowerCase();
    let at = 0;
    for (let k = low.indexOf(needle); k !== -1; k = low.indexOf(needle, k + needle.length)) {
      frag.append(text.slice(at, k));
      const mark = document.createElement('mark');
      mark.className = 'dk-hit';
      mark.textContent = text.slice(k, k + needle.length);
      frag.appendChild(mark);
      at = k + needle.length;
    }
    frag.append(text.slice(at));
  });
  out.textContent = '';
  out.appendChild(frag);
  if (!shown.length) out.textContent = 'No line matches.';
  $('#dkLogsState').textContent = `${dkLogsState} · ${shown.length.toLocaleString()} of ${plural(dkEntries.length, 'line')}`;
  out.scrollTop = out.scrollHeight;
}

let dkLogsState = '';

function openDkLogs(c) {
  dkLogsId = c.id;
  dkEntries = [];
  dkPartial = '';
  dkLogFilter.level = '';
  dkLogFilter.type = '';
  dkLogsState = 'following';
  $('#dkLogs').classList.remove('hidden');
  $('#dkLogsTitle').textContent = `Logs · ${c.name}`;
  $('#dkLogsState').textContent = dkLogsState;
  $('#dkLogsOutput').textContent = '';
  renderDkLogTags();
  $$('#dkList .dk-row').forEach((r) => r.classList.toggle('selected', r.dataset.id === c.id));
  window.containers.logsStart(c.id).then((r) => {
    if (r.error) $('#dkLogsState').textContent = r.error;
  });
}

function closeDkLogs() {
  dkLogsId = null;
  window.containers.logsStop();
  $('#dkLogs').classList.add('hidden');
  $$('#dkList .dk-row.selected').forEach((r) => r.classList.remove('selected'));
}

// -- New container --
function dkRowsFor(id) {
  return [...$(`#${id}`).querySelectorAll('.dk-form-row')].map((r) => [...r.querySelectorAll('input')].map((i) => i.value));
}

function dkSpec() {
  return {
    image: $('#dkImage').value.trim(),
    name: $('#dkName').value.trim(),
    ports: dkRowsFor('dkPorts').map(([host, container]) => ({ host, container })),
    env: dkRowsFor('dkEnv').map(([key, value]) => ({ key, value })),
    volumes: dkRowsFor('dkVolumes').map(([source, target]) => ({ source, target })),
    restart: $('#dkRestart').value,
    command: $('#dkCommand').value.trim(),
  };
}

let dkPreviewTimer = null;
function renderDkPreview() {
  clearTimeout(dkPreviewTimer);
  dkPreviewTimer = setTimeout(async () => {
    const preview = $('#dkPreview');
    if (!$('#dkImage').value.trim()) {
      preview.textContent = `${dkEngine().toLowerCase()} run -d ... (choose an image)`;
      preview.classList.remove('invalid');
      return;
    }
    const r = await window.containers.preview(dkSpec());
    preview.textContent = r.error || r.command;
    preview.classList.toggle('invalid', Boolean(r.error));
  }, 120);
}

// A line of two fields (and a remove button) in the ports, variables or volumes list.
function dkFormRow(listId, [a = '', b = ''] = [], { first, second, sep }) {
  const row = document.createElement('div');
  row.className = 'dk-form-row';
  const mk = (value, placeholder, cls) => {
    const input = document.createElement('input');
    input.className = `input ${cls}`;
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('input', () => {
      $('#dkNewError').classList.add('hidden');
      renderDkPreview();
    });
    return input;
  };
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-action';
  remove.title = 'Remove this line';
  remove.setAttribute('aria-label', 'Remove this line');
  remove.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  remove.addEventListener('click', () => {
    row.remove();
    renderDkPreview();
  });
  row.append(mk(a, first.placeholder, first.cls), diffSpan('dk-form-sep', sep), mk(b, second.placeholder, second.cls), remove);
  $(`#${listId}`).appendChild(row);
  return row;
}

const DK_ROWS = {
  dkPorts: { first: { placeholder: '5432', cls: 'dk-in-port' }, second: { placeholder: '5432', cls: 'dk-in-port' }, sep: '→' },
  dkEnv: { first: { placeholder: 'NAME', cls: 'dk-in-key' }, second: { placeholder: 'value', cls: 'dk-in-value' }, sep: '=' },
  dkVolumes: { first: { placeholder: 'data-volume or /full/path', cls: 'dk-in-value' }, second: { placeholder: '/path/in/container', cls: 'dk-in-value' }, sep: '→' },
};

function applyDkTemplate(t) {
  $$('#dkTemplates .tag-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.id === t.id));
  $('#dkImage').value = t.image;
  $('#dkName').value = t.name;
  for (const id of ['dkPorts', 'dkEnv', 'dkVolumes']) $(`#${id}`).textContent = '';
  t.ports.forEach((p) => dkFormRow('dkPorts', p, DK_ROWS.dkPorts));
  t.env.forEach((p) => dkFormRow('dkEnv', p, DK_ROWS.dkEnv));
  t.volumes.forEach((p) => dkFormRow('dkVolumes', p, DK_ROWS.dkVolumes));
  $('#dkRestart').value = t.restart || 'no';
  $('#dkCommand').value = t.command || '';
  $('#dkNewError').classList.add('hidden');
  renderDkPreview();
}

async function openDkNew() {
  const chips = $('#dkTemplates');
  if (!chips.children.length) {
    for (const t of DK_TEMPLATES) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip';
      chip.dataset.id = t.id;
      chip.textContent = t.label;
      chip.addEventListener('click', () => applyDkTemplate(t));
      chips.appendChild(chip);
    }
  }
  applyDkTemplate(DK_TEMPLATES[0]);
  $('#dkNewModal').classList.remove('hidden');
  $('#dkImage').focus();
  const list = $('#dkImageList');
  list.textContent = '';
  for (const image of await window.containers.images()) {
    const o = document.createElement('option');
    o.value = image;
    list.appendChild(o);
  }
}

function closeDkNew() {
  $('#dkNewModal').classList.add('hidden');
}

async function createContainer() {
  const spec = dkSpec();
  const fail = (text) => {
    const el = $('#dkNewError');
    el.textContent = text;
    el.classList.remove('hidden');
  };
  if (!spec.image) return fail('Choose an image, for example postgres:16.');
  const check = await window.containers.preview(spec);
  if (check.error) return fail(check.error);
  showLoading();
  const r = await window.containers.run(spec);
  hideLoading();
  if (r.error) return fail(r.error);
  closeDkNew();
  toast(`Started ${spec.name || spec.image}`, 'success');
  dkFilter = 'all';
  await refreshContainers();
}

// -- Commands: what the page runs (start, stop, run, logs, inspect...) with how it ended, and a line to run your own
// docker or podman command. The list refresh every few seconds is left out. --
const DK_TERM_OPEN_KEY = 'dkTermOpen';
const DK_TERM_HISTORY_KEY = 'dkTermHistory';
const DK_TERM_MAX = 300000;
let dkTermRunning = false;
let dkTermHistory = [];
let dkTermAt = -1;
let dkTypedId = 0;

function dkTermWrite(text, cls) {
  const out = $('#dkTermOutput');
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  if (cls) out.appendChild(dkEl('span', cls, text));
  else out.append(text);
  if (out.textContent.length > DK_TERM_MAX) out.textContent = out.textContent.slice(-DK_TERM_MAX);
  if (atBottom) out.scrollTop = out.scrollHeight;
}

function dkTermTime(at) {
  return new Date(at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function dkTermEndLine() {
  const out = $('#dkTermOutput');
  if (out.textContent && !out.textContent.endsWith('\n')) dkTermWrite('\n');
}

function onDkCommand(m) {
  if (m.info) {
    dkTermEndLine();
    dkTermWrite(`${dkTermTime(m.at)} · ${m.info}\n`, 'dk-term-info');
    return;
  }
  if (m.start) {
    dkTermEndLine();
    dkTermWrite(`${$('#dkTermOutput').textContent ? '\n' : ''}${dkTermTime(m.at)} `, 'dk-term-time');
    dkTermWrite(`❯ ${m.text}\n`, 'help-term-cmd');
    return;
  }
  if (m.chunk) {
    dkTermWrite(m.chunk);
    return;
  }
  if (m.end) {
    if (m.out) dkTermWrite(`${m.out}\n`, 'dk-term-out');
    if (m.err) dkTermWrite(`${m.err}\n`, 'help-term-err');
    dkTermEndLine();
    if (m.stopped) dkTermWrite('[stopped]\n', 'help-term-err');
    else if (m.code !== undefined && m.code !== null) dkTermWrite(`[exit code ${m.code}]\n`, m.code === 0 ? 'help-term-ok' : 'help-term-err');
  }
}

function setDkTermRunning(on) {
  dkTermRunning = on;
  $('#dkTermStop').classList.toggle('hidden', !on);
  $('#dkTermState').textContent = on ? 'running...' : '';
  $('#dkTerm').classList.toggle('running', on);
}

function setDkTermOpen(open) {
  $('#dkTerm').classList.toggle('collapsed', !open);
  const toggle = $('#dkTermToggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? 'Hide the commands' : 'Show the commands';
  toggle.setAttribute('aria-label', toggle.title);
  try {
    localStorage.setItem(DK_TERM_OPEN_KEY, open ? '1' : '0');
  } catch {
    // not remembered
  }
}

async function dkTermRun() {
  const input = $('#dkTermInput');
  const command = input.value.trim();
  if (!command || dkTermRunning) return;
  dkTermHistory = [command, ...dkTermHistory.filter((c) => c !== command)].slice(0, 50);
  try {
    localStorage.setItem(DK_TERM_HISTORY_KEY, JSON.stringify(dkTermHistory));
  } catch {
    // only for this session
  }
  dkTermAt = -1;
  input.value = '';
  setDkTermRunning(true);
  const r = await window.containers.runCommand(command);
  if (r.error) {
    setDkTermRunning(false);
    dkTermEndLine();
    dkTermWrite(`${$('#dkTermOutput').textContent ? '\n' : ''}${dkTermTime()} `, 'dk-term-time');
    dkTermWrite(`❯ ${dkEngine().toLowerCase()} ${command.replace(/^(docker|podman)\s+/, '')}\n`, 'help-term-cmd');
    dkTermWrite(`${r.error}\n`, 'help-term-err');
  }
}

function setupDkTerm() {
  try {
    dkTermHistory = JSON.parse(localStorage.getItem(DK_TERM_HISTORY_KEY)) || [];
  } catch {
    dkTermHistory = [];
  }
  let open = true;
  try {
    open = localStorage.getItem(DK_TERM_OPEN_KEY) !== '0';
  } catch {
    // open by default
  }
  setDkTermOpen(open);
  window.containers.onCommand((m) => {
    onDkCommand(m);
    if (m.start && m.typed) dkTypedId = m.id;
    if (m.end && m.id === dkTypedId) {
      // the typed command ended: the list shows what it changed
      dkTypedId = 0;
      setDkTermRunning(false);
      refreshContainers({ quiet: true });
    }
  });
  const input = $('#dkTermInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dkTermRun();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!dkTermHistory.length) return;
      e.preventDefault();
      dkTermAt = Math.max(-1, Math.min(dkTermHistory.length - 1, dkTermAt + (e.key === 'ArrowUp' ? 1 : -1)));
      input.value = dkTermAt === -1 ? '' : dkTermHistory[dkTermAt];
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (e.key === 'c' && e.ctrlKey && dkTermRunning && !input.selectionStart && !input.selectionEnd) {
      e.preventDefault();
      window.containers.stopCommand();
    } else if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      dkTermAt = -1;
    }
  });
  $('#dkTermOutput').addEventListener('click', () => {
    if (!window.getSelection().toString()) input.focus();
  });
  $('#dkTermStop').addEventListener('click', () => window.containers.stopCommand());
  $('#dkTermClear').addEventListener('click', () => {
    $('#dkTermOutput').textContent = '';
    input.focus();
  });
  $('#dkTermToggle').addEventListener('click', () => setDkTermOpen($('#dkTerm').classList.contains('collapsed')));
}

function setupContainers() {
  if (CARD_ID) return;
  setupDkTerm();
  Object.assign(ACTION_ICONS, {
    start: DK_ICONS.start,
    stop: DK_ICONS.stop,
    restart: '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
    logs: DK_ICONS.logs,
    terminal: '<path d="M5 7l5 5l-5 5"/><path d="M12 19h7"/>',
  });
  try {
    const saved = localStorage.getItem(DK_FILTER_KEY);
    if (['all', 'running', 'stopped'].includes(saved)) dkFilter = saved;
  } catch {
    // starts on All
  }
  $$('#dkFilters .tab').forEach((t) => t.addEventListener('click', () => {
    dkFilter = t.dataset.filter;
    try {
      localStorage.setItem(DK_FILTER_KEY, dkFilter);
    } catch {
      // not remembered
    }
    renderContainers();
  }));
  $('#dkSearch').addEventListener('input', renderContainers);
  $('#dkSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.value) {
      e.stopPropagation();
      e.target.value = '';
      renderContainers();
    }
  });
  $('#dkRefreshBtn').addEventListener('click', () => refreshContainers());
  $('#dkNewBtn').addEventListener('click', openDkNew);
  $('#dkStartDesktopBtn').addEventListener('click', async () => {
    const r = await window.containers.startDesktop();
    if (r.error) toast(r.error, 'error');
    else toast(dkEngine() === 'Podman' ? 'Starting the Podman machine: the list fills in once it is ready' : 'Starting Docker Desktop: the list fills in once it is ready', 'info');
  });
  $('#dkLogsClose').addEventListener('click', closeDkLogs);
  $('#dkLogsClear').addEventListener('click', () => {
    dkEntries = [];
    dkPartial = '';
    setDkLogFilter({ level: '', type: '' });
  });
  $('#dkLogsFilter').addEventListener('input', (e) => setDkLogFilter({ text: e.target.value.trim().toLowerCase() }));
  $('#dkLogsFilter').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.value) {
      e.stopPropagation();
      e.target.value = '';
      setDkLogFilter({ text: '' });
    }
  });
  window.containers.onLogs(({ id, text }) => {
    if (id !== dkLogsId) return;
    dkAddLogText(text);
    if (!dkFiltering()) {
      // nothing to filter: the text goes on the end as it comes, and the view stays where it was if scrolled up
      const out = $('#dkLogsOutput');
      const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      out.textContent = (out.textContent + text.replace(ANSI, '')).slice(-MAX_OUTPUT_CHARS);
      if (atBottom) out.scrollTop = out.scrollHeight;
    }
    // the tags and a filtered view are redrawn a few times a second at most
    if (!dkLogTimer) {
      dkLogTimer = setTimeout(() => {
        dkLogTimer = null;
        renderDkLogTags();
        if (dkFiltering()) renderDkLogOutput();
      }, 250);
    }
  });
  window.containers.onLogsEnd(({ id }) => {
    if (id !== dkLogsId) return;
    if (dkPartial) {
      dkAddLine(dkPartial);
      dkPartial = '';
    }
    dkLogsState = 'stopped following (the container stopped)';
    renderDkLogTags();
    $('#dkLogsState').textContent = dkLogsState;
  });
  // the details popup
  $$('#dkDetailTabs .tab').forEach((t) => t.addEventListener('click', () => {
    if (!dkDetail || !dkDetail.data) return;
    dkDetail.tab = t.dataset.tab;
    renderDkDetailBody();
  }));
  $('#dkDetailClose').addEventListener('click', closeDkDetails);
  $('#dkDetailModal').addEventListener('mousedown', (e) => {
    if (e.target.id === 'dkDetailModal') closeDkDetails();
  });
  // Esc closes it, wherever the focus is (a filter with text in it is cleared first)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !dkDetail || $('#dkDetailModal').classList.contains('hidden')) return;
    if (e.target.matches && e.target.matches('input') && e.target.value) {
      e.target.value = '';
      e.target.dispatchEvent(new Event('input'));
      return;
    }
    e.preventDefault();
    closeDkDetails();
  });
  // the form
  $('#dkAddPort').addEventListener('click', () => dkFormRow('dkPorts', [], DK_ROWS.dkPorts).querySelector('input').focus());
  $('#dkAddEnv').addEventListener('click', () => dkFormRow('dkEnv', [], DK_ROWS.dkEnv).querySelector('input').focus());
  $('#dkAddVolume').addEventListener('click', () => dkFormRow('dkVolumes', [], DK_ROWS.dkVolumes).querySelector('input').focus());
  for (const id of ['dkImage', 'dkName', 'dkCommand']) {
    $(`#${id}`).addEventListener('input', () => {
      $('#dkNewError').classList.add('hidden');
      renderDkPreview();
    });
  }
  $('#dkRestart').addEventListener('change', renderDkPreview);
  $('#dkNewCancel').addEventListener('click', closeDkNew);
  $('#dkNewCreate').addEventListener('click', createContainer);
  $('#dkNewModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDkNew();
    }
  });
  // while the page is open, the list follows what happens in Docker
  setInterval(() => {
    if (currentMode === 'docker' && !document.hidden && $('#dkNewModal').classList.contains('hidden')) refreshContainers({ quiet: true });
  }, DK_POLL_MS);
}

setupContainers();
