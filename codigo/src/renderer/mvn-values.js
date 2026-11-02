// -- Values per environment for Start and Debug: the variables of the service's application*.properties / .yml, and
// for each one the environment whose value the application starts with. "All from" puts them all in one environment;
// a click on a value changes that one. Kept per repository and folder. The values that differ from local go to
// spring-boot:run as SPRING_APPLICATION_JSON, over the files (maven.js); a build or the tests never get them. --
const MVN_VALUES_KEY = 'mvnValues';
const MVN_VALUES_DIFFERS_KEY = 'mvnValuesDiffers';
let mvnValueEnvs = []; // the environments with a file in the folder the commands run in (from the info)
let mvnValuesDir = '';
let mvnValuesTable = null; // { files, envs, keys, values } as read when the dialog opened

const mvnValuesId = () => `${mvnRepo}|${mvnValuesDir}`;

// What is chosen: base, the environment of every variable; picks, the variables that take another one.
function savedMvnValues() {
  try {
    const v = (JSON.parse(localStorage.getItem(MVN_VALUES_KEY)) || {})[mvnValuesId()] || {};
    return { base: typeof v.base === 'string' ? v.base : 'local', picks: v.picks && typeof v.picks === 'object' ? v.picks : {} };
  } catch {
    return { base: 'local', picks: {} };
  }
}

function storeMvnValues(choice) {
  try {
    const all = JSON.parse(localStorage.getItem(MVN_VALUES_KEY)) || {};
    if (choice.base === 'local' && !Object.keys(choice.picks).length) delete all[mvnValuesId()];
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

// "dev · 2 from sit, 1 from prod": the environment of all, and how many come from another.
function mvnValuesSummary(choice) {
  const from = {};
  for (const env of Object.values(choice.picks)) if (env !== choice.base) from[env] = (from[env] || 0) + 1;
  const more = Object.entries(from).map(([env, n]) => `${n} from ${env}`).join(', ');
  return `${choice.base}${more ? ` · ${more}` : ''}`;
}

// What the application gets over its files: the values chosen that are not the local ones. null: nothing to add.
function mvnValuesPayload(table, choice) {
  const values = {};
  const from = {};
  for (const key of table.keys) {
    const env = mvChosenEnv(choice, key);
    if (env === 'local') continue;
    const got = mvValueOf(table, key, env);
    const local = (table.values[key] || {}).local;
    if (!got || (local !== undefined && got.value === local)) continue;
    values[key] = got.value;
    from[env] = (from[env] || 0) + 1;
  }
  const n = Object.keys(values).length;
  if (!n) return null;
  return { values, valuesNote: `${plural(n, 'value')} (${Object.entries(from).map(([env, c]) => `${c} from ${env}`).join(', ')})` };
}

// For a run: the values to send (read again from the files, which may have changed), or nothing.
async function mvnValuesRequest() {
  const choice = savedMvnValues();
  if (!mvnRepo || mvnValueEnvs.length < 2 || (choice.base === 'local' && !Object.keys(choice.picks).length)) return {};
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
  const changed = choice.base !== 'local' || Object.keys(choice.picks).length > 0;
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
      <p class="mv-legend">A click on a value takes it for that variable. In italics: the environment does not set it, so it keeps the local one. ⚠: the value needs a variable of your environment (set it before Start).</p>
      <div class="action-row settings-actions mv-actions">
        <label class="mv-differs"><input id="mvDiffers" type="checkbox" /> <span id="mvDiffersText">Only what differs</span></label>
        <span class="mv-gap"></span>
        <button id="mvLocalBtn" class="btn" type="button" title="Every variable with its local value (application.properties)">Back to local</button>
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
  $('#mvLocalBtn').addEventListener('click', () => chooseMvnValues({ base: 'local', picks: {} }));
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
    input.addEventListener('change', () => chooseMvnValues({ base: env, picks: {} }));
    label.append(input, document.createTextNode(env));
    label.classList.toggle('on', input.checked);
    all.appendChild(label);
  }
  // the variables: those the same everywhere left out when asked
  const onlyDiffers = $('#mvDiffers').checked;
  const differs = (key) => new Set(envs.map((e) => JSON.stringify(mvValueOf(t, key, e)?.value))).size > 1;
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
    for (const env of envs) {
      const got = mvValueOf(t, key, env);
      const cell = tr.insertCell();
      const label = document.createElement('label');
      const warn = got && /\$\{[^}]+\}/.test(got.value);
      label.className = `mv-cell${!got ? ' none' : got.own ? '' : ' inherited'}${warn ? ' warn' : ''}`;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `mv-row-${i}`;
      input.value = env;
      input.checked = mvChosenEnv(choice, key) === env;
      input.setAttribute('aria-label', `${key} from ${env}: ${got ? got.value || '(empty)' : 'not set'}`);
      input.addEventListener('change', () => pickMvnValue(key, env));
      const text = document.createElement('span');
      text.textContent = got ? got.value || '(empty)' : 'not set';
      label.title = !got
        ? `Not set in ${env} nor in local`
        : `${got.value}${got.own ? '' : `\n${env} does not set it: the local value`}${warn ? `\nNeeds ${got.value.match(/\$\{([^}:]+)/)[1]} in your environment` : ''}`;
      label.append(input, text);
      cell.appendChild(label);
    }
  });
  if (!shown.length) body.insertRow().insertCell().textContent = 'Every variable has the same value in every environment.';
}

function setupMvnValues() {
  $('#mvnValuesBtn').addEventListener('click', openMvnValues);
}
