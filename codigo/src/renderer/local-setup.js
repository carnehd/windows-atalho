// -- Local setup (the button beside Env on the Maven page; main: local-setup.js): what this microservice needs running on
// this computer. An agent the user has reads a copy of the repository, following a skill, and answers with a list. Each
// one here says what uses it, how it is now (the app looks: its container, or its port), the values it needs, and how to
// start it: Start does it (the agent only reads; it is the app that runs the container), Copy gives the same commands
// for a terminal. A PostgreSQL gets its database from New database, filled in. The variables go to Env with one button. --
const LS_KINDS = { database: 'Database', cache: 'Cache', messaging: 'Messaging', identity: 'Identity', storage: 'Storage', search: 'Search', service: 'Service', other: 'Other' };
// who the code goes to, by the agent: said before it does
const LS_PROVIDERS = { claude: 'Anthropic', copilot: 'GitHub' };
const LS_SECRET_SHOWN = '••••••••';

// repo, folder: the microservice shown. setup: the answer kept for it. states: how each one is now, by id. open: those
// unfolded. busy: those starting or stopping now. said: what each one last said, by id: { text, error }.
const ls = { repo: null, folder: '', setup: null, states: {}, engine: null, info: null, running: false, progress: '', failure: '', open: new Set(), busy: new Set(), said: {}, runs: {}, showing: new Set(), timer: 0, all: false };

const lsEl = (tag, cls = '', text = '') => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};

function lsBtn(text, title, run, cls = 'btn btn-sm') {
  const b = lsEl('button', cls, text);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', run);
  return b;
}

const lsOpen = () => {
  const modal = $('#lsModal');
  return Boolean(modal && !modal.classList.contains('hidden'));
};

function localSetupModal() {
  let modal = $('#lsModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'lsModal';
  modal.className = 'settings-overlay hidden';
  modal.innerHTML = `
    <div class="settings-card ls-card" role="dialog" aria-modal="true" aria-labelledby="lsTitle">
      <h3 id="lsTitle">Local setup</h3>
      <p class="mv-sub">What this microservice needs running on this computer. The agent only reads the code and makes the list; QuickDeck starts what you choose, in containers of this computer.</p>
      <div class="ls-bar">
        <label class="ls-field"><span>Agent</span><select id="lsAgent" class="input"></select></label>
        <label class="ls-field"><span>Skill</span><select id="lsSkill" class="input"></select></label>
        <button id="lsEditSkill" class="btn btn-sm" type="button" title="Open the SKILL.md of this skill, to change what the agent looks for">Edit</button>
        <span class="mv-gap"></span>
        <span id="lsMeta" class="ls-meta"></span>
        <button id="lsAnalyse" class="btn btn-sm" type="button">Analyse</button>
      </div>
      <div id="lsProgress" class="ls-progress hidden" role="status" aria-live="polite"></div>
      <div id="lsBody" class="ls-body">
        <p id="lsSummary" class="ls-summary hidden"></p>
        <div id="lsEngine" class="ls-engine hidden" role="status"></div>
        <div id="lsList" class="ls-list" role="list" aria-label="What it needs"></div>
      </div>
      <p id="lsNote" class="me-hint ls-note hidden"></p>
      <div class="action-row settings-actions mv-actions">
        <button id="lsToEnv" class="btn" type="button"></button>
        <span class="mv-gap"></span>
        <button id="lsStopAll" class="btn hidden" type="button" title="Stop the containers of this list that are running: what they keep stays, and Start starts them again">Stop all</button>
        <button id="lsClose" class="btn" type="button">Close</button>
        <button id="lsStartAll" class="btn btn-primary" type="button">Start all</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('.sel-menu')) {
      e.stopPropagation();
      closeLocalSetup();
    }
  });
  $('#lsClose').addEventListener('click', closeLocalSetup);
  $('#lsAnalyse').addEventListener('click', () => (ls.running ? window.localSetup.stop(ls.repo, ls.folder) : analyseLocalSetup()));
  $('#lsStartAll').addEventListener('click', startAllLocalSetup);
  $('#lsStopAll').addEventListener('click', stopAllLocalSetup);
  $('#lsToEnv').addEventListener('click', localSetupToEnv);
  $('#lsEditSkill').addEventListener('click', async () => {
    const r = await window.agent.editSkill($('#lsSkill').value);
    if (r.error) toast(r.error, 'error');
  });
  const choose = async () => {
    const r = await window.agent.setSettings({ agent: $('#lsAgent').value, localSkill: $('#lsSkill').value });
    if (r.error) {
      toast(r.error, 'error');
      return;
    }
    ls.info = { agents: r.agents, skills: r.localSkills, agent: r.agent, skill: r.localSkill };
    if (typeof agentInfo !== 'undefined' && agentInfo) agentInfo = r;
    drawLocalSetup();
  };
  $('#lsAgent').addEventListener('change', choose);
  $('#lsSkill').addEventListener('change', choose);
  return modal;
}

// -- The button on the page --

// Lit when this microservice has a list kept.
function renderLocalSetupBtn() {
  if (!mvnRepo) return;
  const repo = mvnRepo;
  window.localSetup.get(repo, mvnValuesDir).then((r) => {
    if (repo !== mvnRepo || r.error) return;
    const n = r.setup ? r.setup.dependencies.length : 0;
    const btn = $('#mvnSetupBtn');
    btn.classList.toggle('on', Boolean(r.setup));
    $('#mvnSetupLabel').textContent = r.setup ? `Local setup: ${n}` : 'Local setup';
    btn.title = r.setup
      ? `It needs ${plural(n, 'thing')} on this computer: ${r.setup.dependencies.map((d) => d.name).join(', ')}`
      : 'What this microservice needs running on this computer (database, Redis, Pub/Sub, Keycloak...): an agent reads the code, and QuickDeck starts what you choose';
  }).catch(() => {});
}

async function openLocalSetup() {
  if (!mvnRepo) return;
  const modal = localSetupModal();
  Object.assign(ls, { repo: mvnRepo, folder: mvnValuesDir || '', setup: null, states: {}, engine: null, running: false, progress: '', failure: '', open: new Set(), said: {}, runs: {}, showing: new Set(), busy: new Set() });
  modal.classList.remove('hidden');
  $('#mvnSetupBtn').setAttribute('aria-expanded', 'true');
  drawLocalSetup();
  const repo = ls.repo;
  const r = await window.localSetup.get(ls.repo, ls.folder);
  if (repo !== ls.repo || !lsOpen()) return;
  if (r.error) {
    ls.failure = r.error;
    drawLocalSetup();
    return;
  }
  ls.setup = r.setup;
  ls.info = r.info;
  ls.running = r.running;
  ls.busy = new Set(r.starting || []);
  drawLocalSetup();
  $('#lsAnalyse').focus();
  refreshLocalSetupStates();
  clearInterval(ls.timer);
  ls.timer = setInterval(() => {
    if (lsOpen() && !document.hidden) refreshLocalSetupStates();
  }, 4000);
}

function closeLocalSetup() {
  const modal = $('#lsModal');
  if (!modal || modal.classList.contains('hidden')) return;
  clearInterval(ls.timer);
  modal.classList.add('hidden');
  $('#mvnSetupBtn').setAttribute('aria-expanded', 'false');
  mvnFocusBack($('#mvnSetupBtn'));
  renderLocalSetupBtn();
}

// -- The agent --

async function analyseLocalSetup() {
  const repo = ls.repo;
  Object.assign(ls, { running: true, progress: 'Starting', failure: '' });
  drawLocalSetup();
  const r = await window.localSetup.analyse(repo, ls.folder);
  if (repo !== ls.repo) return;
  if (r.error) {
    Object.assign(ls, { running: false, failure: r.error });
    drawLocalSetup();
  }
}

function onLocalSetupEvent(e) {
  const here = e.repo === ls.repo && e.folder === ls.folder;
  if (e.type === 'done' && !lsOpen()) {
    if (e.repo === mvnRepo) renderLocalSetupBtn();
    toast(`Local setup: the list of ${e.folder || e.repo.replace(/[\\/]+$/, '').split(/[\\/]/).pop()} is ready`, 'success', { plain: true });
  }
  if (!here) return;
  if (e.type === 'progress') {
    ls.running = true;
    ls.progress = e.text;
    drawLocalSetupProgress();
  } else if (e.type === 'done') {
    Object.assign(ls, { running: false, setup: e.setup, failure: '', states: {}, said: {}, runs: {}, open: new Set(), showing: new Set() });
    drawLocalSetup();
    refreshLocalSetupStates();
  } else if (e.type === 'failed') {
    Object.assign(ls, { running: false, failure: e.code === 'stopped' ? '' : e.error });
    drawLocalSetup();
  } else if (e.type === 'dep') {
    ls.said[e.id] = { text: e.text };
    drawLocalSetupRow(e.id);
  } else if (e.type === 'dep-steps') {
    lsRunOf(e.id).steps = e.steps.map((st) => ({ ...st, detail: '', ms: 0, tail: [] }));
    drawLocalSetupRow(e.id);
  } else if (e.type === 'dep-step') {
    const run = lsRunOf(e.id);
    const st = run.steps.find((x) => x.key === e.key);
    if (!st) return;
    const changed = st.state !== e.state;
    Object.assign(st, { state: e.state, detail: e.detail, ms: e.ms });
    if (e.state !== 'run' && e.state !== 'fail') st.tail = [];
    if (changed) drawLocalSetupRow(e.id);
    else lsPatchStep(e.id, st);
  } else if (e.type === 'dep-log') {
    const run = lsRunOf(e.id);
    run.lines.push(...e.lines);
    if (run.lines.length > LS_LOG_MAX) run.lines.splice(0, run.lines.length - LS_LOG_MAX);
    const on = run.steps.find((x) => x.state === 'run');
    if (on) {
      on.tail = [...on.tail, ...e.lines.map((l) => l.text)].slice(-3);
      lsPatchStep(e.id, on);
    }
    lsAppendLines(e.id, e.lines);
  }
}

// -- How each one is now --

// One at a time. Asked while one is on its way (with what was so before): once more after it, so what this waits for is
// what is so now.
let lsAsking = null;
let lsAskNext = null;
function refreshLocalSetupStates() {
  if (!lsAsking) {
    lsAsking = askLocalSetupStates().finally(() => (lsAsking = null));
    return lsAsking;
  }
  if (!lsAskNext) {
    lsAskNext = lsAsking.then(() => {
      lsAskNext = null;
      return refreshLocalSetupStates();
    });
  }
  return lsAskNext;
}

async function askLocalSetupStates() {
  if (!ls.setup) return;
  const repo = ls.repo;
  const r = await window.localSetup.states(ls.repo, ls.folder).catch(() => null);
  if (!r || r.error || repo !== ls.repo || !lsOpen()) return;
  const before = JSON.stringify([ls.states, ls.engine]);
  ls.engine = r.engine;
  ls.states = Object.fromEntries(r.states.map((s) => [s.id, s]));
  if (JSON.stringify([ls.states, ls.engine]) !== before) {
    drawLocalSetupEngine();
    ls.setup.dependencies.forEach((d) => drawLocalSetupRow(d.id));
    drawLocalSetupFoot();
  }
}

const lsEngineName = () => (ls.engine && ls.engine.name === 'podman' ? 'Podman' : ls.engine && ls.engine.name === 'docker' ? 'Docker' : 'Docker or Podman');
const lsEngineUp = () => Boolean(ls.engine && ls.engine.running);
// What Start can do for it: nothing when it runs, when something else answers on its port, or when it has no container.
const lsCanStart = (d) => {
  const s = ls.states[d.id];
  return Boolean(d.container && s && (s.state === 'absent' || s.state === 'stopped'));
};

function lsStateOf(d) {
  const s = ls.states[d.id];
  const said = ls.said[d.id];
  if (ls.busy.has(d.id)) return { dot: 'busy', text: (said && said.text) || 'Starting' };
  if (said && said.error) return { dot: 'bad', text: 'Failed' };
  if (!s) return { dot: 'none', text: '' };
  switch (s.state) {
    case 'running': return { dot: 'good', text: 'Running' };
    case 'answering': return { dot: 'good', text: `Answers on :${d.port}${s.by ? ` (${s.by})` : ''}`, title: s.by ? `The container ${s.by} is on that port: check it is the one it expects` : 'Something on this computer is on that port: check it is the one it expects' };
    case 'stopped': return { dot: 'off', text: 'Stopped' };
    case 'absent': return { dot: 'off', text: 'Not started' };
    case 'silent': return { dot: 'off', text: `Nothing on :${d.port}` };
    default: return { dot: 'none', text: 'By hand' };
  }
}

// -- Starting and stopping --

async function startLocalSetupDep(id, opts) {
  ls.busy.add(id);
  ls.said[id] = { text: 'Starting' };
  ls.runs[id] = lsNewRun();
  drawLocalSetupRow(id);
  drawLocalSetupFoot();
  const repo = ls.repo;
  const r = await window.localSetup.startDep(ls.repo, ls.folder, id, opts).catch((e) => ({ error: e.message }));
  if (repo !== ls.repo) return r;
  ls.busy.delete(id);
  ls.said[id] = r.error ? { error: r.error } : {};
  if (r.error) ls.open.add(id);
  const run = ls.runs[id];
  if (run) {
    Object.assign(run, { finished: true, failed: Boolean(r.error), ms: Date.now() - run.startedAt });
    run.open = Boolean(r.error); // a start that went well folds its log away: Log brings it back
  }
  await refreshLocalSetupStates();
  drawLocalSetupRow(id);
  drawLocalSetupFoot();
  return r;
}

// One after the other, in the order of the list: what has to run first is first.
async function startAllLocalSetup() {
  ls.all = true;
  drawLocalSetupFoot();
  let failed = 0;
  for (const d of ls.setup.dependencies) if (lsCanStart(d) && !ls.busy.has(d.id) && lsOpen()) failed += (await startLocalSetupDep(d.id)).error ? 1 : 0;
  ls.all = false;
  drawLocalSetupFoot();
  toast(failed ? `${failed} did not start: see the list` : 'Started', failed ? 'error' : 'success', { plain: true });
}

async function stopAllLocalSetup() {
  await Promise.all(ls.setup.dependencies.filter((d) => (ls.states[d.id] || {}).state === 'running' && !ls.busy.has(d.id)).map(stopLocalSetupDep));
}

async function stopLocalSetupDep(d) {
  ls.busy.add(d.id);
  ls.said[d.id] = { text: 'Stopping' };
  drawLocalSetupRow(d.id);
  const r = await window.localSetup.stopDep(ls.repo, ls.folder, d.id).catch((e) => ({ error: e.message }));
  ls.busy.delete(d.id);
  ls.said[d.id] = r.error ? { error: r.error } : {};
  await refreshLocalSetupStates();
  drawLocalSetupRow(d.id);
  drawLocalSetupFoot();
}

async function removeLocalSetupDep(d) {
  const yes = await askConfirm(`Remove the container ${d.container.name}? What it keeps goes with it (the database, the realm...). Start makes it again, from nothing.`, { danger: true });
  if (!yes) return;
  ls.busy.add(d.id);
  ls.said[d.id] = { text: 'Removing' };
  drawLocalSetupRow(d.id);
  const r = await window.localSetup.removeDep(ls.repo, ls.folder, d.id).catch((e) => ({ error: e.message }));
  ls.busy.delete(d.id);
  ls.said[d.id] = r.error ? { error: r.error } : {};
  await refreshLocalSetupStates();
  drawLocalSetupRow(d.id);
  drawLocalSetupFoot();
}

// New database, filled in with what the agent found: for a PostgreSQL that was there already, or to see its SQL.
function localSetupNewDatabase(d) {
  const db = d.database;
  openNewDatabase({ database: db.name, schema: db.schema, ddlUser: db.ddlUser, ddlPassword: db.ddlPassword, dmlUser: db.dmlUser, dmlPassword: db.dmlPassword, migrations: db.migrations });
}

// -- Env --

const lsVariables = () => {
  const by = new Map();
  for (const d of ls.setup ? ls.setup.dependencies : []) for (const v of d.variables) by.set(mvnEnvKey(v.name), v);
  return [...by.values()];
};

// Those Env does not have yet, or has with another value.
const lsVariablesToAdd = () => {
  const on = new Map(mvnRunEnv.vars.filter((v) => v.enabled !== false).map((v) => [mvnEnvKey(v.name), v.value]));
  return lsVariables().filter((v) => on.get(mvnEnvKey(v.name)) !== v.value);
};

async function localSetupToEnv() {
  const add = lsVariablesToAdd();
  if (!add.length || ls.repo !== mvnRepo) return;
  const vars = mvnRunEnv.vars.map((v) => ({ ...v }));
  let changed = 0;
  for (const v of add) {
    const same = vars.find((x) => mvnEnvKey(x.name) === mvnEnvKey(v.name));
    if (same) {
      same.value = v.value;
      delete same.enabled;
      changed += 1;
    } else vars.push({ name: v.name, value: v.value });
  }
  const r = await window.maven.setRunEnv(ls.repo, { vars });
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  renderMvnEnvBtn({ runEnv: r.runEnv });
  drawLocalSetupFoot();
  toast(`${plural(add.length, 'variable')} in Env${changed ? ` (${changed} with a new value)` : ''}: Start and Debug take them`, 'success', { plain: true });
}

// -- Drawing --

function drawLocalSetup() {
  if (!$('#lsModal')) return;
  const info = ls.info;
  const name = ls.folder || (ls.repo || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  $('#lsTitle').textContent = `Local setup of ${name}`;
  const agent = $('#lsAgent');
  const skill = $('#lsSkill');
  if (info) {
    agent.replaceChildren(...info.agents.map((a) => {
      const o = new Option(a.found ? a.name : `${a.name} (not found)`, a.id);
      o.disabled = !a.found;
      return o;
    }));
    agent.value = info.agent;
    skill.replaceChildren(...info.skills.map((s) => {
      const o = new Option(s.name, s.name);
      o.title = s.description;
      return o;
    }));
    skill.value = info.skill;
  }
  agent.disabled = skill.disabled = ls.running || !info;
  $('#lsEditSkill').disabled = !info;
  const found = info && info.agents.find((a) => a.id === info.agent);
  const analyse = $('#lsAnalyse');
  analyse.textContent = ls.running ? 'Stop' : ls.setup ? 'Analyse again' : 'Analyse';
  analyse.classList.toggle('btn-primary', !ls.setup && !ls.running);
  analyse.disabled = !ls.running && !(found && found.found);
  analyse.title = found && found.found ? `The code of this microservice goes to ${LS_PROVIDERS[found.id] || 'the provider of the agent'} through ${found.name}, with your account there. What Git ignores stays here.` : 'No agent was found on this computer: install Claude CLI or Copilot CLI, and sign in once in a terminal';
  const meta = $('#lsMeta');
  meta.textContent = ls.setup && !ls.running ? `By ${ls.setup.agent}, ${lsWhen(ls.setup.at)}${ls.setup.tookMs ? ` in ${agentDuration(ls.setup.tookMs)}` : ''}` : '';
  meta.title = ls.setup ? `Skill ${ls.setup.skill}${ls.setup.model ? ` · ${ls.setup.model}` : ''}${ls.setup.tokens && ls.setup.tokens.total ? ` · ${ls.setup.tokens.total.toLocaleString('en-US')} tokens` : ''}` : '';
  drawLocalSetupProgress();
  drawLocalSetupEngine();
  const summary = $('#lsSummary');
  summary.classList.toggle('hidden', !(ls.setup && ls.setup.summary));
  summary.textContent = ls.setup ? ls.setup.summary : '';
  const list = $('#lsList');
  list.replaceChildren();
  if (ls.setup) {
    if (!ls.setup.dependencies.length && agentCouldNotRead(ls.setup.summary)) list.appendChild(lsEl('p', 'ls-empty agent-not-read', AGENT_NOT_READ_NOTE));
    else if (!ls.setup.dependencies.length) list.appendChild(lsEl('p', 'ls-empty', 'The agent found nothing it needs on this computer.'));
    for (const d of ls.setup.dependencies) list.appendChild(lsRow(d));
  } else if (!ls.running) list.appendChild(lsFirstTime(found));
  drawLocalSetupFoot();
}

const lsWhen = (at) => {
  const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / (60 * 24))} d ago`;
};

function lsFirstTime(found) {
  const box = lsEl('div', 'ls-empty');
  box.append(lsEl('p', 'ls-empty-title', 'What does it need to run here?'));
  box.append(lsEl('p', '', found && found.found
    ? `Analyse asks ${found.name} to read this microservice and list its database, cache, messaging, identity server and the rest, with the values each one needs. The code goes to ${LS_PROVIDERS[found.id] || 'the provider of the agent'}, with your account there; what Git ignores stays here.`
    : 'It takes an agent to read the code: install Claude CLI or Copilot CLI, sign in once in a terminal, and open this again.'));
  return box;
}

function drawLocalSetupProgress() {
  const box = $('#lsProgress');
  if (!box) return;
  box.classList.toggle('hidden', !(ls.running || ls.failure));
  box.classList.toggle('error', !ls.running && Boolean(ls.failure));
  box.textContent = ls.running ? `${ls.progress || 'Starting'}...` : ls.failure;
}

function drawLocalSetupEngine() {
  const box = $('#lsEngine');
  if (!box) return;
  const needs = ls.setup && ls.setup.dependencies.some((d) => d.container);
  const down = needs && ls.engine && !ls.engine.running;
  box.classList.toggle('hidden', !down);
  box.replaceChildren();
  if (!down) return;
  box.append(lsEl('span', '', ls.engine.name ? `${lsEngineName()} is not running: Start needs it.` : 'Neither Docker nor Podman was found on this computer: use the commands by hand, or install one.'));
  if (ls.engine.name) {
    const go = lsBtn(`Start ${lsEngineName()}`, 'Start it, as the Containers page does', async () => {
      go.disabled = true;
      go.textContent = 'Starting...';
      const r = await window.containers.startDesktop();
      if (r && r.error) toast(r.error, 'error');
      refreshLocalSetupStates();
    });
    box.append(go);
  }
}

function drawLocalSetupRow(id) {
  const now = document.querySelector(`.ls-row[data-id="${CSS.escape(id)}"]`);
  const d = ls.setup && ls.setup.dependencies.find((x) => x.id === id);
  if (!now || !d) return;
  const focus = document.activeElement && now.contains(document.activeElement) ? document.activeElement.dataset.act : '';
  const row = lsRow(d);
  now.replaceWith(row);
  if (focus) {
    const again = row.querySelector(`[data-act="${focus}"]`);
    (again && !again.disabled ? again : row.querySelector('.ls-fold')).focus();
  }
}

function lsRow(d) {
  const row = lsEl('div', 'ls-row');
  row.dataset.id = d.id;
  row.setAttribute('role', 'listitem');
  const open = ls.open.has(d.id);
  const state = lsStateOf(d);
  const s = ls.states[d.id];
  const head = lsEl('div', 'ls-head');
  const fold = lsEl('button', 'ls-fold');
  fold.type = 'button';
  fold.dataset.act = 'fold';
  fold.setAttribute('aria-expanded', String(open));
  fold.title = open ? 'Hide the details' : 'What it needs, and how to start it';
  const name = lsEl('span', 'ls-name', d.name);
  fold.append(lsEl('span', `ls-dot ${state.dot}`), name, lsEl('span', 'ls-kind', LS_KINDS[d.kind] || d.kind));
  if (!d.required) fold.append(lsEl('span', 'ls-kind', 'Optional'));
  fold.addEventListener('click', () => {
    if (ls.open.has(d.id)) ls.open.delete(d.id);
    else ls.open.add(d.id);
    drawLocalSetupRow(d.id);
  });
  const said = lsEl('span', `ls-state${state.dot === 'bad' ? ' error' : ''}`, state.text);
  said.title = state.title || state.text;
  head.append(fold, said);
  // the one thing to do with it now
  if (lsCanStart(d) && !ls.busy.has(d.id)) {
    const go = lsBtn('Start', `Run ${d.container.image} in a container of this computer`, () => startLocalSetupDep(d.id), 'btn btn-sm ls-start');
    go.dataset.act = 'start';
    go.disabled = !lsEngineUp();
    head.append(go);
  } else if (s && s.state === 'running' && !ls.busy.has(d.id)) {
    const stop = lsBtn('Stop', `Stop the container ${s.container}`, () => stopLocalSetupDep(d), 'btn btn-sm');
    stop.dataset.act = 'stop';
    head.append(stop);
  }
  row.append(head);
  const under = lsEl('p', 'ls-why');
  under.textContent = d.why;
  if (d.container) under.append(lsEl('span', 'ls-image', `${d.container.image}${d.port ? ` · :${d.port}` : ''}`));
  row.append(under);
  const run = ls.runs[d.id];
  const failedStep = Boolean(run && run.failed && run.steps.some((st) => st.state === 'fail')); // that step says why
  if (ls.said[d.id] && ls.said[d.id].error && !failedStep) row.append(lsEl('p', 'ls-error', ls.said[d.id].error));
  const what = lsRunEl(d);
  if (what) row.append(what);
  if (open) row.append(lsDetails(d, s));
  return row;
}

// -- What a start shows: its steps (what it is doing, and how far) and, under them, its log --

const LS_LOG_MAX = 2000;
const LS_ERROR_WORDS = /\b(errors?|failed|failure|fatal|panic|exception|denied|refused|unable|cannot|x509)\b/i;
// what a failed step means, for the ones with a proxy or a registry in the way
const LS_HINTS = [
  [/x509|certificate (signed by unknown|verify failed|is not trusted)|unknown authority|failed to verify/i, "The proxy changes the registry's certificate and the engine does not trust it. Install the certificate of your company in the Podman machine (or in Docker), then try again."],
  [/\b407\b|proxy authentication required/i, 'The proxy asks for a user and a password.'],
  [/i\/o timeout|context deadline exceeded|proxyconnect|no such host|client\.timeout|dial tcp/i, 'The engine cannot reach the registry. With a proxy in the way, the machine of the engine needs it too: the proxy of Windows alone is not enough.'],
  [/toomanyrequests|rate limit|\b429\b/i, 'The registry limits the downloads from this network. Wait, sign in to the registry, or use a mirror of your company.'],
  [/short-name resolution|did not resolve to an alias/i, 'The image name has no registry. Write it in full, for example docker.io/library/redis:7.'],
  [/manifest unknown|name unknown|repository does not exist|requested access to the resource is denied|unauthorized/i, 'The registry has no such image, or it is private: check the name and the tag.'],
  [/no space left/i, 'The engine has no more room: free some space (old images and containers) and try again.'],
  [/address already in use|port is already allocated|taken on this computer/i, 'Another program uses that port on this computer.'],
  [/cannot connect to (the )?(podman|docker)|docker daemon running|unable to connect to podman/i, 'The engine is not running: start it and try again.'],
];
const lsHint = (text) => {
  const found = LS_HINTS.find(([rx]) => rx.test(text));
  return found ? found[1] : '';
};

const lsNewRun = () => ({ steps: [], lines: [], open: true, filter: 'all', follow: true, startedAt: Date.now(), finished: false, failed: false, ms: 0 });
function lsRunOf(id) {
  if (!ls.runs[id]) ls.runs[id] = lsNewRun();
  return ls.runs[id];
}
const lsClock = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
function lsSeconds(ms) {
  if (ms < 1000) return '< 1 s';
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}
// engine: what docker or podman prints; container: its own log; app: what this window does
const lsSrcName = (src) => (src === 'engine' ? (ls.engine && ls.engine.name) || 'engine' : src);
const lsLineKind = (l) => (l.kind === 'ok' || l.kind === 'error' ? l.kind : l.src !== 'app' && LS_ERROR_WORDS.test(l.text) ? 'error' : l.src === 'engine' ? 'dim' : '');
const lsShows = (run, l) => run.filter === 'all' || (run.filter === 'steps' ? l.src === 'app' : lsLineKind(l) === 'error');
const lsFootText = (run) => `${run.follow ? 'Following' : 'Paused'} · ${run.lines.length} line${run.lines.length === 1 ? '' : 's'}${run.filter === 'all' ? '' : ` (${run.filter} shown)`}`;
const lsRowEl = (id) => document.querySelector(`.ls-row[data-id="${CSS.escape(id)}"]`);

function lsLineEl(l) {
  const el = lsEl('div', `ls-ln ${lsLineKind(l)}`.trim());
  el.append(lsEl('span', 'ls-ts', lsClock(l.ts)), lsEl('span', `ls-src ${l.src}`, lsSrcName(l.src)), lsEl('span', 'ls-tx', l.text));
  return el;
}

function lsStepEl(d, run, st) {
  const el = lsEl('div', `ls-step ${st.state}`);
  el.dataset.key = st.key;
  el.append(lsEl('span', 'ls-step-ico'));
  const name = lsEl('span', 'ls-step-name', st.label);
  if (st.detail && st.state !== 'fail') name.append(lsEl('span', 'ls-step-detail', ` · ${st.detail}`));
  el.append(name, lsEl('span', 'ls-step-ms', (st.state === 'ok' || st.state === 'fail') && st.ms ? lsSeconds(st.ms) : ''));
  if (st.state === 'run' && st.tail && st.tail.length) el.append(lsEl('div', 'ls-step-tail', st.tail.join('\n')));
  if (st.state === 'fail') {
    el.append(lsEl('div', 'ls-step-fail', st.detail));
    const hint = lsHint(`${st.detail}\n${(st.tail || []).join('\n')}`);
    if (hint) el.append(lsEl('div', 'ls-hint', hint));
    const acts = lsEl('div', 'ls-step-actions');
    const again = lsBtn('Try again', 'Start it again', () => startLocalSetupDep(d.id));
    again.disabled = ls.busy.has(d.id);
    acts.append(again, lsBtn('Copy log', 'The whole log, as text', () => lsCopyLog(run)));
    el.append(acts);
  }
  return el;
}

// One step drawn again, not the whole row: what the log says goes under the step it is about.
function lsPatchStep(id, st) {
  const run = ls.runs[id];
  const d = ls.setup && ls.setup.dependencies.find((x) => x.id === id);
  const now = lsRowEl(id) && lsRowEl(id).querySelector(`.ls-step[data-key="${CSS.escape(st.key)}"]`);
  if (run && d && now) now.replaceWith(lsStepEl(d, run, st));
}

function lsRunEl(d) {
  const run = ls.runs[d.id];
  if (!run || (!run.steps.length && !run.lines.length)) return null;
  const busy = ls.busy.has(d.id);
  const box = lsEl('div', 'ls-run');
  const head = lsEl('div', 'ls-run-head');
  const at = run.steps.findIndex((st) => st.state === 'run');
  const n = at >= 0 ? at + 1 : run.steps.filter((st) => st.state === 'ok').length + 1;
  const title = busy ? (run.steps.length ? `Step ${Math.min(n, run.steps.length)} of ${run.steps.length}` : 'Starting') : run.failed ? 'It did not start' : run.finished ? `Started in ${lsSeconds(run.ms)}` : '';
  head.append(lsEl('span', `ls-run-title${run.failed && !busy ? ' error' : ''}`, title));
  const toggle = lsBtn(run.open ? 'Hide log' : `Log (${run.lines.length})`, 'What the engine, this window and the container say', () => {
    run.open = !run.open;
    drawLocalSetupRow(d.id);
  }, 'btn btn-sm ls-log-btn');
  toggle.dataset.act = 'log';
  toggle.setAttribute('aria-expanded', String(run.open));
  head.append(toggle);
  box.append(head);
  if (busy || run.failed) {
    const steps = lsEl('div', 'ls-steps');
    for (const st of run.steps) steps.append(lsStepEl(d, run, st));
    box.append(steps);
  }
  if (run.open) box.append(lsLogEl(d, run));
  return box;
}

function lsLogEl(d, run) {
  const log = lsEl('div', 'ls-log');
  const bar = lsEl('div', 'ls-log-bar');
  for (const [id, label] of [['all', 'All'], ['steps', 'Steps'], ['errors', 'Errors']]) {
    const b = lsBtn(label, id === 'all' ? 'Every line' : id === 'steps' ? 'What this window does, step by step' : 'Only the lines that say an error', () => {
      run.filter = id;
      drawLocalSetupRow(d.id);
    }, `ls-seg${run.filter === id ? ' on' : ''}`);
    b.setAttribute('aria-pressed', String(run.filter === id));
    bar.append(b);
  }
  bar.append(lsEl('span', 'ls-log-space'));
  const body = lsEl('div', 'ls-log-body');
  const foot = lsEl('div', 'ls-log-foot', lsFootText(run));
  const follow = lsBtn('Follow', 'Keep the last line in view', () => {
    run.follow = !run.follow;
    lsFollowState(follow, foot, run);
    if (run.follow) body.scrollTop = body.scrollHeight;
  }, `ls-act${run.follow ? ' on' : ''}`);
  follow.setAttribute('aria-pressed', String(run.follow));
  const clear = lsBtn('Clear', 'Empty the log of this one', () => {
    run.lines = [];
    body.replaceChildren(lsEl('div', 'ls-ln dim', 'Nothing yet.'));
    foot.textContent = lsFootText(run);
  }, 'ls-act');
  bar.append(follow, lsBtn('Copy', 'The whole log, as text', () => lsCopyLog(run), 'ls-act'), clear);
  for (const l of run.lines) if (lsShows(run, l)) body.append(lsLineEl(l));
  if (!body.children.length) body.append(lsEl('div', 'ls-ln dim', run.lines.length ? 'No line of this kind.' : 'Nothing yet.'));
  body.addEventListener('scroll', () => {
    const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 12;
    if (atEnd !== run.follow) {
      run.follow = atEnd;
      lsFollowState(follow, foot, run);
    }
  });
  log.append(bar, body, foot);
  // drawn, then in view at the last line (when it follows)
  if (run.follow) requestAnimationFrame(() => (body.scrollTop = body.scrollHeight));
  return log;
}

function lsFollowState(button, foot, run) {
  button.classList.toggle('on', run.follow);
  button.setAttribute('aria-pressed', String(run.follow));
  foot.textContent = lsFootText(run);
}

// Lines that come while the log is open: added to it, not all of it drawn again.
function lsAppendLines(id, lines) {
  const run = ls.runs[id];
  const row = lsRowEl(id);
  if (!run || !row) return;
  const body = row.querySelector('.ls-log-body');
  if (!body) {
    const toggle = row.querySelector('.ls-log-btn');
    if (toggle && !run.open) toggle.textContent = `Log (${run.lines.length})`;
    return;
  }
  const empty = body.querySelector('.ls-ln.dim:only-child');
  if (empty && !empty.querySelector('.ls-ts')) empty.remove();
  const frag = document.createDocumentFragment();
  for (const l of lines) if (lsShows(run, l)) frag.append(lsLineEl(l));
  body.append(frag);
  while (body.children.length > LS_LOG_MAX) body.firstChild.remove();
  if (run.follow) body.scrollTop = body.scrollHeight;
  const foot = row.querySelector('.ls-log-foot');
  if (foot) foot.textContent = lsFootText(run);
}

const lsCopyLog = (run) => lsCopy(run.lines.map((l) => `${lsClock(l.ts)} ${lsSrcName(l.src)} ${l.text}`).join('\n'), false, 'The log');

function lsSection(title, ...els) {
  const box = lsEl('div', 'ls-sec');
  box.append(lsEl('div', 'ls-sec-title', title), ...els);
  return box;
}

async function lsCopy(text, secret, what) {
  const r = await (secret ? window.tools.copySecret(text) : window.tools.copy(text));
  toast(r && r.error ? r.error : `${what} copied`, r && r.error ? 'error' : 'success', { plain: true });
}

// name, value, Copy: a secret is hidden until asked for, and goes to the clipboard as a secret.
function lsValueRow(d, v, group) {
  const key = `${d.id}:${group}:${v.name}`;
  const row = lsEl('div', 'ls-value');
  const shown = !v.secret || ls.showing.has(key);
  row.append(lsEl('span', 'ls-value-name', v.name), lsEl('code', 'ls-value-text', shown ? v.value : LS_SECRET_SHOWN));
  if (v.secret) {
    row.append(lsBtn(shown ? 'Hide' : 'Show', '', () => {
      if (ls.showing.has(key)) ls.showing.delete(key);
      else ls.showing.add(key);
      drawLocalSetupRow(d.id);
    }, 'ls-link'));
  }
  const copy = lsBtn('Copy', v.secret ? 'Out of the clipboard history, and cleared from the clipboard in half a minute' : '', () => lsCopy(group === 'variables' ? `${v.name}=${v.value}` : v.value, v.secret, v.name), 'ls-link');
  row.append(copy);
  return row;
}

function lsDetails(d, s) {
  const box = lsEl('div', 'ls-details');
  if (d.settings.length) box.append(lsSection('Values', ...d.settings.map((v) => lsValueRow(d, v, 'settings'))));
  if (d.database) {
    const line = lsEl('div', 'ls-line');
    line.append(lsEl('span', 'me-hint', d.createsDatabase ? `Start creates the database ${d.database.name}, its schema and its two users in the container it makes. For a PostgreSQL that is there already:` : `The database ${d.database.name}, its schema and its two users:`));
    const open = lsBtn('New database...', 'The New database window, filled in with these values', () => localSetupNewDatabase(d));
    open.dataset.act = 'newdb';
    line.append(open);
    box.append(lsSection('Its database', line));
  }
  if (d.variables.length) box.append(lsSection('Variables it has to be given', ...d.variables.map((v) => lsValueRow(d, v, 'variables'))));
  if (d.shown) {
    const copy = lsBtn('Copy', 'All the commands, with their passwords, for a terminal: out of the clipboard history, and cleared from the clipboard in half a minute', async () => {
      const r = await window.localSetup.copy(ls.repo, ls.folder, d.id);
      toast(r.error || 'The commands were copied', r.error ? 'error' : 'success', { plain: true });
    });
    copy.dataset.act = 'copy';
    const title = lsEl('div', 'ls-sec-title ls-sec-row');
    title.append(lsEl('span', '', 'How to start it yourself'), copy);
    const lines = [d.shown.run];
    if (d.shown.ready) lines.push('', '# When this works, it is ready', d.shown.ready);
    const after = d.shown.steps;
    if (after.length) lines.push('', '# Then', ...after.flatMap((x) => (x.title ? [`# ${x.title}`, x.line] : [x.line])));
    const pre = lsEl('pre', 'mc-command ls-command', lines.join('\n'));
    const sec = lsEl('div', 'ls-sec');
    sec.append(title, pre);
    if (s && s.state === 'running' && (after.length || d.createsDatabase) && !ls.busy.has(d.id)) {
      const again = lsEl('div', 'ls-line');
      again.append(lsEl('span', 'me-hint', 'Start ran these when it made the container.'));
      const run = lsBtn('Run them again', 'For when one failed: what is there already may say so', () => startLocalSetupDep(d.id, { stepsOnly: true }));
      run.dataset.act = 'steps';
      again.append(run);
      sec.append(again);
    }
    box.append(sec);
  }
  if (d.byHand.length) {
    const list = lsEl('ol', 'ls-hand');
    for (const t of d.byHand) list.append(lsEl('li', '', t));
    box.append(lsSection('By hand', list));
  }
  if (d.found.length) box.append(lsSection('Found in', lsEl('p', 'ls-found', d.found.map((f) => `${f.file}${f.line ? `:${f.line}` : ''}`).join(' · '))));
  if (s && s.made && !ls.busy.has(d.id)) {
    const line = lsEl('div', 'ls-line');
    line.append(lsEl('span', 'me-hint', `The container ${s.container} was made here.`));
    const remove = lsBtn('Remove', 'Take the container away, with what it keeps', () => removeLocalSetupDep(d));
    remove.dataset.act = 'remove';
    line.append(remove);
    box.append(line);
  }
  return box;
}

function drawLocalSetupFoot() {
  if (!$('#lsToEnv')) return;
  const deps = ls.setup ? ls.setup.dependencies : [];
  const can = deps.filter((d) => lsCanStart(d) && !ls.busy.has(d.id));
  const start = $('#lsStartAll');
  start.classList.toggle('hidden', !deps.some((d) => d.container));
  start.textContent = ls.all ? 'Starting...' : can.length ? `Start all (${can.length})` : 'Start all';
  start.disabled = ls.all || !can.length || !lsEngineUp();
  start.title = can.length ? `Run ${can.map((d) => d.container.image).join(', ')}, one after the other` : 'Nothing to start';
  const stop = $('#lsStopAll');
  stop.classList.toggle('hidden', !deps.some((d) => (ls.states[d.id] || {}).state === 'running' && !ls.busy.has(d.id)));
  stop.disabled = ls.all;
  const all = lsVariables();
  const add = lsVariablesToAdd();
  const env = $('#lsToEnv');
  env.classList.toggle('hidden', !all.length);
  env.disabled = !add.length;
  env.textContent = add.length ? `Add ${plural(add.length, 'variable')} to Env` : `${plural(all.length, 'variable')} in Env`;
  env.title = add.length ? `Start and Debug take them: ${add.map((v) => v.name).join(', ')}` : 'Env has them all, with these values';
  const note = $('#lsNote');
  const inBox = $('#mvnCommand').value === 'container';
  note.classList.toggle('hidden', !(inBox && deps.length));
  note.textContent = inBox ? `Start in container has its own variables (From Env takes these), and inside it localhost is the container itself: use ${ls.engine && ls.engine.name === 'podman' ? 'host.containers.internal' : 'host.docker.internal'} for what runs here.` : '';
}

function setupLocalSetup() {
  $('#mvnSetupBtn').addEventListener('click', openLocalSetup);
  window.localSetup.onEvent(onLocalSetupEvent);
}
