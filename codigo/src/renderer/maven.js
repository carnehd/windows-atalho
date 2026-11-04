// Maven tab inside the Git view. Relies on helpers from app.js ($, $$, toast, currentRepo, ACTION_ICONS).
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const MAX_OUTPUT_CHARS = 400000;
let mvnRepo = null;
let mvnRun = null;
let mvnTimer = null;
let mvnPortsView = null;
const MVN_CHOICE_KEY = 'mvnCommand';

const mvnChoice = () => $('#mvnCommand').value;

// -- Macros: several commands under a name, for every repository, run one after the other (chosen in the same list) --
let mvnMacros = [];
let mvnLastChoice = 'clean-install';
const macroOf = (value) => (String(value || '').startsWith('macro:') ? mvnMacros.find((m) => `macro:${m.id}` === value) || null : null);
const chosenMacro = () => macroOf(mvnChoice());

// What to do with local changes, as a Local changes step is set (ask: chosen each time the macro runs).
const CHANGES_CHOICES = [
  ['ask', 'Ask what to do when it runs'],
  ['stash', 'Stash them'],
  ['discard', 'Discard them'],
  ['stop', 'Stop the macro'],
];
const MACRO_GIT_KINDS = new Set(['changes', 'fetch', 'checkout', 'branch', 'pull', 'unstash']);

// What a step runs, as the bar shows it (Start and Debug with this repository's ports).
function macroStepText(step) {
  if (step.kind === 'stop') return 'Stop what is running';
  if (step.kind === 'custom') return `mvn ${step.goals}`;
  if (step.kind === 'changes') return `Local changes: ${(CHANGES_CHOICES.find(([v]) => v === step.policy) || CHANGES_CHOICES[0])[1].toLowerCase()}`;
  if (step.kind === 'fetch') return 'git fetch --all --prune --tags';
  if (step.kind === 'checkout') return `git checkout ${step.branch}`;
  if (step.kind === 'branch') return `New branch from origin/${step.base} (its name is asked when it runs)`;
  if (step.kind === 'pull') return step.from ? `git pull origin ${step.from}` : 'git pull';
  if (step.kind === 'unstash') return 'Bring back the stashed changes (git stash pop)';
  const base = (mvnPortsView && mvnPortsView.commands && mvnPortsView.commands[step.preset]) || `mvn ${step.preset}`;
  return step.extra ? `${base} ${step.extra}` : base;
}

function renderMacroOptions() {
  const group = $('#mvnMacroGroup');
  const select = $('#mvnCommand');
  const keep = select.value;
  group.replaceChildren(
    ...mvnMacros.map((m) => {
      const o = new Option(m.name, `macro:${m.id}`);
      o.title = m.steps.map(macroStepText).join('\n');
      return o;
    }),
    new Option('New macro...', 'new-macro')
  );
  if ([...select.options].some((o) => o.value === keep) && keep !== 'new-macro') select.value = keep;
  else if (keep.startsWith('macro:')) select.value = 'clean-install';
}

async function loadMvnMacros() {
  const r = await window.maven.macros();
  mvnMacros = Array.isArray(r.macros) ? r.macros : [];
  renderMacroOptions();
}

// -- My commands: Maven goals saved under a name, for every repository (Save next to Custom command...). Chosen in the
// same list and run as a custom command is, the options added; Edit and Delete next to the one chosen. --
let mvnSaved = [];
const savedOf = (value) => (String(value || '').startsWith('cmd:') ? mvnSaved.find((c) => `cmd:${c.id}` === value) || null : null);
const chosenSaved = () => savedOf(mvnChoice());

function renderSavedOptions() {
  const select = $('#mvnCommand');
  const keep = select.value;
  $('#mvnSavedGroup').replaceChildren(
    ...mvnSaved.map((c) => {
      const o = new Option(c.name, `cmd:${c.id}`);
      o.title = `mvn ${c.goals}`;
      return o;
    })
  );
  if ([...select.options].some((o) => o.value === keep)) select.value = keep;
}

async function loadMvnSaved() {
  const r = await window.maven.commands();
  mvnSaved = Array.isArray(r.commands) ? r.commands : [];
  renderSavedOptions();
}

let mvnSaveEditing = null; // the saved command changed in the dialog, or null for a new one
let mvnSaveFrom = null; // the button that opened it
function mvnSaveModal() {
  let modal = $('#mvnSaveModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'mvnSaveModal';
  modal.className = 'settings-overlay hidden';
  modal.innerHTML = `
    <div class="settings-card mvn-save-card" role="dialog" aria-modal="true" aria-labelledby="mvnSaveTitle">
      <h3 id="mvnSaveTitle"></h3>
      <label class="settings-label" for="mvnSaveName">Name in the list</label>
      <input id="mvnSaveName" class="input" maxlength="60" autocomplete="off" spellcheck="false" />
      <label class="settings-label" for="mvnSaveGoals">Goals</label>
      <input id="mvnSaveGoals" class="input mvn-save-goals" maxlength="400" placeholder="clean verify -Pdev" autocomplete="off" spellcheck="false" />
      <p id="mvnSaveNote" class="me-note" aria-live="polite"></p>
      <div class="action-row settings-actions mv-actions">
        <button id="mvnSaveDelete" class="btn btn-danger mvn-save-delete hidden" type="button">Delete</button>
        <span class="mv-gap"></span>
        <button id="mvnSaveCancel" class="btn" type="button">Cancel</button>
        <button id="mvnSaveOk" class="btn btn-primary" type="button">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeSaveCommand();
    } else if (e.key === 'Enter' && e.target.matches('input')) {
      e.preventDefault();
      saveMvnCommand();
    }
  });
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) closeSaveCommand();
  });
  // an empty name shows the goals in the list
  $('#mvnSaveGoals').addEventListener('input', () => ($('#mvnSaveName').placeholder = $('#mvnSaveGoals').value.trim() || 'Integration tests'));
  $('#mvnSaveCancel').addEventListener('click', closeSaveCommand);
  $('#mvnSaveOk').addEventListener('click', saveMvnCommand);
  $('#mvnSaveDelete').addEventListener('click', async () => {
    const command = mvnSaveEditing;
    if (command && (await deleteSavedCommand(command))) closeSaveCommand();
  });
  return modal;
}

// command: a saved one to change; or null, with the goals typed in Custom command...
function openSaveCommand(command, goals = '') {
  const modal = mvnSaveModal();
  mvnSaveEditing = command;
  mvnSaveFrom = document.activeElement;
  $('#mvnSaveTitle').textContent = command ? `Change ${command.name}` : 'Save this command';
  $('#mvnSaveName').value = command && command.name !== command.goals ? command.name : '';
  $('#mvnSaveGoals').value = command ? command.goals : goals;
  $('#mvnSaveName').placeholder = $('#mvnSaveGoals').value.trim() || 'Integration tests';
  const note = $('#mvnSaveNote');
  note.classList.remove('error');
  note.textContent = 'For every microservice. Empty, the name is the goals; + option still adds flags and profiles when it runs.';
  $('#mvnSaveDelete').classList.toggle('hidden', !command);
  modal.classList.remove('hidden');
  $('#mvnSaveName').focus();
}

function closeSaveCommand() {
  const modal = $('#mvnSaveModal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  mvnSaveEditing = null;
  if (mvnSaveFrom && mvnSaveFrom.isConnected && !mvnSaveFrom.closest('.hidden')) mvnSaveFrom.focus();
  else $('#mvnCommand').focus();
}

async function saveMvnCommand() {
  const editing = mvnSaveEditing;
  const r = await window.maven.saveCommand({ id: editing ? editing.id : undefined, name: $('#mvnSaveName').value, goals: $('#mvnSaveGoals').value });
  if (r.error) {
    const note = $('#mvnSaveNote');
    note.classList.add('error');
    note.textContent = r.error;
    return;
  }
  mvnSaved = r.commands;
  renderSavedOptions();
  const saved = mvnSaved.find((c) => c.id === r.id);
  closeSaveCommand();
  chooseMvnCommand(`cmd:${r.id}`);
  toast(`${editing ? 'Changed' : 'Saved in My commands'}: ${saved ? saved.name : ''}`, 'success', { plain: true });
}

// Out of the list, once confirmed; the one chosen goes back to Custom command..., its goals in the field.
async function deleteSavedCommand(command) {
  if (!(await askConfirm(`Delete ${command.name}? It goes out of My commands, for every microservice.`))) return false;
  const r = await window.maven.deleteCommand(command.id);
  const was = mvnChoice() === `cmd:${command.id}`;
  mvnSaved = Array.isArray(r.commands) ? r.commands : mvnSaved.filter((c) => c.id !== command.id);
  renderSavedOptions();
  if (was) {
    $('#mvnCustom').value = command.goals;
    chooseMvnCommand('custom');
  }
  toast(`Deleted from My commands: ${command.name}`, 'success', { plain: true });
  return true;
}

// -- Options under the command: flags and pom.xml profiles added to whatever runs, remembered per repository --
const MVN_OPTIONS_KEY = 'mvnOptions';
let mvnOptionList = []; // [{ id, flag, label }] the app accepts
let mvnProfiles = []; // profile ids in this repository's pom.xml

function savedMvnOptions(repo) {
  try {
    const v = (JSON.parse(localStorage.getItem(MVN_OPTIONS_KEY)) || {})[repo] || {};
    return { options: Array.isArray(v.options) ? v.options : [], profiles: Array.isArray(v.profiles) ? v.profiles : [] };
  } catch {
    return { options: [], profiles: [] };
  }
}

function storeMvnOptions(repo, value) {
  try {
    const all = JSON.parse(localStorage.getItem(MVN_OPTIONS_KEY)) || {};
    all[repo] = value;
    localStorage.setItem(MVN_OPTIONS_KEY, JSON.stringify(all));
  } catch {
    // not remembered, but they still apply until the app closes
  }
}

// What is chosen and still exists (a profile taken out of the pom.xml drops out).
function chosenMvnOptions() {
  const saved = savedMvnOptions(mvnRepo);
  return {
    options: saved.options.filter((id) => mvnOptionList.some((o) => o.id === id)),
    profiles: saved.profiles.filter((p) => mvnProfiles.includes(p)),
  };
}

// The flags as the command gets them: one the command already has is not repeated (the app does the same).
function mvnOptionFlags(baseArgs = []) {
  const { options, profiles } = chosenMvnOptions();
  const flags = mvnOptionList.filter((o) => options.includes(o.id) && !baseArgs.includes(o.flag.split(' ')[0])).map((o) => o.flag);
  if (profiles.length) flags.push(`-P${profiles.join(',')}`);
  return flags;
}

function removeMvnOption(kind, id) {
  const current = chosenMvnOptions();
  storeMvnOptions(mvnRepo, { ...current, [kind]: current[kind].filter((x) => x !== id) });
  renderMvnPreview();
}

// One tag per chosen flag or profile, each with its own ×. A flag the command already has is struck through: Maven
// gets it once.
function renderMvnTags(baseArgs) {
  const busy = Boolean(mvnRun && mvnRun.running);
  const { options, profiles } = chosenMvnOptions();
  const tags = [
    ...mvnOptionList.filter((o) => options.includes(o.id)).map((o) => ({ kind: 'options', id: o.id, flag: o.flag, hint: o.label })),
    ...profiles.map((p) => ({ kind: 'profiles', id: p, flag: `-P${p}`, hint: `Turn on the ${p} profile` })),
  ];
  $('#mvnTags').replaceChildren(
    ...tags.map((t, i) => {
      const dup = t.kind === 'options' && baseArgs.includes(t.flag.split(' ')[0]);
      const tag = document.createElement('span');
      tag.className = `mvn-tag${dup ? ' dup' : ''}`;
      tag.title = dup ? `${t.flag} is already in the command` : t.hint;
      const code = document.createElement('code');
      code.textContent = t.flag;
      const x = document.createElement('button');
      x.type = 'button';
      x.disabled = busy;
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove ${t.flag}`);
      x.addEventListener('click', () => {
        removeMvnOption(t.kind, t.id);
        const left = [...$$('#mvnTags button')];
        (left[Math.min(i, left.length - 1)] || $('#mvnOptionsBtn')).focus();
      });
      tag.append(code, x);
      return tag;
    }),
  );
}

function closeMvnOptions() {
  const box = $('#mvnOptionsMenu');
  if (box) {
    document.removeEventListener('mousedown', box.onOutside, true);
    box.remove();
  }
  $('#mvnOptionsBtn').setAttribute('aria-expanded', 'false');
}

// Under "+ option", which moves along as tags come and go.
function placeMvnOptions(box) {
  const a = $('#mvnOptionsBtn').getBoundingClientRect();
  const m = box.getBoundingClientRect();
  box.style.left = `${Math.round(Math.max(8, Math.min(a.left, window.innerWidth - m.width - 8)))}px`;
  box.style.top = `${Math.round(a.bottom + 4 + m.height > window.innerHeight - 8 ? Math.max(8, a.top - 4 - m.height) : a.bottom + 4)}px`;
}

function openMvnOptions() {
  if ($('#mvnOptionsMenu')) {
    closeMvnOptions();
    return;
  }
  const btn = $('#mvnOptionsBtn');
  const box = document.createElement('div');
  box.id = 'mvnOptionsMenu';
  box.className = 'clip-menu mvn-options-menu';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Maven options');
  const update = (kind, id, on) => {
    const current = chosenMvnOptions();
    const set = new Set(current[kind]);
    if (on) set.add(id);
    else set.delete(id);
    storeMvnOptions(mvnRepo, { ...current, [kind]: [...set] });
    renderMvnPreview();
    placeMvnOptions(box);
  };
  const row = (checked, flag, text, onChange) => {
    const label = document.createElement('label');
    label.className = 'mvn-opt';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const code = document.createElement('code');
    code.className = 'mvn-opt-flag';
    code.textContent = flag;
    const span = document.createElement('span');
    span.className = 'mvn-opt-label';
    span.textContent = text;
    label.append(input, code, span);
    return label;
  };
  const title = (text) => {
    const t = document.createElement('div');
    t.className = 'mvn-opt-title';
    t.textContent = text;
    return t;
  };
  const { options, profiles } = chosenMvnOptions();
  box.appendChild(title('Options'));
  for (const o of mvnOptionList) box.appendChild(row(options.includes(o.id), o.flag, o.label, (on) => update('options', o.id, on)));
  box.appendChild(title('Profiles in pom.xml'));
  if (mvnProfiles.length === 0) {
    const note = document.createElement('div');
    note.className = 'mvn-opt-note';
    note.textContent = 'This pom.xml has no profiles.';
    box.appendChild(note);
  }
  for (const p of mvnProfiles) box.appendChild(row(profiles.includes(p), `-P ${p}`, `Turn on the ${p} profile`, (on) => update('profiles', p, on)));
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMvnOptions();
      btn.focus();
    }
  });
  box.onOutside = (e) => {
    if (!box.contains(e.target) && !btn.contains(e.target)) closeMvnOptions();
  };
  document.addEventListener('mousedown', box.onOutside, true);
  document.body.appendChild(box);
  placeMvnOptions(box);
  btn.setAttribute('aria-expanded', 'true');
  const first = box.querySelector('input');
  if (first) first.focus();
}

// What Run starts before the options: the chosen command, or "mvn" and the goals typed for a custom one.
function mvnBaseCommand() {
  const saved = chosenSaved();
  if (saved) return `mvn ${saved.goals}`;
  if (mvnChoice() === 'custom') {
    const goals = $('#mvnCustom').value.trim().replace(/^mvn(w)?(\.cmd)?\s+/i, '');
    return goals ? `mvn ${goals}` : '';
  }
  return (mvnPortsView && mvnPortsView.commands && mvnPortsView.commands[mvnChoice()]) || '';
}

// The command list is as wide as the chosen command, so the tags follow it as on a command line.
let mvnMeasure = null;
function fitMvnCommand() {
  const select = $('#mvnCommand');
  const option = select.selectedOptions[0];
  const cs = getComputedStyle(select);
  mvnMeasure = mvnMeasure || document.createElement('canvas').getContext('2d');
  mvnMeasure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const room = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((n, k) => n + (parseFloat(cs[k]) || 0), 0);
  select.style.width = `${Math.ceil(mvnMeasure.measureText(option ? option.textContent : '').width + room)}px`;
}

// The bar reads as the command Run starts: mvn, the command, then the options. Its tooltip has the whole line (Start
// and Debug add the port arguments). "Custom command..." shows a field for the goals in the bar.
function renderMvnPreview() {
  $('#mvnCustom').classList.toggle('hidden', mvnChoice() !== 'custom');
  // Save next to the goals typed; a saved command chosen: its goals (unless they are its name), Edit and Delete
  const saved = chosenSaved();
  $('#mvnCustomSave').classList.toggle('hidden', mvnChoice() !== 'custom');
  $('#mvnCustomSave').disabled = Boolean(mvnRun && mvnRun.running) || !$('#mvnCustom').value.trim();
  $('#mvnSavedInfo').classList.toggle('hidden', !saved || saved.name === saved.goals);
  $('#mvnSavedInfo').textContent = saved ? saved.goals : '';
  ['#mvnSavedEdit', '#mvnSavedDelete'].forEach((sel) => $(sel).classList.toggle('hidden', !saved));
  fitMvnCommand();
  const macro = chosenMacro();
  const container = mvnChoice() === 'container';
  // a macro's steps carry their own flags, and a container runs the jar: the options do not apply to them, nor does a
  // separate window
  ['#mvnTags', '#mvnOptionsBtn'].forEach((sel) => $(sel).classList.toggle('hidden', Boolean(macro) || container));
  $('#mvnMacroInfo').classList.toggle('hidden', !macro && !container);
  $('#mvnCmdline .mvn-prefix').textContent = macro ? 'macro' : 'mvn';
  $('#mvnCmdline .mvn-prefix').classList.toggle('hidden', container);
  $('#mvnMacroEditBtn').classList.toggle('hidden', !macro);
  $('#mvnExternal').disabled = Boolean(macro) || container;
  $('#mvnExternal').closest('label').title = macro ? 'Macros run here, in the app' : container ? 'A container runs here, in the app' : 'Opens a separate window (PowerShell on Windows, Terminal on Mac) instead of showing the output here';
  if (container) {
    const summary = mvnContainerSummary(mvnContainerSpec);
    $('#mvnMacroInfo').textContent = summary;
    $('#mvnMacroInfo').title = 'Run opens a dialog with the image, the port and the variables of the container';
    const bar = $('#mvnCmdline');
    bar.dataset.command = `Start in container${summary ? `: ${summary}` : ''}`;
    bar.title = bar.dataset.command;
    updateMvnRunButton();
    return;
  }
  if (macro) {
    $('#mvnMacroInfo').textContent = `${macro.steps.length} step${macro.steps.length === 1 ? '' : 's'}`;
    const lines = macro.steps.map((st, i) => `${i + 1}. ${macroStepText(st)}`);
    $('#mvnMacroInfo').title = lines.join('\n');
    const bar = $('#mvnCmdline');
    bar.dataset.command = `macro ${macro.name}`;
    bar.title = lines.join('\n');
    updateMvnRunButton();
    return;
  }
  const base = mvnBaseCommand();
  const baseArgs = base.split(/\s+/);
  renderMvnTags(baseArgs);
  const bar = $('#mvnCmdline');
  bar.dataset.command = base ? [base, ...mvnOptionFlags(baseArgs)].join(' ') : '';
  bar.title = bar.dataset.command || 'Type the goals to run, e.g. clean verify -Pdev';
  updateMvnRunButton();
}

// Run, or Stop while something runs here. A macro that begins by stopping what runs (to build and start the app
// again) can still start then, from "Run macro" next to it.
let mvnStopping = false;
function updateMvnRunButton() {
  const running = Boolean(mvnRun && mvnRun.running);
  const macro = chosenMacro();
  const restarts = Boolean(macro && macro.steps.some((st) => st.kind === 'stop'));
  const btn = $('#mvnRunBtn');
  btn.classList.toggle('stop', running);
  btn.classList.toggle('btn-primary', !running);
  $('#mvnRunIcon').innerHTML = running ? '<rect x="6" y="6" width="12" height="12" rx="1.5"/>' : '<path d="M7 4v16l13-8z"/>';
  $('#mvnRunLabel').textContent = !running ? 'Run' : mvnStopping ? 'Stopping...' : 'Stop';
  btn.disabled = running && mvnStopping;
  btn.title = running ? `Stop ${mvnRun.command}` : '';
  const again = $('#mvnRestartBtn');
  again.classList.toggle('hidden', !(running && restarts));
  again.title = running && restarts ? `Runs ${macro.name}: its Stop step ends what is running` : '';
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function setMvnOutput(text) {
  const out = $('#mvnOutput');
  const clean = text.replace(ANSI, '');
  out.textContent = clean;
  out.scrollTop = out.scrollHeight;
  // the modules are read again from the whole output (no times for what was already building)
  resetMvnModules();
  feedMvnModules(clean, false);
  renderMvnModules();
  mvnFindLater();
}

function appendMvnOutput(text) {
  const out = $('#mvnOutput');
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  const clean = text.replace(ANSI, '');
  out.textContent = (out.textContent + clean).slice(-MAX_OUTPUT_CHARS);
  if (atBottom) out.scrollTop = out.scrollHeight;
  if (feedMvnModules(clean, true)) renderMvnModules();
  mvnFindLater();
}

// -- Search in the output: every match marked (CSS highlights, so the text itself is not touched), the one on show
// brighter and scrolled to. It starts on the last one (the newest output); Enter and Shift+Enter go to the next and the
// previous, round; Esc empties it. The marks follow the output as it comes, without moving it. --
const MVN_FIND_MAX = 5000;
let mvnFind = { q: '', hits: [], at: -1 };
let mvnFindTimer = 0;

function mvnFindLater() {
  if (!mvnFind.q && !$('#mvnFind').value) return;
  clearTimeout(mvnFindTimer);
  mvnFindTimer = setTimeout(() => mvnFindRun(), 150);
}

// fresh: a new search (it goes to the last match); else the same one again over the output as it is now
function mvnFindRun({ fresh = false } = {}) {
  clearTimeout(mvnFindTimer);
  const q = $('#mvnFind').value;
  const node = $('#mvnOutput').firstChild;
  const text = node ? node.data.toLowerCase() : '';
  const hits = [];
  if (q) {
    const word = q.toLowerCase();
    for (let i = text.indexOf(word); i !== -1 && hits.length < MVN_FIND_MAX; i = text.indexOf(word, i + word.length)) hits.push(i);
  }
  let at = -1;
  if (hits.length) at = fresh || mvnFind.q !== q || mvnFind.at < 0 ? hits.length - 1 : Math.min(mvnFind.at, hits.length - 1);
  mvnFind = { q, hits, at };
  mvnFindPaint(fresh);
}

function mvnFindPaint(scroll) {
  const { q, hits, at } = mvnFind;
  const count = $('#mvnFindCount');
  count.textContent = !q ? '' : !hits.length ? 'No matches' : `${at + 1} of ${hits.length}${hits.length >= MVN_FIND_MAX ? '+' : ''}`;
  count.classList.toggle('none', Boolean(q) && !hits.length);
  $('#mvnFindPrev').disabled = hits.length < 2;
  $('#mvnFindNext').disabled = hits.length < 2;
  if (!window.CSS || !CSS.highlights) return;
  const out = $('#mvnOutput');
  const node = out.firstChild;
  const others = [];
  let current = null;
  if (node && q) {
    hits.forEach((i, k) => {
      const r = new Range();
      r.setStart(node, i);
      r.setEnd(node, Math.min(node.length, i + q.length));
      if (k === at) current = r;
      else others.push(r);
    });
  }
  CSS.highlights.set('mvn-find', new Highlight(...others));
  CSS.highlights.set('mvn-find-current', new Highlight(...(current ? [current] : [])));
  if (scroll && current) {
    const top = current.getBoundingClientRect().top - out.getBoundingClientRect().top;
    out.scrollTop += top - out.clientHeight / 2;
  }
}

function mvnFindStep(d) {
  if (!mvnFind.hits.length) return;
  mvnFind.at = (mvnFind.at + d + mvnFind.hits.length) % mvnFind.hits.length;
  mvnFindPaint(true);
}

function setupMvnFind() {
  const input = $('#mvnFind');
  input.addEventListener('input', () => mvnFindRun({ fresh: true }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // a search typed but not run yet (the output was busy): run it first
      if (mvnFind.q !== input.value) mvnFindRun({ fresh: true });
      else mvnFindStep(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      mvnFindRun({ fresh: true });
    }
  });
  $('#mvnFindPrev').addEventListener('click', () => mvnFindStep(-1));
  $('#mvnFindNext').addEventListener('click', () => mvnFindStep(1));
  // Ctrl+F (Cmd+F) on the Maven page, with no popup over it
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
    if (currentMode !== 'git' || effectiveGitView() !== 'maven' || $('#mvnPanel').classList.contains('hidden')) return;
    if (document.querySelector('.settings-overlay:not(.hidden)')) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
}

// -- The modules of a multi-module build, read from Maven's output as it comes: their order from "Reactor Build
// Order", "Building <name> <version> [n/N]" as each one starts, and how each ended from the "Reactor Summary". Shown on
// the left of the output as a vertical bar with a segment per module. A macro step that builds starts a new list. --
let mvnMods = { list: [], parallel: false, threads: 1, seq: 0, phase: null, rest: '' };
let mvnModTimer = null;
const MVN_MOD_STATES = { SUCCESS: 'success', FAILURE: 'failed', SKIPPED: 'skipped' };
const MVN_MOD_FOLD_KEY = 'mvnModulesFolded';

// Folded, the area keeps only the bars (each one's name and state in its tooltip); remembered.
// (the steps of a macro too: one choice for the column)
function setMvnModulesFolded(folded) {
  for (const [box, btn, what] of [['#mvnModules', '#mvnModFold', 'modules'], ['#mvnSteps', '#mvnStepFold', 'steps']]) {
    $(box).classList.toggle('folded', folded);
    const label = folded ? `Show the names of the ${what}` : 'Show only the bars';
    $(btn).title = label;
    $(btn).setAttribute('aria-label', label);
    $(btn).setAttribute('aria-expanded', String(!folded));
  }
  try {
    localStorage.setItem(MVN_MOD_FOLD_KEY, folded ? '1' : '0');
  } catch {
    // only until the app closes
  }
}

function resetMvnModules() {
  mvnMods = { list: [], parallel: false, threads: 1, seq: 0, phase: null, rest: '' };
}

// Whole lines only (a chunk can end in the middle of one); true when the list changed.
function feedMvnModules(text, live) {
  const lines = (mvnMods.rest + text).split('\n');
  mvnMods.rest = lines.pop();
  let changed = false;
  for (const line of lines) changed = mvnModuleLine(line.replace(/\r$/, ''), live) || changed;
  return changed;
}

// Maven says when a module starts, not when it ends. One at a time, the one before has ended when the next starts; with
// -T no more build at once than its threads, so the ones that started first have ended. The summary at the end says
// how each one did.
function startMvnModule(mod, live) {
  mod.state = 'building';
  mod.startedAt = live ? Date.now() : null;
  mod.seq = ++mvnMods.seq;
  const building = mvnMods.list.filter((x) => x.state === 'building').sort((a, b) => a.seq - b.seq);
  const room = mvnMods.parallel ? mvnMods.threads : 1;
  for (const x of building.slice(0, Math.max(0, building.length - room))) x.state = 'success';
  return true;
}

function mvnModuleLine(raw, live) {
  const m = mvnMods;
  if (/^▶ \d+\/\d+ /.test(raw)) {
    resetMvnModules();
    return true;
  }
  const hit = /^\[(?:INFO|WARNING|ERROR)\] ?(.*)$/.exec(raw);
  if (!hit) return false;
  const line = hit[1];
  if (line === 'Reactor Build Order:') {
    Object.assign(m, { list: [], parallel: false, threads: 1, seq: 0, phase: 'order' });
    return true;
  }
  if (m.phase === 'order') {
    if (!line.trim()) {
      if (m.list.length) m.phase = null;
      return false;
    }
    const e = /^(.+?)\s+\[([\w.-]+)\]\s*$/.exec(line);
    m.list.push({ name: (e ? e[1] : line).trim(), packaging: e ? e[2] : '', state: 'pending', startedAt: null, time: '' });
    return true;
  }
  const threads = /^Using the MultiThreadedBuilder implementation with a thread count of (\d+)/.exec(line);
  if (threads) {
    m.parallel = true;
    m.threads = Math.max(1, Number(threads[1]));
    return false;
  }
  const b = /^Building (.+) (\S+)\s+\[(\d+)\/(\d+)\]\s*$/.exec(line);
  if (b) {
    let mod = m.list[Number(b[3]) - 1];
    if (!mod || mod.name !== b[1]) mod = m.list.find((x) => x.name === b[1]) || mod;
    return mod ? startMvnModule(mod, live) : false;
  }
  // older Maven has no [n/N]: only a name of the list counts (not "Building jar: ...")
  const old = /^Building (.+) (\S+)\s*$/.exec(line);
  if (old && m.list.some((x) => x.name === old[1])) return startMvnModule(m.list.find((x) => x.name === old[1]), live);
  if (/^Reactor Summary/.test(line)) {
    m.phase = 'summary';
    return false;
  }
  if (m.phase === 'summary') {
    const s = /^(.+?) \.* ?(SUCCESS|FAILURE|SKIPPED)(?:\s*\[\s*(.+?)\s*\])?\s*$/.exec(line);
    const mod = s && m.list.find((x) => x.name === s[1]);
    if (mod) {
      mod.state = MVN_MOD_STATES[s[2]];
      mod.time = s[3] || '';
      return true;
    }
    if (/^-{20,}/.test(line)) m.phase = null;
  }
  return false;
}

// The run ended: what was building ended with it, and what had not started was not built.
function finishMvnModules(exitCode, stopped) {
  for (const x of mvnMods.list) {
    if (x.state === 'building') x.state = exitCode === 0 ? 'success' : stopped ? 'stopped' : 'failed';
    else if (x.state === 'pending' && exitCode !== 0) x.state = stopped ? 'pending' : 'skipped';
    x.startedAt = null;
  }
  renderMvnModules();
}

const mvnModWhen = (x) => {
  if (x.state === 'building') return x.startedAt ? `building · ${formatDuration(Date.now() - x.startedAt)}` : 'building';
  const label = { pending: 'waiting', success: '', failed: 'failed', skipped: 'skipped', stopped: 'stopped' }[x.state];
  return [label, x.time].filter(Boolean).join(' · ') || 'built';
};

function renderMvnModules() {
  const box = $('#mvnModules');
  const list = mvnMods.list;
  clearInterval(mvnModTimer);
  // a project of one module has no reactor: nothing to show
  box.classList.toggle('hidden', list.length < 2);
  if (list.length < 2) return;
  const built = list.filter((x) => x.state === 'success').length;
  const failed = list.find((x) => x.state === 'failed');
  $('#mvnModCount').textContent = failed ? `failed at ${list.indexOf(failed) + 1} of ${list.length}` : `${built} of ${list.length}`;
  $('#mvnModCount').classList.toggle('failed', Boolean(failed));
  $('#mvnModList').replaceChildren(
    ...list.map((x, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mvn-mod';
      b.dataset.state = x.state;
      b.title = `${x.name}${x.packaging ? ` [${x.packaging}]` : ''}: ${mvnModWhen(x)}. A click shows where it starts in the output.`;
      const seg = document.createElement('span');
      seg.className = 'mvn-mod-seg';
      const text = document.createElement('span');
      text.className = 'mvn-mod-text';
      const name = document.createElement('span');
      name.className = 'mvn-mod-name';
      name.textContent = x.name;
      const when = document.createElement('span');
      when.className = 'mvn-mod-when';
      when.textContent = mvnModWhen(x);
      text.append(name, when);
      b.append(seg, text);
      b.addEventListener('click', () => scrollToMvnModule(x));
      li.appendChild(b);
      return li;
    })
  );
  if (list.some((x) => x.state === 'building' && x.startedAt)) {
    mvnModTimer = setInterval(() => {
      $$('#mvnModList .mvn-mod[data-state="building"] .mvn-mod-when').forEach((el, i) => {
        const x = list.filter((y) => y.state === 'building')[i];
        if (x) el.textContent = mvnModWhen(x);
      });
    }, 1000);
  }
}

// -- The steps of a macro, by the output as the modules are: a segment each (waiting, running, done, failed, stopped,
// not run), what it runs and how long it took; a click shows where it starts in the output. --
let mvnStepTimer = null;

function mvnStepState(n) {
  const m = mvnRun.macro;
  const at = m.step || 1;
  if (mvnRun.running) return n < at ? 'success' : n === at ? 'building' : 'pending';
  if (mvnRun.stopped) return n < at ? 'success' : n === at ? 'stopped' : 'skipped';
  if (mvnRun.failedStep) return n < mvnRun.failedStep ? 'success' : n === mvnRun.failedStep ? 'failed' : 'skipped';
  return 'success';
}

const mvnStepTook = (mark) => {
  if (!mark) return '';
  const ms = mark.ms ?? Date.now() - mark.at;
  return ms < 1000 ? `${ms} ms` : formatDuration(ms);
};

function mvnStepWhen(state, mark) {
  const took = mvnStepTook(mark);
  if (state === 'pending') return 'waiting';
  if (state === 'skipped') return 'not run';
  if (state === 'building') return took ? `running · ${took}` : 'running';
  if (state === 'failed' || state === 'stopped') return [state, took].filter(Boolean).join(' · ');
  return took || 'done';
}

function renderMvnSteps() {
  const box = $('#mvnSteps');
  const m = mvnRun && mvnRun.macro;
  clearInterval(mvnStepTimer);
  box.classList.toggle('hidden', !m || m.total < 2);
  if (!m || m.total < 2) return;
  const marks = m.marks || [];
  const states = m.steps.map((_, i) => mvnStepState(i + 1));
  const count = $('#mvnStepCount');
  const failed = states.indexOf('failed');
  const stopped = states.indexOf('stopped');
  count.textContent = failed !== -1 ? `failed at ${failed + 1} of ${m.total}` : stopped !== -1 ? `stopped at ${stopped + 1} of ${m.total}` : `${mvnRun.running ? m.step || 1 : m.total} of ${m.total}`;
  count.classList.toggle('failed', failed !== -1);
  $('#mvnStepList').replaceChildren(
    ...m.steps.map((label, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mvn-mod';
      b.dataset.state = states[i];
      b.title = `${i + 1}. ${label}: ${mvnStepWhen(states[i], marks[i])}. A click shows where it starts in the output.`;
      const seg = document.createElement('span');
      seg.className = 'mvn-mod-seg';
      const text = document.createElement('span');
      text.className = 'mvn-mod-text';
      const name = document.createElement('span');
      name.className = 'mvn-mod-name';
      name.textContent = label;
      const when = document.createElement('span');
      when.className = 'mvn-mod-when';
      when.textContent = mvnStepWhen(states[i], marks[i]);
      text.append(name, when);
      b.append(seg, text);
      b.addEventListener('click', () => scrollToMvnStep(i + 1, m.total));
      li.appendChild(b);
      return li;
    })
  );
  const running = states.indexOf('building');
  if (running !== -1) {
    mvnStepTimer = setInterval(() => {
      const el = $(`#mvnStepList li:nth-child(${running + 1}) .mvn-mod-when`);
      if (el && mvnRun && mvnRun.macro) el.textContent = mvnStepWhen('building', (mvnRun.macro.marks || [])[running]);
    }, 1000);
  }
}

// The output scrolled to the line where the step starts ("▶ 2/5").
function scrollToMvnStep(n, total) {
  const out = $('#mvnOutput');
  const node = out.firstChild;
  if (!node) return;
  const at = node.data.lastIndexOf(`▶ ${n}/${total} `);
  if (at === -1) return;
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, Math.min(node.length, at + 1));
  out.scrollTop += range.getBoundingClientRect().top - out.getBoundingClientRect().top - 8;
}

// The output scrolled to the line where the module starts (in the last build of the output).
function scrollToMvnModule(x) {
  const out = $('#mvnOutput');
  const text = out.textContent;
  const from = Math.max(0, text.lastIndexOf('Reactor Build Order:'));
  const at = text.indexOf(`Building ${x.name} `, from);
  const node = out.firstChild;
  if (at === -1 || !node) return;
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, Math.min(node.length, at + 1));
  const top = range.getBoundingClientRect().top - out.getBoundingClientRect().top;
  out.scrollTop += top - 8;
}

function renderMvnStatus() {
  clearInterval(mvnTimer);
  renderMvnSteps();
  const status = $('#mvnStatus');
  const running = Boolean(mvnRun && mvnRun.running);
  if (!running) mvnStopping = false;
  $('#mvnClearBtn').disabled = running;
  $('#mvnOptionsBtn').disabled = running;
  $$('#mvnTags button').forEach((b) => (b.disabled = running));
  $('#mvnCustom').disabled = running;
  $('#mvnCustomSave').disabled = running || !$('#mvnCustom').value.trim();
  ['#mvnSavedEdit', '#mvnSavedDelete'].forEach((sel) => ($(sel).disabled = running));
  $('#mvnLineRun').disabled = running;
  updateMvnRunButton();
  $('#mvnMacroEditBtn').disabled = running;
  $('#mvnFolder').disabled = running;
  status.className = 'mvn-status';
  if (!mvnRun) {
    status.textContent = 'Idle';
    return;
  }
  const m = mvnRun.macro;
  if (running) {
    status.classList.add('running');
    const what = () => (m ? `${mvnRun.command} · step ${m.step || 1} of ${m.total}: ${mvnRun.stepCommand || m.steps[0]}` : mvnRun.command);
    const tick = () => (status.textContent = `Running ${what()} (${formatDuration(Date.now() - mvnRun.startedAt)})`);
    tick();
    mvnTimer = setInterval(tick, 1000);
    return;
  }
  const ok = mvnRun.exitCode === 0 && !(m && mvnRun.stopped);
  status.classList.add(ok ? 'ok' : 'failed');
  const took = mvnRun.endedAt ? ` in ${formatDuration(mvnRun.endedAt - mvnRun.startedAt)}` : '';
  if (m && mvnRun.stopped) status.textContent = `Stopped ${mvnRun.command} at step ${m.step} of ${m.total}${took}`;
  else if (m && !ok) status.textContent = `Failed ${mvnRun.command} at step ${mvnRun.failedStep || m.step}: ${m.steps[(mvnRun.failedStep || m.step) - 1]}${mvnRun.failedGit ? ' (why is in the output)' : ` (exit code ${mvnRun.exitCode})`}${took}`;
  else if (m) status.textContent = `Finished ${mvnRun.command}, ${m.total} step${m.total === 1 ? '' : 's'}${took}`;
  else status.textContent = ok ? `Finished ${mvnRun.command}${took}` : `Failed ${mvnRun.command} (exit code ${mvnRun.exitCode})${took}`;
}

// Shows the saved ports in the fields and in the Start and Debug entries of the list.
function renderMvnPorts(view) {
  mvnPortsView = view;
  const { ports, commands = {} } = view;
  const debugInput = $('#mvnDebugPort');
  const serverInput = $('#mvnServerPort');
  if (document.activeElement !== debugInput) debugInput.value = String(ports.debug);
  if (document.activeElement !== serverInput) serverInput.value = ports.server ? String(ports.server) : '';
  $('#mvnPortsBtn').title = `Start / Debug ports: debug ${ports.debug}, app ${ports.server || "the project's own"}`;
  $('#mvnCommand option[value="debug"]').textContent = `Debug :${ports.debug}`;
  $('#mvnCommand option[value="start"]').textContent = ports.server ? `Start :${ports.server}` : 'Start';
  $$('#mvnCommand option').forEach((o) => {
    if (commands[o.value]) o.title = commands[o.value];
  });
  renderMacroOptions(); // their steps show these ports
  renderMvnPreview();
}

// -- The ports of Start and Debug, in a popover under the gear at the end of the command line: saved when a field is
// left or Enter is pressed (Enter closes it too); Esc, a click elsewhere or the window left close it. --
function closeMvnPorts(refocus = false) {
  const pop = $('#mvnPortsPop');
  if (pop.classList.contains('hidden')) return;
  // a field being typed in is saved as it is left
  if (pop.contains(document.activeElement)) document.activeElement.blur();
  pop.classList.add('hidden');
  $('#mvnPortsBtn').setAttribute('aria-expanded', 'false');
  if (refocus) $('#mvnPortsBtn').focus();
}

function openMvnPorts() {
  const pop = $('#mvnPortsPop');
  const btn = $('#mvnPortsBtn');
  pop.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  // under the gear, its right edge lined up with it, inside the window
  const a = btn.getBoundingClientRect();
  pop.style.left = `${Math.round(Math.max(8, Math.min(a.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8)))}px`;
  pop.style.top = `${Math.round(a.bottom + 6)}px`;
  $('#mvnDebugPort').focus();
  $('#mvnDebugPort').select();
}

function setupMvnPorts() {
  const pop = $('#mvnPortsPop');
  const btn = $('#mvnPortsBtn');
  btn.addEventListener('click', () => (pop.classList.contains('hidden') ? openMvnPorts() : closeMvnPorts()));
  ['#mvnDebugPort', '#mvnServerPort'].forEach((sel) => {
    const input = $(sel);
    input.addEventListener('change', saveMvnPorts);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // the key ends here: else it would press the gear the focus goes back to, and open it again
      e.preventDefault();
      closeMvnPorts(true);
    });
  });
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMvnPorts(true);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (!pop.classList.contains('hidden') && !pop.contains(e.target) && !btn.contains(e.target)) closeMvnPorts();
  }, true);
  window.addEventListener('blur', () => closeMvnPorts());
}

async function saveMvnPorts() {
  if (!mvnRepo || !mvnPortsView) return;
  const debug = $('#mvnDebugPort').value.trim();
  const server = $('#mvnServerPort').value.trim();
  const saved = mvnPortsView.ports;
  if ((debug || String(5005)) === String(saved.debug) && server === (saved.server ? String(saved.server) : '')) return;
  const r = await window.maven.setPorts(mvnRepo, { debug, server });
  if (r.error) {
    toast(r.error, 'error');
    $('#mvnDebugPort').value = String(saved.debug);
    $('#mvnServerPort').value = saved.server ? String(saved.server) : '';
    return;
  }
  renderMvnPorts(r);
  toast(r.ports.server ? `Debug port ${r.ports.debug}, app port ${r.ports.server}` : `Debug port ${r.ports.debug}, app port from the project`, 'success');
}

async function refreshMaven() {
  if (!currentRepo) return;
  const repo = currentRepo;
  let info = await window.maven.info(repo);
  if (repo !== currentRepo) return;
  if (repo !== mvnRepo) closeMvnPorts(); // the ports are another microservice's
  mvnRepo = repo;
  closeMvnOptions();
  if (info.error) {
    toast(info.error, 'error');
    return;
  }
  // no pom.xml in the root, and a single folder of the repository has one: that is where Maven runs
  if (!info.hasPom && info.folders && info.folders.length === 1 && info.folders[0] && !(info.run && info.run.running)) {
    const r = await window.maven.setDir(repo, info.folders[0]);
    if (repo !== currentRepo) return;
    if (!r.error) info = r;
  }
  applyMvnInfo(info);
}

function applyMvnInfo(info) {
  mvnOptionList = info.options || [];
  mvnProfiles = info.profiles || [];
  mvnContainerSpec = info.container || null;
  renderMvnFolder(info);
  renderMvnValuesBtn(info);
  renderMvnEnvBtn(info);
  renderMvnPreview();
  if (info.ports) renderMvnPorts(info);
  $('#mvnNoPom').classList.toggle('hidden', info.hasPom);
  $('#mvnNoPom').textContent = info.folders && info.folders.length ? 'No pom.xml in this folder: choose the folder of the microservice above.' : 'No pom.xml in this repository.';
  $('#mvnPanel').classList.toggle('hidden', !info.hasPom);
  // "Runs in" at the right of the command line; with no pom.xml in the folder (no command line), on top to choose another
  const row = $('#mvnFolderRow');
  if (info.hasPom) $('#mvnCmdline').insertBefore(row, $('#mvnValuesBtn'));
  else $('#tab-maven').insertBefore(row, $('#mvnNoPom'));
  renderMvnLine(info);
  $('#mvnWrapper').classList.toggle('hidden', !info.wrapper);
  $('#mvnWrapper').textContent = info.wrapperDir ? `using ${info.wrapperDir}/mvnw` : 'using mvnw';
  // the same run, read while its output came: the page already has more of it than this copy
  const behind = info.run && mvnRun && mvnRun.id === info.run.id && (mvnRun.written || 0) > (info.run.written || 0);
  if (!behind) mvnStopping = false;
  mvnRun = info.run ? { ...info.run, ...(behind ? { written: mvnRun.written } : {}) } : null;
  if (!behind) setMvnOutput(mvnRun ? mvnRun.log : '');
  // read again from the output, a run that ended without its summary (stopped, or Maven killed) still ends its modules
  if (mvnRun && !mvnRun.running) finishMvnModules(mvnRun.exitCode, mvnRun.stopped);
  renderMvnStatus();
}

// "Runs in": the folders of the repository with a pom.xml, when there is more than the root to choose from.
function renderMvnFolder(info) {
  const folders = info.folders || [];
  const select = $('#mvnFolder');
  const choices = folders.includes('') ? folders : ['', ...folders];
  select.replaceChildren(...choices.map((f) => new Option(f ? `${f}/` : folders.includes('') ? 'Root of the repository' : 'Root of the repository (no pom.xml)', f)));
  select.value = info.dir || '';
  $('#mvnFolderRow').classList.toggle('hidden', !(folders.length > 1 || (folders.length === 1 && folders[0] !== '') || info.dir));
  $('#mvnFolderNote').textContent = info.lostDir ? `${info.lostDir}/ has no pom.xml any more: the root is used` : '';
}

async function setMvnFolder(rel) {
  if (!mvnRepo) return;
  const repo = mvnRepo;
  const r = await window.maven.setDir(repo, rel);
  if (repo !== mvnRepo) return;
  if (r.error) {
    toast(r.error, 'error');
    refreshMaven();
    return;
  }
  applyMvnInfo(r);
  toast(rel ? `Maven runs in ${rel}/` : 'Maven runs in the root of the repository', 'success', { plain: true });
}

async function runMaven(request) {
  if (!mvnRepo) return;
  const external = $('#mvnExternal').checked;
  // the values chosen per environment (mvn-values.js): maven.js gives them to spring-boot:run only
  const r = await window.maven.run(mvnRepo, { ...request, ...(await mvnValuesRequest()), external });
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  if (r.external) {
    // what a run here gives the application and a separate window does not
    const left = [r.valuesLeft && 'the values chosen in Values', r.envLeft && 'the profiles and variables of Env'].filter(Boolean);
    toast(`Opened ${r.command} in a ${window.git.platform === 'win32' ? 'PowerShell' : 'Terminal'} window${left.length ? `, without ${left.join(' nor ')}: they go to a run here only` : ''}`, left.length ? 'info' : 'success', { plain: true });
    return;
  }
  startedMvnRun(r);
}

// -- The command line under the output: what is typed there runs as Run does (mvn-line in maven.js), its output after
// what is there. ↑ and ↓ bring back the last ones typed, the newest first (kept in this window). --
const MVN_LINE_KEY = 'mvnLineHistory';
const MVN_LINE_MAX = 50;
let mvnLines = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(MVN_LINE_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter((x) => typeof x === 'string').slice(0, MVN_LINE_MAX) : [];
  } catch {
    return [];
  }
})();
let mvnLineAt = -1; // where ↑ and ↓ are in that list; -1: what is being typed
let mvnLineDraft = '';

async function runMvnLine() {
  const input = $('#mvnLine');
  const line = input.value.trim();
  if (!mvnRepo || !line) return;
  const r = await window.maven.line(mvnRepo, { line, ...(await mvnValuesRequest()) });
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  mvnLines = [line, ...mvnLines.filter((x) => x !== line)].slice(0, MVN_LINE_MAX);
  try {
    localStorage.setItem(MVN_LINE_KEY, JSON.stringify(mvnLines));
  } catch {
    // kept until the window closes
  }
  mvnLineAt = -1;
  input.value = '';
  startedMvnRun(r);
}

// by 1: an older one; by -1: a newer one, and past the newest what was being typed
function stepMvnLine(by) {
  const input = $('#mvnLine');
  if (mvnLineAt === -1) mvnLineDraft = input.value;
  const at = Math.max(-1, Math.min(mvnLines.length - 1, mvnLineAt + by));
  if (at === mvnLineAt) return;
  mvnLineAt = at;
  input.value = at === -1 ? mvnLineDraft : mvnLines[at];
  input.setSelectionRange(input.value.length, input.value.length);
}

// where a command typed there runs, before it and in the empty line
function renderMvnLine(info) {
  const entry = repos.find((r) => r.path === mvnRepo);
  const where = `${entry ? displayName(entry) : repoName(mvnRepo)}${info.dir ? `/${info.dir}` : ''}`;
  $('#mvnLinePrompt').textContent = `${where} ${window.git.platform === 'win32' ? '>' : '$'}`;
  const input = $('#mvnLine');
  input.placeholder = `A command in ${where}: mvn, git, java -version... ↑ for the last ones`;
  input.title = 'Runs as Run does, in this folder: mvn is the same Maven (mvnw), with Env and Values when it starts the application; any other command goes to the system shell, with them. A cd or a variable set in a line lasts for that line only.';
}

// A run that started here: its output and status in the page.
function startedMvnRun(r) {
  mvnRun = { id: r.id, written: r.written, command: r.command, running: true, startedAt: r.startedAt, exitCode: null };
  setMvnOutput(r.log || `> ${r.command}\n`);
  renderMvnStatus();
}

// -- What a macro asks when it starts: the name of each new branch, and what to do with the local changes when one of
// its steps asks (or discards them, which is never done without saying so). Nothing to ask: it starts at once. --
const macroBranchOk = (t) => /^[\w./-]+$/.test(t) && !/^[-/]|[/.]$|\.lock$|\.\.|\/\//.test(t);
let macroAsk = null; // { resolve, macro, names }

async function askMacroAnswers(macro, repo) {
  const branchSteps = macro.steps.map((st, i) => ({ st, i })).filter(({ st }) => st.kind === 'branch');
  const changesStep = macro.steps.find((st) => st.kind === 'changes' && (st.policy === 'ask' || st.policy === 'discard'));
  let status = null;
  if (changesStep) {
    status = await window.git.getStatus(repo).catch(() => null);
    if (!status || status.error || !(status.entries || []).length) status = null;
  }
  if (!branchSteps.length && !status) return {};
  return new Promise((resolve) => openMacroAsk(macro, repo, { branchSteps, status, changesStep }, resolve));
}

function closeMacroAsk(answers) {
  $('#mvnAskModal').classList.add('hidden');
  const ask = macroAsk;
  macroAsk = null;
  if (ask) ask.resolve(answers);
}

function openMacroAsk(macro, repo, { branchSteps, status, changesStep }, resolve) {
  const names = new Map(); // step index -> its input
  macroAsk = { resolve, macro, names };
  const entry = repos.find((r) => r.path === repo);
  const branch = (status && status.branch) || (entry && entry.branch) || '';
  $('#mvnAskTitle').textContent = `Run ${macro.name}`;
  $('#mvnAskWhere').textContent = `In ${entry ? displayName(entry) : repoName(repo)}${branch ? `, on ${branch}` : ''}`;
  $('#mvnAskError').textContent = '';
  const body = $('#mvnAskBody');
  body.textContent = '';
  let local = new Set(); // the branches here, for "already exists"
  window.git.getBranches(repo).then((b) => {
    local = new Set(((b && b.local) || []).map((x) => x.name));
    names.forEach((input) => input.dispatchEvent(new Event('input')));
  }).catch(() => {});

  for (const { st, i } of branchSteps) {
    const id = `mvnAskBranch${i}`;
    const label = document.createElement('label');
    label.className = 'settings-label';
    label.htmlFor = id;
    label.textContent = branchSteps.length > 1 ? `New branch at step ${i + 1}, from origin/${st.base}` : `New branch, from origin/${st.base}`;
    const input = document.createElement('input');
    input.id = id;
    input.className = 'input mvn-ask-branch';
    input.maxLength = 200;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = `feature/${ticketPrefix || 'ABC-'}123`;
    input.value = `feature/${ticketPrefix}`;
    const note = document.createElement('span');
    note.className = 'mvn-ask-note';
    input.addEventListener('input', () => {
      const t = input.value.trim();
      $('#mvnAskError').textContent = '';
      note.className = 'mvn-ask-note';
      if (!t) note.textContent = '';
      else if (!macroBranchOk(t)) {
        note.textContent = 'Not a valid branch name';
        note.classList.add('bad');
      } else note.textContent = local.has(t) ? 'Exists already: the macro switches to it' : '';
      renderMacroAskSteps(macro, names, body);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitMacroAsk(macro, names, body);
      }
    });
    const chips = branchPrefixChips(input);
    chips.addEventListener('click', () => input.dispatchEvent(new Event('input'))); // after the chip filled it in
    const row = document.createElement('div');
    row.className = 'mvn-ask-row';
    row.append(chips, note);
    body.append(label, input, row);
    names.set(i, input);
  }

  if (status) {
    const files = status.entries.map((e) => e.file);
    const title = document.createElement('div');
    title.className = 'settings-label';
    title.textContent = `${files.length} local change${files.length === 1 ? '' : 's'}${branch ? ` on ${branch}` : ''}`;
    const list = document.createElement('div');
    list.className = 'mvn-ask-files';
    list.textContent = files.slice(0, 4).join(', ') + (files.length > 4 ? `, and ${files.length - 4} more` : '');
    list.title = files.join('\n');
    const back = macro.steps.findIndex((st) => st.kind === 'unstash');
    const choices = [
      ['stash', 'Stash them', back === -1 ? 'Kept in the Stash tab, with the new files' : `Kept in the Stash tab, and brought back at step ${back + 1}`],
      ['discard', 'Discard them', 'Every change and new file is lost: this cannot be undone'],
      ['stop', 'Stop the macro', 'Nothing runs: commit or stash them yourself first'],
    ];
    const group = document.createElement('div');
    group.className = 'mvn-ask-choices';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'What to do with the local changes');
    const chosen = changesStep.policy === 'discard' ? 'discard' : 'stash';
    for (const [value, text, hint] of choices) {
      const label = document.createElement('label');
      label.className = `mvn-ask-choice${value === 'discard' ? ' danger' : ''}`;
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'mvnAskChanges';
      radio.value = value;
      radio.checked = value === chosen;
      radio.addEventListener('change', () => renderMacroAskSteps(macro, names, body));
      const words = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = text;
      const small = document.createElement('small');
      small.textContent = hint;
      words.append(strong, small);
      label.append(radio, words);
      group.appendChild(label);
    }
    body.append(title, list, group);
  }
  renderMacroAskSteps(macro, names, body);
  $('#mvnAskModal').classList.remove('hidden');
  const first = names.values().next().value || body.querySelector('input:checked');
  if (first) {
    first.focus();
    if (first.type !== 'radio') first.setSelectionRange(first.value.length, first.value.length);
  } else $('#mvnAskRun').focus();
}

// What it runs, as the answers stand: the new branch's name and the choice for the local changes in their steps.
function renderMacroAskSteps(macro, names, body) {
  const choice = body.querySelector('input[name="mvnAskChanges"]:checked');
  const changes = { stash: 'stash them', discard: 'discard them', stop: 'stop the macro' };
  $('#mvnAskSteps').replaceChildren(
    ...macro.steps.map((st, i) => {
      const li = document.createElement('li');
      let text = macroStepText(st);
      if (st.kind === 'branch') text = `New branch ${(names.get(i) && names.get(i).value.trim()) || '...'} from origin/${st.base}`;
      else if (st.kind === 'changes' && (st.policy === 'ask' || st.policy === 'discard')) text = choice ? `Local changes: ${changes[choice.value]}` : 'Local changes: none now';
      li.textContent = text;
      if (MACRO_GIT_KINDS.has(st.kind)) li.className = 'git';
      return li;
    })
  );
}

function submitMacroAsk(macro, names, body) {
  const branches = {};
  for (const [i, input] of names) {
    const t = input.value.trim();
    const fail = (text) => {
      $('#mvnAskError').textContent = text;
      input.focus();
    };
    if (!t) return fail('Type a name for the new branch.');
    if (ticketPrefix && t.endsWith(ticketPrefix)) return fail('Complete the name after the ticket prefix.');
    if (!macroBranchOk(t)) return fail(`"${t}" is not a valid branch name.`);
    branches[i] = t;
  }
  const choice = body.querySelector('input[name="mvnAskChanges"]:checked');
  closeMacroAsk({ branches, ...(choice ? { changes: choice.value } : {}) });
}

function setupMacroAsk() {
  const modal = $('#mvnAskModal');
  $('#mvnAskCancel').addEventListener('click', () => closeMacroAsk(null));
  $('#mvnAskRun').addEventListener('click', () => {
    const ask = macroAsk;
    if (ask) submitMacroAsk(ask.macro, ask.names, $('#mvnAskBody'));
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMacroAsk(null);
    }
  });
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) closeMacroAsk(null);
  });
}

async function runMvnMacro(macro) {
  if (!mvnRepo) return;
  const repo = mvnRepo;
  const answers = await askMacroAnswers(macro, repo);
  if (!answers || repo !== mvnRepo) return;
  const r = await window.maven.runMacro(repo, macro.id, answers, await mvnValuesRequest());
  if (r.error) {
    toast(r.error, 'error', { plain: true });
    return;
  }
  mvnRun = { id: r.id, written: r.written, command: r.command, running: true, startedAt: r.startedAt, exitCode: null, macro: r.macro, stepCommand: null };
  setMvnOutput(r.log);
  renderMvnStatus();
}

// -- the macro editor --
let macroDraft = null;
// What a new macro starts from (the first one unless another is picked): its name and steps, changed at will.
const MACRO_TEMPLATES = [
  {
    id: 'task',
    label: 'Start a task',
    title: 'Local changes (asked when it runs), switch to develop, pull, a new branch from it, build, start the app',
    make: () => ({
      name: 'Start a task',
      steps: [
        { kind: 'changes', policy: 'ask' },
        { kind: 'checkout', branch: 'develop' },
        { kind: 'pull', from: '' },
        { kind: 'branch', base: 'develop' },
        { kind: 'preset', preset: 'install-skip-tests', extra: '' },
        { kind: 'preset', preset: 'start', extra: '' },
      ],
    }),
  },
  {
    id: 'update',
    label: 'Update and build',
    title: 'Stash the local changes, pull, bring them back, build',
    make: () => ({
      name: 'Update and build',
      steps: [{ kind: 'changes', policy: 'stash' }, { kind: 'pull', from: '' }, { kind: 'unstash' }, { kind: 'preset', preset: 'install-skip-tests', extra: '' }],
    }),
  },
  {
    id: 'restart',
    label: 'Rebuild and restart',
    title: 'Stop the app, format, build, start it again',
    make: () => ({
      name: 'Rebuild and restart',
      steps: [{ kind: 'stop' }, { kind: 'preset', preset: 'spotless-apply', extra: '' }, { kind: 'preset', preset: 'install-skip-tests', extra: '' }, { kind: 'preset', preset: 'start', extra: '' }],
    }),
  },
  { id: 'empty', label: 'Empty', title: 'No steps: add them yourself', make: () => ({ name: '', steps: [] }) },
];
// A new step as the "+ Add a step..." list makes it.
const NEW_STEPS = {
  'git:changes': () => ({ kind: 'changes', policy: 'ask' }),
  'git:fetch': () => ({ kind: 'fetch' }),
  'git:checkout': () => ({ kind: 'checkout', branch: 'develop' }),
  'git:branch': () => ({ kind: 'branch', base: 'develop' }),
  'git:pull': () => ({ kind: 'pull', from: '' }),
  'git:unstash': () => ({ kind: 'unstash' }),
  custom: () => ({ kind: 'custom', goals: '' }),
  stop: () => ({ kind: 'stop' }),
};
// the commands of the list (not Custom), as a step runs them: Start is mvn spring-boot:run
const macroPresets = () =>
  [...$('#mvnCommand').children]
    .filter((o) => o.tagName === 'OPTION' && o.value !== 'custom' && o.value !== 'container')
    .map((o) => [o.value, `mvn ${(mvnPortsView && mvnPortsView.presets && mvnPortsView.presets[o.value]) || o.textContent}`]);

function openMacroEditor(macro) {
  macroDraft = macro ? JSON.parse(JSON.stringify(macro)) : MACRO_TEMPLATES[0].make();
  $('#mvnMacroTitle').textContent = macro ? 'Edit macro' : 'New macro';
  $('#mvnMacroName').value = macroDraft.name;
  $('#mvnMacroDelete').classList.toggle('hidden', !macro);
  $('#mvnMacroError').textContent = '';
  renderMacroTemplates(macro ? null : MACRO_TEMPLATES[0].id);
  const add = $('#mvnMacroAdd');
  const placeholder = new Option('+ Add a step...', '');
  placeholder.hidden = true; // what the dropdown says, not one of its entries
  const group = (label, options) => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...options);
    return g;
  };
  const opt = (text, value, title) => Object.assign(new Option(text, value), { title });
  add.replaceChildren(
    placeholder,
    group('Git', [
      opt('Local changes: stash, discard or ask', 'git:changes', 'What to do when there are changes not committed: asked when the macro runs, or always the same'),
      opt('Fetch from origin', 'git:fetch', 'git fetch --all --prune --tags'),
      opt('Switch to a branch', 'git:checkout', 'git checkout <branch>'),
      opt('New branch from origin/...', 'git:branch', 'Its name is asked when the macro runs; the branch it starts from is fetched first'),
      opt('Pull', 'git:pull', 'git pull: the branch from its own on origin, or another branch merged into it'),
      opt('Bring back the stashed changes', 'git:unstash', 'git stash pop of what the Local changes step stashed'),
    ]),
    group('Maven', [...macroPresets().map(([v, t]) => new Option(t, `preset:${v}`)), new Option('Custom goals...', 'custom')]),
    group('Other', [new Option('Stop what is running', 'stop')])
  );
  renderMacroSteps();
  $('#mvnMacroModal').classList.remove('hidden');
  $('#mvnMacroName').focus();
  $('#mvnMacroName').select();
}

// "Start from": a new macro's name and steps from one of the templates (the one picked is pressed).
function renderMacroTemplates(current) {
  const row = $('#mvnMacroTemplates');
  row.classList.toggle('hidden', !current);
  if (!current) return;
  const chips = MACRO_TEMPLATES.map((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tag-chip mvn-macro-template';
    b.textContent = t.label;
    b.title = t.title;
    b.setAttribute('aria-pressed', String(t.id === current));
    b.addEventListener('click', () => {
      const next = t.make();
      macroDraft.name = next.name;
      macroDraft.steps = next.steps;
      $('#mvnMacroName').value = next.name;
      $('#mvnMacroError').textContent = '';
      renderMacroTemplates(t.id);
      renderMacroSteps();
      row.querySelector(`[aria-pressed="true"]`).focus();
    });
    return b;
  });
  const label = document.createElement('span');
  label.className = 'mvn-macro-templates-label';
  label.textContent = 'Start from';
  row.replaceChildren(label, ...chips);
}

function closeMacroEditor() {
  $('#mvnMacroModal').classList.add('hidden');
  macroDraft = null;
}

function macroIconButton(icon, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mvn-macro-btn';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS[icon] || ''}</svg>`;
  b.addEventListener('click', onClick);
  return b;
}

// A git step in the editor: a "git" tag, what it does, and its field (a branch, or what to do with local changes).
// Returns what takes the focus first, if anything.
function macroGitStepBody(step, i, body) {
  const tag = document.createElement('span');
  tag.className = 'mvn-macro-tag';
  tag.textContent = 'git';
  const words = (text) => {
    const t = document.createElement('span');
    t.className = 'mvn-macro-words';
    t.textContent = text;
    return t;
  };
  const field = (prop, placeholder, title, aria) => {
    const input = document.createElement('input');
    input.className = 'input mvn-macro-branch';
    input.placeholder = placeholder;
    input.title = title;
    input.maxLength = 200;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = step[prop] || '';
    input.setAttribute('aria-label', `Step ${i + 1}: ${aria}`);
    input.addEventListener('input', () => (step[prop] = input.value.trim()));
    return input;
  };
  body.appendChild(tag);
  if (step.kind === 'changes') {
    const sel = document.createElement('select');
    sel.className = 'input mvn-macro-preset';
    sel.setAttribute('aria-label', `Step ${i + 1}: what to do with local changes`);
    sel.append(...CHANGES_CHOICES.map(([v, t]) => new Option(t, v)));
    sel.value = step.policy || 'ask';
    sel.addEventListener('change', () => (step.policy = sel.value));
    body.append(words('Local changes:'), sel);
    return sel;
  }
  if (step.kind === 'fetch') {
    body.append(words('Fetch every branch and tag from origin'));
    return null;
  }
  if (step.kind === 'unstash') {
    body.append(words('Bring back the changes the Local changes step stashed'));
    return null;
  }
  if (step.kind === 'checkout') {
    const input = field('branch', 'develop', 'The branch to switch to (one only on origin is made here, following it)', 'branch to switch to');
    body.append(words('Switch to'), input);
    return input;
  }
  if (step.kind === 'branch') {
    const input = field('base', 'develop', 'The branch on origin the new one starts from; it is fetched first, so it is up to date', 'branch on origin it starts from');
    const note = document.createElement('span');
    note.className = 'mvn-macro-note';
    note.textContent = 'name asked when it runs';
    body.append(words('New branch from origin/'), input, note);
    return input;
  }
  const input = field('from', 'its own branch on origin', 'Empty: the branch is updated from its own branch on origin. A name (e.g. develop): origin/develop is merged into it.', 'branch to pull from');
  body.append(words('Pull from'), input);
  return input;
}

function renderMacroSteps(focusIndex = -1) {
  const list = $('#mvnMacroSteps');
  const steps = macroDraft.steps;
  list.textContent = '';
  steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.className = 'mvn-macro-step';
    const body = document.createElement('div');
    body.className = 'mvn-macro-body';
    let first = null;
    if (step.kind === 'stop') {
      const t = document.createElement('span');
      t.className = 'mvn-macro-stop';
      t.textContent = 'Stop what is running in the microservice';
      body.appendChild(t);
    } else if (step.kind === 'preset') {
      const sel = document.createElement('select');
      sel.className = 'input mvn-macro-preset';
      sel.setAttribute('aria-label', `Step ${i + 1}: command`);
      sel.append(...macroPresets().map(([v, t]) => new Option(t, v)));
      sel.value = step.preset;
      sel.addEventListener('change', () => (step.preset = sel.value));
      const extra = document.createElement('input');
      extra.className = 'input mvn-macro-extra';
      extra.placeholder = 'more flags';
      extra.title = 'More flags for this step, e.g. -Pdev';
      extra.maxLength = 400;
      extra.spellcheck = false;
      extra.value = step.extra || '';
      extra.setAttribute('aria-label', `Step ${i + 1}: more flags`);
      extra.addEventListener('input', () => (step.extra = extra.value));
      body.append(sel, extra);
      first = sel;
    } else if (MACRO_GIT_KINDS.has(step.kind)) {
      first = macroGitStepBody(step, i, body);
    } else {
      const pre = document.createElement('span');
      pre.className = 'mvn-macro-prefix';
      pre.textContent = 'mvn';
      const goals = document.createElement('input');
      goals.className = 'input mvn-macro-goals';
      goals.placeholder = 'goals, e.g. clean verify -Pdev';
      goals.maxLength = 400;
      goals.spellcheck = false;
      goals.value = step.goals || '';
      goals.setAttribute('aria-label', `Step ${i + 1}: Maven goals`);
      goals.addEventListener('input', () => (step.goals = goals.value));
      body.append(pre, goals);
      first = goals;
    }
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= steps.length) return;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      renderMacroSteps(j);
    };
    const actions = document.createElement('span');
    actions.className = 'mvn-macro-step-actions';
    const up = macroIconButton('up', 'Move up', () => move(-1));
    const down = macroIconButton('down', 'Move down', () => move(1));
    up.disabled = i === 0;
    down.disabled = i === steps.length - 1;
    actions.append(up, down, macroIconButton('delete', 'Remove this step', () => {
      steps.splice(i, 1);
      renderMacroSteps(Math.min(i, steps.length - 1));
    }));
    li.append(body, actions);
    list.appendChild(li);
    if (i === focusIndex) (first || actions.querySelector('button:not(:disabled)') || li).focus();
  });
  if (!steps.length) {
    const empty = document.createElement('li');
    empty.className = 'mvn-macro-empty';
    empty.textContent = 'No steps yet: add them below.';
    list.appendChild(empty);
  }
}

async function saveMacroDraft() {
  macroDraft.name = $('#mvnMacroName').value;
  const r = await window.maven.saveMacro(macroDraft);
  if (r.error) {
    $('#mvnMacroError').textContent = r.error;
    return;
  }
  mvnMacros = r.macros;
  const name = macroDraft.name.trim();
  closeMacroEditor();
  renderMacroOptions();
  chooseMvnCommand(`macro:${r.id}`);
  toast(`Macro ${name} saved`, 'success', { plain: true });
}

async function deleteMacroDraft() {
  const macro = mvnMacros.find((m) => m.id === macroDraft.id);
  if (!macro || !(await askConfirm(`Delete the macro "${macro.name}"?`))) return;
  const r = await window.maven.deleteMacro(macro.id);
  mvnMacros = r.macros || [];
  closeMacroEditor();
  renderMacroOptions();
  if (mvnChoice() === `macro:${macro.id}` || !macroOf(mvnChoice())) chooseMvnCommand(mvnChoice().startsWith('macro:') ? 'clean-install' : mvnChoice());
  toast(`Macro ${macro.name} deleted`, 'info', { plain: true });
}

// -- The list of commands, drawn by the app (the same on Windows and on a Mac), not by the system: the commands, then
// the macros, each with a pencil to change it, and New macro... The select stays as what is chosen (its value and its
// change event), so a click or a key on it opens this list instead of the system one. --
function closeMvnCommandMenu(refocus = false) {
  const menu = $('#mvnCmdMenu');
  if (!menu) return;
  document.removeEventListener('mousedown', menu.onOutside, true);
  menu.remove();
  if (refocus) $('#mvnCommand').focus();
}

function openMvnCommandMenu() {
  const select = $('#mvnCommand');
  if ($('#mvnCmdMenu')) {
    closeMvnCommandMenu(true);
    return;
  }
  if (select.disabled) return;
  const menu = document.createElement('div');
  menu.id = 'mvnCmdMenu';
  menu.className = 'clip-menu mvn-cmd-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', 'Maven command');
  const pick = (value) => {
    closeMvnCommandMenu(true);
    if (value === select.value) return;
    select.value = value;
    select.dispatchEvent(new Event('change'));
  };
  const icon = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  const item = (label, value, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    const on = value === select.value;
    b.className = `clip-menu-item mvn-cmd-item${on ? ' current' : ''}`;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(on));
    if (title) b.title = title;
    b.innerHTML = '<svg class="mvn-cmd-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>';
    const text = document.createElement('span');
    text.className = 'mvn-cmd-label';
    text.textContent = label;
    b.appendChild(text);
    b.addEventListener('click', () => pick(value));
    return b;
  };
  for (const o of select.children) {
    if (o.tagName === 'OPTION') {
      menu.appendChild(item(o.textContent, o.value, o.title));
      continue;
    }
    // Podman / Docker: Start in container, in a section of its own
    if (o.id === 'mvnContainerGroup') {
      const head = document.createElement('div');
      head.className = 'mvn-cmd-group';
      head.textContent = o.label;
      head.title = 'The jar Maven builds, run in a Java image with Podman or Docker';
      menu.appendChild(head);
      for (const c of o.children) menu.appendChild(item(c.textContent, c.value, c.title));
      continue;
    }
    // My commands, when there are any: their goals beside a name of their own, a pencil each
    if (o.id === 'mvnSavedGroup') {
      if (!mvnSaved.length) continue;
      const head = document.createElement('div');
      head.className = 'mvn-cmd-group';
      head.textContent = `My commands (${mvnSaved.length})`;
      head.title = 'Maven goals saved under a name, for every repository (Save next to Custom command...)';
      menu.appendChild(head);
      for (const c of mvnSaved) {
        const row = document.createElement('div');
        row.className = 'mvn-cmd-macro';
        const b = item(c.name, `cmd:${c.id}`, `mvn ${c.goals}`);
        if (c.name !== c.goals) {
          const goals = document.createElement('span');
          goals.className = 'mvn-cmd-steps mvn-cmd-goals';
          goals.textContent = c.goals;
          b.appendChild(goals);
        }
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'icon-action mvn-cmd-edit';
        edit.title = `Change ${c.name}: its name and goals, or delete it`;
        edit.setAttribute('aria-label', `Edit ${c.name}`);
        edit.innerHTML = icon(ACTION_ICONS.edit);
        edit.addEventListener('click', () => {
          closeMvnCommandMenu();
          openSaveCommand(c);
        });
        row.append(b, edit);
        menu.appendChild(row);
      }
      continue;
    }
    // the macros: a pencil each, then New macro...
    const head = document.createElement('div');
    head.className = 'mvn-cmd-group';
    head.textContent = mvnMacros.length ? `Macros (${mvnMacros.length})` : 'Macros';
    head.title = 'Several commands under a name, run one after the other, for every repository';
    menu.appendChild(head);
    for (const m of mvnMacros) {
      const row = document.createElement('div');
      row.className = 'mvn-cmd-macro';
      const b = item(m.name, `macro:${m.id}`, m.steps.map(macroStepText).join('\n'));
      const steps = document.createElement('span');
      steps.className = 'mvn-cmd-steps';
      steps.textContent = `${m.steps.length} step${m.steps.length === 1 ? '' : 's'}`;
      b.appendChild(steps);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'icon-action mvn-cmd-edit';
      edit.title = `Change ${m.name}: its name and steps, or delete it`;
      edit.setAttribute('aria-label', `Edit ${m.name}`);
      edit.innerHTML = icon(ACTION_ICONS.edit);
      edit.addEventListener('click', () => {
        closeMvnCommandMenu();
        openMacroEditor(m);
      });
      row.append(b, edit);
      menu.appendChild(row);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'clip-menu-item mvn-cmd-new';
    add.title = 'Several commands under a name, run one after the other (for example: stop, build, start)';
    add.innerHTML = icon(ACTION_ICONS.plus);
    add.append('New macro...');
    add.addEventListener('click', () => {
      closeMvnCommandMenu();
      openMacroEditor(null);
    });
    menu.appendChild(add);
  }
  menu.addEventListener('keydown', (e) => {
    const all = [...menu.querySelectorAll('button')];
    const i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMvnCommandMenu(true);
    } else if (e.key === 'Tab') {
      closeMvnCommandMenu();
    }
  });
  menu.onOutside = (e) => {
    if (!menu.contains(e.target) && e.target !== select) closeMvnCommandMenu();
  };
  document.addEventListener('mousedown', menu.onOutside, true);
  document.body.appendChild(menu);
  // under the list, its left edges lined up, as tall as the window allows
  const a = select.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const top = a.bottom + 4;
  menu.style.left = `${Math.round(Math.max(8, Math.min(a.left, window.innerWidth - m.width - 8)))}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.maxHeight = `${Math.max(160, window.innerHeight - top - 12)}px`;
  (menu.querySelector('.mvn-cmd-item.current') || menu.querySelector('button')).focus();
}

// A command or macro of the list chosen (and remembered).
function chooseMvnCommand(value) {
  const select = $('#mvnCommand');
  if (![...select.options].some((o) => o.value === value)) value = 'clean-install';
  select.value = value;
  mvnLastChoice = value;
  try {
    localStorage.setItem(MVN_CHOICE_KEY, value);
  } catch {
    // not remembered, but the choice still applies
  }
  renderMvnPreview();
}

function setupMacroEditor() {
  const modal = $('#mvnMacroModal');
  $('#mvnMacroAdd').addEventListener('change', (e) => {
    const v = e.target.value;
    e.target.value = '';
    if (!v || !macroDraft) return;
    if (macroDraft.steps.length >= 15) {
      $('#mvnMacroError').textContent = 'A macro has 15 steps at most';
      return;
    }
    const step = NEW_STEPS[v] ? NEW_STEPS[v]() : { kind: 'preset', preset: v.slice(7), extra: '' };
    macroDraft.steps.push(step);
    renderMacroSteps(macroDraft.steps.length - 1);
  });
  $('#mvnMacroSave').addEventListener('click', saveMacroDraft);
  $('#mvnMacroCancel').addEventListener('click', closeMacroEditor);
  $('#mvnMacroDelete').addEventListener('click', deleteMacroDraft);
  $('#mvnMacroName').addEventListener('keydown', (e) => e.key === 'Enter' && saveMacroDraft());
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMacroEditor();
    }
  });
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) closeMacroEditor();
  });
  $('#mvnMacroEditBtn').addEventListener('click', () => {
    const macro = chosenMacro();
    if (macro) openMacroEditor(macro);
  });
}

// After a git step of a macro (the next step began, or the macro ended): the repository's line in the list, and the
// Git half of its page when it is the one open (branch, changes, log), without reading the Maven output again.
const gitStepping = new Set(); // repositories whose macro is on a git step
function afterGitStep(repo) {
  if (!gitStepping.delete(repo)) return;
  refreshSummaries([repo]);
  if (repo !== currentRepo || shownRepo !== repo) return;
  [refreshStatus, refreshLog, refreshStash, refreshPush, refreshCmpRefs].forEach((f) => Promise.resolve().then(f).catch(() => {}));
}

function setupMaven() {
  if (CARD_ID) return;
  setupMvnValues();
  setupMvnEnv();
  const select = $('#mvnCommand');
  let saved = null;
  try {
    saved = localStorage.getItem(MVN_CHOICE_KEY);
    if ([...select.options].some((o) => o.value === saved)) select.value = saved;
  } catch {
    // storage unavailable: start on the first command
  }
  mvnLastChoice = select.value;
  // a macro chosen last time is in the list once the macros are read
  loadMvnMacros().then(() => {
    if (saved && saved.startsWith('macro:') && macroOf(saved)) chooseMvnCommand(saved);
  });
  // and so is a saved command
  loadMvnSaved().then(() => {
    if (saved && saved.startsWith('cmd:') && savedOf(saved)) chooseMvnCommand(saved);
  });
  // the app's own list, not the system's
  select.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    select.focus();
    openMvnCommandMenu();
  });
  select.addEventListener('keydown', (e) => {
    if ([' ', 'Enter', 'ArrowDown', 'ArrowUp', 'F4'].includes(e.key)) {
      e.preventDefault();
      openMvnCommandMenu();
    }
  });
  window.addEventListener('blur', () => closeMvnCommandMenu());
  select.addEventListener('change', () => {
    if (select.value === 'new-macro') {
      select.value = mvnLastChoice;
      openMacroEditor(null);
      return;
    }
    chooseMvnCommand(select.value);
    if (select.value === 'custom') $('#mvnCustom').focus();
  });
  const runChosen = () => {
    closeMvnOptions();
    const macro = chosenMacro();
    if (macro) runMvnMacro(macro);
    else if (mvnChoice() === 'container') openMvnContainer();
    else {
      const saved = chosenSaved();
      runMaven({ ...(saved ? { custom: saved.goals } : mvnChoice() === 'custom' ? { custom: $('#mvnCustom').value } : { preset: mvnChoice() }), ...chosenMvnOptions() });
    }
  };
  $('#mvnCustomSave').addEventListener('click', () => openSaveCommand(null, $('#mvnCustom').value.trim()));
  $('#mvnSavedEdit').addEventListener('click', () => {
    const command = chosenSaved();
    if (command) openSaveCommand(command);
  });
  $('#mvnSavedDelete').addEventListener('click', () => {
    const command = chosenSaved();
    if (command) deleteSavedCommand(command);
  });
  setupMacroEditor();
  setupMacroAsk();
  $('#mvnFolder').addEventListener('change', (e) => setMvnFolder(e.target.value));
  $('#mvnOptionsBtn').addEventListener('click', openMvnOptions);
  // Run, or Stop while something runs here
  $('#mvnRunBtn').addEventListener('click', async () => {
    if (!(mvnRun && mvnRun.running)) {
      runChosen();
      return;
    }
    mvnStopping = true;
    updateMvnRunButton();
    const r = await window.maven.stop(mvnRepo);
    if (r.error) {
      mvnStopping = false;
      updateMvnRunButton();
      toast(r.error, 'error');
    }
  });
  $('#mvnRestartBtn').addEventListener('click', runChosen);
  setupMvnFind();
  $('#mvnCustom').addEventListener('input', renderMvnPreview);
  $('#mvnCustom').addEventListener('keydown', (e) => e.key === 'Enter' && runChosen());
  renderMvnPreview();
  setupMvnPorts();
  $('#mvnLineForm').addEventListener('submit', (e) => {
    e.preventDefault();
    runMvnLine();
  });
  $('#mvnLine').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    stepMvnLine(e.key === 'ArrowUp' ? 1 : -1);
  });
  $('#mvnClearBtn').addEventListener('click', async () => {
    await window.maven.clear(mvnRepo);
    mvnRun = null;
    setMvnOutput('');
    renderMvnStatus();
  });
  window.maven.onRunning(setMavenRunning);
  window.maven.running().then(setMavenRunning).catch(() => {});
  // what the output does not have yet: the start of a run is in what Run gets back too, which may come first
  window.maven.onOutput(({ repo, text, id, end }) => {
    if (repo !== mvnRepo) return;
    if (!mvnRun || mvnRun.id !== id || !Number.isFinite(end)) {
      appendMvnOutput(text);
      return;
    }
    const have = mvnRun.written || 0;
    if (end <= have) return;
    mvnRun.written = end;
    appendMvnOutput(end - have < text.length ? text.slice(text.length - (end - have)) : text);
  });
  window.maven.onExit(({ repo, exitCode, endedAt, failedStep, failedGit, stopped, marks }) => {
    afterGitStep(repo);
    if (repo !== mvnRepo || !mvnRun) return;
    Object.assign(mvnRun, { running: false, exitCode, endedAt, failedStep, failedGit, stopped });
    if (mvnRun.macro && marks) mvnRun.macro.marks = marks;
    finishMvnModules(exitCode, stopped);
    // a macro's steps have their exit codes in the output already
    if (!mvnRun.macro) appendMvnOutput(`\n[exit code ${exitCode}]\n`);
    renderMvnStatus();
  });
  let folded = false;
  try {
    folded = localStorage.getItem(MVN_MOD_FOLD_KEY) === '1';
  } catch {
    // open
  }
  setMvnModulesFolded(folded);
  $('#mvnModFold').addEventListener('click', () => setMvnModulesFolded(!$('#mvnModules').classList.contains('folded')));
  $('#mvnStepFold').addEventListener('click', () => setMvnModulesFolded(!$('#mvnSteps').classList.contains('folded')));
  window.maven.onStep(({ repo, step, command, git, marks }) => {
    afterGitStep(repo);
    if (git) gitStepping.add(repo);
    if (repo !== mvnRepo || !mvnRun || !mvnRun.macro) return;
    mvnRun.macro.step = step;
    if (marks) mvnRun.macro.marks = marks;
    mvnRun.stepCommand = command;
    renderMvnStatus();
  });
}

setupMaven();
