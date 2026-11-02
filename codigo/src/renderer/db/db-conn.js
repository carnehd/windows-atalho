// -- The connections of the Database page, in a dialog: the list on the left (+ New connection), the one chosen on the
// right (name, host and port, database, user, password, SSL), or all of it in one link (db-link.js). Test tries it as
// it is in the form; Save keeps it (the password encrypted by the system, never shown again: "saved" says there is
// one); Delete asks first. --
const DB_SSL = [['disable', 'Off'], ['require', 'Required'], ['no-verify', 'Required, certificate not checked']];
const DB_MODE_KEY = 'dbConnMode';
// list: the connections as the page knows them, plus a new one being made; mode: Fields or Link; autoName: the name
// the link gave (a name typed is not changed); linkPassword: the password field holds the link's
const dbForm = { list: [], at: -1, base: '', mode: dbLoad(DB_MODE_KEY) === 'link' ? 'link' : 'fields', autoName: '', linkPassword: false };

const dbFormChanged = () => dbForm.at >= 0 && JSON.stringify(dbFormValues()) !== dbForm.base;

function dbConnModal() {
  let modal = $('#dbConnModal');
  if (modal) return modal;
  modal = dbEl('div', 'settings-overlay hidden');
  modal.id = 'dbConnModal';
  modal.innerHTML = `
    <div class="settings-card db-conn-card" role="dialog" aria-modal="true" aria-labelledby="dbConnTitle">
      <h3 id="dbConnTitle">PostgreSQL connections</h3>
      <div class="db-conn-layout">
        <div class="db-conn-side">
          <div id="dbConnList" class="bru-env-list" role="listbox" aria-label="Connections"></div>
          <button id="dbConnNewBtn" class="btn btn-sm" type="button">+ New connection</button>
        </div>
        <form id="dbConnForm" class="db-conn-form" autocomplete="off">
          <div id="dbcMode" class="seg db-conn-mode" role="group" aria-label="Give it as">
            <button class="seg-btn" type="button" data-mode="fields" aria-pressed="true" title="Host, port, database and user, each in its field">Fields</button>
            <button class="seg-btn" type="button" data-mode="link" aria-pressed="false" title="All of it in one link: postgresql://user:password@host:5432/database">Link</button>
          </div>
          <label class="bru-field"><span class="bru-field-label">Name</span><input id="dbcName" class="input" maxlength="60" placeholder="catalog dev" /></label>
          <div id="dbcLinkBox" class="hidden">
            <label class="bru-field"><span class="bru-field-label">Link</span><input id="dbcLink" class="input db-conn-link" maxlength="2000" placeholder="postgresql://user:password@host:5432/database" spellcheck="false" /></label>
            <div id="dbcLinkInfo" class="db-link-info"></div>
            <p class="db-conn-hint">Also jdbc:postgresql://… and host=… dbname=… user=…. A password in the link goes out of sight, and is kept encrypted.</p>
          </div>
          <div id="dbcFields">
          <div class="db-conn-pair">
            <label class="bru-field"><span class="bru-field-label">Host</span><input id="dbcHost" class="input" maxlength="255" placeholder="localhost" spellcheck="false" /></label>
            <label class="bru-field db-conn-port"><span class="bru-field-label">Port</span><input id="dbcPort" class="input" inputmode="numeric" maxlength="5" placeholder="5432" /></label>
          </div>
          <div class="db-conn-pair">
            <label class="bru-field"><span class="bru-field-label">Database</span><input id="dbcDatabase" class="input" maxlength="63" placeholder="postgres" spellcheck="false" /></label>
            <label class="bru-field"><span class="bru-field-label">User</span><input id="dbcUser" class="input" maxlength="63" placeholder="reader" spellcheck="false" /></label>
          </div>
          <label class="bru-field"><span class="bru-field-label">Password</span><input id="dbcPassword" class="input" type="password" maxlength="200" autocomplete="new-password" /></label>
          <label id="dbcForgetRow" class="db-conn-check hidden"><input id="dbcForget" type="checkbox" /> Forget the saved password</label>
          <label class="bru-field"><span class="bru-field-label">SSL</span><select id="dbcSsl" class="input"></select></label>
          </div>
          <p class="db-conn-hint">Only read: every query goes in a read only transaction. A user with SELECT only is safer still.</p>
          <div id="dbcTest" class="db-conn-test" role="status" aria-live="polite"></div>
        </form>
      </div>
      <div class="action-row settings-actions bru-env-actions">
        <button id="dbcDeleteBtn" class="btn btn-sm btn-danger" type="button">Delete</button>
        <span class="bru-env-gap"></span>
        <button id="dbcTestBtn" class="btn" type="button">Test</button>
        <button id="dbcCancelBtn" class="btn" type="button">Cancel</button>
        <button id="dbcSaveBtn" class="btn btn-primary" type="button">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  $('#dbcSsl').replaceChildren(...DB_SSL.map(([v, l]) => new Option(l, v)));
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) closeDbConnections();
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDbConnections();
    } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      saveDbConnection();
    }
  });
  $('#dbConnNewBtn').addEventListener('click', () => newDbConnection());
  $('#dbcTestBtn').addEventListener('click', testDbConnection);
  $('#dbcSaveBtn').addEventListener('click', saveDbConnection);
  $('#dbcCancelBtn').addEventListener('click', () => closeDbConnections());
  $('#dbcDeleteBtn').addEventListener('click', deleteDbConnection);
  $('#dbcForget').addEventListener('change', (e) => {
    $('#dbcPassword').disabled = e.target.checked;
    if (e.target.checked) $('#dbcPassword').value = '';
  });
  $('#dbcPassword').addEventListener('input', () => (dbForm.linkPassword = false));
  $$('#dbcMode .seg-btn').forEach((b) => b.addEventListener('click', () => setDbConnMode(b.dataset.mode)));
  // pasted or left: done, a password in it put out of sight; typed: read as it goes
  $('#dbcLink').addEventListener('input', (e) => readDbLink(e.inputType === 'insertFromPaste'));
  $('#dbcLink').addEventListener('change', () => readDbLink(true));
  return modal;
}

function setDbConnMode(mode, focus = true) {
  dbForm.mode = mode === 'link' ? 'link' : 'fields';
  dbStore(DB_MODE_KEY, dbForm.mode);
  $$('#dbcMode .seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === dbForm.mode)));
  $('#dbcFields').classList.toggle('hidden', dbForm.mode !== 'fields');
  $('#dbcLinkBox').classList.toggle('hidden', dbForm.mode !== 'link');
  if (dbForm.mode === 'link') {
    const v = dbFormValues();
    $('#dbcLink').value = v.database || v.user ? dbLinkOf(v) : ''; // a new one: nothing yet
    readDbLink(true);
  }
  if (focus) $(dbForm.mode === 'link' ? '#dbcLink' : '#dbcHost').focus();
}

// The link into the fields. Done (pasted, left, saved): a password in it goes into the password field and out of the
// link, and what is wrong is said in red; while typed, quietly. A link without a password keeps the one there was.
function readDbLink(done = false) {
  const input = $('#dbcLink');
  $('#dbcTest').textContent = ''; // what Test or Save said was about the link before
  $('#dbcTest').className = 'db-conn-test';
  let c;
  try {
    c = parseDbLink(input.value);
  } catch (e) {
    showDbLinkInfo(input.value.trim() ? e.message : '', done);
    return null;
  }
  $('#dbcHost').value = c.host;
  $('#dbcPort').value = String(c.port);
  $('#dbcDatabase').value = c.database;
  $('#dbcUser').value = c.user;
  $('#dbcSsl').value = c.ssl;
  if (c.password !== null) {
    $('#dbcPassword').value = c.password;
    $('#dbcPassword').disabled = false;
    $('#dbcForget').checked = false;
    dbForm.linkPassword = true;
    if (done) input.value = dbLinkOf(c);
  }
  const name = $('#dbcName');
  if (!name.value.trim() || name.value === dbForm.autoName) {
    dbForm.autoName = (c.database ? `${c.database} on ${c.host}` : c.host).slice(0, 60);
    name.value = dbForm.autoName;
  }
  showDbLinkInfo(c, done);
  return c;
}

// What the link gives: where, which database, as whom, SSL, which password; what it lacks, and what is not used.
function showDbLinkInfo(c, done) {
  const box = $('#dbcLinkInfo');
  if (!c || typeof c === 'string') {
    box.className = `db-link-info${c ? (done ? ' bad' : ' typing') : ''}`;
    box.textContent = c || '';
    return;
  }
  const saved = (dbForm.list[dbForm.at] || {}).hasPassword && !$('#dbcForget').checked;
  const typed = $('#dbcPassword').value;
  const parts = [
    [`${c.host.includes(':') ? `[${c.host}]` : c.host}:${c.port}`],
    c.database ? [c.database] : ['no database: host/database', 'miss'],
    c.user ? [`as ${c.user}`] : ['no user: user@host', 'miss'],
    [{ disable: 'SSL off', require: 'SSL, certificate checked', 'no-verify': 'SSL, certificate not checked' }[c.ssl]],
    [typed ? (dbForm.linkPassword ? `password from the link${saved ? ', in place of the saved one' : ''}` : 'the password typed in Fields') : saved ? 'the saved password' : 'no password'],
  ];
  box.className = 'db-link-info';
  box.replaceChildren();
  parts.forEach(([text, cls], i) => {
    if (i) box.appendChild(document.createTextNode(' · '));
    box.appendChild(dbEl('span', cls ? `db-link-${cls}` : '', text));
  });
  if (c.unused.length) box.appendChild(dbEl('span', 'db-link-unused', `Not used: ${c.unused.join(', ')}`));
}

// Test and Save in Link: the link as it is, or what is wrong with it.
function dbLinkReady() {
  if (dbForm.mode !== 'link') return true;
  try {
    parseDbLink($('#dbcLink').value);
  } catch (e) {
    $('#dbcTest').className = 'db-conn-test bad';
    $('#dbcTest').textContent = e.message;
    $('#dbcLink').focus();
    return false;
  }
  readDbLink(true);
  return true;
}

// fresh: begin with a new one (the page had none)
function openDbConnections(fresh = false) {
  dbForm.list = db.conns.map((c) => ({ ...c }));
  const modal = dbConnModal();
  modal.classList.remove('hidden');
  if (fresh || !dbForm.list.length) newDbConnection();
  else showDbConnection(Math.max(0, dbForm.list.findIndex((c) => c.id === db.id)));
}

async function closeDbConnections(force = false) {
  const modal = $('#dbConnModal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (!force && dbFormChanged() && !(await askConfirm('Discard the changes to this connection?', { confirm: 'Discard' }))) return;
  modal.classList.add('hidden');
  $('#dbConnBtn').focus();
}

function renderDbConnList() {
  const list = $('#dbConnList');
  list.innerHTML = '';
  dbForm.list.forEach((c, i) => {
    const b = dbEl('button', `bru-env-item${i === dbForm.at ? ' on' : ''}`, c.name || 'New connection');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(i === dbForm.at));
    if (c.id && c.id === db.id) b.appendChild(dbEl('span', 'bru-env-used', 'open'));
    b.addEventListener('click', async () => {
      if (i === dbForm.at) return;
      if (dbFormChanged() && !(await askConfirm('Discard the changes to this connection?', { confirm: 'Discard' }))) return;
      if (!dbForm.list[dbForm.at].id) dbForm.list.splice(dbForm.at, 1);
      showDbConnection(dbForm.list.indexOf(c));
    });
    list.appendChild(b);
  });
}

function showDbConnection(i) {
  dbForm.at = i;
  const c = dbForm.list[i];
  $('#dbcName').value = c.name || '';
  $('#dbcHost').value = c.host || '';
  $('#dbcPort').value = c.port ? String(c.port) : '';
  $('#dbcDatabase').value = c.database || '';
  $('#dbcUser').value = c.user || '';
  $('#dbcPassword').value = '';
  $('#dbcPassword').disabled = false;
  $('#dbcPassword').placeholder = c.hasPassword ? 'saved: type to change it' : 'none';
  $('#dbcForget').checked = false;
  $('#dbcForgetRow').classList.toggle('hidden', !c.hasPassword);
  $('#dbcSsl').value = c.ssl || 'disable';
  $('#dbcTest').textContent = '';
  $('#dbcTest').className = 'db-conn-test';
  $('#dbcDeleteBtn').disabled = !c.id;
  dbForm.autoName = '';
  dbForm.linkPassword = false;
  setDbConnMode(dbForm.mode, false);
  dbForm.base = JSON.stringify(dbFormValues());
  renderDbConnList();
  $(!c.id && dbForm.mode === 'link' ? '#dbcLink' : '#dbcName').focus(); // a new one in Link: ready to paste
}

function newDbConnection() {
  if (dbForm.at >= 0 && dbForm.list[dbForm.at] && !dbForm.list[dbForm.at].id) return $('#dbcName').focus();
  dbForm.list.push({ name: '', host: 'localhost', port: 5432, database: '', user: '', ssl: 'disable' });
  showDbConnection(dbForm.list.length - 1);
}

function dbFormValues() {
  const c = dbForm.list[dbForm.at] || {};
  return {
    id: c.id || null,
    name: $('#dbcName').value.trim(),
    host: $('#dbcHost').value.trim(),
    port: Number($('#dbcPort').value.trim() || 5432),
    database: $('#dbcDatabase').value.trim(),
    user: $('#dbcUser').value.trim(),
    password: $('#dbcPassword').value,
    clearPassword: $('#dbcForget').checked,
    ssl: $('#dbcSsl').value,
  };
}

async function testDbConnection() {
  if (!dbLinkReady()) return;
  const box = $('#dbcTest');
  box.className = 'db-conn-test';
  box.replaceChildren(dbEl('span', 'db-spin'), document.createTextNode(' Connecting…'));
  const r = await window.database.test(dbFormValues());
  box.classList.add(r.error ? 'bad' : 'ok');
  box.textContent = r.error ? r.error : `✓ PostgreSQL ${r.version} · ${r.database} as ${r.user}`;
}

async function saveDbConnection() {
  if (!dbLinkReady()) return;
  db.saving = true;
  const r = await window.database.save(dbFormValues());
  if (r.error) {
    db.saving = false;
    $('#dbcTest').className = 'db-conn-test bad';
    $('#dbcTest').textContent = r.error;
    return;
  }
  db.conns = r.connections;
  closeDbConnections(true);
  toast(`${r.connection.name} saved`, 'success', { plain: true });
  db.ready = false;
  const opening = openDbConnection(r.connection.id); // db.id is set at once: a refresh now keeps it
  db.saving = false;
  await opening;
}

async function deleteDbConnection() {
  const c = dbForm.list[dbForm.at];
  if (!c || !c.id) return;
  if (!(await askConfirm(`Delete the connection "${c.name}"?\nIts saved password goes with it. The database is not touched.`, { confirm: 'Delete' }))) return;
  db.saving = true;
  const r = await window.database.remove(c.id);
  if (r.error) {
    db.saving = false;
    return toast(r.error, 'error', { plain: true });
  }
  db.conns = r.connections;
  dbForm.list = db.conns.map((x) => ({ ...x }));
  toast(`${c.name} deleted`, 'success', { plain: true });
  let opening = null;
  if (db.id === c.id) {
    db.ready = false;
    opening = openDbConnection(db.conns[0] ? db.conns[0].id : null);
  } else renderDbBar();
  db.saving = false;
  await opening;
  if (!dbForm.list.length) closeDbConnections(true);
  else showDbConnection(0);
}
