// Pull of several repositories: they are chosen in a popup (each with its current branch), then pulled one after the
// other while a bar at the bottom of the repository list shows how far it got; a click on the bar lists each one.
// At the end, View results says what happened to each. The same popup chooses the repositories of Fetch several, and
// the ones to take out of the list (Remove several).
// Uses app.js globals ($, $$, repos, repoGroups, displayName, repoName, currentRepo, renderSidebar, refresh,
// refreshSummaries, toast, fetchManyRepos, fetchingMany, CARD_ID).
const PM_MODES = {
  pull: {
    key: 'pullManyChosen', title: 'Pull repositories', verb: 'Pull',
    intro: 'Each one is fetched, then moved forward to its branch on origin when that needs no merge. One that fails is skipped and the next one goes on.',
  },
  fetch: {
    key: 'fetchManyChosen', title: 'Fetch repositories', verb: 'Fetch',
    intro: 'Each one gets what is new on origin, without changing any file. The list then shows what each has to pull.',
  },
  // none is chosen to begin with (unless asked from one of them or a group), and the choice is not kept
  remove: {
    key: null, title: 'Remove from the list', verb: 'Remove',
    intro: 'They leave the app\'s list only: their folders and files stay on disk, and nothing changes in Git. The app forgets the name, favorite, group and Maven settings it kept for them.',
  },
};
let pmMode = 'pull';
let pmChosen = new Set();
let pmRemember = true; // the choice is kept for next time (one for Pull, one for Fetch), except for one group
let pmRun = null; // { items: [{ path, name, branch, state, message }], done, stopped, stopping, expanded }

const PM_STATES = {
  pending: 'Waiting',
  running: 'Pulling...',
  updated: 'Pulled',
  current: 'Up to date',
  error: 'Failed',
  skipped: 'Skipped',
  stopped: 'Not pulled',
};
const PM_ICONS = {
  pending: '<circle cx="8" cy="8" r="2.2"/>',
  updated: '<path d="M3.5 8.5l3 3 6-7"/>',
  current: '<path d="M3.5 8.5l3 3 6-7"/>',
  error: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  skipped: '<path d="M4 8h8"/>',
  stopped: '<path d="M4 8h8"/>',
};

const samePath = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function pmStateIcon(state) {
  const el = document.createElement('span');
  el.className = `pm-state pm-state-${state}`;
  el.title = PM_STATES[state] || state;
  el.innerHTML = state === 'running' ? '' : `<svg viewBox="0 0 16 16" aria-hidden="true">${PM_ICONS[state] || ''}</svg>`;
  return el;
}

// Why a repository can not be pulled ('' when it can). Any can be taken out of the list.
function pmBlocked(r) {
  if (pmMode === 'remove') return '';
  if (r.isGit === false) return 'Folder (no Git)';
  if (r.error) return 'Unavailable';
  return '';
}

// The repositories in the order of the list: Favorites, each group, Other.
function pmSections() {
  const ids = new Set(repoGroups.map((g) => g.id));
  const sections = [];
  const favorites = repos.filter((r) => r.favorite);
  if (favorites.length) sections.push({ key: 'favorites', name: 'Favorites', repos: favorites });
  for (const g of repoGroups) {
    const members = repos.filter((r) => !r.favorite && r.group === g.id);
    if (members.length) sections.push({ key: `group:${g.id}`, name: g.name, repos: members });
  }
  const other = repos.filter((r) => !r.favorite && !ids.has(r.group));
  if (other.length) sections.push({ key: 'other', name: sections.length ? 'Other' : '', repos: other });
  return sections;
}

// The groups of the popup start closed, each one line with what it has to pull; the ones opened stay open next time
// (kept on this PC). While the filter has text, every group with a match is open.
const PM_OPEN_KEY = 'pullManyOpen';
let pmOpen = null;

function pmOpenGroups() {
  if (!pmOpen) {
    try {
      pmOpen = new Set(JSON.parse(localStorage.getItem(PM_OPEN_KEY) || '[]'));
    } catch {
      pmOpen = new Set();
    }
  }
  return pmOpen;
}

function togglePullManyGroup(key) {
  const open = pmOpenGroups();
  if (open.has(key)) open.delete(key);
  else open.add(key);
  try {
    localStorage.setItem(PM_OPEN_KEY, JSON.stringify([...open]));
  } catch {
    // open for this run only
  }
  renderPullMany();
}

// A group's line, closed or open: how many of its repositories have commits to pull and files changed (as of the
// last fetch); none: up to date.
function pmSectionSummary(rows) {
  if (pmMode === 'remove') {
    const sum = document.createElement('span');
    sum.className = 'pm-section-sum';
    const chosen = document.createElement('span');
    chosen.className = 'pm-section-chosen pm-section-quiet';
    sum.appendChild(chosen);
    return sum;
  }
  const can = rows.filter((r) => !pmBlocked(r));
  const behind = can.filter((r) => r.behind > 0).length;
  const changed = pmMode === 'pull' ? can.filter((r) => r.changes > 0).length : 0;
  const sum = document.createElement('span');
  sum.className = 'pm-section-sum';
  const part = (text, cls, title) => {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    el.title = title;
    sum.appendChild(el);
  };
  if (behind) part(`↓ ${behind} to pull`, 'pm-behind', `${behind === 1 ? '1 repository has' : `${behind} repositories have`} new commits on origin (as of the last fetch)`);
  if (changed) part(`${changed} with changes`, 'pm-changes', `${changed === 1 ? '1 repository has' : `${changed} repositories have`} files changed and not committed`);
  if (!behind && !changed) part(can.length ? 'Up to date' : 'Nothing to pull', 'pm-section-quiet', can.length ? 'Nothing new on origin as of the last fetch' : '');
  const chosen = document.createElement('span');
  chosen.className = 'pm-section-chosen pm-section-quiet';
  sum.prepend(chosen);
  return sum;
}

// -- The popup to choose them: for a pull, or with mode 'fetch' for a fetch --
function openPullMany(only = null, mode = 'pull') {
  if (mode === 'fetch' && fetchingMany) {
    toast('A fetch is already running', 'info');
    return;
  }
  if (pmRun && !pmRun.done && mode !== 'remove') {
    pmRun.expanded = true;
    renderPullDock();
    toast('A pull is already running: its bar is at the bottom of the list', 'info');
    return;
  }
  pmMode = mode;
  const texts = PM_MODES[mode];
  $('#pullManyTitle').textContent = texts.title;
  $('#pullManyModal .pm-intro').textContent = texts.intro;
  $('#pmList').setAttribute('aria-label', `Repositories to ${texts.verb.toLowerCase()}`);
  const can = new Set(repos.filter((r) => !pmBlocked(r)).map((r) => r.path));
  pmRemember = !only && Boolean(texts.key);
  if (mode === 'remove') {
    pmChosen = new Set((only || []).filter((p) => can.has(p)));
  } else if (only) {
    pmChosen = new Set(only.filter((p) => can.has(p)));
  } else {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(texts.key) || 'null');
    } catch {
      // nothing kept: all of them
    }
    // none of the ones kept is still in the list: all of them
    const kept = Array.isArray(saved) ? saved.filter((p) => can.has(p)) : [];
    pmChosen = new Set(kept.length ? kept : can);
  }
  $('#pmFilter').value = '';
  $('#pmPull').classList.toggle('btn-primary', mode !== 'remove');
  $('#pmPull').classList.toggle('btn-danger', mode === 'remove');
  $('#pullManyModal').classList.toggle('pm-removing', mode === 'remove');
  renderPullMany();
  $('#pullManyModal').classList.remove('hidden');
  $('#pmFilter').focus();
  // the branches shown are the ones of now: the repositories changed since git was last asked are asked again
  refreshChangedSummaries().then(() => {
    if (!$('#pullManyModal').classList.contains('hidden')) renderPullMany();
  });
}

function closePullMany() {
  $('#pullManyModal').classList.add('hidden');
}

function renderPullMany() {
  const list = $('#pmList');
  const scroll = list.scrollTop;
  list.innerHTML = '';
  const q = $('#pmFilter').value.trim().toLowerCase();
  const matches = (r) => !q || [displayName(r), r.path, r.branch || ''].join(' ').toLowerCase().includes(q);
  let shown = 0;
  for (const section of pmSections()) {
    const rows = section.repos.filter(matches);
    if (!rows.length) continue;
    shown += rows.length;
    const open = rows.filter((r) => !pmBlocked(r));
    const body = document.createElement('div');
    body.className = 'pm-section-rows';
    for (const r of rows) body.appendChild(pullManyRow(r));
    if (section.name) {
      const expanded = Boolean(q) || pmOpenGroups().has(section.key);
      const head = document.createElement('div');
      head.className = `pm-section${expanded ? ' open' : ''}`;
      head.dataset.key = section.key;
      const caret = document.createElement('button');
      caret.type = 'button';
      caret.className = 'pm-section-caret';
      caret.setAttribute('aria-expanded', String(expanded));
      caret.setAttribute('aria-label', `${expanded ? 'Hide' : 'Show'} the repositories of ${section.name}`);
      caret.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'pm-section-box';
      box.paths = open.map((r) => r.path);
      box.disabled = open.length === 0;
      box.setAttribute('aria-label', `All of ${section.name}`);
      box.addEventListener('change', () => {
        box.paths.forEach((p) => (box.checked ? pmChosen.add(p) : pmChosen.delete(p)));
        syncPullManyChecks();
      });
      const name = document.createElement('span');
      name.className = 'pm-section-name';
      name.textContent = section.name;
      const count = document.createElement('span');
      count.className = 'pm-section-count';
      count.textContent = rows.length;
      head.append(caret, box, name, count, pmSectionSummary(rows));
      // a click on the line (not on its box) opens or closes the group; while filtering, all stay open
      head.addEventListener('click', (e) => {
        if (e.target === box || q) return;
        togglePullManyGroup(section.key);
      });
      if (q) caret.disabled = true;
      body.classList.toggle('hidden', !expanded);
      body.classList.add('in-group');
      list.appendChild(head);
    }
    list.appendChild(body);
  }
  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'pm-empty';
    empty.textContent = q ? 'No repositories match' : 'No repositories';
    list.appendChild(empty);
  }
  list.scrollTop = scroll;
  syncPullManyChecks();
}

// The boxes follow the choice without drawing the list again, so the focus stays where it is.
function syncPullManyChecks() {
  for (const box of $$('#pmList .pm-row input')) box.checked = !box.disabled && pmChosen.has(box.dataset.path);
  for (const box of $$('#pmList .pm-section-box')) {
    const chosen = box.paths.filter((p) => pmChosen.has(p)).length;
    box.checked = box.paths.length > 0 && chosen === box.paths.length;
    box.indeterminate = chosen > 0 && chosen < box.paths.length;
    // closed, the line says when not all of it is chosen
    const note = box.parentElement.querySelector('.pm-section-chosen');
    if (note) note.textContent = box.paths.length && chosen < box.paths.length ? `${chosen} of ${box.paths.length} chosen` : '';
  }
  updatePullManyCount();
}

function pullManyRow(r) {
  const blocked = pmBlocked(r);
  const row = document.createElement('label');
  row.className = `pm-row${blocked ? ' blocked' : ''}`;
  row.title = r.path;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.disabled = Boolean(blocked);
  box.dataset.path = r.path;
  box.addEventListener('change', () => {
    if (box.checked) pmChosen.add(r.path);
    else pmChosen.delete(r.path);
    syncPullManyChecks();
  });
  const name = document.createElement('span');
  name.className = 'pm-name';
  name.textContent = displayName(r);
  const branch = document.createElement('span');
  branch.className = 'pm-branch';
  const info = document.createElement('span');
  info.className = 'pm-info';
  if (pmMode === 'remove') {
    // where it is, to tell apart two of the same name; one whose folder is gone says so
    branch.textContent = r.branch ? `⎇ ${r.branch}` : '';
    info.textContent = r.error ? 'Unavailable' : `\u200e${r.path}\u200e`; // the marks keep the path in order in a right-to-left box
    info.title = r.error || r.path;
    info.classList.add('pm-path');
  } else if (blocked) {
    info.textContent = blocked;
    if (r.error) info.title = r.error;
  } else {
    branch.textContent = r.branch === undefined ? '...' : `⎇ ${r.branch || 'detached'}`;
    branch.title = !r.branch ? '' : pmMode === 'pull' ? `It is on ${r.branch}: that is the branch pulled` : `It is on ${r.branch}`;
    const bits = [];
    if (r.behind > 0) bits.push([`↓${r.behind}`, 'pm-behind', `${r.behind} new commit${r.behind === 1 ? '' : 's'} on origin (as of the last fetch)`]);
    if (r.ahead > 0) bits.push([`↑${r.ahead}`, 'pm-ahead', `${r.ahead} commit${r.ahead === 1 ? '' : 's'} not pushed`]);
    if (r.changes > 0 && pmMode === 'pull') bits.push([`${r.changes} changed`, 'pm-changes', 'Files changed and not committed: a pull that touches them fails and is skipped']);
    for (const [text, cls, title] of bits) {
      const b = document.createElement('span');
      b.className = cls;
      b.textContent = text;
      b.title = title;
      info.appendChild(b);
    }
  }
  row.append(box, name, branch, info);
  return row;
}

function pmChosenPaths() {
  return pmSections().flatMap((s) => s.repos).filter((r) => !pmBlocked(r) && pmChosen.has(r.path)).map((r) => r.path);
}

function updatePullManyCount() {
  const can = repos.filter((r) => !pmBlocked(r));
  const n = pmChosenPaths().length;
  $('#pmCount').textContent = `${n} of ${can.length} chosen`;
  const all = $('#pmAll');
  all.checked = n > 0 && n === can.length;
  all.indeterminate = n > 0 && n < can.length;
  const go = $('#pmPull');
  const { verb } = PM_MODES[pmMode];
  go.textContent = n ? `${verb} ${n}` : verb;
  go.disabled = n === 0;
}

// The choice, for the next time the popup opens in that mode.
function pmKeepChoice(mode, paths) {
  try {
    localStorage.setItem(PM_MODES[mode].key, JSON.stringify(paths));
  } catch {
    // not kept for next time
  }
}

// -- Running it --
async function runPullMany(paths, remember) {
  if (!paths.length) return;
  if (remember) pmKeepChoice('pull', paths);
  const item = (p) => {
    const r = repos.find((x) => samePath(x.path, p));
    return { path: p, name: r ? displayName(r) : repoName(p), branch: (r && r.branch) || '', state: 'pending', message: '' };
  };
  // ready before the first progress message, which can come before the answer
  pmRun = { items: paths.map(item), done: false, stopped: false, stopping: false, expanded: pmRun ? pmRun.expanded : false };
  renderPullDock();
  const result = await window.git.pullMany(paths);
  if (result.error) {
    pmRun = null;
    renderPullDock();
    toast(result.error, 'error');
    return;
  }
  if (result.paths.length !== pmRun.items.length) {
    const before = pmRun.items;
    pmRun.items = result.paths.map((p) => before.find((i) => samePath(i.path, p)) || item(p));
    renderPullDock();
  }
}

function onPullManyProgress(msg) {
  if (!pmRun) return;
  if (msg.done) {
    pmRun.done = true;
    pmRun.stopped = Boolean(msg.stopped);
    renderPullDock();
    if (!$('#pullResultsModal').classList.contains('hidden')) renderPullResults();
    finishPullMany();
    return;
  }
  const it = pmRun.items.find((i) => samePath(i.path, msg.path));
  if (!it) return;
  it.state = msg.state;
  it.message = msg.message || '';
  if (msg.branch) it.branch = msg.branch;
  renderPullDock();
  if (!$('#pullResultsModal').classList.contains('hidden')) renderPullResults();
}

function pmCounts() {
  const counts = {};
  for (const i of pmRun.items) counts[i.state] = (counts[i.state] || 0) + 1;
  return counts;
}

function pmSummary() {
  const c = pmCounts();
  return [
    c.updated && `${c.updated} pulled`,
    c.current && `${c.current} up to date`,
    c.error && `${c.error} failed`,
    c.skipped && `${c.skipped} skipped`,
    c.stopped && `${c.stopped} not pulled`,
  ].filter(Boolean).join(' · ');
}

async function finishPullMany() {
  const c = pmCounts();
  toast(pmSummary(), c.error ? 'error' : 'success', { title: pmRun.stopped ? 'Pull stopped' : 'Pull done' });
  const pulledHere = pmRun.items.some((i) => i.state === 'updated' && samePath(i.path, currentRepo || ''));
  await refreshSummaries();
  if (pulledHere) await refresh();
}

// -- The bar at the bottom of the list --
function renderPullDock() {
  const dock = $('#pullDock');
  if (!pmRun) {
    dock.classList.add('hidden');
    return;
  }
  dock.classList.remove('hidden');
  const { items, done } = pmRun;
  const total = items.length;
  const finished = items.filter((i) => i.state !== 'pending' && i.state !== 'running').length;
  const running = items.find((i) => i.state === 'running');
  const c = pmCounts();
  dock.classList.toggle('done', done);
  dock.classList.toggle('has-errors', Boolean(c.error));
  $('#pullDockTitle').textContent = done
    ? (pmRun.stopped ? 'Pull stopped' : 'Pull done')
    : `Pulling ${Math.min(finished + 1, total)} of ${total}`;
  $('#pullDockNow').textContent = done ? pmSummary() : running ? `${running.name}${running.branch ? ` · ${running.branch}` : ''}` : 'Starting...';

  const track = $('#pullDockTrack');
  track.innerHTML = '';
  for (const i of items) {
    const seg = document.createElement('span');
    seg.className = `pm-seg pm-seg-${i.state}`;
    track.appendChild(seg);
  }
  track.setAttribute('aria-valuemax', String(total));
  track.setAttribute('aria-valuenow', String(finished));
  track.setAttribute('aria-valuetext', `${finished} of ${total}`);

  const bar = $('#pullDockBar');
  bar.setAttribute('aria-expanded', String(pmRun.expanded));
  bar.title = pmRun.expanded ? 'Hide the list' : 'Show each repository';
  dock.classList.toggle('expanded', pmRun.expanded);
  const list = $('#pullDockList');
  list.classList.toggle('hidden', !pmRun.expanded);
  if (pmRun.expanded) {
    list.innerHTML = '';
    for (const i of items) {
      const row = document.createElement('div');
      row.className = `pull-dock-row state-${i.state}`;
      row.title = i.message ? `${i.name}: ${i.message}` : i.name;
      const name = document.createElement('span');
      name.className = 'pull-dock-name';
      name.textContent = i.name;
      const what = document.createElement('span');
      what.className = 'pull-dock-what';
      what.textContent = PM_STATES[i.state];
      row.append(pmStateIcon(i.state), name, what);
      list.appendChild(row);
    }
    const now = list.querySelector('.state-running');
    if (now) now.scrollIntoView({ block: 'nearest' });
  }

  const stop = $('#pullDockStop');
  stop.classList.toggle('hidden', done);
  stop.disabled = pmRun.stopping;
  stop.textContent = pmRun.stopping ? 'Stopping...' : 'Stop';
  $('#pullDockResults').classList.toggle('hidden', !done);
  $('#pullDockClose').classList.toggle('hidden', !done);
}

// -- What happened to each --
function openPullResults() {
  if (!pmRun) return;
  renderPullResults();
  $('#pullResultsModal').classList.remove('hidden');
  $('#prClose').focus();
}

function closePullResults() {
  $('#pullResultsModal').classList.add('hidden');
}

function renderPullResults() {
  const c = pmCounts();
  const summary = $('#prSummary');
  summary.innerHTML = '';
  for (const state of ['updated', 'current', 'error', 'skipped', 'stopped', 'running', 'pending']) {
    if (!c[state]) continue;
    const chip = document.createElement('span');
    chip.className = `pr-chip state-${state}`;
    chip.textContent = `${c[state]} ${PM_STATES[state].replace('...', '').toLowerCase()}`;
    summary.appendChild(chip);
  }
  const list = $('#prList');
  list.innerHTML = '';
  for (const i of pmRun.items) {
    const row = document.createElement('div');
    row.className = `pr-row state-${i.state}`;
    const who = document.createElement('div');
    who.className = 'pr-who';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'pr-name';
    name.textContent = i.name;
    name.title = `Open ${i.name}`;
    name.addEventListener('click', async () => {
      const r = repos.find((x) => samePath(x.path, i.path));
      if (!r) return;
      closePullResults();
      currentRepo = r.path;
      renderSidebar();
      await refresh();
    });
    const branch = document.createElement('span');
    branch.className = 'pr-branch';
    branch.textContent = i.branch ? `⎇ ${i.branch}` : '';
    who.append(name, branch);
    const what = document.createElement('div');
    what.className = 'pr-what';
    const label = document.createElement('span');
    label.className = 'pr-label';
    label.textContent = PM_STATES[i.state];
    what.appendChild(label);
    if (i.message && i.message !== 'Already up to date') {
      const message = document.createElement('div');
      message.className = 'pr-message';
      message.textContent = i.message;
      what.appendChild(message);
    }
    row.append(pmStateIcon(i.state), who, what);
    list.appendChild(row);
  }
  $('#prRetry').classList.toggle('hidden', !(pmRun.done && c.error));
}

// Remove several: asked once, then out of the list together. True when they were removed.
async function removeManyRepos(paths) {
  const names = paths.map((p) => {
    const r = repos.find((x) => x.path === p);
    return r ? displayName(r) : repoName(p);
  });
  const which = paths.length === 1 ? `"${names[0]}"` : `${paths.length} repositories`;
  const listed = paths.length > 1 ? `\n\n${names.slice(0, 12).join('\n')}${names.length > 12 ? `\nand ${names.length - 12} more` : ''}` : '';
  if (!(await askConfirm(`Remove ${which} from the list? ${paths.length === 1 ? 'Its folder stays' : 'Their folders stay'} on disk.${listed}`))) return false;
  const r = await window.git.removeRepos(paths);
  if (paths.some((p) => samePath(p, currentRepo))) currentRepo = null;
  await loadRepos();
  // a scan of the microservices folder adds back what is in it
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const inRoot = reposRootPath ? paths.filter((p) => norm(p).startsWith(`${norm(reposRootPath)}/`)).length : 0;
  const removed = r && Number.isFinite(r.removed) ? r.removed : paths.length;
  toast(`Removed ${removed === 1 ? `${names[0]}` : `${removed} repositories`} from the list${inRoot ? '. Look for new repositories adds back the ones in the microservices folder' : ''}`, 'info', { plain: true });
  return true;
}

function setupPullMany() {
  window.git.onPullManyProgress(onPullManyProgress);
  $('#pmCancel').addEventListener('click', closePullMany);
  $('#pmPull').addEventListener('click', async () => {
    const paths = pmChosenPaths();
    if (!paths.length) return;
    if (pmMode === 'remove') {
      if (await removeManyRepos(paths)) closePullMany();
      return;
    }
    closePullMany();
    if (pmMode === 'fetch') {
      if (pmRemember) pmKeepChoice('fetch', paths);
      fetchManyRepos(paths);
    } else runPullMany(paths, pmRemember);
  });
  $('#pmFilter').addEventListener('input', renderPullMany);
  $('#pmAll').addEventListener('change', (e) => {
    const can = repos.filter((r) => !pmBlocked(r)).map((r) => r.path);
    pmChosen = e.target.checked ? new Set(can) : new Set();
    syncPullManyChecks();
  });
  $('#pullDockBar').addEventListener('click', () => {
    if (!pmRun) return;
    pmRun.expanded = !pmRun.expanded;
    renderPullDock();
  });
  $('#pullDockStop').addEventListener('click', async () => {
    if (!pmRun || pmRun.done) return;
    pmRun.stopping = true;
    renderPullDock();
    await window.git.stopPullMany();
  });
  $('#pullDockResults').addEventListener('click', openPullResults);
  $('#pullDockClose').addEventListener('click', () => {
    pmRun = null;
    renderPullDock();
  });
  $('#prClose').addEventListener('click', closePullResults);
  $('#prRetry').addEventListener('click', () => {
    const failed = pmRun.items.filter((i) => i.state === 'error').map((i) => i.path);
    closePullResults();
    runPullMany(failed, false);
  });
  // Esc closes the one that is open, wherever the focus is
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [['pullResultsModal', closePullResults], ['pullManyModal', closePullMany]].find(([id]) => !$(`#${id}`).classList.contains('hidden'));
    if (!open) return;
    e.stopPropagation();
    open[1]();
  });
  for (const [id, close] of [['pullManyModal', closePullMany], ['pullResultsModal', closePullResults]]) {
    const modal = $(`#${id}`);
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) close();
    });
  }
}

if (!CARD_ID) setupPullMany();
