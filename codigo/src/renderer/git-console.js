// -- The Git panel at the bottom of the window: every git command the app runs, as a terminal shows it, and a line to
// type your own --
// When, in which repository, whether it goes to the network (a remote) or stays on this disk, the command, and how
// long it took or how it failed. Closed it is one line with the last
// command; open, the list (the last GC_MAX), which its top edge makes taller or shorter. Open or not, and how tall,
// are kept on this PC.
const GC_MAX = 1000;
const GC_KEY = 'gitConsole';
const GC_MIN_H = 80;
let gcEntries = []; // oldest first
const gcById = new Map();
let gcOpen = false;
let gcHeight = 220;

function gcClock(ms) {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

// The repository a folder is in (the deepest one, for a repository inside another); its folder name otherwise.
function gcRepoName(cwd) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const at = norm(cwd);
  let best = null;
  for (const r of repos) {
    const p = norm(r.path);
    if ((at === p || at.startsWith(`${p}/`)) && (!best || p.length > norm(best.path).length)) best = r;
  }
  return best ? displayName(best) : repoName(cwd || '');
}

function gcOutcome(e) {
  const took = e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)} s` : `${e.ms} ms`;
  if (e.running) return { text: 'running...', cls: 'run' };
  if (e.error) return { text: e.error, cls: 'fail' };
  if (e.signal) return { text: `stopped, ${took}`, cls: 'fail' };
  // exit 1 is how Git says no (no merge going on, no such branch, the files differ): an answer, not a failure
  if (e.code === 1) return { text: `exit 1, ${took}`, cls: '', note: 'Exit 1: Git answered no (no such branch or ref, the files differ...), which is not an error' };
  if (e.code) return { text: `exit ${e.code}, ${took}`, cls: 'fail' };
  return { text: took, cls: '' };
}

function gcRow(e) {
  const row = document.createElement('div');
  row.dataset.id = e.id;
  const time = document.createElement('span');
  time.className = 'gc-time';
  const repo = document.createElement('span');
  repo.className = 'gc-repo';
  const where = document.createElement('span');
  where.className = 'gc-where';
  const cmd = document.createElement('span');
  cmd.className = 'gc-cmd';
  const out = document.createElement('span');
  out.className = 'gc-out';
  row.append(time, repo, where, cmd, out);
  gcFillRow(row, e);
  return row;
}

function gcFillRow(row, e) {
  const o = gcOutcome(e);
  const typed = Boolean(e.typed || gcTyped.has(e.id));
  row.className = `gc-row${o.cls ? ` ${o.cls}` : ''}${typed ? ' typed' : ''}`;
  row.title = [new Date(e.at).toLocaleString(), e.cwd, o.note].filter(Boolean).join('\n');
  const [time, repo, where, cmd, out] = row.children;
  time.textContent = gcClock(e.at);
  repo.textContent = gcRepoName(e.cwd);
  where.textContent = e.network ? 'network' : 'local';
  where.classList.toggle('net', Boolean(e.network));
  where.title = e.network ? 'Talks to the remote (origin): goes over the network' : 'Reads or writes the repository on this disk only: no network';
  cmd.textContent = e.command;
  out.textContent = o.text;
  if (typed) gcFillOutput(row, e.id);
}

// -- The line at the foot of the panel: a git command typed there runs in the repository on show (git itself, no
// shell), listed like the others and marked, with its output under it. One at a time; Up and Down go through the last
// ones (kept on this PC), Ctrl+C stops it, "clear" empties the list. --
const GC_TYPED_MAX = 200000; // of the output of one command, its end kept
const GC_HISTORY_KEY = 'gitConsoleHistory';
const GC_ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const gcTyped = new Map(); // entry id -> its output
let gcTypedRun = null; // { id, repo }
let gcHistory = [];
let gcHistoryAt = -1;

function gcFillOutput(row, id) {
  let pre = row.querySelector('.gc-output');
  if (!pre) {
    pre = document.createElement('pre');
    pre.className = 'gc-output';
    row.appendChild(pre);
  }
  pre.textContent = gcTyped.get(id) || '';
  pre.classList.toggle('hidden', !pre.textContent);
}

// Where a command typed now runs, and whether one is running.
function gcRenderPrompt() {
  const where = $('#gcWhere');
  const entry = currentRepo && repos.find((r) => r.path === currentRepo);
  where.textContent = currentRepo ? (entry ? displayName(entry) : repoName(currentRepo)) : 'no repository';
  where.title = currentRepo ? `Runs in ${currentRepo}` : 'Choose a repository in Git first';
  $('#gcStop').classList.toggle('hidden', !gcTypedRun);
  $('#gcInput').placeholder = gcTypedRun ? 'Running... Ctrl+C stops it' : 'status, log --oneline -10, switch develop...  (Up for the last ones)';
}

function gcSaveHistory() {
  try {
    localStorage.setItem(GC_HISTORY_KEY, JSON.stringify(gcHistory));
  } catch {
    // only until the app closes
  }
}

async function gcRunTyped() {
  const input = $('#gcInput');
  const text = input.value.trim();
  if (!text) return;
  if (/^(clear|cls)$/i.test(text)) {
    input.value = '';
    $('#gitConsoleClear').click();
    return;
  }
  if (gcTypedRun) {
    toast('A git command is still running: Ctrl+C stops it', 'info', { plain: true });
    return;
  }
  const repo = currentRepo;
  if (!repo) {
    toast('Choose a repository in Git first', 'info', { plain: true });
    return;
  }
  const r = await window.terminal.git(repo, text);
  if (r.error) {
    toast(r.error, 'error', { plain: true });
    return;
  }
  gcTypedRun = { id: r.id, repo };
  if (!gcTyped.has(r.id)) gcTyped.set(r.id, '');
  gcHistory = [text, ...gcHistory.filter((h) => h !== text)].slice(0, 50);
  gcHistoryAt = -1;
  gcSaveHistory();
  input.value = '';
  gcRenderPrompt();
  const list = $('#gitConsoleList');
  list.scrollTop = list.scrollHeight;
}

function gcTypedOutput({ id, text }) {
  const all = (gcTyped.get(id) || '') + String(text).replace(GC_ANSI, '');
  gcTyped.set(id, all.length > GC_TYPED_MAX ? all.slice(-GC_TYPED_MAX) : all);
  if (!gcOpen) return;
  const list = $('#gitConsoleList');
  const stick = gcAtBottom(list);
  const row = list.querySelector(`.gc-row[data-id="${id}"]`);
  if (row) gcFillOutput(row, id);
  if (stick) list.scrollTop = list.scrollHeight;
}

// It ended: what it changed shows (the page of the repository, or its line in the list).
function gcTypedExit({ id, repo }) {
  if (gcTypedRun && gcTypedRun.id === id) gcTypedRun = null;
  gcRenderPrompt();
  if (repo === currentRepo && currentMode === 'git') refresh();
  else refreshSummaries([repo]);
}

function setupGitPrompt() {
  try {
    const saved = JSON.parse(localStorage.getItem(GC_HISTORY_KEY) || '[]');
    if (Array.isArray(saved)) gcHistory = saved.filter((h) => typeof h === 'string').slice(0, 50);
  } catch {
    // none yet
  }
  const input = $('#gcInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      gcRunTyped();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!gcHistory.length) return;
      e.preventDefault();
      gcHistoryAt = Math.max(-1, Math.min(gcHistory.length - 1, gcHistoryAt + (e.key === 'ArrowUp' ? 1 : -1)));
      input.value = gcHistoryAt === -1 ? '' : gcHistory[gcHistoryAt];
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (e.key === 'c' && e.ctrlKey && !e.metaKey && gcTypedRun && input.selectionStart === input.selectionEnd) {
      e.preventDefault();
      window.terminal.gitStop();
    } else if (e.key === 'Escape') {
      input.blur();
    }
  });
  $('#gcStop').addEventListener('click', () => window.terminal.gitStop());
  $('#gitConsoleTyped').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    $('#gitConsoleList').classList.toggle('only-typed', on);
  });
  window.terminal.onGitOutput(gcTypedOutput);
  window.terminal.onGitExit(gcTypedExit);
  // Ctrl+` from anywhere: the panel open, the cursor on the line
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Backquote') {
      e.preventDefault();
      if (!gcOpen) gcSetOpen(true);
      input.focus();
    }
  });
}

// "log" of "git -c core.quotepath=off log --graph ...": the git command itself, without the options before it
function gcVerb(command) {
  const words = String(command).split(/\s+/);
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i += words[i] === '-c' || words[i] === '-C' ? 2 : 1;
  return words[i] || '';
}

// -- While a git command runs: a bar moving along the foot of the top bar, and next to the page's name what runs. It
// shows once git has run GIT_BUSY_DELAY_MS, so the many quick commands never show it, and once shown it stays at
// least GIT_BUSY_MIN_MS, so it does not blink. --
const GIT_BUSY_DELAY_MS = 150;
const GIT_BUSY_MIN_MS = 400;
let gitBusySince = 0;
let gitBusyShow = null;
let gitBusyHide = null;

function gitBusySet(on) {
  $('#gitBusy').classList.toggle('hidden', !on);
  $('#gitBusyBar').classList.toggle('hidden', !on);
  if (on) gitBusySince = Date.now();
}

function gitBusyRender() {
  const box = $('#gitBusy');
  const shown = !box.classList.contains('hidden');
  const running = gcEntries.filter((e) => e.running);
  if (running.length) {
    clearTimeout(gitBusyHide);
    gitBusyHide = null;
    const e = running[0];
    $('#gitBusyText').textContent = running.length === 1 ? `git ${gcVerb(e.command)} · ${gcRepoName(e.cwd)}` : `${running.length} git commands`;
    box.title = `Running:\n${running.map((x) => `${x.command}  ·  ${gcRepoName(x.cwd)}`).join('\n')}`;
    if (!shown && !gitBusyShow) {
      gitBusyShow = setTimeout(() => {
        gitBusyShow = null;
        if (gcEntries.some((x) => x.running)) gitBusySet(true);
      }, GIT_BUSY_DELAY_MS);
    }
    return;
  }
  clearTimeout(gitBusyShow);
  gitBusyShow = null;
  if (!shown || gitBusyHide) return;
  gitBusyHide = setTimeout(() => {
    gitBusyHide = null;
    gitBusySet(false);
  }, Math.max(0, GIT_BUSY_MIN_MS - (Date.now() - gitBusySince)));
}

function gcRenderBar() {
  gitBusyRender();
  gcRenderPrompt();
  $('#gitConsoleCount').textContent = String(gcEntries.length);
  const running = gcEntries.filter((e) => e.running).length;
  const dot = $('#gitConsoleDot');
  dot.classList.toggle('hidden', !running);
  dot.title = running ? `${running} running` : '';
  const last = $('#gitConsoleLast');
  const e = gcEntries[gcEntries.length - 1];
  if (!e) {
    last.textContent = 'No git command yet';
    last.className = 'git-console-last';
    return;
  }
  const o = gcOutcome(e);
  last.textContent = `${e.network ? 'network' : 'local'}  ·  ${e.command}  ·  ${gcRepoName(e.cwd)}  ·  ${o.text}`;
  last.className = `git-console-last${o.cls ? ` ${o.cls}` : ''}`;
}

const gcAtBottom = (list) => list.scrollHeight - list.scrollTop - list.clientHeight < 24;

function gcRenderList() {
  const list = $('#gitConsoleList');
  list.textContent = '';
  if (!gcEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'gc-empty';
    empty.textContent = 'No git command yet. Each one the app runs shows here.';
    list.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  gcEntries.forEach((e) => frag.appendChild(gcRow(e)));
  list.appendChild(frag);
  list.scrollTop = list.scrollHeight;
}

// New commands, and the ones that ended: added or changed in place; the list stays at the end while it is there.
function gcReceive(batch) {
  const list = $('#gitConsoleList');
  const stick = gcOpen && gcAtBottom(list);
  let added = false;
  for (const e of batch) {
    const known = gcById.get(e.id);
    if (known) {
      Object.assign(known, e);
      if (gcOpen) {
        const row = list.querySelector(`.gc-row[data-id="${e.id}"]`);
        if (row) gcFillRow(row, known);
      }
      continue;
    }
    gcEntries.push(e);
    gcById.set(e.id, e);
    added = true;
    if (gcOpen) {
      const empty = list.querySelector('.gc-empty');
      if (empty) empty.remove();
      list.appendChild(gcRow(e));
    }
  }
  while (gcEntries.length > GC_MAX) {
    const old = gcEntries.shift();
    gcById.delete(old.id);
    if (gcOpen && list.firstElementChild) list.firstElementChild.remove();
  }
  if (added && stick) list.scrollTop = list.scrollHeight;
  gcRenderBar();
}

// What the page leaves for it: the toasts sit above it.
function gcSpace() {
  document.documentElement.style.setProperty('--git-console-h', `${$('#gitConsole').offsetHeight}px`);
}

function gcSave() {
  try {
    localStorage.setItem(GC_KEY, JSON.stringify({ open: gcOpen, height: gcHeight }));
  } catch {
    // kept for this run only
  }
}

const gcMaxHeight = () => Math.max(GC_MIN_H, Math.round(window.innerHeight * 0.7));

function gcApplyHeight() {
  $('#gitConsoleList').style.height = `${Math.min(gcHeight, gcMaxHeight())}px`;
  gcSpace();
}

function gcSetOpen(on) {
  gcOpen = on;
  $('#gitConsole').classList.toggle('open', on);
  $('#gitConsoleToggle').setAttribute('aria-expanded', String(on));
  $('#gitConsoleToggle').title = on ? 'Hide the list' : 'Show every git command the app runs, and type your own (Ctrl+`)';
  $('#gitConsoleList').classList.toggle('hidden', !on);
  $('#gitConsoleActions').classList.toggle('hidden', !on);
  $('#gitConsoleResizer').classList.toggle('hidden', !on);
  $('#gcPrompt').classList.toggle('hidden', !on);
  if (on) {
    gcApplyHeight(); // first, so the list opens at its end
    gcRenderList();
  } else {
    $('#gitConsoleList').textContent = '';
    gcSpace();
  }
  gcSave();
}

function setupGitConsoleResize() {
  const handle = $('#gitConsoleResizer');
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = $('#gitConsoleList').offsetHeight;
    document.body.classList.add('git-console-resizing');
    const move = (ev) => {
      gcHeight = Math.max(GC_MIN_H, Math.min(gcMaxHeight(), startH - (ev.clientY - startY)));
      gcApplyHeight();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('git-console-resizing');
      gcSave();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  window.addEventListener('resize', () => {
    if (gcOpen) gcApplyHeight();
  });
}

async function setupGitConsole() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(GC_KEY) || '{}') || {};
  } catch {
    // as it comes
  }
  if (Number(saved.height) >= GC_MIN_H) gcHeight = Math.round(Number(saved.height));
  $('#gitConsoleToggle').addEventListener('click', () => {
    gcSetOpen(!gcOpen);
    if (gcOpen) $('#gcInput').focus();
  });
  $('#gitConsoleClear').addEventListener('click', async () => {
    await window.git.clearCommandLog();
    gcEntries = [];
    gcById.clear();
    for (const id of [...gcTyped.keys()]) if (!gcTypedRun || gcTypedRun.id !== id) gcTyped.delete(id);
    gcRenderList();
    gcRenderBar();
  });
  $('#gitConsoleCopy').addEventListener('click', async () => {
    const r = await window.git.copyCommandLog();
    toast(r.error || `Copied ${plural(r.count, 'git command')}`, r.error ? 'info' : 'success');
  });
  setupGitConsoleResize();
  setupGitPrompt();
  // the commands until now (the ones at the start too), then each one as it starts and ends; what comes while the
  // first are on their way waits for them, so the list stays in order
  let early = [];
  window.git.onCommandLog((batch) => (early ? early.push(...batch) : gcReceive(batch)));
  gcReceive(await window.git.commandLog());
  const rest = early;
  early = null;
  if (rest.length) gcReceive(rest);
  gcSetOpen(Boolean(saved.open));
}
