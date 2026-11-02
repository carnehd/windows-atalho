// -- Env for Start and Debug, like a run configuration in IntelliJ: the Spring profiles to turn on and environment
// variables, NAME=value one per line (IntelliJ's NAME=value;NAME2=value2 is split as it is pasted), or taken from the
// run configurations IntelliJ keeps in the repository. Saved per repository in the app's data (maven.js gives them to
// spring-boot:run only; the output names the variables, never their values). --
let mvnRunEnv = { profiles: '', vars: [] };
let mvnEnvConfigs = []; // IntelliJ's, read when the dialog opens
let mvnEnvFolders = []; // the folders of the repository with a pom.xml (from the info), for IntelliJ's module

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// "Env: profile sit, 2 variables"
function mvnEnvSummary(r) {
  const parts = [r.profiles && `profile ${r.profiles}`, r.vars.length && plural(r.vars.length, 'variable')].filter(Boolean);
  return parts.join(', ');
}

function renderMvnEnvBtn(info) {
  mvnRunEnv = info.runEnv || { profiles: '', vars: [] };
  if (info.folders) mvnEnvFolders = info.folders;
  const btn = $('#mvnEnvBtn');
  const summary = mvnEnvSummary(mvnRunEnv);
  btn.classList.toggle('on', Boolean(summary));
  $('#mvnEnvLabel').textContent = summary ? `Env: ${summary}` : 'Env';
  btn.title = summary
    ? `Start and Debug start the application with ${summary}${mvnRunEnv.vars.length ? `: ${mvnRunEnv.vars.map((v) => v.name).join(', ')}` : ''}`
    : 'Spring profiles and environment variables for Start and Debug, like a run configuration in IntelliJ';
}

// A value as a line shows it: in quotes when they would otherwise be lost (spaces at the ends, quotes around it).
const envLineValue = (v) => (v !== v.trim() || /^(["']).*\1$/s.test(v) ? `"${v}"` : v);
const envText = (vars) => vars.map((v) => `${v.name}=${envLineValue(v.value)}`).join('\n');

// The lines of the box: NAME=value (export NAME=value and quoted values as a .env file has them too), # for a comment.
function parseMvnEnvText(text) {
  const vars = [];
  const errors = [];
  const at = new Map();
  String(text).split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const body = line.replace(/^export\s+/, '');
    const eq = body.indexOf('=');
    const name = eq > 0 ? body.slice(0, eq).trim() : '';
    if (!name) return errors.push(`Line ${i + 1}: write it as NAME=value`);
    if (!ENV_NAME.test(name)) return errors.push(`Line ${i + 1}: "${name.slice(0, 40)}" is not a variable name (a letter or _ first, then letters, digits, _ . -)`);
    const key = window.git.platform === 'win32' ? name.toUpperCase() : name;
    if (at.has(key)) return errors.push(`Line ${i + 1}: ${name} is already on line ${at.get(key)}`);
    at.set(key, i + 1);
    let value = body.slice(eq + 1).trim();
    const q = /^(["'])([\s\S]*)\1$/.exec(value);
    if (q) value = q[2];
    vars.push({ name, value });
  });
  return { vars, errors };
}

// IntelliJ's line: NAME=value;NAME2=value2, a ; inside a value written \;
function splitIntellijEnv(text) {
  const t = String(text).trim();
  if (t.includes('\n') || !t.includes(';') || !/^[A-Za-z_][\w.-]*=/.test(t)) return null;
  return t.split(/(?<!\\);/).map((p) => p.replace(/\\;/g, ';').trim()).filter(Boolean);
}

function mvnEnvModal() {
  let modal = $('#mvnEnvModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'mvnEnvModal';
  modal.className = 'settings-overlay hidden';
  modal.innerHTML = `
    <div class="settings-card me-card" role="dialog" aria-modal="true" aria-labelledby="meTitle">
      <h3 id="meTitle">Start and Debug: profiles and environment</h3>
      <p id="meSub" class="mv-sub">Like a run configuration in IntelliJ. Saved for this microservice: Start, Debug and spring-boot:run start with them; a build and the tests do not.</p>
      <label class="settings-label" for="meProfiles">Active profiles</label>
      <div class="me-profiles-row">
        <input id="meProfiles" class="input me-profiles" maxlength="300" placeholder="e.g. sit" autocomplete="off" spellcheck="false" aria-describedby="meProfilesHint" />
        <span id="meChips" class="me-chips" role="group" aria-label="Profiles of the application files"></span>
      </div>
      <p id="meProfilesHint" class="me-hint">Given as SPRING_PROFILES_ACTIVE: Spring reads application-&lt;profile&gt; over application. Several with commas.</p>
      <div class="me-vars-head">
        <label class="settings-label" for="meVars">Environment variables</label>
        <span class="mv-gap"></span>
        <button id="meIntellij" class="btn btn-sm hidden" type="button" aria-haspopup="menu">From IntelliJ</button>
      </div>
      <textarea id="meVars" class="input me-vars" spellcheck="false" autocomplete="off" wrap="off" aria-describedby="meNote" placeholder="NAME=value, one per line&#10;IntelliJ's NAME=value;NAME2=value2 is split when pasted&#10;# a line with # first is left out"></textarea>
      <p id="meNote" class="me-note" aria-live="polite"></p>
      <div class="action-row settings-actions mv-actions">
        <button id="meClear" class="btn" type="button" title="Empty both fields (Save to keep it so)">Clear</button>
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
    }
  });
  $('#meCancel').addEventListener('click', closeMvnEnv);
  $('#meSave').addEventListener('click', saveMvnEnv);
  $('#meClear').addEventListener('click', () => {
    $('#meProfiles').value = '';
    $('#meVars').value = '';
    renderMvnEnvChips();
    renderMvnEnvNote();
    $('#meProfiles').focus();
  });
  $('#meProfiles').addEventListener('input', renderMvnEnvChips);
  $('#meVars').addEventListener('input', () => renderMvnEnvNote());
  $('#meVars').addEventListener('paste', (e) => {
    const parts = splitIntellijEnv(e.clipboardData.getData('text/plain'));
    if (!parts) return;
    e.preventDefault();
    const box = e.target;
    // on a line of its own, whatever is around it
    const before = box.value.slice(0, box.selectionStart);
    const text = `${before && !before.endsWith('\n') ? '\n' : ''}${parts.join('\n')}`;
    document.execCommand('insertText', false, text);
    renderMvnEnvNote(`Pasted as ${plural(parts.length, 'line')}, one variable each.`);
  });
  $('#meIntellij').addEventListener('click', openMvnEnvIntellij);
  return modal;
}

// The profiles of the application files (application-<profile>), to turn on and off with a click.
function renderMvnEnvChips() {
  const box = $('#meChips');
  const on = new Set($('#meProfiles').value.split(/[\s,]+/).filter(Boolean));
  box.replaceChildren(
    ...mvnValueEnvs.filter((e) => e !== 'local').map((env) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `me-chip${on.has(env) ? ' on' : ''}`;
      chip.textContent = env;
      chip.setAttribute('aria-pressed', String(on.has(env)));
      chip.title = on.has(env) ? `Take ${env} off` : `Turn on ${env} (application-${env})`;
      chip.addEventListener('click', () => {
        const list = $('#meProfiles').value.split(/[\s,]+/).filter(Boolean);
        $('#meProfiles').value = (on.has(env) ? list.filter((p) => p !== env) : [...list, env]).join(',');
        renderMvnEnvChips();
      });
      return chip;
    })
  );
}

// Under the box: how many variables, the first line that is wrong, or what was just done.
function renderMvnEnvNote(done = '') {
  const { vars, errors } = parseMvnEnvText($('#meVars').value);
  const note = $('#meNote');
  note.classList.toggle('error', errors.length > 0);
  note.textContent = errors.length ? errors[0] + (errors.length > 1 ? ` (and ${errors.length - 1} more)` : '') : `${done ? `${done} ` : ''}${vars.length ? plural(vars.length, 'variable') : 'No variables'}`;
}

async function openMvnEnv() {
  if (!mvnRepo) return;
  const repo = mvnRepo;
  const modal = mvnEnvModal();
  $('#meProfiles').value = mvnRunEnv.profiles;
  $('#meVars').value = envText(mvnRunEnv.vars);
  $('#meIntellij').classList.add('hidden');
  renderMvnEnvChips();
  renderMvnEnvNote();
  modal.classList.remove('hidden');
  $('#mvnEnvBtn').setAttribute('aria-expanded', 'true');
  $('#meProfiles').focus();
  const r = await window.maven.intellijConfigs(repo);
  if (repo !== mvnRepo || modal.classList.contains('hidden')) return;
  mvnEnvConfigs = (r && r.configs) || [];
  const btn = $('#meIntellij');
  btn.classList.toggle('hidden', !mvnEnvConfigs.length);
  btn.textContent = `From IntelliJ (${mvnEnvConfigs.length})`;
  btn.title = `The run configurations of this project in IntelliJ with profiles or variables: ${mvnEnvConfigs.map((c) => c.name).join(', ')}`;
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

// Into the fields, in place of what they had: Save keeps it.
function takeMvnEnvConfig(c) {
  $('#meProfiles').value = c.profiles;
  $('#meVars').value = envText(c.vars);
  renderMvnEnvChips();
  // IntelliJ's module is a folder of the repository other than the one Maven runs in
  const moduleDir = c.module ? mvnEnvFolders.find((f) => f && f.split('/').pop() === c.module) : undefined;
  const more = [
    c.skipped.length && `Left out: ${c.skipped.join(', ')} (a value on several lines, or a name a shell does not take).`,
    moduleDir !== undefined && moduleDir !== mvnValuesDir && `IntelliJ runs it in the module ${c.module}: choose ${moduleDir}/ in Runs in.`,
  ].filter(Boolean);
  renderMvnEnvNote(`Taken from ${c.name}: Save to keep it.${more.length ? ` ${more.join(' ')}` : ''}`);
  $('#meVars').focus();
}

async function saveMvnEnv() {
  if (!mvnRepo) return;
  const repo = mvnRepo;
  const { vars, errors } = parseMvnEnvText($('#meVars').value);
  if (errors.length) {
    renderMvnEnvNote();
    $('#meVars').focus();
    return;
  }
  const r = await window.maven.setRunEnv(repo, { profiles: $('#meProfiles').value, vars });
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
  toast(summary ? `Start and Debug: ${summary}` : 'Start and Debug: no profiles nor variables', 'success', { plain: true });
}

function setupMvnEnv() {
  $('#mvnEnvBtn').addEventListener('click', openMvnEnv);
}
