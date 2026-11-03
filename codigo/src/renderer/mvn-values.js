// -- Values per environment for Start and Debug: the variables of the service's application*.properties / .yml, and
// for each one the environment whose value the application starts with. "All from" puts them all in one environment;
// a click on a value changes that one, and a double-click (or F2) changes the value itself, here only: the files stay
// as they are. Kept per repository and folder. The values that differ from local go to spring-boot:run as
// SPRING_APPLICATION_JSON, over the files (maven.js); a build or the tests never get them. --
const MVN_VALUES_KEY = 'mvnValues';
const MVN_VALUES_DIFFERS_KEY = 'mvnValuesDiffers';
let mvnValueEnvs = []; // the environments with a file in the folder the commands run in (from the info)
let mvnValuesDir = '';
let mvnValuesTable = null; // { files, envs, keys, values } as read when the dialog opened

const mvnValuesId = () => `${mvnRepo}|${mvnValuesDir}`;

// What is chosen: base, the environment of every variable; picks, the variables that take another one; edits, the
// values changed here, { variable: { environment: value } }.
function savedMvnValues() {
  try {
    const v = (JSON.parse(localStorage.getItem(MVN_VALUES_KEY)) || {})[mvnValuesId()] || {};
    const edits = {};
    for (const [key, envs] of Object.entries(v.edits && typeof v.edits === 'object' ? v.edits : {})) {
      for (const [env, value] of Object.entries(envs && typeof envs === 'object' ? envs : {})) if (typeof value === 'string') (edits[key] ||= {})[env] = value;
    }
    return { base: typeof v.base === 'string' ? v.base : 'local', picks: v.picks && typeof v.picks === 'object' ? v.picks : {}, edits };
  } catch {
    return { base: 'local', picks: {}, edits: {} };
  }
}

function storeMvnValues(choice) {
  try {
    const all = JSON.parse(localStorage.getItem(MVN_VALUES_KEY)) || {};
    if (choice.base === 'local' && !Object.keys(choice.picks).length && !Object.keys(choice.edits || {}).length) delete all[mvnValuesId()];
    else all[mvnValuesId()] = choice;
    localStorage.setItem(MVN_VALUES_KEY, JSON.stringify(all));
  } catch {
    // only for this session
  }
}

// An environment's value of a variable: its own, else the local one (the file every environment starts from), else none.
function mvValueOf(table, key, env) {
  const row = table.values[key] || {};
  if (env in row) return { value: row[env], own: true };
  if ('local' in row) return { value: row.local, own: false };
  return null;
}

const mvChosenEnv = (choice, key) => choice.picks[key] || choice.base;

// The value of a cell, the one a run takes: changed here, else the environment's own (mvValueOf).
function mvCellOf(table, choice, key, env) {
  const edit = choice.edits[key];
  if (edit && env in edit) return { value: edit[env], own: true, edited: true, file: mvValueOf(table, key, env) };
  return mvValueOf(table, key, env);
}

// How many variables take a value changed here (the cell they take was changed).
const mvEditsTaken = (choice) => Object.keys(choice.edits).filter((key) => mvChosenEnv(choice, key) in choice.edits[key]).length;

// "dev · 2 from sit, 1 from prod · 1 edited": the environment of all, how many come from another, how many were changed.
function mvnValuesSummary(choice) {
  const from = {};
  for (const env of Object.values(choice.picks)) if (env !== choice.base) from[env] = (from[env] || 0) + 1;
  const more = Object.entries(from).map(([env, n]) => `${n} from ${env}`).join(', ');
  const edited = mvEditsTaken(choice);
  return `${choice.base}${more ? ` · ${more}` : ''}${edited ? ` · ${edited} edited` : ''}`;
}

// What the application gets over its files: the values chosen that are not the local ones. null: nothing to add.
function mvnValuesPayload(table, choice) {
  const values = {};
  const from = {};
  let edited = 0;
  for (const key of table.keys) {
    const env = mvChosenEnv(choice, key);
    const got = mvCellOf(table, choice, key, env);
    if (!got || (env === 'local' && !got.edited)) continue;
    const local = (table.values[key] || {}).local;
    if (local !== undefined && got.value === local) continue;
    values[key] = got.value;
    if (got.edited) edited += 1;
    else from[env] = (from[env] || 0) + 1;
  }
  const n = Object.keys(values).length;
  if (!n) return null;
  const parts = [...Object.entries(from).map(([env, c]) => `${c} from ${env}`), edited && `${edited} edited`].filter(Boolean);
  return { values, valuesNote: `${plural(n, 'value')} (${parts.join(', ')})` };
}

// For a run: the values to send (read again from the files, which may have changed), or nothing.
async function mvnValuesRequest() {
  const choice = savedMvnValues();
  if (!mvnRepo || mvnValueEnvs.length < 2 || (choice.base === 'local' && !Object.keys(choice.picks).length && !mvEditsTaken(choice))) return {};
  const table = await window.maven.envValues(mvnRepo);
  if (!table || table.error) return {};
  return mvnValuesPayload(table, choice) || {};
}

// From the info of the Maven page: the button shows when the folder has files of more than one environment.
function renderMvnValuesBtn(info) {
  const dir = info.dir || '';
  if (dir !== mvnValuesDir) mvnValuesTable = null;
  mvnValuesDir = dir;
  mvnValueEnvs = info.valueEnvs || [];
  const btn = $('#mvnValuesBtn');
  btn.classList.toggle('hidden', mvnValueEnvs.length < 2);
  const choice = savedMvnValues();
  const changed = choice.base !== 'local' || Object.keys(choice.picks).length > 0 || mvEditsTaken(choice) > 0;
  btn.classList.toggle('on', changed);
  $('#mvnValuesLabel').textContent = `Values: ${mvnValuesSummary(choice)}`;
  btn.title = changed
    ? `Start and Debug take the values of ${mvnValuesSummary(choice)} (over the application files)`
    : 'Start and Debug take the local values (application.properties). Choose another environment for some or all of them';
}

function mvnValuesModal() {
  let modal = $('#mvnValuesModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'mvnValuesModal';
  modal.className = 'settings-overlay hidden';
  modal.innerHTML = `
    <div class="settings-card mv-card" role="dialog" aria-modal="true" aria-labelledby="mvTitle">
      <h3 id="mvTitle">Values for Start and Debug</h3>
      <p id="mvSub" class="mv-sub"></p>
      <div class="mv-all"><span>All from</span><div id="mvAll" class="mv-seg" role="radiogroup" aria-label="All the variables from"></div></div>
      <div class="mv-wrap"><table id="mvTable" class="mv-table"></table></div>
      <p class="mv-legend">A click on a value takes it for that variable; a double-click (or F2) changes it, for Start and Debug only: the files stay as they are. ✎: changed here (↺ puts the file's back). In italics: the environment does not set it, so it keeps the local one. ⚠: the value needs a variable of your environment (set it before Start).</p>
      <div class="action-row settings-actions mv-actions">
        <label class="mv-differs"><input id="mvDiffers" type="checkbox" /> <span id="mvDiffersText">Only what differs</span></label>
        <span class="mv-gap"></span>
        <button id="mvLocalBtn" class="btn" type="button" title="Every variable with its local value (application.properties): the values changed here are taken out too">Back to local</button>
        <button id="mvDoneBtn" class="btn btn-primary" type="button">Done</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) closeMvnValues();
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMvnValues();
    }
  });
  $('#mvDoneBtn').addEventListener('click', closeMvnValues);
  $('#mvLocalBtn').addEventListener('click', () => chooseMvnValues({ base: 'local', picks: {}, edits: {} }));
  $('#mvDiffers').addEventListener('change', (e) => {
    try {
      localStorage.setItem(MVN_VALUES_DIFFERS_KEY, e.target.checked ? '1' : '0');
    } catch {
      // only for now
    }
    renderMvnValuesTable();
  });
  return modal;
}

async function openMvnValues() {
  if (!mvnRepo) return;
  const repo = mvnRepo;
  const table = await window.maven.envValues(repo);
  if (repo !== mvnRepo) return;
  if (!table || table.error) return toast((table && table.error) || 'The application files could not be read', 'error');
  mvnValuesTable = table;
  const modal = mvnValuesModal();
  let differs = true;
  try {
    differs = localStorage.getItem(MVN_VALUES_DIFFERS_KEY) !== '0';
  } catch {
    // shown so then
  }
  $('#mvDiffers').checked = differs;
  modal.classList.remove('hidden');
  $('#mvnValuesBtn').setAttribute('aria-expanded', 'true');
  renderMvnValuesTable();
  const first = $('#mvAll input:checked') || $('#mvAll input');
  if (first) first.focus();
}

function closeMvnValues() {
  const modal = $('#mvnValuesModal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  $('#mvnValuesBtn').setAttribute('aria-expanded', 'false');
  $('#mvnValuesBtn').focus();
}

function chooseMvnValues(choice) {
  storeMvnValues(choice);
  renderMvnValuesBtn({ dir: mvnValuesDir, valueEnvs: mvnValueEnvs });
  renderMvnValuesTable();
}

// One variable's value from env: kept as a pick, unless it is the environment of all.
function pickMvnValue(key, env) {
  const choice = savedMvnValues();
  if (env === choice.base) delete choice.picks[key];
  else choice.picks[key] = env;
  storeMvnValues(choice);
  renderMvnValuesBtn({ dir: mvnValuesDir, valueEnvs: mvnValueEnvs });
  renderMvnValuesHead(choice);
}

function renderMvnValuesHead(choice) {
  const t = mvnValuesTable;
  const files = t.files.map((f) => f.file);
  const bad = t.files.filter((f) => f.error);
  $('#mvSub').textContent = `${mvnValuesDir ? `${mvnValuesDir}/` : ''}src/main/resources: ${files.join(', ')}${bad.length ? ` · not read: ${bad.map((f) => `${f.file} (${f.error})`).join(', ')}` : ''} · now ${mvnValuesSummary(choice)}`;
}

function renderMvnValuesTable() {
  const t = mvnValuesTable;
  if (!t) return;
  const choice = savedMvnValues();
  const envs = t.envs;
  renderMvnValuesHead(choice);
  // All from: one environment for every variable
  const all = $('#mvAll');
  all.innerHTML = '';
  for (const env of envs) {
    const label = document.createElement('label');
    label.className = 'mv-seg-item';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'mv-all';
    input.value = env;
    input.checked = choice.base === env;
    input.addEventListener('change', () => chooseMvnValues({ ...savedMvnValues(), base: env, picks: {} }));
    label.append(input, document.createTextNode(env));
    label.classList.toggle('on', input.checked);
    all.appendChild(label);
  }
  // the variables: those the same everywhere left out when asked
  const onlyDiffers = $('#mvDiffers').checked;
  const differs = (key) => new Set(envs.map((e) => JSON.stringify(mvCellOf(t, choice, key, e)?.value))).size > 1;
  const shown = t.keys.filter((k) => !onlyDiffers || differs(k));
  $('#mvDiffersText').textContent = `Only what differs (${t.keys.filter(differs).length} of ${t.keys.length})`;
  const table = $('#mvTable');
  table.innerHTML = '';
  const head = table.createTHead().insertRow();
  head.appendChild(document.createElement('th')).textContent = 'Variable';
  for (const env of envs) {
    const th = head.appendChild(document.createElement('th'));
    th.textContent = env;
    th.title = t.files.filter((f) => f.env === env).map((f) => f.file).join(', ') || `${env}: set inside another file`;
  }
  const body = table.createTBody();
  shown.forEach((key, i) => {
    const tr = body.insertRow();
    const name = tr.insertCell();
    name.className = 'mv-key';
    name.title = key;
    // the last part of the name stands out: catalog.environment.<region>
    const cut = key.lastIndexOf('.', key.endsWith(']') ? key.lastIndexOf('[') : key.length) + 1;
    name.append(Object.assign(document.createElement('span'), { className: 'mv-prefix', textContent: key.slice(0, cut) }), document.createTextNode(key.slice(cut)));
    for (const env of envs) fillMvnCell(tr.insertCell(), key, env, i, choice);
  });
  if (!shown.length) body.insertRow().insertCell().textContent = 'Every variable has the same value in every environment.';
}

// One cell: the value the variable takes from env (changed here, its own, the local one or none), a radio to take it,
// and ↺ when it was changed here.
function fillMvnCell(cell, key, env, i, choice) {
  const got = mvCellOf(mvnValuesTable, choice, key, env);
  const label = document.createElement('label');
  const warn = got && /\$\{[^}]+\}/.test(got.value);
  label.className = `mv-cell${!got ? ' none' : got.own ? '' : ' inherited'}${got && got.edited ? ' edited' : warn ? ' warn' : ''}`;
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = `mv-row-${i}`;
  input.value = env;
  input.checked = mvChosenEnv(choice, key) === env;
  input.setAttribute('aria-label', `${key} from ${env}: ${got ? got.value || '(empty)' : 'not set'}${got && got.edited ? ', changed here' : ''}. F2 to change it`);
  input.addEventListener('change', () => pickMvnValue(key, env));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'F2' && e.key !== 'Enter') return;
    e.preventDefault();
    editMvnCell(cell, key, env, i);
  });
  const text = document.createElement('span');
  text.textContent = got ? got.value || '(empty)' : 'not set';
  const file = got && got.edited ? got.file : got;
  const fileText = !file ? `Not set in ${env} nor in local` : `${file.value}${file.own ? '' : `\n${env} does not set it: the local value`}`;
  label.title = got && got.edited
    ? `${got.value}\nChanged here. The file: ${fileText}\nDouble-click to change it again`
    : `${fileText}${warn ? `\nNeeds ${got.value.match(/\$\{([^}:]+)/)[1]} in your environment` : ''}\nDouble-click to change it`;
  label.append(input, text);
  label.addEventListener('dblclick', (e) => {
    e.preventDefault();
    editMvnCell(cell, key, env, i);
  });
  const parts = [label];
  if (got && got.edited) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'mv-reset';
    reset.textContent = '↺';
    reset.title = "Back to the file's value";
    reset.setAttribute('aria-label', `Put back the file's value of ${key} in ${env}`);
    reset.addEventListener('click', () => {
      setMvnEdit(key, env, null);
      refillMvnCell(cell, key, env, i, true);
    });
    parts.push(reset);
  }
  cell.replaceChildren(...parts);
}

// A double-click (or F2) on a cell: its value in a field. Enter or leaving it keeps it, Esc does not.
function editMvnCell(cell, key, env, i) {
  const label = cell.querySelector('.mv-cell');
  if (!label || label.querySelector('.mv-edit')) return;
  const got = mvCellOf(mvnValuesTable, savedMvnValues(), key, env);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'input mv-edit';
  input.value = got ? got.value : '';
  input.maxLength = 4000;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', `The value of ${key} in ${env}`);
  label.classList.add('editing');
  label.querySelector('span').replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep, refocus) => {
    if (done) return;
    done = true;
    if (keep) setMvnEdit(key, env, input.value);
    refillMvnCell(cell, key, env, i, refocus);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false, true);
    }
  });
  input.addEventListener('blur', () => finish(true, false));
}

// A value changed here (null takes the change out). Back to what the file has is no change; a value set also takes that
// cell for the variable.
function setMvnEdit(key, env, value) {
  const choice = savedMvnValues();
  const file = mvValueOf(mvnValuesTable, key, env);
  const edits = { ...(choice.edits[key] || {}) };
  if (value === null || (file ? file.value === value : value === '')) delete edits[env];
  else edits[env] = value;
  if (Object.keys(edits).length) choice.edits[key] = edits;
  else delete choice.edits[key];
  if (value !== null) {
    if (env === choice.base) delete choice.picks[key];
    else choice.picks[key] = env;
  }
  storeMvnValues(choice);
}

// The cell drawn again after a change, with the button and the line above the table.
function refillMvnCell(cell, key, env, i, refocus) {
  const choice = savedMvnValues();
  fillMvnCell(cell, key, env, i, choice);
  renderMvnValuesBtn({ dir: mvnValuesDir, valueEnvs: mvnValueEnvs });
  renderMvnValuesHead(choice);
  if (refocus) cell.querySelector('.mv-cell input').focus();
}

function setupMvnValues() {
  $('#mvnValuesBtn').addEventListener('click', openMvnValues);
}
