// -- Database > Calls: what the page asks of the database, as it asks: each statement, how long it took, how many rows it gave
// or the error as PostgreSQL said it (its code, message, detail and hint), grouped under what the user did (Open orders.customer).
// For the day a table does not open and another client (DBeaver) reads it: the statement that was refused is there to compare,
// and Permissions asks the database what this user may do. The main process tells each call (db/pg.js: db-call). --
const DB_CALLS_KEY = 'dbCallsOpen';
const DB_CALLS_MAX = 1000;

const dbCalls = {
  items: [],
  open: true,
  errorsOnly: false,
  showQuiet: false,
  shownGroup: 0,
  failures: 0, // the calls that failed since the list was emptied
  check: null, // the answer of Permissions, { sel, r }: kept above the list until it is closed
};

const dbcEl = (tag, cls = '', text = '') => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};
const dbcClock = (at) => new Date(at).toLocaleTimeString('en-GB', { hour12: false });

function dbcLoadOpen() {
  try {
    return localStorage.getItem(DB_CALLS_KEY) !== '0';
  } catch {
    return true;
  }
}

function dbcSaveOpen() {
  try {
    localStorage.setItem(DB_CALLS_KEY, dbCalls.open ? '1' : '0');
  } catch {
    // for this session only
  }
}

// what a call says, as a line of text (to copy)
function dbcText(e) {
  const result = e.error ? `ERROR ${e.error.code} ${e.error.message}${e.error.detail ? ` | ${e.error.detail}` : ''}${e.error.hint ? ` | hint: ${e.error.hint}` : ''}` : e.rows != null ? `${e.rows} rows` : '';
  return `${dbcClock(e.at)}  ${e.label || ''}  ${e.ms != null ? `${e.ms} ms  ` : ''}${e.kind === 'sql' ? e.sql : e.text || ''}${e.params ? `  [${e.params}]` : ''}${result ? `  -> ${result}` : ''}`;
}

const dbcShows = (e) => {
  if (e.error) return true;
  if (dbCalls.errorsOnly) return false;
  return !e.quiet || dbCalls.showQuiet;
};

function dbcCallEl(e) {
  const row = dbcEl('div', `db-call${e.error ? ' bad' : ''}${e.kind === 'info' ? ' info' : ''}${e.quiet && !e.error ? ' quiet' : ''}`);
  const main = dbcEl('div', 'db-call-main');
  main.append(
    dbcEl('span', 'db-call-ts', dbcClock(e.at)),
    dbcEl('span', 'db-call-ms', e.ms != null ? `${e.ms} ms` : ''),
    dbcEl('span', 'db-call-sql', e.kind === 'sql' ? e.sql : e.text || ''),
    dbcEl('span', 'db-call-res', e.error ? e.error.code || 'error' : e.rows != null ? `${e.rows} row${e.rows === 1 ? '' : 's'}` : '')
  );
  main.title = `${e.kind === 'sql' ? e.sql : e.text || ''}${e.params ? `\nParameters: ${e.params}` : ''}\nClick to show it whole`;
  main.addEventListener('click', () => row.classList.toggle('open'));
  row.append(main);
  if (e.params) row.append(dbcEl('div', 'db-call-extra', `Parameters: ${e.params}`));
  if (e.error) {
    const err = dbcEl('div', 'db-call-error');
    err.append(dbcEl('div', 'db-call-msg', `${e.error.code ? `${e.error.code}: ` : ''}${e.error.message}`));
    if (e.error.detail) err.append(dbcEl('div', 'db-call-more', `Detail: ${e.error.detail}`));
    if (e.error.hint) err.append(dbcEl('div', 'db-call-more', `Hint: ${e.error.hint}`));
    if (e.error.where) err.append(dbcEl('div', 'db-call-more', `Where: ${e.error.where}`));
    if (e.error.code === '42501') {
      err.append(dbcEl('div', 'db-call-more', 'PostgreSQL says this user is not allowed. DBeaver may connect as another user or role: Permissions shows what this one may do.'));
      const ask = dbcEl('button', 'btn btn-sm', 'Check the permissions');
      ask.type = 'button';
      ask.disabled = !db.sel;
      ask.addEventListener('click', dbcCheckPermissions);
      err.append(ask);
    }
    row.append(err);
  }
  return row;
}

function dbcGroupEl(e) {
  return dbcEl('div', 'db-calls-group', `${e.label || 'Call'} · ${dbcClock(e.at)}`);
}

function dbcSummary() {
  const shown = dbCalls.items.filter((e) => e.kind === 'sql' && !e.quiet).length;
  const last = [...dbCalls.items].reverse().find((e) => e.ms != null && e.kind === 'sql' && !e.quiet);
  return `${shown} statement${shown === 1 ? '' : 's'}${dbCalls.failures ? ` · ${dbCalls.failures} refused` : ''}${last ? ` · last ${last.ms} ms` : ''}`;
}

function dbcPaintButton() {
  const btn = $('#dbCallsBtn');
  if (!btn) return;
  btn.classList.toggle('on', dbCalls.open);
  btn.classList.toggle('bad', dbCalls.failures > 0);
  btn.setAttribute('aria-expanded', String(dbCalls.open));
  const n = $('#dbCallsN');
  if (n) n.textContent = dbCalls.failures ? String(dbCalls.failures) : '';
}

function dbcRender() {
  const box = $('#dbCalls');
  if (!box) return;
  dbcPaintButton();
  box.classList.toggle('hidden', !dbCalls.open);
  if (!dbCalls.open) return;
  box.replaceChildren();
  const head = dbcEl('div', 'db-calls-head');
  head.append(dbcEl('b', '', 'Calls'), dbcEl('span', 'db-calls-sum', dbcSummary()), dbcEl('span', 'db-calls-space'));
  const toggle = (label, title, key) => {
    const l = dbcEl('label', 'db-calls-opt');
    l.title = title;
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = dbCalls[key];
    c.addEventListener('change', () => {
      dbCalls[key] = c.checked;
      dbcRender();
    });
    l.append(c, document.createTextNode(` ${label}`));
    return l;
  };
  const button = (label, title, run) => {
    const b = dbcEl('button', 'btn btn-sm', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', run);
    return b;
  };
  const perm = button('Permissions', 'Asks the database what this user may do with the table in view: its roles, its rights on the schema, the table and its columns', dbcCheckPermissions);
  perm.disabled = !db.sel || !db.id;
  head.append(
    toggle('Errors only', 'Only the calls that failed', 'errorsOnly'),
    toggle('Transaction control', 'BEGIN, savepoints and ROLLBACK, which every call has', 'showQuiet'),
    perm,
    button('Copy', 'All the calls, as text', dbcCopy),
    button('Clear', 'Empty the list', () => {
      dbCalls.items = [];
      dbCalls.failures = 0;
      dbCalls.check = null;
      dbcRender();
    }),
    button('Hide', 'Close this area: Calls on the bar opens it again', () => dbcSetOpen(false))
  );
  const body = dbcEl('div', 'db-calls-body');
  body.id = 'dbCallsBody';
  if (dbCalls.check) box.append(head, dbcCheckEl());
  else box.append(head);
  dbCalls.shownGroup = 0;
  for (const e of dbCalls.items) if (dbcShows(e)) dbcAppend(body, e);
  if (!body.children.length) body.append(dbcEl('div', 'db-calls-empty', dbCalls.items.length ? 'Nothing of this kind.' : 'Open a table: what is asked of the database shows here.'));
  box.append(body);
  body.scrollTop = body.scrollHeight;
}

function dbcAppend(body, e) {
  if (e.group !== dbCalls.shownGroup) {
    body.append(dbcGroupEl(e));
    dbCalls.shownGroup = e.group;
  }
  body.append(dbcCallEl(e));
}

function dbcSetOpen(on) {
  dbCalls.open = on;
  dbcSaveOpen();
  dbcRender();
}

function dbcCopy() {
  const text = dbCalls.items.map(dbcText).join('\n');
  window.tools.copy(text).then((r) => toast(r && r.error ? r.error : 'The calls were copied', r && r.error ? 'error' : 'success', { plain: true }));
}

// What this user may do with the table in view, asked of the database; the answers stay above the calls, with what they mean.
async function dbcCheckPermissions() {
  const sel = db.sel;
  if (!sel || !db.id) return;
  const id = db.id;
  const r = await window.database.whoami(id, sel.schema, sel.table);
  if (db.id !== id) return;
  dbCalls.check = { sel, r };
  dbCalls.open = true;
  dbcSaveOpen();
  dbcRender();
}

function dbcCheckEl() {
  const { sel, r } = dbCalls.check;
  const box = dbcEl('div', 'db-calls-check');
  const title = dbcEl('div', 'db-calls-check-head');
  title.append(dbcEl('span', 'db-calls-check-title', `Permissions of this user on ${sel.schema}.${sel.table}`));
  const close = dbcEl('button', 'btn btn-sm', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => {
    dbCalls.check = null;
    dbcRender();
  });
  title.append(close);
  box.append(title);
  if (r.error) {
    box.append(dbcEl('div', 'db-call-msg', r.error));
    return box;
  }
  for (const line of r.reading) box.append(dbcEl('div', 'db-calls-reading', line));
  for (const item of r.items) {
    const part = dbcEl('div', 'db-calls-check-item');
    part.append(dbcEl('div', 'db-calls-check-label', item.label));
    if (item.error) part.append(dbcEl('div', 'db-call-msg', item.error));
    else if (!item.rows.length) part.append(dbcEl('div', 'db-calls-check-row', 'nothing'));
    else for (const row of item.rows) part.append(dbcEl('div', 'db-calls-check-row', Object.entries(row).map(([k, v]) => `${k}: ${v === 't' ? 'yes' : v === 'f' ? 'no' : v === null ? '-' : v}`).join(' · ')));
    box.append(part);
  }
  return box;
}

function setupDbCalls() {
  if (!$('#dbCalls') || !window.database || !window.database.onCall) return;
  dbCalls.open = dbcLoadOpen();
  window.database.onCall((e) => {
    dbCalls.items.push(e);
    if (dbCalls.items.length > DB_CALLS_MAX) dbCalls.items.splice(0, dbCalls.items.length - DB_CALLS_MAX);
    if (e.error) {
      dbCalls.failures += 1;
      // a refusal shows the list, whatever it was before
      if (!dbCalls.open) {
        dbCalls.open = true;
        dbcRender();
        return;
      }
    }
    dbcPaintButton();
    const body = $('#dbCallsBody');
    if (!dbCalls.open || !body) {
      if (dbCalls.open) dbcRender();
      return;
    }
    if (!dbcShows(e)) {
      const sum = $('#dbCalls .db-calls-sum');
      if (sum) sum.textContent = dbcSummary();
      return;
    }
    body.querySelector('.db-calls-empty')?.remove();
    const follow = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    dbcAppend(body, e);
    const sum = $('#dbCalls .db-calls-sum');
    if (sum) sum.textContent = dbcSummary();
    if (follow) body.scrollTop = body.scrollHeight;
  });
  const btn = $('#dbCallsBtn');
  if (btn) btn.addEventListener('click', () => dbcSetOpen(!dbCalls.open));
  dbcRender();
}

setupDbCalls();
