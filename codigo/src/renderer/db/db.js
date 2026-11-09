// -- Database: the data of a PostgreSQL database, to read only. A connection (db-conn.js), its schemas and tables on
// the left; on the right a table's rows a page at a time (sorted by a click on a column), its columns, and SQL that
// reads (one SELECT, WITH, SHOW, EXPLAIN...). Nothing here changes data: the main process refuses it, and so does the
// database (db/pg.js). --
const DB_CONN_KEY = 'dbConn';
const DB_TAB_KEY = 'dbTab';
const DB_SQL_KEY = 'dbSql';
const DB_TABS = [['data', 'Data'], ['columns', 'Columns'], ['sql', 'SQL']];

const db = {
  conns: [],
  id: null,
  info: null, // { version, database, user } of the connection, or { error }
  schemas: [],
  open: new Set(), // schemas unfolded
  tables: {}, // schema -> [{ name, kind, estimate, readable }]
  sel: null, // { schema, table }
  tab: 'data',
  view: { offset: 0, sort: null, desc: false },
  data: null, // the page shown, or { error }
  cols: null,
  sql: null, // the answer to the SQL, or { error }
  busy: 0,
  filter: '',
  ready: false,
  saving: false, // the dialog is saving or deleting one: it opens what follows, not refreshDb
  token: 0, // the last opening: an answer for an older one is dropped
};

function dbEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

const dbStore = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // only for now
  }
};
const dbLoad = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const dbConn = () => db.conns.find((c) => c.id === db.id) || null;

// From activateMode: the connections read again, the one chosen opened (once, or when it is another).
async function refreshDb() {
  const opened = db.token;
  const r = await window.database.connections();
  // a connection opened, saved or deleted while the list was read: the list may be old, what was opened stands
  if (db.saving || db.token !== opened) return;
  db.conns = r.connections || [];
  const saved = dbLoad(DB_CONN_KEY);
  const id = db.conns.some((c) => c.id === db.id) ? db.id : db.conns.some((c) => c.id === saved) ? saved : db.conns[0] ? db.conns[0].id : null;
  renderDbBar();
  if (id !== db.id || !db.ready) await openDbConnection(id);
  else renderDb();
}

async function openDbConnection(id) {
  const token = ++db.token;
  db.id = id;
  dbStore(DB_CONN_KEY, id);
  Object.assign(db, { info: null, schemas: [], open: new Set(), tables: {}, sel: null, data: null, cols: null, sql: null, filter: '', ready: true });
  db.tab = dbLoad(DB_TAB_KEY) || 'data';
  $('#dbFilter').value = '';
  renderDb();
  if (!id) return;
  const conn = dbConn();
  db.busy++;
  renderDbStatus();
  const [info, s] = await Promise.all([window.database.test({ id, ...conn }), window.database.schemas(id)]);
  db.busy--;
  if (db.token !== token) return renderDbStatus();
  db.info = info;
  db.schemas = s.error ? [] : s.schemas;
  if (s.error && !info.error) db.info = { error: s.error };
  // the schema with tables opens by itself: public, else the first
  const first = db.schemas.find((x) => x.name === 'public' && x.tables) || db.schemas.find((x) => x.tables);
  if (first) await toggleDbSchema(first.name, true);
  if (db.token === token) renderDb();
}

async function loadDbTables(schema) {
  if (db.tables[schema]) return;
  const id = db.id;
  const r = await window.database.tables(id, schema);
  if (db.id !== id) return;
  db.tables[schema] = r.error ? [] : r.tables;
}

async function toggleDbSchema(name, open = !db.open.has(name)) {
  if (open) {
    db.open.add(name);
    await loadDbTables(name);
  } else db.open.delete(name);
  renderDbTree();
}

async function chooseDbTable(schema, table) {
  db.sel = { schema, table };
  db.view = { offset: 0, sort: null, desc: false };
  db.data = null;
  db.cols = null;
  // SQL: Build takes the table; Write, when nothing is written yet, a query of it
  if (db.tab === 'sql' && dbSqlMode() === 'build') dbBuildFromTable(schema, table);
  else if (db.tab === 'sql' && !savedDbSql().trim()) setDbSql(`select * from ${dbIdent(schema)}.${dbIdent(table)} limit 50`);
  renderDbTree();
  await loadDbTab();
}

const dbIdent = (name) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

// What the tab open needs: the page of rows, the columns.
async function loadDbTab() {
  const sel = db.sel;
  if (!sel || !db.id) return renderDbPane();
  const id = db.id;
  if (db.tab === 'data') {
    db.busy++;
    renderDbStatus();
    const r = await window.database.rows(id, sel.schema, sel.table, db.view);
    db.busy--;
    if (db.id !== id || db.sel !== sel) return;
    db.data = r;
    if (!r.error) db.cols = r.columns;
  } else if (db.tab === 'columns' && !db.cols) {
    const r = await window.database.columns(id, sel.schema, sel.table);
    if (db.id !== id || db.sel !== sel) return;
    db.cols = r.error ? r : r.columns;
  }
  renderDbStatus();
  renderDbPane();
}

function setDbTab(tab) {
  db.tab = tab;
  dbStore(DB_TAB_KEY, tab);
  renderDbTabs();
  if (tab === 'sql') renderDbPane();
  else loadDbTab();
}

// -- Drawing --
function renderDb() {
  renderDbBar();
  renderDbStatus();
  const none = !db.conns.length;
  $('#dbEmpty').classList.toggle('hidden', !none);
  $('#dbMain').classList.toggle('hidden', none);
  renderDbTree();
  renderDbTabs();
  renderDbPane();
}

function renderDbBar() {
  const select = $('#dbConn');
  select.replaceChildren(...db.conns.map((c) => new Option(c.name, c.id)));
  select.value = db.id || '';
  select.disabled = !db.conns.length;
  $('#dbRefreshBtn').disabled = !db.id;
}

function renderDbStatus() {
  const box = $('#dbStatus');
  box.className = 'db-status';
  const conn = dbConn();
  if (!conn) return (box.textContent = '');
  if (db.busy) {
    box.replaceChildren(dbEl('span', 'db-spin'), document.createTextNode(`Reading ${conn.host}:${conn.port}…`));
    return;
  }
  if (!db.info) return (box.textContent = '');
  if (db.info.error) {
    box.classList.add('bad');
    box.textContent = db.info.error;
    box.title = db.info.error;
    return;
  }
  box.textContent = `PostgreSQL ${db.info.version} · ${db.info.database} as ${db.info.user} · ${conn.host}:${conn.port}`;
  box.title = box.textContent;
}

function renderDbTree() {
  const tree = $('#dbTree');
  tree.innerHTML = '';
  const q = db.filter.toLowerCase();
  if (db.info && db.info.error) {
    tree.appendChild(dbEl('div', 'db-note', 'Not connected. Check the connection (the gear above), then Refresh.'));
    return;
  }
  if (!db.schemas.length) {
    if (db.info) tree.appendChild(dbEl('div', 'db-note', 'No schema this user can read.'));
    return;
  }
  for (const s of db.schemas) {
    const list = (db.tables[s.name] || []).filter((t) => !q || t.name.toLowerCase().includes(q));
    if (q && !list.length) continue;
    const open = db.open.has(s.name) || Boolean(q);
    const row = dbEl('div', `db-row db-schema${open ? ' open' : ''}`);
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', String(open));
    row.tabIndex = 0;
    row.innerHTML = '<svg class="db-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
    row.append(dbEl('span', 'db-name', s.name), dbEl('span', 'db-count', String(s.tables)));
    row.addEventListener('click', () => toggleDbSchema(s.name));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        toggleDbSchema(s.name, e.key === 'ArrowRight' ? true : e.key === 'ArrowLeft' ? false : undefined);
      }
    });
    tree.appendChild(row);
    if (!open) continue;
    for (const t of list) {
      const on = db.sel && db.sel.schema === s.name && db.sel.table === t.name;
      const item = dbEl('div', `db-row db-table${on ? ' selected' : ''}${t.readable ? '' : ' locked'}`);
      item.setAttribute('role', 'treeitem');
      item.setAttribute('aria-selected', String(on));
      item.tabIndex = 0;
      item.title = `${s.name}.${t.name}: ${t.kind}${t.readable ? '' : ' (no permission to read it)'}`;
      item.innerHTML = t.kind === 'table'
        ? '<svg class="db-kind" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z"/><path d="M3 10h18"/><path d="M10 3v18"/></svg>'
        : '<svg class="db-kind" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/></svg>';
      item.appendChild(dbEl('span', 'db-name', t.name));
      if (t.estimate > 0) item.appendChild(dbEl('span', 'db-count', `~${dbNumber(t.estimate)}`));
      item.addEventListener('click', () => chooseDbTable(s.name, t.name));
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') chooseDbTable(s.name, t.name);
      });
      tree.appendChild(item);
    }
  }
}

const dbNumber = (n) => Number(n).toLocaleString('en-US');

function renderDbTabs() {
  const tabs = $('#dbTabs');
  tabs.innerHTML = '';
  for (const [key, label] of DB_TABS) {
    const b = dbEl('button', `bru-tab${db.tab === key ? ' active' : ''}`, label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(db.tab === key));
    b.addEventListener('click', () => setDbTab(key));
    tabs.appendChild(b);
  }
}

function renderDbPane() {
  const pane = $('#dbPane');
  if (db.tab === 'sql') return renderDbSql(pane);
  pane.innerHTML = '';
  if (!db.sel) {
    pane.appendChild(dbEl('div', 'db-note', db.conns.length ? 'Choose a table on the left to see its rows.' : ''));
    return;
  }
  if (db.tab === 'columns') return renderDbColumns(pane);
  renderDbData(pane);
}

function renderDbData(pane) {
  const d = db.data;
  const { schema, table } = db.sel;
  const head = dbEl('div', 'db-head');
  head.appendChild(dbEl('strong', 'db-title', `${schema}.${table}`));
  pane.appendChild(head);
  if (!d) {
    head.appendChild(dbEl('span', 'db-dim', 'Reading…'));
    return;
  }
  if (d.error) {
    pane.appendChild(dbEl('div', 'db-error', d.error));
    return;
  }
  const from = d.offset + 1;
  const to = d.offset + d.rows.length;
  head.appendChild(dbEl('span', 'db-dim', d.total === null ? '' : `${d.exact ? '' : '~'}${dbNumber(d.total)} rows`));
  const pager = dbEl('span', 'db-pager');
  const prev = dbEl('button', 'btn btn-sm', '‹');
  prev.type = 'button';
  prev.title = `The ${d.page} before`;
  prev.setAttribute('aria-label', 'Previous rows');
  prev.disabled = d.offset === 0;
  prev.addEventListener('click', () => {
    db.view.offset = Math.max(0, d.offset - d.page);
    loadDbTab();
  });
  const next = dbEl('button', 'btn btn-sm', '›');
  next.type = 'button';
  next.title = `The next ${d.page}`;
  next.setAttribute('aria-label', 'Next rows');
  next.disabled = !d.more;
  next.addEventListener('click', () => {
    db.view.offset = d.offset + d.page;
    loadDbTab();
  });
  pager.append(prev, dbEl('span', 'db-range', d.rows.length ? `${dbNumber(from)}–${dbNumber(to)}` : 'none'), next);
  head.appendChild(pager);
  const pk = (d.columns || []).filter((c) => c.pk).map((c) => c.name);
  const sortedBy = d.sort ? `${d.sort} ${d.desc ? 'descending' : 'ascending'}` : pk.length ? `${pk.join(', ')} (primary key)` : 'as stored';
  head.appendChild(dbEl('span', 'db-dim db-sorted', `sorted by ${sortedBy}`));
  pane.appendChild(dbGrid(d.fields, d.rows, {
    sort: d.sort,
    desc: d.desc,
    pk,
    onSort: (name) => {
      // ascending, descending, then back to the primary key
      if (db.view.sort !== name) db.view = { offset: 0, sort: name, desc: false };
      else if (!db.view.desc) db.view = { offset: 0, sort: name, desc: true };
      else db.view = { offset: 0, sort: null, desc: false };
      loadDbTab();
    },
  }));
  if (!d.rows.length) pane.appendChild(dbEl('div', 'db-note', 'No rows.'));
}

// A grid of rows: the columns with their types (a click sorts, when onSort is given), NULL told apart, a value cut
// at 2000 characters marked; a double click copies a value.
function dbGrid(fields, rows, { sort = null, desc = false, pk = [], onSort = null } = {}) {
  const wrap = dbEl('div', 'db-grid-wrap');
  const table = dbEl('table', 'db-grid');
  const tr = table.createTHead().insertRow();
  tr.appendChild(dbEl('th', 'db-rownum', '#'));
  for (const f of fields) {
    const th = dbEl('th');
    const name = dbEl(onSort ? 'button' : 'span', 'db-col');
    if (onSort) {
      name.type = 'button';
      name.title = `Sort by ${f.name}`;
      name.addEventListener('click', () => onSort(f.name));
      if (sort === f.name) th.setAttribute('aria-sort', desc ? 'descending' : 'ascending');
    }
    name.append(dbEl('span', 'db-col-name', f.name));
    if (pk.includes(f.name)) name.appendChild(dbEl('span', 'db-pk', 'PK'));
    if (sort === f.name) name.appendChild(dbEl('span', 'db-arrow', desc ? '↓' : '↑'));
    th.append(name, dbEl('span', 'db-col-type', f.type || ''));
    tr.appendChild(th);
  }
  const body = table.createTBody();
  const start = db.tab === 'data' && db.data && !db.data.error ? db.data.offset : 0;
  rows.forEach((r, i) => {
    const row = body.insertRow();
    row.appendChild(dbEl('td', 'db-rownum', String(start + i + 1)));
    for (const v of r) {
      const td = row.insertCell();
      if (v === null) td.appendChild(dbEl('span', 'db-null', 'NULL'));
      else {
        td.textContent = v;
        td.title = v.length > 300 ? `${v.slice(0, 300)}… (double click: copy)` : `${v}\n(double click: copy)`;
        if (v.endsWith('…') && v.length > 2000) td.classList.add('db-cut');
        td.addEventListener('dblclick', () => copyText(v, 'Value'));
      }
    }
  });
  wrap.appendChild(table);
  return wrap;
}

function renderDbColumns(pane) {
  pane.innerHTML = '';
  const { schema, table } = db.sel;
  const head = dbEl('div', 'db-head');
  head.appendChild(dbEl('strong', 'db-title', `${schema}.${table}`));
  pane.appendChild(head);
  if (!db.cols) {
    head.appendChild(dbEl('span', 'db-dim', 'Reading…'));
    return;
  }
  if (db.cols.error) {
    pane.appendChild(dbEl('div', 'db-error', db.cols.error));
    return;
  }
  head.appendChild(dbEl('span', 'db-dim', `${db.cols.length} columns`));
  const fields = [{ name: 'column', type: '' }, { name: 'type', type: '' }, { name: 'null', type: '' }, { name: 'default', type: '' }, { name: 'key', type: '' }];
  const rows = db.cols.map((c) => [c.name, c.type, c.nullable ? 'yes' : 'no', c.default, c.pk ? 'primary key' : null]);
  pane.appendChild(dbGrid(fields, rows));
}

// -- SQL: the tab is in db-sql.js (Write and Build) --

function setupDb() {
  $('#dbConn').addEventListener('change', (e) => openDbConnection(e.target.value));
  $('#dbRefreshBtn').addEventListener('click', () => {
    db.ready = false;
    openDbConnection(db.id);
  });
  $('#dbConnBtn').addEventListener('click', () => openDbConnections());
  $('#dbEmptyNew').addEventListener('click', () => openDbConnections(true));
  let typing = null;
  $('#dbFilter').addEventListener('input', (e) => {
    clearTimeout(typing);
    typing = setTimeout(async () => {
      db.filter = e.target.value.trim();
      // a name looked for in every schema: their tables read once
      if (db.filter) await Promise.all(db.schemas.map((s) => loadDbTables(s.name)));
      renderDbTree();
    }, 150);
  });
}

setupDb();
