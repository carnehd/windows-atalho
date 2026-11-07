// -- New database (+ New database on the Database page; main: new-database.js): a database for a microservice in a
// local PostgreSQL, with its schema, a user that makes the tables (DDL) and a user for the application (DML). On the
// left the values: the microservice gives the database its name, the database gives the schema its; the users; where
// PostgreSQL is (a container that runs one, or a pod of a cluster). On the right what it runs (the SQL, or the same
// as a PowerShell or Bash script to run by hand), with the values marked where they go, and the lines the
// microservice needs to connect. Create runs it and shows what PostgreSQL said; what is there already is kept. The
// passwords are not kept, and go to the clipboard only as secrets. --
const ND_KEY = 'newDb';
const ND_PERMS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const ND_VIEWS = [['sql', 'SQL'], ['powershell', 'PowerShell'], ['bash', 'Bash'], ['output', 'Output']];
const ND_MIGRATIONS = [['flyway', 'Flyway'], ['liquibase', 'Liquibase'], ['none', 'None']];
// the lines of its application properties, or environment variables to give it when it starts (Spring's names)
const ND_FORMATS = [['props', 'Properties', 'Lines for its application properties'], ['env', 'Variables', 'Environment variables to give it when it starts (Start in container, Env): Spring\'s own names, which take the place of what its file says']];

// targets: where a PostgreSQL may be; view: what the box on the right shows; out: what the last run printed;
// result: how it ended; schemaTyped: the schema was typed (it no longer follows the database)
const nd = { targets: null, view: 'sql', preview: null, seq: 0, timer: null, out: '', running: null, result: null, schemaTyped: false, pod: null, showPass: false };

const ndSaved = () => {
  try {
    return JSON.parse(dbLoad(ND_KEY) || '{}') || {};
  } catch {
    return {};
  }
};

function newDatabaseModal() {
  let modal = $('#ndModal');
  if (modal) return modal;
  modal = dbEl('div', 'settings-overlay hidden');
  modal.id = 'ndModal';
  const key = (text, id) => `<label class="mc-key"${id ? ` for="${id}"` : ''}>${text}</label>`;
  modal.innerHTML = `
    <div class="settings-card nd-card" role="dialog" aria-modal="true" aria-labelledby="ndTitle">
      <div class="nd-head"><h3 id="ndTitle">New database</h3><span class="nd-gap"></span><button id="ndClose" class="close-btn" type="button" title="Close (Esc)" aria-label="Close">&#x2715;</button></div>
      <p class="nd-sub">A database for a microservice in a PostgreSQL of this computer: its schema, a user that makes the tables and a user for the application. Git Quick writes the SQL from these values and runs it in the container; what is there already is kept as it is.</p>
      <div class="nd-main">
        <form id="ndForm" class="nd-form" autocomplete="off">
          <div class="nd-sec">The database <span class="nd-line"></span></div>
          <div class="mc-grid">
            ${key('Microservice', 'ndMs')}
            <div class="mc-line"><select id="ndMs" class="input mc-wide"></select></div>
            ${key('Database', 'ndDb')}
            <div class="mc-line"><input id="ndDb" class="input mc-wide nd-mono" maxlength="63" spellcheck="false" placeholder="billing-service" /></div>
            ${key('Schema', 'ndSchema')}
            <div class="mc-line"><input id="ndSchema" class="input mc-wide nd-mono" maxlength="63" spellcheck="false" placeholder="billing_service" /><span id="ndSchemaFrom" class="nd-from">the database's, _ for -</span></div>
          </div>
          <div class="nd-sec">Its users <span class="nd-line"></span></div>
          <div class="mc-grid">
            ${key('DDL user', 'ndDdlUser')}
            <div class="mc-line"><input id="ndDdlUser" class="input nd-short nd-mono" maxlength="63" spellcheck="false" /><input id="ndDdlPass" class="input nd-pass nd-mono" type="password" maxlength="200" placeholder="password" autocomplete="new-password" aria-label="Password of the DDL user" /><span class="nd-hint">makes the tables</span></div>
            ${key('DML user', 'ndDmlUser')}
            <div class="mc-line"><input id="ndDmlUser" class="input nd-short nd-mono" maxlength="63" spellcheck="false" /><input id="ndDmlPass" class="input nd-pass nd-mono" type="password" maxlength="200" placeholder="password" autocomplete="new-password" aria-label="Password of the DML user" /><span class="nd-hint">the application</span></div>
            <span class="mc-key">DML may</span>
            <div class="mc-line" role="group" aria-label="What the DML user may do">${ND_PERMS.map((p) => `<label class="nd-perm"><input type="checkbox" data-perm="${p}" /> ${p}</label>`).join('')}</div>
          </div>
          <p class="nd-note">PostgreSQL users are shared by all its databases: one that is there already is kept as it is, with the password it has.</p>
          <div class="nd-sec">Where PostgreSQL is <span class="nd-line"></span></div>
          <div class="mc-grid">
            ${key('Runs in', 'ndTarget')}
            <div class="mc-line"><select id="ndTarget" class="input mc-wide"></select></div>
            <label class="mc-key nd-kube" for="ndContext">Cluster</label>
            <div class="mc-line nd-kube"><select id="ndContext" class="input mc-wide nd-mono"></select><span id="ndLocal" class="nd-chip"></span></div>
            <label class="mc-key nd-kube" for="ndNamespace">Namespace</label>
            <div class="mc-line nd-kube"><input id="ndNamespace" class="input nd-short nd-mono" maxlength="63" spellcheck="false" placeholder="postgres" /></div>
            <label class="mc-key nd-kube" for="ndLabel">Pod</label>
            <div class="mc-line nd-kube"><input id="ndLabel" class="input mc-wide nd-mono" maxlength="300" spellcheck="false" placeholder="app.kubernetes.io/name=postgresql" title="The label of the pod of PostgreSQL" /><button id="ndFind" class="btn btn-sm" type="button" title="Look for the pod that runs with this label">Find</button></div>
            <span class="nd-kube"></span>
            <div id="ndPod" class="nd-found nd-kube" aria-live="polite"></div>
            ${key('Admin user', 'ndAdmin')}
            <div class="mc-line"><input id="ndAdmin" class="input nd-short nd-mono" maxlength="63" spellcheck="false" placeholder="postgres" /><input id="ndAdminPass" class="input nd-pass nd-mono" type="password" maxlength="200" placeholder="password" autocomplete="new-password" aria-label="Password of the admin user" /><span class="nd-hint">only if it asks</span></div>
            ${key('Reached at', 'ndHost')}
            <div class="mc-line"><input id="ndHost" class="input mc-wide nd-mono" maxlength="255" spellcheck="false" aria-label="Host" title="Where the microservice finds PostgreSQL: localhost from this computer, host.docker.internal (Podman: host.containers.internal) from a container" /><span class="nd-at">:</span><input id="ndPort" class="input nd-mono nd-port" inputmode="numeric" maxlength="5" aria-label="Port" /></div>
            <span></span>
            <div class="mc-line nd-from-line"><span class="nd-hint">by the microservice, when it runs on</span><button id="ndHostHere" class="logs-form-chip" type="button" title="The microservice runs on this computer (IntelliJ, spring-boot:run): localhost">this PC</button><span class="nd-hint">or in</span><button id="ndHostBox" class="logs-form-chip" type="button" title="The microservice runs in a container: inside it localhost is the container itself">a container</button></div>
          </div>
          <p id="ndNone" class="nd-note hidden"></p>
        </form>
        <div class="nd-right">
          <div class="nd-box grow">
            <div class="nd-box-head">
              <div id="ndView" class="seg" role="group" aria-label="What to show">${ND_VIEWS.map(([id, label]) => `<button class="seg-btn" type="button" data-view="${id}" aria-pressed="false">${label}</button>`).join('')}</div>
              <span class="nd-gap"></span>
              <label class="mv-differs"><input id="ndShow" type="checkbox" /> Show passwords</label>
              <button id="ndCopy" class="btn btn-sm" type="button" title="Copy it, with its passwords: out of the clipboard history, and cleared from the clipboard in half a minute">Copy</button>
            </div>
            <pre id="ndPre" class="clip-formatted nd-pre" tabindex="0" aria-label="What it runs"></pre>
          </div>
          <div class="nd-box">
            <div class="nd-box-head">
              <span class="nd-box-title">For the microservice</span>
              <div id="ndFormat" class="seg" role="group" aria-label="As">${ND_FORMATS.map(([id, label, title]) => `<button class="seg-btn" type="button" data-format="${id}" aria-pressed="false" title="${title}">${label}</button>`).join('')}</div>
              <span class="nd-gap"></span>
              <div id="ndMig" class="seg" role="group" aria-label="Its migrations">${ND_MIGRATIONS.map(([id, label]) => `<button class="seg-btn" type="button" data-mig="${id}" aria-pressed="false" title="The lines of the user that makes the tables: ${label}">${label}</button>`).join('')}</div>
              <button id="ndCopyProps" class="btn btn-sm" type="button" title="Copy these lines, with their passwords, for the microservice's application properties">Copy</button>
            </div>
            <pre id="ndProps" class="clip-formatted nd-pre nd-props" aria-label="What the microservice needs to connect"></pre>
          </div>
        </div>
      </div>
      <div class="nd-foot">
        <span id="ndSay" class="nd-say" role="status" aria-live="polite"></span>
        <button id="ndAdd" class="btn hidden" type="button" title="A connection to it on the Database page, as the DML user">Add it to the Database page</button>
        <button id="ndCancel" class="btn" type="button">Close</button>
        <button id="ndRun" class="btn btn-primary" type="button">Create</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) closeNewDatabase();
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeNewDatabase();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runNewDatabase();
  });
  $('#ndClose').addEventListener('click', closeNewDatabase);
  $('#ndCancel').addEventListener('click', closeNewDatabase);
  $('#ndForm').addEventListener('submit', (e) => e.preventDefault());
  $('#ndMs').addEventListener('change', () => {
    const name = $('#ndMs').value;
    if (name) $('#ndDb').value = name;
    ndFollowSchema();
    ndChanged();
  });
  $('#ndDb').addEventListener('input', () => {
    ndFollowSchema();
    ndChanged();
  });
  $('#ndSchema').addEventListener('input', () => {
    nd.schemaTyped = Boolean($('#ndSchema').value.trim());
    ndFollowSchema();
    ndChanged();
  });
  for (const id of ['#ndDdlUser', '#ndDdlPass', '#ndDmlUser', '#ndDmlPass', '#ndAdmin', '#ndAdminPass', '#ndNamespace', '#ndLabel', '#ndHost', '#ndPort']) $(id).addEventListener('input', ndChanged);
  modal.querySelectorAll('[data-perm]').forEach((box) => box.addEventListener('change', ndChanged));
  $('#ndTarget').addEventListener('change', () => {
    ndTargetChosen(true);
    ndChanged();
  });
  $('#ndContext').addEventListener('change', () => {
    nd.pod = null;
    ndChanged();
  });
  $('#ndFind').addEventListener('click', findNewDatabasePod);
  $('#ndView').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b && !b.disabled) ndShowView(b.dataset.view);
  });
  $('#ndMig').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mig]');
    if (!b) return;
    nd.migrations = b.dataset.mig;
    ndChanged();
  });
  $('#ndFormat').addEventListener('click', (e) => {
    const b = e.target.closest('[data-format]');
    if (!b) return;
    nd.format = b.dataset.format;
    ndChanged();
  });
  // where the microservice runs: on this computer, or in a container (the engine's name for this computer)
  $('#ndHostHere').addEventListener('click', () => {
    $('#ndHost').value = 'localhost';
    ndChanged();
  });
  $('#ndHostBox').addEventListener('click', () => {
    $('#ndHost').value = nd.targets && nd.targets.engine && nd.targets.engine.name === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
    ndChanged();
  });
  $('#ndShow').addEventListener('change', () => {
    nd.showPass = $('#ndShow').checked;
    for (const id of ['#ndDdlPass', '#ndDmlPass', '#ndAdminPass']) $(id).type = nd.showPass ? 'text' : 'password';
    renderNewDatabase();
  });
  $('#ndCopy').addEventListener('click', () => copyNewDatabase(nd.view));
  $('#ndCopyProps').addEventListener('click', () => copyNewDatabase('props'));
  $('#ndRun').addEventListener('click', runNewDatabase);
  $('#ndAdd').addEventListener('click', addNewDatabaseConnection);
  window.newDb.onOutput(({ id, text }) => {
    if (!nd.running || nd.running !== id) return;
    nd.out += text;
    if (nd.view === 'output') {
      const pre = $('#ndPre');
      pre.textContent = nd.out;
      pre.scrollTop = pre.scrollHeight;
    }
  });
  return modal;
}

function ndFollowSchema() {
  if (!nd.schemaTyped) $('#ndSchema').value = $('#ndDb').value.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').slice(0, 63);
  $('#ndSchemaFrom').classList.toggle('hidden', nd.schemaTyped);
}

const ndTargetOf = () => {
  const value = $('#ndTarget').value;
  const t = nd.targets;
  if (!t || !value) return null;
  if (value.startsWith('k:')) return { kind: 'kube', tool: value.slice(2), info: t.kube.find((k) => k.tool === value.slice(2)) };
  return { kind: 'container', info: t.containers.find((c) => c.id === value.slice(2)) };
};

function ndValues() {
  return {
    database: $('#ndDb').value, schema: $('#ndSchema').value,
    ddlUser: $('#ndDdlUser').value, ddlPassword: $('#ndDdlPass').value,
    dmlUser: $('#ndDmlUser').value, dmlPassword: $('#ndDmlPass').value,
    perms: [...$('#ndModal').querySelectorAll('[data-perm]')].filter((b) => b.checked).map((b) => b.dataset.perm),
    host: $('#ndHost').value, port: $('#ndPort').value, migrations: nd.migrations, format: nd.format,
  };
}

function ndWhere() {
  const t = ndTargetOf();
  const admin = $('#ndAdmin').value;
  if (!t) return { kind: 'container', container: '', admin };
  if (t.kind === 'kube') return { kind: 'kube', tool: t.tool, context: $('#ndContext').value, namespace: $('#ndNamespace').value, label: $('#ndLabel').value, admin };
  return { kind: 'container', engine: t.info ? t.info.engine : '', container: t.info ? t.info.name : '', admin };
}

// The target chosen: its rows (a cluster has its context, namespace and label), and what it knows (the admin user of
// the container, the port it publishes).
function ndTargetChosen(fill) {
  const t = ndTargetOf();
  const kube = Boolean(t && t.kind === 'kube');
  $('#ndModal').querySelectorAll('.nd-kube').forEach((el) => el.classList.toggle('hidden', !kube));
  nd.pod = null;
  if (kube) {
    const saved = ndSaved();
    const select = $('#ndContext');
    select.replaceChildren(...t.info.contexts.map((c) => new Option(c.name, c.name)));
    const want = [saved.context, t.info.current, (t.info.contexts.find((c) => c.local) || {}).name].find((n) => t.info.contexts.some((c) => c.name === n));
    select.value = want || t.info.contexts[0].name;
    if (fill) {
      $('#ndNamespace').value = saved.namespace || 'postgres';
      $('#ndLabel').value = saved.label || 'app.kubernetes.io/name=postgresql';
      $('#ndAdmin').value = saved.kubeAdmin || 'postgres';
      $('#ndHost').value = 'localhost';
      $('#ndPort').value = '5432';
    }
  } else if (t && t.info && fill) {
    $('#ndAdmin').value = t.info.admin || 'postgres';
    $('#ndHost').value = 'localhost';
    $('#ndPort').value = String(t.info.port || 5432);
  }
}

// preset: the values Local setup found for this microservice ({ database, schema, ddlUser, ddlPassword, dmlUser,
// dmlPassword, migrations }): the window opens over it, filled in.
async function openNewDatabase(preset = null) {
  const modal = newDatabaseModal();
  document.body.appendChild(modal);
  const saved = ndSaved();
  Object.assign(nd, { view: ['sql', 'powershell', 'bash'].includes(saved.view) ? saved.view : 'sql', preview: null, out: '', running: null, result: null, schemaTyped: false, pod: null, showPass: false, migrations: saved.migrations || 'flyway', format: saved.format === 'env' ? 'env' : 'props', targets: null });
  // the microservices of the list; the one open now first
  const list = (typeof repos !== 'undefined' ? repos : []).map((r) => ({ name: r.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop(), label: displayName(r), path: r.path }));
  const ms = $('#ndMs');
  ms.replaceChildren(new Option('Another name: type it below', ''), ...list.map((r) => new Option(r.label === r.name ? r.name : `${r.label} (${r.name})`, r.name)));
  const now = list.find((r) => r.path === currentRepo);
  ms.value = now ? now.name : '';
  $('#ndDb').value = now ? now.name : '';
  $('#ndSchema').value = '';
  ndFollowSchema();
  $('#ndDdlUser').value = saved.ddlUser || 'user_ddl';
  $('#ndDmlUser').value = saved.dmlUser || 'user_dml';
  for (const id of ['#ndDdlPass', '#ndDmlPass', '#ndAdminPass']) {
    $(id).value = '';
    $(id).type = 'password';
  }
  if (preset) {
    $('#ndDb').value = preset.database || '';
    $('#ndSchema').value = preset.schema || '';
    nd.schemaTyped = Boolean(preset.schema);
    $('#ndDdlUser').value = preset.ddlUser || $('#ndDdlUser').value;
    $('#ndDmlUser').value = preset.dmlUser || $('#ndDmlUser').value;
    $('#ndDdlPass').value = preset.ddlPassword || '';
    $('#ndDmlPass').value = preset.dmlPassword || '';
    if (ND_MIGRATIONS.some(([id]) => id === preset.migrations)) nd.migrations = preset.migrations;
    ms.value = [...ms.options].some((o) => o.value === preset.database) ? preset.database : '';
    ndFollowSchema();
  }
  $('#ndShow').checked = false;
  const perms = Array.isArray(saved.perms) && saved.perms.length ? saved.perms : ND_PERMS;
  modal.querySelectorAll('[data-perm]').forEach((b) => (b.checked = perms.includes(b.dataset.perm)));
  $('#ndTarget').replaceChildren(new Option('Looking for PostgreSQL...', ''));
  $('#ndTarget').disabled = true;
  $('#ndNone').classList.add('hidden');
  ndTargetChosen(false);
  $('#ndHost').value = 'localhost';
  $('#ndPort').value = '5432';
  $('#ndAdmin').value = 'postgres';
  $('#ndAdd').classList.add('hidden');
  modal.classList.remove('hidden');
  renderNewDatabase();
  (now ? $('#ndDdlPass') : $('#ndDb')).focus();
  const t = await window.newDb.targets();
  if (modal.classList.contains('hidden')) return;
  nd.targets = t.error ? { containers: [], kube: [], engineError: t.error } : t;
  const options = [
    ...nd.targets.containers.map((c) => new Option(`${c.name} · ${c.image}${c.port ? ` · :${c.port}` : ''} (${nd.targets.engine ? nd.targets.engine.label : 'container'})`, `c:${c.id}`)),
    ...nd.targets.kube.map((k) => new Option(`A pod of a cluster (${k.tool})`, `k:${k.tool}`)),
  ];
  const select = $('#ndTarget');
  select.replaceChildren(...(options.length ? options : [new Option('No PostgreSQL found', '')]));
  select.disabled = !options.length;
  const kept = options.find((o) => o.value === saved.target) || options.find((o) => o.value.startsWith('c:') && saved.container && o.textContent.startsWith(`${saved.container} ·`));
  select.value = kept ? kept.value : options[0] ? options[0].value : '';
  if (!options.length) {
    const note = $('#ndNone');
    note.textContent = `No container runs a PostgreSQL${nd.targets.engineError ? ` (${nd.targets.engineError})` : ''}, and neither kubectl nor oc knows a cluster. Start the PostgreSQL of the microservice (its compose, on the Containers page) and open this again.`;
    note.classList.remove('hidden');
  }
  ndTargetChosen(true);
  ndChanged();
}

function closeNewDatabase() {
  const modal = $('#ndModal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (nd.running) window.newDb.stop();
  clearTimeout(nd.timer);
  for (const id of ['#ndDdlPass', '#ndDmlPass', '#ndAdminPass']) $(id).value = '';
  nd.preview = null;
  nd.out = '';
  modal.classList.add('hidden');
}

// A value changed: remembered (never the passwords), what is on the right asked again in a moment.
function ndChanged() {
  const v = ndValues();
  const t = ndTargetOf();
  const kube = t && t.kind === 'kube';
  dbStore(ND_KEY, JSON.stringify({
    ...ndSaved(), ddlUser: v.ddlUser.trim(), dmlUser: v.dmlUser.trim(), perms: v.perms, migrations: nd.migrations, format: nd.format, view: nd.view === 'output' ? ndSaved().view : nd.view,
    target: $('#ndTarget').value, ...(t && t.kind === 'container' && t.info ? { container: t.info.name } : {}),
    ...(kube ? { context: $('#ndContext').value, namespace: $('#ndNamespace').value.trim(), label: $('#ndLabel').value.trim(), kubeAdmin: $('#ndAdmin').value.trim() } : {}),
  }));
  if (nd.result) {
    nd.result = null;
    $('#ndAdd').classList.add('hidden');
  }
  clearTimeout(nd.timer);
  nd.timer = setTimeout(previewNewDatabase, 180);
  renderNewDatabase();
}

async function previewNewDatabase() {
  const seq = ++nd.seq;
  const r = await window.newDb.preview(ndValues(), ndWhere());
  if (seq !== nd.seq || $('#ndModal').classList.contains('hidden')) return;
  nd.preview = r.error ? { problems: [r.error], sql: '', powershell: '', bash: '', props: '' } : r;
  renderNewDatabase();
}

// Text marked by the main process as HTML: a value in a <mark>, a password as dots unless they are shown.
function ndMarked(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc(String(text || ''))
    .replace(/\u0003([\s\S]*?)\u0004/g, (_, pw) => `<mark class="nd-pw">${nd.showPass ? pw : '••••••••'}</mark>`)
    .replace(/\u0001([\s\S]*?)\u0002/g, '<mark>$1</mark>');
}

function ndShowView(view) {
  nd.view = view;
  if (view !== 'output') dbStore(ND_KEY, JSON.stringify({ ...ndSaved(), view }));
  renderNewDatabase();
}

function renderNewDatabase() {
  const p = nd.preview;
  const t = ndTargetOf();
  $('#ndView').querySelectorAll('[data-view]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.view === nd.view));
    if (b.dataset.view === 'output') b.disabled = !nd.out && !nd.running;
  });
  $('#ndMig').querySelectorAll('[data-mig]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mig === nd.migrations)));
  $('#ndFormat').querySelectorAll('[data-format]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.format === nd.format)));
  $('#ndCopyProps').title = nd.format === 'env' ? 'Copy these variables, with their passwords, to Paste them in Start in container or in Env' : 'Copy these lines, with their passwords, for the microservice\'s application properties';
  const pre = $('#ndPre');
  if (nd.view === 'output') pre.textContent = nd.out || (nd.running ? 'Running...' : '');
  else pre.innerHTML = p && p[nd.view] ? ndMarked(p[nd.view]) : '';
  $('#ndProps').innerHTML = p && p.props ? ndMarked(p.props) : '';
  // what PostgreSQL said is not copied from here: it is not a script
  $('#ndCopy').disabled = !p || !p.sql || Boolean(p.problems.length) || nd.view === 'output';
  $('#ndCopyProps').disabled = !p || !p.props || Boolean(p.problems.length);
  // the cluster chosen: one of this computer, or not
  const chip = $('#ndLocal');
  if (t && t.kind === 'kube' && p && p.target) {
    chip.textContent = p.target.production ? 'production' : p.target.local ? 'local' : 'not this computer';
    chip.className = `nd-chip ${p.target.production ? 'bad' : p.target.local ? 'ok' : 'warn'}`;
  } else chip.className = 'nd-chip hidden';
  const pod = $('#ndPod');
  pod.textContent = '';
  if (nd.pod) {
    pod.className = `nd-found nd-kube${nd.pod.error ? ' bad' : ''}`;
    if (!nd.pod.error) pod.appendChild(dbEl('span', 'nd-dot'));
    pod.append(nd.pod.error || nd.pod.name);
  }
  const say = $('#ndSay');
  const run = $('#ndRun');
  run.textContent = nd.running ? 'Stop' : 'Create';
  const production = Boolean(p && p.target && p.target.production);
  if (nd.running) {
    say.textContent = 'Running in PostgreSQL...';
    say.className = 'nd-say';
    run.disabled = false;
  } else if (nd.result) {
    say.textContent = nd.result.ok
      ? `Done: the database ${nd.result.database} with the schema ${nd.result.schema}${nd.result.kept.length ? `. Kept as it was: ${nd.result.kept.map((k) => k.split(':')[0]).join(', ')}` : ''}`
      : nd.result.error;
    say.className = `nd-say ${nd.result.ok ? 'ok' : 'bad'}`;
    run.disabled = false;
  } else {
    const problem = production ? 'That cluster reads as production: a database is not made there from here' : p && p.problems.length ? p.problems[0] : '';
    say.textContent = problem || (p ? 'Marked: where each value goes. The passwords are not kept.' : '');
    say.className = `nd-say${production ? ' bad' : ''}`;
    run.disabled = !p || Boolean(problem) || !t;
  }
}

async function findNewDatabasePod() {
  const btn = $('#ndFind');
  btn.disabled = true;
  nd.pod = null;
  renderNewDatabase();
  const r = await window.newDb.pod(ndWhere());
  btn.disabled = false;
  nd.pod = r.error ? { error: r.error } : { name: r.pod };
  renderNewDatabase();
}

async function copyNewDatabase(what) {
  const r = await window.newDb.copy(ndValues(), ndWhere(), what);
  const vars = what === 'props' && nd.format === 'env';
  if (vars && !r.error && nd.preview && typeof pastedMvnEnvVars === 'function') {
    // Paste (Start in container, Env) has them after the clipboard is cleared too
    mvnEnvCopied = nd.preview.props.replace(/[\u0001-\u0004]/g, '');
  }
  const name = { sql: 'SQL', powershell: 'PowerShell script', bash: 'Bash script', props: vars ? 'Variables for the microservice' : 'Lines for the microservice' }[what];
  toast(r.error || (vars ? `${name} copied, with the passwords: Paste them in Start in container or in Env` : `${name} copied, with the passwords: cleared from the clipboard in half a minute`), r.error ? 'error' : 'success');
}

async function runNewDatabase() {
  if (nd.running) {
    window.newDb.stop();
    return;
  }
  if ($('#ndRun').disabled) return;
  const p = nd.preview;
  const where = ndWhere();
  let confirmed = false;
  if (where.kind === 'kube' && p && p.target && !p.target.local) {
    confirmed = await askConfirm(`Make the database in ${where.context}?\nIt is not a cluster of this computer: the database, its schema and its users are made there, as ${where.admin.trim() || 'postgres'}.`, { confirm: 'Make it there' });
    if (!confirmed) return;
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  nd.running = id;
  nd.out = '';
  nd.result = null;
  $('#ndAdd').classList.add('hidden');
  nd.view = 'output';
  renderNewDatabase();
  const values = ndValues();
  const r = await window.newDb.run(id, values, where, $('#ndAdminPass').value, confirmed);
  if (nd.running !== id) return;
  nd.running = null;
  nd.result = r.error && r.ok === undefined ? { ok: false, error: r.error } : r;
  if (!nd.result.ok && nd.result.error) nd.out += `${nd.out && !nd.out.endsWith('\n') ? '\n' : ''}${nd.result.error}\n`;
  renderNewDatabase();
  if (nd.result.ok) {
    nd.made = { ...values, database: values.database.trim(), dmlUser: values.dmlUser.trim() };
    $('#ndAdd').classList.remove('hidden');
    toast(`Database ${nd.result.database} is there, with its schema and users`, 'success');
  } else {
    if (nd.result.needsPassword) $('#ndAdminPass').focus();
    if (!nd.result.stopped) toast(nd.result.error, 'error');
  }
}

// A connection to the new database on the Database page, as the DML user (its password kept encrypted, as the
// others); a name taken gets the user's after it.
async function addNewDatabaseConnection() {
  const m = nd.made;
  if (!m) return;
  const taken = (name) => db.conns.some((c) => c.name.toLowerCase() === name.toLowerCase());
  let name = m.database.slice(0, 60);
  if (taken(name)) name = `${m.database} (${m.dmlUser})`.slice(0, 60);
  for (let n = 2; taken(name) && n < 50; n++) name = `${m.database} ${n}`.slice(0, 60);
  db.saving = true;
  let r;
  try {
    // localhost as 127.0.0.1: a container's port is often published on IPv4 only, and localhost may be tried as ::1
    const host = !m.host.trim() || m.host.trim().toLowerCase() === 'localhost' ? '127.0.0.1' : m.host.trim();
    r = await window.database.save({ name, host, port: Number(m.port) || 5432, database: m.database, user: m.dmlUser, password: m.dmlPassword, ssl: 'disable' });
  } finally {
    db.saving = false;
  }
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  closeNewDatabase();
  db.conns = r.connections;
  renderDbBar();
  await openDbConnection(r.connection.id);
  toast(`Connection ${r.connection.name} added: the new database, as ${m.dmlUser}`, 'success');
}

$('#dbNewBtn').addEventListener('click', () => openNewDatabase());
