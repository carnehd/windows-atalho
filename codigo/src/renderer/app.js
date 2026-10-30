const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// A Jira key such as ABC-, set in Settings: the start of a new commit message and of a new branch name after feature/.
let ticketPrefix = '';
const CARD_ID = new URLSearchParams(location.search).get('card');

let currentRepo = null;
let refreshTimer = null;
let selectedCount = 0;
let currentMode = 'git';

function resetCommitMsg() {
  $('#commitMsg').value = ticketPrefix;
  updateCommitBtn();
}

function updateCommitBtn() {
  const msg = $('#commitMsg').value.trim();
  $('#commitBtn').disabled = selectedCount === 0 || !msg || (Boolean(ticketPrefix) && msg === ticketPrefix);
}

// -- Init --
// -- Resizable left sidebar (shared width for Git, Vault and Tasks) --
const SIDEBAR_DEFAULT = 220;
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 380;
const SIDEBAR_KEY = 'sidebarWidth';

function setSidebarWidth(px) {
  const w = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)));
  document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  return w;
}

function setupSidebarResize() {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_KEY));
    if (saved) setSidebarWidth(saved);
  } catch {
    // storage unavailable: keep the default width
  }
  const save = (w) => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(w));
    } catch {
      // not remembered, but the width still applies
    }
  };
  $$('.sidebar').forEach((sidebar) => {
    const handle = document.createElement('div');
    handle.className = 'sidebar-resizer';
    handle.title = 'Drag to resize (double-click to reset)';
    sidebar.appendChild(handle);
    let width = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing-sidebar');
      const left = sidebar.getBoundingClientRect().left;
      const move = (ev) => (width = setSidebarWidth(ev.clientX - left));
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        document.body.classList.remove('resizing-sidebar');
        if (width) save(width);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', () => save(setSidebarWidth(SIDEBAR_DEFAULT)));
  });
}

// -- Resizable window: it has no frame, so its edges and corners are handles; the size is remembered --
function setupWindowResize() {
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const handle = document.createElement('div');
    handle.className = `win-resize win-resize-${edge}`;
    handle.dataset.edge = edge;
    handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('pointerdown', async (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const start = { x: e.screenX, y: e.screenY };
      let frame = 0;
      let last = null;
      const move = (ev) => {
        last = [ev.screenX - start.x, ev.screenY - start.y];
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          window.git.resizeMove(...last);
        });
      };
      const up = async () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        cancelAnimationFrame(frame);
        if (last) window.git.resizeMove(...last);
        document.body.classList.remove('resizing-window');
        showWindowSize(await window.git.resizeEnd());
      };
      document.body.classList.add('resizing-window');
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
      await window.git.resizeStart(edge);
    });
    handle.addEventListener('dblclick', async () => showWindowSize(await window.git.resetWindowSize()));
    document.body.appendChild(handle);
  }
  $('#windowSizeReset').addEventListener('click', async () => {
    showWindowSize(await window.git.resetWindowSize());
    toast('The window is back to its default size', 'info');
  });
  window.git.getWindowSize().then(showWindowSize);
}

// Text size in Settings: Smaller, Normal, Larger, Largest (the page scaled as a whole).
// Settings > Ticket prefix: saved when the field is left (or Enter); a commit message still only the old prefix takes the new one.
async function setupTicketPrefix() {
  ticketPrefix = (await window.git.getTicketPrefix()) || '';
  const input = $('#ticketPrefix');
  input.value = ticketPrefix;
  const save = async () => {
    if (input.value.trim() === ticketPrefix) return;
    const r = await window.git.setTicketPrefix(input.value);
    if (r.error) {
      toast(r.error, 'error', { plain: true });
      input.value = ticketPrefix;
      return;
    }
    const box = $('#commitMsg');
    const untouched = !box.value.trim() || box.value.trim() === ticketPrefix;
    ticketPrefix = r.prefix;
    input.value = ticketPrefix;
    if (untouched) resetCommitMsg();
    toast(ticketPrefix ? `Ticket prefix: ${ticketPrefix}` : 'No ticket prefix', 'success', { plain: true });
  };
  input.addEventListener('change', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
}

function setupTextSize() {
  const mark = (z) => $$('#textSizeSwitch .theme-opt').forEach((b) => {
    const on = Number(b.dataset.zoom) === z;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  window.git.getZoom().then(mark);
  $$('#textSizeSwitch .theme-opt').forEach((b) => b.addEventListener('click', async () => {
    const r = await window.git.setZoom(Number(b.dataset.zoom));
    if (r.error) toast(r.error, 'error');
    else mark(r.zoom);
  }));
}

function showWindowSize(size) {
  if (size && size.width) $('#windowSizeNow').textContent = `${size.width} × ${size.height}`;
}

// -- Remember where the window was left (also across restarts) --
let uiStateTimer = null;

function saveUiState() {
  clearTimeout(uiStateTimer);
  uiStateTimer = setTimeout(() => {
    const tab = $('#gitView .tab.active');
    window.git.saveUiState({
      mode: currentMode,
      repo: currentRepo,
      gitTab: tab ? tab.dataset.tab : 'changes',
      gitView: gitViewChoice,
      vaultEnv: selectedEnvId,
      vaultFilter: typeFilter,
      vaultSort,
      vaultItem: selectedItemId,
      todoList,
      logsQuery: $('#logsQuery').value,
      logsRange: $('#logsRange').value,
      logsColumns,
      logsColumnsChosen,
      logsHidden,
      logsServiceTabs,
      logsEnv,
      logsOrigin,
      logsTabLabels,
    });
  }, 200);
}

async function init() {
  setupSidebarResize();
  setupWindowResize();
  setupTextSize();
  await setupTicketPrefix();
  const saved = (await window.git.getUiState()) || {};
  if (saved.repo) currentRepo = saved.repo;
  if (saved.vaultEnv) selectedEnvId = saved.vaultEnv;
  if (saved.vaultFilter && $(`#vaultFilters .tab[data-type="${saved.vaultFilter}"]`)) typeFilter = saved.vaultFilter;
  if (saved.vaultSort) vaultSort = saved.vaultSort;
  if (saved.vaultItem) selectedItemId = saved.vaultItem;
  if (typeof saved.todoList === 'string') todoList = saved.todoList;
  restoreLogsState(saved);
  // before 1.5.1 Maven was a tab of the Git page
  if (saved.gitView === 'maven' || saved.gitTab === 'maven') gitViewChoice = 'maven';
  await loadRepos();
  setupTabs();
  $$('.view-switch-btn').forEach((b) => b.addEventListener('click', () => setGitView(b.dataset.view)));
  applyGitView();
  const savedTab = saved.gitTab && $(`#gitView .tab[data-tab="${saved.gitTab}"]`);
  if (savedTab) savedTab.click();
  if (saved.mode) setMode(saved.mode);
  if (currentMode === 'docker') refreshContainers();
  setupEvents();
  setupStash();
  setupPark();
  setupIgnored();
  setupPush();
  setupDiff();
  setupGitBasics();
  resetCommitMsg();
  setupModes();
  setupPin();
  setupIdeBanner();
  window.git.onWindowShown((mode, ide) => activateMode(mode, ide));
  await setupSettings();
}

// -- The microservices folder, and Refresh --
let reposRootPath = '';

async function renderReposRoot() {
  const r = await window.git.getReposRoot();
  reposRootPath = r.exists ? r.path : '';
  // Sync has a dot while no microservices folder is chosen: Look for new repositories asks for it first
  const btn = $('#syncReposBtn');
  btn.classList.toggle('unset', !reposRootPath);
  btn.title = reposRootPath
    ? `Look for new repositories in ${reposRootPath}, pull or fetch several, the microservices folder`
    : 'The microservices folder is not chosen yet: Look for new repositories asks for it';
}

async function chooseReposRoot() {
  const folder = await window.git.pickFolder();
  if (!folder) return false;
  const r = await window.git.setReposRoot(folder);
  if (r.error) {
    toast(r.error, 'error');
    return false;
  }
  await renderReposRoot();
  return true;
}

async function refreshRepoList() {
  showLoading();
  let result;
  try {
    result = await window.git.refreshRepos();
  } catch (e) {
    result = { error: e.message };
  }
  hideLoading();
  if (result.needsRoot) {
    if (result.path) toast(`The microservices folder is gone: ${result.path}. Choose it again.`, 'info');
    if (await chooseReposRoot()) await refreshRepoList();
    return;
  }
  if (result.error) {
    toast(result.error, 'error', { title: "Couldn't look in the folder" });
    return;
  }
  if (!currentRepo && result.first) currentRepo = result.first;
  await loadRepos();
  if (currentMode === 'git' && currentRepo) await refresh();
  const extra = result.truncated ? ' (the search stopped at its limit)' : '';
  if (result.added > 0) toast(`Found ${result.added} new ${result.added === 1 ? 'repository' : 'repositories'}${extra}`, 'success');
  else toast(`Up to date: no new repositories in ${result.root}${extra}`, 'info');
}

// -- Sync: look for new repositories in the microservices folder, pull or fetch several, the folder itself --
function openSyncReposMenu() {
  const btn = $('#syncReposBtn');
  if ($('#actionMenu') && $('#actionMenu').dataset.anchor === btn.id) {
    closeActionMenu();
    return;
  }
  const git = repos.filter((r) => r.isGit !== false).length;
  openActionMenu({
    anchor: btn,
    items: [
      { icon: 'scan', label: 'Look for new repositories', hint: reposRootPath ? `In ${reposRootPath}, and update the list` : 'Asks for the microservices folder first', run: refreshRepoList },
      { icon: 'pull', label: 'Pull several...', hint: 'Choose repositories and pull them one after the other', run: () => openPullMany() },
      { icon: 'fetchAll', label: 'Fetch several...', hint: 'Choose repositories and see what is new on origin for each, without changing any file', disabled: !git || fetchingMany, run: () => openPullMany(null, 'fetch') },
      { icon: 'folder', label: 'Microservices folder...', hint: reposRootPath || 'Not chosen yet', run: openReposRootMenu },
    ],
  });
}

// Fetch of the repositories chosen in the popup of Pull several (a few at a time): the list then shows what each has
// to pull.
let fetchingMany = false;

async function fetchManyRepos(paths) {
  if (fetchingMany || !paths.length) return;
  fetchingMany = true;
  const btn = $('#syncReposBtn');
  btn.disabled = true;
  btn.classList.add('busy');
  $('#syncReposLabel').textContent = 'Fetching...';
  let r;
  try {
    r = await window.git.fetchMany(paths);
  } catch (e) {
    r = { error: e.message };
  }
  fetchingMany = false;
  btn.disabled = false;
  btn.classList.remove('busy');
  $('#syncReposLabel').textContent = 'Sync';
  if (r.error) {
    toast(r.error, 'error', { title: 'Fetch failed' });
    return;
  }
  const failed = r.results.filter((x) => !x.ok);
  const nameOf = (p) => {
    const repo = repos.find((x) => x.path === p);
    return repo ? displayName(repo) : repoName(p);
  };
  if (!failed.length) toast(`Fetched ${r.results.length} ${r.results.length === 1 ? 'repository' : 'repositories'}`, 'success');
  else {
    // each repository with the short reason (the long Git text would hide which one it was)
    toast(failed.map((x) => `${nameOf(x.path)}: ${describeMessage(x.error).title || x.error.split('\n')[0]}`).join('\n'), 'error', {
      title: `Fetched ${r.results.length - failed.length} of ${r.results.length}; ${failed.length} failed`,
      plain: true,
    });
  }
  await refreshSummaries();
  if (currentMode === 'git' && currentRepo) await refresh();
}

function openReposRootMenu() {
  const btn = $('#syncReposBtn');
  const choose = async () => {
    if (await chooseReposRoot()) await refreshRepoList();
  };
  openActionMenu({
    anchor: btn,
    title: 'Microservices folder',
    items: [
      { note: reposRootPath || 'Not chosen yet. Choose the folder that holds your microservices: Look for new repositories then finds every repository in it.' },
      { icon: 'folder', label: reposRootPath ? 'Choose another folder...' : 'Choose the folder...', run: choose },
      {
        icon: 'open', label: 'Open it', disabled: !reposRootPath,
        run: async () => {
          const r = await window.git.openReposRoot();
          if (r.error) toast(r.error, 'error');
        },
      },
      {
        icon: 'delete', label: 'Stop using it', disabled: !reposRootPath, hint: 'The repositories stay in the list',
        run: async () => {
          await window.git.setReposRoot(null);
          await renderReposRoot();
          toast('No microservices folder: Look for new repositories asks for one', 'info');
        },
      },
    ],
  });
}

// -- Repos --
let repos = [];
let editingPath = null;
// Groups of the list ({ id, name, collapsed }, in order) and the one whose name is being edited.
let repoGroups = [];
let editingGroup = null;
const REPO_DRAG_TYPE = 'application/x-git-quick-repo';

async function loadRepos() {
  const [list, groups] = await Promise.all([window.git.getRepos(), window.git.getRepoGroups()]);
  repoGroups = groups.groups || [];
  const previous = new Map(repos.map((r) => [r.path, r]));
  repos = list.map((r) => ({ ...previous.get(r.path), ...r }));
  if (repos.length === 0) {
    currentRepo = null;
    renderSidebar();
    $('#emptyState').classList.remove('hidden');
    $('#mainContent').classList.add('hidden');
    return;
  }
  $('#emptyState').classList.add('hidden');
  $('#mainContent').classList.remove('hidden');

  if (!currentRepo || !repos.some((r) => r.path === currentRepo)) {
    currentRepo = repos[0].path;
  }
  renderSidebar();
  refreshSummaries();
  await refresh();
}

async function refreshSummaries() {
  let summaries;
  try {
    summaries = await window.git.getRepoSummaries();
  } catch {
    return;
  }
  repos.forEach((r) => {
    const s = summaries[r.path];
    if (s) Object.assign(r, { branch: s.branch, changes: s.changes, ahead: s.ahead, behind: s.behind, error: s.error });
  });
  renderSidebar();
}

function updateRepoSummary(repoPath, status) {
  const r = repos.find((x) => x.path === repoPath);
  if (!r) return;
  Object.assign(r, { branch: status.branch, changes: status.changes, ahead: status.ahead, behind: status.behind, error: undefined });
  renderSidebar();
}

function repoName(p) {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

function displayName(r) {
  return r.name || repoName(r.path);
}

const REPO_ICONS = {
  open: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5z"/>',
  edit: '<path d="M11.5 2.5l2 2L5.5 12.5l-3 .8.8-3 8.2-7.8z"/>',
  remove: '<path d="M4 4l8 8M12 4l-8 8"/>',
  star: '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
  more: '<circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/>',
  group: '<path d="M8 2.5l5.5 2.8L8 8 2.5 5.3z"/><path d="M2.5 8L8 10.8 13.5 8"/><path d="M2.5 10.7L8 13.5l5.5-2.8"/>',
  chevron: '<path d="M4.5 6.5L8 10l3.5-3.5"/>',
};

async function toggleFavorite(r) {
  const result = await window.git.toggleFavorite(r.path);
  if (result.error) {
    toast(result.error, 'error');
    return;
  }
  r.favorite = result.favorite;
  renderSidebar();
}

function repoIconButton(icon, title, extraClass, handler) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `repo-item-btn ${extraClass}`.trim();
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${REPO_ICONS[icon]}</svg>`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    handler();
  });
  return btn;
}

// -- Actions menu of a repository (one button per row instead of four icons) --
function closeRepoMenu(refocus = false) {
  const menu = $('#repoMenu');
  if (!menu) return;
  const anchor = menu.anchor;
  menu.remove();
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'false');
    anchor.classList.remove('open');
    if (refocus && anchor.isConnected) anchor.focus();
  }
  if (sidebarDirty) renderSidebar();
}

function openRepoMenu(anchor, r, nameEl) {
  const open = $('#repoMenu');
  const sameButton = open && open.anchor === anchor;
  closeRepoMenu();
  if (sameButton) return;

  const menu = document.createElement('div');
  menu.id = 'repoMenu';
  menu.className = 'clip-menu repo-menu';
  menu.setAttribute('role', 'menu');
  menu.anchor = anchor;
  const add = (icon, label, run, extraClass = '') => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `clip-menu-item repo-menu-item ${extraClass}`.trim();
    item.setAttribute('role', 'menuitem');
    item.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${REPO_ICONS[icon]}</svg>`;
    item.appendChild(document.createTextNode(label));
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      // Run first: a rename has to start before the list may be drawn again.
      run();
      closeRepoMenu();
    });
    menu.appendChild(item);
  };
  add('star', r.favorite ? 'Remove from favorites' : 'Add to favorites', () => toggleFavorite(r), r.favorite ? 'favorite' : '');
  add('open', IS_MAC ? 'Open in Finder' : 'Open in Explorer', async () => {
    const result = await window.git.openFolder(r.path);
    if (result.error) toast(result.error, 'error');
  });
  add('edit', 'Rename', () => startRename(r, nameEl));
  add('group', 'Move to group...', () => openMoveToGroup(r, anchor.getBoundingClientRect()));
  add('remove', 'Remove from list', () => removeRepo(r.path), 'danger');

  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeRepoMenu(true);
    } else if (e.key === 'Tab') {
      closeRepoMenu();
    }
  });

  document.body.appendChild(menu);
  // Below the button, its right edge lined up with the button; above it when there is no room below.
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const left = Math.min(Math.max(8, a.right - m.width), window.innerWidth - m.width - 8);
  const top = a.bottom + 4 + m.height > window.innerHeight - 8 ? a.top - m.height - 4 : a.bottom + 4;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  anchor.classList.add('open');
  menu.querySelector('button').focus();
}

// Drawing the list again would remove the button an open menu or a rename belongs to, so it waits for them.
let sidebarDirty = false;

// Repositories with a Maven command running in the app: a green dot before their name in the list.
let mavenRunning = new Map(); // repo path -> command

// Goals that keep the microservice running (Start and Debug run spring-boot:run), as opposed to a build that ends.
const SERVE_GOALS = /(^|\s)(spring-boot:run|quarkus:dev|jetty:run|tomcat\d?:run|liberty:dev|exec:java)(\s|$)/;

function setMavenRunning(list) {
  mavenRunning = new Map((list || []).map((r) => [r.repo, r.command]));
  $$('#repoList .repo-item').forEach(markMavenRunning);
  renderViewRunState();
  $$('#repoList .repo-group[data-group]').forEach(markGroupState);
}

// A folded group shows on its header what its rows would show: a build running, a microservice up, the open repository.
function markGroupState(group) {
  const head = group.querySelector('.repo-group-head');
  if (!head) return;
  const rows = [...group.querySelectorAll('.repo-item')];
  const serving = rows.filter((el) => el.classList.contains('mvn-serving'));
  head.classList.toggle('mvn-running', rows.some((el) => el.classList.contains('mvn-running')));
  head.classList.toggle('mvn-serving', serving.length > 0);
  const tag = head.querySelector('.repo-run-tag');
  if (tag) tag.title = serving.length ? `Running: ${serving.map((el) => el.querySelector('.repo-item-name').textContent).join(', ')}` : '';
  group.classList.toggle('has-active', rows.some((el) => el.classList.contains('active')));
}

// A build shows a green dot before the name; a microservice that is up shows "running" on the right.
function markMavenRunning(item) {
  const command = mavenRunning.get(item.dataset.path);
  const serving = Boolean(command) && SERVE_GOALS.test(command);
  item.classList.toggle('mvn-running', Boolean(command) && !serving);
  item.classList.toggle('mvn-serving', serving);
  const dot = item.querySelector('.repo-run-dot');
  if (dot) dot.title = command && !serving ? `Running ${command}` : '';
  const tag = item.querySelector('.repo-run-tag');
  if (tag) {
    const debug = serving && /jdwp/.test(command) ? (command.match(/address=\*?:?(\d+)/) || [])[1] : null;
    tag.title = serving ? `${debug ? `Running in debug (debugger on port ${debug})` : 'Running'}: ${command}` : '';
  }
}

function renderSidebar() {
  if (editingPath || editingGroup || $('#repoMenu')) {
    sidebarDirty = true;
    return;
  }
  sidebarDirty = false;
  updateCrumb();
  const list = $('#repoList');
  list.innerHTML = '';
  if (repos.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.textContent = 'No repositories';
    list.appendChild(empty);
    return;
  }
  // The search box filters by display name, folder, current branch and group name.
  const q = $('#repoSearch').value.trim().toLowerCase();
  const groupName = new Map(repoGroups.map((g) => [g.id, g.name]));
  const shown = q ? repos.filter((r) => [displayName(r), r.path, r.branch || '', groupName.get(r.group) || ''].join(' ').toLowerCase().includes(q)) : repos;
  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.textContent = 'No repositories match';
    list.appendChild(empty);
    return;
  }
  // A repository shows once: under Favorites while it is a favorite, else in its group, else under Other.
  const favorites = shown.filter((r) => r.favorite);
  const others = shown.filter((r) => !r.favorite && !groupName.has(r.group));
  const sectionLabel = (text, parent = list) => {
    const el = document.createElement('div');
    el.className = 'repo-section';
    el.textContent = text;
    parent.appendChild(el);
  };
  if (favorites.length) {
    sectionLabel('Favorites');
    favorites.forEach((r) => list.appendChild(repoRow(r)));
  }
  for (const g of repoGroups) {
    const members = shown.filter((r) => !r.favorite && r.group === g.id);
    if (q && members.length === 0) continue;
    list.appendChild(groupBlock(g, members, Boolean(q)));
  }
  // With groups, Other is where a repository is dropped to take it out of its group (shown only while dragging when empty).
  if (repoGroups.length && !q) {
    const other = document.createElement('div');
    other.className = `repo-group repo-group-other${others.length ? '' : ' empty'}`;
    other.dataset.drop = '';
    sectionLabel('Other', other);
    if (others.length) others.forEach((r) => other.appendChild(repoRow(r)));
    else {
      const hint = document.createElement('div');
      hint.className = 'repo-group-empty';
      hint.textContent = 'Drop here to take it out of its group';
      other.appendChild(hint);
    }
    dropTarget(other, '');
    list.appendChild(other);
  } else {
    if (others.length && (favorites.length || repoGroups.length)) sectionLabel('Other');
    others.forEach((r) => list.appendChild(repoRow(r)));
  }
  $$('#repoList .repo-group[data-group]').forEach(markGroupState);
}

function repoRow(r) {
  const item = document.createElement('div');
  item.className = `repo-item${r.path === currentRepo ? ' active' : ''}`;
  item.title = r.path;
  item.dataset.path = r.path;

  const text = document.createElement('div');
  text.className = 'repo-item-text';

  const title = document.createElement('div');
  title.className = 'repo-item-title';
  const dot = document.createElement('span');
  dot.className = 'repo-run-dot';
  const name = document.createElement('span');
  name.className = 'repo-item-name';
  name.textContent = displayName(r);
  title.append(dot, name);
  if (r.changes > 0) {
    const badge = document.createElement('span');
    badge.className = 'repo-badge';
    badge.textContent = r.changes;
    badge.title = `${r.changes} changed file${r.changes !== 1 ? 's' : ''}`;
    title.appendChild(badge);
  }
  const runTag = document.createElement('span');
  runTag.className = 'repo-run-tag';
  runTag.textContent = 'running';
  title.appendChild(runTag);

  const branch = document.createElement('div');
  branch.className = 'repo-item-branch';
  if (r.error) {
    branch.classList.add('error');
    branch.textContent = 'unavailable';
    branch.title = r.error;
  } else if (r.isGit === false) {
    branch.textContent = 'Folder (no Git)';
  } else if (r.branch === undefined) {
    branch.textContent = '...';
  } else {
    const sync = [r.ahead > 0 ? `↑${r.ahead}` : '', r.behind > 0 ? `↓${r.behind}` : ''].filter(Boolean).join(' ');
    branch.textContent = `⎇ ${r.branch || 'detached'}${sync ? '  ' + sync : ''}`;
  }
  text.append(title, branch);

  const actions = document.createElement('div');
  actions.className = 'repo-item-actions';
  const more = repoIconButton('more', 'Actions: favorite, open folder, rename, group, remove', 'repo-more', () => openRepoMenu(more, r, name));
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  actions.append(more);

  name.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(r, name);
  });

  item.addEventListener('click', async () => {
    if (editingPath || r.path === currentRepo) return;
    currentRepo = r.path;
    $$('.repo-item').forEach((el) => el.classList.toggle('active', el === item));
    $$('#repoList .repo-group[data-group]').forEach(markGroupState);
    await refresh();
  });

  // Dragged onto a group (or Other) it moves there.
  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    if (editingPath) {
      e.preventDefault();
      return;
    }
    closeRepoMenu();
    e.dataTransfer.setData(REPO_DRAG_TYPE, r.path);
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('dragging');
    $('#repoList').classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    $('#repoList').classList.remove('dragging');
    $$('#repoList .drop-target').forEach((el) => el.classList.remove('drop-target'));
  });

  item.append(text, actions);
  markMavenRunning(item);
  return item;
}

function dropTarget(el, groupId) {
  const dragged = (e) => e.dataTransfer.types.includes(REPO_DRAG_TYPE);
  el.addEventListener('dragover', (e) => {
    if (!dragged(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!el.classList.contains('drop-target')) {
      $$('#repoList .drop-target').forEach((x) => x.classList.remove('drop-target'));
      el.classList.add('drop-target');
    }
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target');
  });
  el.addEventListener('drop', (e) => {
    if (!dragged(e)) return;
    e.preventDefault();
    el.classList.remove('drop-target');
    const r = repos.find((x) => x.path === e.dataTransfer.getData(REPO_DRAG_TYPE));
    if (r) moveRepoToGroup(r, groupId);
  });
}

// A group: its header (fold, name, how many, its menu) and its repositories under it.
function groupBlock(g, members, searching) {
  const block = document.createElement('div');
  const folded = g.collapsed && !searching;
  block.className = `repo-group${folded ? ' collapsed' : ''}`;
  block.dataset.group = g.id;
  block.dataset.drop = g.id;

  const head = document.createElement('div');
  head.className = 'repo-group-head';
  head.title = searching ? g.name : `${g.name}: a click folds or opens it, a double-click on the name renames it`;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'repo-group-toggle';
  toggle.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${REPO_ICONS.chevron}</svg>`;
  toggle.setAttribute('aria-expanded', String(!folded));
  toggle.setAttribute('aria-label', `${g.name}, ${members.length} ${members.length === 1 ? 'repository' : 'repositories'}`);
  toggle.disabled = searching;
  const name = document.createElement('span');
  name.className = 'repo-group-name';
  name.textContent = g.name;
  const count = document.createElement('span');
  count.className = 'repo-group-count';
  count.textContent = members.length;
  const end = document.createElement('span');
  end.className = 'repo-group-end';
  const dot = document.createElement('span');
  dot.className = 'repo-run-dot';
  dot.title = 'A build is running in this group';
  const tag = document.createElement('span');
  tag.className = 'repo-run-tag';
  tag.textContent = 'running';
  const more = repoIconButton('more', `Actions of the group ${g.name}: rename, order, delete`, 'repo-more', () => openGroupMenu(g, { anchor: more }));
  more.setAttribute('aria-haspopup', 'menu');
  end.append(dot, tag, more);
  head.append(toggle, name, count, end);

  head.addEventListener('click', () => {
    if (searching || editingGroup === g.id) return;
    g.collapsed = !g.collapsed;
    block.classList.toggle('collapsed', g.collapsed);
    toggle.setAttribute('aria-expanded', String(!g.collapsed));
    window.git.collapseRepoGroup(g.id, g.collapsed).then((r) => r && r.error && toast(r.error, 'error'));
  });
  name.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startGroupRename(g, name);
  });
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openGroupMenu(g, { x: e.clientX, y: e.clientY });
  });

  const body = document.createElement('div');
  body.className = 'repo-group-body';
  if (members.length) members.forEach((r) => body.appendChild(repoRow(r)));
  else {
    const hint = document.createElement('div');
    hint.className = 'repo-group-empty';
    hint.textContent = 'Empty: drag a repository here, or use Move to group in its ⋯ menu';
    body.appendChild(hint);
  }
  block.append(head, body);
  dropTarget(block, g.id);
  return block;
}

async function moveRepoToGroup(r, groupId) {
  if ((r.group || '') === (groupId || '')) return;
  const result = await window.git.setRepoGroup(r.path, groupId || null);
  if (result.error) {
    toast(result.error, 'error');
    return;
  }
  r.group = groupId || '';
  const g = repoGroups.find((x) => x.id === groupId);
  // the group opens so the repository can be seen in it
  if (g && g.collapsed) {
    g.collapsed = false;
    window.git.collapseRepoGroup(g.id, false);
  }
  renderSidebar();
  const what = `"${displayName(r)}"`;
  if (!g) toast(`${what} is out of its group`, 'info');
  else toast(r.favorite ? `${what} is in ${g.name}. It shows under Favorites while it is a favorite.` : `${what} is in ${g.name}`, 'success');
}

// The groups to choose from, at the place of the repository's ⋯ menu (it has just closed).
function openMoveToGroup(r, at) {
  if (repoGroups.length === 0) {
    newGroupForm(at, r);
    return;
  }
  const items = repoGroups.map((g) => (g.id === r.group
    ? { icon: 'check', label: g.name, disabled: true, hint: 'It is in this group', run: () => {} }
    : { icon: 'group', label: g.name, run: () => moveRepoToGroup(r, g.id) }));
  if (r.group && repoGroups.some((g) => g.id === r.group)) items.push({ icon: 'ungroup', label: 'No group', hint: 'Back under Other', run: () => moveRepoToGroup(r, '') });
  items.push({ icon: 'plus', label: 'New group...', run: () => newGroupForm(at, r) });
  openActionMenu({ x: at.right - 200, y: at.bottom + 4, title: `Move "${displayName(r)}" to`, items });
}

// The name of a new group, typed in a menu. With a repository it goes into the new group.
function newGroupForm(at, r = null) {
  openActionMenu({ x: at.right - 220, y: at.bottom + 4, items: [] });
  showMenuForm($('#actionMenu'), {
    title: r ? `New group for "${displayName(r)}"` : 'New group',
    placeholder: 'Payments, Customers, Tools...',
    aria: 'Name of the new group',
    button: r ? 'Create and move' : 'Create',
    submit: async (name, fail) => {
      if (!name) return fail('Type a name for the group.');
      const result = await window.git.createRepoGroup(name);
      if (result.error) return fail(result.error);
      closeActionMenu();
      repoGroups.push(result);
      if (r) await moveRepoToGroup(r, result.id);
      else {
        renderSidebar();
        toast(`Group ${result.name} created: drag repositories into it`, 'success');
      }
    },
  });
}

function openGroupMenu(g, { anchor = null, x = 0, y = 0 }) {
  if (anchor && $('#actionMenu') && $('#actionMenu').groupAnchor === anchor) {
    closeActionMenu();
    return;
  }
  const i = repoGroups.indexOf(g);
  const nameEl = () => $(`#repoList .repo-group[data-group="${g.id}"] .repo-group-name`);
  const move = async (delta) => {
    const result = await window.git.moveRepoGroup(g.id, delta);
    if (result.error) return toast(result.error, 'error');
    repoGroups.splice(i, 1);
    repoGroups.splice(i + delta, 0, g);
    renderSidebar();
  };
  openActionMenu({
    anchor,
    x,
    y,
    title: g.name,
    items: [
      { icon: 'rename', label: 'Rename', run: () => nameEl() && startGroupRename(g, nameEl()) },
      { icon: 'up', label: 'Move up', disabled: i <= 0, run: () => move(-1) },
      { icon: 'down', label: 'Move down', disabled: i >= repoGroups.length - 1, run: () => move(1) },
      { icon: 'pull', label: 'Pull this group...', hint: 'Choose which of its repositories to pull', run: () => openPullMany(repos.filter((r) => r.group === g.id).map((r) => r.path)) },
      { icon: 'plus', label: 'New group...', run: () => newGroupForm((anchor || nameEl() || $('#repoList')).getBoundingClientRect()) },
      { icon: 'group', label: 'Manage groups...', hint: 'Every group side by side, to drag the microservices between them', run: openGroupsBoard },
      { icon: 'delete', label: 'Delete group', danger: true, hint: 'Its repositories stay in the list, under Other', run: () => deleteGroup(g) },
    ],
  });
  if ($('#actionMenu')) $('#actionMenu').groupAnchor = anchor;
}

async function deleteGroup(g) {
  const count = repos.filter((r) => r.group === g.id).length;
  const message = count
    ? `Delete the group "${g.name}"? Its ${count === 1 ? 'repository stays' : `${count} repositories stay`} in the list, under Other.`
    : `Delete the group "${g.name}"?`;
  if (!(await window.git.confirm(message))) return;
  const result = await window.git.deleteRepoGroup(g.id);
  if (result.error) return toast(result.error, 'error');
  repoGroups = repoGroups.filter((x) => x.id !== g.id);
  repos.forEach((r) => {
    if (r.group === g.id) r.group = '';
  });
  renderSidebar();
  toast(`Group ${g.name} deleted`, 'info');
}

function startGroupRename(g, nameEl) {
  if (editingPath || editingGroup) return;
  editingGroup = g.id;
  const input = document.createElement('input');
  input.className = 'repo-rename-input repo-group-rename';
  input.value = g.name;
  input.maxLength = 40;
  input.setAttribute('aria-label', 'Name of the group');
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value && value !== g.name) {
      const result = await window.git.renameRepoGroup(g.id, value);
      if (result.error) toast(result.error, 'error');
      else g.name = result.name;
    }
    editingGroup = null;
    renderSidebar();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') {
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function startRename(r, nameEl) {
  if (editingPath) return;
  editingPath = r.path;
  const row = nameEl.closest('.repo-item');
  if (row) row.draggable = false;
  const input = document.createElement('input');
  input.className = 'repo-rename-input';
  input.value = displayName(r);
  input.maxLength = 60;
  input.placeholder = repoName(r.path);
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save) {
      const value = input.value.trim() === repoName(r.path) ? '' : input.value;
      r.name = await window.git.renameRepo(r.path, value);
    }
    editingPath = null;
    renderSidebar();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function removeRepo(repoPath) {
  const target = repos.find((r) => r.path === repoPath);
  if (!(await window.git.confirm(`Remove "${target ? displayName(target) : repoName(repoPath)}" from the list?`))) return;
  await window.git.removeRepo(repoPath);
  if (repoPath === currentRepo) currentRepo = null;
  await loadRepos();
  toast('Repository removed', 'info');
}

// -- Refresh --
// After a switch to another repository, until its answers come: the tab on show (or Maven) says it is loading instead
// of showing the last one's files, and the branch name and the line under it fade until the status comes. A tab
// whose part has come shows while the others load.
let shownRepo = null;
let repoLoading = null; // { repo, pending: Set of the parts not here yet }
const TAB_PART = { changes: 'status' };

function renderRepoLoading() {
  const main = $('#mainContent');
  const pending = repoLoading && repoLoading.repo === currentRepo ? repoLoading.pending : null;
  const tab = $('#gitView .tab.active');
  const shown = effectiveGitView() === 'maven' ? 'maven' : tab ? tab.dataset.tab : 'changes';
  const on = Boolean(pending && pending.has(TAB_PART[shown] || shown));
  if (on) {
    main.style.setProperty('--repo-loading-top', `${$(`#tab-${shown}`).offsetTop}px`);
    const entry = repos.find((r) => r.path === currentRepo);
    $('#repoLoadingName').textContent = entry ? displayName(entry) : repoName(currentRepo);
  }
  main.classList.toggle('repo-switching', on);
  main.classList.toggle('repo-status-pending', Boolean(pending && pending.has('status')));
}

async function refresh() {
  if (!currentRepo) return;
  saveUiState();
  updateCrumb();
  const repoPath = currentRepo;
  const entry = repos.find((r) => r.path === repoPath);
  const isGit = !entry || entry.isGit !== false;
  setFolderMode(!isGit);
  const parts = isGit
    ? { status: refreshStatus, branches: refreshBranches, log: refreshLog, stash: refreshStash, push: refreshPush, maven: refreshMaven, ignored: refreshIgnored, refs: refreshCmpRefs }
    : { maven: refreshMaven };
  // A second refresh while it loads (the timer, a focus) keeps the parts already here. Until every part has come the
  // page shows no repository in full, so going back to the last one is a switch too.
  const switching = repoPath !== shownRepo;
  if (switching) {
    shownRepo = null;
    if (!repoLoading || repoLoading.repo !== repoPath) repoLoading = { repo: repoPath, pending: new Set(Object.keys(parts)) };
    renderRepoLoading();
  }
  await Promise.all(
    Object.entries(parts).map(async ([part, run]) => {
      try {
        await run();
      } finally {
        if (switching && repoLoading && repoLoading.repo === repoPath) {
          repoLoading.pending.delete(part);
          if (!repoLoading.pending.size) {
            repoLoading = null;
            shownRepo = repoPath;
          }
          renderRepoLoading();
        }
      }
    })
  );
}

// -- Git or Maven: the repository page shows one of them, chosen with the switch on its left --
// A folder without Git only has Maven; the choice comes back with the next repository.
let gitViewChoice = 'git';

function effectiveGitView() {
  return $('#gitView').classList.contains('folder-mode') ? 'maven' : gitViewChoice;
}

function applyGitView() {
  const page = $('#gitView');
  const view = effectiveGitView();
  page.classList.toggle('maven-view', view === 'maven');
  $$('.view-switch-btn').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const folder = page.classList.contains('folder-mode');
  $('#viewGitBtn').disabled = folder;
  $('#viewGitBtn').title = folder ? 'This folder has no Git' : 'Git: changes, branches and history';
  if (view === 'maven') closeBranchMenu();
  renderViewRunState();
  renderRepoLoading();
  updateCrumb();
}

function setGitView(view) {
  if (view === gitViewChoice && view === effectiveGitView()) return;
  gitViewChoice = view === 'maven' ? 'maven' : 'git';
  applyGitView();
  saveUiState();
}

// The Maven half of the switch has a green dot while Maven runs in this repository.
function renderViewRunState() {
  const btn = $('#viewMavenBtn');
  const command = mavenRunning.get(currentRepo);
  btn.classList.toggle('mvn-running', Boolean(command));
  btn.title = command
    ? `Maven: ${SERVE_GOALS.test(command) ? 'running' : 'build running'} (${command})`
    : 'Maven: build, start and debug';
}

function setFolderMode(on) {
  $('#gitView').classList.toggle('folder-mode', on);
  if (on) $('#currentBranch').textContent = 'Folder (no Git)';
  applyGitView();
}

// Under the header: where the branch stands next to origin and when origin was last asked (a fetch or a pull), and
// one button for the next step: Fetch, Pull N, Push N... or Pull N, then push. Its arrow has the four of them.
let gitLine = null; // { branch, detached, upstream, ahead, behind, lastFetch, act }

const SYNC_ICONS = {
  fetch: '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
  pull: '<path d="M4 20h16"/><path d="M12 14v-10"/><path d="M12 14l4 -4"/><path d="M12 14l-4 -4"/>',
  push: '<path d="M12 4v10"/><path d="M12 4l4 4"/><path d="M12 4l-4 4"/><path d="M4 20h16"/>',
  both: '<path d="M7 3v14"/><path d="M4 14l3 3l3 -3"/><path d="M17 21v-14"/><path d="M14 10l3 -3l3 3"/>',
};

function fetchedText(ms) {
  if (!ms) return 'not fetched yet';
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return 'fetched just now';
  if (mins < 60) return `fetched ${mins} min ago`;
  if (mins < 1440) return `fetched ${Math.floor(mins / 60)} h ago`;
  const days = Math.floor(mins / 1440);
  return `fetched ${days} day${days === 1 ? '' : 's'} ago`;
}

function renderFetchedAgo() {
  const el = $('#gslText .gsl-fetched');
  if (!el || !gitLine) return;
  el.textContent = fetchedText(gitLine.lastFetch);
  el.title = gitLine.lastFetch ? `Last fetch or pull: ${new Date(gitLine.lastFetch).toLocaleString()}` : 'Fetch to see what is new on origin';
}

function renderGitStatusLine(status) {
  const text = $('#gslText');
  text.textContent = '';
  const part = (cls, label, title) => {
    const el = document.createElement('span');
    el.className = `gsl-part ${cls}`;
    el.textContent = label;
    if (title) el.title = title;
    text.appendChild(el);
    return el;
  };
  const ahead = status.ahead || 0;
  const behind = status.behind || 0;
  const upstream = status.tracking || '';
  const detached = !status.branch || status.branch === 'HEAD';
  if (detached) part('muted', 'Not on a branch (detached HEAD)');
  else if (!upstream) part('muted', `${status.branch} is not on origin yet`, 'Push creates it there');
  else if (!ahead && !behind) part('ok', `Up to date with ${upstream}`);
  else {
    part('upstream', `${upstream}:`);
    if (behind) part('behind', `↓${behind} to pull`, `${plural(behind, 'commit')} on ${upstream} not here yet`);
    if (ahead) part('ahead', `↑${ahead} to push`, `${plural(ahead, 'commit')} here not on ${upstream} yet`);
  }
  if (upstream) part('gsl-fetched', '');

  let act;
  let label;
  let title;
  if (detached) [act, label, title] = ['fetch', 'Fetch', 'See what is new on origin, without changing your files'];
  else if (!upstream) [act, label, title] = ['push', 'Push...', `Create ${status.branch} on origin: see what goes and push it`];
  else if (behind && ahead) [act, label, title] = ['both', `Pull ${behind}, then push`, `Bring the ${plural(behind, 'new commit')} from ${upstream}, then see your ${plural(ahead, 'commit')} to push`];
  else if (behind) [act, label, title] = ['pull', `Pull ${behind}`, `Bring the ${plural(behind, 'new commit')} from ${upstream} into ${status.branch}`];
  else if (ahead) [act, label, title] = ['push', `Push ${ahead}...`, `See the ${plural(ahead, 'commit')} to push to ${upstream} and push them`];
  else [act, label, title] = ['fetch', 'Fetch', 'See what is new on origin, without changing your files'];
  gitLine = { branch: status.branch, detached, upstream, ahead, behind, lastFetch: status.lastFetch || null, act };
  renderFetchedAgo();

  $('#syncMainIcon').innerHTML = `<svg viewBox="0 0 24 24">${SYNC_ICONS[act === 'both' ? 'both' : act]}</svg>`;
  $('#syncMainLabel').textContent = label;
  const main = $('#syncMainBtn');
  main.title = title;
  main.dataset.act = act;
  main.classList.toggle('due', act !== 'fetch');
  $('#syncMoreBtn').classList.toggle('due', act !== 'fetch');

  const changed = (status.entries || []).length;
  $('#gitView .tab[data-tab="changes"]').textContent = changed ? `Changes (${changed})` : 'Changes';
}

async function gitFetch() {
  if (!currentRepo) return;
  showLoading();
  const result = await window.git.fetch(currentRepo);
  hideLoading();
  if (result.error) {
    toast(result.error, 'error', { title: 'Fetch failed' });
  } else {
    if (result.warning) toast(result.warning, 'info', { title: 'Fetched, but some tags did not come' });
    else toast('Fetched', 'success');
    await refresh();
  }
}

// Returns true when the pull went through.
async function gitPull() {
  if (!currentRepo) return false;
  showLoading();
  const result = await window.git.pull(currentRepo);
  hideLoading();
  if (result.error) {
    toast(result.error, 'error', result.conflict ? {} : { title: 'Pull failed' });
    if (result.conflict) await refresh(); // the files in conflict show in Changes
    return false;
  }
  toast('Pulled successfully', 'success');
  await refresh();
  return true;
}

function openPushTab() {
  if ($('#pushTab').classList.contains('hidden')) {
    toast(pushInfo ? `Nothing to push: origin/${pushInfo.target} already has every commit of ${pushInfo.current}` : 'Nothing to push', 'info');
    return;
  }
  $('#pushTab').click();
}

// Push, Stash and Ignored show only when they have something; one that empties while open gives way to Changes.
function showTabIf(tab, on) {
  tab.classList.toggle('hidden', !on);
  if (!on && tab.classList.contains('active')) $('#gitView .tab[data-tab="changes"]').click();
}

async function runSyncMain() {
  const act = $('#syncMainBtn').dataset.act || 'fetch';
  if (act === 'fetch') await gitFetch();
  else if (act === 'pull') await gitPull();
  else if (act === 'push') openPushTab();
  else if (act === 'both' && (await gitPull())) openPushTab();
}

function openSyncMenu() {
  const btn = $('#syncMoreBtn');
  if ($('#actionMenu') && $('#actionMenu').dataset.anchor === btn.id) {
    closeActionMenu();
    return;
  }
  const behind = gitLine ? gitLine.behind : 0;
  const ahead = gitLine ? gitLine.ahead : 0;
  openActionMenu({
    anchor: btn,
    items: [
      { icon: 'fetch', label: 'Fetch', hint: 'See what is new on origin, without changing your files', run: gitFetch },
      { icon: 'pull', label: behind ? `Pull ${behind}` : 'Pull', hint: 'Bring the new commits from origin into this branch', run: gitPull },
      { icon: 'push', label: ahead ? `Push ${ahead}...` : 'Push...', hint: 'See what is ready to push and choose the branch', run: openPushTab },
      { icon: 'stash', label: 'Stash...', hint: 'Put some or all changes aside without committing', run: openStashModal },
    ],
  });
}

async function refreshStatus() {
  if (!currentRepo) return;
  const repoPath = currentRepo;
  const status = await window.git.getStatus(repoPath);
  if (status.error) {
    toast(status.error, 'error');
    return;
  }
  updateRepoSummary(repoPath, status);
  if (repoPath !== currentRepo) return;

  $('#currentBranch').textContent = status.branch || 'detached';
  renderGitStatusLine(status);

  currentEntries = status.entries;
  const known = new Set(currentEntries.map((e) => e.file));
  const off = deselectedFiles(repoPath);
  for (const f of off) if (!known.has(f)) off.delete(f);
  renderFileList();
  showOperation(status);
  // The diff follows the list: closed when its file is no longer changed (or the repository changed), else redrawn.
  if (diffFile && !diffCommit) {
    if (diffRepo !== repoPath || !known.has(diffFile)) closeDiff();
    else loadDiff({ keepScroll: true });
  }
}

const LETTER_TITLES = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Conflict' };

// Every changed file is selected for the commit unless the user unticks it; the choice is kept per repository.
let currentEntries = [];
const deselectedByRepo = new Map();

function deselectedFiles(repo = currentRepo) {
  if (!deselectedByRepo.has(repo)) deselectedByRepo.set(repo, new Set());
  return deselectedByRepo.get(repo);
}

function selectedEntries() {
  const off = deselectedFiles();
  return currentEntries.filter((e) => !off.has(e.file));
}

// How the Changes list is sorted: null keeps Git's order; a click on a column title sorts by that column.
const CHANGES_SORT_KEY = 'changesSort';
const CHANGE_COLUMNS = [['type', 'Type'], ['path', 'Path'], ['date', 'Modified'], ['changes', 'Changes']];
let changesSort = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(CHANGES_SORT_KEY));
    return v && CHANGE_COLUMNS.some(([k]) => k === v.key) && ['asc', 'desc'].includes(v.dir) ? v : null;
  } catch {
    return null;
  }
})();

function changeValue(entry, key) {
  if (key === 'type') return entry.letter;
  if (key === 'path') return entry.file.toLowerCase();
  if (key === 'date') return entry.mtime ?? -1;
  return entry.binary || entry.add === undefined ? -1 : entry.add + entry.del;
}

function sortedEntries() {
  if (!changesSort) return currentEntries;
  const dir = changesSort.dir === 'desc' ? -1 : 1;
  return currentEntries
    .map((e, i) => ({ e, i, v: changeValue(e, changesSort.key) }))
    .sort((a, b) => (typeof a.v === 'number' ? a.v - b.v : a.v.localeCompare(b.v, undefined, { numeric: true })) * dir || a.i - b.i)
    .map((r) => r.e);
}

// The column titles; Modified sorts the newest first, Changes the biggest, the others A to Z; the third click goes
// back to Git's order.
function changesHead() {
  const head = document.createElement('div');
  head.className = 'file-head';
  head.appendChild(document.createElement('span'));
  for (const [key, label] of CHANGE_COLUMNS) {
    const on = changesSort && changesSort.key === key;
    const first = key === 'changes' || key === 'date' ? 'desc' : 'asc';
    const th = document.createElement('button');
    th.type = 'button';
    th.className = `file-th file-th-${key}${on ? ' on' : ''}`;
    th.textContent = label;
    th.title = !on ? `Sort by ${label.toLowerCase()}` : changesSort.dir === first ? 'Sort the other way' : "Back to Git's order";
    if (on) th.appendChild(diffSpan('file-th-arrow', changesSort.dir === 'asc' ? '\u2191' : '\u2193'));
    th.addEventListener('click', () => {
      if (!on) changesSort = { key, dir: first };
      else changesSort = changesSort.dir === first ? { key, dir: first === 'asc' ? 'desc' : 'asc' } : null;
      try {
        if (changesSort) localStorage.setItem(CHANGES_SORT_KEY, JSON.stringify(changesSort));
        else localStorage.removeItem(CHANGES_SORT_KEY);
      } catch {
        // the order is only kept for this session
      }
      renderFileList();
    });
    head.appendChild(th);
  }
  return head;
}

function renderFileList() {
  const list = $('#fileList');
  list.innerHTML = '';
  if (currentEntries.length === 0) list.appendChild(noteEl('Working tree clean'));
  else list.appendChild(changesHead());
  sortedEntries().forEach((entry) => addFileItem(list, entry));
  updateSelectionInfo();
}

function updateSelectionInfo() {
  const total = currentEntries.length;
  const selected = selectedEntries().length;
  $('#changesCount').textContent = total === 0
    ? '0 changes'
    : `${selected} of ${total} file${total !== 1 ? 's' : ''} selected for the commit`;
  const all = $('#selectAllFiles');
  all.disabled = total === 0;
  all.checked = total > 0 && selected === total;
  all.indeterminate = selected > 0 && selected < total;
  selectedCount = selected;
  $('#commitBtn .btn-label').textContent = selected > 0 && selected < total ? `Commit ${selected}` : 'Commit';
  // Revert and Move to ignored folder act on the ticked files, so they only show when some are ticked.
  for (const id of ['#revertBtn', '#parkBtn']) {
    $(id).disabled = selected === 0;
    $(id).classList.toggle('hidden', selected === 0);
  }
  $('#revertBtn .btn-label').textContent = selected > 0 && selected < total ? `Revert ${selected}...` : 'Revert...';
  updateCommitBtn();
}

// The checkbox chooses the file for the commit; a click anywhere else on the row shows its diff in a popup.
function addFileItem(container, entry) {
  const div = document.createElement('div');
  div.className = `file-item${entry.file === diffFile ? ' selected' : ''}`;
  div.dataset.file = entry.file;
  div.tabIndex = 0;
  div.title = 'Click to see what changed';
  div.addEventListener('click', () => openDiff(entry));
  div.addEventListener('keydown', (e) => {
    if (e.target !== div) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      openDiff(entry);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Up and down move through the files; with the diff open, it follows.
      const next = e.key === 'ArrowDown' ? div.nextElementSibling : div.previousElementSibling;
      if (next && next.classList.contains('file-item')) {
        e.preventDefault();
        next.focus();
        if (diffFile) next.click();
      }
    }
  });

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'file-check';
  box.title = 'Include this file in the commit';
  box.checked = !deselectedFiles().has(entry.file);
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('change', () => {
    if (box.checked) deselectedFiles().delete(entry.file);
    else deselectedFiles().add(entry.file);
    updateSelectionInfo();
  });

  const letter = document.createElement('span');
  letter.className = `file-status ${entry.letter}`;
  letter.textContent = entry.letter;
  letter.title = LETTER_TITLES[entry.letter] || entry.letter;

  // The whole path, with the folders in grey so the file name stands out; a rename shows where it came from.
  const slash = entry.file.lastIndexOf('/');
  const where = document.createElement('span');
  where.className = 'file-path';
  const dir = `${entry.from ? `${entry.from} \u2192 ` : ''}${entry.file.slice(0, slash + 1)}`;
  if (dir) where.append(diffSpan('fp-dir', dir));
  where.append(diffSpan('fp-base', entry.file.slice(slash + 1)));
  where.title = `${entry.from ? `${entry.from} -> ${entry.file}` : entry.file}\nClick to see what changed`;

  // When the file last changed on disk; a deleted file has no date.
  const when = diffSpan('file-date', entry.mtime ? formatDate(entry.mtime) : '\u2014');
  when.title = entry.mtime ? `Changed ${new Date(entry.mtime).toLocaleString()}` : 'Deleted: no date';

  const counts = document.createElement('span');
  counts.className = 'file-counts';
  if (entry.binary) counts.append(diffSpan('fc-bin', 'binary'));
  else if (entry.add !== undefined) counts.append(diffSpan('add', `+${entry.add}`), diffSpan('del', `−${entry.del}`));

  div.append(box, letter, where, when, counts);
  container.appendChild(div);
}

// -- Diff of the clicked file, in a popup over the list in the Changes tab --
const DIFF_MAX_LINES = 6000;
const DIFF_LAYOUT_KEY = 'diffLayout';
let diffRequest = 0;
let diffFile = null;
let diffRepo = null;
let diffEntry = null;
let diffFull = false;
let diffResult = null;
let diffTarget = null; // the two files of the split diff on screen (see diffTargetForChanges)
let diffCommit = null; // { hash, short, files } when the diff shows a file a commit changed (Log, Push, Branches)
let diffGroups = [];
let diffCursor = -1;
let diffJumpAt = 0;
let diffLayout = (() => {
  try {
    return localStorage.getItem(DIFF_LAYOUT_KEY) === 'unified' ? 'unified' : 'split';
  } catch {
    return 'split';
  }
})();

// Unified diff text -> header facts plus one row per line, with old and new line numbers.
function parseDiff(text) {
  const meta = { newFile: false, deleted: false, binary: false, renamedFrom: null, oldMode: null, newMode: null };
  const rows = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      inHunk = true;
      rows.push({
        type: 'hunk',
        text: line,
        range: line.slice(0, line.indexOf('@@', 2) + 2),
        oldStart: oldNo,
        oldCount: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newStart: newNo,
        newCount: hunk[4] === undefined ? 1 : Number(hunk[4]),
        // The function or block the change is in, as Git reports it ("async pushTo(target) {" -> "async pushTo(target)").
        context: hunk[5].trim().replace(/\s*\{\s*$/, ''),
      });
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (/^new file/.test(line)) meta.newFile = true;
      else if (/^deleted file/.test(line)) meta.deleted = true;
      else if (line.startsWith('rename from ')) meta.renamedFrom = line.slice('rename from '.length);
      else if (/^Binary files /.test(line)) meta.binary = true;
      else if (line.startsWith('old mode ')) meta.oldMode = line.slice('old mode '.length);
      else if (line.startsWith('new mode ')) meta.newMode = line.slice('new mode '.length);
      continue;
    }
    const sign = line[0];
    // oldAt / newAt: where the line would go on the side that does not have it
    if (sign === '+') rows.push({ type: 'add', newNo: newNo++, oldAt: oldNo, text: line.slice(1) });
    else if (sign === '-') rows.push({ type: 'del', oldNo: oldNo++, newAt: newNo, text: line.slice(1) });
    else if (sign === ' ') rows.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    else if (sign === '\\') rows.push({ type: 'note', text: line.slice(2) });
  }
  return { meta, rows };
}

function diffSpan(cls, text) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function diffTokens(s) {
  return s.match(/\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g) || [];
}

// Marks the words that differ between a removed line and the added line that replaces it (longest common
// subsequence of words). Returns null when the lines have little in common: then the whole line is the change.
function wordDiff(a, b) {
  const x = diffTokens(a);
  const y = diffTokens(b);
  const n = x.length;
  const m = y.length;
  if (n === 0 || m === 0 || n * m > 60000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const left = [];
  const right = [];
  const add = (out, text, changed) => {
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += text;
    else out.push({ text, changed });
  };
  let same = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      if (x[i].trim()) same += x[i].length;
      add(left, x[i++], false);
      add(right, y[j++], false);
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      add(left, x[i++], true);
    } else {
      add(right, y[j++], true);
    }
  }
  while (i < n) add(left, x[i++], true);
  while (j < m) add(right, y[j++], true);
  const total = a.replace(/\s/g, '').length + b.replace(/\s/g, '').length;
  if (total === 0 || (2 * same) / total < 0.35) return null;
  return { left, right };
}

// In each run of removed lines followed by added lines, the n-th removed line is compared with the n-th added one.
function annotateWords(rows) {
  for (let i = 0; i < rows.length; ) {
    if (rows[i].type !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (d < rows.length && rows[d].type === 'del') d++;
    let a = d;
    while (a < rows.length && rows[a].type === 'add') a++;
    for (let k = 0; k < Math.min(d - i, a - d); k++) {
      const words = wordDiff(rows[i + k].text, rows[d + k].text);
      if (words) {
        rows[i + k].words = words.left;
        rows[d + k].words = words.right;
      }
    }
    i = a;
  }
}

// Git names a hunk after the last function that starts ABOVE it, so a change to a function's own first lines is
// labelled with the function before it. When the hunk itself shows where a function starts, that name is better:
// a definition inside the first run of changes wins, else the last one in the unchanged lines before it.
const DEF_LINE = new RegExp([
  String.raw`^\s*(?:(?:export|default|public|private|protected|internal|static|final|abstract|override|synchronized|async|suspend|open|inline)\s+)*`,
  '(?:',
  String.raw`function\b[^=]*\(`,
  String.raw`|def\s+\w+|class\s+\w+|interface\s+\w+|enum\s+\w+|fun\s+\w+|func\s+\w+|record\s+\w+`,
  String.raw`|(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)`,
  String.raw`|(?:[\w$<>\[\],.?]+\s+)*[A-Za-z_$][\w$]*\s*\([^;]*\)\s*(?:throws\s+[\w.,\s]+)?(?:\{|=>)\s*$`,
  ')',
].join(''));
const NOT_DEF = /^\s*(?:if|else|for|while|do|switch|case|catch|return|try|finally|with|new|await|throw|yield|super|this)\b/;

const isDefinition = (text) => DEF_LINE.test(text) && !NOT_DEF.test(text);
const defName = (text) => text.trim().replace(/\s*(?:\{|=>\s*\{?)\s*$/, '').trim();

function improveHunkNames(rows) {
  for (let h = 0; h < rows.length; h++) {
    if (rows[h].type !== 'hunk') continue;
    let before = null;
    let inside = null;
    let seenChange = false;
    for (let i = h + 1; i < rows.length && rows[i].type !== 'hunk'; i++) {
      const row = rows[i];
      if (row.type === 'del' || row.type === 'add') seenChange = true;
      else if (seenChange) break;
      if (row.type === 'del' || row.type === 'note' || !isDefinition(row.text)) continue;
      if (seenChange) {
        inside = row.text;
        break;
      }
      before = row.text;
    }
    const best = inside || before;
    if (best) rows[h].context = defName(best);
  }
}

// Rows with folds in the gaps between the shown parts ("128 unchanged lines").
// full: no folds (the whole file is shown). onShow: what a fold's Show button does (the Changes diff by default).
function diffSequence(rows, meta, full = diffFull, onShow = showWholeFile) {
  const items = [];
  let prevOldEnd = null;
  for (const row of rows) {
    if (row.type === 'hunk') {
      const gap = prevOldEnd === null ? row.oldStart - 1 : row.oldStart - prevOldEnd;
      if (!full && !meta.newFile && gap > 0) items.push({ kind: 'fold', count: gap, newLine: row.newStart - gap, onShow });
      prevOldEnd = row.oldStart + row.oldCount;
      items.push({ kind: 'hunk', row });
    } else {
      items.push({ kind: 'line', row });
    }
  }
  return items;
}

function codeEl(row) {
  const code = document.createElement('span');
  code.className = 'dl-code';
  if (row && row.words) {
    row.words.forEach((w) => (w.changed ? code.appendChild(diffSpan('dl-word', w.text)) : code.append(w.text)));
  } else {
    code.textContent = row ? row.text : '';
  }
  if (!code.textContent) code.textContent = ' ';
  return code;
}

const DIFF_SIGNS = { add: '+', del: '−', ctx: '' };

function hunkEl(row) {
  const el = document.createElement('div');
  el.className = 'dh';
  if (row.context) el.appendChild(diffSpan('dh-ctx', row.context));
  el.appendChild(diffSpan('dh-range', row.range));
  return el;
}

function foldEl(item) {
  const el = document.createElement('div');
  el.className = 'df';
  el.appendChild(diffSpan('', plural(item.count, 'unchanged line')));
  const show = document.createElement('button');
  show.type = 'button';
  show.className = 'df-show';
  show.textContent = 'Show';
  show.title = 'Show the whole file';
  show.addEventListener('click', () => (item.onShow || showWholeFile)(item.newLine));
  el.appendChild(show);
  return el;
}

function noteRowEl(row) {
  const el = document.createElement('div');
  el.className = 'dl-note';
  el.textContent = row.text;
  return el;
}

function renderUnified(items) {
  const box = document.createElement('div');
  box.className = 'diff-lines';
  let inChange = false;
  for (const item of items) {
    if (item.kind === 'hunk') box.appendChild(hunkEl(item.row));
    else if (item.kind === 'fold') box.appendChild(foldEl(item));
    else if (item.row.type === 'note') box.appendChild(noteRowEl(item.row));
    else {
      const row = item.row;
      const el = document.createElement('div');
      el.className = `dl ${row.type}`;
      if (row.newNo !== undefined) el.dataset.new = row.newNo;
      el.append(
        diffSpan('dl-no', row.oldNo === undefined ? '' : String(row.oldNo)),
        diffSpan('dl-no', row.newNo === undefined ? '' : String(row.newNo)),
        diffSpan('dl-sign', DIFF_SIGNS[row.type]),
        codeEl(row)
      );
      const change = row.type !== 'ctx';
      if (change && !inChange) diffGroups.push(el);
      inChange = change;
      box.appendChild(el);
      continue;
    }
    inChange = false;
  }
  return box;
}

// target (the diff's two files, see diffTargetFor...): a changed line gets an arrow that puts it on the other side,
// when that side can be written.
function splitCell(row, side, target, other) {
  const cell = document.createElement('div');
  cell.className = `ds-cell side-${side} ${row ? row.type : 'empty'}`;
  const no = row ? (side === 'left' ? row.oldNo : row.newNo) : undefined;
  cell.append(diffSpan('dl-no', no === undefined ? '' : String(no)), diffSpan('dl-sign', row ? DIFF_SIGNS[row.type] : ''), codeEl(row));
  const to = side === 'left' ? 'right' : 'left';
  if (target && row && row.type !== 'ctx' && target.writable[to]) cell.appendChild(lineArrow(target, side, row, other));
  return cell;
}

function renderSplit(items, target = null) {
  const box = document.createElement('div');
  box.className = 'diff-lines split';
  if (target) {
    box.classList.toggle('use-right', target.writable.right);
    box.classList.toggle('use-left', target.writable.left);
  }
  let dels = [];
  let adds = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const el = document.createElement('div');
      el.className = 'ds';
      if (adds[k]) el.dataset.new = adds[k].newNo;
      el.diffRows = { left: dels[k] || null, right: adds[k] || null };
      el.append(splitCell(dels[k], 'left', target, adds[k]), splitCell(adds[k], 'right', target, dels[k]));
      if (k === 0) diffGroups.push(el);
      box.appendChild(el);
    }
    dels = [];
    adds = [];
  };
  for (const item of items) {
    const row = item.row;
    if (item.kind === 'line' && row.type === 'del') {
      if (adds.length) flush();
      dels.push(row);
      continue;
    }
    if (item.kind === 'line' && row.type === 'add') {
      adds.push(row);
      continue;
    }
    flush();
    if (item.kind === 'hunk') box.appendChild(hunkEl(row));
    else if (item.kind === 'fold') box.appendChild(foldEl(item));
    else if (row.type === 'note') box.appendChild(noteRowEl(row));
    else {
      const el = document.createElement('div');
      el.className = 'ds';
      el.dataset.new = row.newNo;
      el.diffRows = { left: row, right: row };
      el.append(splitCell(row, 'left', target), splitCell(row, 'right', target));
      box.appendChild(el);
    }
  }
  flush();
  return box;
}

// -- Taking text from one side of a split diff to the other --
// A target is the diff on screen: its two files ({ kind, file, folder } for the main process), which of them can
// be written, and what to do after a change. Every change reads the file again first and checks that the lines it
// replaces are still the ones on screen, so nothing written meanwhile is lost.
function diffTargetForChanges(entry) {
  return {
    sides: { left: { kind: 'head', file: entry.from || entry.file }, right: { kind: 'work', file: entry.file } },
    writable: { left: false, right: true },
    names: { left: 'the last commit', right: 'your working copy' },
    after: async () => {
      await refreshStatus();
      if (diffFile) loadDiff({ keepScroll: true });
    },
  };
}

function diffTargetForIgnored(sel) {
  return {
    sides: { left: { kind: 'project', folder: sel.folder, file: sel.file }, right: { kind: 'parked', folder: sel.folder, file: sel.file } },
    writable: { left: true, right: true },
    names: { left: 'the file in the project', right: 'your copy' },
    after: async () => {
      await refreshStatus();
      loadIgnoredDiff({ keepScroll: true });
    },
  };
}

function splitDoc(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const endsWithEol = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (endsWithEol) lines.pop();
  return { eol, endsWithEol, lines };
}

const joinDoc = (doc) => doc.lines.join(doc.eol) + (doc.endsWithEol || doc.lines.length === 0 ? doc.eol : '');

// at: 1-based line; count: lines replaced there (0 inserts); expect: the text those lines must still have.
async function changeDiffSide(target, side, { at, count = 0, lines, expect = [] }) {
  const read = await window.git.sideRead(currentRepo, target.sides[side]);
  if (read.error) {
    toast(read.error, 'error');
    return false;
  }
  const doc = splitDoc(read.text);
  const same = expect.every((text, i) => doc.lines[at - 1 + i] === text);
  if (at < 1 || at > doc.lines.length + 1 || !same) {
    toast('The file changed since this diff was shown. Here it is again.', 'error');
    target.after();
    return false;
  }
  doc.lines.splice(at - 1, count, ...lines);
  const write = await window.git.sideWrite(currentRepo, target.sides[side], joinDoc(doc));
  if (write.error) {
    toast(write.error, 'error');
    return false;
  }
  await target.after();
  return true;
}

// The arrow on a changed line: the line goes to the other side, in place of the line it faces there (or, with
// nothing in front of it, where it belongs in that file).
function lineArrow(target, side, row, other) {
  const to = side === 'left' ? 'right' : 'left';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ds-use';
  b.textContent = side === 'left' ? '→' : '←';
  b.title = `Use this line in ${target.names[to]}`;
  b.setAttribute('aria-label', b.title);
  b.addEventListener('mousedown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const noKey = to === 'right' ? 'newNo' : 'oldNo';
    const atKey = to === 'right' ? 'newAt' : 'oldAt';
    if (other) changeDiffSide(target, to, { at: other[noKey], count: 1, lines: [row.text], expect: [other.text] });
    else changeDiffSide(target, to, { at: row[atKey], lines: [row.text] });
  });
  return b;
}

// The text selected on one side of a split diff: the side, the rows it spans and their text (whole lines are taken
// from the diff itself, so an empty line stays empty).
function splitSelection(box) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!box.contains(range.commonAncestorContainer)) return null;
  const cellOf = (node) => (node.nodeType === 1 ? node : node.parentElement).closest('.ds-cell');
  const startCell = cellOf(range.startContainer);
  const side = (startCell && startCell.classList.contains('side-right')) || box.dataset.select === 'right' ? 'right' : 'left';
  const rows = [...box.querySelectorAll('.ds')].filter((el) => range.intersectsNode(el));
  const parts = [];
  const used = [];
  for (const el of rows) {
    const row = el.diffRows && el.diffRows[side];
    const code = el.querySelector(`.side-${side} .dl-code`);
    if (!row || !code || !range.intersectsNode(code)) continue;
    const sub = document.createRange();
    sub.selectNodeContents(code);
    const startsInside = code.contains(range.startContainer);
    const endsInside = code.contains(range.endContainer);
    if (startsInside) sub.setStart(range.startContainer, range.startOffset);
    if (endsInside) sub.setEnd(range.endContainer, range.endOffset);
    parts.push(startsInside || endsInside ? sub.toString() : row.text);
    used.push(el);
  }
  if (!used.length) return null;
  return { side, rows: used, text: parts.join('\n') };
}

function closeDiffMenu() {
  const menu = $('#diffMenu');
  if (menu) menu.remove();
}

// Right-click on a selection: use the selected text on the other side, in place of the lines facing it, before them
// or after them.
function openDiffMenu(e, box, target) {
  const picked = splitSelection(box);
  if (!picked) return;
  e.preventDefault();
  closeDiffMenu();
  const to = picked.side === 'left' ? 'right' : 'left';
  const noKey = to === 'right' ? 'newNo' : 'oldNo';
  const atKey = to === 'right' ? 'newAt' : 'oldAt';
  const facing = picked.rows.map((el) => el.diffRows[to]).filter(Boolean);
  const first = facing.length ? facing[0][noKey] : picked.rows.map((el) => el.diffRows[picked.side][atKey]).find((n) => n !== undefined);
  const last = facing.length ? facing[facing.length - 1][noKey] : first - 1;
  const lines = picked.text.split('\n');
  const menu = document.createElement('div');
  menu.id = 'diffMenu';
  menu.className = 'clip-menu diff-menu';
  menu.setAttribute('role', 'menu');
  const item = (label, title, run, disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'clip-menu-item';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', () => {
      closeDiffMenu();
      run();
    });
    menu.appendChild(b);
  };
  const can = target.writable[to] && first !== undefined;
  const where = target.names[to];
  item('Use this text', `Put it in ${where}, in place of the lines facing it`, () => changeDiffSide(target, to, { at: first, count: facing.length ? last - first + 1 : 0, lines, expect: facing.map((r) => r.text) }), !can);
  item('Use this text before', `Put it in ${where}, before the lines facing it`, () => changeDiffSide(target, to, { at: first, lines }), !can);
  item('Use this text after', `Put it in ${where}, after the lines facing it`, () => changeDiffSide(target, to, { at: last + 1, lines }), !can);
  if (!target.writable[to]) menu.appendChild(diffSpan('diff-menu-note', `${where[0].toUpperCase()}${where.slice(1)} cannot be changed.`));
  menu.appendChild(Object.assign(document.createElement('div'), { className: 'diff-menu-sep' }));
  item('Copy', 'Copy the selected text', () => copyText(picked.text, 'Text'));
  document.body.appendChild(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(e.clientX, window.innerWidth - w - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(e.clientY, window.innerHeight - h - 8))}px`;
  (menu.querySelector('button:not(:disabled)') || menu.querySelector('button')).focus();
}

// On a split diff: the side the mouse goes down on is the only one that can be selected, and right-click on a
// selection opens the menu above. getTarget: the target of the diff on screen, or null (unified, or no diff).
function setupSplitTools(body, getTarget) {
  body.addEventListener('mousedown', (e) => {
    const box = body.querySelector('.diff-lines.split');
    const cell = e.target.closest && e.target.closest('.ds-cell');
    if (box && cell && e.button === 0) box.dataset.select = cell.classList.contains('side-right') ? 'right' : 'left';
  });
  body.addEventListener('contextmenu', (e) => {
    const box = body.querySelector('.diff-lines.split');
    const target = getTarget();
    if (box && target) openDiffMenu(e, box, target);
  });
  body.addEventListener('scroll', closeDiffMenu);
}

// "Use this file": the whole file of one side becomes the other side.
async function useWholeSide(target, from, label) {
  const to = from === 'left' ? 'right' : 'left';
  if (!target || !target.writable[to]) return;
  if (!(await window.git.confirm(`Replace ${target.names[to]} with ${target.names[from]} (${label})? Its differences are lost.`))) return;
  const read = await window.git.sideRead(currentRepo, target.sides[from]);
  if (read.error) {
    toast(read.error, 'error');
    return;
  }
  const write = await window.git.sideWrite(currentRepo, target.sides[to], read.text);
  if (write.error) {
    toast(write.error, 'error');
    return;
  }
  toast(`${target.names[to][0].toUpperCase()}${target.names[to].slice(1)} is now ${target.names[from]}`, 'success');
  await target.after();
}

function renderDiffBody() {
  const body = $('#diffBody');
  body.textContent = '';
  diffTarget = null;
  closeDiffMenu();
  diffGroups = [];
  diffCursor = -1;
  const result = diffResult;
  const stats = $('#diffStats');
  stats.textContent = '';
  const note = $('#diffNote');
  note.textContent = '';
  if (!result) return;
  if (result.error) {
    $('#diffCols').classList.add('hidden');
    body.appendChild(noteEl(result.error));
    updateDiffPos();
    return;
  }
  const { meta, rows } = parseDiff(result.diff);
  annotateWords(rows);
  improveHunkNames(rows);
  const added = rows.filter((r) => r.type === 'add').length;
  const removed = rows.filter((r) => r.type === 'del').length;
  if (added || removed) stats.append(diffSpan('add', `+${added}`), diffSpan('del', `−${removed}`));

  const notes = [];
  if (meta.newFile) notes.push(diffEntry && diffEntry.untracked ? 'New file, not yet tracked by Git.' : 'New file.');
  if (meta.deleted) notes.push('Deleted file.');
  if (meta.renamedFrom) notes.push(`Renamed from ${meta.renamedFrom}.`);
  if (meta.oldMode && meta.newMode) notes.push(`File mode changed from ${meta.oldMode} to ${meta.newMode}.`);
  if (result.truncated || rows.length > DIFF_MAX_LINES) notes.push('The diff is very long, so only the first part is shown.');
  if (diffFull) notes.push('Showing the whole file.');
  if (notes.length) note.append(notes.join(' '));
  if (diffFull) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'diff-note-link';
    back.textContent = 'Only the changes';
    back.addEventListener('click', () => {
      diffFull = false;
      loadDiff();
    });
    note.append(' ', back);
  }
  note.classList.toggle('hidden', notes.length === 0);

  // A new or deleted file has only one side, which reads better in one column.
  const oneSide = meta.newFile || meta.deleted;
  const layout = oneSide ? 'unified' : diffLayout;
  $$('#diffLayout .seg-btn').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.layout === layout));
    b.disabled = oneSide;
  });
  const hasText = !meta.binary && rows.length > 0;
  $('#diffCols').classList.toggle('hidden', !hasText || layout !== 'split');
  if (meta.binary) body.appendChild(noteEl('Binary file: there is no text to compare.'));
  else if (!hasText) body.appendChild(noteEl(meta.newFile ? 'The file is empty.' : 'No changes in the content of the file.'));
  else {
    const items = diffSequence(rows.slice(0, DIFF_MAX_LINES), meta);
    diffTarget = layout === 'split' && diffEntry && !diffCommit ? diffTargetForChanges(diffEntry) : null;
    body.appendChild(layout === 'split' ? renderSplit(items, diffTarget) : renderUnified(items));
  }
  updateDiffPos();
}

function showDiffHeader(entry) {
  const status = $('#diffStatus');
  status.className = `file-status ${entry.letter}`;
  status.textContent = entry.letter;
  status.title = LETTER_TITLES[entry.letter] || entry.letter;
  const pathEl = $('#diffPath');
  pathEl.textContent = '';
  const slash = entry.file.lastIndexOf('/');
  if (slash !== -1) pathEl.appendChild(diffSpan('dp-dir', entry.file.slice(0, slash + 1)));
  pathEl.appendChild(diffSpan('dp-base', entry.file.slice(slash + 1)));
  pathEl.title = entry.from ? `${entry.from} -> ${entry.file}` : entry.file;
}

async function loadDiff({ keepScroll = false, scrollToNewLine = null } = {}) {
  const commit = diffCommit;
  const entry = (commit ? commit.files : currentEntries).find((e) => e.file === diffFile);
  if (!entry || !currentRepo) {
    closeDiff();
    return;
  }
  const repoPath = currentRepo;
  const request = ++diffRequest;
  showDiffHeader(entry);
  showDiffSides(commit);
  const body = $('#diffBody');
  const top = keepScroll ? body.scrollTop : 0;
  if (!keepScroll) {
    body.textContent = '';
    body.appendChild(noteEl('Loading...'));
  }
  let result;
  try {
    if (commit && commit.compare) result = await window.git.compareFileDiff(repoPath, commit.base, commit.hash, entry.file, entry.from, { full: diffFull });
    else if (commit) result = await window.git.commitFileDiff(repoPath, commit.hash, entry.file, entry.from, { full: diffFull });
    else result = await window.git.fileDiff(repoPath, entry.file, entry.from, { full: diffFull });
  } catch (e) {
    result = { error: e.message };
  }
  if (request !== diffRequest || repoPath !== currentRepo || diffFile !== entry.file || diffCommit !== commit) return;
  diffEntry = entry;
  diffResult = result;
  renderDiffBody();
  const target = scrollToNewLine !== null ? body.querySelector(`[data-new="${scrollToNewLine}"]`) : null;
  body.scrollTop = target ? Math.max(0, target.offsetTop - 40) : top;
  diffCursor = currentGroupIndex();
  updateDiffPos();
}

// "Show" on a fold: the whole file, scrolled to the first line that was hidden.
function showWholeFile(newLine) {
  diffFull = true;
  loadDiff({ scrollToNewLine: newLine });
}

// The diff opens in a popup over the list.
function setDiffOpen(open) {
  $('#diffModal').classList.toggle('hidden', !open);
  $('#diffPanel').classList.toggle('hidden', !open);
  updateCrumb();
}

function markSelectedFile() {
  $$('#fileList .file-item').forEach((el) => el.classList.toggle('selected', !diffCommit && el.dataset.file === diffFile));
  $$('#logList .log-file:not(.cmp-file), .push-file[data-hash]').forEach((el) => el.classList.toggle('selected', Boolean(diffCommit) && el.dataset.hash === diffCommit.hash && el.dataset.file === diffFile));
  $$('#logList .cmp-file').forEach((el) => el.classList.toggle('selected', Boolean(diffCommit && diffCommit.compare) && el.dataset.file === diffFile && el.dataset.base === diffCommit.base && el.dataset.to === diffCommit.hash));
}

// What the two columns are: the last commit and your copy, a commit and the one before it, or the two sides of Compare
// (nothing to change in the last two).
function showDiffSides(commit) {
  const label = (el, strong, rest) => {
    el.textContent = '';
    const b = document.createElement('strong');
    b.textContent = strong;
    el.append(b, ` · ${rest}`);
  };
  if (commit && commit.compare) {
    label($('#diffLeftLabel'), 'From', commit.baseLabel);
    label($('#diffRightLabel'), 'To', commit.label);
  } else {
    label($('#diffLeftLabel'), 'Before', commit ? `the commit before ${commit.short}` : 'last commit (HEAD)');
    label($('#diffRightLabel'), 'After', commit ? `commit ${commit.short}` : 'your working copy');
  }
  $('#diffUseLeftBtn').classList.toggle('hidden', Boolean(commit));
}

// A file a commit changed, from the Log or the commit lists of Push and Branches.
function openCommitDiff(commit, file) {
  if (!currentRepo) return;
  const same = Boolean(diffCommit) && diffCommit.hash === commit.fullHash && diffFile === file.file && diffRepo === currentRepo;
  if (!same) diffFull = false;
  diffCommit = { hash: commit.fullHash, short: commit.hash, files: commit.files };
  diffFile = file.file;
  diffRepo = currentRepo;
  setDiffOpen(true);
  markSelectedFile();
  loadDiff({ keepScroll: same });
}

function openDiff(entry) {
  if (!currentRepo) return;
  const same = !diffCommit && diffFile === entry.file && diffRepo === currentRepo;
  diffCommit = null;
  if (!same) diffFull = false;
  diffFile = entry.file;
  diffRepo = currentRepo;
  setDiffOpen(true);
  markSelectedFile();
  loadDiff({ keepScroll: same });
}

function closeDiff() {
  if (!diffFile) return;
  diffRequest++;
  diffFile = null;
  diffRepo = null;
  diffEntry = null;
  diffResult = null;
  diffFull = false;
  diffCommit = null;
  setDiffOpen(false);
  markSelectedFile();
}

// The change at the top of the visible area. Before the first one has scrolled up to the top, the first one
// counts as current if it is on screen (so Next goes to the second); -1 while it is still below the visible area.
function currentGroupIndex() {
  const body = $('#diffBody');
  const y = body.scrollTop + 48;
  let index = -1;
  diffGroups.forEach((el, i) => {
    if (el.offsetTop <= y) index = i;
  });
  if (index === -1 && diffGroups.length && diffGroups[0].offsetTop < body.scrollTop + body.clientHeight) index = 0;
  return index;
}

function updateDiffPos() {
  const n = diffGroups.length;
  $('#diffPos').textContent = n === 0 ? 'No changes' : `Change ${Math.max(1, diffCursor + 1)} of ${n}`;
  $('#diffPrevBtn').disabled = n === 0 || diffCursor <= 0;
  $('#diffNextBtn').disabled = n === 0 || diffCursor >= n - 1;
}

function jumpChange(step) {
  if (diffGroups.length === 0) return;
  const index = Math.min(diffGroups.length - 1, Math.max(0, diffCursor + step));
  diffCursor = index;
  diffJumpAt = Date.now();
  $('#diffBody').scrollTop = Math.max(0, diffGroups[index].offsetTop - 36);
  updateDiffPos();
}

function setupDiff() {
  $('#diffCloseBtn').addEventListener('click', closeDiff);
  setupSplitTools($('#diffBody'), () => diffTarget);
  $('#diffUseLeftBtn').addEventListener('click', () => useWholeSide(diffTarget, 'left', diffFile));
  // the right-click menu closes on a click elsewhere and on Esc (before Esc closes the diff itself)
  document.addEventListener('mousedown', (e) => {
    if ($('#diffMenu') && !e.target.closest('#diffMenu')) closeDiffMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#diffMenu')) {
      e.preventDefault();
      e.stopPropagation();
      closeDiffMenu();
    }
  }, true);
  window.addEventListener('blur', closeDiffMenu);
  $('#diffPrevBtn').addEventListener('click', () => jumpChange(-1));
  $('#diffNextBtn').addEventListener('click', () => jumpChange(1));
  $$('#diffLayout .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      diffLayout = b.dataset.layout;
      try {
        localStorage.setItem(DIFF_LAYOUT_KEY, diffLayout);
      } catch {
        // not remembered, but the layout still applies
      }
      renderDiffBody();
    })
  );
  $('#diffBody').addEventListener('scroll', () => {
    // A jump sets the position itself; the scroll it causes must not undo that.
    if (Date.now() - diffJumpAt > 200) diffCursor = currentGroupIndex();
    updateDiffPos();
  });
  // a click outside the popup closes it
  $('#diffModal').addEventListener('mousedown', (e) => {
    if (e.target.id === 'diffModal') closeDiff();
  });
  // Esc closes the diff, J and K move between changes (not while typing, nor over another dialog or a menu).
  document.addEventListener('keydown', (e) => {
    if (!diffFile || currentMode !== 'git' || $('#diffPanel').classList.contains('hidden')) return;
    if (document.querySelector('.settings-overlay:not(.hidden):not(#diffModal)') || $('#repoMenu')) return;
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDiff();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'j' || e.key === 'k')) {
      e.preventDefault();
      jumpChange(e.key === 'j' ? 1 : -1);
    }
  });
}

// The branches on origin: where Push can go, and what a new branch can copy.
async function refreshBranches() {
  if (!currentRepo) return;
  const repoPath = currentRepo;
  const data = await window.git.getBranches(repoPath);
  if (data.error || repoPath !== currentRepo) return;
  // Only branches on origin: new branches copy one of them and pushes go to origin.
  remoteBranchNames = data.remote.filter((b) => b.fullName.startsWith('remotes/origin/')).map((b) => b.name);
  renderPushTargetOptions();
}

// A remote branch is switched to by its short name: Git makes a local branch that follows origin/<name>
// (or goes to the local one when it already exists).
async function switchBranch(name) {
  showLoading();
  const result = await window.git.checkoutBranch(currentRepo, name);
  hideLoading();
  if (result.error) {
    toast(result.error, 'error', { title: `Couldn't switch to ${name}` });
  } else {
    toast(`Switched to ${name}`, 'success');
    await refresh();
  }
}

// -- Branch list under the branch name: local and remote branches, a search box, a click switches --
function closeBranchMenu(refocus = false) {
  const menu = $('#branchMenu');
  if (!menu) return;
  menu.remove();
  const btn = $('#branchSwitchBtn');
  btn.setAttribute('aria-expanded', 'false');
  btn.classList.remove('open');
  if (refocus) btn.focus();
}

async function openBranchMenu() {
  if ($('#branchMenu')) {
    closeBranchMenu();
    return;
  }
  if (!currentRepo || $('#gitView').classList.contains('folder-mode')) return;
  const repoPath = currentRepo;
  const btn = $('#branchSwitchBtn');
  const menu = document.createElement('div');
  menu.id = 'branchMenu';
  menu.className = 'clip-menu branch-menu';
  menu.setAttribute('role', 'menu');
  const search = document.createElement('input');
  search.className = 'input branch-menu-search';
  search.placeholder = 'Search branches and tags...';
  search.spellcheck = false;
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search branches and tags');
  const list = document.createElement('div');
  list.className = 'branch-menu-list';
  list.appendChild(noteEl('Loading...'));
  // at the foot: a new branch, named after the search when nothing matches it
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'clip-menu-item branch-menu-new';
  add.title = 'Create a branch from one on origin (fetched first, so it is up to date) and switch to it';
  add.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS.plus}</svg>`;
  add.append('New branch...');
  add.addEventListener('click', () => openNewBranchForm(menu, add, items().length > 1 ? '' : search.value.trim()));
  menu.append(search, list, add);

  let groups = null;
  const items = () => [...list.querySelectorAll('.branch-menu-item'), add];
  const render = () => {
    if (!groups) return;
    const q = search.value.trim().toLowerCase();
    list.textContent = '';
    let shown = 0;
    for (const [title, branches] of groups) {
      const hits = q ? branches.filter((b) => b.label.toLowerCase().includes(q)) : branches;
      if (hits.length === 0) continue;
      const head = document.createElement('div');
      head.className = 'branch-menu-group';
      head.textContent = `${title} (${hits.length})`;
      list.appendChild(head);
      for (const b of hits) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `clip-menu-item branch-menu-item${b.current ? ' current' : ''}`;
        item.setAttribute('role', 'menuitem');
        item.title = b.hint;
        item.innerHTML = '<svg class="branch-menu-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>';
        if (b.tag) item.insertAdjacentHTML('beforeend', `<svg class="branch-menu-tag" viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS.tag}</svg>`);
        const label = document.createElement('span');
        label.className = 'branch-menu-name';
        label.textContent = b.label;
        item.appendChild(label);
        item.addEventListener('click', () => {
          closeBranchMenu(b.current);
          if (b.tag) checkoutTagFromMenu(b.name);
          else if (!b.current) switchBranch(b.name);
        });
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openBranchActions(menu, item, b, e.clientX, e.clientY);
        });
        list.appendChild(item);
      }
      shown += hits.length;
    }
    if (shown === 0) list.appendChild(noteEl(q ? 'No branch matches the search' : 'No branches'));
  };

  search.addEventListener('input', render);
  menu.addEventListener('keydown', (e) => {
    if (e.target.closest('#branchActions')) return; // the right-click menu has its own keys
    const all = items();
    const i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (all.length === 0) return;
      const next = i + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) search.focus();
      else all[Math.min(next, all.length - 1)].focus();
    } else if (e.key === 'Enter' && document.activeElement === search) {
      e.preventDefault();
      if (all[0]) all[0].click();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeBranchMenu(true);
    } else if (e.key === 'Tab') {
      closeBranchMenu();
    }
  });

  document.body.appendChild(menu);
  // Below the branch name, lined up with its left edge, as tall as the window allows.
  const a = btn.getBoundingClientRect();
  const left = Math.min(Math.max(8, a.left), window.innerWidth - menu.getBoundingClientRect().width - 8);
  const top = a.bottom + 6;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.maxHeight = `${Math.max(160, window.innerHeight - top - 12)}px`;
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('open');
  search.focus();

  const data = await window.git.getBranches(repoPath);
  if (!menu.isConnected || repoPath !== currentRepo) return;
  if (data.error) {
    list.textContent = '';
    list.appendChild(noteEl(data.error));
    return;
  }
  // A detached HEAD is listed as "(HEAD detached at ...)", which is not a branch to switch to.
  const localNames = new Set(data.local.map((b) => b.name));
  const onBranch = data.local.some((b) => b.current && !b.name.startsWith('(')) ? data.current : null;
  const local = data.local.filter((b) => !b.name.startsWith('(')).map((b) => ({
    label: b.name, name: b.name, current: b.current, ref: `refs/heads/${b.name}`, local: true, onBranch,
    hint: `${b.current ? 'The branch you are on' : `Switch to ${b.name}`} (right-click for more)`,
  }));
  const remote = data.remote.map((b) => {
    const label = b.fullName.replace(/^remotes\//, '');
    const hint = localNames.has(b.name) ? `Switch to your local ${b.name}` : `Create the local branch ${b.name} from ${label} and switch to it`;
    return { label, name: b.name, current: false, ref: `refs/${b.fullName}`, local: false, onBranch, hint: `${hint} (right-click for more)` };
  });
  // The tags last: a click goes to the commit of the tag, on no branch.
  const tagList = await window.git.listTags(repoPath);
  if (!menu.isConnected || repoPath !== currentRepo) return;
  const tags = (tagList.tags || []).map((name) => ({
    label: name, name, current: false, ref: `refs/tags/${name}`, local: false, tag: true, onBranch,
    hint: `Go to tag ${name}: its commit, on no branch (right-click for more)`,
  }));
  groups = [['Local', local], ['Remote', remote], ['Tags', tags]];
  render();
}

// A tag from the branch list: its commit, on no branch (detached HEAD), after a confirmation.
async function checkoutTagFromMenu(name) {
  const lines = [`Go to tag ${name}?`, 'You will be on its commit without a branch (detached HEAD): new commits there belong to no branch. To work on it, right-click the tag and create a branch from it.'];
  if (!(await window.git.confirm(lines.join('\n')))) return;
  showLoading();
  const result = await window.git.checkoutTag(currentRepo, name);
  hideLoading();
  if (result.error) toast(result.error, 'error', { title: `Couldn't go to ${name}` });
  else {
    toast(`On tag ${name}, on no branch`, 'success');
    await refresh();
  }
}

// -- Right-click on a branch in the list: its log, merge it into the current branch, delete it, start a branch from it --
function closeBranchActions(refocus = null) {
  const box = $('#branchActions');
  if (!box) return;
  box.remove();
  if (refocus && refocus.isConnected) refocus.focus();
}

// Icons of the action menus (Tabler, 24x24 outline).
const ACTION_ICONS = {
  compare: '<path d="M7 10h14l-4 -4"/><path d="M17 14h-14l4 4"/>',
  edit: '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>',
  undo: '<path d="M9 14l-4 -4l4 -4"/><path d="M5 10h11a4 4 0 1 1 0 8h-1"/>',
  revert: '<path d="M12 8v4l2 2"/><path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"/>',
  tag: '<path d="M6.5 7.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592 -5.592a2.41 2.41 0 0 0 0 -3.408l-7.71 -7.71a2 2 0 0 0 -1.414 -.586h-5.172a3 3 0 0 0 -3 3z"/>',
  copy: '<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z"/><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"/>',
  push: '<path d="M12 4v10"/><path d="M12 4l4 4"/><path d="M12 4l-4 4"/><path d="M4 20h16"/>',
  folder: '<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/>',
  clone: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4v12"/>',
  rename: '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>',
  open: '<path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6"/><path d="M11 13l9 -9"/><path d="M15 4h5v5"/>',
  info: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 9h.01"/><path d="M11 12h1v4h1"/>',
  log: '<path d="M4 16l6 -7l5 5l5 -6"/><path d="M14 14a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M9 9a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M3 16a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M19 8a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>',
  merge: '<path d="M5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M15 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M7 8v8"/><path d="M7 8a4 4 0 0 0 4 4h4"/>',
  create: '<path d="M10 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M15 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M7 8v2a2 2 0 0 0 2 2h6a2 2 0 0 0 2 -2v-2"/><path d="M12 12v4"/>',
  delete: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/>',
  group: '<path d="M12 4l-8 4l8 4l8 -4l-8 -4"/><path d="M4 12l8 4l8 -4"/><path d="M4 16l8 4l8 -4"/>',
  ungroup: '<path d="M12 4l-8 4l8 4l8 -4l-8 -4"/><path d="M4 12l8 4l8 -4"/><path d="M15 18h6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  pull: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4v12"/>',
  scan: '<path d="M11 19h-6a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v2.5"/><path d="M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M20.2 20.2l1.8 1.8"/>',
  fetchAll: '<path d="M19 18a3.5 3.5 0 0 0 0 -7h-1a5 4.5 0 0 0 -11 -2a4.6 4.4 0 0 0 -2.1 8.4"/><path d="M12 13v9"/><path d="M9 19l3 3l3 -3"/>',
  fetch: '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
  stash: '<path d="M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-10"/><path d="M10 12h4"/>',
  check: '<path d="M5 12l5 5l10 -10"/>',
  up: '<path d="M12 5v14"/><path d="M18 11l-6 -6"/><path d="M6 11l6 -6"/>',
  down: '<path d="M12 5v14"/><path d="M18 13l-6 6"/><path d="M6 13l6 6"/>',
};

function openBranchActions(menu, anchor, b, x, y) {
  closeBranchActions();
  const box = document.createElement('div');
  box.id = 'branchActions';
  box.className = 'clip-menu branch-actions-menu';
  box.setAttribute('role', 'menu');
  const head = document.createElement('div');
  head.className = 'branch-actions-title';
  head.textContent = b.label;
  head.title = b.label;
  box.appendChild(head);
  const add = (icon, label, run, cls = '') => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `clip-menu-item ${cls}`.trim();
    item.setAttribute('role', 'menuitem');
    item.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS[icon]}</svg>`;
    item.append(label);
    item.addEventListener('click', run);
    box.appendChild(item);
    return item;
  };
  add('log', 'Show log', () => {
    closeBranchMenu();
    openBranchLog(b.ref, b.label);
  });
  // Only what makes sense for this branch: no merge into itself or without a current branch; only a local branch
  // that is not the current one can be deleted (a branch on origin is left alone).
  if (b.onBranch && !b.current && !b.tag) add('merge', `Merge into ${b.onBranch}`, () => mergeIntoCurrent(b));
  add('create', 'Create branch from this...', () => showCreateFrom(box, b));
  if (b.local) add('rename', 'Rename branch...', () => showRenameForm(box, b));
  if (b.local && !b.current) add('delete', 'Delete branch...', () => deleteBranchFromMenu(b), 'danger');
  if (!b.local && /^refs\/remotes\/origin\/./.test(b.ref)) add('delete', 'Delete on origin...', () => deleteRemoteFromMenu(b), 'danger');

  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const items = [...box.querySelectorAll('button.clip-menu-item')];
    const i = items.indexOf(document.activeElement);
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length && !e.target.matches('input')) {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeBranchActions(anchor);
    }
  });
  // A press anywhere else in the branch list closes this menu (the list stays open).
  menu.addEventListener('mousedown', (e) => {
    if (!box.contains(e.target)) closeBranchActions();
  }, { once: true });
  menu.appendChild(box);
  const m = box.getBoundingClientRect();
  box.style.left = `${Math.round(Math.min(x, window.innerWidth - m.width - 8))}px`;
  box.style.top = `${Math.round(Math.min(y, window.innerHeight - m.height - 8))}px`;
  box.querySelector('button').focus();
}

async function mergeIntoCurrent(b) {
  const current = b.onBranch;
  closeBranchMenu();
  if (!(await window.git.confirm(`Merge ${b.label} into ${current}?\nIts commits that ${current} does not have are added to ${current}.`))) return;
  showLoading();
  const result = await window.git.mergeBranch(currentRepo, b.ref);
  hideLoading();
  if (result.error) toast(result.error, 'error', result.conflict ? {} : { title: `Couldn't merge ${b.label}` });
  else toast(result.upToDate ? `${current} already has everything from ${b.label}` : `Merged ${b.label} into ${current}`, 'success');
  await refresh();
}

async function deleteBranchFromMenu(b) {
  closeBranchMenu();
  const only = await window.git.branchOnlyCommits(currentRepo, b.name);
  if (only.error) {
    toast(only.error, 'error', { title: `Couldn't delete ${b.name}` });
    return;
  }
  const lines = [`Delete branch "${b.name}"?`];
  if (only.count > 0) lines.push(`It has ${plural(only.count, 'commit')} that no other branch has; they will be lost.`);
  if (!(await window.git.confirm(lines.join('\n')))) return;
  showLoading();
  const result = await window.git.deleteBranch(currentRepo, b.name);
  hideLoading();
  if (result.error) toast(result.error, 'error', { title: `Couldn't delete ${b.name}` });
  else toast(`Deleted ${b.name}`, 'success');
  await refresh();
}

// A name field in place of the menu items (create, rename): the error shows under it, Enter submits.
function showMenuForm(box, { title, value = '', placeholder = '', aria, extra = null, button, submit }) {
  box.querySelectorAll('.clip-menu-item').forEach((el) => el.remove());
  const form = document.createElement('div');
  form.className = 'branch-create-form';
  const label = document.createElement('div');
  label.className = 'branch-create-label';
  label.textContent = title;
  const input = document.createElement('input');
  input.className = 'input branch-create-input';
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.setAttribute('aria-label', aria);
  const error = document.createElement('div');
  error.className = 'branch-create-error hidden';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'btn btn-sm btn-primary';
  ok.textContent = button;
  const fail = (text) => {
    error.textContent = text;
    error.classList.remove('hidden');
    input.focus();
  };
  const run = () => submit(input.value.trim(), fail);
  ok.addEventListener('click', run);
  input.addEventListener('input', () => error.classList.add('hidden'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  });
  form.append(label, input, ...(extra ? [extra(input)] : []), error, ok);
  box.appendChild(form);
  // keep the menu inside the window now that it is taller
  const r = box.getBoundingClientRect();
  if (r.bottom > window.innerHeight - 8) box.style.top = `${Math.max(8, Math.round(window.innerHeight - r.height - 8))}px`;
  if (r.right > window.innerWidth - 8) box.style.left = `${Math.max(8, Math.round(window.innerWidth - r.width - 8))}px`;
  input.focus();
  input.select();
}

// The kinds of branch a new name starts with: a click on one fills in "<kind>/" and the ticket prefix.
const BRANCH_PREFIXES = ['fix', 'feature'];

function branchPrefixChips(input) {
  const chips = document.createElement('div');
  chips.className = 'branch-create-chips';
  for (const prefix of BRANCH_PREFIXES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-chip';
    chip.textContent = prefix;
    chip.addEventListener('click', () => {
      input.value = `${prefix}/${ticketPrefix}`;
      input.focus();
    });
    chips.appendChild(chip);
  }
  return chips;
}

// The new branch's name is typed in the menu itself, with the fix / feature chips.
function showCreateFrom(box, b) {
  showMenuForm(box, {
    title: `New branch from ${b.label}`,
    placeholder: `feature/${ticketPrefix || 'ABC-'}123`,
    aria: 'New branch name',
    extra: branchPrefixChips,
    button: 'Create and switch',
    submit: async (name, fail) => {
      if (!name) return fail('Type a name for the new branch.');
      if (ticketPrefix && name.endsWith(ticketPrefix)) return fail('Complete the name after the ticket prefix.');
      showLoading();
      const result = await window.git.createBranchAt(currentRepo, name, b.ref);
      hideLoading();
      if (result.error) return fail(describeMessage(result.error).text || describeMessage(result.error).title);
      closeBranchMenu();
      toast(`Created ${name} from ${b.label}`, 'success');
      await refresh();
    },
  });
}

// "New branch..." at the foot of the branch list: a name and the branch on origin it copies (origin/main unless
// another is picked), fetched first so the copy is up to date; then you are on the new branch.
function openNewBranchForm(menu, anchor, name) {
  closeBranchActions();
  const box = document.createElement('div');
  box.id = 'branchActions';
  box.className = 'clip-menu branch-actions-menu';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'New branch');
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closeBranchActions(anchor);
    }
  });
  menu.addEventListener('mousedown', (e) => {
    if (!box.contains(e.target)) closeBranchActions();
  }, { once: true });
  menu.appendChild(box);
  const m = menu.getBoundingClientRect();
  box.style.left = `${Math.round(m.right + 6)}px`;
  box.style.top = `${Math.round(anchor.getBoundingClientRect().top)}px`;
  let base = null;
  showMenuForm(box, {
    title: 'New branch',
    value: name,
    placeholder: `feature/${ticketPrefix || 'ABC-'}123`,
    aria: 'New branch name',
    extra: (input) => {
      const wrap = document.createElement('div');
      wrap.className = 'branch-create-extra';
      const from = document.createElement('label');
      from.className = 'branch-create-base';
      from.append('from origin/');
      base = document.createElement('select');
      base.className = 'input branch-base-select';
      base.title = 'The branch on origin the new branch copies. It is fetched first, so the copy is up to date.';
      const names = remoteBranchNames.length > 0 ? remoteBranchNames : ['main'];
      for (const n of names) base.appendChild(new Option(n, n));
      base.value = ['main', 'master'].find((n) => names.includes(n)) || names[0];
      from.appendChild(base);
      wrap.append(branchPrefixChips(input), from);
      return wrap;
    },
    button: 'Create and switch',
    submit: async (branch, fail) => {
      if (!branch) return fail('Type a name for the new branch.');
      if (ticketPrefix && branch.endsWith(ticketPrefix)) return fail('Complete the name after the ticket prefix.');
      const from = base.value || 'main';
      showLoading();
      const result = await window.git.createBranch(currentRepo, branch, from);
      hideLoading();
      if (result.error) return fail(describeMessage(result.error).text || describeMessage(result.error).title);
      closeBranchMenu();
      toast(`Created ${branch} from origin/${result.base || from} and switched to it`, 'success');
      await refresh();
    },
  });
}

// Renaming drops the link to origin/<old name>: the next push creates origin/<new name>, the old one stays there.
function showRenameForm(box, b) {
  showMenuForm(box, {
    title: `New name for ${b.name}`,
    value: b.name,
    aria: 'New branch name',
    button: 'Rename',
    submit: async (name, fail) => {
      if (!name) return fail('Type the new name.');
      if (name === b.name) return fail('That is already its name.');
      showLoading();
      const result = await window.git.renameBranch(currentRepo, b.name, name);
      hideLoading();
      if (result.error) return fail(describeMessage(result.error).text || describeMessage(result.error).title);
      closeBranchMenu();
      toast(result.oldUpstream
        ? `Renamed ${b.name} to ${result.name}. ${result.oldUpstream} keeps the old name on origin; the next push creates origin/${result.name}.`
        : `Renamed ${b.name} to ${result.name}`, 'success');
      await refresh();
    },
  });
}

async function deleteRemoteFromMenu(b) {
  closeBranchMenu();
  const only = await window.git.remoteOnlyCommits(currentRepo, b.ref);
  if (only.error) {
    toast(only.error, 'error', { title: `Couldn't delete ${b.label}` });
    return;
  }
  const lines = [`Delete ${b.label} on origin (GitHub)?`, 'It is gone for everyone; a branch on your PC with the same name stays.'];
  if (only.count > 0) lines.push(`It has ${plural(only.count, 'commit')} that no other branch or tag has; they will be lost.`);
  if (!(await window.git.confirm(lines.join('\n')))) return;
  showLoading();
  const result = await window.git.deleteRemoteBranch(currentRepo, b.ref);
  hideLoading();
  if (result.error) toast(result.error, 'error', { title: `Couldn't delete ${b.label}` });
  else toast(`Deleted ${b.label} on origin`, 'success');
  await refresh();
}

// -- A menu of actions under a button or at the mouse (Add, the commit menu, a commit in the Log) --
// Items: { icon, label, run, danger, disabled, hint } or { note } for a line of text.
function closeActionMenu() {
  const box = $('#actionMenu');
  if (!box) return;
  document.removeEventListener('mousedown', box.onOutside, true);
  box.remove();
}

function openActionMenu({ anchor = null, x = 0, y = 0, title = '', items }) {
  closeActionMenu();
  const box = document.createElement('div');
  box.id = 'actionMenu';
  box.className = 'clip-menu branch-actions-menu';
  box.setAttribute('role', 'menu');
  if (title) {
    const head = document.createElement('div');
    head.className = 'branch-actions-title';
    head.textContent = title;
    head.title = title;
    box.appendChild(head);
  }
  for (const it of items) {
    if (it.note) {
      const note = document.createElement('div');
      note.className = 'action-menu-note';
      note.textContent = it.note;
      box.appendChild(note);
      continue;
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `clip-menu-item${it.danger ? ' danger' : ''}`;
    item.setAttribute('role', 'menuitem');
    item.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS[it.icon] || ''}</svg>`;
    item.append(it.label);
    item.disabled = Boolean(it.disabled);
    if (it.hint) item.title = it.hint;
    item.addEventListener('click', () => {
      closeActionMenu();
      it.run();
    });
    box.appendChild(item);
  }
  box.addEventListener('keydown', (e) => {
    const list = [...box.querySelectorAll('button.clip-menu-item:not(:disabled)')];
    const i = list.indexOf(document.activeElement);
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && list.length) {
      e.preventDefault();
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeActionMenu();
      if (anchor) anchor.focus();
    }
  });
  if (anchor && anchor.id) box.dataset.anchor = anchor.id;
  box.onOutside = (e) => {
    if (!box.contains(e.target) && e.target !== anchor && !(anchor && anchor.contains(e.target))) closeActionMenu();
  };
  document.addEventListener('mousedown', box.onOutside, true);
  document.body.appendChild(box);
  const m = box.getBoundingClientRect();
  if (anchor) {
    // under the button, its right edges lined up; above it when there is no room below
    const a = anchor.getBoundingClientRect();
    x = a.right - m.width;
    y = a.bottom + 4 + m.height > window.innerHeight - 8 ? a.top - 4 - m.height : a.bottom + 4;
  }
  box.style.left = `${Math.round(Math.max(8, Math.min(x, window.innerWidth - m.width - 8)))}px`;
  box.style.top = `${Math.round(Math.max(8, Math.min(y, window.innerHeight - m.height - 8)))}px`;
  const first = box.querySelector('button.clip-menu-item:not(:disabled)');
  if (first) first.focus();
}

// -- Log of a branch: Git's graph, message, author and date, in a popup --
const GRAPH_CHAR = 7; // px per character of Git's graph; lanes are two characters apart
const GRAPH_ROW = 30; // a commit: its message
const GRAPH_ROW_LABELS = 52; // a commit with names on it: the message, then the names below it
const GRAPH_DOT_Y = 15; // the dot sits on the message line
const GRAPH_LINK_ROW = 12;

// One line of `git log --graph` drawn as lines and a dot, so the lanes join from row to row.
function graphSvg(graph, height, { first = false, last = false, dotY = height / 2 } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const width = Math.max(1, graph.length) * GRAPH_CHAR + GRAPH_CHAR;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('aria-hidden', 'true');
  const x = (i) => i * GRAPH_CHAR + GRAPH_CHAR / 2;
  const lane = (i) => `lane-${Math.round(i / 2) % 6}`;
  const line = (x1, y1, x2, y2, cls) => {
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', x1);
    l.setAttribute('y1', y1);
    l.setAttribute('x2', x2);
    l.setAttribute('y2', y2);
    l.setAttribute('class', cls);
    svg.appendChild(l);
  };
  [...graph].forEach((ch, i) => {
    if (ch === '|') line(x(i), 0, x(i), height, lane(i));
    else if (ch === '/') line(x(i + 1), 0, x(i - 1), height, lane(i + 1));
    else if (ch === '\\') line(x(i - 1), 0, x(i + 1), height, lane(i + 1));
    else if (ch === '_') line(x(i - 1), height, x(i + 1), height, lane(i));
    else if (ch === '-') line(x(i - 1), dotY, x(i + 1), dotY, lane(i));
    else if (ch === '*') {
      line(x(i), first ? dotY : 0, x(i), last ? dotY : height, lane(i));
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', x(i));
      dot.setAttribute('cy', dotY);
      dot.setAttribute('r', 4);
      dot.setAttribute('class', `dot ${lane(i)}`);
      svg.appendChild(dot);
    }
  });
  return svg;
}

// The names on a commit, as its second line shows them: the tags (versions), then each local branch followed by
// "> origin/<name>" when the same branch on GitHub is on this commit too, then the branches only GitHub has here.
function commitLabels(refs) {
  const tags = [];
  const locals = [];
  const remotes = [];
  let current = null;
  for (const raw of refs) {
    let ref = raw;
    if (ref.startsWith('HEAD -> ')) {
      ref = ref.slice(8);
      current = ref.replace(/^refs\/heads\//, '');
    }
    if (ref.startsWith('tag: ')) tags.push(ref.slice(5).replace(/^refs\/tags\//, ''));
    else if (ref.startsWith('refs/heads/')) locals.push(ref.slice(11));
    else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) remotes.push(ref.slice(13));
  }
  const labels = tags.map((name) => ({ kind: 'tag', name }));
  const paired = new Set();
  locals.sort((a, b) => Number(b === current) - Number(a === current)); // the branch you are on first
  for (const name of locals) {
    const remote = remotes.find((r) => r.slice(r.indexOf('/') + 1) === name && !paired.has(r));
    if (remote) paired.add(remote);
    labels.push({ kind: 'branch', name, remote, current: name === current });
  }
  for (const name of remotes) if (!paired.has(name)) labels.push({ kind: 'remote', name });
  return labels;
}

function commitLabelsLine(refs) {
  const line = document.createElement('span');
  line.className = 'branch-log-refs';
  for (const l of commitLabels(refs)) {
    if (l.kind === 'tag') {
      const tag = diffSpan('branch-log-ref tag', l.name);
      tag.title = `Tag ${l.name}: a fixed name for this commit, usually a version`;
      line.appendChild(tag);
    } else if (l.kind === 'remote') {
      const remote = diffSpan('branch-log-ref remote', l.name);
      remote.title = `${l.name}: this branch on GitHub is at this commit; your copy of it is somewhere else, or you have none`;
      line.appendChild(remote);
    } else {
      const pair = diffSpan('branch-log-pair', '');
      pair.appendChild(diffSpan(`branch-log-ref${l.current ? ' head' : ''}`, l.name));
      if (l.remote) pair.append(diffSpan('branch-log-sep', '>'), diffSpan('branch-log-ref remote', l.remote));
      pair.title = [
        l.current ? `You are on ${l.name}.` : '',
        l.remote ? `${l.name} on your PC and ${l.remote} on GitHub are both at this commit.` : `${l.name} is a branch on your PC; GitHub's copy of it is not at this commit.`,
      ].filter(Boolean).join(' ');
      line.appendChild(pair);
    }
  }
  return line;
}

function closeBranchLog() {
  const modal = $('#branchLogModal');
  if (!modal) return;
  document.removeEventListener('keydown', modal.onEscape, true);
  modal.remove();
}

async function openBranchLog(ref, label) {
  closeBranchLog();
  const repoPath = currentRepo;
  const modal = document.createElement('div');
  modal.id = 'branchLogModal';
  modal.className = 'settings-overlay';
  const card = document.createElement('section');
  card.className = 'settings-card branch-log-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', `Log of ${label}`);
  const head = document.createElement('div');
  head.className = 'branch-log-head';
  const title = document.createElement('span');
  title.className = 'branch-log-title';
  title.textContent = `Log of ${label}`;
  const count = document.createElement('span');
  count.className = 'branch-log-count';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn-plain branch-log-close';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '\u2715';
  close.addEventListener('click', closeBranchLog);
  head.append(title, count, close);
  const body = document.createElement('div');
  body.className = 'branch-log-body';
  body.appendChild(noteEl('Loading...'));
  card.append(head, body);
  modal.appendChild(card);
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) closeBranchLog();
  });
  // Esc closes it wherever the focus is (a click on a row leaves the focus on the page, not in the popup)
  modal.onEscape = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    closeBranchLog();
  };
  document.addEventListener('keydown', modal.onEscape, true);
  document.body.appendChild(modal);
  close.focus();

  const data = await window.git.branchGraph(repoPath, ref);
  if (!modal.isConnected) return;
  body.textContent = '';
  if (data.error) {
    body.appendChild(noteEl(describeMessage(data.error).title));
    return;
  }
  count.textContent = data.total > data.shown ? `latest ${data.shown} of ${data.total} commits` : plural(data.total, 'commit');
  const width = Math.max(...data.rows.map((r) => r.graph.length), 1) * GRAPH_CHAR + GRAPH_CHAR;
  const firstCommit = data.rows.findIndex((r) => r.hash);
  let lastCommit = -1;
  data.rows.forEach((r, i) => { if (r.hash) lastCommit = i; });
  const table = document.createElement('div');
  table.className = 'branch-log-table';
  table.style.setProperty('--graph-width', `${width}px`);
  const th = document.createElement('div');
  th.className = 'branch-log-row branch-log-th';
  for (const text of ['', 'Message', 'Author', 'Date', 'Commit']) th.appendChild(diffSpan('', text));
  table.appendChild(th);
  data.rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = `branch-log-row${r.hash ? '' : ' link'}`;
    // first line the message; the names on the commit, if any, on a second line
    const labels = r.hash ? commitLabelsLine(r.refs) : null;
    const height = !r.hash ? GRAPH_LINK_ROW : labels.childElementCount ? GRAPH_ROW_LABELS : GRAPH_ROW;
    row.style.height = `${height}px`;
    const graph = document.createElement('span');
    graph.className = 'branch-log-graph';
    graph.appendChild(graphSvg(r.graph, height, { first: i === firstCommit, last: i === lastCommit, dotY: GRAPH_DOT_Y }));
    row.appendChild(graph);
    if (r.hash) {
      const msg = document.createElement('span');
      msg.className = 'branch-log-msg';
      const subject = diffSpan('branch-log-subject', r.message);
      subject.title = r.message;
      msg.appendChild(subject);
      if (labels.childElementCount) msg.appendChild(labels);
      const author = diffSpan('branch-log-author', r.author);
      author.title = r.author;
      const date = diffSpan('branch-log-date', formatDate(r.date));
      date.title = new Date(r.date).toLocaleString();
      const hash = diffSpan('branch-log-hash copyable', r.short);
      hash.title = `Click to copy ${r.hash}`;
      hash.addEventListener('click', () => copyText(r.hash, 'Commit hash'));
      row.append(msg, author, date, hash);
    }
    table.appendChild(row);
  });
  body.appendChild(table);
}

// The author and date of a commit (and "Not pushed" in the Log) as small tags, each with an icon (Tabler, 24x24 outline).
const META_ICONS = {
  push: '<path d="M12 4v10"/><path d="M12 4l4 4"/><path d="M12 4l-4 4"/><path d="M4 20h16"/>',
  author: '<path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"/><path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/>',
  date: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 7v5l3 3"/>',
};

function metaTag(icon, text, title) {
  const t = document.createElement('span');
  t.className = 'meta-tag';
  t.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${META_ICONS[icon]}</svg>`;
  t.append(text);
  t.title = title;
  return t;
}

// The first line of a commit: its message, and its author and date on the right.
function commitTitleRow({ message, author, date }) {
  const row = document.createElement('div');
  row.className = 'log-title-row';
  const text = document.createElement('div');
  text.className = 'log-message';
  text.textContent = message;
  text.title = message;
  const who = document.createElement('div');
  who.className = 'log-who';
  who.append(metaTag('author', author, `Author: ${author}`), metaTag('date', formatDate(date), new Date(date).toLocaleString()));
  row.append(text, who);
  return row;
}

// Below it, in the Log: a commit origin does not have yet. Null when there is nothing to say.
function commitMeta({ pushed }) {
  const meta = document.createElement('div');
  meta.className = 'log-meta';
  if (pushed === false) {
    const local = metaTag('push', 'Not pushed', 'No branch on origin has this commit yet');
    local.classList.add('local');
    meta.appendChild(local);
  }
  return meta.children.length ? meta : null;
}

// -- Log: a history, 100 commits at a time and searchable: your branch's, or Base's (another branch, a tag or a
// commit). With Compare too, as on GitHub, the commits Compare has that Base has not, and in Files what they changed
// together (from where the two split). A click on a commit shows its files, a click on a file what the commit changed
// in it; the ⋯ button (or a right-click) has what can be done to it. --
const LOG_PAGE = 100;
let logState = { repo: null, key: '', query: '', commits: [], total: 0, more: false, head: '', branch: '', open: new Set(), files: null, error: '', graph: null };
let logSearchTimer = null;
const logSides = new Map(); // repository -> { base, compare }, sides as Compare makes them; no base is your branch
let logView = 'commits'; // while comparing: 'commits' or 'files'
let logSearchOf = 'commits'; // the one whose search the box has
const logQuery = { commits: '', files: '' }; // the search of each, kept while the other is shown

// Your branch as a side (HEAD when on no branch): as the last log said, or the list of repositories before it.
function logOwnSide() {
  let ref = logState.repo === currentRepo ? logState.branch : '';
  if (logState.repo !== currentRepo) {
    const entry = repos.find((r) => r.path === currentRepo);
    if (entry && entry.branch && entry.branch !== 'HEAD') ref = `refs/heads/${entry.branch}`;
  }
  return ref ? cmpSideFor(ref) : { value: 'HEAD', kind: 'commit', label: 'HEAD' };
}

const logViewNow = () => ((logSides.get(currentRepo) || {}).compare ? logView : 'commits');

// What the Log asks for: the history of ref, or with base the commits ref has that base has not.
function logSpec(repoPath) {
  const { base, compare } = logSides.get(repoPath) || {};
  if (!compare) return { ref: base ? base.value : undefined, key: base ? base.value : 'HEAD' };
  const from = base ? base.value : 'HEAD';
  return { ref: compare.value, base: from, key: `${from}..${compare.value}` };
}

function renderLogBar() {
  const { base, compare } = (currentRepo && logSides.get(currentRepo)) || {};
  const show = (btn, side, empty) => {
    btn.classList.toggle('empty', !side);
    btn.querySelector('.cmp-pick-icon').innerHTML = side ? cmpIcon(side.kind) : '';
    btn.querySelector('.cmp-pick-text').textContent = !side ? empty : side.kind === 'commit' && side.message ? `${side.label}  ${side.message}` : side.label;
  };
  show($('#logBaseBtn'), base || logOwnSide(), '');
  show($('#logCompareBtn'), compare, 'Compare with...');
  $('#logClearBtn').classList.toggle('hidden', !compare);
  $('#logSwapBtn').classList.toggle('hidden', !compare);
  $('#logViewSeg').classList.toggle('hidden', !compare);
  const view = logViewNow();
  $$('#logViewSeg .seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  const search = $('#logSearch');
  if (logSearchOf !== view) {
    logSearchOf = view;
    search.value = logQuery[view];
  }
  search.placeholder = view === 'files' ? 'Search files: path or name' : 'Search commits: message, author or hash';
  search.setAttribute('aria-label', view === 'files' ? 'Search files' : 'Search commits');
}

function setLogSide(key, side) {
  const sides = logSides.get(currentRepo) || { base: null, compare: null };
  // your branch as Base is no choice: it follows the branch you switch to
  sides[key] = key === 'base' && side && side.value === logOwnSide().value ? null : side;
  logSides.set(currentRepo, sides);
  renderLogBar();
  refreshLog();
}

function swapLogSides() {
  const sides = logSides.get(currentRepo);
  if (!sides || !sides.compare) return;
  const base = sides.base || logOwnSide();
  sides.base = sides.compare.value === logOwnSide().value ? null : sides.compare;
  sides.compare = base;
  renderLogBar();
  refreshLog();
}

// From a commit's ⋯: it as Base, and what the Log shows as Compare (what came after it).
function logCompareFrom(c) {
  const sides = logSides.get(currentRepo) || { base: null, compare: null };
  sides.compare = sides.compare || sides.base || logOwnSide();
  // its picker lists the commits of the branch it came from
  const branch = ['local', 'remote'].includes(sides.compare.kind) ? sides.compare.value : '';
  sides.base = cmpSideFor(c.fullHash, { message: c.message, label: c.hash, branch });
  logSides.set(currentRepo, sides);
  logView = 'commits';
  renderLogBar();
  refreshLog();
}

function setLogView(view) {
  if (view === logView) return;
  logView = view;
  renderLogBar();
  renderLog();
}

async function refreshLog({ more = false } = {}) {
  if (!currentRepo) return;
  const repoPath = currentRepo;
  // a branch or tag deleted since: back to your branch, or to no Compare
  const sides = logSides.get(repoPath);
  if (sides && cmpRefs && cmpRefs.repo === repoPath) {
    const known = new Set([...cmpRefs.local, ...cmpRefs.remote, ...cmpRefs.tags].map((r) => r.ref));
    for (const k of ['base', 'compare']) if (sides[k] && sides[k].kind !== 'commit' && !known.has(sides[k].value)) sides[k] = null;
  }
  renderLogBar();
  const spec = logSpec(repoPath);
  const query = logQuery.commits;
  const same = logState.repo === repoPath && logState.key === spec.key && logState.query === query;
  // a refresh reloads as many commits as were shown, so the list does not shrink under you
  const skip = more ? logState.commits.length : 0;
  const count = more ? LOG_PAGE : Math.max(LOG_PAGE, same ? logState.commits.length : 0);
  const [page, files] = await Promise.all([
    // with no search, the commits come with Git's graph (always from the first one)
    window.git.logPage(repoPath, { skip, count, query, ref: spec.ref, base: spec.base, graph: true }),
    spec.base && !more ? window.git.compare(repoPath, spec.base, spec.ref, { mergeBase: true }) : null,
  ]);
  if (repoPath !== currentRepo || query !== logQuery.commits || spec.key !== logSpec(repoPath).key) return;
  logState = {
    repo: repoPath,
    key: spec.key,
    query,
    commits: page.error ? [] : more && !page.graph ? [...logState.commits, ...page.commits] : page.commits,
    total: page.total || 0,
    more: Boolean(page.more),
    head: page.head || '',
    branch: page.error && logState.repo === repoPath ? logState.branch : page.branch || '',
    open: same ? logState.open : new Set(),
    files: more ? logState.files : files,
    error: page.error || '',
    graph: page.graph || null,
  };
  renderLog();
}

function renderLog() {
  renderLogBar();
  const list = $('#logList');
  const top = list.scrollTop;
  list.textContent = '';
  const { commits, total, query, files } = logState;
  const sides = logSides.get(currentRepo) || {};
  const comparing = Boolean(sides.compare) && logState.repo === currentRepo && logState.key === logSpec(currentRepo).key;
  $('#logCommitsCount').textContent = files && !files.error ? String(files.ahead) : '';
  $('#logFilesCount').textContent = files && !files.error ? String(files.files.length) : '';
  if (logState.error) {
    list.appendChild(noteEl(logState.error));
    $('#logCount').textContent = '';
    return;
  }
  if (comparing && files && !files.error && !files.ahead) {
    // Base already has everything Compare has: a line that says so, with Swap, and the commits the other way, muted
    $('#logCount').textContent = '';
    if (files.from === files.to) {
      list.appendChild(noteEl('Base and Compare are the same commit: pick another one on one side.'));
      return;
    }
    const baseLabel = (sides.base || logOwnSide()).label;
    const line = document.createElement('div');
    line.className = 'log-nothing';
    line.append(diffSpan('log-nothing-text', `${sides.compare.label} has no commits that ${baseLabel} doesn't have.`));
    const swap = document.createElement('button');
    swap.type = 'button';
    swap.className = 'btn btn-sm log-nothing-swap';
    swap.title = `Base: ${sides.compare.label}, Compare: ${baseLabel}`;
    swap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS.compare}</svg>`;
    swap.append('Swap');
    swap.addEventListener('click', swapLogSides);
    line.appendChild(swap);
    list.appendChild(line);
    for (const c of files.back || []) list.appendChild(logBackRow(c));
    if (files.behind > (files.back || []).length) list.appendChild(noteEl(`and ${plural(files.behind - files.back.length, 'more commit')}`));
    return;
  }
  if (comparing && logView === 'files') {
    renderLogFiles(list, sides);
    list.scrollTop = top;
    markSelectedFile();
    return;
  }
  $('#logCount').textContent = !total ? '' : query ? `${plural(total, 'commit')} found` : `${commits.length} of ${plural(total, 'commit')}`;
  if (commits.length === 0) {
    list.appendChild(noteEl(query ? `No commit has "${query}" in its message, author or hash` : 'No commits yet'));
    return;
  }
  const { graph } = logState;
  list.classList.toggle('graph', Boolean(graph));
  if (graph) {
    // Git's graph: a commit's row on each commit, the lines between them on rows of their own
    const byHash = new Map(commits.map((c) => [c.fullHash, c]));
    const width = Math.max(...graph.map((r) => r.graph.length), 1) * GRAPH_CHAR + GRAPH_CHAR;
    list.style.setProperty('--log-graph-width', `${width}px`);
    const rows = graph.filter((r) => !r.hash || byHash.has(r.hash));
    const firstCommit = rows.findIndex((r) => r.hash);
    let lastCommit = -1;
    rows.forEach((r, i) => { if (r.hash) lastCommit = i; });
    rows.forEach((r, i) => {
      if (!r.hash) {
        const link = document.createElement('div');
        link.className = 'log-graph-link branch-log-graph';
        link.appendChild(graphSvg(r.graph, GRAPH_LINK_ROW));
        list.appendChild(link);
        return;
      }
      const item = logItem(byHash.get(r.hash));
      item.graphRow = { graph: r.graph, first: i === firstCommit, last: i === lastCommit && !logState.more };
      list.appendChild(item);
    });
  } else for (const c of commits) list.appendChild(logItem(c));
  if (logState.more) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn btn-sm log-more';
    more.textContent = `Show ${Math.min(LOG_PAGE, total - commits.length)} more`;
    more.addEventListener('click', () => refreshLog({ more: true }));
    list.appendChild(more);
  }
  drawLogGraphs();
  list.scrollTop = top;
  markSelectedFile();
}

// A commit of the other way round, muted under "has no commits": a click swaps, to see it for real.
function logBackRow(c) {
  const row = document.createElement('div');
  row.className = 'log-back-row';
  row.title = 'Swap Base and Compare to see these commits';
  const body = document.createElement('div');
  body.className = 'log-body';
  body.appendChild(commitTitleRow(c));
  if (commitLabels(c.refs).length) body.appendChild(commitLabelsLine(c.refs));
  row.append(diffSpan('log-hash', c.hash), body);
  row.addEventListener('click', swapLogSides);
  return row;
}

// The graph of each commit, as tall as the commit is now (its files open or not), the dot on its message line.
function drawLogGraph(item) {
  const row = item.graphRow;
  if (!row) return;
  let cell = item.querySelector(':scope > .log-graph');
  if (!cell) {
    cell = document.createElement('div');
    cell.className = 'log-graph branch-log-graph';
    item.prepend(cell);
  }
  const height = item.offsetHeight;
  if (!height) return; // not on screen: drawn when the list shows
  if (cell.dataset.height === String(height)) return;
  cell.dataset.height = String(height);
  const hash = item.querySelector('.log-item-head .log-hash');
  const dotY = hash ? Math.round(hash.offsetTop + hash.offsetHeight / 2) : GRAPH_DOT_Y;
  cell.textContent = '';
  cell.appendChild(graphSvg(row.graph, height, { first: row.first, last: row.last, dotY }));
}

function drawLogGraphs() {
  $$('#logList > .log-item').forEach(drawLogGraph);
}

// Files: what the commits of Compare changed together, from where it split from Base; a file opens its diff.
function renderLogFiles(list, sides) {
  const data = logState.files;
  if (!data || data.error) {
    list.appendChild(noteEl(data ? data.error : 'Loading...'));
    $('#logCount').textContent = '';
    return;
  }
  const baseLabel = (sides.base || logOwnSide()).label;
  const q = logQuery.files.toLowerCase();
  const shown = q ? data.files.filter((f) => `${f.from || ''} ${f.file}`.toLowerCase().includes(q)) : data.files;
  $('#logCount').textContent = q ? `${shown.length} of ${plural(data.files.length, 'file')}` : `${plural(data.files.length, 'file')} changed`;
  const added = data.files.reduce((n, f) => n + (f.added || 0), 0);
  const removed = data.files.reduce((n, f) => n + (f.removed || 0), 0);
  const head = document.createElement('div');
  head.className = 'cmp-head';
  head.append(`${plural(data.files.length, 'file')} changed in ${plural(data.ahead, 'commit')}`);
  const lines = document.createElement('span');
  lines.className = 'cmp-lines';
  lines.append(diffSpan('add', `+${added}`), diffSpan('del', `−${removed}`));
  head.appendChild(lines);
  list.appendChild(head);
  // Base moved on after Compare split from it: the files start from there, so its later changes are left out
  const split = data.base !== data.from;
  if (split) list.appendChild(noteEl(`From ${data.base.slice(0, 7)}, where ${sides.compare.label} split from ${baseLabel}: what ${baseLabel} got after that (${plural(data.behind, 'commit')}) is left out.`));
  const ctx = { from: data.base, to: data.to, files: data.files, fromLabel: split ? `${data.base.slice(0, 7)} (where they split)` : baseLabel, toLabel: sides.compare.label };
  if (!data.files.length) list.appendChild(noteEl('No differences in the files.'));
  else if (!shown.length) list.appendChild(noteEl(`No file has "${logQuery.files}" in its path`));
  for (const f of shown) list.appendChild(cmpFileRow(f, ctx));
}

function logItem(c) {
  const item = document.createElement('div');
  item.className = `log-item${logState.open.has(c.fullHash) ? ' open' : ''}`;
  item.dataset.hash = c.fullHash;
  const head = document.createElement('div');
  head.className = 'log-item-head';
  head.tabIndex = 0;
  head.title = 'Click to show the files of this commit';
  const hash = diffSpan('log-hash', c.hash);
  const body = document.createElement('div');
  body.className = 'log-body';
  body.appendChild(commitTitleRow(c));
  if (commitLabels(c.refs).length) body.appendChild(commitLabelsLine(c.refs));
  const meta = commitMeta(c);
  if (meta) body.appendChild(meta);
  const actions = document.createElement('button');
  actions.type = 'button';
  actions.className = 'icon-action log-actions-btn';
  actions.title = 'What you can do with this commit';
  actions.setAttribute('aria-label', 'Actions for this commit');
  actions.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12.5" cy="8" r="1" fill="currentColor"/></svg>';
  actions.addEventListener('click', (e) => {
    e.stopPropagation();
    openLogActions(c, actions);
  });
  head.append(hash, body, actions);
  const files = document.createElement('div');
  files.className = `log-files${logState.open.has(c.fullHash) ? '' : ' hidden'}`;
  if (c.files.length === 0) files.appendChild(noteEl(c.parents.length > 1 ? 'A merge commit: it changed no files of its own' : 'No file changes'));
  for (const f of c.files) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'log-file';
    row.dataset.hash = c.fullHash;
    row.dataset.file = f.file;
    row.title = 'Click to see what this commit changed in the file';
    const letter = diffSpan(`file-status ${f.letter}`, f.letter);
    letter.title = LETTER_TITLES[f.letter] || f.letter;
    const where = document.createElement('span');
    where.className = 'file-path';
    const slash = f.file.lastIndexOf('/');
    const dir = `${f.from ? `${f.from} → ` : ''}${f.file.slice(0, slash + 1)}`;
    if (dir) where.append(diffSpan('fp-dir', dir));
    where.append(diffSpan('fp-base', f.file.slice(slash + 1)));
    row.append(letter, where);
    row.addEventListener('click', () => openCommitDiff(c, f));
    files.appendChild(row);
  }
  const toggle = () => {
    const open = files.classList.toggle('hidden') === false;
    item.classList.toggle('open', open);
    if (open) logState.open.add(c.fullHash);
    else logState.open.delete(c.fullHash);
    drawLogGraph(item);
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.target !== head) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openLogActions(c, null, e.clientX, e.clientY);
  });
  item.append(head, files);
  return item;
}

// What can be done with a commit of the Log. The last one, while origin does not have it, can be amended or undone;
// any one can be reverted (a new commit that undoes it) or get a tag.
function openLogActions(c, anchor, x, y) {
  if (anchor && $('#actionMenu') && $('#actionMenu').dataset.anchor === anchor.id && anchor.id) {
    closeActionMenu();
    return;
  }
  const isHead = c.fullHash === logState.head;
  const tags = commitLabels(c.refs).filter((l) => l.kind === 'tag').map((l) => l.name);
  const items = [{ icon: 'copy', label: 'Copy hash', run: () => copyText(c.fullHash, 'Commit hash') }];
  if (isHead && !c.pushed) {
    items.push(
      { icon: 'edit', label: 'Amend this commit...', hint: 'Change its message, or add the ticked files to it', run: () => withLastCommit(openAmend) },
      {
        icon: 'undo', label: 'Undo this commit...', disabled: c.parents.length > 1,
        hint: c.parents.length > 1 ? 'A merge commit: use Revert instead' : 'Its changes go back to Changes; nothing is lost',
        run: () => withLastCommit(undoLastCommit),
      },
    );
  }
  items.push(
    { icon: 'revert', label: 'Revert this commit...', hint: 'A new commit that undoes this one; this one stays in the history', run: () => revertFromLog(c) },
    { icon: 'tag', label: 'Create tag here...', hint: 'A fixed name for this commit, usually a version', run: () => openTagModal(c) },
    { icon: 'compare', label: 'Compare from here', hint: 'This commit as Base: the commits that came after it, and what they changed', run: () => logCompareFrom(c) },
  );
  for (const t of tags) {
    items.push(
      { icon: 'push', label: `Push tag ${t}`, hint: `Send ${t} to origin (GitHub)`, run: () => pushTagFromLog(t) },
      { icon: 'delete', label: `Delete tag ${t}...`, danger: true, run: () => deleteTagFromLog(t) },
    );
  }
  openActionMenu({ anchor, x, y, title: `${c.hash} ${c.message}`, items });
}

async function revertFromLog(c) {
  const lines = [`Revert ${c.hash} "${c.message}"?`, 'A new commit undoes its changes; the commit itself stays in the history.'];
  if (c.parents.length > 1) lines.push('It is a merge commit: what it brought in is undone, against the branch it was merged into.');
  if (!(await window.git.confirm(lines.join('\n')))) return;
  showLoading();
  const result = await window.git.revertCommit(currentRepo, c.fullHash);
  hideLoading();
  if (result.error) {
    toast(result.error, 'error', result.conflict ? {} : { title: `Couldn't revert ${c.hash}` });
    if (result.conflict) $('#gitView .tab[data-tab="changes"]').click();
  } else {
    toast(`Reverted ${c.hash}: the new commit is ready to push`, 'success');
  }
  await refresh();
}

// -- The last commit: amend (new message, or the ticked files added to it) or undo, while origin does not have it --
async function withLastCommit(fn) {
  const last = await window.git.lastCommit(currentRepo);
  if (last.error) toast(last.error, 'error');
  else fn(last);
}

async function openCommitMenu() {
  const btn = $('#commitMoreBtn');
  if (!currentRepo) return;
  if ($('#actionMenu') && $('#actionMenu').dataset.anchor === btn.id) {
    closeActionMenu();
    return;
  }
  const last = await window.git.lastCommit(currentRepo);
  if (last.error) {
    openActionMenu({ anchor: btn, items: [{ note: last.error }] });
    return;
  }
  const why = last.pushed ? `${last.short} is already on origin, so it can't be changed or undone here. Revert it from the Log instead.` : '';
  openActionMenu({
    anchor: btn,
    title: `Last commit: ${last.short} ${last.message.split('\n')[0]}`,
    items: [
      { icon: 'edit', label: 'Amend last commit...', disabled: last.pushed, hint: 'Change its message, or add the ticked files to it', run: () => openAmend(last) },
      {
        icon: 'undo', label: 'Undo last commit...', disabled: last.pushed || last.merge,
        hint: last.merge ? 'A merge commit: revert it from the Log instead' : 'Its changes go back to Changes; nothing is lost',
        run: () => undoLastCommit(last),
      },
      ...(why ? [{ note: why }] : []),
    ],
  });
}

let amendLast = null;

function openAmend(last) {
  const [subject, ...rest] = last.message.split('\n');
  amendLast = { ...last, body: rest.join('\n').trim() };
  $('#amendMeta').textContent = `${last.short} · ${formatDate(last.date)}${amendLast.body ? ' · the lines after the first one are kept' : ''}`;
  $('#amendMsg').value = subject;
  const n = selectedEntries().length;
  $('#amendFilesRow').classList.toggle('hidden', n === 0);
  $('#amendFiles').checked = n > 0;
  $('#amendFilesText').textContent = `Also add the ${plural(n, 'ticked file')} to it`;
  $('#amendError').classList.add('hidden');
  $('#amendModal').classList.remove('hidden');
  const input = $('#amendMsg');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function closeAmend() {
  $('#amendModal').classList.add('hidden');
  amendLast = null;
}

async function confirmAmend() {
  if (!amendLast) return;
  const fail = (text) => {
    const el = $('#amendError');
    el.textContent = text;
    el.classList.remove('hidden');
  };
  const subject = $('#amendMsg').value.trim();
  if (!subject) return fail('Write a message.');
  const message = amendLast.body ? `${subject}\n\n${amendLast.body}` : subject;
  const chosen = $('#amendFiles').checked ? selectedEntries() : [];
  const files = chosen.flatMap((e) => (e.from ? [e.from, e.file] : [e.file]));
  showLoading();
  const result = await window.git.amendCommit(currentRepo, message, files);
  hideLoading();
  if (result.error) return fail(describeMessage(result.error).text || describeMessage(result.error).title);
  const short = amendLast.short;
  closeAmend();
  if (chosen.length) deselectedFiles().clear();
  toast(chosen.length ? `Added ${plural(chosen.length, 'file')} to the last commit` : `Changed the message of ${short}`, 'success');
  await refresh();
}

async function undoLastCommit(last) {
  const lines = [`Undo the last commit?`, `${last.short} ${last.message.split('\n')[0]}`, 'Its changes go back to Changes, ready to commit again. Nothing is lost.'];
  if (!(await window.git.confirm(lines.join('\n')))) return;
  showLoading();
  const result = await window.git.undoCommit(currentRepo);
  hideLoading();
  if (result.error) {
    toast(result.error, 'error', { title: "Couldn't undo the commit" });
    return;
  }
  // its message waits in the box, unless something is being written there
  const box = $('#commitMsg');
  if (!box.value.trim() || box.value.trim() === ticketPrefix) {
    box.value = result.message.split('\n')[0];
    updateCommitBtn();
  }
  toast(`Undid ${result.short}: its changes are back in Changes`, 'success');
  $('#gitView .tab[data-tab="changes"]').click();
  await refresh();
}

// -- A merge or revert that stopped on conflicts: a banner over Changes says how to finish it, or abort it --
let operationMessageShown = '';

function showOperation(status) {
  const op = status.operation;
  $('#opBanner').classList.toggle('hidden', !op);
  if (!op) {
    operationMessageShown = '';
    return;
  }
  const conflicts = status.entries.filter((e) => e.letter === 'U').length;
  $('#opText').textContent = conflicts
    ? `A ${op} is waiting: fix the ${plural(conflicts, 'file')} in conflict (U), tick ${conflicts === 1 ? 'it' : 'them'} and commit to finish it. Or abort it to go back to how things were.`
    : `A ${op} is waiting: commit to finish it, or abort it to go back to how things were.`;
  $('#opAbortBtn').textContent = `Abort ${op}`;
  $('#opAbortBtn').dataset.operation = op;
  // the message Git prepared for it goes in the box once, unless something is being written there
  const box = $('#commitMsg');
  if (status.operationMessage && status.operationMessage !== operationMessageShown && (!box.value.trim() || box.value.trim() === ticketPrefix)) {
    box.value = status.operationMessage;
    operationMessageShown = status.operationMessage;
    updateCommitBtn();
  }
}

async function abortOperation() {
  const op = $('#opAbortBtn').dataset.operation || 'merge';
  if (!(await window.git.confirm(`Abort the ${op}?\nThe files go back to how they were before it; what you changed while fixing the conflicts is lost.`))) return;
  showLoading();
  const result = await window.git.abortOperation(currentRepo);
  hideLoading();
  if (result.error) {
    toast(result.error, 'error', { title: `Couldn't abort the ${op}` });
  } else {
    toast(`Aborted the ${result.operation}`, 'success');
    if ($('#commitMsg').value === operationMessageShown) resetCommitMsg();
  }
  await refresh();
}

// -- Tags: create on a commit (and push), push, delete here and on origin --
let tagCommit = null;

async function openTagModal(c) {
  tagCommit = c;
  $('#tagMeta').textContent = `On ${c.hash} · ${c.message}`;
  $('#tagError').classList.add('hidden');
  $('#tagName').value = '';
  $('#tagModal').classList.remove('hidden');
  const suggestion = await window.git.suggestTag(currentRepo);
  const input = $('#tagName');
  if (!suggestion.error && !input.value) input.value = suggestion.name;
  input.focus();
  input.select();
}

function closeTagModal() {
  $('#tagModal').classList.add('hidden');
  tagCommit = null;
}

async function confirmTag() {
  if (!tagCommit) return;
  const fail = (text) => {
    const el = $('#tagError');
    el.textContent = text;
    el.classList.remove('hidden');
  };
  const name = $('#tagName').value.trim();
  if (!name) return fail('Type a name, for example v1.0.0.');
  showLoading();
  const result = await window.git.createTag(currentRepo, name, tagCommit.fullHash, $('#tagPush').checked);
  hideLoading();
  if (result.error) return fail(describeMessage(result.error).text || describeMessage(result.error).title);
  closeTagModal();
  if (result.pushError) toast(result.pushError, 'error', { title: `Created ${result.tag}, but couldn't push it` });
  else toast(result.pushed ? `Created ${result.tag} and pushed it to origin` : `Created ${result.tag}`, 'success');
  await refreshLog();
}

async function pushTagFromLog(tag) {
  showLoading();
  const result = await window.git.pushTag(currentRepo, tag);
  hideLoading();
  if (result.error) toast(result.error, 'error', { title: `Couldn't push ${tag}` });
  else toast(`Pushed ${tag} to origin`, 'success');
}

// Asks origin first: a tag that is there is deleted there too.
async function deleteTagFromLog(tag) {
  showLoading();
  const where = await window.git.tagOnOrigin(currentRepo, tag);
  hideLoading();
  const onOrigin = !where.error && where.onOrigin;
  const question = where.error
    ? `Delete tag ${tag} on this PC?\nCouldn't check origin, so it is left there if it has it.`
    : onOrigin
      ? `Delete tag ${tag}?\nIt is also on origin (GitHub), and is deleted there too.`
      : `Delete tag ${tag}?\nIt is only on this PC.`;
  if (!(await window.git.confirm(question))) return;
  showLoading();
  const result = await window.git.deleteTag(currentRepo, tag, onOrigin);
  hideLoading();
  if (result.error) toast(result.error, 'error', { title: `Couldn't delete ${tag}` });
  else toast(onOrigin ? `Deleted ${tag} here and on origin` : `Deleted ${tag}`, 'success');
  await refreshLog();
}

// -- Clone a repository into a folder, and make a plain folder a Git repository --
let cloneParentPath = '';
let cloneNameTouched = false;

// "https://github.com/owner/repo.git" -> "repo"
function cloneFolderName(url) {
  const last = String(url).trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop() || '';
  return last.replace(/\.git$/i, '').replace(/[^A-Za-z0-9._-]/g, '-');
}

function updateCloneWhere() {
  const name = $('#cloneName').value.trim();
  const sep = window.git.platform === 'win32' ? '\\' : '/';
  $('#cloneParent').textContent = cloneParentPath;
  $('#cloneParent').title = cloneParentPath;
  $('#cloneWhere').textContent = name ? `Creates ${cloneParentPath.replace(/[\\/]+$/, '')}${sep}${name}` : '';
}

async function openCloneModal() {
  cloneParentPath = await window.git.getCloneParent();
  cloneNameTouched = false;
  $('#cloneUrl').value = '';
  $('#cloneName').value = '';
  $('#cloneError').classList.add('hidden');
  updateCloneWhere();
  $('#cloneModal').classList.remove('hidden');
  $('#cloneUrl').focus();
}

function closeCloneModal() {
  $('#cloneModal').classList.add('hidden');
}

async function confirmClone() {
  const fail = (text) => {
    const el = $('#cloneError');
    el.textContent = text;
    el.classList.remove('hidden');
  };
  const url = $('#cloneUrl').value.trim();
  const name = $('#cloneName').value.trim();
  if (!url) return fail('Paste the address of the repository.');
  if (!name) return fail('Choose a name for the new folder.');
  showLoading();
  let result;
  try {
    result = await window.git.cloneRepo(url, cloneParentPath, name);
  } catch (e) {
    result = { error: e.message };
  }
  hideLoading();
  if (result.error) return fail(describeMessage(result.error).text || describeMessage(result.error).title);
  closeCloneModal();
  currentRepo = result.path;
  await loadRepos();
  toast(result.existing ? 'Cloned (the folder was already in the list)' : `Cloned into ${result.path}`, 'success');
}

async function initRepoHere() {
  if (!currentRepo) return;
  const entry = repos.find((r) => r.path === currentRepo);
  const name = (entry && entry.name) || currentRepo.split(/[\\/]/).pop();
  if (!(await window.git.confirm(`Make "${name}" a Git repository?\nGit starts keeping its history there (in a .git folder), on a branch called main. Nothing is committed yet.`))) return;
  showLoading();
  const result = await window.git.initRepo(currentRepo);
  hideLoading();
  if (result.error) {
    toast(result.error, 'error', { title: "Couldn't make it a Git repository" });
    return;
  }
  await loadRepos();
  toast(`${name} is now a Git repository`, 'success');
}

function setupGitBasics() {
  $('#commitMoreBtn').addEventListener('click', openCommitMenu);
  $('#opAbortBtn').addEventListener('click', abortOperation);
  $('#initRepoBtn').addEventListener('click', initRepoHere);
  // a search of the commits asks Git; one of the files filters the list here
  const search = (text) => {
    const view = logViewNow();
    logQuery[view] = text.trim();
    clearTimeout(logSearchTimer);
    if (view === 'files') renderLog();
    else logSearchTimer = setTimeout(() => refreshLog(), text ? 250 : 0);
  };
  $('#logSearch').addEventListener('input', (e) => search(e.target.value));
  $('#logSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.value) {
      e.stopPropagation();
      e.target.value = '';
      search('');
    }
  });
  $('#logBaseBtn').addEventListener('click', () => openRefPicker($('#logBaseBtn'), (logSides.get(currentRepo) || {}).base || logOwnSide(), (side) => setLogSide('base', side)));
  $('#logCompareBtn').addEventListener('click', () => openRefPicker($('#logCompareBtn'), (logSides.get(currentRepo) || {}).compare, (side) => setLogSide('compare', side)));
  $('#logClearBtn').addEventListener('click', () => setLogSide('compare', null));
  $('#logSwapBtn').addEventListener('click', swapLogSides);
  $$('#logViewSeg .seg-btn').forEach((b) => b.addEventListener('click', () => setLogView(b.dataset.view)));
  // the graph is drawn to the height of each commit: again when the list shows or changes width
  new ResizeObserver(() => drawLogGraphs()).observe($('#logList'));
  // the dialogs: Esc or Cancel closes, Enter in a field confirms
  const dialog = (id, close, confirm, fields) => {
    $(`#${id}`).addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    });
    for (const f of fields) {
      $(`#${f}`).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          confirm();
        }
      });
    }
  };
  dialog('amendModal', closeAmend, confirmAmend, ['amendMsg']);
  $('#amendCancelBtn').addEventListener('click', closeAmend);
  $('#amendConfirmBtn').addEventListener('click', confirmAmend);
  $('#amendMsg').addEventListener('input', () => $('#amendError').classList.add('hidden'));
  dialog('tagModal', closeTagModal, confirmTag, ['tagName']);
  $('#tagCancelBtn').addEventListener('click', closeTagModal);
  $('#tagConfirmBtn').addEventListener('click', confirmTag);
  $('#tagName').addEventListener('input', () => $('#tagError').classList.add('hidden'));
  dialog('cloneModal', closeCloneModal, confirmClone, ['cloneUrl', 'cloneName']);
  $('#cloneCancelBtn').addEventListener('click', closeCloneModal);
  $('#cloneConfirmBtn').addEventListener('click', confirmClone);
  $('#cloneUrl').addEventListener('input', () => {
    $('#cloneError').classList.add('hidden');
    if (!cloneNameTouched) $('#cloneName').value = cloneFolderName($('#cloneUrl').value);
    updateCloneWhere();
  });
  $('#cloneName').addEventListener('input', () => {
    cloneNameTouched = true;
    $('#cloneError').classList.add('hidden');
    updateCloneWhere();
  });
  $('#cloneParentBtn').addEventListener('click', async () => {
    const folder = await window.git.pickCloneParent();
    if (!folder) return;
    cloneParentPath = folder;
    updateCloneWhere();
  });
  window.addEventListener('blur', closeActionMenu);
}

// -- Tabs --
function setupTabs() {
  $$('#gitView .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.dataset.tab !== 'changes' || diffCommit) closeDiff();
      $$('#gitView .tab').forEach((t) => t.classList.remove('active'));
      $$('.tab-content').forEach((c) => c.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
      renderRepoLoading();
      saveUiState();
    });
  });
}

// -- Events --
function setupEvents() {
  document.addEventListener('mousedown', (e) => {
    const menu = $('#repoMenu');
    // A press on the menu's own button is left to its click, which closes the menu.
    if (menu && !menu.contains(e.target) && !(menu.anchor && menu.anchor.contains(e.target))) closeRepoMenu();
    const branches = $('#branchMenu');
    if (branches && !branches.contains(e.target) && !$('#branchSwitchBtn').contains(e.target)) closeBranchMenu();
  });
  $('#repoList').addEventListener('scroll', () => closeRepoMenu());
  window.addEventListener('blur', () => {
    closeRepoMenu();
    closeBranchMenu();
  });
  $('#branchSwitchBtn').addEventListener('click', openBranchMenu);

  const search = $('#repoSearch');
  search.addEventListener('input', renderSidebar);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('#repoList .repo-item');
      if (first) first.click();
    } else if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      search.value = '';
      renderSidebar();
    }
  });

  $('#syncReposBtn').addEventListener('click', openSyncReposMenu);
  $('#addRepoBtn').addEventListener('click', () => {
    const btn = $('#addRepoBtn');
    if ($('#actionMenu') && $('#actionMenu').dataset.anchor === btn.id) {
      closeActionMenu();
      return;
    }
    openActionMenu({
      anchor: btn,
      items: [
        { icon: 'folder', label: 'Add a folder...', hint: 'A repository (or any folder) already on this PC', run: addExistingFolder },
        { icon: 'clone', label: 'Clone from a URL...', hint: 'Copy a repository from GitHub or another server', run: openCloneModal },
        { icon: 'group', label: 'Manage groups...', hint: 'Create groups and drag the microservices into them', run: openGroupsBoard },
      ],
    });
  });

  async function addExistingFolder() {
    let result;
    try {
      result = await window.git.addRepo();
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    if (!result) return;
    if (result.error) {
      toast(result.error, 'error');
      return;
    }
    currentRepo = result.path;
    await loadRepos();
    if (result.existing) toast('Already in the list', 'info');
    else toast(result.notGit ? 'Folder added (no Git)' : 'Repository added', 'success');
  }

  // Refresh: looks for repositories in the microservices folder that are not in the list yet, and updates the
  // branch and changes of every repository. Without that folder it asks for it first.
  renderReposRoot();

  $('#selectAllFiles').addEventListener('change', (e) => {
    const off = deselectedFiles();
    off.clear();
    if (!e.target.checked) currentEntries.forEach((entry) => off.add(entry.file));
    renderFileList();
  });

  $('#commitMsg').addEventListener('input', updateCommitBtn);
  $('#commitMsg').addEventListener('focus', (e) => {
    const el = e.target;
    el.setSelectionRange(el.value.length, el.value.length);
  });

  $('#commitBtn').addEventListener('click', async () => {
    const msg = $('#commitMsg').value.trim();
    if (!msg || (ticketPrefix && msg === ticketPrefix)) return;
    const chosen = selectedEntries();
    if (chosen.length === 0) return;
    // A rename is committed together with the removal of its old path.
    const files = chosen.flatMap((e) => (e.from ? [e.from, e.file] : [e.file]));
    showLoading();
    const result = await window.git.commit(currentRepo, msg, files);
    hideLoading();
    if (result.error) {
      toast(result.error, 'error', { title: 'Commit failed' });
    } else {
      toast(`Committed ${chosen.length} file${chosen.length !== 1 ? 's' : ''}`, 'success');
      deselectedFiles().clear();
      resetCommitMsg();
      await Promise.all([refreshStatus(), refreshLog(), refreshPush()]);
      $('#pushTab').click();
    }
  });

  // Revert: the selected files go back to the last commit. Files that did not exist there are deleted.
  $('#revertBtn').addEventListener('click', async () => {
    const chosen = selectedEntries();
    if (!currentRepo || chosen.length === 0) return;
    const created = chosen.filter((e) => e.letter === 'A').length;
    const lines = [
      `Revert ${plural(chosen.length, 'file')} to the last commit?`,
      'The changes in them are lost and cannot be undone.',
    ];
    if (created > 0) lines.push(`${plural(created, 'new file')} will be deleted.`);
    if (!(await window.git.confirm(lines.join('\n')))) return;
    // A rename is reverted together with its old path, like a commit.
    const files = chosen.flatMap((e) => (e.from ? [e.from, e.file] : [e.file]));
    showLoading();
    let result;
    try {
      result = await window.git.revertFiles(currentRepo, files);
    } catch (e) {
      result = { error: e.message };
    }
    hideLoading();
    if (result.error) toast(result.error, 'error', { title: "Couldn't revert the files" });
    else toast(`Reverted ${plural(chosen.length, 'file')}`, 'success');
    await refreshStatus();
  });

  $('#syncMainBtn').addEventListener('click', runSyncMain);
  $('#syncMoreBtn').addEventListener('click', openSyncMenu);
  setInterval(renderFetchedAgo, 60000);

  // Ctrl+Enter to commit
  $('#commitMsg').addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      $('#commitBtn').click();
    }
  });
}

// -- Stash --
let stashCandidates = [];

function noteEl(text) {
  const el = document.createElement('div');
  el.className = 'list-note';
  el.textContent = text;
  return el;
}

function setStashTabLabel(count) {
  $('#stashTab').textContent = count > 0 ? `Stash (${count})` : 'Stash';
  showTabIf($('#stashTab'), count > 0);
}

async function refreshStash() {
  if (!currentRepo) return;
  const repoPath = currentRepo;
  const stashes = await window.git.stashList(repoPath);
  if (repoPath !== currentRepo) return;
  const list = $('#stashList');
  list.innerHTML = '';
  if (stashes.error) {
    setStashTabLabel(0);
    list.appendChild(noteEl(stashes.error));
    return;
  }
  setStashTabLabel(stashes.length);
  if (stashes.length === 0) {
    list.appendChild(noteEl('No stashes yet. Use "Stash changes..." to put work aside.'));
    return;
  }
  stashes.forEach((s) => list.appendChild(createStashItem(s)));
}

async function stashAction(fn, okMessage) {
  showLoading();
  let result;
  try {
    result = await fn();
  } catch (e) {
    result = { error: e.message };
  }
  hideLoading();
  toast(result.error || okMessage, result.error ? 'error' : 'success');
  await refresh();
}

function createStashItem(s) {
  const item = document.createElement('div');
  item.className = 'stash-item';

  const head = document.createElement('div');
  head.className = 'stash-item-head';

  const main = document.createElement('div');
  main.className = 'stash-item-main';
  main.title = 'Click to show the files';
  const name = document.createElement('div');
  name.className = `stash-item-name${s.named ? '' : ' unnamed'}`;
  name.textContent = s.named ? s.message : `(no name) ${s.message}`;
  const meta = document.createElement('div');
  meta.className = 'stash-item-meta';
  meta.textContent = `⎇ ${s.branch || '?'} · ${formatDate(s.date)}`;
  main.append(name, meta);

  const files = document.createElement('div');
  files.className = 'stash-item-files hidden';
  main.addEventListener('click', async () => {
    const open = !files.classList.toggle('hidden');
    if (!open || files.dataset.loaded) return;
    files.dataset.loaded = '1';
    files.textContent = '...';
    const result = await window.git.stashFiles(currentRepo, s.index);
    files.textContent = '';
    if (result.error) {
      files.appendChild(noteEl(result.error));
      return;
    }
    result.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'stash-file';
      row.textContent = f;
      files.appendChild(row);
    });
  });

  const actions = document.createElement('div');
  actions.className = 'stash-item-actions';
  const addBtn = (label, title, handler, extraClass = '') => {
    const btn = document.createElement('button');
    btn.className = `btn btn-sm ${extraClass}`.trim();
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', handler);
    actions.appendChild(btn);
  };
  addBtn('Apply', 'Restore the changes and keep the stash', () =>
    stashAction(() => window.git.stashApply(currentRepo, s.index), 'Stash applied')
  );
  addBtn('Pop', 'Restore the changes and remove the stash', () =>
    stashAction(() => window.git.stashPop(currentRepo, s.index), 'Stash restored and removed')
  );
  addBtn('Drop', 'Delete the stash', async () => {
    const label = s.named ? s.message : s.message || 'this stash';
    if (!(await window.git.confirm(`Delete stash "${label}"? This cannot be undone.`))) return;
    await stashAction(() => window.git.stashDrop(currentRepo, s.index), 'Stash deleted');
  }, 'btn-danger');

  head.append(main, actions);
  item.append(head, files);
  return item;
}

function selectedStashEntries() {
  return [...$$('#stashFiles input[type=checkbox]')]
    .filter((cb) => cb.checked)
    .map((cb) => stashCandidates[Number(cb.dataset.index)]);
}

function updateStashSelection() {
  const n = selectedStashEntries().length;
  const total = stashCandidates.length;
  $('#stashHint').textContent = `${n} of ${total} file${total !== 1 ? 's' : ''} selected. Unselected files stay in your working tree.`;
  $('#stashConfirmBtn').disabled = n === 0;
  $('#stashToggleAll').textContent = n === total ? 'None' : 'All';
}

async function openStashModal() {
  if (!currentRepo) return;
  const status = await window.git.getStatus(currentRepo);
  if (status.error) {
    toast(status.error, 'error');
    return;
  }
  stashCandidates = status.entries.filter((e) => e.letter !== 'U');
  if (stashCandidates.length === 0) {
    toast('No changes to stash', 'info');
    return;
  }
  $('#stashName').value = '';
  const box = $('#stashFiles');
  box.innerHTML = '';
  stashCandidates.forEach((entry, i) => {
    const row = document.createElement('label');
    row.className = 'stash-pick';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.index = i;
    cb.addEventListener('change', updateStashSelection);
    const letter = document.createElement('span');
    letter.className = `file-status ${entry.letter}`;
    letter.textContent = entry.letter;
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = entry.file;
    name.title = entry.file;
    row.append(cb, letter, name);
    box.appendChild(row);
  });
  updateStashSelection();
  $('#stashModal').classList.remove('hidden');
  $('#stashName').focus();
}

function closeStashModal() {
  $('#stashModal').classList.add('hidden');
}

async function confirmStash() {
  const selected = selectedStashEntries();
  if (selected.length === 0) return;
  showLoading();
  const result = await window.git.stashPush(
    currentRepo,
    $('#stashName').value,
    selected.map((e) => e.file),
    selected.some((e) => e.untracked)
  );
  hideLoading();
  if (result.error) {
    toast(result.error, 'error', { title: 'Stash failed' });
    return;
  }
  closeStashModal();
  toast(`Stashed ${selected.length} file${selected.length !== 1 ? 's' : ''}`, 'success');
  await refresh();
  $('#stashTab').click();
}

function setupStash() {
  $('#stashOpenBtn').addEventListener('click', openStashModal);
  $('#stashCancelBtn').addEventListener('click', closeStashModal);
  $('#stashConfirmBtn').addEventListener('click', confirmStash);
  $('#stashToggleAll').addEventListener('click', () => {
    const all = selectedStashEntries().length === stashCandidates.length;
    $$('#stashFiles input[type=checkbox]').forEach((cb) => (cb.checked = !all));
    updateStashSelection();
  });
  $('#stashModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeStashModal();
  });
  $('#stashName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmStash();
  });
}

// -- Push: commits and files not yet on origin, and the branch they go to --
let pushInfo = null;
let remoteBranchNames = [];

function plural(n, word) {
  return `${n} ${word}${n !== 1 ? 's' : ''}`;
}

function renderPushTargetOptions() {
  const list = $('#pushTargetOptions');
  list.textContent = '';
  remoteBranchNames.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    list.appendChild(option);
  });
}

// show: whether there is something to push (commits, or a branch origin does not have yet)
function setPushTabLabel(count, show = count > 0) {
  $('#pushTab').textContent = count > 0 ? `Push (${count})` : 'Push';
  showTabIf($('#pushTab'), show);
}

async function refreshPush() {
  if (!currentRepo) return;
  const repoPath = currentRepo;
  let info;
  try {
    info = await window.git.getUnpushed(repoPath);
  } catch (e) {
    info = { error: e.message };
  }
  if (repoPath !== currentRepo) return;
  pushInfo = info.error ? null : info;
  renderPush(info);
}

function renderPush(info) {
  const input = $('#pushTarget');
  const summary = $('#pushSummary');
  const list = $('#pushList');
  const btn = $('#pushNowBtn');
  const typing = document.activeElement === input;
  summary.className = 'push-summary';
  list.innerHTML = '';

  if (info.error) {
    setPushTabLabel(0);
    summary.textContent = info.error;
    summary.classList.add('warn');
    btn.disabled = true;
    btn.textContent = 'Push';
    return;
  }

  if (!typing) input.value = info.target;
  const n = info.commits.length;
  const dest = `origin/${info.target}`;

  // A new branch with no commits of its own: the push only creates it on origin, at the same commit.
  const createOnly = n === 0 && !info.targetExists && info.behind === 0;
  setPushTabLabel(n, n > 0 || createOnly);
  const parts = [];
  if (n === 0) {
    parts.push(
      info.targetExists
        ? `Nothing to push: ${dest} already has every commit of ${info.current}.`
        : `${dest} does not exist yet. Pushing creates it at the same commit as ${info.current}, with no new commits.`
    );
  } else if (info.targetExists) {
    parts.push(`${plural(n, 'commit')} and ${plural(info.files.length, 'file')} from ${info.current} not yet on ${dest}.`);
  } else {
    parts.push(`${dest} does not exist yet. Pushing creates it with ${plural(n, 'commit')} and ${plural(info.files.length, 'file')} from ${info.current}.`);
  }
  if (info.behind > 0) {
    parts.push(`${dest} has ${plural(info.behind, 'commit')} that ${info.current} does not have, so the push would be rejected. Pull or rebase first.`);
    summary.classList.add('warn');
  } else if (info.upstream && info.target !== info.upstream) {
    parts.push(`${info.current} normally tracks origin/${info.upstream}.`);
  }
  summary.textContent = parts.join(' ');
  btn.disabled = (n === 0 && !createOnly) || info.behind > 0;
  btn.textContent = n > 0 ? `Push ${plural(n, 'commit')}` : createOnly ? `Create ${dest}` : 'Push';

  if (n === 0) {
    list.appendChild(noteEl(createOnly ? `No new commits: the push only creates ${dest} on origin.` : 'Commit something and it shows up here, ready to push.'));
    return;
  }
  // Files on the left, commits on the right; each column scrolls on its own.
  const filesCol = document.createElement('div');
  filesCol.className = 'push-col';
  filesCol.appendChild(pushSectionTitle(`Files (${info.files.length})`, `What changes on ${dest} with this push`));
  info.files.forEach((f) => filesCol.appendChild(pushFileRow(f)));
  const commitsCol = document.createElement('div');
  commitsCol.className = 'push-col';
  commitsCol.appendChild(pushSectionTitle(`Commits (${n})`, 'Click a commit to see its files'));
  info.commits.forEach((c) => commitsCol.appendChild(pushCommitItem(c)));
  list.append(filesCol, commitsCol);
}

function pushSectionTitle(text, hint) {
  const el = document.createElement('div');
  el.className = 'push-section';
  el.textContent = text;
  el.title = hint;
  return el;
}

// In a commit's file list (Push and Branches) a click shows what that commit changed in the file.
function pushFileRow(f, commit = null) {
  const row = document.createElement(commit ? 'button' : 'div');
  row.className = 'push-file';
  if (commit) {
    row.type = 'button';
    row.dataset.hash = commit.fullHash;
    row.dataset.file = f.file;
    row.title = 'Click to see what this commit changed in the file';
    row.addEventListener('click', () => openCommitDiff(commit, f));
  }
  const letter = document.createElement('span');
  letter.className = `file-status ${f.letter}`;
  letter.textContent = f.letter;
  letter.title = LETTER_TITLES[f.letter] || f.letter;
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = f.from ? `${f.from} -> ${f.file}` : f.file;
  if (!commit) name.title = name.textContent;
  row.append(letter, name);
  return row;
}

function pushCommitItem(c) {
  const item = document.createElement('div');
  item.className = 'push-commit';
  const head = document.createElement('div');
  head.className = 'push-commit-head';
  head.title = 'Click to show the files of this commit';
  const hash = document.createElement('span');
  hash.className = 'log-hash';
  hash.textContent = c.hash;
  const body = document.createElement('div');
  body.className = 'log-body';
  body.appendChild(commitTitleRow(c));
  const meta = commitMeta(c);
  if (meta) body.appendChild(meta);
  head.append(hash, body);
  const files = document.createElement('div');
  files.className = 'push-commit-files hidden';
  if (c.files.length === 0) files.appendChild(noteEl('No file changes (merge commit)'));
  c.files.forEach((f) => files.appendChild(pushFileRow(f, c)));
  head.addEventListener('click', () => files.classList.toggle('hidden'));
  item.append(head, files);
  return item;
}

async function pushNow() {
  if (!pushInfo || !currentRepo) return;
  // An empty field means the usual branch, even if the list on screen was computed for another target.
  const usual = pushInfo.upstream || pushInfo.current;
  const target = $('#pushTarget').value.trim() || usual;
  if (target !== usual && !(await window.git.confirm(`Push ${pushInfo.current} to origin/${target}?`))) return;
  const count = pushInfo.commits.length;
  showLoading();
  const result = await window.git.push(currentRepo, target);
  hideLoading();
  if (result.error) {
    toast(result.error, 'error', { title: 'Push failed' });
    return;
  }
  toast(count ? `Pushed ${plural(count, 'commit')} to origin/${result.target}` : `Created origin/${result.target}`, 'success');
  await refresh();
}

function setupPush() {
  const input = $('#pushTarget');
  // "change" fires when the field loses focus with a new value and when a suggestion is picked.
  input.addEventListener('change', async () => {
    if (!currentRepo) return;
    const r = await window.git.setPushTarget(currentRepo, input.value);
    if (r.error) {
      toast(r.error, 'error');
      return;
    }
    await refreshPush();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape' && pushInfo) {
      input.value = pushInfo.target;
      input.blur();
    }
  });
  $('#pushNowBtn').addEventListener('click', pushNow);
}

// -- Move selected files to a folder Git ignores: they leave the commit list but stay on disk --
let parkEntries = [];

const PARK_NOTES = {
  A: 'moves',
  M: 'your version moves; the file goes back to the last commit',
  R: 'moves; the old name comes back from the last commit',
};

const parkFolderText = () => $('#parkFolder').value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

function renderParkFiles() {
  const folder = parkFolderText() || '...';
  const box = $('#parkFiles');
  box.textContent = '';
  parkEntries.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'park-row';
    const letter = diffSpan(`file-status ${e.letter}`, e.letter);
    letter.title = LETTER_TITLES[e.letter] || e.letter;
    const main = document.createElement('div');
    main.className = 'park-main';
    const name = diffSpan('park-path', e.from ? `${e.from} -> ${e.file}` : e.file);
    name.title = name.textContent;
    const dest = diffSpan('park-dest', `→ ${folder}/${e.file}`);
    dest.title = dest.textContent;
    main.append(name, dest);
    row.append(letter, main, diffSpan('park-note', PARK_NOTES[e.letter] || 'moves'));
    box.appendChild(row);
  });
}

async function openParkModal() {
  if (!currentRepo) return;
  const chosen = selectedEntries();
  // A deleted file has nothing to move; a conflict has to be resolved first.
  const skipped = chosen.filter((e) => e.letter === 'D' || e.letter === 'U');
  parkEntries = chosen.filter((e) => e.letter !== 'D' && e.letter !== 'U');
  if (parkEntries.length === 0) {
    toast(skipped.length ? 'Deleted files and files with conflicts cannot be moved' : 'Select at least one file', 'info');
    return;
  }
  let folder = 'local-changes';
  try {
    folder = await window.git.getParkFolder(currentRepo);
  } catch {
    // keep the default
  }
  $('#parkFolder').value = folder;
  const hint = $('#parkHint');
  const why = 'deleted files and files with conflicts cannot be moved.';
  hint.textContent = skipped.length === 0 ? '' : skipped.length === 1 ? `1 file stays as it is: ${why}` : `${skipped.length} files stay as they are: ${why}`;
  hint.classList.toggle('hidden', skipped.length === 0);
  renderParkFiles();
  $('#parkConfirmBtn').textContent = `Move ${plural(parkEntries.length, 'file')}`;
  $('#parkModal').classList.remove('hidden');
  $('#parkFolder').focus();
  $('#parkFolder').select();
}

function closeParkModal() {
  $('#parkModal').classList.add('hidden');
}

async function confirmPark() {
  if (!currentRepo || parkEntries.length === 0) return;
  const btn = $('#parkConfirmBtn');
  btn.disabled = true;
  showLoading();
  let result;
  try {
    result = await window.git.parkFiles(currentRepo, parkEntries.map((e) => ({ file: e.file, from: e.from })), $('#parkFolder').value);
  } catch (e) {
    result = { error: e.message };
  }
  hideLoading();
  btn.disabled = false;
  if (result.error) {
    toast(result.error, 'error');
    return;
  }
  closeParkModal();
  parkEntries.forEach((e) => deselectedFiles().delete(e.file));
  toast(`Moved ${plural(result.moved.length, 'file')} to ${result.folder}. Git ignores that folder in this repository.`, 'success');
  await Promise.all([refreshStatus(), refreshIgnored()]);
}

// -- Ignored tab: the files kept out of commits, each comparable with the project's file and movable back --
let ignoredData = [];
let ignoredRepo = null;
let ignoredSel = null;
let ignoredFull = false;
let ignoredResult = null;
let ignoredTarget = null; // the two files of the split diff on screen (see diffTargetForIgnored)
let ignoredRequest = 0;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function findIgnored(sel) {
  const folder = sel && ignoredData.find((f) => f.folder === sel.folder);
  return folder ? folder.files.find((f) => f.file === sel.file) : null;
}

async function refreshIgnored() {
  if (!currentRepo) return;
  const repoPath = currentRepo;
  let result;
  try {
    result = await window.git.parkedList(repoPath);
  } catch (e) {
    result = { error: e.message };
  }
  if (repoPath !== currentRepo) return;
  if (ignoredRepo !== repoPath) {
    ignoredSel = null;
    ignoredFull = false;
  }
  ignoredRepo = repoPath;
  ignoredData = result.error ? [] : result.folders;
  const count = ignoredData.reduce((n, f) => n + f.files.length, 0);
  $('#ignoredTab').textContent = count > 0 ? `Ignored (${count})` : 'Ignored';
  showTabIf($('#ignoredTab'), count > 0);
  if (ignoredSel && !findIgnored(ignoredSel)) {
    ignoredSel = null;
    ignoredFull = false;
  }
  renderIgnoredList(result.error);
  if (ignoredSel) loadIgnoredDiff({ keepScroll: true });
  else showIgnoredPanel(false);
}

function showIgnoredPanel(on) {
  $('#ignoredPanel').classList.toggle('hidden', !on);
  $('#ignoredHint').classList.toggle('hidden', on);
}

function renderIgnoredList(error) {
  const box = $('#ignoredList');
  box.textContent = '';
  if (error) {
    box.appendChild(noteEl(error));
    return;
  }
  if (ignoredData.length === 0) {
    box.appendChild(noteEl('No files kept out of commits. Use "Move to ignored folder..." in Changes.'));
    return;
  }
  ignoredData.forEach((group) => {
    const head = document.createElement('div');
    head.className = 'ign-folder';
    const text = document.createElement('div');
    text.className = 'ign-folder-text';
    text.append(
      diffSpan('ign-folder-name', `${group.folder}/`),
      diffSpan('ign-folder-sub', group.truncated ? 'ignored in this repository · first 2000 files' : 'ignored in this repository')
    );
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-sm';
    open.textContent = 'Open folder';
    open.title = `Open ${group.folder} in ${IS_MAC ? 'Finder' : 'Explorer'}`;
    open.disabled = !group.exists;
    open.addEventListener('click', () => openIgnoredFolder(group.folder));
    head.append(text, open);
    box.appendChild(head);
    if (group.files.length === 0) {
      box.appendChild(noteEl(group.exists ? 'This folder is empty.' : 'This folder does not exist any more.'));
      return;
    }
    group.files.forEach((f) => box.appendChild(ignoredRow(group.folder, f)));
  });
}

function ignoredRow(folder, f) {
  const row = document.createElement('div');
  const selected = ignoredSel && ignoredSel.folder === folder && ignoredSel.file === f.file;
  row.className = `ign-row${selected ? ' selected' : ''}`;
  row.tabIndex = 0;
  row.dataset.folder = folder;
  row.dataset.file = f.file;
  row.title = `${folder}/${f.file}\nClick to compare it with the project`;
  const slash = f.file.lastIndexOf('/');
  const name = document.createElement('div');
  name.className = 'ign-name';
  name.append(diffSpan('fn-base', slash === -1 ? f.file : f.file.slice(slash + 1)));
  if (slash !== -1) name.append(diffSpan('fn-dir', f.file.slice(0, slash)));
  const meta = document.createElement('div');
  meta.className = 'ign-meta';
  meta.append(diffSpan('', formatSize(f.size)), diffSpan('', formatDate(f.mtime)));
  if (!f.inProject) meta.appendChild(diffSpan('ign-badge', 'not in the project'));
  else if (f.projectChanged) meta.appendChild(diffSpan('ign-badge warn', 'project file has changes'));
  if (f.original !== f.file) meta.appendChild(diffSpan('ign-badge', `copy of ${f.original.split('/').pop()}`));
  row.append(name, meta);
  row.addEventListener('click', () => selectIgnored(folder, f.file));
  row.addEventListener('keydown', (e) => {
    if (e.target !== row) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      row.click();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = [...$$('#ignoredList .ign-row')];
      const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        e.preventDefault();
        next.focus();
        next.click();
      }
    }
  });
  return row;
}

function selectIgnored(folder, file) {
  const same = ignoredSel && ignoredSel.folder === folder && ignoredSel.file === file;
  if (!same) ignoredFull = false;
  ignoredSel = { folder, file };
  $$('#ignoredList .ign-row').forEach((el) => el.classList.toggle('selected', el.dataset.folder === folder && el.dataset.file === file));
  loadIgnoredDiff({ keepScroll: same });
}

async function loadIgnoredDiff({ keepScroll = false, scrollToNewLine = null } = {}) {
  const sel = ignoredSel;
  if (!sel || !currentRepo) return;
  const repoPath = currentRepo;
  const request = ++ignoredRequest;
  showIgnoredPanel(true);
  const pathEl = $('#ignoredPath');
  pathEl.textContent = '';
  const slash = sel.file.lastIndexOf('/');
  pathEl.append(diffSpan('dp-dir', `${sel.folder}/${slash === -1 ? '' : sel.file.slice(0, slash + 1)}`), diffSpan('dp-base', sel.file.slice(slash + 1)));
  pathEl.title = `${sel.folder}/${sel.file}`;
  $('#ignoredColFolder').textContent = sel.folder;
  const body = $('#ignoredBody');
  const top = keepScroll ? body.scrollTop : 0;
  if (!keepScroll) {
    body.textContent = '';
    body.appendChild(noteEl('Loading...'));
  }
  let result;
  try {
    result = await window.git.parkedDiff(repoPath, sel.folder, sel.file, { full: ignoredFull });
  } catch (e) {
    result = { error: e.message };
  }
  if (request !== ignoredRequest || repoPath !== currentRepo || ignoredSel !== sel) return;
  ignoredResult = result;
  renderIgnoredDiff();
  const target = scrollToNewLine !== null ? body.querySelector(`[data-new="${scrollToNewLine}"]`) : null;
  body.scrollTop = target ? Math.max(0, target.offsetTop - 40) : top;
}

// The project's file on the left, the kept copy on the right (the same diff renderers as the Changes tab).
function renderIgnoredDiff() {
  const result = ignoredResult;
  const body = $('#ignoredBody');
  ignoredTarget = null;
  closeDiffMenu();
  const stats = $('#ignoredStats');
  const note = $('#ignoredNote');
  body.textContent = '';
  stats.textContent = '';
  note.textContent = '';
  if (!result || result.error) {
    $('#ignoredCols').classList.add('hidden');
    note.classList.add('hidden');
    if (result) body.appendChild(noteEl(result.error));
    return;
  }
  const { meta, rows } = parseDiff(result.diff);
  annotateWords(rows);
  improveHunkNames(rows);
  const added = rows.filter((r) => r.type === 'add').length;
  const removed = rows.filter((r) => r.type === 'del').length;
  if (added || removed) stats.append(diffSpan('add', `+${added}`), diffSpan('del', `−${removed}`));

  const notes = [];
  if (!result.inProject) notes.push(`${result.original} is not in the project, so the whole copy is shown.`);
  else if (result.original !== result.file) notes.push(`A second copy of ${result.original}.`);
  if (result.truncated || rows.length > DIFF_MAX_LINES) notes.push('The diff is very long, so only the first part is shown.');
  if (ignoredFull) notes.push('Showing the whole file.');
  if (notes.length) note.append(notes.join(' '));
  if (ignoredFull) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'diff-note-link';
    back.textContent = 'Only the differences';
    back.addEventListener('click', () => {
      ignoredFull = false;
      loadIgnoredDiff();
    });
    note.append(' ', back);
  }
  note.classList.toggle('hidden', notes.length === 0);

  const oneSide = !result.inProject;
  const layout = oneSide ? 'unified' : diffLayout;
  $$('#ignoredLayout .seg-btn').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.layout === layout));
    b.disabled = oneSide;
  });
  const hasText = !meta.binary && rows.length > 0;
  $('#ignoredCols').classList.toggle('hidden', !hasText || layout !== 'split');
  if (meta.binary) body.appendChild(noteEl('Binary file: there is no text to compare.'));
  else if (!hasText) body.appendChild(noteEl(result.inProject ? 'Your copy is the same as the file in the project.' : 'The file is empty.'));
  else {
    const onShow = (newLine) => {
      ignoredFull = true;
      loadIgnoredDiff({ scrollToNewLine: newLine });
    };
    const items = diffSequence(rows.slice(0, DIFF_MAX_LINES), meta, ignoredFull, onShow);
    // the renderers collect change groups for the Changes diff's J/K keys; keep that list as it was
    const changesGroups = diffGroups;
    diffGroups = [];
    ignoredTarget = layout === 'split' && ignoredSel ? diffTargetForIgnored(ignoredSel) : null;
    body.appendChild(layout === 'split' ? renderSplit(items, ignoredTarget) : renderUnified(items));
    diffGroups = changesGroups;
  }
}

async function restoreIgnored() {
  const sel = ignoredSel;
  if (!sel || !currentRepo) return;
  const entry = findIgnored(sel);
  const target = entry ? entry.original : sel.file;
  if (!(await window.git.confirm(`Put ${sel.folder}/${sel.file} back in the project as ${target}? It counts as a change again.`))) return;
  showLoading();
  let result;
  try {
    result = await window.git.parkedRestore(currentRepo, sel.folder, sel.file);
  } catch (e) {
    result = { error: e.message };
  }
  hideLoading();
  if (result.error) {
    toast(result.error, 'error');
    return;
  }
  toast(`${result.file} is back in the project`, 'success');
  ignoredSel = null;
  ignoredFull = false;
  await Promise.all([refreshIgnored(), refreshStatus()]);
}

async function openIgnoredFolder(folder) {
  const result = await window.git.parkedOpenFolder(currentRepo, folder);
  if (result.error) toast(result.error, 'error');
}

function setupIgnored() {
  setupSplitTools($('#ignoredBody'), () => ignoredTarget);
  $('#ignoredUseLeftBtn').addEventListener('click', () => ignoredSel && useWholeSide(ignoredTarget, 'left', ignoredSel.file));
  $('#ignoredUseRightBtn').addEventListener('click', () => ignoredSel && useWholeSide(ignoredTarget, 'right', ignoredSel.file));
  $('#ignoredRestoreBtn').addEventListener('click', restoreIgnored);
  $$('#ignoredLayout .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      diffLayout = b.dataset.layout;
      try {
        localStorage.setItem(DIFF_LAYOUT_KEY, diffLayout);
      } catch {
        // not remembered, but the layout still applies
      }
      renderIgnoredDiff();
    })
  );
}

function setupPark() {
  $('#parkBtn').addEventListener('click', openParkModal);
  $('#parkCancelBtn').addEventListener('click', closeParkModal);
  $('#parkConfirmBtn').addEventListener('click', confirmPark);
  $('#parkFolder').addEventListener('input', renderParkFiles);
  $('#parkModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeParkModal();
    else if (e.key === 'Enter' && e.target.id === 'parkFolder') confirmPark();
  });
}

// -- Modes (Git / Vault) --
function updateCrumb() {
  let mode = 'Git';
  let ctx = '';
  if (currentMode === 'git') {
    if (effectiveGitView() === 'maven') mode = 'Maven';
    const r = repos.find((x) => x.path === currentRepo);
    ctx = r ? displayName(r) : '';
  } else if (currentMode === 'vault') {
    mode = 'Vault';
    ctx = vaultCrumb();
  } else if (currentMode === 'clip') {
    mode = 'Clipboard history';
  } else if (currentMode === 'logs') {
    mode = 'Logs';
    ctx = logsCrumb();
  } else if (currentMode === 'docker') {
    mode = 'Containers';
    const running = dkState.containers.filter(dkRunning).length;
    ctx = dkState.status && dkState.status.running ? `${running} running · ${dkEngine()}` : '';
  } else if (currentMode === 'help') {
    mode = 'Help';
    ctx = $('#helpSearch').value.trim() ? 'Search' : helpCategory;
  } else if (currentMode === 'tools') {
    mode = 'Tools';
    ctx = toolTitle(currentTool);
  } else if (currentMode === 'analysis') {
    mode = 'Analysis';
    ctx = analysisTitle(currentAnalysis);
  } else if (currentMode === 'search') {
    mode = 'Search';
    ctx = searchCrumb();
  } else {
    mode = 'Tasks';
    const open = todoTasks.filter((t) => t.status !== 'done').length;
    ctx = todoTasks.length > 0 ? `${open} to do` : '';
  }
  $('#crumbMode').textContent = mode;
  $('#crumbCtx').textContent = ctx;
  $('#crumbSep').classList.toggle('hidden', !ctx);
}

function setMode(mode) {
  currentMode = ['vault', 'todo', 'clip', 'help', 'logs', 'docker', 'tools', 'analysis', 'search'].includes(mode) ? mode : 'git';
  $('#gitView').classList.toggle('hidden', currentMode !== 'git');
  $('#vaultView').classList.toggle('hidden', currentMode !== 'vault');
  $('#todoView').classList.toggle('hidden', currentMode !== 'todo');
  $('#clipView').classList.toggle('hidden', currentMode !== 'clip');
  $('#helpView').classList.toggle('hidden', currentMode !== 'help');
  $('#logsView').classList.toggle('hidden', currentMode !== 'logs');
  $('#dockerView').classList.toggle('hidden', currentMode !== 'docker');
  $('#toolsView').classList.toggle('hidden', currentMode !== 'tools');
  $('#analysisView').classList.toggle('hidden', currentMode !== 'analysis');
  $('#searchView').classList.toggle('hidden', currentMode !== 'search');
  $$('.mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === currentMode));
  updateHotkeyBadge();
  updateCrumb();
  saveUiState();
}

// -- IntelliJ project detected when the window was opened --
let ideProjectPath = null;

function hideIdeBanner() {
  $('#ideBanner').classList.add('hidden');
  ideProjectPath = null;
}

function handleIde(ide) {
  hideIdeBanner();
  if (!ide) return;
  if (ide.repo) {
    currentRepo = ide.repo;
    return;
  }
  ideProjectPath = ide.projectPath;
  $('#ideBannerText').textContent = ide.projectPath
    ? `IntelliJ project "${ide.projectName}" is not in your list (${ide.projectPath}).`
    : `IntelliJ project "${ide.projectName}" is not in your list.`;
  $('#ideBannerAdd').classList.toggle('hidden', !ide.projectPath);
  $('#ideBanner').classList.remove('hidden');
}

function setupIdeBanner() {
  $('#ideBannerClose').addEventListener('click', hideIdeBanner);
  $('#ideBannerAdd').addEventListener('click', async () => {
    if (!ideProjectPath) return;
    const r = await window.git.addRepoPath(ideProjectPath);
    if (r.error) {
      toast(r.error, 'error');
      return;
    }
    hideIdeBanner();
    currentRepo = r.path;
    await loadRepos();
    toast(r.notGit ? 'Folder added (no Git)' : 'Repository added', 'success');
  });
}

function activateMode(mode, ide) {
  if (ide !== undefined) handleIde(ide);
  setMode(mode);
  if (currentMode === 'vault') {
    refreshVault();
  } else if (currentMode === 'todo') {
    refreshTodos();
  } else if (currentMode === 'clip') {
    refreshClips();
  } else if (currentMode === 'logs') {
    refreshLogs();
  } else if (currentMode === 'docker') {
    refreshContainers();
  } else if (currentMode === 'tools') {
    showTool(currentTool);
  } else if (currentMode === 'analysis') {
    showAnalysis(currentAnalysis);
  } else if (currentMode === 'search') {
    showSearch();
  } else if (currentMode === 'help') {
    renderTermFolders(); // the repositories may have changed
  } else {
    refreshSummaries();
    if (currentRepo) refresh();
  }
}

function setupModes() {
  $$('.mode-tab').forEach((t) => t.addEventListener('click', () => activateMode(t.dataset.mode)));
  setupRailOrder();
}

// -- The rail: its icons can be put in another order by dragging them (or Alt+Up/Down); kept on this PC --
const RAIL_ORDER_KEY = 'railOrder';
const railItems = () => [...$('.rail').querySelectorAll('.rail-btn.mode-tab')];
const railKey = (b) => b.dataset.mode || b.id;
let railDefault = [];

function applyRailOrder(order) {
  const rail = $('.rail');
  const spacer = rail.querySelector('.rail-spacer');
  const byKey = new Map(railItems().map((b) => [railKey(b), b]));
  // an icon the saved order does not know (a new page) keeps its place after the known ones
  const keys = [...order.filter((k) => byKey.has(k)), ...[...byKey.keys()].filter((k) => !order.includes(k))];
  for (const k of keys) rail.insertBefore(byKey.get(k), spacer);
}

function saveRailOrder() {
  try {
    localStorage.setItem(RAIL_ORDER_KEY, JSON.stringify(railItems().map(railKey)));
  } catch {
    // only for this session
  }
}

function setupRailOrder() {
  railDefault = railItems().map(railKey);
  try {
    const saved = JSON.parse(localStorage.getItem(RAIL_ORDER_KEY));
    if (Array.isArray(saved)) applyRailOrder(saved);
  } catch {
    // the default order
  }
  let dragged = null;
  const clearMarks = () => railItems().forEach((b) => b.classList.remove('rail-drop-before', 'rail-drop-after'));
  for (const btn of railItems()) {
    btn.draggable = true;
    btn.title = `${btn.getAttribute('aria-label')} (drag to move it)`;
    btn.addEventListener('dragstart', (e) => {
      dragged = btn;
      btn.classList.add('rail-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', railKey(btn));
    });
    btn.addEventListener('dragover', (e) => {
      if (!dragged || dragged === btn) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = btn.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      clearMarks();
      btn.classList.add(before ? 'rail-drop-before' : 'rail-drop-after');
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('rail-drop-before', 'rail-drop-after'));
    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragged || dragged === btn) return;
      const before = btn.classList.contains('rail-drop-before');
      btn.parentNode.insertBefore(dragged, before ? btn : btn.nextSibling);
      clearMarks();
      saveRailOrder();
    });
    btn.addEventListener('dragend', () => {
      if (dragged) dragged.classList.remove('rail-dragging');
      dragged = null;
      clearMarks();
    });
    // from the keyboard: Alt+Up / Alt+Down moves the icon one place
    btn.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const items = railItems();
      const i = items.indexOf(btn);
      const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
      if (j < 0 || j >= items.length) return;
      btn.parentNode.insertBefore(btn, e.key === 'ArrowUp' ? items[j] : items[j].nextSibling);
      btn.focus();
      saveRailOrder();
    });
  }
  // a right-click on the rail puts the icons back in their first order
  $('.rail').addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.rail-btn.mode-tab')) return;
    e.preventDefault();
    openActionMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { note: 'Drag an icon to move it (or Alt+Up / Alt+Down).' },
        {
          icon: 'undo', label: 'Put the icons back in their first order', disabled: railItems().map(railKey).join() === railDefault.join(),
          run: () => {
            applyRailOrder(railDefault);
            try {
              localStorage.removeItem(RAIL_ORDER_KEY);
            } catch {
              // nothing saved
            }
          },
        },
      ],
    });
  });
}

// -- Pin (keep the window open when it loses focus) --
async function setupPin() {
  const btn = $('#pinBtn');
  const apply = (pinned) => {
    btn.classList.toggle('active', pinned);
    btn.setAttribute('aria-pressed', String(pinned));
    btn.title = pinned
      ? 'Pinned: the window stays open when you click outside (click to unpin)'
      : 'Pin: keep the window open when you click outside';
  };
  apply(await window.git.getPinned());
  btn.addEventListener('click', async () => apply(await window.git.setPinned(!btn.classList.contains('active'))));
}

// -- Settings (global shortcuts) --
const KEY_NAMES = {
  Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Tab: 'Tab', Backspace: 'Backspace',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';',
  Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`',
};

const hotkeyState = {};

// Shortcuts read as Cmd/Option on macOS and Ctrl/Win on Windows, the keys the user actually presses.
const IS_MAC = window.git.platform === 'darwin';
const KEY_LABELS = IS_MAC
  ? { CommandOrControl: 'Cmd', Command: 'Cmd', Super: 'Cmd', Meta: 'Cmd', Control: 'Ctrl', Alt: 'Option' }
  : { CommandOrControl: 'Ctrl', Control: 'Ctrl', Super: 'Win', Meta: 'Win' };

function displayHotkey(accel) {
  return accel.split('+').map((part) => KEY_LABELS[part] || part).join('+');
}

function codeToKey(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return `num${m[1]}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return KEY_NAMES[code] || null;
}

function hotkeyInput(name) {
  return document.querySelector(`.hotkey-input[data-hotkey="${name}"]`);
}

// pending: null = unchanged, '' = remove the shortcut, otherwise the new accelerator.
function hotkeyValue(s) {
  return s.pending === null ? s.active : s.pending;
}

function updateHotkeySave() {
  const changed = Object.values(hotkeyState).some((s) => s.pending !== null && s.pending !== s.active);
  $('#hotkeySaveBtn').disabled = !changed;
}

function setPendingHotkey(name, accel) {
  const s = hotkeyState[name];
  s.pending = accel;
  const value = hotkeyValue(s);
  hotkeyInput(name).value = value ? displayHotkey(value) : '';
  hotkeyInput(name).closest('.hotkey-row').querySelector('.hotkey-clear').disabled = !value;
  updateHotkeySave();
}

function updateHotkeyBadge() {
  const s = hotkeyState[currentMode];
  $('#hotkeyBadge').classList.toggle('hidden', !s || !s.active);
  if (s && s.active) $('#hotkeyBadge').textContent = displayHotkey(s.active);
}

function openSettings() {
  for (const name of Object.keys(hotkeyState)) setPendingHotkey(name, null);
  $('#settingsPanel').classList.remove('hidden');
}

function closeSettings() {
  $('#settingsPanel').classList.add('hidden');
  $$('.hotkey-input').forEach((i) => i.classList.remove('capturing'));
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $$('.theme-opt[data-theme-value]').forEach((b) => b.classList.toggle('active', b.dataset.themeValue === theme));
}

async function setupTheme() {
  applyTheme(await window.git.getTheme());
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    window.git.setTheme(next);
  });
  $$('.theme-opt[data-theme-value]').forEach((b) =>
    b.addEventListener('click', () => {
      applyTheme(b.dataset.themeValue);
      window.git.setTheme(b.dataset.themeValue);
    })
  );
}

function hotkeyFromEvent(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const key = codeToKey(e.code);
  if (!key) {
    toast('Key not supported', 'error');
    return null;
  }
  if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && !/^F\d+$/.test(key)) {
    toast('Use at least one modifier (Ctrl, Alt, Shift)', 'error');
    return null;
  }
  // On macOS the Cmd key is CommandOrControl and Ctrl is Control; on Windows Ctrl is CommandOrControl and Win is Super.
  const parts = [];
  if (e.ctrlKey) parts.push(IS_MAC ? 'Control' : 'CommandOrControl');
  if (e.metaKey) parts.push(IS_MAC ? 'CommandOrControl' : 'Super');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

function buildHotkeyRows(info) {
  const box = $('#hotkeyRows');
  box.textContent = '';
  for (const [name, v] of Object.entries(info)) {
    const row = document.createElement('div');
    row.className = 'hotkey-row';
    const label = document.createElement('span');
    label.className = 'hotkey-label';
    label.textContent = v.label || name;
    const input = document.createElement('input');
    input.className = 'input hotkey-input';
    input.dataset.hotkey = name;
    input.readOnly = true;
    input.placeholder = 'Not set - click and press keys';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'icon-btn-plain hotkey-clear';
    clear.title = `Remove the ${v.label || name} shortcut`;
    clear.textContent = '\u2715';
    clear.addEventListener('click', () => setPendingHotkey(name, ''));
    input.addEventListener('focus', () => input.classList.add('capturing'));
    input.addEventListener('blur', () => input.classList.remove('capturing'));
    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      if (e.key === 'Escape') {
        closeSettings();
        return;
      }
      const accel = hotkeyFromEvent(e);
      if (accel) setPendingHotkey(name, accel);
    });
    row.append(label, input, clear);
    box.appendChild(row);
  }
}

async function setupSettings() {
  await setupTheme();
  const info = await window.git.getHotkeys();
  for (const [name, v] of Object.entries(info)) {
    hotkeyState[name] = { active: v.hotkey, def: v.defaultHotkey, pending: null };
  }
  buildHotkeyRows(info);
  updateHotkeyBadge();

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsCancelBtn').addEventListener('click', closeSettings);

  $('#hotkeyResetBtn').addEventListener('click', () => {
    for (const [name, s] of Object.entries(hotkeyState)) setPendingHotkey(name, s.def);
  });

  $('#hotkeySaveBtn').addEventListener('click', async () => {
    const changed = Object.entries(hotkeyState).filter(([, s]) => s.pending !== null && s.pending !== s.active);
    const labelOf = (name) => hotkeyInput(name).closest('.hotkey-row').querySelector('.hotkey-label').textContent;
    // Free every changed key first, so two shortcuts can swap keys in one save.
    for (const [name, s] of changed) {
      if (s.active) {
        await window.git.setHotkey(name, '');
        s.active = '';
      }
    }
    let failed = null;
    for (const [name, s] of changed) {
      if (!s.pending) continue;
      const result = await window.git.setHotkey(name, s.pending);
      if (result.error) {
        failed = `${labelOf(name)}: ${result.error}`;
        break;
      }
      s.active = result.hotkey;
    }
    const info = await window.git.getHotkeys();
    for (const [name, v] of Object.entries(info)) Object.assign(hotkeyState[name], { active: v.hotkey, pending: null });
    updateHotkeyBadge();
    if (failed) {
      for (const name of Object.keys(hotkeyState)) setPendingHotkey(name, null);
      toast(failed, 'error');
      return;
    }
    closeSettings();
    toast('Shortcuts saved', 'success');
  });
}

// -- Messages --
// Git answers in its own words: "error:" and "fatal:" in front, files indented with a tab, "hint:" lines, "Aborting".
// The messages Git gives most often become a title, a sentence, the files and what to do. Any other message keeps
// its own words, with its first sentence as the title.
const these = (files) => (files.length === 1 ? 'this file' : 'these files');
const GIT_MESSAGES = [
  { re: /local changes to the following files would be overwritten by (checkout|switch)/i, title: "Can't switch branch",
    text: (m, f) => `Your changes in ${these(f)} would be lost:`, hint: 'Commit or stash them first (Stash... at the top), then switch.' },
  { re: /local changes to the following files would be overwritten by merge/i, title: "Can't pull",
    text: (m, f) => `Your changes in ${these(f)} would be lost:`, hint: 'Commit or stash them first, then pull.' },
  { re: /untracked working tree files would be (overwritten|removed) by (checkout|switch)/i, title: "Can't switch branch",
    text: (m, f) => `The other branch also has ${these(f)}, not yet in Git here:`, hint: 'Commit, move or delete them first, then switch.' },
  { re: /untracked working tree files would be (overwritten|removed) by merge/i, title: "Can't pull",
    text: (m, f) => `origin also has ${these(f)}, not yet in Git here:`, hint: 'Commit, move or delete them first, then pull.' },
  { re: /stopped on conflicts|Merge conflict in|Automatic merge failed/i, title: 'Conflicts to resolve',
    text: (m, f) => (f.length ? `${f.length === 1 ? 'This file' : 'These files'} changed on both sides:` : 'Some files changed on both sides.'),
    hint: 'Open each one in Changes, keep the lines you want, then commit.' },
  { re: /You have not concluded your merge|MERGE_HEAD exists|you have unmerged files|unresolved conflict/i, title: 'A merge is still open',
    text: 'Some files are still in conflict.', hint: 'Resolve them in Changes and commit, then try again.' },
  { re: /\[rejected\]|Updates were rejected|non-fast-forward|\(fetch first\)/i, title: 'Push rejected',
    text: 'origin has commits that your branch does not have.', hint: 'Pull first, then push again.' },
  { re: /Authentication failed|could not read (Username|Password)|Permission denied|returned error: 40[13]|terminal prompts disabled|Invalid username or password/i,
    title: 'Login refused', text: 'The server did not accept your Git login for this repository.',
    hint: 'Check your credentials (on Windows, in Credential Manager) and that you have access to the repository.' },
  { re: /Repository not found|does not appear to be a git repository|repository '[^']*' not found/i, title: 'Repository not found',
    text: 'origin points to a repository that does not exist, or that you cannot see.', hint: 'Check the origin address and your access.' },
  { re: /Could not resolve host|Failed to connect|Connection (timed out|refused|reset)|Couldn't connect to server|Operation timed out|unable to access/i,
    title: "Can't reach the server",
    text: (m, f, raw) => `${(raw.match(/Could not resolve host:? ?([^\s']+)/i) || raw.match(/https?:\/\/(?:[^@/'\s]+@)?([^/'\s:]+)/i) || [])[1] || 'The server'} did not answer.`,
    hint: 'Check the network or the VPN, then try again.' },
  { re: /pathspec '(.+?)' did not match/i, title: 'Branch not found',
    text: (m) => `There is no branch called "${m[1]}".`, hint: 'Press Fetch to bring the newest branches from origin.' },
  { re: /couldn't find remote ref (\S+)/i, title: 'Branch not on origin',
    text: (m) => `origin has no branch "${m[1]}".`, hint: 'Press Fetch, or push the branch first.' },
  { re: /a branch named '(.+?)' already exists/i, title: 'Branch already exists',
    text: (m) => `There is already a branch called "${m[1]}".`, hint: 'Pick another name, or switch to it from the branch list.' },
  { re: /Cannot delete branch '(.+?)' checked out/i, title: "Can't delete the branch you are on",
    text: (m) => `You are on "${m[1]}".`, hint: 'Switch to another branch first.' },
  { re: /branch '(.+?)' is not fully merged/i, title: 'Branch not merged',
    text: (m) => `"${m[1]}" has commits that no other branch has.`, hint: 'Merge or push it first.' },
  { re: /no tracking information for the current branch/i, title: 'Nothing to pull from',
    text: 'This branch is not linked to a branch on origin.', hint: 'Push it once (Push...) to link it.' },
  { re: /Please tell me who you are|Author identity unknown|empty ident name/i, title: "Git doesn't know who you are",
    text: 'A commit needs your name and email.', hint: 'Run git config --global user.name "Your Name" and git config --global user.email "you@example.com".' },
  { re: /index\.lock/i, title: 'Git is busy',
    text: 'Another Git program is using this repository.', hint: 'Wait for it to end. If none is open, delete .git/index.lock.' },
  { re: /refusing to merge unrelated histories/i, title: 'Unrelated histories',
    text: 'Your branch and origin have no commit in common.', hint: 'This needs git pull --allow-unrelated-histories in a terminal.' },
  { re: /nothing to commit/i, title: 'Nothing to commit', text: 'There are no changes to commit.' },
  { re: /No local changes to save|No stash entries found/i, title: 'Nothing to stash', text: 'There are no changes to put aside.' },
  { re: /not a git repository/i, title: 'Not a Git repository', text: 'This folder has no .git folder.' },
];

function describeMessage(msg, title = '') {
  let lines = String(msg ?? '').replace(/\r/g, '').split('\n');
  // Git prints progress and the server's lines first; what matters starts at the first "error:" or "fatal:".
  const first = lines.findIndex((l) => /^(error|fatal):/i.test(l.trim()));
  if (first > 0) lines = lines.slice(first);
  const files = [];
  const words = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^(\t| {4,})\S/.test(line)) {
      files.push(t);
      continue;
    }
    const conflict = t.match(/Merge conflict in (.+)$/);
    if (conflict) files.push(conflict[1]);
    if (t && !/^(hint:|Aborting$)/i.test(t)) words.push(t.replace(/^(error|fatal|warning|remote):\s*/i, ''));
  }
  const unique = [...new Set(files)];
  const plain = words.join(' ').replace(/\s+/g, ' ').trim();
  const raw = lines.join('\n');
  const rule = GIT_MESSAGES.find((r) => r.re.test(raw));
  if (rule) {
    const m = raw.match(rule.re);
    const value = (v) => (typeof v === 'function' ? v(m, unique, raw) : v || '');
    return { title: title || rule.title, text: value(rule.text), files: unique, hint: value(rule.hint) };
  }
  if (title) return { title, text: plain, files: unique, hint: '' };
  // The first sentence is the title; a short message is only a title, a long one only text.
  const split = plain.match(/^(.{1,140}?[.!?:])\s+(?=["'(<A-Z0-9])(.+)$/s);
  if (split) return { title: split[1].replace(/[.:]$/, ''), text: split[2], files: unique, hint: '' };
  if (plain.length <= 100) return { title: plain.replace(/\.$/, ''), text: '', files: unique, hint: '' };
  return { title: '', text: plain, files: unique, hint: '' };
}

const TOAST_ICONS = {
  error: '<circle cx="8" cy="8" r="6.5"/><path d="M8 4.7v3.8M8 11.2v.1"/>',
  success: '<circle cx="8" cy="8" r="6.5"/><path d="M5.3 8.2l1.8 1.8 3.6-3.8"/>',
  info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7.3v3.9M8 4.8v.1"/>',
};
const MAX_TOAST_FILES = 6;

// Every message has the same layout: an icon, a title, a sentence, the files and what to do. An error stays longer,
// waits while the mouse is on it and has a close button.
function toast(msg, type = 'info', opts = {}) {
  const el = $('#toast');
  // plain: the app's own text as it is (a list of names, say), not read for a known Git message
  const d = opts.plain ? { title: opts.title || '', text: String(msg ?? ''), files: [], hint: '' } : describeMessage(msg, opts.title);
  const part = (tag, cls, text) => {
    const node = document.createElement(tag);
    node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  el.textContent = '';
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.insertAdjacentHTML('beforeend', `<svg class="toast-icon" viewBox="0 0 16 16" aria-hidden="true">${TOAST_ICONS[type] || TOAST_ICONS.info}</svg>`);
  const body = part('div', 'toast-body');
  if (d.title) body.appendChild(part('div', 'toast-title', d.title));
  if (d.text) body.appendChild(part('div', 'toast-text', d.text));
  if (d.files.length) {
    const list = part('ul', 'toast-files');
    for (const file of d.files.slice(0, MAX_TOAST_FILES)) {
      const item = part('li', '');
      const cut = file.lastIndexOf('/') + 1;
      if (cut) item.appendChild(part('span', 'toast-dir', file.slice(0, cut)));
      item.appendChild(document.createTextNode(file.slice(cut)));
      list.appendChild(item);
    }
    if (d.files.length > MAX_TOAST_FILES) list.appendChild(part('li', 'toast-more', `and ${d.files.length - MAX_TOAST_FILES} more`));
    body.appendChild(list);
  }
  if (d.hint) body.appendChild(part('div', 'toast-hint', d.hint));
  el.appendChild(body);
  if (type === 'error') {
    const close = part('button', 'toast-close', '✕');
    close.type = 'button';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => el.classList.add('hidden'));
    el.appendChild(close);
  }
  const hideIn = (ms) => {
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.add('hidden'), ms);
  };
  if (!el._hover) {
    el._hover = true;
    el.addEventListener('mouseenter', () => clearTimeout(el._timer));
    el.addEventListener('mouseleave', () => hideIn(2500));
  }
  hideIn(type === 'error' ? 8000 + 1000 * Math.min(d.files.length, MAX_TOAST_FILES) : 2500);
}

// -- Utils --

function showLoading() {
  $('#loading').classList.remove('hidden');
}
function hideLoading() {
  $('#loading').classList.add('hidden');
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return d.toLocaleDateString();
  } catch {
    return dateStr;
  }
}

// Start once every script has loaded: init uses functions from vault.js, todo.js and maven.js.
// A pop-out card window is set up by vault.js instead.
if (!CARD_ID) document.addEventListener('DOMContentLoaded', init);
