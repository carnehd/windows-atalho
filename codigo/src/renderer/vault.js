// Vault view. Relies on helpers from app.js ($, $$, toast, confirm via window.git).
const TYPE_LABELS = { credential: 'Credential', link: 'Link', db: 'DB', endpoint: 'Endpoint', note: 'Note' };

const DB_ENGINES = {
  postgresql: { label: 'PostgreSQL', port: 5432, url: (h, p, d) => `jdbc:postgresql://${h}:${p}/${d}` },
  mysql: { label: 'MySQL', port: 3306, url: (h, p, d) => `jdbc:mysql://${h}:${p}/${d}` },
  mariadb: { label: 'MariaDB', port: 3306, url: (h, p, d) => `jdbc:mariadb://${h}:${p}/${d}` },
  oracle: { label: 'Oracle', port: 1521, url: (h, p, d) => `jdbc:oracle:thin:@//${h}:${p}/${d}` },
  sqlserver: { label: 'SQL Server', port: 1433, url: (h, p, d) => `jdbc:sqlserver://${h}:${p};databaseName=${d}` },
  mongodb: { label: 'MongoDB', port: 27017, url: (h, p, d) => `mongodb://${h}:${p}/${d}` },
  redis: { label: 'Redis', port: 6379, url: (h, p, d) => `redis://${h}:${p}/${d || 0}` },
  other: { label: 'Other', port: null, url: null },
};

function dbConnectionUrl(item) {
  if (item.url) return item.url;
  const engine = DB_ENGINES[item.engine] || DB_ENGINES.other;
  if (!engine.url || !item.host) return '';
  return engine.url(item.host, item.port || engine.port, item.database || '');
}

function springDatasourceConfig(item, password) {
  if (item.engine === 'mongodb') return `spring.data.mongodb.uri=${dbConnectionUrl(item)}`;
  if (item.engine === 'redis') {
    const engine = DB_ENGINES.redis;
    return [
      `spring.data.redis.host=${item.host}`,
      `spring.data.redis.port=${item.port || engine.port}`,
      item.username ? `spring.data.redis.username=${item.username}` : '',
      password ? `spring.data.redis.password=${password}` : '',
    ].filter(Boolean).join('\n');
  }
  return [
    `spring.datasource.url=${dbConnectionUrl(item)}`,
    `spring.datasource.username=${item.username || ''}`,
    `spring.datasource.password=${password || ''}`,
  ].join('\n');
}
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const REVEAL_MS = 15000;
const MASK = '\u2022'.repeat(8);

let vaultData = { environments: [] };
// Items with no environment: kept apart from the environments, which are the ones listed (main process: vault.js).
const NO_ENV_ID = 'no-environment';
let noEnvItems = { id: NO_ENV_ID, name: '', baseUrl: '', items: [], generic: true };
let selectedEnvId = null; // the environment chosen in the tabs of a variable (null: no environment)
let typeFilter = 'all';
let vaultSort = null; // { key: 'type' | 'added' | 'name' | 'username' | 'url', dir: 'asc' | 'desc' }; null is by type
let itemDialog = null;
let envDialogId = null;

function vEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const ICONS = {
  edit: '<path d="M11.5 2.5l2 2L5.5 12.5l-3 .8.8-3 8.2-7.8z"/>',
  trash: '<path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.6 8.5h6.8l.6-8.5M6.8 7v3.5M9.2 7v3.5"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  eyeOff: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 13.5l11-11"/>',
  open: '<path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V5.5A1.5 1.5 0 0 1 4 4h2.5"/>',
  signIn: '<path d="M9.5 2.5H12a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9.5M2.5 8h7.5M7.5 5.5L10 8l-2.5 2.5"/>',
  popout: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><rect x="8" y="7.5" width="4.5" height="3.5" rx="0.8"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.6-2.5 2.6-4 5-4s4.4 1.5 5 4"/>',
  key: '<circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.3 8.7L13 3M11 5l1.5 1.5M9.5 6.5L11 8"/>',
  pin: '<path d="M8 11v3.5M6 6.7a1.3 1.3 0 0 1-.7 1.2l-1.2.6a1.3 1.3 0 0 0-.7 1.2v.5c0 .4.3.8.8.8h7.6c.4 0 .7-.4.7-.8v-.5a1.3 1.3 0 0 0-.7-1.2l-1.2-.6a1.3 1.3 0 0 1-.7-1.2V4.3c0-.4.3-.7.7-.7a1.3 1.3 0 0 0 0-2.6H5.3a1.3 1.3 0 0 0 0 2.6c.4 0 .7.3.7.7z"/>',
  spring: '<path d="M13.5 2.5C6 2.5 2.5 6 3 12.5c6.5.5 10.5-3 10.5-10zM3 13l6-6"/>',
  format: '<path d="M5.5 2.5c-1.5 0-2 .7-2 2v1.6c0 .9-.5 1.4-1.5 1.9 1 .5 1.5 1 1.5 1.9v1.6c0 1.3.5 2 2 2M10.5 2.5c1.5 0 2 .7 2 2v1.6c0 .9.5 1.4 1.5 1.9-1 .5-1.5 1-1.5 1.9v1.6c0 1.3-.5 2-2 2"/>',
  link: '<path d="M6.8 9.2l2.4-2.4M7.2 4.6l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1M8.8 11.4l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1"/>',
  star: '<path d="M8 1.9l1.9 3.8 4.2.6-3 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3-3 4.2-.6z"/>',
  db: '<ellipse cx="8" cy="3.8" rx="5" ry="1.8"/><path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8"/>',
  note: '<path d="M4 1.8h5.5L12.5 5v9.2H4z"/><path d="M9.5 1.8V5h3M6 8.2h4.5M6 10.8h4.5"/>',
  endpoint: '<path d="M5 4L1.8 8 5 12M11 4l3.2 4L11 12M9.3 3L6.7 13"/>',
  chevron: '<path d="M6 3.5l4.5 4.5L6 12.5"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
};
const TYPE_ICONS = { credential: 'key', link: 'link', db: 'db', endpoint: 'endpoint', note: 'note' };
const NEW_TYPES = ['credential', 'link', 'db', 'note'];

function typeIcon(type) {
  const icon = vEl('span', `vt-type type-${type}-icon`);
  icon.title = TYPE_LABELS[type];
  icon.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[TYPE_ICONS[type]]}</svg>`;
  return icon;
}

function setIcon(btn, name) {
  btn.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
}

function vIconBtn(icon, title, handler, cls = '') {
  const b = vEl('button', `icon-action ${cls}`.trim());
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  setIcon(b, icon);
  b.addEventListener('click', handler);
  return b;
}

async function copyText(text, what) {
  const r = await window.vault.copyText(text);
  toast(r.error || `${what} copied`, r.error ? 'error' : 'success');
  return !r.error;
}

async function openLink(url) {
  const r = await window.vault.openLink(url);
  toast(r.error || `Opened ${r.host} in the browser`, r.error ? 'error' : 'info');
}

// "Open and sign in": the page in a window of the app, with the username and password put in its login form.
const canSignIn = (item) => ['link', 'credential'].includes(item.type) && /^https?:\/\//i.test(item.url || '') && Boolean(item.username || item.hasPassword);

async function signInTo(item) {
  const r = await window.vault.signIn(item.id);
  toast(r.error || `Opened ${r.host}: the username and password go in when its login form shows`, r.error ? 'error' : 'info');
}

function signInButton(item) {
  return vIconBtn('signIn', 'Open and sign in (in a window of the app, filled in, not sent)', (e) => {
    e.stopPropagation();
    signInTo(item);
  });
}

function resolveUrl(env, url) {
  if (/^https?:\/\//i.test(url) || !env.baseUrl) return url;
  return env.baseUrl.replace(/\/+$/, '') + (url.startsWith('/') ? '' : '/') + url;
}

function envById(id) {
  return vaultData.environments.find((e) => e.id === id);
}

async function refreshVault() {
  let data;
  try {
    data = await window.vault.get();
  } catch (e) {
    data = { error: e.message };
  }
  if (data.error) {
    toast(data.error, 'error');
    return;
  }
  vaultData = data;
  noEnvItems = data.environments.find((e) => e.generic) || { id: NO_ENV_ID, name: '', baseUrl: '', items: [], generic: true };
  vaultData.environments = data.environments.filter((e) => !e.generic);
  // the first time the Vault shows while the app runs: on GERAL when there is one (else the one shown last time)
  if (!vaultOpened) {
    vaultOpened = true;
    const geral = vaultData.environments.find((e) => e.name.trim().toLowerCase() === DEFAULT_ENV_NAME);
    if (geral) {
      vaultViewEnv = geral.id;
      selectedEnvId = geral.id;
    }
  }
  if (selectedEnvId !== NO_ENV_ID && !envById(selectedEnvId)) selectedEnvId = null;
  renderVault();
}

function renderVault() {
  updateCrumb();
  const warning = $('#vaultWarning');
  if (vaultData.loadError) {
    warning.textContent = `The vault file could not be read (${vaultData.loadError}). Saving is disabled so the file is not overwritten.`;
  } else if (!vaultData.encryption) {
    warning.textContent = 'Encryption is not available on this system, so nothing can be saved.';
  } else {
    warning.textContent = '';
  }
  warning.classList.toggle('hidden', !warning.textContent);

  renderEnvList();
  // items can do without an environment, so the page is there with none
  $('#vaultEmpty').classList.add('hidden');
  $('#vaultMain').classList.remove('hidden');
  renderItems();
}

// Each environment has a colour: by its usual name (dev, sit / qa / test, uat / pre, prod, a shared one), else by its
// place in the list.
const ENV_COLOURS = ['#1D9E75', '#BA7517', '#D85A30', '#378ADD', '#7F77DD', '#D4537E', '#639922'];
function envColour(env) {
  const n = env.name.toLowerCase();
  if (/prod|\bprd\b/.test(n)) return '#E24B4A';
  if (/\bdev|desenv/.test(n)) return '#1D9E75';
  if (/\bsit\b|\bqa\b|\btest|\bstir/.test(n)) return '#BA7517';
  if (/\buat\b|\bpre|\bstag|homolog/.test(n)) return '#D85A30';
  if (/geral|common|shared|global/.test(n)) return '#888780';
  return ENV_COLOURS[Math.max(0, vaultData.environments.indexOf(env)) % ENV_COLOURS.length];
}

function envDot(env) {
  const dot = vEl('span', 'vd-env-dot');
  dot.style.background = envColour(env);
  return dot;
}

// Over the sections: the environment shown (or all of them), each with its colour and how many items it has.
function renderEnvList() {
  const box = $('#vaultEnvChips');
  box.textContent = '';
  if (vaultViewEnv !== 'all' && !viewEnv()) vaultViewEnv = 'all';
  const chip = (id, label, env) => {
    const on = vaultViewEnv === id;
    const b = vEl('button', `vd-chip${on ? ' active' : ''}`);
    b.type = 'button';
    b.dataset.env = id;
    b.setAttribute('aria-pressed', String(on));
    if (env) b.appendChild(envDot(env));
    b.append(label);
    if (env) b.appendChild(vEl('span', 'vd-chip-n', String(env.items.length)));
    b.title = env ? `Show the values of ${env.name}${env.baseUrl ? ` (${env.baseUrl})` : ''}` : 'Show every environment, a column each';
    b.addEventListener('click', () => setViewEnv(id));
    box.appendChild(b);
  };
  chip('all', 'All');
  for (const env of vaultData.environments) chip(env.id, env.name, env);
  if (!vaultData.environments.length) box.appendChild(vEl('span', 'vd-legend-none', 'No environments: everything is the same for all'));
}

// Environments ▾: each one to rename (and its base URL) or delete, and a new one.
function openEnvMenu() {
  const btn = $('#vaultEnvsBtn');
  if ($('#actionMenu') && $('#actionMenu').dataset.anchor === btn.id) {
    closeActionMenu();
    return;
  }
  openActionMenu({
    anchor: btn,
    title: 'Environments',
    items: [
      ...vaultData.environments.map((env) => ({ icon: 'edit', label: `${env.name} (${env.items.length})...`, hint: `Rename ${env.name}, its base URL, or delete it`, run: () => openEnvDialog(env) })),
      { icon: 'plus', label: 'New environment...', hint: 'For example dev, sit, uat', run: () => openEnvDialog(null) },
    ],
  });
}

// -- Variables: the items with the same name and type in every environment, as one. Each environment keeps its own
// values; one without it gets it with the + on its tab. The data stays as it is: an item per environment. --
const varKey = (item) => `${item.type}|${itemName(item).trim().toLowerCase()}`;

function vaultVariables() {
  const vars = new Map();
  // the values for no environment first: what a variable is unless an environment has its own
  for (const env of [noEnvItems, ...vaultData.environments]) {
    const seen = new Map();
    for (const item of env.items) {
      let key = varKey(item);
      // the same name twice in one environment: the second is a variable of its own
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n > 1) key += `#${n}`;
      if (!vars.has(key)) vars.set(key, { key, type: item.type, name: itemName(item), entries: [] });
      vars.get(key).entries.push({ env, item });
    }
  }
  return [...vars.values()];
}

// The item of a variable shown: the one of the environment chosen, else the one for no environment, else its first.
const shownEntry = (v) => v.entries.find((e) => e.env.id === selectedEnvId) || v.entries[0];
const envEntries = (v) => v.entries.filter((e) => !e.env.generic);

// What the bar over the page says: the variable open, and its environment; else the environment shown.
function vaultCrumb() {
  const v = detailKey && shownRows.find((x) => x.key === detailKey);
  if (v) {
    const { env } = shownEntry(v);
    return env.generic ? v.name : `${v.name} · ${env.name}`;
  }
  const env = viewEnv();
  return env ? env.name : 'All environments';
}

// The variables of the type, with the search: a variable matches when one of its environments does.
function visibleVariables(type = typeFilter) {
  const q = $('#vaultSearch').value.trim().toLowerCase();
  const rows = vaultVariables().filter((v) => {
    if (type !== 'all' && v.type !== type) return false;
    if (!q) return true;
    return v.entries.some(({ env, item }) =>
      [env.name, item.title, item.username, item.url, item.notes, item.method, item.host, item.database, item.engine, ...(item.attributes || []).map((a) => a.value)].join(' ').toLowerCase().includes(q)
    );
  });
  return { rows, searching: Boolean(q) };
}

// -- The page: the environment shown on top (or all of them), then a section per kind: the users as a table, the
// links, the databases, the notes. A row opens the variable on the right, with a tab per environment it has. --
const VIEW_ENV_KEY = 'vaultViewEnv';
const DEFAULT_ENV_NAME = 'geral'; // the environment the Vault opens on, when there is one by that name
let vaultViewEnv = 'all';
let vaultOpened = false;
let detailKey = null; // the variable open on the right
let selectedItemId = null;
let selectedVarKey = null;
let shownRows = [];
let shownSearching = false;
const quickOpen = { credential: false, link: false };
let qaRefs = null;
// By type: credentials, links, databases, endpoints, notes.
const TYPE_ORDER = ['credential', 'link', 'db', 'endpoint', 'note'];
const sortKey = () => 'type';
const SECTIONS = [
  { type: 'credential', title: 'Users', one: 'user', add: '+ User', quick: 'credential' },
  { type: 'link', title: 'Links', one: 'link', add: '+ Link', quick: 'link' },
  { type: 'endpoint', title: 'Endpoints', one: 'endpoint' },
  { type: 'db', title: 'Databases', one: 'database', add: '+ Database' },
  { type: 'note', title: 'Notes', one: 'note', add: '+ Note' },
];

const viewEnv = () => (vaultViewEnv === 'all' ? null : envById(vaultViewEnv) || null);
// The values of a variable in an environment: its own there, else the ones for no environment (the same for all).
const entryIn = (v, env) => v.entries.find((e) => e.env.id === env.id) || v.entries.find((e) => e.env.generic) || null;
// what + fills in for another environment: its name, or its username when it has no label
const prefillOf = (v) => {
  const from = shownEntry(v).item;
  return from.title ? { title: from.title } : { username: from.username };
};

function setViewEnv(id) {
  vaultViewEnv = id;
  try {
    localStorage.setItem(VIEW_ENV_KEY, id);
  } catch {
    // only until the app closes
  }
  const env = viewEnv();
  if (env) selectedEnvId = env.id;
  renderEnvList();
  renderItems();
}

function renderItems() {
  qaRefs = qaRefs || { credential: $('#qaCredential'), link: $('#qaLink') };
  const box = $('#vaultItems');
  const old = box.querySelector('.vd-sections');
  const scroll = old ? old.scrollTop : 0;
  box.textContent = '';
  const { rows, searching } = visibleVariables('all');
  shownRows = sortRows(rows);
  shownSearching = searching;
  const env = viewEnv();
  const sections = vEl('div', 'vd-sections');
  for (const sec of SECTIONS) {
    // with an environment shown, only what has values there (its own, or the ones for every environment)
    const list = shownRows.filter((v) => v.type === sec.type && (!env || entryIn(v, env)));
    // users, links and notes are always there to add to; the others only when there are some (or a search finds them)
    if (!list.length && (searching || !['credential', 'link', 'note'].includes(sec.type))) continue;
    sections.appendChild(sectionEl(sec, list, env));
  }
  if (!sections.children.length) sections.appendChild(noteEl(searching ? 'No matches' : 'Nothing here yet. Use + New to add something.'));
  box.appendChild(sections);
  sections.scrollTop = scroll;
  const v = detailKey && shownRows.find((x) => x.key === detailKey);
  if (!v) detailKey = null;
  box.classList.toggle('with-detail', Boolean(v));
  if (v) {
    const pick = shownEntry(v);
    selectedVarKey = v.key;
    selectedItemId = pick.item.id;
    box.appendChild(detailPanel(pick.env, pick.item, v));
  }
  updateCrumb();
}

// A variable opened on the right, in an environment (its tab there).
function openDetail(v, env) {
  detailKey = v.key;
  selectedVarKey = v.key;
  if (env) selectedEnvId = env.id;
  saveUiState();
  renderItems();
}

// The variable on the right again (another tab chosen), the sections built again with it.
function selectVariable(key) {
  detailKey = key;
  selectedVarKey = key;
  saveUiState();
  renderItems();
}

function closeDetail() {
  if (!detailKey) return false;
  detailKey = null;
  renderItems();
  return true;
}

function sectionEl(sec, list, env) {
  const section = vEl('section', 'vd-section');
  section.dataset.type = sec.type;
  const head = vEl('div', 'vd-section-head');
  head.append(vEl('h3', '', env && sec.type === 'credential' ? `Users in ${env.name}` : sec.title), vEl('span', 'vd-section-n', String(list.length)));
  head.appendChild(vEl('span', 'vd-head-space'));
  if (sectionItemIds(list, env).length) head.appendChild(vIconBtn('trash', deleteSectionText(sec, list, env), () => deleteSection(sec, list, env), 'danger vd-section-del'));
  if (sec.type === 'credential') {
    const imp = vEl('button', 'btn btn-sm vd-section-import', 'Import...');
    imp.type = 'button';
    imp.title = 'Users from an Excel (.xlsx) or CSV file: name, username and password, then any other columns as attributes';
    imp.addEventListener('click', () => importUsers(env));
    head.appendChild(imp);
  }
  if (sec.add) {
    const add = vEl('button', `btn btn-sm vd-section-add${sec.quick && quickOpen[sec.quick] ? ' on' : ''}`, sec.add);
    add.type = 'button';
    add.title = sec.quick ? `A row to add ${sec.title.toLowerCase()} quickly${env ? ` to ${env.name}` : ''}` : `Add ${sec.title.toLowerCase()}`;
    add.addEventListener('click', () => {
      if (!sec.quick) {
        openItemDialog(sec.type, env, null);
        return;
      }
      quickOpen[sec.quick] = !quickOpen[sec.quick];
      renderItems();
      if (quickOpen[sec.quick]) qaRefs[sec.quick].querySelector('input').focus();
    });
    head.appendChild(add);
  }
  section.appendChild(head);
  if (!list.length) section.appendChild(vEl('div', 'vd-section-empty', `No ${sec.title.toLowerCase()} yet`));
  else if (sec.type === 'credential') section.appendChild(env ? usersTable(list, env) : usersAllTable(list));
  else if (sec.type === 'link') section.appendChild(linksTable(list, env));
  else section.appendChild(itemLines(list, env));
  if (sec.quick) {
    const quick = qaRefs[sec.quick];
    quick.classList.toggle('hidden', !quickOpen[sec.quick]);
    quick.querySelector('.type-pill').textContent = env ? `New in ${env.name}` : 'New for all';
    section.appendChild(quick);
  }
  return section;
}

// What Delete all takes in a section: the variables it lists (after the search); with an environment shown, only their
// items of that environment (the ones for all environments stay), else all their items.
function sectionItemIds(list, env) {
  const ids = [];
  for (const v of list) for (const e of v.entries) if (!env || e.env.id === env.id) ids.push(e.item.id);
  return ids;
}

// "Delete all 4 users, in every environment (5 values)": the variables, and their values when there are more.
function deleteSectionText(sec, list, env) {
  const ids = sectionItemIds(list, env);
  const count = env ? ids.length : list.length;
  const what = count === 1 ? `the ${sec.one}` : `all ${count} ${sec.title.toLowerCase()}`;
  const values = !env && ids.length !== count ? ` (${ids.length} values)` : '';
  return `Delete ${what}${shownSearching ? ' the search shows' : ''}${env ? ` of ${env.name}` : `, in every environment${values}`}`;
}

async function deleteSection(sec, list, env) {
  const ids = sectionItemIds(list, env);
  if (!ids.length) return;
  const lines = [`${deleteSectionText(sec, list, env)}? This cannot be undone.`];
  if (env && list.some((v) => v.entries.some((e) => e.env.generic))) lines.push('The ones for all environments stay.');
  if (!(await window.git.confirm(lines.join('\n')))) return;
  const r = await window.vault.deleteItems(ids);
  if (r.error) toast(r.error, 'error', { plain: true });
  else toast(`${r.deleted} deleted`, 'info', { plain: true });
  await refreshVault();
}

function nameCell(v, e, env) {
  const td = vEl('td', 'vd-td-name');
  td.appendChild(vEl('span', 'vd-row-name', v.name));
  if (isFavorite(v)) {
    const star = vEl('span', 'vd-fav');
    star.title = 'Favorite';
    star.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS.star}</svg>`;
    td.appendChild(star);
  }
  if (env && e && e.env.generic) td.appendChild(vEl('span', 'vd-tag-all', 'all'));
  return td;
}

function addHereButton(v, env) {
  const add = vEl('button', 'vd-link-btn', '+ add');
  add.type = 'button';
  add.title = `Give ${v.name} values for ${env.name}`;
  add.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openItemDialog(v.type, env, null, prefillOf(v));
  });
  return add;
}

function detailsButton(v, env) {
  const b = vIconBtn('chevron', 'Open it on the right', (ev) => {
    ev.stopPropagation();
    openDetail(v, env);
  }, 'vd-open');
  return b;
}

// A row of a table or list that opens its variable (a click, or Enter).
function opens(row, v, env) {
  row.tabIndex = 0;
  row.dataset.key = v.key;
  row.addEventListener('click', () => openDetail(v, env));
  row.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target === row) {
      ev.preventDefault();
      openDetail(v, env);
    }
  });
}

// Users of one environment: name, username and password (a click copies them), Sign in, and the ones not there.
function usersTable(list, env) {
  const table = vEl('table', 'vd-table');
  const head = table.createTHead().insertRow();
  for (const h of ['Name', 'Username', 'Password', '']) head.appendChild(vEl('th', '', h));
  const body = table.createTBody();
  for (const v of list) {
    const e = entryIn(v, env);
    const tr = body.insertRow();
    tr.className = `vd-tr${v.key === detailKey ? ' selected' : ''}`;
    tr.appendChild(nameCell(v, e, env));
    const item = e.item;
    const user = vEl('td', 'vd-td-mono', item.username || '—');
    if (item.username) copyable(user, `Click to copy: ${item.username}`, () => copyText(item.username, 'Username'));
    const pass = vEl('td', 'vd-td-pass');
    if (item.hasPassword) {
      const { pw, toggle } = passwordReveal(item, pass);
      pass.append(pw, toggle);
    } else pass.textContent = '—';
    const act = vEl('td', 'vd-td-act');
    if (canSignIn(item)) {
      act.appendChild(vTextBtn('signIn', 'Sign in', 'Open the page in a window of the app with the username and password filled in (not sent)', (ev) => {
        ev.stopPropagation();
        signInTo(item);
      }));
    }
    act.appendChild(detailsButton(v, e.env));
    tr.append(user, pass, act);
    opens(tr, v, e.env);
  }
  return table;
}

// Users of every environment: a column each (and one for the values for no environment, when there are some), with
// the username; a click on one opens it, + gives it values for that environment.
function usersAllTable(list) {
  const cols = [...(list.some((v) => v.entries.some((e) => e.env.generic)) ? [noEnvItems] : []), ...vaultData.environments];
  const table = vEl('table', 'vd-table vd-table-all');
  const head = table.createTHead().insertRow();
  head.appendChild(vEl('th', '', 'Name'));
  for (const col of cols) {
    const th = vEl('th', '');
    if (col.generic) th.append('Same for all');
    else th.append(envDot(col), col.name);
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const v of list) {
    const tr = body.insertRow();
    tr.className = `vd-tr${v.key === detailKey ? ' selected' : ''}`;
    tr.appendChild(nameCell(v, null, null));
    for (const col of cols) {
      const e = v.entries.find((x) => x.env.id === col.id);
      const td = vEl('td', e ? 'vd-td-mono vd-td-cell' : 'vd-td-none');
      if (e) {
        td.textContent = e.item.username || (e.item.hasPassword ? MASK : '—');
        td.title = `${v.name}${col.generic ? '' : ` in ${col.name}`}: open it`;
        td.addEventListener('click', (ev) => {
          ev.stopPropagation();
          openDetail(v, col);
        });
      } else if (!col.generic) td.appendChild(addHereButton(v, col));
      tr.appendChild(td);
    }
    opens(tr, v, null);
  }
  return table;
}

// Links as a table: the name, the link (a click copies it), Open; with all environments shown, the ones it is in.
function linksTable(list, env) {
  const table = vEl('table', 'vd-table vd-links');
  const head = table.createTHead().insertRow();
  for (const h of env ? ['Name', 'Link', ''] : ['Name', 'Link', 'Environments', '']) head.appendChild(vEl('th', '', h));
  const body = table.createTBody();
  for (const v of list) {
    const e = env ? entryIn(v, env) : shownEntry(v);
    const tr = body.insertRow();
    tr.className = `vd-tr${v.key === detailKey ? ' selected' : ''}`;
    tr.appendChild(nameCell(v, e, env));
    const url = e.item.url || '';
    const link = vEl('td', 'vd-td-mono vd-td-link', url || '\u2014');
    if (url) copyable(link, `Click to copy: ${url}`, () => copyText(url, 'Link'));
    tr.appendChild(link);
    if (!env) {
      const where = vEl('td', 'vd-td-envs');
      const own = envEntries(v);
      if (!own.length) where.appendChild(vEl('span', 'vd-tag-all', 'all'));
      for (const x of own) {
        const dot = envDot(x.env);
        dot.title = x.env.name;
        where.appendChild(dot);
      }
      tr.appendChild(where);
    }
    const act = vEl('td', 'vd-td-act');
    if (/^https?:\/\//i.test(url)) {
      act.appendChild(vTextBtn('open', 'Open', `Open ${url} in your browser`, (ev) => {
        ev.stopPropagation();
        openLink(url);
      }));
    }
    act.appendChild(detailsButton(v, e.env));
    tr.appendChild(act);
    opens(tr, v, e.env);
  }
  return table;
}

// Databases, endpoints and notes: a line each, with what can be done with it (open, copy).
function itemLines(list, env) {
  const box = vEl('div', 'vd-lines');
  for (const v of list) {
    const e = env ? entryIn(v, env) : shownEntry(v);
    const line = vEl('div', `vd-line${v.key === detailKey ? ' selected' : ''}`);
    const name = vEl('span', 'vd-line-name');
    name.append(typeIcon(v.type), vEl('span', 'vd-row-name', v.name));
    if (isFavorite(v)) {
      const star = vEl('span', 'vd-fav');
      star.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS.star}</svg>`;
      name.appendChild(star);
    }
    line.appendChild(name);
    const item = e.item;
    line.appendChild(vEl('span', 'vd-line-sub', itemSubtitle(e.env, item)));
    if (env && e.env.generic) line.appendChild(vEl('span', 'vd-tag-all', 'all'));
    if (!env) {
      const dots = vEl('span', 'vd-row-envs');
      for (const x of envEntries(v)) {
        const dot = envDot(x.env);
        dot.title = x.env.name;
        dots.appendChild(dot);
      }
      line.appendChild(dots);
    }
    const act = vEl('span', 'vd-line-act');
    const url = v.type === 'endpoint' ? resolveUrl(e.env, item.url) : item.url;
    if ((v.type === 'link' || v.type === 'endpoint') && /^https?:\/\//i.test(url || '')) {
      act.append(
        vTextBtn('open', 'Open', `Open ${url} in your browser`, (ev) => {
          ev.stopPropagation();
          openLink(url);
        }),
        vIconBtn('copy', 'Copy the address', (ev) => {
          ev.stopPropagation();
          copyText(url, 'URL');
        })
      );
    } else if (v.type === 'db' && dbConnectionUrl(item)) {
      act.appendChild(vIconBtn('copy', 'Copy the connection URL', (ev) => {
        ev.stopPropagation();
        copyText(dbConnectionUrl(item), 'Connection URL');
      }));
    }
    act.appendChild(detailsButton(v, e.env));
    line.appendChild(act);
    opens(line, v, e.env);
    box.appendChild(line);
  }
  return box;
}

function itemName(item) {
  return item.title || item.username || '(untitled)';
}

// The address of an item: the URL of a credential or link, host:port of a DB, the full address of an endpoint.
function itemAddress(env, item) {
  if (item.type === 'db') {
    const engine = DB_ENGINES[item.engine] || DB_ENGINES.other;
    if (item.host) return item.port || engine.port ? `${item.host}:${item.port || engine.port}` : item.host;
    return dbConnectionUrl(item);
  }
  if (item.type === 'endpoint') return resolveUrl(env, item.url);
  return item.type === 'note' ? '' : item.url || '';
}

// By type (the default): the types in their order, favorites first in each, else the order added. Otherwise favorites
// first (a favorite in any environment), then the chosen column of the item shown (empty values last), else the order
// they were added in.
const isFavorite = (v) => v.entries.some((e) => e.item.favorite);
function sortRows(rows) {
  const key = sortKey();
  const value = (v) => {
    if (key === 'type' || key === 'added') return '';
    const { env, item } = shownEntry(v);
    if (key === 'name') return itemName(item);
    if (key === 'username') return item.username || '';
    return itemAddress(env, item);
  };
  const dir = vaultSort && vaultSort.dir === 'desc' ? -1 : 1;
  return rows
    .map((v, i) => ({ v, i, s: value(v).toLowerCase() }))
    .sort((a, b) => {
      if (key === 'type' && a.v.type !== b.v.type) return TYPE_ORDER.indexOf(a.v.type) - TYPE_ORDER.indexOf(b.v.type);
      if (isFavorite(a.v) !== isFavorite(b.v)) return isFavorite(a.v) ? -1 : 1;
      if (a.s !== b.s) {
        if (!a.s) return 1;
        if (!b.s) return -1;
        return a.s.localeCompare(b.s, undefined, { numeric: true }) * dir;
      }
      return a.i - b.i;
    })
    .map((x) => x.v);
}

// The line under a name in the list: the site of a credential or link (else its username), the engine and host of
// a DB, the method and address of an endpoint, the first line of a note.
function itemSubtitle(env, item) {
  if (item.type === 'note') return (item.notes || '').split('\n').find((l) => l.trim()) || '';
  if (item.type === 'db') {
    const address = itemAddress(env, item);
    const engine = (DB_ENGINES[item.engine] || DB_ENGINES.other).label;
    return address ? `${engine} \u00b7 ${address}` : engine;
  }
  if (item.type === 'endpoint') return `${item.method} ${itemAddress(env, item).replace(/^https?:\/\//i, '')}`;
  if (item.url) {
    try {
      return new URL(item.url).host;
    } catch {
      return item.url;
    }
  }
  return item.username || '';
}

// A button with an icon and words, for the main actions of the item on the right.
function vTextBtn(icon, label, title, handler, cls = '') {
  const b = vEl('button', `btn btn-sm vd-btn ${cls}`.trim());
  b.type = 'button';
  b.title = title;
  b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[icon]}</svg>`;
  b.append(label);
  b.addEventListener('click', handler);
  return b;
}

// Over the details: a tab per environment the variable has values for (none when it is the same for all), and + to give
// it values for another one.
function envTabs(v, current) {
  const bar = vEl('div', 'vd-envs');
  const own = envEntries(v);
  const tabs = vEl('div', 'vd-env-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Environments');
  // with environments of its own, its values for no environment are a tab too
  const shown = own.length ? v.entries : [];
  for (const { env } of shown) {
    const on = env.id === current.id;
    const tab = vEl('button', `vd-env${on ? ' active' : ''}${env.generic ? ' vd-env-none' : ''}`);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(on));
    if (env.generic) tab.append('No environment');
    else tab.append(envDot(env), env.name);
    tab.title = env.generic ? `${v.name} for every environment without values of its own` : `${v.name} in ${env.name}`;
    tab.addEventListener('click', () => {
      selectedEnvId = env.id;
      selectVariable(v.key);
      const again = $('#vaultItems .vd-env.active');
      if (again) again.focus();
    });
    tabs.appendChild(tab);
  }
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const all = [...tabs.querySelectorAll('.vd-env')];
    const i = all.indexOf(document.activeElement);
    if (i === -1) return;
    e.preventDefault();
    all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length].click();
  });
  const add = vEl('button', 'vd-env-plus');
  add.type = 'button';
  add.setAttribute('aria-haspopup', 'menu');
  add.title = own.length ? `Give ${v.name} values for another environment` : `${v.name} is the same for every environment: give it values for one`;
  add.append(vEl('span', 'vd-env-add', '+'), own.length ? '' : 'Environment');
  add.addEventListener('click', () => openAddEnvMenu(v, add));
  bar.append(tabs, add);
  return bar;
}

// + : the environments the variable has no values for (and no environment, when it has none for that), then a new one.
function openAddEnvMenu(v, anchor) {
  if ($('#actionMenu') && $('#actionMenu').addEnvAnchor === anchor) {
    closeActionMenu();
    return;
  }
  const has = new Set(v.entries.map((e) => e.env.id));
  // the same name (or username, when it has no label) for the new environment
  const from = shownEntry(v).item;
  const prefill = from.title ? { title: from.title } : { username: from.username };
  const items = vaultData.environments
    .filter((env) => !has.has(env.id))
    .map((env) => ({ icon: 'plus', label: env.name, hint: `Values of ${v.name} for ${env.name}`, run: () => openItemDialog(v.type, env, null, prefill) }));
  if (!has.has(NO_ENV_ID)) items.push({ icon: 'plus', label: 'No environment', hint: `Values of ${v.name} for every environment without its own`, run: () => openItemDialog(v.type, null, null, prefill) });
  items.push({ icon: 'edit', label: 'New environment...', hint: 'For example dev, sit, uat', run: () => openEnvDialog(null) });
  openActionMenu({ anchor, title: `${v.name} for`, items });
  if ($('#actionMenu')) $('#actionMenu').addEnvAnchor = anchor;
}


// The chosen item in full: its name and actions on top, a tab per environment, every field as a block that copies on a
// click (the password with its eye), then Sign in and Open in the browser.
function detailPanel(env, item, v) {
  const panel = vEl('div', 'vd-detail');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', itemName(item));
  const head = vEl('div', 'vd-head');
  const title = vEl('div', 'vd-title');
  const name = vEl('span', 'vd-title-text', itemName(item));
  name.title = itemName(item);
  title.append(typeIcon(item.type), name);
  head.append(title, vEl('span', `type-pill type-${item.type}`, TYPE_LABELS[item.type]));
  head.appendChild(vEl('span', 'vd-head-space'));
  const star = vIconBtn('star', item.favorite ? 'Remove from favorites' : 'Add to favorites (they come first)', () => toggleItemFavorite(item), `vd-star${item.favorite ? ' on' : ''}`);
  star.setAttribute('aria-pressed', String(Boolean(item.favorite)));
  head.appendChild(star);
  const pop = popoutButton(item);
  if (pop) head.appendChild(pop);
  head.append(...itemActions(env, item));
  if (v) head.appendChild(vIconBtn('close', 'Close (Esc)', () => closeDetail(), 'vd-close'));
  panel.appendChild(head);
  if (v) panel.appendChild(envTabs(v, env));

  const fields = vEl('div', 'vd-fields');
  const buttons = vEl('div', 'vd-buttons');
  const text = (label, value, what) => vBlock(label, value, `Click to copy: ${value}`, () => copyText(value, what));
  const openButton = (url) => vTextBtn('open', 'Open in the browser', `Open ${url} in your browser`, () => openLink(url));
  if (item.type === 'credential' || item.type === 'link') {
    if (item.url) fields.appendChild(text(item.type === 'link' ? 'URL' : 'Site', item.url, 'URL'));
    if (item.username) fields.appendChild(text('Username', item.username, 'Username'));
    if (item.hasPassword) fields.appendChild(passwordBlock(item));
    if (canSignIn(item)) {
      buttons.appendChild(vTextBtn('signIn', 'Sign in', 'Open the page in a window of the app with the username and password filled in (not sent)', () => signInTo(item), 'btn-primary'));
    }
    if (/^https?:\/\//i.test(item.url || '')) buttons.appendChild(openButton(item.url));
  } else if (item.type === 'db') {
    const engine = DB_ENGINES[item.engine] || DB_ENGINES.other;
    fields.appendChild(vBlock('Engine', engine.label));
    if (item.host) fields.appendChild(text('Host', item.port || engine.port ? `${item.host}:${item.port || engine.port}` : item.host, 'Host'));
    if (item.database) fields.appendChild(text('Database', item.database, 'Database name'));
    if (item.username) fields.appendChild(text('User', item.username, 'Username'));
    if (item.hasPassword) fields.appendChild(passwordBlock(item));
    const url = dbConnectionUrl(item);
    if (url) fields.appendChild(text('Connection URL', url, 'Connection URL'));
    buttons.appendChild(vTextBtn('spring', 'Copy Spring config', 'Copy the Spring Boot datasource config (kept out of the clipboard history)', () => copySpringConfig(item)));
  } else if (item.type === 'endpoint') {
    const full = resolveUrl(env, item.url);
    const value = vEl('span', 'vault-block-value');
    value.append(vEl('span', `method-pill m-${item.method}`, item.method), ` ${full}`);
    fields.appendChild(vBlock('Endpoint', value, `Click to copy: ${full}`, () => copyText(full, 'Endpoint')));
    if (/^https?:\/\//i.test(full) && item.method === 'GET') buttons.appendChild(openButton(full));
  }
  // the other columns of an import: shown here only
  if (item.attributes && item.attributes.length) {
    fields.appendChild(vEl('div', 'vd-attrs-head', 'Attributes'));
    for (const a of item.attributes) fields.appendChild(text(a.name, a.value, a.name));
  }
  if (item.notes) {
    const note = vEl('span', 'vault-block-value vault-block-note', item.notes);
    fields.appendChild(vBlock(item.type === 'note' ? 'Note' : 'Notes', note, 'Click to copy the note', () => copyText(item.notes, 'Note')));
  }
  if (!fields.children.length) fields.appendChild(vEl('span', 'vault-tile-empty', 'Nothing to copy'));
  panel.appendChild(fields);
  if (buttons.children.length) panel.appendChild(buttons);
  return panel;
}

// -- Import users: the file is chosen and read (by the app, which keeps its passwords), then this popup shows what it
// has and asks the environment; one with the same name there is updated, the others are added. --
async function importUsers(env) {
  const picked = await window.vault.importPick();
  if (!picked || picked.canceled) return;
  if (picked.error) {
    toast(picked.error, 'error', { title: "Couldn't read the file", plain: true });
    return;
  }
  const modal = vEl('div', 'settings-overlay vd-import');
  modal.id = 'vaultImportModal';
  const card = vEl('div', 'settings-card vd-import-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', 'Import users');
  const n = picked.users.length;
  const intro = [`${picked.file}: ${n} ${n === 1 ? 'user' : 'users'}.`];
  intro.push(picked.attributes.length
    ? `The first three columns are the name, the username and the password; the others (${picked.attributes.join(', ')}) are kept with each user, shown when you open it.`
    : 'The three columns are the name, the username and the password.');
  if (picked.skipped) intro.push(`${picked.skipped} ${picked.skipped === 1 ? 'row has' : 'rows have'} no username and no password, so ${picked.skipped === 1 ? 'it is' : 'they are'} left out.`);
  const where = vEl('label', 'vd-import-where', 'Into ');
  const select = vEl('select', 'input');
  for (const e of vaultData.environments) select.appendChild(new Option(e.name, e.id));
  select.appendChild(new Option('No environment (the same for all)', NO_ENV_ID));
  select.value = env ? env.id : NO_ENV_ID;
  where.appendChild(select);
  const same = vEl('div', 'settings-hint vd-import-same');
  const table = vEl('table', 'vd-table vd-import-table');
  const head = table.createTHead().insertRow();
  for (const h of ['Name', 'Username', 'Password', 'Attributes']) head.appendChild(vEl('th', '', h));
  const body = table.createTBody();
  for (const u of picked.users.slice(0, 8)) {
    const tr = body.insertRow();
    tr.append(
      vEl('td', 'vd-td-name', u.title || '\u2014'),
      vEl('td', 'vd-td-mono', u.username || '\u2014'),
      vEl('td', 'vd-td-mono', u.hasPassword ? MASK : '\u2014'),
      vEl('td', 'vd-td-attrs', u.attributes.map((a) => `${a.name}: ${a.value}`).join(' \u00b7 ') || '\u2014'),
    );
  }
  const more = n > 8 ? vEl('div', 'settings-hint', `and ${n - 8} more`) : null;
  const actions = vEl('div', 'action-row settings-actions');
  const cancel = vEl('button', 'btn', 'Cancel');
  cancel.type = 'button';
  const ok = vEl('button', 'btn btn-primary', `Import ${n} ${n === 1 ? 'user' : 'users'}`);
  ok.type = 'button';
  actions.append(cancel, ok);
  card.append(vEl('h3', '', 'Import users'), vEl('p', 'settings-hint', intro.join(' ')), where, same, table, ...(more ? [more] : []), actions);
  modal.appendChild(card);
  // the ones already there with the same name (the label, else the username): updated, not added
  const showSame = () => {
    const target = select.value === NO_ENV_ID ? noEnvItems : envById(select.value);
    const names = new Set((target ? target.items : []).filter((i) => i.type === 'credential').map((i) => itemName(i).toLowerCase()));
    const k = picked.users.filter((u) => names.has((u.title || u.username).toLowerCase())).length;
    same.textContent = k ? `${k} already ${k === 1 ? 'is' : 'are'} there with the same name: ${k === 1 ? 'its' : 'their'} username, password and attributes are replaced.` : '';
  };
  select.addEventListener('change', showSame);
  showSame();
  const close = () => modal.remove();
  cancel.addEventListener('click', close);
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) close();
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    const r = await window.vault.importUsers(picked.token, select.value === NO_ENV_ID ? '' : select.value);
    close();
    if (r.error) {
      toast(r.error, 'error', { title: "Couldn't import", plain: true });
      return;
    }
    const into = select.value === NO_ENV_ID ? 'no environment' : (envById(select.value) || {}).name;
    const parts = [r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.skipped && `${r.skipped} skipped`].filter(Boolean).join(', ');
    toast(`Imported into ${into}: ${parts || 'nothing'}`, 'success', { plain: true });
    await refreshVault();
  });
  document.body.appendChild(modal);
  ok.focus();
}

async function toggleItemFavorite(item) {
  const r = await window.vault.setFavorite(item.id, !item.favorite);
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  await refreshVault();
}

// -- New item menu: the type of the open tab comes first --
function closeVaultNewMenu(refocus = false) {
  const menu = $('#vaultNewMenu');
  if (!menu) return;
  menu.remove();
  const btn = $('#vaultNewBtn');
  btn.setAttribute('aria-expanded', 'false');
  btn.classList.remove('open');
  if (refocus) btn.focus();
}

function openVaultNewMenu() {
  if ($('#vaultNewMenu')) {
    closeVaultNewMenu();
    return;
  }
  const btn = $('#vaultNewBtn');
  const menu = vEl('div', 'clip-menu vault-new-menu');
  menu.id = 'vaultNewMenu';
  menu.setAttribute('role', 'menu');
  const order = NEW_TYPES.includes(typeFilter) ? [typeFilter, ...NEW_TYPES.filter((t) => t !== typeFilter)] : NEW_TYPES;
  for (const type of order) {
    const item = vEl('button', 'clip-menu-item vault-new-item');
    item.type = 'button';
    item.dataset.add = type;
    item.setAttribute('role', 'menuitem');
    item.append(typeIcon(type), TYPE_LABELS[type]);
    item.addEventListener('click', () => {
      closeVaultNewMenu();
      openItemDialog(type, viewEnv(), null);
    });
    menu.appendChild(item);
  }
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeVaultNewMenu(true);
    } else if (e.key === 'Tab') {
      closeVaultNewMenu();
    }
  });
  document.body.appendChild(menu);
  // below the button, its right edge lined up with the button
  const a = btn.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  menu.style.left = `${Math.round(Math.max(8, a.right - m.width))}px`;
  menu.style.top = `${Math.round(a.bottom + 4)}px`;
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('open');
  menu.querySelector('button').focus();
}

// A field of a card as a block: its label over its value; a click anywhere on it copies the value.
function vBlock(label, value, title, copy) {
  const block = vEl('div', 'vault-block');
  block.append(vEl('span', 'vault-block-label', label), typeof value === 'string' ? vEl('span', 'vault-block-value', value) : value);
  if (copy) copyable(block, title, copy);
  return block;
}

function popoutButton(item) {
  if (CARD_ID) return null;
  return vIconBtn('popout', 'Open this item as a card in its own window (stays open when you click outside)', (e) => {
    // from the item on the right, the card opens over it, as wide as a card; its window then fits its height
    const card = e.currentTarget.closest('.vault-card');
    const rect = (card || e.currentTarget.closest('.vd-detail')).getBoundingClientRect();
    window.vault.popout({
      id: item.id,
      width: card ? Math.round(rect.width) : 280,
      height: card ? Math.round(rect.height) : 200,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
    });
  }, 'tile-popout');
}

function itemActions(env, item) {
  if (CARD_ID) return [vIconBtn('close', 'Close this window', () => window.vault.closeCard())];
  return [
    vIconBtn('edit', 'Edit', () => openItemDialog(item.type, env, item)),
    vIconBtn('trash', 'Delete', async () => {
      if (!(await window.git.confirm(`Delete "${item.title || item.username || 'this item'}"?`))) return;
      const r = await window.vault.deleteItem(item.id);
      if (r.error) toast(r.error, 'error');
      else toast('Deleted', 'info');
      await refreshVault();
    }, 'danger'),
  ];
}

function copyable(el, title, copy) {
  el.classList.add('copyable');
  el.title = title;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  const run = async () => {
    if (!(await copy())) return;
    el.classList.add('copied');
    setTimeout(() => el.classList.remove('copied'), 1000);
  };
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    // text selected in this value (to copy a part of it) is left alone; a selection elsewhere (a field) does not count
    const selection = window.getSelection();
    if (selection.toString() && el.contains(selection.anchorNode)) return;
    run();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      run();
    }
  });
  return el;
}

// A Vault item as a card: its title and type on top, its fields as blocks that copy on a click, the actions below.
function createCard(env, item, showEnv) {
  const card = vEl('div', 'vault-card vault-tile');
  const head = vEl('div', 'vault-tile-head');
  const title = vEl('span', 'vault-tile-title', item.title || item.username || '(untitled)');
  title.title = item.notes && item.type !== 'note' ? `${title.textContent}\n\n${item.notes}` : title.textContent;
  head.appendChild(title);
  if (showEnv) head.appendChild(vEl('span', 'vault-env-tag', env.name));
  head.appendChild(vEl('span', `type-pill type-${item.type}`, TYPE_LABELS[item.type]));
  card.appendChild(head);

  const blocks = vEl('div', 'vault-blocks');
  const foot = vEl('div', 'vault-tile-foot');
  const pop = popoutButton(item);
  if (pop) foot.appendChild(pop);
  const buttons = [];
  const text = (label, value, what) => vBlock(label, value, `Click to copy: ${value}`, () => copyText(value, what));
  if (item.type === 'credential') {
    if (item.username) blocks.appendChild(text('Username', item.username, 'Username'));
    if (item.hasPassword) blocks.appendChild(passwordBlock(item));
    if (canSignIn(item)) buttons.push(signInButton(item));
    if (item.url) buttons.push(vIconBtn('open', `Open ${item.url}`, () => openLink(item.url)));
  } else if (item.type === 'link') {
    // the URL copies on a click; its right side opens it in the browser
    const urlBlock = text('URL', item.url, 'URL');
    const open = vIconBtn('open', 'Open in the browser', (e) => {
      e.stopPropagation();
      openLink(item.url);
    });
    urlBlock.classList.add('has-action');
    if (canSignIn(item)) {
      urlBlock.classList.add('has-two');
      urlBlock.appendChild(signInButton(item));
    }
    urlBlock.appendChild(open);
    blocks.appendChild(urlBlock);
    // the username and the password side by side, under the URL
    const pair = vEl('div', 'vault-blocks-pair');
    if (item.username) pair.appendChild(text('Username', item.username, 'Username'));
    if (item.hasPassword) pair.appendChild(passwordBlock(item));
    if (pair.children.length) blocks.appendChild(pair);
  } else if (item.type === 'db') {
    appendDbBlocks(blocks, foot, buttons, item);
  } else if (item.type === 'endpoint') {
    const full = resolveUrl(env, item.url);
    const value = vEl('span', 'vault-block-value');
    value.append(vEl('span', `method-pill m-${item.method}`, item.method), ` ${full}`);
    blocks.appendChild(vBlock('Endpoint', value, `Click to copy: ${full}`, () => copyText(full, 'Endpoint')));
    if (/^https?:\/\//i.test(full) && item.method === 'GET') buttons.push(vIconBtn('open', 'Open in the browser', () => openLink(full)));
  } else if (item.notes) {
    const note = vEl('span', 'vault-block-value vault-block-note', item.notes);
    blocks.appendChild(vBlock('Note', note, 'Click to copy the note', () => copyText(item.notes, 'Note')));
  }
  if (!blocks.children.length) blocks.appendChild(vEl('span', 'vault-tile-empty', 'Nothing to copy'));
  card.appendChild(blocks);
  if (item.type !== 'note' && item.notes) {
    const notes = vEl('div', 'vault-tile-notes', item.notes);
    notes.title = item.notes;
    card.appendChild(notes);
  }
  foot.append(...buttons, ...itemActions(env, item));
  card.appendChild(foot);
  return card;
}

// target: the element a click on copies the password from (the dots, or the block they are in).
function passwordReveal(item, target = null) {
  const pw = vEl('span', 'vault-value mono', MASK);
  let timer = null;
  let shown = false;
  const toggle = vIconBtn('eye', 'Show the password for a few seconds', () => {});
  toggle.addEventListener('click', (e) => e.stopPropagation()); // showing it does not copy it
  const hide = () => {
    clearTimeout(timer);
    shown = false;
    pw.textContent = MASK;
    toggle.classList.remove('on');
    setIcon(toggle, 'eye');
    toggle.title = 'Show the password for a few seconds';
  };
  toggle.onclick = async () => {
    if (shown) {
      hide();
      return;
    }
    const r = await window.vault.getSecret(item.id);
    if (r.error) {
      toast(r.error, 'error');
      return;
    }
    pw.textContent = r.password || '(empty)';
    shown = true;
    toggle.classList.add('on');
    setIcon(toggle, 'eyeOff');
    toggle.title = 'Hide the password';
    timer = setTimeout(hide, REVEAL_MS);
  };
  copyable(target || pw, 'Click to copy the password (the clipboard is cleared after 30 seconds)', async () => {
    const r = await window.vault.copySecret(item.id);
    toast(r.error || `Password copied, clipboard clears in ${r.clearsInSeconds}s`, r.error ? 'error' : 'success');
    return !r.error;
  });
  return { pw, toggle };
}

// The password as a block: dots, an eye that shows it for a few seconds, and a click that copies it.
function passwordBlock(item) {
  const block = vEl('div', 'vault-block vault-block-secret has-action');
  const { pw, toggle } = passwordReveal(item, block);
  pw.className = 'vault-block-value';
  block.append(vEl('span', 'vault-block-label', 'Password'), pw, toggle);
  return block;
}

function appendDbBlocks(blocks, foot, buttons, item) {
  const engine = DB_ENGINES[item.engine] || DB_ENGINES.other;
  blocks.classList.add('two');
  foot.appendChild(vEl('span', 'db-engine', engine.label));
  const text = (label, value, what) => vBlock(label, value, `Click to copy: ${value}`, () => copyText(value, what));
  if (item.host) blocks.appendChild(text('Host', item.port || engine.port ? `${item.host}:${item.port || engine.port}` : item.host, 'Host'));
  if (item.database) blocks.appendChild(text('Database', item.database, 'Database name'));
  if (item.username) blocks.appendChild(text('User', item.username, 'Username'));
  if (item.hasPassword) blocks.appendChild(passwordBlock(item));
  const url = dbConnectionUrl(item);
  if (url) buttons.push(vIconBtn('link', `Copy the connection URL: ${url}`, () => copyText(url, 'Connection URL')));
  buttons.push(vIconBtn('spring', 'Copy the Spring Boot datasource config (kept out of the clipboard history)', () => copySpringConfig(item)));
}

async function copySpringConfig(item) {
  let password = '';
  if (item.hasPassword) {
    const r = await window.vault.getSecret(item.id);
    if (r.error) {
      toast(r.error, 'error');
      return;
    }
    password = r.password;
  }
  const r = await window.vault.copySensitive(springDatasourceConfig(item, password));
  toast(r.error || `Spring config copied, clipboard clears in ${r.clearsInSeconds}s`, r.error ? 'error' : 'success');
}

// -- Item dialog --
function closeItemDialog() {
  $('#itemModal').classList.add('hidden');
  itemDialog = null;
}

async function openItemDialog(type, env, existing, prefill = null) {
  // env null (or the one for no environment): the item is the same for every environment
  if (env && env.generic) env = null;
  const it = existing || prefill || {};
  const fields = {};
  const form = $('#itemForm');
  form.textContent = '';

  const addField = (key, label, node) => {
    const wrap = vEl('div', 'form-field');
    wrap.append(vEl('label', 'settings-label', label), node);
    form.appendChild(wrap);
    fields[key] = node;
  };
  const input = (placeholder, value, max) => {
    const i = vEl('input', 'input form-input');
    i.placeholder = placeholder;
    i.value = value || '';
    i.maxLength = max;
    return i;
  };
  const area = (rows, value, placeholder) => {
    const a = vEl('textarea', 'input form-input');
    a.rows = rows;
    a.value = value || '';
    a.maxLength = 5000;
    a.placeholder = placeholder || '';
    return a;
  };

  const addPassword = () => {
    const pw = vEl('input', 'input form-input');
    pw.type = 'password';
    pw.maxLength = 500;
    pw.autocomplete = 'off';
    const group = vEl('div', 'input-group');
    const toggle = vIconBtn('eye', 'Show or hide the password', () => {
      pw.type = pw.type === 'password' ? 'text' : 'password';
      setIcon(toggle, pw.type === 'password' ? 'eye' : 'eyeOff');
    });
    group.append(pw, toggle);
    addField('password', 'Password', group);
    fields.password = pw;
  };
  const pair = (a, b) => {
    const row = vEl('div', 'form-pair');
    row.append(a, b);
    return row;
  };

  const titleHints = { credential: 'e.g. Admin user', link: 'e.g. Customer portal', db: 'e.g. Orders database', endpoint: 'e.g. Users page', note: 'e.g. VPN setup' };
  addField('title', type === 'credential' ? 'Label (optional)' : 'Title', input(titleHints[type], it.title, 120));

  if (type === 'db') {
    const engine = vEl('select', 'input form-input');
    Object.entries(DB_ENGINES).forEach(([id, e]) => {
      const o = vEl('option', '', e.label);
      o.value = id;
      engine.appendChild(o);
    });
    engine.value = it.engine || 'postgresql';
    const host = input('e.g. db.dev.example.com', it.host, 255);
    const port = input('', it.port ? String(it.port) : '', 5);
    const database = input('database or service name', it.database, 200);
    const url = input('', it.url, 1000);
    const updatePlaceholders = () => {
      const e = DB_ENGINES[engine.value];
      port.placeholder = e.port ? String(e.port) : 'port';
      url.placeholder = e.url ? 'Leave empty to build it from host, port and database' : 'e.g. jdbc:h2:mem:test';
    };
    engine.addEventListener('change', updatePlaceholders);
    updatePlaceholders();
    const field = (label, node) => {
      const wrap = vEl('div', 'form-field');
      wrap.append(vEl('label', 'settings-label', label), node);
      return wrap;
    };
    form.appendChild(pair(field('Engine', engine), field('Port', port)));
    addField('host', 'Host', host);
    addField('database', 'Database', database);
    Object.assign(fields, { engine, port });
    addField('username', 'Username', input('', it.username, 200));
    addPassword();
    addField('url', 'Connection URL (optional)', url);
    addField('notes', 'Notes (optional)', area(2, it.notes));
  } else if (type === 'credential') {
    addField('username', 'Username', input('', it.username, 200));
    addPassword();
    addField('url', 'Login URL (optional)', input('https://...', it.url, 1000));
    addField('notes', 'Notes (optional)', area(3, it.notes));
  } else if (type === 'link') {
    addField('url', 'URL', input('https://...', it.url, 1000));
    addField('username', 'Username (optional)', input('', it.username, 200));
    addPassword();
    fields.password.closest('.form-field').querySelector('label').textContent = 'Password (optional)';
    addField('notes', 'Notes (optional)', area(3, it.notes));
  } else if (type === 'endpoint') {
    const method = vEl('select', 'input');
    HTTP_METHODS.forEach((m) => {
      const o = vEl('option', '', m);
      o.value = m;
      method.appendChild(o);
    });
    method.value = it.method || 'GET';
    const url = input(env && env.baseUrl ? '/api/users' : 'https://...', it.url, 1000);
    url.classList.add('form-input');
    const row = vEl('div', 'form-row');
    row.append(method, url);
    addField('url', 'Method and path or URL', row);
    fields.method = method;
    fields.url = url;
    addField('notes', 'Notes (optional)', area(3, it.notes));
  } else {
    addField('notes', 'Note', area(8, it.notes));
  }

  // a new item: no environment unless one is chosen
  const dialogTitle = (e) => `${existing ? 'Edit' : 'Add'} ${TYPE_LABELS[type].toLowerCase()}${e ? ` in ${e.name}` : ''}`;
  let envSelect = null;
  if (!existing && vaultData.environments.length) {
    envSelect = vEl('select', 'input form-input');
    envSelect.appendChild(new Option('No environment (the same for all)', ''));
    for (const e of vaultData.environments) envSelect.appendChild(new Option(e.name, e.id));
    envSelect.value = env ? env.id : '';
    const wrap = vEl('div', 'form-field');
    wrap.append(vEl('label', 'settings-label', 'Environment'), envSelect);
    form.prepend(wrap);
  }
  itemDialog = { type, envId: env ? env.id : '', id: it.id, fields };
  $('#itemModalTitle').textContent = dialogTitle(env);
  if (envSelect) {
    envSelect.addEventListener('change', () => {
      itemDialog.envId = envSelect.value;
      $('#itemModalTitle').textContent = dialogTitle(envById(envSelect.value));
    });
  }
  $('#itemModal').classList.remove('hidden');

  if (existing && existing.hasPassword && fields.password) {
    const r = await window.vault.getSecret(existing.id);
    if (!r.error) fields.password.value = r.password;
  }
  (type === 'credential' ? fields.username : fields.title || fields.notes).focus();
}

async function saveItemDialog() {
  if (!itemDialog) return;
  const { type, envId, id, fields } = itemDialog;
  const val = (k) => (fields[k] ? fields[k].value : '');
  const r = await window.vault.saveItem({
    id,
    envId,
    type,
    title: val('title'),
    username: val('username'),
    password: val('password'),
    url: val('url'),
    method: val('method'),
    engine: val('engine'),
    host: val('host'),
    port: val('port'),
    database: val('database'),
    notes: val('notes'),
  });
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  closeItemDialog();
  toast('Saved', 'success');
  // a new one is shown, in its environment
  if (!id && r.id) {
    selectedEnvId = envId || NO_ENV_ID;
    selectedItemId = r.id;
    selectedVarKey = null;
  }
  await refreshVault();
}

// -- Environment dialog --
function closeEnvDialog() {
  $('#envModal').classList.add('hidden');
}

function openEnvDialog(env) {
  envDialogId = env ? env.id : null;
  $('#envDeleteBtn').classList.toggle('hidden', !env);
  $('#envModalTitle').textContent = env ? 'Edit environment' : 'New environment';
  $('#envName').value = env ? env.name : '';
  $('#envBaseUrl').value = env ? env.baseUrl : '';
  $('#envModal').classList.remove('hidden');
  $('#envName').focus();
}

async function saveEnvDialog() {
  const r = await window.vault.saveEnv({
    id: envDialogId,
    name: $('#envName').value,
    baseUrl: $('#envBaseUrl').value,
  });
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  selectedEnvId = r.id;
  closeEnvDialog();
  toast('Saved', 'success');
  await refreshVault();
}

function setupVault() {
  $('#addEnvBtn').addEventListener('click', () => openEnvDialog(null));
  $('#vaultEnvsBtn').addEventListener('click', openEnvMenu);
  $('#envDeleteBtn').addEventListener('click', async () => {
    const env = envById(envDialogId);
    if (!env) return;
    const n = env.items.length;
    if (!(await window.git.confirm(`Delete environment "${env.name}" and its ${n} item${n !== 1 ? 's' : ''}? This cannot be undone.`))) return;
    const r = await window.vault.deleteEnv(env.id);
    if (r.error) toast(r.error, 'error');
    else toast('Environment deleted', 'info');
    closeEnvDialog();
    if (selectedEnvId === env.id) selectedEnvId = null;
    await refreshVault();
  });

  $('#vaultNewBtn').addEventListener('click', openVaultNewMenu);
  document.addEventListener('mousedown', (e) => {
    const menu = $('#vaultNewMenu');
    if (menu && !menu.contains(e.target) && !$('#vaultNewBtn').contains(e.target)) closeVaultNewMenu();
  });
  window.addEventListener('blur', () => closeVaultNewMenu());
  // "/" goes to the search box, unless something is being typed or a dialog is open
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || currentMode !== 'vault') return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('.settings-overlay:not(.hidden)') || $('#vaultMain').classList.contains('hidden')) return;
    e.preventDefault();
    $('#vaultSearch').focus();
  });
  try {
    vaultViewEnv = localStorage.getItem(VIEW_ENV_KEY) || 'all';
  } catch {
    // all of them
  }
  // Esc closes the variable open on the right (not while typing, nor over a dialog or a menu)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || currentMode !== 'vault' || !detailKey) return;
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (document.querySelector('.settings-overlay:not(.hidden)') || $('#actionMenu') || $('#vaultNewMenu')) return;
    e.preventDefault();
    closeDetail();
  });
  $('#vaultSearch').addEventListener('input', renderItems);
  $('#vaultSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.value) {
      e.target.value = '';
      renderItems();
      e.stopPropagation();
    }
  });

  $('#itemCancelBtn').addEventListener('click', closeItemDialog);
  $('#itemSaveBtn').addEventListener('click', saveItemDialog);
  $('#itemModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeItemDialog();
    else if (e.key === 'Enter' && e.target.tagName === 'INPUT') saveItemDialog();
  });

  $('#envCancelBtn').addEventListener('click', closeEnvDialog);
  $('#envSaveBtn').addEventListener('click', saveEnvDialog);
  $('#envModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEnvDialog();
    else if (e.key === 'Enter') saveEnvDialog();
  });
}

setupVault();

// -- Quick add rows (Credentials and Links tabs) --
const withScheme = (u) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`);

function hostOf(url) {
  try {
    return new URL(withScheme(url)).host;
  } catch {
    return '';
  }
}

// The quick rows add to the environment shown, or for no environment (the same for all) when all are shown.
async function quickSave(item, inputs) {
  const env = viewEnv();
  const r = await window.vault.saveItem({ envId: env ? env.id : '', ...item });
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  inputs.forEach((i) => (i.value = ''));
  toast('Saved', 'success');
  await refreshVault();
  inputs[0].focus();
}

function setupQuickAdd() {
  const cred = [$('#qaCredTitle'), $('#qaCredUser'), $('#qaCredPass')];
  const addCred = () =>
    quickSave({ type: 'credential', title: cred[0].value, username: cred[1].value, password: cred[2].value }, cred);
  $('#qaCredAdd').addEventListener('click', addCred);
  cred.forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && addCred()));

  const link = [$('#qaLinkTitle'), $('#qaLinkUrl')];
  const addLink = () => {
    const url = link[1].value.trim();
    quickSave({ type: 'link', title: link[0].value.trim() || hostOf(url) || url, url }, link);
  };
  $('#qaLinkAdd').addEventListener('click', addLink);
  link.forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && addLink()));
}

// While the quick row of the links is open, a URL copied to the clipboard is put into its URL field.
const CLIPBOARD_POLL_MS = 800;
let clipWatchActive = false;
let lastClip = null;

function offerClipboardUrl(url) {
  const normalized = withScheme(url);
  if ([noEnvItems, ...vaultData.environments].some((env) => env.items.some((i) => i.type === 'link' && i.url === normalized))) return;
  const input = $('#qaLinkUrl');
  if (document.activeElement === input || input.value.trim() === url) return;
  input.value = url;
  input.classList.add('copied');
  setTimeout(() => input.classList.remove('copied'), 900);
  if (!$('#qaLinkTitle').value) $('#qaLinkTitle').focus();
}

async function clipboardTick() {
  const active =
    currentMode === 'vault' &&
    quickOpen.link &&
    !document.hidden &&
    !$('#vaultMain').classList.contains('hidden');
  if (!active) {
    clipWatchActive = false;
    return;
  }
  let url;
  try {
    url = await window.vault.clipboardUrl();
  } catch {
    return;
  }
  if (!clipWatchActive) {
    clipWatchActive = true;
    lastClip = url;
    if (url) offerClipboardUrl(url);
    return;
  }
  if (url && url !== lastClip) offerClipboardUrl(url);
  lastClip = url;
}

if (!CARD_ID) {
  setupQuickAdd();
  setInterval(clipboardTick, CLIPBOARD_POLL_MS);
}

// -- Pop-out card window --
async function renderCardWindow() {
  const root = $('#cardWindowBody');
  let data;
  try {
    data = await window.vault.get();
  } catch (e) {
    data = { error: e.message };
  }
  root.textContent = '';
  let found = null;
  if (!data.error) {
    for (const env of data.environments) {
      const item = env.items.find((i) => i.id === CARD_ID);
      if (item) {
        found = { env, item };
        break;
      }
    }
  }
  if (found) {
    root.appendChild(createCard(found.env, found.item, false));
  } else {
    root.append(noteEl(data.error || 'This item no longer exists.'), vIconBtn('close', 'Close this window', () => window.vault.closeCard()));
  }
  await new Promise((resolve) => requestAnimationFrame(resolve));
  window.vault.fitCard(root.offsetHeight + 14);
}

async function initCardWindow() {
  document.body.classList.add('card-window');
  applyTheme(await window.git.getTheme());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.vault.closeCard();
  });
  window.addEventListener('focus', renderCardWindow);
  setupCardDrag();
  await renderCardWindow();
}

function setupCardDrag() {
  let dragging = false;
  const end = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging-card');
    window.vault.cardDragEnd();
  };
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, textarea, select, a, .copyable')) return;
    e.preventDefault();
    dragging = true;
    document.documentElement.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging-card');
    window.vault.cardDragStart();
  });
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  document.documentElement.addEventListener('lostpointercapture', end);
  window.addEventListener('blur', end);
}

if (CARD_ID) initCardWindow();
