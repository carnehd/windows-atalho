// -- Pull requests (a tab of the Git page): the pull requests of the repository on GitHub, asked with a token made
// there (the main process keeps it: the page only knows whether there is one). GitHub is asked when the tab opens,
// on Refresh and when Open, Closed or All is chosen, not on each refresh of the page. A click on one fetches its
// commits from origin and lists the files they changed, from where it split from its base (as a list, or as a tree
// of their folders); a click on a file opens the diff popup, as in the Log. Under the files, the comments of its
// conversation on GitHub and a box to add one. The comments on lines of its files show in the diff of each file,
// under their line, where a click on a line number adds one. --

// Tabler, 24x24 outline
const PR_ICONS = {
  open: '<path d="M6 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M18 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M6 8l0 8"/><path d="M11 6h5a2 2 0 0 1 2 2v8"/><path d="M14 9l-3 -3l3 -3"/>',
  draft: '<path d="M6 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M18 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M6 8v8"/><path d="M18 11h.01"/><path d="M18 6h.01"/>',
  merged: '<path d="M7 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M7 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M17 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M7 8l0 8"/><path d="M7 8a4 4 0 0 0 4 4h4"/>',
  closed: '<path d="M6 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M18 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M6 8v8"/><path d="M18 11v5"/><path d="M16 4l4 4m0 -4l-4 4"/>',
};
const PR_STATE_TEXT = { open: 'Open', draft: 'Draft: not ready to merge yet', merged: 'Merged', closed: 'Closed without merging' };
// What GitHub answers that a token (another one, or one at all) puts right: the form shows under it
const PR_TOKEN_CODES = ['no-token', 'token', 'missing', 'sso'];

const PR_FOLDERS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.5a1.5 1.5 0 0 1 1.5 -1.5h3l2 2h3.5a1.5 1.5 0 0 1 1.5 1.5v1a1.5 1.5 0 0 1 -1.5 1.5h-8.5a1.5 1.5 0 0 1 -1.5 -1.5z"/><path d="M6 10v7.5a1.5 1.5 0 0 0 1.5 1.5h3.5"/><path d="M6 14h5"/><path d="M15 14h6"/><path d="M15 19h6"/></svg>';
const PR_TALK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9h8"/><path d="M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"/></svg>';
const PR_INTO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M7 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M17 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M7 8l0 8"/><path d="M7 8a4 4 0 0 0 4 4h4"/></svg>';

// closed: the folders folded in the tree of a pull request ("number:path"); comments: number -> what GitHub said
// (list: its conversation, lines: the ones on lines of its files); lineForms: the boxes open in a diff to comment on
// a line or answer one there, by where they are -> { draft, posting, error }; reviews, runs, openFindings,
// agentFolded: what an agent found in a pull request, the ones it is reading now, the findings unfolded and the
// reviews folded away (agent-review.js); ctx: the two ends of the diff of each pull request whose files are listed
const newPrState = () => ({ repo: null, pulls: [], more: false, page: 0, loaded: false, loading: false, error: null, info: null, open: new Set(), details: new Map(), closed: new Set(), comments: new Map(), lineForms: new Map(), reviews: new Map(), runs: new Map(), openFindings: new Set(), agentFolded: new Set(), ctx: new Map(), tokenForm: false, tokenError: '', saving: false });
let prState = newPrState();
let prFilter = 'open'; // open, closed or all: kept from a repository to the next
let prQuery = '';
let prRequest = 0;
// The files of a pull request as a tree of their folders (as Changes can show them) or as a list: kept on this PC
const PR_GROUP_KEY = 'pullFilesByFolder';
let prGrouped = (() => {
  try {
    return localStorage.getItem(PR_GROUP_KEY) === '1';
  } catch {
    return false;
  }
})();

function pullsTabShown() {
  const tab = $('#gitView .tab.active');
  return Boolean(tab) && tab.dataset.tab === 'pulls' && effectiveGitView() === 'git';
}

// On each refresh of the page: another repository starts empty, and GitHub is asked only while the tab is on show
// and has nothing yet. It does not wait for the answer (the other tabs would wait with it).
function refreshPulls() {
  if (prState.repo !== currentRepo) {
    prRequest++;
    prState = { ...newPrState(), repo: currentRepo };
    renderPulls();
  }
  if (pullsTabShown() && !prState.loaded && !prState.loading) loadPulls();
}

// The first page (or the next one) of the pull requests, as the filter says.
async function loadPulls({ more = false } = {}) {
  if (!currentRepo) return;
  const repoPath = currentRepo;
  const request = ++prRequest;
  const page = more ? prState.page + 1 : 1;
  prState.loading = true;
  renderPulls();
  let got;
  try {
    got = await window.github.pulls(repoPath, { state: prFilter, page });
  } catch (e) {
    got = { error: e.message, code: 'failed' };
  }
  if (request !== prRequest || repoPath !== currentRepo) return;
  prState.loading = false;
  prState.loaded = true;
  if (got.site) prState.info = { site: got.site, owner: got.owner, repo: got.repo, hasToken: Boolean(got.hasToken) };
  if (got.error) {
    prState.error = { text: got.error, code: got.code };
    if (!more) prState.pulls = [];
    prState.more = false;
  } else {
    prState.error = null;
    prState.pulls = more ? [...prState.pulls, ...got.pulls.filter((p) => !prState.pulls.some((x) => x.number === p.number))] : got.pulls;
    prState.more = Boolean(got.more);
    prState.page = page;
    // what an open one changed is read again when it got new commits
    for (const p of prState.pulls) {
      const d = prState.details.get(p.number);
      if (d && d.sha !== p.head.sha) prState.details.delete(p.number);
    }
  }
  renderPulls();
  for (const p of prState.pulls) {
    if (!prState.open.has(p.number)) continue;
    if (!prState.details.has(p.number)) loadPullFiles(p);
    if (!more) loadPullComments(p);
  }
  if (!prState.error) loadPullReviews();
}

function pullMatches(p, q) {
  return `#${p.number} ${p.title} ${p.author} ${p.head.label} ${p.base.ref} ${p.labels.join(' ')}`.toLowerCase().includes(q);
}

function renderPulls() {
  const list = $('#prList');
  if (!list || currentMode === 'pulls') return; // the page of all of them draws its own (all-pulls.js)
  const { info, error } = prState;
  $$('#prStateSeg .seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.state === prFilter)));
  const tokenBtn = $('#prTokenBtn');
  tokenBtn.classList.toggle('hidden', !info);
  tokenBtn.classList.toggle('has-token', Boolean(info && info.hasToken));
  tokenBtn.title = info ? (info.hasToken ? `A token is kept for ${info.site}: change it or remove it` : `Set the token GitHub (${info.site}) is asked with`) : '';
  $('#prRefreshBtn').disabled = prState.loading;
  const top = list.scrollTop;
  list.textContent = '';
  const count = $('#prCount');
  count.textContent = '';
  const asksToken = Boolean(error && PR_TOKEN_CODES.includes(error.code));
  if (info && (prState.tokenForm || asksToken)) list.appendChild(pullTokenForm(asksToken ? error : null));
  if (prState.loading && !prState.pulls.length) {
    list.appendChild(noteEl(info ? `Asking ${info.site} for the pull requests of ${info.owner}/${info.repo}...` : 'Asking GitHub...'));
    return;
  }
  if (error && !asksToken) list.appendChild(noteEl(error.text));
  if (error && !prState.pulls.length) return;
  if (!prState.loaded) return;
  const q = prQuery.trim().toLowerCase();
  const shown = q ? prState.pulls.filter((p) => pullMatches(p, q)) : prState.pulls;
  const total = `${plural(prState.pulls.length, 'pull request')}${prState.more ? ' (more on GitHub)' : ''}`;
  count.textContent = q ? `${shown.length} of ${total}` : total;
  if (!prState.pulls.length) {
    const what = prFilter === 'all' ? '' : `${prFilter} `;
    list.appendChild(noteEl(`${info.owner}/${info.repo} has no ${what}pull requests on ${info.site}.`));
  } else if (!shown.length) list.appendChild(noteEl(`No pull request has "${prQuery.trim()}" in its title, number, author, branches or labels`));
  for (const p of shown) list.appendChild(pullItem(p));
  if (prState.more) {
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn btn-sm log-more';
    next.textContent = prState.loading ? 'Asking GitHub...' : 'Show more';
    next.disabled = prState.loading;
    next.addEventListener('click', () => loadPulls({ more: true }));
    list.appendChild(next);
  }
  list.scrollTop = top;
  markSelectedFile();
}

// A pull request: its state, number and title, who made it and when it last changed; under them the branch it comes
// from and, marked, the one it is merged into, then its labels. A click shows the files it changes and its comments.
// The list the pull requests are drawn in: the tab's, or the page of all of them; its pull request of that number.
const pullsHost = () => (currentMode === 'pulls' ? $('#apList') : $('#prList'));
const pullItemEl = (number) => pullsHost().querySelector(`.pr-item[data-number="${number}"]`);
const pullPart = (number, part) => {
  const item = pullItemEl(number);
  return item ? item.querySelector(part) : null;
};

// What the head of a pull request shows: the icon of its state, and its two lines. found: what an agent found in it;
// ms: the name of its microservice, at the start of the second line, where the list does not say it.
function pullHeadParts(p, found, ms = '') {
  const state = document.createElement('span');
  state.className = `pr-state ${p.state}`;
  state.title = PR_STATE_TEXT[p.state];
  state.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${PR_ICONS[p.state]}</svg>`;
  const body = document.createElement('div');
  body.className = 'log-body';
  const row = document.createElement('div');
  row.className = 'log-title-row';
  const text = document.createElement('div');
  text.className = 'log-message';
  text.title = p.title;
  text.append(diffSpan('pr-number', `#${p.number}`), ` ${p.title}`);
  const who = document.createElement('div');
  who.className = 'log-who';
  if (p.author) who.appendChild(metaTag('author', p.author, `Opened by ${p.author}${p.created ? ` on ${new Date(p.created).toLocaleString()}` : ''}`));
  const when = p.closed || p.updated;
  if (when) who.appendChild(metaTag('date', formatDate(when), `${p.state === 'merged' ? 'Merged' : p.state === 'closed' ? 'Closed' : 'Last changed'} ${new Date(when).toLocaleString()}`));
  row.append(text, who);
  const meta = document.createElement('div');
  meta.className = 'log-meta';
  if (ms) meta.appendChild(diffSpan('meta-tag ap-ms', ms));
  const from = diffSpan('meta-tag pr-from', p.head.label);
  from.title = `The branch with the changes: ${p.head.label}`;
  const into = document.createElement('span');
  into.className = 'meta-tag pr-into';
  into.title = `${p.state === 'merged' ? 'Merged' : 'To be merged'} into ${p.base.ref}`;
  into.innerHTML = PR_INTO_ICON;
  into.append('into ', diffSpan('pr-base', p.base.ref));
  meta.append(from, diffSpan('pr-arrow', '→'), into);
  if (p.state !== 'open') {
    const chip = diffSpan(`meta-tag pr-chip ${p.state}`, p.state[0].toUpperCase() + p.state.slice(1));
    chip.title = PR_STATE_TEXT[p.state];
    meta.appendChild(chip);
  }
  for (const l of p.labels) {
    const label = diffSpan('meta-tag pr-label', l);
    label.title = `Label: ${l}`;
    meta.appendChild(label);
  }
  if (found) meta.appendChild(found);
  body.append(row, meta);
  return [state, body];
}

function pullItem(p) {
  const item = document.createElement('div');
  const open = prState.open.has(p.number);
  item.className = `log-item pr-item${open ? ' open' : ''}`;
  item.dataset.number = p.number;
  const head = document.createElement('div');
  head.className = 'log-item-head';
  head.tabIndex = 0;
  head.title = 'Click to show the files this pull request changes';
  const [state, body] = pullHeadParts(p, pullAgentChip(p), allPullsMsOf(p));
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'btn btn-sm btn-icon pr-open-btn';
  link.title = `Open #${p.number} on GitHub, in the browser`;
  link.setAttribute('aria-label', link.title);
  link.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS.open}</svg>`;
  link.addEventListener('click', async (e) => {
    e.stopPropagation();
    const result = await window.github.open(currentRepo, p.number);
    if (result.error) toast(result.error, 'error', { title: `Couldn't open #${p.number}` });
  });
  head.append(state, body, ...pullAgentButtons(p), link);
  // under the head: what an agent found in it (when it was analysed), what it changes, then its comments
  const files = document.createElement('div');
  files.className = `log-files pr-files${open ? '' : ' hidden'}`;
  const agent = document.createElement('div');
  agent.className = 'pr-agent hidden';
  const changes = document.createElement('div');
  changes.className = 'pr-changes';
  const talk = document.createElement('div');
  talk.className = 'pr-comments';
  files.append(agent, changes, talk);
  if (open) {
    fillPullAgent(agent, p);
    fillPullFiles(changes, p);
    fillPullComments(talk, p);
  }
  const toggle = () => {
    const on = files.classList.toggle('hidden') === false;
    item.classList.toggle('open', on);
    if (on) {
      prState.open.add(p.number);
      fillPullAgent(agent, p);
      if (prState.details.has(p.number)) fillPullFiles(changes, p);
      else loadPullFiles(p);
      if (prState.comments.has(p.number)) fillPullComments(talk, p);
      else loadPullComments(p);
    } else prState.open.delete(p.number);
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.target !== head) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  item.append(head, files);
  return item;
}

// What a pull request changes: its commits come from origin (nothing is fetched when they are here already), then
// they are compared here from where it split from its base, as GitHub does in Files changed.
async function loadPullFiles(p) {
  const repoPath = currentRepo;
  const state = prState;
  const show = () => {
    const box = pullPart(p.number, '.pr-changes');
    if (box && state === prState && repoPath === currentRepo) fillPullFiles(box, p);
  };
  state.details.set(p.number, { loading: true, sha: p.head.sha });
  show();
  let data;
  try {
    data = await window.github.fetchPull(repoPath, p.number, p.head.sha, p.base.sha, p.base.ref);
    if (!data.error) data = await window.git.compare(repoPath, p.base.sha, p.head.sha, { mergeBase: true });
  } catch (e) {
    data = { error: e.message };
  }
  const now = state.details.get(p.number);
  if (!now || now.sha !== p.head.sha) return; // read again meanwhile, for newer commits
  state.details.set(p.number, data.error ? { error: data.error, sha: p.head.sha } : { data, sha: p.head.sha });
  show();
}

function fillPullFiles(box, p) {
  const d = prState.details.get(p.number);
  box.textContent = '';
  if (!d || d.loading) {
    box.appendChild(noteEl(`Fetching the commits of #${p.number} from origin...`));
    return;
  }
  if (d.error) {
    box.appendChild(noteEl(d.error));
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn btn-sm log-more';
    again.textContent = 'Try again';
    again.addEventListener('click', () => loadPullFiles(p));
    box.appendChild(again);
    return;
  }
  const { data } = d;
  const added = data.files.reduce((n, f) => n + (f.added || 0), 0);
  const removed = data.files.reduce((n, f) => n + (f.removed || 0), 0);
  const head = document.createElement('div');
  head.className = 'cmp-head';
  head.append(`${plural(data.files.length, 'file')} changed in ${plural(data.ahead, 'commit')}`);
  const lines = document.createElement('span');
  lines.className = 'cmp-lines';
  lines.append(diffSpan('add', `+${added}`), diffSpan('del', `−${removed}`));
  head.appendChild(lines);
  if (data.files.length) {
    const group = document.createElement('button');
    group.type = 'button';
    group.className = 'btn btn-sm btn-icon group-folders-btn pr-group-btn';
    group.setAttribute('aria-pressed', String(prGrouped));
    group.setAttribute('aria-label', 'Group by folder');
    group.title = prGrouped ? 'Show the files as a list' : 'Group the files by folder, as a tree';
    group.innerHTML = PR_FOLDERS_ICON;
    group.addEventListener('click', () => setPullsGrouped(!prGrouped));
    head.appendChild(group);
  }
  box.appendChild(head);
  if (!data.files.length) box.appendChild(noteEl('No differences in the files.'));
  const ctx = { from: data.base, to: data.to, files: data.files, fromLabel: `${p.base.ref} (${data.base.slice(0, 7)}, where #${p.number} starts)`, toLabel: `#${p.number} ${p.head.label}`, pull: { number: p.number, headSha: p.head.sha } };
  prState.ctx.set(p.number, ctx);
  if (prGrouped) pullFilesTree(box, p, changesTree(data.files), ctx, 0);
  else for (const f of data.files) box.appendChild(cmpFileRow(f, ctx));
  markPullFileTalk(p.number);
  markPullFileAgent(p.number);
  markSelectedFile();
}

// On the row of a file: how many comments its lines have on GitHub.
function markPullFileTalk(number) {
  const c = prState.comments.get(number);
  const lines = (c && c.lines) || [];
  const item = pullItemEl(number);
  for (const row of item ? item.querySelectorAll('.pr-changes .cmp-file') : []) {
    const old = row.querySelector('.pr-file-talk');
    if (old) old.remove();
    const count = lines.filter((x) => x.path === row.dataset.file).length;
    if (!count) continue;
    const chip = document.createElement('span');
    chip.className = 'pr-file-talk';
    chip.title = `${plural(count, 'comment')} on lines of this file: open it to see them, under their line`;
    chip.innerHTML = PR_TALK_ICON;
    chip.append(String(count));
    row.insertBefore(chip, row.querySelector('.cmp-lines'));
  }
}

function setPullsGrouped(on) {
  prGrouped = on;
  try {
    localStorage.setItem(PR_GROUP_KEY, on ? '1' : '0');
  } catch {
    // only for this session
  }
  for (const p of prState.pulls) {
    const box = pullPart(p.number, '.pr-changes');
    if (box && prState.open.has(p.number)) fillPullFiles(box, p);
  }
}

// The files as a tree: folders first, by name (one with only a folder in it shares its line), then the files. A
// click on a folder folds it, with its lines changed still on its row.
function pullFilesTree(box, p, node, ctx, depth) {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  for (const d of dirs) {
    const open = !prState.closed.has(`${p.number}:${d.path}`);
    box.appendChild(pullDirRow(box, p, d, depth, open));
    if (open) pullFilesTree(box, p, d, ctx, depth + 1);
  }
  for (const f of node.files) box.appendChild(pullTreeFileRow(f, ctx, depth));
}

function pullDirRow(box, p, dir, depth, open) {
  const files = filesUnder(dir);
  const row = document.createElement('div');
  row.className = `file-dir pr-dir${open ? ' open' : ''}`;
  row.dataset.dir = dir.path;
  row.tabIndex = 0;
  row.setAttribute('aria-expanded', String(open));
  row.title = `${dir.path}/: ${plural(files.length, 'file')}. Click to ${open ? 'close' : 'open'} it`;
  const name = document.createElement('span');
  name.className = 'file-path dir-name';
  name.style.setProperty('--depth', String(depth));
  name.innerHTML = '<svg class="dir-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg><svg class="dir-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5z"/></svg>';
  name.append(diffSpan('dir-label', dir.name), diffSpan('dir-count', plural(files.length, 'file')));
  const lines = document.createElement('span');
  lines.className = 'cmp-lines';
  lines.append(diffSpan('add', `+${files.reduce((n, f) => n + (f.added || 0), 0)}`), diffSpan('del', `−${files.reduce((n, f) => n + (f.removed || 0), 0)}`));
  row.append(name, lines);
  const toggle = () => {
    const key = `${p.number}:${dir.path}`;
    if (open) prState.closed.add(key);
    else prState.closed.delete(key);
    fillPullFiles(box, p);
    const again = [...box.querySelectorAll('.pr-dir')].find((r) => r.dataset.dir === dir.path);
    if (again) again.focus();
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => {
    if (e.target !== row) return;
    if (e.key === 'Enter' || e.key === ' ' || (e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) {
      e.preventDefault();
      toggle();
    }
  });
  return row;
}

// A file in the tree: its name alone, under its folder (one renamed in its folder says its old name, one moved from
// another says where it was).
function pullTreeFileRow(f, ctx, depth) {
  const row = cmpFileRow(f, ctx);
  row.classList.add('in-tree');
  const where = row.querySelector('.file-path');
  where.textContent = '';
  where.style.setProperty('--depth', String(depth));
  const slash = f.file.lastIndexOf('/');
  const base = f.file.slice(slash + 1);
  let moved = '';
  if (f.from) {
    const oldDir = f.from.slice(0, f.from.lastIndexOf('/') + 1);
    const oldBase = f.from.slice(oldDir.length);
    if (oldDir === f.file.slice(0, slash + 1)) where.append(diffSpan('fp-dir', `${oldBase} \u2192 `));
    else moved = oldBase === base ? `moved from ${oldDir || 'the top folder'}` : `moved from ${f.from}`;
  }
  where.append(diffSpan('fp-base', base));
  if (moved) where.append(diffSpan('fp-moved', moved));
  where.title = f.from ? `${f.from} -> ${f.file}` : f.file;
  return row;
}

// -- The comments of a pull request on GitHub (its conversation), oldest first, and a box to add one as the owner
// of the token. Read when it opens and on Refresh; what is being written is kept while the list is redrawn. --
async function loadPullComments(p) {
  const repoPath = currentRepo;
  const state = prState;
  const show = () => {
    const box = pullPart(p.number, '.pr-comments');
    if (box && state === prState && repoPath === currentRepo) fillPullComments(box, p);
  };
  const before = state.comments.get(p.number) || {};
  const mine = { ...before, loading: true, error: '' };
  state.comments.set(p.number, mine);
  show();
  const asked = (call) => call.catch((e) => ({ error: e.message }));
  const [got, lines] = await Promise.all([asked(window.github.comments(repoPath, p.number)), asked(window.github.lineComments(repoPath, p.number))]);
  const now = state.comments.get(p.number);
  if (!now) return;
  now.loading = false;
  if (got.error) now.error = got.error;
  else {
    now.list = got.comments;
    now.more = Boolean(got.more);
  }
  // the ones on lines of the files: an error of the first says it for both
  if (!lines.error) now.lines = lines.comments;
  show();
  if (state !== prState || repoPath !== currentRepo) return;
  markPullFileTalk(p.number);
  const shown = pullOfDiff();
  if (shown && shown.number === p.number) decoratePullDiff();
}

function fillPullComments(box, p) {
  const c = prState.comments.get(p.number);
  box.textContent = '';
  if (!c) return;
  const head = document.createElement('div');
  head.className = 'cmp-head pr-comments-head';
  head.textContent = c.list ? `${plural(c.list.length, 'comment')}${c.more ? ' (more on GitHub)' : ''}` : 'Comments';
  box.appendChild(head);
  if (c.loading && !c.list) box.appendChild(noteEl('Asking GitHub for the comments...'));
  if (c.error) box.appendChild(noteEl(c.error));
  if (c.lines && c.lines.length) box.appendChild(noteEl(`${plural(c.lines.length, 'more comment')} on lines of the files: each shows in the diff of its file, under its line.`));
  for (const one of c.list || []) box.appendChild(pullCommentEl(one));
  if (!prState.info || !prState.info.hasToken) {
    box.appendChild(noteEl('To add a comment, set a token (Token...): GitHub posts it as the owner of the token.'));
    return;
  }
  const form = document.createElement('form');
  form.className = 'pr-comment-form';
  const text = document.createElement('textarea');
  text.className = 'input pr-comment-input';
  text.rows = 3;
  text.maxLength = 65000;
  text.placeholder = `Add a comment to #${p.number} (Markdown, as on GitHub)`;
  text.setAttribute('aria-label', `A comment for #${p.number}`);
  text.value = c.draft || '';
  text.disabled = Boolean(c.posting);
  const line = document.createElement('div');
  line.className = 'pr-comment-line';
  const bad = diffSpan(`pr-token-error${c.postError ? '' : ' hidden'}`, c.postError || '');
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'btn btn-sm btn-primary';
  send.textContent = c.posting ? 'Sending...' : 'Comment';
  send.title = 'Add the comment to the pull request on GitHub (Ctrl+Enter)';
  send.disabled = Boolean(c.posting) || !text.value.trim();
  line.append(bad, send);
  form.append(text, line);
  text.addEventListener('input', () => {
    c.draft = text.value;
    c.postError = '';
    bad.classList.add('hidden');
    send.disabled = !text.value.trim();
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!send.disabled) form.requestSubmit();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendPullComment(p);
  });
  box.appendChild(form);
}

async function sendPullComment(p) {
  const repoPath = currentRepo;
  const state = prState;
  const c = state.comments.get(p.number);
  if (!c || c.posting || !(c.draft || '').trim()) return;
  const show = (focus) => {
    const box = pullPart(p.number, '.pr-comments');
    if (!box || state !== prState || repoPath !== currentRepo) return;
    fillPullComments(box, p);
    if (focus && box.querySelector('.pr-comment-input')) box.querySelector('.pr-comment-input').focus();
  };
  c.posting = true;
  c.postError = '';
  show(false);
  let result;
  try {
    result = await window.github.addComment(repoPath, p.number, c.draft);
  } catch (e) {
    result = { error: e.message };
  }
  c.posting = false;
  if (result.error) {
    c.postError = result.error;
    show(true);
    return;
  }
  c.draft = '';
  c.list = [...(c.list || []), result.comment];
  show(false);
  if (state === prState) toast(`Comment added to #${p.number}`, 'success');
}

// The token of this GitHub: typed here, checked with GitHub by the main process and kept there, encrypted. Under
// what GitHub said, when that is why it shows.
function pullTokenForm(error) {
  const { info } = prState;
  const form = document.createElement('form');
  form.className = 'pr-token';
  form.autocomplete = 'off';
  if (error) form.appendChild(diffSpan(`pr-token-why${error.code === 'no-token' ? '' : ' bad'}`, error.text));
  const label = document.createElement('label');
  label.className = 'pr-token-label';
  label.htmlFor = 'prTokenInput';
  label.textContent = `GitHub token for ${info.site}`;
  const line = document.createElement('div');
  line.className = 'pr-token-line';
  const input = document.createElement('input');
  input.id = 'prTokenInput';
  input.type = 'password';
  input.className = 'input pr-token-input';
  input.placeholder = info.hasToken ? 'A new token, in place of the one kept' : 'Paste the token here';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.maxLength = 400;
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-sm btn-primary';
  save.textContent = prState.saving ? 'Asking GitHub...' : 'Save';
  save.disabled = prState.saving;
  line.append(input, save);
  if (prState.tokenForm) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-sm';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => closePullTokenForm());
    line.appendChild(cancel);
  }
  const bad = diffSpan(`pr-token-error${prState.tokenError ? '' : ' hidden'}`, prState.tokenError);
  const hint = document.createElement('p');
  hint.className = 'settings-hint pr-token-hint';
  hint.textContent = 'Made on GitHub, in Settings > Developer settings > Personal access tokens. It needs to read this repository: a classic token with the "repo" scope, or a fine-grained one for this repository with Pull requests: Read-only (Read and write, to add comments too). '
    + `It is kept encrypted on this computer and is sent only to ${info.site}.`;
  const more = document.createElement('div');
  more.className = 'pr-token-more';
  const page = document.createElement('button');
  page.type = 'button';
  page.className = 'btn btn-sm btn-icon';
  page.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS.open}</svg>`;
  page.append('Tokens on GitHub');
  page.title = `Open the page of ${info.site} where tokens are made, in the browser`;
  page.addEventListener('click', async () => {
    const result = await window.github.openTokens(currentRepo);
    if (result.error) toast(result.error, 'error');
  });
  more.appendChild(page);
  if (info.hasToken) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-sm btn-danger';
    remove.textContent = 'Remove the token';
    remove.title = `Forget the token kept for ${info.site}`;
    remove.addEventListener('click', removePullToken);
    more.appendChild(remove);
  }
  form.append(label, line, bad, hint, more);
  input.addEventListener('input', () => {
    prState.tokenError = '';
    bad.classList.add('hidden');
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && prState.tokenForm) {
      e.preventDefault();
      e.stopPropagation();
      closePullTokenForm();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    savePullToken(input.value);
  });
  return form;
}

function closePullTokenForm() {
  prState.tokenForm = false;
  prState.tokenError = '';
  renderPulls();
  $('#prTokenBtn').focus();
}

async function savePullToken(value) {
  const token = value.trim();
  const fail = (text) => {
    prState.tokenError = text;
    renderPulls();
    const input = $('#prTokenInput');
    if (input) input.focus();
  };
  if (!token) return fail('Paste the token first.');
  const repoPath = currentRepo;
  const state = prState;
  state.saving = true;
  renderPulls();
  let result;
  try {
    result = await window.github.setToken(repoPath, token);
  } catch (e) {
    result = { error: e.message };
  }
  if (state !== prState || repoPath !== currentRepo) return;
  state.saving = false;
  if (result.error) return fail(result.error);
  state.tokenForm = false;
  state.tokenError = '';
  state.info = { ...state.info, hasToken: true };
  toast(`Token for ${state.info.site} saved`, 'success');
  return loadPulls();
}

async function removePullToken() {
  const { info } = prState;
  if (!(await askConfirm(`Remove the token kept for ${info.site}?\nThe pull requests of private repositories are not shown without one.`, { confirm: 'Remove' }))) return;
  const result = await window.github.clearToken(currentRepo);
  if (result.error) {
    toast(result.error, 'error', { title: "Couldn't remove the token" });
    return;
  }
  prState.tokenForm = false;
  prState.info = { ...info, hasToken: false };
  toast(`Token for ${info.site} removed`, 'success');
  loadPulls();
}

// -- Comments on lines, in the diff of a file of a pull request. The code stays whole: a line that has comments on
// GitHub has a marker with how many, and a click on it opens a balloon under the line with them and a box to answer.
// A click on a line number opens the same balloon to comment on that line. GitHub takes comments on the lines of its
// diff only (the changed ones and the three around them), so in the whole file the other numbers are not offered.
// The comments whose line changed since are behind a marker above the diff. --
// A file of what is about to be pushed, or of the changes with a review, comes this way too (pull.push), for the
// findings of the agent on its lines: it has no comments, and no pull request to add one to.
function pullOfDiff() {
  if (!diffFile || diffRepo !== currentRepo) return null;
  if (!diffCommit) return changesAgent.repo === currentRepo && changesAgent.review ? CHANGES_PULL : null;
  return diffCommit.pull && (diffCommit.pull.push || prState.repo === currentRepo) ? diffCommit.pull : null;
}

const pullLineKey = (pull, kind, where) => `${pull.number}|${diffFile}|${kind}|${where}`;

// The rows of the diff, in order, each with the line it is: "RIGHT:12" (the new file's line 12) or, for a removed
// line, "LEFT:12" (the old file's). A break (a hunk title, a fold) is null.
function pullDiffRows(body) {
  const box = body.querySelector('.diff-lines');
  const rows = [];
  for (const el of box ? box.children : []) {
    if (el.classList.contains('dl')) {
      const [oldNo, newNo] = [...el.querySelectorAll('.dl-no')].map((n) => n.textContent);
      const del = el.classList.contains('del');
      const key = del ? `LEFT:${oldNo}` : `RIGHT:${newNo}`;
      rows.push({ el, changed: !el.classList.contains('ctx'), keys: del || el.classList.contains('add') ? [key] : [key, `LEFT:${oldNo}`], cells: [{ el, key }] });
    } else if (el.classList.contains('ds') && el.diffRows) {
      const { left, right } = el.diffRows;
      const [a, b] = el.children;
      const cells = [];
      if (left) cells.push({ el: a, key: left.type === 'del' ? `LEFT:${left.oldNo}` : `RIGHT:${left.newNo}` });
      if (right) cells.push({ el: b, key: `RIGHT:${right.newNo}` });
      const keys = [...new Set(cells.map((c) => c.key))];
      if (left && left.type === 'ctx') keys.push(`LEFT:${left.oldNo}`);
      rows.push({ el, changed: !(left && left.type === 'ctx'), keys, cells });
    } else rows.push(null);
  }
  return rows;
}

// In the whole file: only a changed line, or one within three of it, is a line of GitHub's diff.
function markPullDiffLines(rows, all) {
  const near = new Array(rows.length).fill(all);
  if (!all) {
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i] || !rows[i].changed) continue;
      near[i] = true;
      for (const step of [-1, 1]) for (let k = 1; k <= 3 && rows[i + step * k] && !rows[i + step * k].changed; k++) near[i + step * k] = true;
    }
  }
  rows.forEach((row, i) => {
    if (!row) return;
    for (const cell of row.cells) {
      cell.el.classList.toggle('can-talk', near[i]);
      if (near[i]) cell.el.dataset.talk = cell.key;
      else delete cell.el.dataset.talk;
      for (const no of cell.el.querySelectorAll('.dl-no')) no.title = near[i] ? 'Click to comment on this line' : '';
    }
  });
}

function pullCommentEl(one, note = '') {
  const item = document.createElement('div');
  item.className = 'pr-comment';
  const who = document.createElement('div');
  who.className = 'pr-comment-who';
  who.append(diffSpan('pr-comment-author', one.author || 'someone'));
  if (one.created) {
    const when = diffSpan('pr-comment-when', `${formatDate(one.created)}${one.edited ? ' (edited)' : ''}`);
    when.title = new Date(one.created).toLocaleString();
    who.appendChild(when);
  }
  if (note) who.appendChild(diffSpan('pr-comment-when', note));
  item.append(who, diffSpan('pr-comment-text', one.body));
  return item;
}

// The box to write a comment on a line, or an answer to the ones there. What is written stays, by line (or by the
// comment it answers), while the balloon is closed and when the diff is drawn again.
function pullLineFormEl(pull, key, at, placeholder) {
  if (!prState.lineForms.has(key)) prState.lineForms.set(key, { draft: '', posting: false, error: '' });
  const state = prState.lineForms.get(key);
  const form = document.createElement('form');
  form.className = 'pr-line-form';
  form.dataset.form = key;
  const line = document.createElement('div');
  line.className = 'pr-line-form-line';
  const text = document.createElement('textarea');
  text.className = 'input pr-comment-input';
  text.rows = 1;
  text.maxLength = 65000;
  text.placeholder = placeholder;
  text.setAttribute('aria-label', placeholder);
  text.value = state.draft || '';
  text.disabled = Boolean(state.posting);
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'btn btn-sm btn-primary';
  send.textContent = state.posting ? 'Sending...' : at.replyTo ? 'Reply' : 'Comment';
  send.title = 'Add it to the pull request on GitHub (Ctrl+Enter)';
  send.disabled = Boolean(state.posting) || !text.value.trim();
  line.append(text, send);
  const bad = diffSpan(`pr-token-error${state.error ? '' : ' hidden'}`, state.error || '');
  form.append(line, bad);
  // as tall as what is written, up to a few lines
  form.fit = () => {
    text.style.height = 'auto';
    text.style.overflowY = text.scrollHeight > 138 ? 'auto' : 'hidden';
    text.style.height = `${Math.min(140, text.scrollHeight + 2)}px`;
  };
  text.addEventListener('input', () => {
    state.draft = text.value;
    state.error = '';
    bad.classList.add('hidden');
    send.disabled = !text.value.trim();
    form.fit();
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!send.disabled) form.requestSubmit();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendPullLineComment(pull, key, at);
  });
  return form;
}

// The comments on lines of the file on show, as conversations: the first on a line, then its answers.
function pullLineThreads(pull) {
  const c = prState.comments.get(pull.number);
  const mine = ((c && c.lines) || []).filter((x) => x.path === diffFile);
  return mine.filter((x) => !x.replyTo || !mine.some((y) => y.id === x.replyTo)).map((root) => [root, ...mine.filter((x) => x.replyTo === root.id)]);
}

// The balloon on show: { number, file, where }, where a line ("RIGHT:12") or "elsewhere" (lines that changed since)
let prLinePop = null;
let prFocusPop = false; // the cursor goes to its box once it is drawn
// A line to show once its file is drawn, asked from a finding of the agent: { number, file, where, line, comment }
let prPendingLine = null;

// redraw: the markers again (a line where a comment was started and not sent gets one)
function closePullLinePop(redraw = false) {
  if (!prLinePop) return;
  prLinePop = null;
  document.removeEventListener('mousedown', pullLinePopOutside, true);
  document.removeEventListener('keydown', pullLinePopKey, true);
  const pop = $('#prLinePop');
  if (pop) pop.remove();
  $$('#diffBody .pr-line-on').forEach((el) => el.classList.remove('pr-line-on'));
  if (redraw && pullOfDiff()) decoratePullDiff();
}

// A click on the marker or the number of the line whose balloon is open closes it.
function openPullLinePop(where) {
  const pull = pullOfDiff();
  if (!pull) return;
  const same = Boolean(prLinePop) && prLinePop.where === where && prLinePop.number === pull.number && prLinePop.file === diffFile;
  closePullLinePop(same);
  if (same) return;
  setPullLinePop(pull, where);
  decoratePullDiff();
}

function setPullLinePop(pull, where) {
  prLinePop = { number: pull.number, file: diffFile, where };
  document.addEventListener('mousedown', pullLinePopOutside, true);
  document.addEventListener('keydown', pullLinePopKey, true);
  prFocusPop = true;
}

function pullLinePopOutside(e) {
  if (e.target.closest && e.target.closest('#prLinePop, .pr-line-mark, .can-comment .can-talk .dl-no')) return;
  closePullLinePop(true);
}

// Esc closes the balloon, not the diff under it
function pullLinePopKey(e) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  closePullLinePop(true);
}

function pullLineMarkEl(where, count, title) {
  const mark = document.createElement('button');
  mark.type = 'button';
  mark.className = `pr-line-mark${count ? '' : ' draft'}`;
  mark.dataset.where = where;
  mark.title = title || (count ? `${plural(count, 'comment')} on this line: click to read ${count === 1 ? 'it' : 'them'} and answer` : 'A comment you started on this line: click to go on');
  mark.innerHTML = PR_TALK_ICON;
  mark.append(count ? String(count) : '…');
  mark.addEventListener('click', (e) => {
    e.stopPropagation();
    openPullLinePop(where);
  });
  return mark;
}

// The balloon: under its line, its right edge at the line's. What the agent found on the line, then its comments,
// each conversation with its box to answer; with no comments yet, the box for the first.
function showPullLinePop(body, pull, anchor, threads, findings, canWrite) {
  const { where } = prLinePop;
  const [side, line] = where.split(':');
  const count = threads.reduce((n, t) => n + t.length, 0);
  const canComment = canWrite && (threads.length > 0 || anchor.classList.contains('can-talk'));
  const what = where === 'elsewhere' ? 'Lines that changed since' : `Line ${line}${side === 'LEFT' ? ' (as it was)' : ''}`;
  const pop = document.createElement('div');
  pop.id = 'prLinePop';
  pop.className = 'pr-line-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', what);
  const head = document.createElement('div');
  head.className = 'pr-line-pop-head';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-action pr-line-pop-close';
  close.title = 'Close (Esc)';
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>';
  close.addEventListener('click', () => closePullLinePop(true));
  const has = [findings.length ? plural(findings.length, 'finding') : '', count ? plural(count, 'comment') : ''].filter(Boolean).join(', ');
  head.append(diffSpan('', `${what} · ${has || 'new comment'}`), close);
  const list = document.createElement('div');
  list.className = 'pr-line-pop-list';
  for (const f of findings) list.appendChild(pullLineFindingEl(pull, f, where, canComment));
  for (const thread of threads) {
    const [root] = thread;
    const note = where === 'elsewhere' ? (root.originalLine ? `was on line ${root.originalLine}` : '') : root.startLine && root.startLine !== root.line ? `lines ${root.startLine} to ${root.line}` : '';
    thread.forEach((one, i) => list.appendChild(pullCommentEl(one, i === 0 ? note : '')));
    if (canWrite) list.appendChild(pullLineFormEl(pull, pullLineKey(pull, 'r', root.id), { replyTo: root.id }, 'Reply...'));
  }
  if (!threads.length && canComment) list.appendChild(pullLineFormEl(pull, pullLineKey(pull, 'n', where), { side, line: Number(line) }, `Comment on line ${line}${side === 'LEFT' ? ' (as it was)' : ''}`));
  else if (threads.length && !canWrite) list.appendChild(diffSpan('pr-line-pop-note', 'To answer, set a token (Token...).'));
  pop.append(head, list);
  anchor.classList.add('pr-line-on');
  body.appendChild(pop);
  const b = body.getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  const right = a.right - b.left + body.scrollLeft - 8;
  pop.style.left = `${Math.round(where === 'elsewhere' ? 8 : Math.max(8, right - pop.offsetWidth))}px`;
  pop.style.top = `${Math.round(a.bottom - b.top + body.scrollTop + 4)}px`;
  pop.querySelectorAll('.pr-line-form').forEach((f) => f.fit());
  if (!findings.length) list.scrollTop = list.scrollHeight;
  if (!prFocusPop) return;
  prFocusPop = false;
  pop.scrollIntoView({ block: 'nearest' });
  const boxes = pop.querySelectorAll('textarea');
  if (boxes.length) boxes[boxes.length - 1].focus();
}

// Called each time the diff popup draws a file (app.js) and when the comments change.
function decoratePullDiff() {
  const body = $('#diffBody');
  body.querySelectorAll('.pr-line-mark, .pr-line-elsewhere, #prLinePop').forEach((el) => el.remove());
  body.querySelectorAll('.has-talk, .pr-line-on').forEach((el) => el.classList.remove('has-talk', 'pr-line-on'));
  const pull = pullOfDiff();
  const canWrite = Boolean(pull && !pull.push && prState.info && prState.info.hasToken);
  body.classList.toggle('can-comment', canWrite);
  const rows = pull ? pullDiffRows(body) : [];
  if (!pull || !rows.length || (prLinePop && (prLinePop.number !== pull.number || prLinePop.file !== diffFile))) closePullLinePop();
  if (!pull || !rows.length) return;
  if (!pull.push) markPullDiffLines(rows, !diffFull);
  // where a line is: its row, and in two columns the cell of its side
  const byKey = new Map();
  for (const row of rows) {
    if (!row) continue;
    for (const key of row.keys) {
      if (byKey.has(key)) continue;
      const cells = key.startsWith('LEFT') ? row.cells : [...row.cells].reverse();
      byKey.set(key, cells.find((c) => c.key === key) || cells[0]);
    }
  }
  // a line asked from a finding of the agent: its balloon, in the whole file when the changes alone do not have it
  if (prPendingLine && (prPendingLine.number !== pull.number || prPendingLine.file !== diffFile)) prPendingLine = null;
  if (prPendingLine) {
    const want = prPendingLine;
    if (byKey.has(want.where)) {
      prPendingLine = null;
      closePullLinePop();
      setPullLinePop(pull, want.where);
      const f = want.comment ? liveFindings(prState.reviews.get(pull.number)).find((x) => x.id === want.comment) : null;
      if (f && canWrite && byKey.get(want.where).el.classList.contains('can-talk')) setFindingDraft(pull, f, want.where);
    } else if (!diffFull && !want.tried) {
      want.tried = true;
      showWholeFile(want.line);
      return;
    } else prPendingLine = null;
  }
  const found = pullLineFindings(pull);
  const here = new Map();
  const elsewhere = [];
  for (const thread of pullLineThreads(pull)) {
    const [root] = thread;
    const where = root.line === null ? null : `${root.side}:${root.line}`;
    if (where && byKey.has(where)) here.set(where, [...(here.get(where) || []), thread]);
    else elsewhere.push(thread);
  }
  // a marker on each line with comments, and on one where a comment was started
  const marked = new Set(here.keys());
  for (const [key, form] of prState.lineForms) {
    const [number, file, kind, where] = key.split('|');
    if (Number(number) === pull.number && file === diffFile && kind === 'n' && (form.draft || '').trim() && byKey.has(where)) marked.add(where);
  }
  for (const where of found.keys()) if (byKey.has(where)) marked.add(where);
  for (const where of marked) {
    const cell = byKey.get(where).el;
    const said = (here.get(where) || []).reduce((n, t) => n + t.length, 0);
    const agent = (found.get(where) || []).length;
    const talk = said > 0 || !agent;
    cell.classList.add('has-talk');
    if (talk) cell.appendChild(pullLineMarkEl(where, said));
    if (!agent) continue;
    // the agent's marker, in its own colour, before the one of the comments
    const mark = pullLineMarkEl(where, agent, `${plural(agent, 'finding')} of the agent on this line: click to read ${agent === 1 ? 'it' : 'them'}`);
    mark.classList.add('agent');
    mark.innerHTML = AGENT_ICON;
    mark.append(String(agent));
    if (talk) {
      mark.classList.add('second');
      cell.classList.add('has-two');
    }
    cell.appendChild(mark);
  }
  if (elsewhere.length) {
    const n = elsewhere.reduce((sum, t) => sum + t.length, 0);
    const top = document.createElement('div');
    top.className = 'pr-line-elsewhere';
    top.append(pullLineMarkEl('elsewhere', n, `Click to read ${n === 1 ? 'it' : 'them'}`), `${plural(n, 'comment')} on lines that are not in this diff: the file changed after ${n === 1 ? 'it' : 'them'}`);
    body.prepend(top);
  }
  if (!prLinePop) return;
  const anchor = prLinePop.where === 'elsewhere' ? body.querySelector('.pr-line-elsewhere') : byKey.has(prLinePop.where) ? byKey.get(prLinePop.where).el : null;
  const threads = prLinePop.where === 'elsewhere' ? elsewhere : here.get(prLinePop.where) || [];
  const findings = found.get(prLinePop.where) || [];
  // nothing to show there: no such line now, or a line with no comments and no findings that takes no comment
  if (!anchor || (!threads.length && !findings.length && !(canWrite && anchor.classList.contains('can-talk')))) closePullLinePop();
  else showPullLinePop(body, pull, anchor, threads, findings, canWrite);
}

async function sendPullLineComment(pull, key, at) {
  const repoPath = currentRepo;
  const state = prState;
  const form = state.lineForms.get(key);
  if (!form || form.posting || !(form.draft || '').trim()) return;
  const [, file] = key.split('|');
  const redraw = () => {
    if (state !== prState || repoPath !== currentRepo) return;
    const shown = pullOfDiff();
    if (!shown || shown.number !== pull.number) return;
    prFocusPop = Boolean(prLinePop);
    decoratePullDiff();
  };
  form.posting = true;
  form.error = '';
  redraw();
  let result;
  try {
    result = await window.github.addLineComment(repoPath, pull.number, { ...at, path: file, commit: pull.headSha, body: form.draft });
  } catch (e) {
    result = { error: e.message };
  }
  form.posting = false;
  if (result.error) {
    form.error = result.error;
    redraw();
    return;
  }
  state.lineForms.delete(key);
  const c = state.comments.get(pull.number) || {};
  c.lines = [...(c.lines || []), result.comment];
  state.comments.set(pull.number, c);
  redraw();
  if (state !== prState) return;
  markPullFileTalk(pull.number);
  const box = pullPart(pull.number, '.pr-comments');
  const p = prState.pulls.find((x) => x.number === pull.number);
  if (box && p) fillPullComments(box, p);
  toast(at.replyTo ? `Reply added to #${pull.number}` : `Comment added to line ${at.line} of ${file.slice(file.lastIndexOf('/') + 1)}`, 'success');
}

function setupPulls() {
  setupAgentReview();
  setupAllPulls();
  // a click on a line number, in the diff of a file of a pull request: the balloon of that line, to comment on it
  $('#diffBody').addEventListener('click', (e) => {
    const no = e.target.closest ? e.target.closest('.dl-no') : null;
    const cell = no && no.closest('.can-talk');
    if (!cell || !cell.dataset.talk || !pullOfDiff() || !$('#diffBody').classList.contains('can-comment')) return;
    openPullLinePop(cell.dataset.talk);
  });
  $('#gitView .tab[data-tab="pulls"]').addEventListener('click', () => {
    if (prState.repo === currentRepo && !prState.loaded && !prState.loading) loadPulls();
  });
  $$('#prStateSeg .seg-btn').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.state === prFilter) return;
    prFilter = b.dataset.state;
    prState.open.clear();
    loadPulls();
  }));
  $('#prSearch').addEventListener('input', (e) => {
    prQuery = e.target.value;
    renderPulls();
  });
  $('#prRefreshBtn').addEventListener('click', () => loadPulls());
  $('#prTokenBtn').addEventListener('click', () => {
    prState.tokenForm = !prState.tokenForm;
    prState.tokenError = '';
    renderPulls();
    const input = $('#prTokenInput');
    if (input) input.focus();
  });
}
