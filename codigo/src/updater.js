// -- Updates of QuickDeck: the latest release on GitHub, its QuickDeck-<version>.zip downloaded into the folder the exe
// runs from, and the QuickDeck-<version>.exe in it taken out next to the zip. The data folder stays as it is: the new
// exe, in the same folder, uses it. Opening the new one closes this one first (two would fight over the global
// shortcuts, and the second would only bring the first forward). The app was called Git Quick before: the names of
// then are still read, and each release also carries its zip as GitQuick-<version>.zip for the copies of Git Quick,
// which look only for that name (LEIA-ME). --
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, ipcMain, net, shell: electronShell } = require('electron');
const { psQuote } = require('./shell');
const { downloadFile, unzip, rename } = require('./download');

const REPO = 'carnehd/windows-atalho';
const IS_WIN = process.platform === 'win32';
const VERSION = /^\d+\.\d+\.\d+$/;
const zipName = (v) => `QuickDeck-${v}.zip`;
const exeName = (v) => `QuickDeck-${v}.exe`;
// the names from when the app was Git Quick
const oldZipNames = (v) => [`GitQuick-${v}.zip`, 'GitQuick.zip'];
const oldExeNames = (v) => [`GitQuick-${v}.exe`, 'GitQuick.exe'];

// a test serves a release from this computer and gives the folder (never in the exe)
const dev = (name) => (app.isPackaged ? '' : process.env[name] || '');
const apiUrl = () => dev('GQ_UPDATE_API') || `https://api.github.com/repos/${REPO}/releases/latest`;
const latestPage = () => dev('GQ_UPDATE_PAGE') || `https://github.com/${REPO}/releases/latest`;

// The folder of the exe (the portable exe runs from a temporary folder: its real one is PORTABLE_EXECUTABLE_DIR).
function appFolder() {
  if (app.isPackaged) return IS_WIN ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath) : null;
  return dev('GQ_UPDATE_DIR') || null;
}
const canOpen = () => app.isPackaged && IS_WIN;

// a newer than b: 1.10.0 after 1.9.3
function isNewer(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

async function fetchWithin(url, options, ms = 20000) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ms);
  try {
    return await net.fetch(url, { ...options, signal: stop.signal, cache: 'no-store' });
  } catch (e) {
    throw new Error(stop.signal.aborted ? 'no answer in 20 seconds' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

// Where an address leads (its redirect), without following it: net.fetch follows it and does not tell where to.
function redirectOf(url, ms = 20000) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'manual', cache: 'no-store' });
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error('no answer in 20 seconds'));
    }, ms);
    const done = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };
    req.on('redirect', (status, method, to) => {
      req.abort();
      done(resolve, to);
    });
    req.on('response', (res) => {
      res.on('data', () => {});
      done(reject, new Error(`it answered ${res.statusCode}`));
    });
    req.on('error', (e) => done(reject, e));
    req.end();
  });
}

// The latest release: its version, notes and zip (QuickDeck-<version>.zip; the Git Quick names in the releases before it).
async function latestRelease() {
  try {
    const res = await fetchWithin(apiUrl(), { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub said ${res.status}`);
    const r = await res.json();
    const version = String(r.tag_name || '').replace(/^v/, '');
    if (!VERSION.test(version)) throw new Error(`the latest release is called ${String(r.tag_name).slice(0, 40)}`);
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const asset = [zipName(version), ...oldZipNames(version)].map((n) => assets.find((a) => a.name === n)).find(Boolean);
    const sha = /^sha256:([0-9a-f]{64})$/i.exec(String((asset && asset.digest) || ''));
    return {
      version,
      date: r.published_at || null,
      notes: String(r.body || '').slice(0, 6000),
      page: r.html_url || `https://github.com/${REPO}/releases/tag/${r.tag_name}`,
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0, sha256: sha ? sha[1] : null } : null,
    };
  } catch (e) {
    // the API can be refused (its limit per hour, a proxy): releases/latest leads to releases/tag/v<version>, and the
    // zip of a release is at releases/download/v<version>/ (no size nor checksum to check it by, then)
    let to = '';
    try {
      to = await redirectOf(latestPage());
    } catch {
      // the API's error says it
    }
    const m = /^(.*\/releases)\/tag\/(v?(\d+\.\d+\.\d+))$/.exec(to);
    if (!m) throw new Error(`Couldn't ask GitHub for the latest version: ${e.message}`);
    const version = m[3];
    return { version, date: null, notes: '', page: to, asset: { name: zipName(version), url: `${m[1]}/download/${m[2]}/${zipName(version)}`, size: 0, sha256: null } };
  }
}

let busy = false;

// What the latest is, and whether it is newer than this one and already in the folder.
async function check() {
  const current = app.getVersion();
  const folder = appFolder();
  if (!folder) return { current, unsupported: true };
  const latest = await latestRelease();
  const exe = path.join(folder, exeName(latest.version));
  return { current, folder, canOpen: canOpen(), latest, newer: isNewer(latest.version, current), have: fs.existsSync(exe) ? exe : null, busy };
}

// The zip of the latest release into the folder, and its exe out of it beside it. progress({ phase: 'download', got,
// total } | { phase: 'unpack' }). What fails leaves no half-written file.
async function download(progress = () => {}) {
  if (busy) throw new Error('The update is being downloaded already');
  const folder = appFolder();
  if (!folder) throw new Error('This copy runs from the source code: only the Windows exe updates itself');
  busy = true;
  let clean = () => {};
  try {
    const latest = await latestRelease();
    const v = latest.version;
    const exe = path.join(folder, exeName(v));
    if (fs.existsSync(exe)) return { version: v, exe, zip: null };
    if (!latest.asset) throw new Error(`The release ${v} has no ${zipName(v)}`);
    const zip = path.join(folder, zipName(v));
    const part = `${zip}.part`;
    const tmp = path.join(folder, `.quickdeck-update-${v}`);
    clean = () => {
      fs.rmSync(part, { force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    };
    clean();
    const what = `QuickDeck ${v}`;
    await downloadFile(latest.asset.url, part, { what, size: latest.asset.size, sha256: latest.asset.sha256, progress: (p) => progress({ phase: 'download', ...p }) });
    await rename(part, zip);
    progress({ phase: 'unpack' });
    fs.mkdirSync(tmp, { recursive: true });
    await unzip(zip, tmp, what);
    const inside = fs.readdirSync(tmp).filter((f) => /\.exe$/i.test(f));
    const pick = [exeName(v), ...oldExeNames(v)].find((n) => inside.includes(n)) || (inside.length === 1 ? inside[0] : null);
    if (!pick) throw new Error(`The zip of ${what} has no QuickDeck exe in it`);
    await rename(path.join(tmp, pick), exe);
    return { version: v, exe, zip };
  } finally {
    busy = false;
    clean();
  }
}

// The new exe, once this one has ended: PowerShell waits for this process, then starts it.
function openVersion(version) {
  if (!canOpen()) throw new Error('Only the Windows exe opens another version');
  if (!VERSION.test(String(version))) throw new Error('Unknown version');
  const exe = path.join(appFolder(), exeName(version));
  if (!fs.existsSync(exe)) throw new Error(`${exeName(version)} is not in the folder any more`);
  const script = `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Start-Process -FilePath ${psQuote(exe)} -WorkingDirectory ${psQuote(path.dirname(exe))}`;
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(() => app.quit(), 300);
}

function registerUpdates({ getWindow }) {
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const wrap = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { error: e.message };
    }
  };
  ipcMain.handle('update-info', () => ({ current: app.getVersion(), supported: Boolean(appFolder()), canOpen: canOpen() }));
  ipcMain.handle('update-check', wrap(() => check()));
  ipcMain.handle('update-download', wrap(() => download((p) => send('update-progress', p))));
  ipcMain.handle('update-open', wrap((_, version) => {
    openVersion(version);
    return { success: true };
  }));
  ipcMain.handle('update-reveal', wrap((_, version) => {
    const folder = appFolder();
    if (!folder || !VERSION.test(String(version))) throw new Error('Unknown version');
    const exe = path.join(folder, exeName(version));
    electronShell.showItemInFolder(fs.existsSync(exe) ? exe : folder);
    return { success: true };
  }));
}

module.exports = { registerUpdates, isNewer, zipName, exeName };
