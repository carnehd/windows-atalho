// -- Env for Start and Debug, like a run configuration in IntelliJ: environment variables in a table of name / value
// rows as the Bruno page edits headers (the box switches one off and keeps it, × takes it out, typing in the empty row
// at the end adds one). NAME=value lines or IntelliJ's NAME=value;NAME2=value2 pasted into a name become a row each;
// From IntelliJ takes the run configurations IntelliJ keeps in the repository. Saved per repository in the app's data
// (maven.js gives them to spring-boot:run only; the output names the variables, never their values). --
let mvnRunEnv = { vars: [] };
let mvnEnvRows = []; // the rows of the dialog, { name, value, enabled }: the table changes them in place
let mvnEnvConfigs = []; // IntelliJ's, read when the dialog opens
let mvnEnvFolders = []; // the folders of the repository with a pom.xml (from the info), for IntelliJ's module

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PROFILES_ENV = 'SPRING_PROFILES_ACTIVE';
const mvnEnvKey = (name) => (window.git.platform === 'win32' ? name.toUpperCase() : name);

// "Env: profile sit, 2 variables", of those switched on
function mvnEnvSummary(r) {
  const on = (r.vars || []).filter((v) => v.enabled !== false);
  const profiles = on.find((v) => v.name === PROFILES_ENV);
  const rest = on.length - (profiles ? 1 : 0);
  return [profiles && `profile ${profiles.value}`, rest && plural(rest, 'variable')].filter(Boolean).join(', ');
}

function renderMvnEnvBtn(info) {
  mvnRunEnv = info.runEnv || { vars: [] };
  if (info.folders) mvnEnvFolders = info.folders;
  const btn = $('#mvnEnvBtn');
  const summary = mvnEnvSummary(mvnRunEnv);
  const names = mvnRunEnv.vars.filter((v) => v.enabled !== false).map((v) => v.name);
  btn.classList.toggle('on', Boolean(summary));
  $('#mvnEnvLabel').textContent = summary ? `Env: ${summary}` : 'Env';
  btn.title = summary
    ? `Start and Debug start the application with ${summary}: ${names.join(', ')}`
    : 'Environment variables for Start and Debug, like a run configuration in IntelliJ';
}

// The rows as they are saved: one with neither name nor value is left out; a name no shell takes, or one switched on
// twice, is an error at its row.
function checkMvnEnvRows(rows) {
  const vars = [];
  const errors = [];
  const at = new Map();
  rows.forEach((row, i) => {
    const name = String(row.name || '').trim();
    const value = String(row.value ?? '');
    if (!name && !value) return;
    const n = i + 1;
    if (!name) return errors.push({ at: i, text: `Row ${n}: the value has no name` });
    if (!ENV_NAME.test(name)) return errors.push({ at: i, text: `Row ${n}: "${name.slice(0, 40)}" is not a variable name (a letter or _ first, then letters, digits, _ . -)` });
    const on = row.enabled !== false;
    if (on && at.has(mvnEnvKey(name))) return errors.push({ at: i, text: `Row ${n}: ${name} is on row ${at.get(mvnEnvKey(name))} too: switch one off` });
    if (on) at.set(mvnEnvKey(name), n);
    vars.push(on ? { name, value } : { name, value, enabled: false });
  });
  return { vars, errors };
}

// IntelliJ's line: NAME=value;NAME2=value2, a ; inside a value written \;
function splitIntellijEnv(text) {
  const t = String(text).trim();
  if (t.includes('\n') || !t.includes(';') || !/^[A-Za-z_][\w.-]*=/.test(t)) return null;
  return t.split(/(?<!\\);/).map((p) => p.replace(/\\;/g, ';').trim()).filter(Boolean);
}

// Text pasted into a name, as variables: NAME=value lines (export NAME=value and quoted values as a .env file has them
// too, # for a comment) or IntelliJ's line. null when it is not that: it is then pasted as it is.
function pastedMvnEnvVars(text) {
  const t = String(text).replace(/\r/g, '').trim();
  const vars = [];
  for (const raw of splitIntellijEnv(t) || t.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.replace(/^export\s+/, '');
    const eq = body.indexOf('=');
    const name = eq > 0 ? body.slice(0, eq).trim() : '';
    if (!ENV_NAME.test(name)) return null;
    let value = body.slice(eq + 1).trim();
    const q = /^(["'])([\s\S]*)\1$/.exec(value);
    if (q) value = q[2];
    vars.push({ name, value, enabled: true });
  }
  return vars.length ? vars : null;
}

function mvnEnvModal() {
  let modal = $('#mvnEnvModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'mvnEnvModal';
  modal.className = 'settings-overlay hidden';
  modal.innerHTML = `
    <div class="settings-card me-card" role="dialog" aria-modal="true" aria-labelledby="meTitle">
      <h3 id="meTitle">Start and Debug: environment variables</h3>
      <p id="meSub" class="mv-sub">Like a run configuration in IntelliJ. Saved for this microservice: Start, Debug and spring-boot:run start with them; a build and the tests do not.</p>
      <div class="me-vars-head">
        <p id="meHint" class="me-hint">Untick one to keep it without giving it. NAME=value lines, or IntelliJ's NAME=value;NAME2=value2, pasted into a name become a row each.</p>
        <button id="meIntellij" class="btn btn-sm hidden" type="button" aria-haspopup="menu">From IntelliJ</button>
      </div>
      <div id="meVars" class="me-vars" role="group" aria-label="Environment variables" aria-describedby="meHint meNote"></div>
      <p id="meNote" class="me-note" aria-live="polite"></p>
      <div class="action-row settings-actions mv-actions">
        <button id="meClear" class="btn" type="button" title="Take every row out (Save to keep it so)">Clear</button>
        <span class="mv-gap"></span>
        <button id="meCancel" class="btn" type="button">Cancel</button>
        <button id="meSave" class="btn btn-primary" type="button" title="Save (Ctrl+Enter)">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMvnEnv();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveMvnEnv();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && e.target.matches('#meVars .bru-input')) {
      // Enter in a row: on to the name of the next one
      e.preventDefault();
      focusMvnEnvRow(mvnEnvRowOf(e.target) + 1);
    }
  });
  $('#meCancel').addEventListener('click', closeMvnEnv);
  $('#meSave').addEventListener('click', saveMvnEnv);
  $('#meClear').addEventListener('click', () => {
    mvnEnvRows = [];
    drawMvnEnvRows(0);
  });
  // × takes the row out and the table is drawn again: the focus goes to the row that took its place
  $('#meVars').addEventListener(
    'click',
    (e) => {
      const del = e.target.closest('.bru-kv-del');
      if (!del || del.disabled) return;
      const at = mvnEnvRowOf(del);
      setTimeout(() => focusMvnEnvRow(at));
    },
    true
  );
  $('#meVars').addEventListener('paste', (e) => {
    const input = e.target.closest('.bru-kv-name');
    const vars = input && pastedMvnEnvVars(e.clipboardData.getData('text/plain'));
    if (!vars) return;
    e.preventDefault();
    const done = pasteMvnEnvRows(mvnEnvRows, mvnEnvRowOf(input), vars);
    drawMvnEnvRows(mvnEnvRows.length, done);
  });
  $('#meIntellij').addEventListener('click', openMvnEnvIntellij);
  return modal;
}

// The index of the row an element of a table is in (the empty row at the end is the number of rows).
const kvRowOf = (el) => [...el.closest('.bru-kv-edit').children].indexOf(el.closest('.bru-kv-row'));
const mvnEnvRowOf = kvRowOf;

// Variables pasted at row `at` of rows: in place of that row when it is empty, else under it; a name already there takes
// the new value. Says what was done.
function pasteMvnEnvRows(rows, at, vars) {
  const here = rows[at];
  if (here && !String(here.name).trim() && !here.value) rows.splice(at, 1);
  else if (here) at += 1;
  let replaced = 0;
  for (const v of vars) {
    const same = rows.filter((r) => mvnEnvKey(String(r.name).trim()) === mvnEnvKey(v.name));
    const row = same.find((r) => r.enabled !== false) || same[0];
    if (row) {
      Object.assign(row, { value: v.value, enabled: true });
      replaced += 1;
    } else rows.splice(at++, 0, v);
  }
  return `Pasted ${plural(vars.length, 'variable')}${replaced ? ` (${replaced} already there: the new value)` : ''}.`;
}

// Under a table of rows: how many variables, the first row that is wrong (its name marked), or what was just done.
function renderEnvRowsNote(box, note, rows, done = '') {
  const { vars, errors } = checkMvnEnvRows(rows);
  const wrong = new Set(errors.map((e) => e.at));
  box.querySelectorAll('.bru-kv-name').forEach((input, i) => (wrong.has(i) ? input.setAttribute('aria-invalid', 'true') : input.removeAttribute('aria-invalid')));
  const on = vars.filter((v) => v.enabled !== false).length;
  const off = vars.length - on;
  note.classList.toggle('error', errors.length > 0);
  note.textContent = errors.length
    ? errors[0].text + (errors.length > 1 ? ` (and ${errors.length - 1} more)` : '')
    : `${done ? `${done} ` : ''}${on ? plural(on, 'variable') : 'No variables'}${off ? `, ${off} switched off` : ''}`;
  return errors;
}

function focusKvRow(box, i) {
  const rows = box.querySelectorAll('.bru-kv-row');
  const row = rows[Math.min(i, rows.length - 1)];
  if (row) row.querySelector('.bru-kv-name').focus();
}
const focusMvnEnvRow = (i) => focusKvRow($('#meVars'), i);

// The table of the rows, drawn again after Clear, a paste or From IntelliJ; the focus on the name of row `focusAt`.
function drawMvnEnvRows(focusAt, done = '') {
  const box = $('#meVars');
  // the table says what changed before it draws itself again (×): the note waits for it
  box.replaceChildren(bruKvEditor(mvnEnvRows, { onChange: () => setTimeout(renderMvnEnvNote), focusKey: 'me' }));
  if (focusAt !== undefined) focusMvnEnvRow(focusAt);
  renderMvnEnvNote(done);
}

const renderMvnEnvNote = (done = '') => renderEnvRowsNote($('#meVars'), $('#meNote'), mvnEnvRows, done);

async function openMvnEnv() {
  if (!mvnRepo) return;
  const repo = mvnRepo;
  const modal = mvnEnvModal();
  mvnEnvRows = mvnRunEnv.vars.map((v) => ({ name: v.name, value: v.value, enabled: v.enabled !== false }));
  $('#meIntellij').classList.add('hidden');
  modal.classList.remove('hidden');
  drawMvnEnvRows(0);
  $('#mvnEnvBtn').setAttribute('aria-expanded', 'true');
  const r = await window.maven.intellijConfigs(repo);
  if (repo !== mvnRepo || modal.classList.contains('hidden')) return;
  mvnEnvConfigs = (r && r.configs) || [];
  const btn = $('#meIntellij');
  btn.classList.toggle('hidden', !mvnEnvConfigs.length);
  btn.textContent = `From IntelliJ (${mvnEnvConfigs.length})`;
  btn.title = `The run configurations of this project in IntelliJ with variables or profiles: ${mvnEnvConfigs.map((c) => c.name).join(', ')}`;
}

function closeMvnEnv() {
  const modal = $('#mvnEnvModal');
  if (!modal || modal.classList.contains('hidden')) return;
  closeActionMenu();
  modal.classList.add('hidden');
  $('#mvnEnvBtn').setAttribute('aria-expanded', 'false');
  $('#mvnEnvBtn').focus();
}

function openMvnEnvIntellij() {
  const btn = $('#meIntellij');
  openActionMenu({
    anchor: btn,
    title: 'Take from IntelliJ',
    items: mvnEnvConfigs.map((c) => ({
      label: `${c.name}${c.kind ? ` (${c.kind})` : ''}: ${mvnEnvSummary(c)}`,
      hint: `${c.module ? `Module ${c.module}. ` : ''}From ${c.file}${c.skipped.length ? `. Left out: ${c.skipped.join(', ')}` : ''}`,
      run: () => takeMvnEnvConfig(c),
    })),
  });
  const first = $('#actionMenu .clip-menu-item');
  if (first) first.focus();
}

// Into the table, in place of what it had: Save keeps it.
function takeMvnEnvConfig(c) {
  mvnEnvRows = c.vars.map((v) => ({ name: v.name, value: v.value, enabled: true }));
  // IntelliJ's module is a folder of the repository other than the one Maven runs in
  const moduleDir = c.module ? mvnEnvFolders.find((f) => f && f.split('/').pop() === c.module) : undefined;
  const more = [
    c.skipped.length && `Left out: ${c.skipped.join(', ')} (a value on several lines, or a name a shell does not take).`,
    moduleDir !== undefined && moduleDir !== mvnValuesDir && `IntelliJ runs it in the module ${c.module}: choose ${moduleDir}/ in Runs in.`,
  ].filter(Boolean);
  drawMvnEnvRows(0, `Taken from ${c.name}: Save to keep it.${more.length ? ` ${more.join(' ')}` : ''}`);
}

async function saveMvnEnv() {
  if (!mvnRepo) return;
  const repo = mvnRepo;
  const { vars, errors } = checkMvnEnvRows(mvnEnvRows);
  if (errors.length) {
    renderMvnEnvNote();
    focusMvnEnvRow(errors[0].at);
    return;
  }
  const r = await window.maven.setRunEnv(repo, { vars });
  if (repo !== mvnRepo) return;
  if (r.error) {
    const note = $('#meNote');
    note.classList.add('error');
    note.textContent = r.error;
    return;
  }
  renderMvnEnvBtn({ runEnv: r.runEnv });
  closeMvnEnv();
  const summary = mvnEnvSummary(r.runEnv);
  toast(summary ? `Start and Debug: ${summary}` : 'Start and Debug: no variables', 'success', { plain: true });
}

function setupMvnEnv() {
  $('#mvnEnvBtn').addEventListener('click', openMvnEnv);
}
