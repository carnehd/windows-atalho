// -- Analyse with agent (right-click on what is selected in the console of the Maven page; main: console-analysis.js): the
// agent reads those lines and the code, and says what went wrong and what fix it proposes. It only reads: nothing is
// changed. The lines go to its provider with the passwords the app recognises hidden, as the window shows them. --
const CA_PROVIDERS = { claude: 'Anthropic', copilot: 'GitHub' };
// repo: the microservice. input: what was asked, to ask it again. sent: the lines as they went. analysis: the last answer.
const ca = { repo: null, input: null, sent: '', cut: false, agentId: '', running: false, progress: '', failure: '', analysis: null };

const caEl = (tag, cls = '', text = '') => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};

const caOpen = () => {
  const modal = $('#caModal');
  return Boolean(modal && !modal.classList.contains('hidden'));
};

function consoleAnalysisModal() {
  let modal = $('#caModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'caModal';
  modal.className = 'settings-overlay hidden';
  modal.innerHTML = `
    <div class="settings-card ls-card" role="dialog" aria-modal="true" aria-labelledby="caTitle">
      <h3 id="caTitle">Analyse the console</h3>
      <p id="caSub" class="mv-sub"></p>
      <div class="ls-bar">
        <label class="ls-field"><span>Agent</span><select id="caAgent" class="input"></select></label>
        <button id="caEditSkill" class="btn btn-sm" type="button" title="Open the SKILL.md of console-fix, to change how the agent reads the console">Edit skill</button>
        <span class="mv-gap"></span>
        <span id="caMeta" class="ls-meta"></span>
        <button id="caAgain" class="btn btn-sm" type="button">Analyse again</button>
      </div>
      <div id="caProgress" class="ls-progress hidden" role="status" aria-live="polite"></div>
      <div id="caBody" class="ls-body"></div>
      <div class="action-row settings-actions mv-actions">
        <span class="mv-gap"></span>
        <button id="caClose" class="btn" type="button">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('.sel-menu')) {
      e.stopPropagation();
      closeConsoleAnalysis();
    }
  });
  $('#caClose').addEventListener('click', closeConsoleAnalysis);
  $('#caAgain').addEventListener('click', () => (ca.running ? window.consoleAnalysis.stop(ca.repo) : startConsoleAnalysis(ca.repo, ca.input)));
  $('#caEditSkill').addEventListener('click', async () => {
    const r = await window.agent.editSkill('console-fix');
    if (r.error) toast(r.error, 'error');
  });
  $('#caAgent').addEventListener('change', async () => {
    const r = await window.agent.setSettings({ agent: $('#caAgent').value });
    if (r.error) toast(r.error, 'error');
    else if (typeof agentInfo !== 'undefined' && agentInfo) agentInfo = r;
    drawConsoleAnalysis();
  });
  return modal;
}

function closeConsoleAnalysis() {
  const modal = $('#caModal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  $('#mvnOutput').focus();
}

function showConsoleAnalysis() {
  consoleAnalysisModal().classList.remove('hidden');
  drawConsoleAnalysis();
  $('#caClose').focus();
}

// How it was started, for the agent: what the page shows of it (a command, or the image of Start in container).
function mvnHowItRan() {
  const select = $('#mvnCommand');
  const chosen = select.selectedOptions[0] ? select.selectedOptions[0].textContent.trim() : '';
  const inBox = select.value === 'container';
  return [
    mvnRun && mvnRun.command ? `The command was ${String(mvnRun.command).slice(0, 300)}.` : '',
    inBox ? `With Start in container: the microservice runs in a container${mvnContainerSpec ? ` (${mvnContainerSummary(mvnContainerSpec)})` : ''}, so localhost inside it is that container.` : chosen ? `Chosen on the page: ${chosen}.` : '',
    mvnRun && mvnRun.running ? 'It is still running.' : mvnRun && mvnRun.exitCode !== null && mvnRun.exitCode !== undefined ? `It ended with exit code ${mvnRun.exitCode}.` : '',
  ].filter(Boolean).join(' ');
}

async function startConsoleAnalysis(repo, input) {
  Object.assign(ca, { repo, input, running: true, progress: 'Starting', failure: '', analysis: null });
  showConsoleAnalysis();
  const r = await window.consoleAnalysis.start(repo, input);
  if (r.error) Object.assign(ca, { running: false, failure: r.error });
  else Object.assign(ca, { sent: r.text, cut: r.cut, agentId: r.agentId });
  drawConsoleAnalysis();
}

function onConsoleAnalysisEvent(e) {
  if (e.repo !== ca.repo) return;
  if (e.type === 'progress') {
    ca.running = true;
    ca.progress = e.text;
    drawConsoleAnalysisProgress();
    return;
  }
  if (e.type === 'done') {
    Object.assign(ca, { running: false, analysis: e.analysis, failure: '' });
    if (!caOpen()) toast('The analysis of the console is ready: right-click in the console to see it', 'success', { plain: true });
  } else if (e.type === 'failed') {
    Object.assign(ca, { running: false, failure: e.code === 'stopped' ? '' : e.error });
    if (!caOpen() && ca.failure) toast(ca.failure, 'error', { plain: true });
  }
  if (caOpen()) drawConsoleAnalysis();
}

function drawConsoleAnalysisProgress() {
  const box = $('#caProgress');
  if (!box) return;
  box.classList.toggle('hidden', !(ca.running || ca.failure));
  box.classList.toggle('error', !ca.running && Boolean(ca.failure));
  box.textContent = ca.running ? `${ca.progress || 'Starting'}...` : ca.failure;
}

async function caCopy(text, what) {
  const r = await window.tools.copy(text);
  toast(r && r.error ? r.error : `${what} copied`, r && r.error ? 'error' : 'success', { plain: true });
}

function caSection(title, ...els) {
  const box = caEl('div', 'ca-sec');
  box.append(caEl('div', 'ls-sec-title', title), ...els);
  return box;
}

function caFix(f, first) {
  const box = caEl('div', 'ca-fix');
  const head = caEl('div', 'ca-fix-head');
  head.append(caEl('span', 'ca-fix-title', f.title));
  box.append(head);
  if (f.file) box.append(caEl('div', 'ca-where', `${f.file}${f.line ? `:${f.line}` : ''}`));
  if (f.detail) box.append(caEl('p', 'ca-text', f.detail));
  if (f.suggestion) {
    const bar = caEl('div', 'ls-sec-row ca-code-head');
    const copy = caEl('button', 'btn btn-sm', 'Copy');
    copy.type = 'button';
    copy.title = 'Copy what it proposes';
    copy.addEventListener('click', () => caCopy(f.suggestion, 'The proposal'));
    bar.append(caEl('span', 'ls-sec-title', first ? 'What it proposes' : 'Or'), copy);
    box.append(bar, caEl('pre', 'mc-command ls-command', f.suggestion));
  }
  return box;
}

function drawConsoleAnalysis() {
  if (!$('#caModal')) return;
  const again = $('#caAgain');
  again.textContent = ca.running ? 'Stop' : 'Analyse again';
  again.disabled = !ca.running && !ca.input;
  window.agent.info().then((info) => {
    if (info.error || !caOpen()) return;
    const agent = $('#caAgent');
    agent.replaceChildren(...info.agents.map((a) => {
      const o = new Option(a.found ? a.name : `${a.name} (not found)`, a.id);
      o.disabled = !a.found;
      return o;
    }));
    agent.value = info.agent;
    agent.disabled = ca.running;
    $('#caSub').textContent = `The agent reads the lines selected and the code of this microservice, and proposes a fix: it changes nothing. They go to ${CA_PROVIDERS[info.agent] || 'the provider of the agent'}, with your account there, without the passwords Git Quick recognises and what Git ignores.`;
  }).catch(() => {});
  const a = ca.analysis;
  const meta = $('#caMeta');
  meta.textContent = a && !ca.running ? `By ${a.agent}, in ${agentDuration(a.tookMs)}` : '';
  meta.title = a ? `Skill console-fix${a.model ? ` · ${a.model}` : ''}${a.tokens && a.tokens.total ? ` · ${a.tokens.total.toLocaleString('en-US')} tokens` : ''}` : '';
  drawConsoleAnalysisProgress();
  const body = $('#caBody');
  body.replaceChildren();
  if (a) {
    if (a.problem) body.append(caSection('The problem', caEl('p', 'ca-text ca-lead', a.problem)));
    if (a.cause) body.append(caSection('Why', caEl('p', 'ca-text', a.cause)));
    if (a.fixes.length) {
      body.append(caSection(a.fixes.length > 1 ? 'Proposed fixes, the first one first' : 'Proposed fix', ...a.fixes.map((f, i) => caFix(f, i === 0))));
    }
    if (a.unsure) body.append(caSection('What it could not tell', caEl('p', 'ca-text', a.unsure)));
    body.append(caEl('p', 'me-hint ca-nothing', 'Nothing was changed: taking it is up to you.'));
  }
  if (ca.sent) {
    const read = caEl('details', 'ca-read');
    const lines = ca.sent.split('\n').length;
    read.append(caEl('summary', '', `The ${plural(lines, 'line')} it was given${ca.cut ? ' (the last ones of what you selected)' : ''}`), caEl('pre', 'mc-command ls-command', ca.sent));
    body.append(read);
  }
}

// A right-click in the console: Copy and Analyse with what is selected. The menu is there without a selection too, to
// say what it takes; with an analysis made, it can show it again.
async function openConsoleMenu(e) {
  const out = $('#mvnOutput');
  const sel = window.getSelection();
  const inside = sel && !sel.isCollapsed && out.contains(sel.anchorNode) && out.contains(sel.focusNode);
  const text = inside ? sel.toString() : '';
  e.preventDefault();
  const { clientX: x, clientY: y } = e;
  const repo = mvnRepo;
  const info = await window.agent.info().catch(() => null);
  const agent = info && !info.error ? info.agents.find((a) => a.id === info.agent) : null;
  const provider = agent ? CA_PROVIDERS[agent.id] || 'the provider of the agent' : '';
  const items = [];
  if (text.trim()) items.push({ label: 'Copy', icon: 'copy', run: () => caCopy(text, 'Text') });
  items.push({
    label: 'Analyse with agent',
    icon: 'agent',
    disabled: !text.trim() || !agent || !agent.found || (ca.running && ca.repo === repo),
    hint: !agent || !agent.found ? 'No agent was found on this computer: install Claude CLI or Copilot CLI, and sign in once in a terminal'
      : !text.trim() ? 'Select the lines first'
        : ca.running && ca.repo === repo ? 'An analysis is going on'
          : `${agent.name} reads them and the code, and proposes a fix. They go to ${provider}`,
    run: () => startConsoleAnalysis(repo, { text, how: mvnHowItRan(), folder: mvnValuesDir || '' }),
  });
  if (ca.repo === repo && (ca.analysis || ca.running)) items.push({ label: ca.running ? 'Show the analysis going on' : 'Show the last analysis', icon: 'agent', run: showConsoleAnalysis });
  openActionMenu({ x, y, items });
}

function setupConsoleAnalysis() {
  $('#mvnOutput').addEventListener('contextmenu', openConsoleMenu);
  window.consoleAnalysis.onEvent(onConsoleAnalysisEvent);
}
