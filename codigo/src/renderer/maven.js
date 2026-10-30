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

// What a step runs, as the bar shows it (Start and Debug with this repository's ports).
function macroStepText(step) {
  if (step.kind === 'stop') return 'Stop what is running';
  if (step.kind === 'custom') return `mvn ${step.goals}`;
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
  fitMvnCommand();
  const macro = chosenMacro();
  // a macro's steps carry their own flags: the options do not apply to it, nor does a separate window
  ['#mvnTags', '#mvnOptionsBtn'].forEach((sel) => $(sel).classList.toggle('hidden', Boolean(macro)));
  $('#mvnMacroInfo').classList.toggle('hidden', !macro);
  $('#mvnCmdline .mvn-prefix').textContent = macro ? 'macro' : 'mvn';
  $('#mvnMacroEditBtn').classList.toggle('hidden', !macro);
  $('#mvnExternal').disabled = Boolean(macro);
  $('#mvnExternal').closest('label').title = macro ? 'Macros run here, in the app' : 'Opens a separate window (PowerShell on Windows, Terminal on Mac) instead of showing the output here';
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

// While something runs here, only a macro that begins by stopping it can start (to build and start the app again).
function updateMvnRunButton() {
  const running = Boolean(mvnRun && mvnRun.running);
  const macro = chosenMacro();
  const restarts = Boolean(macro && macro.steps.some((st) => st.kind === 'stop'));
  const btn = $('#mvnRunBtn');
  btn.disabled = running && !restarts;
  btn.title = !running ? '' : restarts ? `Runs ${macro.name}: its Stop step ends what is running` : 'Something is running here: Stop it first';
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
}

function appendMvnOutput(text) {
  const out = $('#mvnOutput');
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  const clean = text.replace(ANSI, '');
  out.textContent = (out.textContent + clean).slice(-MAX_OUTPUT_CHARS);
  if (atBottom) out.scrollTop = out.scrollHeight;
  if (feedMvnModules(clean, true)) renderMvnModules();
}

// -- The modules of a multi-module build, read from Maven's output as it comes: their order from "Reactor Build
// Order", "Building <name> <version> [n/N]" as each one starts, and how each ended from the "Reactor Summary". Shown on
// the left of the output as a vertical bar with a segment per module. A macro step that builds starts a new list. --
let mvnMods = { list: [], parallel: false, threads: 1, seq: 0, phase: null, rest: '' };
let mvnModTimer = null;
const MVN_MOD_STATES = { SUCCESS: 'success', FAILURE: 'failed', SKIPPED: 'skipped' };
const MVN_MOD_FOLD_KEY = 'mvnModulesFolded';

// Folded, the area keeps only the bars (each one's name and state in its tooltip); remembered.
function setMvnModulesFolded(folded) {
  $('#mvnModules').classList.toggle('folded', folded);
  const btn = $('#mvnModFold');
  const label = folded ? 'Show the names of the modules' : 'Show only the bars';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-expanded', String(!folded));
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
  const status = $('#mvnStatus');
  const running = Boolean(mvnRun && mvnRun.running);
  $('#mvnStopBtn').classList.toggle('hidden', !running);
  $('#mvnClearBtn').disabled = running;
  $('#mvnOptionsBtn').disabled = running;
  $$('#mvnTags button').forEach((b) => (b.disabled = running));
  $('#mvnCustom').disabled = running;
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
  else if (m && !ok) status.textContent = `Failed ${mvnRun.command} at step ${mvnRun.failedStep || m.step}: ${m.steps[(mvnRun.failedStep || m.step) - 1]} (exit code ${mvnRun.exitCode})${took}`;
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
  $('#mvnCommand option[value="debug"]').textContent = `Debug :${ports.debug}`;
  $('#mvnCommand option[value="start"]').textContent = ports.server ? `Start :${ports.server}` : 'Start';
  $$('#mvnCommand option').forEach((o) => {
    if (commands[o.value]) o.title = commands[o.value];
  });
  renderMacroOptions(); // their steps show these ports
  renderMvnPreview();
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
  renderMvnFolder(info);
  renderMvnPreview();
  if (info.ports) renderMvnPorts(info);
  $('#mvnNoPom').classList.toggle('hidden', info.hasPom);
  $('#mvnNoPom').textContent = info.folders && info.folders.length ? 'No pom.xml in this folder: choose the folder of the microservice above.' : 'No pom.xml in this repository.';
  $('#mvnPanel').classList.toggle('hidden', !info.hasPom);
  $('#mvnWrapper').classList.toggle('hidden', !info.wrapper);
  $('#mvnWrapper').textContent = info.wrapperDir ? `using ${info.wrapperDir}/mvnw` : 'using mvnw';
  mvnRun = info.run || null;
  setMvnOutput(mvnRun ? mvnRun.log : '');
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
  const r = await window.maven.run(mvnRepo, { ...request, external });
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  if (r.external) {
    toast(`Opened ${r.command} in a ${window.git.platform === 'win32' ? 'PowerShell' : 'Terminal'} window`, 'success');
    return;
  }
  mvnRun = { command: r.command, running: true, startedAt: r.startedAt, exitCode: null };
  setMvnOutput(r.log || `> ${r.command}\n`);
  renderMvnStatus();
}

async function runMvnMacro(macro) {
  if (!mvnRepo) return;
  const r = await window.maven.runMacro(mvnRepo, macro.id);
  if (r.error) {
    toast(r.error, 'error', { plain: true });
    return;
  }
  mvnRun = { command: r.command, running: true, startedAt: r.startedAt, exitCode: null, macro: r.macro, stepCommand: null };
  setMvnOutput(r.log);
  renderMvnStatus();
}

// -- the macro editor --
let macroDraft = null;
const MACRO_EXAMPLE = () => ({
  name: 'Rebuild and restart',
  steps: [{ kind: 'stop' }, { kind: 'preset', preset: 'spotless-apply', extra: '' }, { kind: 'preset', preset: 'install-skip-tests', extra: '' }, { kind: 'preset', preset: 'start', extra: '' }],
});
// the commands of the list (not Custom), as a step runs them: Start is mvn spring-boot:run
const macroPresets = () =>
  [...$('#mvnCommand').children]
    .filter((o) => o.tagName === 'OPTION' && o.value !== 'custom')
    .map((o) => [o.value, `mvn ${(mvnPortsView && mvnPortsView.presets && mvnPortsView.presets[o.value]) || o.textContent}`]);

function openMacroEditor(macro) {
  macroDraft = macro ? JSON.parse(JSON.stringify(macro)) : MACRO_EXAMPLE();
  $('#mvnMacroTitle').textContent = macro ? 'Edit macro' : 'New macro';
  $('#mvnMacroName').value = macroDraft.name;
  $('#mvnMacroDelete').classList.toggle('hidden', !macro);
  $('#mvnMacroError').textContent = '';
  const add = $('#mvnMacroAdd');
  add.replaceChildren(new Option('+ Add a step...', ''), ...macroPresets().map(([v, t]) => new Option(t, `preset:${v}`)), new Option('Custom goals...', 'custom'), new Option('Stop what is running', 'stop'));
  renderMacroSteps();
  $('#mvnMacroModal').classList.remove('hidden');
  $('#mvnMacroName').focus();
  $('#mvnMacroName').select();
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
  if (!macro || !(await window.git.confirm(`Delete the macro "${macro.name}"?`))) return;
  const r = await window.maven.deleteMacro(macro.id);
  mvnMacros = r.macros || [];
  closeMacroEditor();
  renderMacroOptions();
  if (mvnChoice() === `macro:${macro.id}` || !macroOf(mvnChoice())) chooseMvnCommand(mvnChoice().startsWith('macro:') ? 'clean-install' : mvnChoice());
  toast(`Macro ${macro.name} deleted`, 'info', { plain: true });
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
    const step = v === 'stop' ? { kind: 'stop' } : v === 'custom' ? { kind: 'custom', goals: '' } : { kind: 'preset', preset: v.slice(7), extra: '' };
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

function setupMaven() {
  if (CARD_ID) return;
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
    else runMaven({ ...(mvnChoice() === 'custom' ? { custom: $('#mvnCustom').value } : { preset: mvnChoice() }), ...chosenMvnOptions() });
  };
  setupMacroEditor();
  $('#mvnFolder').addEventListener('change', (e) => setMvnFolder(e.target.value));
  $('#mvnOptionsBtn').addEventListener('click', openMvnOptions);
  $('#mvnRunBtn').addEventListener('click', runChosen);
  $('#mvnCustom').addEventListener('input', renderMvnPreview);
  $('#mvnCustom').addEventListener('keydown', (e) => e.key === 'Enter' && runChosen());
  renderMvnPreview();
  ['#mvnDebugPort', '#mvnServerPort'].forEach((sel) => {
    const input = $(sel);
    input.addEventListener('change', saveMvnPorts);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
  });
  $('#mvnStopBtn').addEventListener('click', async () => {
    const r = await window.maven.stop(mvnRepo);
    if (r.error) toast(r.error, 'error');
  });
  $('#mvnClearBtn').addEventListener('click', async () => {
    await window.maven.clear(mvnRepo);
    mvnRun = null;
    setMvnOutput('');
    renderMvnStatus();
  });
  window.maven.onRunning(setMavenRunning);
  window.maven.running().then(setMavenRunning).catch(() => {});
  window.maven.onOutput(({ repo, text }) => {
    if (repo === mvnRepo) appendMvnOutput(text);
  });
  window.maven.onExit(({ repo, exitCode, endedAt, failedStep, stopped }) => {
    if (repo !== mvnRepo || !mvnRun) return;
    Object.assign(mvnRun, { running: false, exitCode, endedAt, failedStep, stopped });
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
  window.maven.onStep(({ repo, step, command }) => {
    if (repo !== mvnRepo || !mvnRun || !mvnRun.macro) return;
    mvnRun.macro.step = step;
    mvnRun.stepCommand = command;
    renderMvnStatus();
  });
}

setupMaven();
