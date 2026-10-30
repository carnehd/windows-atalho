const {
  app, BrowserWindow, globalShortcut, ipcMain, dialog, Tray, Menu, nativeImage, clipboard, safeStorage, shell, net, Notification,
} = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Store = require('./store');
const { findRepos } = require('./scan');
const GitService = require('./git-service');
const { Vault, usersFromRows } = require('./vault');
const { readTable } = require('./sheet-reader');
const { TodoStore } = require('./todos');
const { MyCommands } = require('./my-commands');
const { RepoGroups } = require('./repo-groups');
const { registerTools } = require('./tools');
const { registerAnalysis } = require('./analysis');
const { registerSearch } = require('./search');
const { registerCardWindows } = require('./card-windows');
const { registerMaven } = require('./maven');
const { registerContainers } = require('./containers');
const { registerTerminal } = require('./terminal');
const { stepBack } = require('./shell');
const { registerSignInWindows } = require('./sign-in-window');
const { registerClipboardHistory } = require('./clipboard-history');
const { createLogsService } = require('./logs-service');
const { createGrafanaBrowser } = require('./grafana-browser');
const { registerLogWatches } = require('./logs-watches');
const { startForegroundWatcher, detectIdeProject, resolveRepo } = require('./ide-detect');

// From source the data lives in the project folder; the packaged exe keeps it in a "data" folder next to the exe
// (the portable exe runs from a temporary folder, so its real location comes from PORTABLE_EXECUTABLE_DIR).
const DATA_DIR = app.isPackaged
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath), 'data')
  : path.join(__dirname, '..', 'data');
const ELECTRON_DIR = path.join(DATA_DIR, 'electron');
fs.mkdirSync(ELECTRON_DIR, { recursive: true });
if (!app.isPackaged) {
  // One-time move of data from the old AppData location. The vault key lives in "Local State", so it moves with vault.dat.
  const oldUserData = app.getPath('userData');
  const migrations = [
    [oldUserData, DATA_DIR, ['git-quick-settings.json', 'git-quick-todos.json', 'vault.dat', 'vault.dat.bak']],
    [oldUserData, ELECTRON_DIR, ['Local State']],
  ];
  for (const [fromDir, toDir, names] of migrations) {
    for (const name of names) {
      const from = path.join(fromDir, name);
      const to = path.join(toDir, name);
      if (!fs.existsSync(to) && fs.existsSync(from)) fs.copyFileSync(from, to);
    }
  }
}
app.setPath('userData', ELECTRON_DIR);

// A second launch only brings the running instance to the front.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow && mainWindow.isVisible()) mainWindow.focus();
  else toggleWindow();
});

const store = new Store('git-quick-settings', DATA_DIR);
const todos = new TodoStore(new Store('git-quick-todos', DATA_DIR));
const myCommands = new MyCommands(new Store('git-quick-commands', DATA_DIR));
const repoGroups = new RepoGroups(store);
let mainWindow = null;
let tray = null;
let dialogOpen = false;
let vault = null;
const MODES = ['git', 'vault', 'logs', 'docker', 'clip', 'todo', 'help', 'tools', 'analysis', 'search'];
let clipHistory = null;
let fgWatcher = null;
let windowMode = MODES.includes(store.get('uiState', {}).mode) ? store.get('uiState', {}).mode : 'git';
let clipboardTimer = null;
let pinned = false;
let maven = null;
let containers = null;
let terminal = null;
// Log explorer: settings and credentials in data/logs-config.json. Requests go through Chromium's network stack,
// so Windows' trusted certificates and proxy settings apply.
// Grafana with browserLogin: a login window like the log-explorer's, and the requests made inside a Grafana page.
const grafanaBrowser = createGrafanaBrowser({ dataDir: DATA_DIR });
const logs = createLogsService({ dataDir: DATA_DIR, fetch: (url, options) => net.fetch(url, options), grafanaBrowser });
let logWatches = null;
let quitting = false;
// An empty string means no shortcut. New features start without one so they do not take keys from other apps.
const DEFAULT_HOTKEYS = { git: 'CommandOrControl+Shift+G', vault: 'Alt+3', logs: '', docker: '', clip: '', todo: 'Alt+2', help: '', tools: '', analysis: '', search: '' };
const HOTKEY_LABELS = { git: 'Git', vault: 'Vault', logs: 'Logs', docker: 'Containers', clip: 'Clipboard', todo: 'Tasks', help: 'Help', tools: 'Tools', analysis: 'Analysis', search: 'Search' };
const hotkeys = { ...DEFAULT_HOTKEYS };
const hotkeyStoreKey = (name) => (name === 'git' ? 'hotkey' : `hotkey${name[0].toUpperCase()}${name.slice(1)}`);
const CLIPBOARD_CLEAR_MS = 30000;

const normPath = (p) => path.resolve(p);
const pathKey = (p) => normPath(p).toLowerCase();

function getRepoList() {
  const raw = store.get('repos', []);
  const seen = new Set();
  const clean = [];
  for (const p of raw) {
    const n = normPath(p);
    const k = n.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      clean.push(n);
    }
  }
  if (clean.length !== raw.length || clean.some((p, i) => p !== raw[i])) store.set('repos', clean);
  return clean;
}

// List entries are either Git repository roots or plain folders added by hand.
const isGitFolder = (p) => fs.existsSync(path.join(p, '.git'));
const isKnownRepo = (p) => getRepoList().some((r) => pathKey(r) === pathKey(String(p)));

async function addFolderToList(folder) {
  const git = new GitService(folder);
  const isRepo = await git.isGitRepo();
  const entry = normPath((isRepo && (await git.getRoot())) || folder);
  const repos = getRepoList();
  const existing = repos.some((r) => pathKey(r) === pathKey(entry));
  if (!existing) store.set('repos', [...repos, entry]);
  return { path: entry, existing, notGit: !isRepo };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function registerHotkey(name, accelerator) {
  try {
    // Every shortcut opens its own page (pressing it again there hides the window). The tray icon reopens where it was left.
    return globalShortcut.register(accelerator, () => toggleWindow(name, name));
  } catch {
    return false;
  }
}

// How a shortcut reads to the user: Cmd and Option on macOS, Ctrl and Win on Windows.
const MODIFIER_LABELS = process.platform === 'darwin'
  ? { CommandOrControl: 'Cmd', Command: 'Cmd', Super: 'Cmd', Meta: 'Cmd', Control: 'Ctrl', Alt: 'Option' }
  : { CommandOrControl: 'Ctrl', Control: 'Ctrl', Super: 'Win', Meta: 'Win' };
const prettyHotkey = (accelerator) => accelerator.split('+').map((part) => MODIFIER_LABELS[part] || part).join('+');

function updateTrayTooltip() {
  if (!tray) return;
  const set = Object.keys(hotkeys).filter((n) => hotkeys[n]);
  tray.setToolTip(`Git Quick (${set.map((n) => `${HOTKEY_LABELS[n]}: ${prettyHotkey(hotkeys[n])}`).join(', ')})`.slice(0, 127));
}

function copySecret(text) {
  if (clipHistory) clipHistory.ignore(text);
  clipboard.writeText(text);
  clearTimeout(clipboardTimer);
  clipboardTimer = setTimeout(() => {
    if (clipboard.readText() === text) clipboard.clear();
  }, CLIPBOARD_CLEAR_MS);
}

// The vault is a plain JSON file in the project's data folder (readable, so it works on any PC).
const PLAIN_CODEC = {
  available: () => true,
  encrypt: (text) => Buffer.from(text, 'utf8'),
  decrypt: (buffer) => buffer.toString('utf8').replace(/^﻿/, ''),
};

function openPlainVault() {
  const jsonFile = path.join(DATA_DIR, 'vault.json');
  const encryptedFile = path.join(DATA_DIR, 'vault.dat');
  if (!fs.existsSync(jsonFile) && fs.existsSync(encryptedFile)) {
    const old = new Vault(encryptedFile, {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (buffer) => safeStorage.decryptString(buffer),
    });
    if (old.loadError) {
      console.error(`Could not convert vault.dat to vault.json: ${old.loadError}`);
    } else {
      const converted = new Vault(jsonFile, PLAIN_CODEC);
      converted.data = old.data;
      converted.save();
    }
  }
  return new Vault(jsonFile, PLAIN_CODEC);
}

function vaultCall(fn) {
  try {
    return fn();
  } catch (e) {
    return { error: e.message };
  }
}

// -- Size of the main window: changed by dragging its edges (it has no frame), remembered across restarts --
const WINDOW_DEFAULT = { width: 1100, height: 660 };
const WINDOW_MIN = { width: 820, height: 520 };
let windowResize = null; // { edge, bounds } while an edge is dragged

function fitWindowSize(size, area) {
  const width = Math.round(Math.min(area.width, Math.max(WINDOW_MIN.width, Number(size && size.width) || WINDOW_DEFAULT.width)));
  const height = Math.round(Math.min(area.height, Math.max(WINDOW_MIN.height, Number(size && size.height) || WINDOW_DEFAULT.height)));
  return { width, height };
}

function savedWindowSize() {
  const { screen } = require('electron');
  return fitWindowSize(store.get('windowSize', WINDOW_DEFAULT), screen.getPrimaryDisplay().workArea);
}

function windowArea() {
  const { screen } = require('electron');
  return screen.getDisplayMatching(mainWindow.getBounds()).workArea;
}

// Text size: the whole page scaled (as a browser's zoom), for every window of the app; remembered.
const ZOOMS = [0.9, 1, 1.1, 1.25];
const savedZoom = () => (ZOOMS.includes(store.get('zoom', 1)) ? store.get('zoom', 1) : 1);

// The ticket prefix (a Jira key such as ABC-): written at the start of a new commit message and after feature/ (or
// fix/...) in a new branch name. None unless it is set in Settings.
const TICKET_PREFIX_BAD = /[\s~^:?*[\\]|\.\.|@\{/;

function setupWindowSizeIPC() {
  ipcMain.handle('ticket-prefix-get', () => String(store.get('ticketPrefix', '') || ''));
  ipcMain.handle('ticket-prefix-set', (_, value) => {
    const prefix = String(value ?? '').trim().slice(0, 30);
    if (TICKET_PREFIX_BAD.test(prefix)) return { error: 'A ticket prefix cannot have spaces, .. or ~ ^ : ? * [ \\' };
    store.set('ticketPrefix', prefix);
    return { prefix };
  });
  ipcMain.handle('ui-zoom-get', () => savedZoom());
  ipcMain.handle('ui-zoom-set', (_, value) => {
    const z = Number(value);
    if (!ZOOMS.includes(z)) return { error: 'Unknown text size' };
    store.set('zoom', z);
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.setZoomFactor(z);
    });
    return { zoom: z };
  });
  ipcMain.handle('win-size-get', () => ({ ...(mainWindow ? mainWindow.getBounds() : savedWindowSize()), defaults: WINDOW_DEFAULT }));
  ipcMain.handle('win-resize-start', (_, edge) => {
    if (!mainWindow || !/^(n|s|e|w|ne|nw|se|sw)$/.test(String(edge))) return false;
    windowResize = { edge: String(edge), bounds: mainWindow.getBounds() };
    return true;
  });
  // dx, dy: how far the pointer moved since the drag started, in screen points
  ipcMain.on('win-resize-move', (_, dx, dy) => {
    if (!windowResize || !mainWindow) return;
    const { edge, bounds: b } = windowResize;
    const area = windowArea();
    let width = b.width + (edge.includes('e') ? dx : edge.includes('w') ? -dx : 0);
    let height = b.height + (edge.includes('s') ? dy : edge.includes('n') ? -dy : 0);
    ({ width, height } = fitWindowSize({ width, height }, area));
    const x = edge.includes('w') ? b.x + b.width - width : b.x;
    const y = edge.includes('n') ? b.y + b.height - height : b.y;
    mainWindow.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  });
  ipcMain.handle('win-resize-end', () => {
    windowResize = null;
    if (!mainWindow) return null;
    const { width, height } = mainWindow.getBounds();
    store.set('windowSize', { width, height });
    return { width, height };
  });
  ipcMain.handle('win-size-reset', () => {
    store.set('windowSize', WINDOW_DEFAULT);
    if (!mainWindow) return WINDOW_DEFAULT;
    const area = windowArea();
    const size = fitWindowSize(WINDOW_DEFAULT, area);
    mainWindow.setBounds({ x: Math.round(area.x + (area.width - size.width) / 2), y: Math.round(area.y + (area.height - size.height) / 2), ...size });
    return size;
  });
}

function createWindow() {
  const size = savedWindowSize();
  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    frame: false,
    resizable: false,
    transparent: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => mainWindow.webContents.setZoomFactor(savedZoom()));

  mainWindow.on('blur', () => {
    if (dialogOpen || pinned) return;
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
    }
  });
}

// A folder or file in the app the system opens it with, in front of this window. Returns Electron's error text.
async function openPath(target) {
  const back = stepBack();
  const error = await shell.openPath(target);
  if (error) back();
  return error;
}

// A file shown selected in Finder / Explorer, in front of this window.
function revealPath(target) {
  stepBack();
  shell.showItemInFolder(target);
}

async function withDialog(fn) {
  dialogOpen = true;
  try {
    return await fn();
  } finally {
    dialogOpen = false;
    if (mainWindow && mainWindow.isVisible()) mainWindow.focus();
  }
}

// Shows the window on the Logs page (unlike toggleWindow it never hides it).
function showLogsPage() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    windowMode = 'logs';
    mainWindow.webContents.send('window-shown', 'logs', null);
    mainWindow.focus();
  } else {
    toggleWindow('logs');
  }
}

function showLogsWatch(watchId) {
  if (!mainWindow) return;
  showLogsPage();
  mainWindow.webContents.send('logs-open-watch', watchId);
}

function notifyWatch(watch, found) {
  // The tab shows a count anyway; the notification is for when the window is not in front.
  if (!Notification.isSupported() || (mainWindow && mainWindow.isVisible() && mainWindow.isFocused())) return;
  const n = new Notification({
    title: watch.label ? `Logs watch: ${watch.label}` : 'Logs watch',
    body: `${found} new log${found === 1 ? '' : 's'} match "${watch.query}"${watch.env ? ` in ${watch.env}` : ''}`,
    silent: false,
  });
  n.on('click', () => showLogsWatch(watch.id));
  n.show();
}

// When a shortcut is pressed while IntelliJ is in front, find the repo of its open project.
function ideContext(source) {
  if (!source || !fgWatcher) return null;
  try {
    const project = detectIdeProject(fgWatcher.last());
    if (!project) return null;
    return { repo: resolveRepo(project, getRepoList()), projectName: project.name, projectPath: project.path };
  } catch {
    return null;
  }
}

function toggleWindow(requestedMode, source) {
  if (!mainWindow) return;
  let mode = requestedMode || windowMode;
  const visible = mainWindow.isVisible();
  if (visible && mode === windowMode && !(pinned && !mainWindow.isFocused())) {
    mainWindow.hide();
    return;
  }
  const ide = ideContext(source);
  if (ide && ide.repo && source === 'git') mode = 'git';
  windowMode = mode;
  if (visible) {
    mainWindow.webContents.send('window-shown', mode, ide);
    mainWindow.focus();
  } else {
    const { screen } = require('electron');
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x, y, width, height } = display.workArea;
    const winBounds = fitWindowSize(mainWindow.getBounds(), display.workArea);
    mainWindow.setBounds({
      x: Math.round(x + (width - winBounds.width) / 2),
      y: Math.round(y + (height - winBounds.height) / 2),
      ...winBounds,
    });
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('window-shown', mode, ide);
  }
}

// The tray icon: .ico on Windows, which holds every size the taskbar may ask for at any display scaling;
// PNG elsewhere (tray@2x.png next to it is used on high-resolution screens).
function trayIcon() {
  const files = process.platform === 'win32' ? ['tray.ico', 'tray.png'] : ['tray.png'];
  for (const name of files) {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', name));
    if (!icon.isEmpty()) return icon;
    console.error(`Tray icon could not be loaded from assets/${name}`);
  }
  return nativeImage.createEmpty();
}

function createTray() {
  const icon = trayIcon();
  tray = new Tray(icon);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Git', click: () => toggleWindow('git') },
      { label: 'Vault', click: () => toggleWindow('vault') },
      { label: 'Tasks', click: () => toggleWindow('todo') },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', () => toggleWindow());
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  for (const name of Object.keys(DEFAULT_HOTKEYS)) {
    hotkeys[name] = store.get(hotkeyStoreKey(name), DEFAULT_HOTKEYS[name]);
    if (hotkeys[name] && !registerHotkey(name, hotkeys[name])) {
      hotkeys[name] = DEFAULT_HOTKEYS[name];
      if (hotkeys[name] && !registerHotkey(name, hotkeys[name])) hotkeys[name] = '';
    }
  }
  updateTrayTooltip();

  vault = openPlainVault();

  fgWatcher = startForegroundWatcher((pid) => app.getAppMetrics().some((m) => m.pid === pid));
  clipHistory = registerClipboardHistory({
    file: path.join(DATA_DIR, 'clipboard-history.json'),
    getWindow: () => mainWindow,
  });
  containers = registerContainers({ getWindow: () => mainWindow });
  registerTools({ copySecret });
  const listNamedRepos = () => {
    const names = store.get('repoNames', {});
    return getRepoList().map((p) => ({ path: p, name: names[pathKey(p)] || path.basename(p) }));
  };
  registerAnalysis({ listRepos: listNamedRepos, isKnownRepo, openPath });
  registerSearch({ listRepos: listNamedRepos, isKnownRepo, openPath, revealPath });
  terminal = registerTerminal({ isKnownRepo, getWindow: () => mainWindow });
  maven = registerMaven({
    isKnownRepo,
    getWindow: () => mainWindow,
    loadPorts: (repoPath) => store.get('mavenPorts', {})[pathKey(String(repoPath))],
    savePorts: (repoPath, ports) => store.set('mavenPorts', { ...store.get('mavenPorts', {}), [pathKey(String(repoPath))]: ports }),
    // the folder inside the repository the Maven commands run in ('' or missing: its root)
    loadDir: (repoPath) => store.get('mavenDirs', {})[pathKey(String(repoPath))],
    saveDir: (repoPath, rel) => {
      const dirs = { ...store.get('mavenDirs', {}) };
      if (rel) dirs[pathKey(String(repoPath))] = rel;
      else delete dirs[pathKey(String(repoPath))];
      store.set('mavenDirs', dirs);
    },
    // macros are for every repository
    loadMacros: () => store.get('mavenMacros', []),
    saveMacros: (list) => store.set('mavenMacros', list),
  });

  logWatches = registerLogWatches({
    logs,
    store,
    notify: notifyWatch,
    onChange: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('logs-watches-changed');
    },
  });
  logWatches.start();

  registerCardWindows({
    preload: path.join(__dirname, 'preload.js'),
    page: path.join(__dirname, 'renderer', 'index.html'),
  });

  setupIPC();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (fgWatcher) fgWatcher.stop();
  if (logWatches) logWatches.stop();
  grafanaBrowser.close();
  if (containers) containers.stop();
});

app.on('before-quit', (e) => {
  if (quitting || !maven) return;
  e.preventDefault();
  quitting = true;
  Promise.all([maven.stopAll(), terminal ? terminal.stop() : null]).finally(() => app.quit());
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

function setupIPC() {
  setupWindowSizeIPC();
  ipcMain.handle('get-repos', () => {
    const names = store.get('repoNames', {});
    const favorites = new Set(store.get('repoFavorites', []));
    const groupOf = repoGroups.members();
    return getRepoList().map((p) => ({
      path: p,
      name: names[pathKey(p)] || '',
      favorite: favorites.has(pathKey(p)),
      group: groupOf[pathKey(p)] || '',
      isGit: isGitFolder(p),
    }));
  });

  // Groups of the list: create, rename, delete, order, fold, and the group of a repository.
  ipcMain.handle('repo-groups-get', () => vaultCall(() => ({ groups: repoGroups.list() })));
  ipcMain.handle('repo-group-create', (_, name) => vaultCall(() => repoGroups.create(name)));
  ipcMain.handle('repo-group-rename', (_, id, name) => vaultCall(() => repoGroups.rename(String(id || ''), name)));
  ipcMain.handle('repo-group-delete', (_, id) => vaultCall(() => repoGroups.delete(String(id || ''))));
  ipcMain.handle('repo-group-move', (_, id, delta) => vaultCall(() => repoGroups.move(String(id || ''), Number(delta) || 0)));
  ipcMain.handle('repo-group-collapse', (_, id, collapsed) => vaultCall(() => repoGroups.setCollapsed(String(id || ''), collapsed === true)));
  ipcMain.handle('repo-group-assign', (_, repoPath, id) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return vaultCall(() => repoGroups.assign(pathKey(String(repoPath)), id ? String(id) : null));
  });

  ipcMain.handle('toggle-favorite-repo', (_, repoPath) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    const k = pathKey(String(repoPath));
    const favorites = new Set(store.get('repoFavorites', []));
    if (favorites.has(k)) favorites.delete(k);
    else favorites.add(k);
    store.set('repoFavorites', [...favorites]);
    return { favorite: favorites.has(k) };
  });

  ipcMain.handle('rename-repo', (_, repoPath, name) => {
    const names = { ...store.get('repoNames', {}) };
    const trimmed = String(name || '').trim().slice(0, 60);
    if (trimmed) names[pathKey(repoPath)] = trimmed;
    else delete names[pathKey(repoPath)];
    store.set('repoNames', names);
    return trimmed;
  });

  ipcMain.handle('open-folder', async (_, repoPath) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    if (!fs.existsSync(repoPath)) return { error: 'Folder not found' };
    const error = await openPath(repoPath);
    return error ? { error } : { success: true };
  });

  ipcMain.handle('get-repo-summaries', async () => {
    const repos = getRepoList();
    const summary = async (p) => {
      if (!fs.existsSync(p)) return { error: 'Folder not found' };
      if (!isGitFolder(p)) return { notGit: true };
      return new GitService(p).getSummary();
    };
    const list = await mapLimit(repos, 4, async (p) => [p, await summary(p)]);
    return Object.fromEntries(list);
  });

  ipcMain.handle('add-repo', async () => {
    const result = await withDialog(() =>
      dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select a Git repository or any folder',
      })
    );
    if (result.canceled || result.filePaths.length === 0) return null;
    return addFolderToList(result.filePaths[0]);
  });

  ipcMain.handle('add-repo-path', async (_, folder) => {
    if (typeof folder !== 'string' || !folder || !fs.existsSync(folder)) return { error: 'Folder not found' };
    return addFolderToList(folder);
  });

  ipcMain.handle('pick-folder', async () => {
    const result = await withDialog(() =>
      dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select a folder that contains Git repositories',
      })
    );
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  // Adds every Git repository under a folder that is not in the list yet.
  const addReposUnder = async (rootPath) => {
    const { repos: scanned, truncated } = await findRepos(rootPath);
    const found = [...new Map(scanned.map((r) => [pathKey(r), normPath(r)])).values()];
    const repos = getRepoList();
    const known = new Set(repos.map(pathKey));
    const added = found.filter((r) => !known.has(pathKey(r)));
    if (added.length > 0) store.set('repos', [...repos, ...added]);
    return { found: found.length, added: added.length, newRepos: added, first: added[0] || found[0] || null, truncated };
  };

  ipcMain.handle('scan-repos', async (_, rootPath) => {
    try {
      return await addReposUnder(rootPath);
    } catch (e) {
      return { error: e.message };
    }
  });

  // The folder that holds all the microservices: Refresh looks in it for repositories that are not in the list yet.
  const reposRoot = () => {
    const root = store.get('reposRoot', '');
    return root && fs.existsSync(root) ? root : '';
  };
  ipcMain.handle('get-repos-root', () => ({ path: store.get('reposRoot', ''), exists: Boolean(reposRoot()) }));

  ipcMain.handle('set-repos-root', (_, folder) => {
    if (folder === null || folder === '') {
      store.set('reposRoot', '');
      return { path: '' };
    }
    const dir = typeof folder === 'string' ? normPath(folder) : '';
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: 'Folder not found' };
    store.set('reposRoot', dir);
    return { path: dir };
  });

  ipcMain.handle('refresh-repos', async () => {
    const root = reposRoot();
    if (!root) return { needsRoot: true, path: store.get('reposRoot', '') };
    try {
      return { root, ...(await addReposUnder(root)) };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('open-repos-root', async () => {
    const root = reposRoot();
    if (!root) return { error: 'Folder not found' };
    const error = await openPath(root);
    return error ? { error } : { success: true };
  });

  ipcMain.handle('remove-repo', (_, repoPath) => {
    const key = pathKey(repoPath);
    store.set('repos', getRepoList().filter((r) => pathKey(r) !== key));
    const names = { ...store.get('repoNames', {}) };
    delete names[key];
    store.set('repoNames', names);
    store.set('repoFavorites', store.get('repoFavorites', []).filter((k) => k !== key));
    repoGroups.forget(key);
    const targets = { ...store.get('pushTargets', {}) };
    delete targets[key];
    store.set('pushTargets', targets);
    const mavenPorts = { ...store.get('mavenPorts', {}) };
    delete mavenPorts[key];
    store.set('mavenPorts', mavenPorts);
    const mavenDirs = { ...store.get('mavenDirs', {}) };
    delete mavenDirs[key];
    store.set('mavenDirs', mavenDirs);
    return true;
  });

  ipcMain.handle('get-status', async (_, repoPath) => {
    const git = new GitService(repoPath);
    return git.getStatus();
  });

  ipcMain.handle('get-branches', async (_, repoPath) => {
    const git = new GitService(repoPath);
    return git.getBranches();
  });

  ipcMain.handle('checkout-branch', async (_, repoPath, branch) => {
    const git = new GitService(repoPath);
    return git.checkout(branch);
  });

  ipcMain.handle('create-branch', async (_, repoPath, branchName, base) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return new GitService(repoPath).createBranchFrom(branchName, typeof base === 'string' ? base : 'main');
  });

  ipcMain.handle('pull', async (_, repoPath) => {
    const git = new GitService(repoPath);
    return git.pull();
  });

  // A pull of several repositories, one after the other. Each result goes to the window as soon as it is known; one
  // that fails is reported and the next one goes on. Stop lets the current one end and leaves the rest as they are.
  let pullMany = null;
  ipcMain.handle('pull-many-start', (_, paths) => {
    if (pullMany) return { error: 'A pull of several repositories is already running' };
    const seen = new Set();
    const list = (Array.isArray(paths) ? paths : [])
      .map(String)
      .filter((p) => isKnownRepo(p) && !seen.has(pathKey(p)) && seen.add(pathKey(p)))
      .map(normPath);
    if (list.length === 0) return { error: 'Choose at least one repository' };
    const run = { stop: false };
    pullMany = run;
    const send = (msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pull-many-progress', msg);
    };
    (async () => {
      for (const [index, p] of list.entries()) {
        if (run.stop) {
          send({ index, path: p, state: 'stopped', message: 'Not pulled: stopped before it' });
          continue;
        }
        send({ index, path: p, state: 'running' });
        let result;
        if (!fs.existsSync(p)) result = { state: 'skipped', message: 'Folder not found' };
        else if (!isGitFolder(p)) result = { state: 'skipped', message: 'Not a Git repository' };
        else {
          try {
            result = await new GitService(p).syncPull();
          } catch (e) {
            result = { state: 'error', message: e.message };
          }
        }
        send({ index, path: p, ...result });
      }
      pullMany = null;
      send({ done: true, stopped: run.stop });
    })();
    return { started: true, paths: list };
  });
  // Fetch of the repositories chosen (of the list), four at a time; each result says how it went.
  let fetchingMany = false;
  ipcMain.handle('fetch-many', async (_, paths) => {
    if (fetchingMany) return { error: 'A fetch of several repositories is already running' };
    const seen = new Set();
    const list = (Array.isArray(paths) ? paths : [])
      .map(String)
      .filter((p) => isKnownRepo(p) && !seen.has(pathKey(p)) && seen.add(pathKey(p)))
      .map(normPath)
      .filter((p) => fs.existsSync(p) && isGitFolder(p));
    if (list.length === 0) return { error: 'Choose at least one repository' };
    fetchingMany = true;
    try {
      const results = await mapLimit(list, 4, async (p) => {
        const r = await new GitService(p).fetchAllQuiet();
        return r.error ? { path: p, ok: false, error: r.error } : { path: p, ok: true };
      });
      return { results };
    } finally {
      fetchingMany = false;
    }
  });

  ipcMain.handle('pull-many-stop', () => {
    if (pullMany) pullMany.stop = true;
    return Boolean(pullMany);
  });

  ipcMain.handle('commit', async (_, repoPath, message, files) => {
    const git = new GitService(repoPath);
    return git.commit(message, files);
  });

  // The chosen push destination is remembered per repository; an empty value means the default (upstream or same name).
  ipcMain.handle('get-push-target', (_, repoPath) => store.get('pushTargets', {})[pathKey(String(repoPath))] || '');

  ipcMain.handle('set-push-target', (_, repoPath, target) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    const value = typeof target === 'string' ? target.trim().slice(0, 200) : '';
    const targets = { ...store.get('pushTargets', {}) };
    const k = pathKey(repoPath);
    if (value) targets[k] = value;
    else delete targets[k];
    store.set('pushTargets', targets);
    return { target: value };
  });

  ipcMain.handle('get-unpushed', async (_, repoPath) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    const remembered = store.get('pushTargets', {})[pathKey(repoPath)] || '';
    return new GitService(repoPath).getUnpushed(remembered);
  });

  ipcMain.handle('push', async (_, repoPath, target) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    const remembered = store.get('pushTargets', {})[pathKey(repoPath)] || '';
    return new GitService(repoPath).pushTo(typeof target === 'string' && target.trim() ? target : remembered);
  });

  ipcMain.handle('stage-all', async (_, repoPath) => {
    const git = new GitService(repoPath);
    return git.stageAll();
  });

  ipcMain.handle('stage-file', async (_, repoPath, file) => {
    const git = new GitService(repoPath);
    return git.stageFile(file);
  });

  ipcMain.handle('unstage-file', async (_, repoPath, file) => {
    const git = new GitService(repoPath);
    return git.unstageFile(file);
  });

  // Moving files to a folder Git ignores; the folder name is remembered per repository.
  ipcMain.handle('get-park-folder', (_, repoPath) => store.get('parkFolders', {})[pathKey(String(repoPath))] || GitService.PARK_DEFAULT_FOLDER);

  ipcMain.handle('park-files', async (_, repoPath, entries, folder) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    const result = await new GitService(repoPath).parkFiles(entries, folder);
    if (result.success) store.set('parkFolders', { ...store.get('parkFolders', {}), [pathKey(repoPath)]: result.folder });
    return result;
  });

  // The Ignored tab: files kept in folders this app made Git ignore.
  ipcMain.handle('parked-list', async (_, repoPath) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return new GitService(repoPath).listParked();
  });

  ipcMain.handle('parked-diff', async (_, repoPath, folder, file, options) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return new GitService(repoPath).parkedDiff(folder, file, { full: Boolean(options && options.full) });
  });

  ipcMain.handle('parked-restore', async (_, repoPath, folder, file) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return new GitService(repoPath).restoreParked(folder, file);
  });

  ipcMain.handle('parked-open-folder', async (_, repoPath, folder) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    const folders = await new GitService(repoPath).parkedFolders();
    if (!folders.includes(String(folder))) return { error: 'Unknown ignored folder' };
    const dir = path.join(repoPath, String(folder));
    if (!fs.existsSync(dir)) return { error: 'Folder not found' };
    const error = await openPath(dir);
    return error ? { error } : { success: true };
  });

  ipcMain.handle('revert-files', async (_, repoPath, files) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return new GitService(repoPath).revertFiles(Array.isArray(files) ? files : []);
  });

  ipcMain.handle('branch-graph', async (_, repoPath, ref) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return new GitService(repoPath).getBranchGraph(ref);
  });

  ipcMain.handle('merge-branch', async (_, repoPath, ref) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return new GitService(repoPath).mergeBranch(ref);
  });

  ipcMain.handle('branch-only-commits', async (_, repoPath, name) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return new GitService(repoPath).branchOnlyCommits(name);
  });

  ipcMain.handle('create-branch-at', async (_, repoPath, name, ref) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return new GitService(repoPath).createBranchAt(name, ref);
  });

  // Plain Git: change, undo or revert commits, a page of the log, tags, rename and delete branches, init and clone.
  const repoCall = (fn) => async (_, repoPath, ...args) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return fn(new GitService(repoPath), ...args);
  };
  ipcMain.handle('last-commit', repoCall((g) => g.lastCommit()));
  ipcMain.handle('amend-commit', repoCall((g, message, files) => g.amendCommit(message, Array.isArray(files) ? files : [])));
  ipcMain.handle('undo-commit', repoCall((g) => g.undoLastCommit()));
  ipcMain.handle('revert-commit', repoCall((g, hash) => g.revertCommit(hash)));
  ipcMain.handle('abort-operation', repoCall((g) => g.abortOperation()));
  ipcMain.handle('log-page', repoCall((g, options) => g.getLogPage(options && typeof options === 'object' ? options : {})));
  ipcMain.handle('commit-file-diff', repoCall((g, hash, file, from, options) => g.getCommitFileDiff(hash, file, from, { full: Boolean(options && options.full) })));
  ipcMain.handle('compare-refs', repoCall((g) => g.compareRefs()));
  ipcMain.handle('compare-commits', repoCall((g, side, count) => g.compareCommits(side, count)));
  ipcMain.handle('compare', repoCall((g, from, to, options) => g.compare(from, to, { mergeBase: Boolean(options && options.mergeBase) })));
  ipcMain.handle('list-tags', repoCall((g) => g.listTags()));
  ipcMain.handle('checkout-tag', repoCall((g, name) => g.checkoutTag(name)));
  ipcMain.handle('compare-file-diff', repoCall((g, from, to, file, oldFile, options) => g.compareFileDiff(from, to, file, oldFile, { full: Boolean(options && options.full) })));
  ipcMain.handle('suggest-tag', repoCall((g) => g.suggestTag()));
  ipcMain.handle('create-tag', repoCall((g, name, hash, push) => g.createTag(name, hash, Boolean(push))));
  ipcMain.handle('push-tag', repoCall((g, name) => g.pushTag(name)));
  ipcMain.handle('tag-on-origin', repoCall((g, name) => g.tagOnOrigin(name)));
  ipcMain.handle('delete-tag', repoCall((g, name, alsoOrigin) => g.deleteTag(name, Boolean(alsoOrigin))));
  ipcMain.handle('remote-only-commits', repoCall((g, ref) => g.remoteOnlyCommits(ref)));
  ipcMain.handle('delete-remote-branch', repoCall((g, ref) => g.deleteRemoteBranch(ref)));
  ipcMain.handle('init-repo', repoCall((g) => g.initRepo()));

  // A renamed branch no longer goes to a push destination remembered under its old name.
  ipcMain.handle('rename-branch', repoCall(async (g, oldName, newName) => {
    const result = await g.renameBranch(oldName, newName);
    const k = pathKey(g.repoPath);
    const targets = { ...store.get('pushTargets', {}) };
    if (result.success && targets[k] === oldName) {
      delete targets[k];
      store.set('pushTargets', targets);
    }
    return result;
  }));

  // Clones go into a folder chosen once and remembered (the home folder at first).
  ipcMain.handle('get-clone-parent', () => {
    const saved = store.get('cloneParent', '');
    return saved && fs.existsSync(saved) ? saved : os.homedir();
  });

  ipcMain.handle('pick-clone-parent', async () => {
    const result = await withDialog(() =>
      dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose the folder to put the clone in',
      })
    );
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle('clone-repo', async (_, url, parent, name) => {
    try {
      const target = await GitService.cloneRepo(url, parent, name);
      store.set('cloneParent', parent);
      return addFolderToList(target);
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('diff-side-read', async (_, repoPath, side) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return new GitService(repoPath).readDiffSide(side);
  });

  ipcMain.handle('diff-side-write', async (_, repoPath, side, text) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return new GitService(repoPath).writeDiffSide(side, text);
  });

  ipcMain.handle('file-diff', async (_, repoPath, file, from, options) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return new GitService(repoPath).getFileDiff(file, from, { full: Boolean(options && options.full) });
  });

  ipcMain.handle('get-log', async (_, repoPath, count) => {
    const git = new GitService(repoPath);
    return git.getLog(count);
  });

  ipcMain.handle('stash-list', (_, p) => new GitService(p).stashList());
  ipcMain.handle('stash-push', (_, p, message, files, includeUntracked) =>
    new GitService(p).stashPush(message, files, includeUntracked)
  );
  ipcMain.handle('stash-apply', (_, p, index) => new GitService(p).stashApply(index));
  ipcMain.handle('stash-pop', (_, p, index) => new GitService(p).stashPop(index));
  ipcMain.handle('stash-drop', (_, p, index) => new GitService(p).stashDrop(index));
  ipcMain.handle('stash-files', (_, p, index) => new GitService(p).stashFiles(index));

  ipcMain.handle('get-theme', () => store.get('theme', 'light'));

  ipcMain.handle('set-theme', (_, theme) => {
    if (theme !== 'light' && theme !== 'dark') return false;
    store.set('theme', theme);
    return true;
  });

  ipcMain.handle('get-hotkeys', () =>
    Object.fromEntries(
      Object.keys(DEFAULT_HOTKEYS).map((name) => [
        name,
        { hotkey: hotkeys[name], defaultHotkey: DEFAULT_HOTKEYS[name], label: HOTKEY_LABELS[name] },
      ])
    )
  );

  ipcMain.handle('set-hotkey', (_, name, accelerator) => {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_HOTKEYS, name)) return { error: 'Unknown shortcut' };
    if (typeof accelerator !== 'string' || accelerator.length > 60) return { error: 'Invalid shortcut' };
    if (accelerator === hotkeys[name]) return { success: true, hotkey: hotkeys[name] };
    const clash = accelerator && Object.keys(hotkeys).find((n) => n !== name && hotkeys[n].toLowerCase() === accelerator.toLowerCase());
    if (clash) return { error: `Already used by the ${HOTKEY_LABELS[clash]} shortcut` };
    if (hotkeys[name]) globalShortcut.unregister(hotkeys[name]);
    if (accelerator && !registerHotkey(name, accelerator)) {
      if (hotkeys[name]) registerHotkey(name, hotkeys[name]);
      return { error: 'Shortcut is invalid or already used by another application' };
    }
    hotkeys[name] = accelerator;
    store.set(hotkeyStoreKey(name), accelerator);
    updateTrayTooltip();
    return { success: true, hotkey: accelerator };
  });

  ipcMain.handle('my-commands-get', () => vaultCall(() => ({ commands: myCommands.list() })));
  ipcMain.handle('my-commands-save', (_, entry) => vaultCall(() => myCommands.save(entry && typeof entry === 'object' ? entry : {})));
  ipcMain.handle('my-commands-delete', (_, id) => vaultCall(() => myCommands.delete(String(id || ''))));
  ipcMain.handle('todo-get', () => vaultCall(() => todos.view()));
  ipcMain.handle('todo-save', (_, task) => vaultCall(() => todos.saveTask(task || {})));
  ipcMain.handle('todo-delete', (_, id) => vaultCall(() => todos.deleteTask(id)));
  ipcMain.handle('todo-move', (_, id, status) => vaultCall(() => todos.moveTask(id, status)));

  ipcMain.handle('vault-get', () => vaultCall(() => vault.view()));
  ipcMain.handle('vault-save-env', (_, env) => vaultCall(() => vault.saveEnv(env || {})));
  ipcMain.handle('vault-delete-env', (_, id) => vaultCall(() => vault.deleteEnv(id)));
  ipcMain.handle('vault-save-item', (_, item) => vaultCall(() => vault.saveItem(item || {})));
  ipcMain.handle('vault-delete-item', (_, id) => vaultCall(() => vault.deleteItem(id)));
  ipcMain.handle('vault-delete-items', (_, ids) => vaultCall(() => vault.deleteItems(ids)));
  ipcMain.handle('vault-set-favorite', (_, id, on) => vaultCall(() => vault.setFavorite(id, on === true)));
  // Import of users from a sheet: the file is read here and kept until the import is confirmed, so its passwords never
  // go to the window, which gets the rows to show with "has a password" only.
  let pendingImport = null;
  ipcMain.handle('vault-import-pick', async () => {
    const result = await withDialog(() =>
      dialog.showOpenDialog(mainWindow, {
        title: 'Import users',
        properties: ['openFile'],
        filters: [{ name: 'Excel or CSV', extensions: ['xlsx', 'csv'] }],
      })
    );
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return vaultCall(() => {
      const file = result.filePaths[0];
      const { header, attributes, users, skipped } = usersFromRows(readTable(file));
      if (!users.length) throw new Error('No users in it: the first three columns must be the name, the username and the password');
      pendingImport = { token: crypto.randomUUID(), users };
      return {
        token: pendingImport.token,
        file: path.basename(file),
        header,
        attributes,
        skipped,
        users: users.map(({ password, ...u }) => ({ ...u, hasPassword: Boolean(password) })),
      };
    });
  });
  ipcMain.handle('vault-import-users', (_, token, envId) =>
    vaultCall(() => {
      if (!pendingImport || pendingImport.token !== token) throw new Error('Choose the file again');
      const { users } = pendingImport;
      pendingImport = null;
      return vault.importUsers(typeof envId === 'string' ? envId : '', users);
    })
  );
  const signIn = registerSignInWindows({ stepBack });
  ipcMain.handle('vault-sign-in', (_, id) => vaultCall(() => signIn.open(String(id || ''), vault.signInFor(id))));
  ipcMain.handle('vault-get-secret', (_, id) => vaultCall(() => ({ password: vault.getSecret(id) })));
  ipcMain.handle('vault-copy-secret', (_, id) =>
    vaultCall(() => {
      copySecret(vault.getSecret(id));
      return { success: true, clearsInSeconds: CLIPBOARD_CLEAR_MS / 1000 };
    })
  );
  // Text that contains a password: kept out of the clipboard history and cleared after 30 seconds.
  ipcMain.handle('vault-copy-sensitive', (_, text) => {
    if (typeof text !== 'string' || !text || text.length > 20000) return { error: 'Nothing to copy' };
    copySecret(text);
    return { success: true, clearsInSeconds: CLIPBOARD_CLEAR_MS / 1000 };
  });

  ipcMain.handle('vault-copy-text', (_, text) => {
    if (typeof text !== 'string' || !text || text.length > 20000) return { error: 'Nothing to copy' };
    clipboard.writeText(text);
    return { success: true };
  });

  // Only URL-looking text leaves the main process, so other clipboard contents (like passwords) never reach the page.
  ipcMain.handle('vault-clipboard-url', () => {
    const text = clipboard.readText().trim();
    return text.length <= 1000 && /^(https?:\/\/|www\.)[^\s]+$/i.test(text) ? text : null;
  });

  ipcMain.handle('vault-open-link', async (_, url) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      return { error: 'Invalid link' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: 'Only http and https links can be opened' };
    const back = stepBack();
    try {
      await shell.openExternal(parsed.href);
      return { success: true, host: parsed.host };
    } catch (e) {
      back();
      return { error: `The browser could not open the link: ${e.message}` };
    }
  });

  ipcMain.handle('confirm', async (_, message) => {
    const result = await withDialog(() =>
      dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Cancel', 'OK'],
        defaultId: 0,
        cancelId: 0,
        message,
      })
    );
    return result.response === 1;
  });

  ipcMain.handle('get-ui-state', () => store.get('uiState', {}));

  // -- Logs --
  const logsCall = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      return { error: e.message, ...(e.code && { code: e.code }) };
    }
  };
  ipcMain.handle('logs-info', () => logsCall(() => logs.info()));
  ipcMain.handle('logs-search', (_, params) => logsCall(() => logs.search(params || {})));
  ipcMain.handle('logs-services', (_, params) => logsCall(() => logs.services(params || {})));
  ipcMain.handle('logs-error-types', (_, params) => logsCall(() => logs.errorTypes(params || {})));
  ipcMain.handle('logs-trace', (_, params) => logsCall(() => logs.trace(params || {})));
  ipcMain.handle('logs-watches', () => logsCall(() => logWatches.state()));
  ipcMain.handle('logs-watch-add', (_, query, env, origin) => logsCall(() => logWatches.add(query, env, origin)));
  ipcMain.handle('logs-watch-remove', (_, id) => logsCall(() => logWatches.remove(String(id))));
  ipcMain.handle('logs-watch-seen', (_, id) => logsCall(() => logWatches.seen(String(id))));
  ipcMain.handle('logs-watch-rename', (_, id, label) => logsCall(() => logWatches.rename(String(id), label)));
  ipcMain.handle('logs-live', (_, on) => logsCall(() => logWatches.setLive(Boolean(on))));
  ipcMain.handle('logs-generate', () => logsCall(() => logs.generate()));
  ipcMain.handle('logs-grafana-status', () => logsCall(async () => {
    const viaCookie = await logs.grafanaCookieStatus(); // a pasted cookie is used first
    if (viaCookie) return viaCookie;
    const base = logs.grafanaLoginBase();
    return base ? { ...(await grafanaBrowser.status(base)), via: 'window' } : { loggedIn: false, notUsed: true };
  }));
  ipcMain.handle('logs-grafana-cookie', (_, value) => logsCall(() => logs.grafanaCookieLogin(value)));
  ipcMain.handle('logs-grafana-login', () => logsCall(async () => {
    const base = logs.useBrowserLogin(); // turns browserLogin on when it is off
    try {
      const user = await grafanaBrowser.login(base, { interactive: true });
      // a pasted cookie would still come first: the window's session takes over
      if (await logs.grafanaCookieStatus()) logs.clearGrafanaCookie();
      return { success: true, user };
    } finally {
      showLogsPage(); // the app window hides when the login window takes the focus
    }
  }));
  ipcMain.handle('logs-grafana-logout', () => logsCall(async () => {
    if (await logs.grafanaCookieStatus()) logs.clearGrafanaCookie();
    // the window's session too, even with browserLogin off now: it would come back when it is turned on again
    await grafanaBrowser.logout();
    return { success: true };
  }));
  ipcMain.handle('logs-open-config', () => logsCall(async () => {
    logs.info(); // creates the file with the defaults when it is missing
    const error = await openPath(logs.configFile);
    return error ? { error } : { success: true, file: logs.configFile };
  }));

  ipcMain.on('save-ui-state', (_, s = {}) => {
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
    const clean = {
      mode: MODES.includes(s.mode) ? s.mode : 'git',
      repo: str(s.repo, 1000),
      gitTab: ['changes', 'push', 'stash', 'ignored', 'log'].includes(s.gitTab) ? s.gitTab : 'changes',
      gitView: s.gitView === 'maven' ? 'maven' : 'git',
      vaultEnv: str(s.vaultEnv, 100),
      vaultFilter: ['all', 'credential', 'link', 'db', 'note'].includes(s.vaultFilter) ? s.vaultFilter : 'all',
      vaultSort: s.vaultSort && ['type', 'added', 'name', 'username', 'url'].includes(s.vaultSort.key) && ['asc', 'desc'].includes(s.vaultSort.dir)
        ? { key: s.vaultSort.key, dir: s.vaultSort.dir }
        : null,
      vaultItem: str(s.vaultItem, 100),
      todoList: str(s.todoList, 100),
      logsQuery: str(s.logsQuery, 2000),
      logsRange: ['15m', '1h', '6h', '24h', '7d', 'custom'].includes(s.logsRange) ? s.logsRange : '1h',
      logsColumns: Array.isArray(s.logsColumns)
        ? s.logsColumns
          .map((c) => (typeof c === 'string' ? { field: c } : c))
          .filter((c) => c && typeof c.field === 'string' && c.field)
          .map((c) => ({ field: c.field.slice(0, 200), ...(typeof c.label === 'string' && c.label && { label: c.label.slice(0, 60) }), ...(typeof c.pattern === 'string' && c.pattern && { pattern: c.pattern.slice(0, 300) }) }))
          .slice(0, 10)
        : [],
      logsEnv: typeof s.logsEnv === 'string' ? s.logsEnv.slice(0, 100) : null,
      logsOrigin: ['openshift', 'gcp', 'both'].includes(s.logsOrigin) ? s.logsOrigin : 'openshift',
      logsColumnsChosen: s.logsColumnsChosen === true,
      logsHidden: Array.isArray(s.logsHidden) ? s.logsHidden.filter((k) => ['time', 'level', 'service', 'message'].includes(k)) : [],
      logsTabLabels: s.logsTabLabels && typeof s.logsTabLabels === 'object' && !Array.isArray(s.logsTabLabels)
        ? Object.fromEntries(Object.entries(s.logsTabLabels).filter(([k, v]) => k.length <= 220 && typeof v === 'string' && v).slice(0, 40).map(([k, v]) => [k, v.slice(0, 60)]))
        : {},
      logsServiceTabs: Array.isArray(s.logsServiceTabs) ? s.logsServiceTabs.filter((n) => typeof n === 'string' && n).map((n) => n.slice(0, 200)).slice(0, 20) : [],
    };
    windowMode = clean.mode;
    if (JSON.stringify(clean) !== JSON.stringify(store.get('uiState', {}))) store.set('uiState', clean);
  });

  ipcMain.handle('get-pinned', () => pinned);

  ipcMain.handle('set-pinned', (_, value) => {
    pinned = Boolean(value);
    return pinned;
  });

  ipcMain.handle('close-window', () => {
    if (mainWindow) mainWindow.hide();
  });

  ipcMain.handle('delete-branch', async (_, repoPath, branch) => {
    const git = new GitService(repoPath);
    return git.deleteBranch(branch);
  });

  ipcMain.handle('fetch', async (_, repoPath) => {
    const git = new GitService(repoPath);
    return git.fetch();
  });
}
