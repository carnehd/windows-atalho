// The Bruno CLI: Node and the @usebruno/cli package, found once (again when asked). The exe does not carry it: Git
// Quick uses `bru` on the PATH, the one npm installed for every project, one that npx keeps in its cache, or the one it
// installed itself (Install, in the Bruno tab: installCli below). runner.js, which goes around it, is copied where Node
// can read it.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app, net } = require('electron');
const shell = require('../shell');

const INSTALL_HINT = 'npm install -g @usebruno/cli';

function which(name, env) {
  const exts = shell.IS_WIN ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

function cliVersion(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.name !== '@usebruno/cli' || !fs.existsSync(path.join(dir, 'src', 'index.js'))) return null;
    return String(pkg.version || '0');
  } catch {
    return null;
  }
}

const newer = (a, b) => {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

// The one Git Quick installs: @usebruno/cli and its packages in a zip on the app's GitHub releases (made with npm, with
// no install scripts run; maps, types and readmes left out), checked against this SHA-256 before it is unpacked. It runs
// with the app's own Node (Electron as Node), so the computer needs neither Node.js nor npm.
const BUNDLE = {
  version: '4.2.1',
  url: 'https://github.com/carnehd/windows-atalho/releases/download/bruno-cli-4.2.1/bruno-cli.zip',
  sha256: '8d415e8d1458e8054935be4601e3b0f4e39ecb9ccee6fdc0df4b78cb59890a70',
  size: 30988807,
};

// The folder it goes in (data/bruno-cli), told by the app when it starts.
let cliHome = null;
function useCliHome(dir) {
  cliHome = dir;
}

function bundledCli(home) {
  if (!home) return null;
  const dir = path.join(home, 'node_modules', '@usebruno', 'cli');
  const version = cliVersion(dir);
  return version ? { ok: true, node: process.execPath, electronNode: true, dir, version, from: "Git Quick's data folder" } : null;
}

let cliFound = null;

async function findCli(again = false) {
  if (cliFound && !again) return cliFound;
  const env = await shell.loginShellEnv();
  const node = which('node', env);
  const places = [];
  const bru = which('bru', env);
  if (bru) {
    try {
      const real = fs.realpathSync(bru);
      places.push({ dir: path.resolve(path.dirname(real), '..'), from: 'bru on the PATH' });
    } catch {
      // a link that leads nowhere
    }
    places.push({ dir: path.join(path.dirname(bru), 'node_modules', '@usebruno', 'cli'), from: 'bru on the PATH' });
  }
  if (node) places.push({ dir: path.resolve(path.dirname(node), '..', 'lib', 'node_modules', '@usebruno', 'cli'), from: 'npm, installed globally' });
  if (shell.IS_WIN && env.APPDATA) places.push({ dir: path.join(env.APPDATA, 'npm', 'node_modules', '@usebruno', 'cli'), from: 'npm, installed globally' });
  for (const p of places) {
    const version = cliVersion(p.dir);
    if (version && node) return (cliFound = { ok: true, node, dir: p.dir, version, from: p.from });
  }
  // npx's cache: the newest one there
  const caches = [env.npm_config_cache, shell.IS_WIN && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'npm-cache') : null, path.join(os.homedir(), '.npm')].filter(Boolean);
  let best = null;
  for (const cache of caches) {
    let runs = [];
    try {
      runs = fs.readdirSync(path.join(cache, '_npx'));
    } catch {
      continue;
    }
    for (const run of runs) {
      const dir = path.join(cache, '_npx', run, 'node_modules', '@usebruno', 'cli');
      const version = cliVersion(dir);
      if (version && (!best || newer(version, best.version))) best = { dir, version, from: 'the npx cache' };
    }
  }
  if (best && node) return (cliFound = { ok: true, node, ...best });
  // the one Git Quick installed: after those, which the user chose
  const own = bundledCli(cliHome);
  if (own) return (cliFound = own);
  cliFound = null;
  return {
    ok: false,
    node: Boolean(node),
    reason: 'The Bruno CLI is not on this computer.',
    hint: node ? INSTALL_HINT : 'Install Node.js, then: npm install -g @usebruno/cli',
    install: { version: BUNDLE.version, size: BUNDLE.size },
  };
}

// Windows' own tar (Windows 10 and 11 have it; another tar on the PATH, Git's, cannot read a zip); macOS's reads one too.
const tarProgram = () => (shell.IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar');

// A folder renamed; on Windows again for a few seconds while the antivirus still reads the files just unpacked.
async function rename(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

let installing = false;

// Downloads the zip (through the app's network, with the computer's proxy), checks it, unpacks it next to its folder
// and puts it in that folder's place. progress({ phase: 'download', got, total } | { phase: 'unpack' }). Nothing is
// left half done.
async function installCli(progress = () => {}) {
  if (installing) throw new Error('The Bruno CLI is being installed already');
  const home = cliHome;
  if (!home) throw new Error('Git Quick does not know where to put the Bruno CLI');
  installing = true;
  const zip = `${home}.zip.part`;
  const part = `${home}.part`;
  const clean = () => {
    fs.rmSync(zip, { force: true });
    fs.rmSync(part, { recursive: true, force: true });
  };
  try {
    clean();
    // a test serves it from this computer (never in the exe)
    const url = !app.isPackaged && process.env.GQ_BRUNO_CLI_URL ? process.env.GQ_BRUNO_CLI_URL : BUNDLE.url;
    const stop = new AbortController();
    let idle = setTimeout(() => stop.abort(), 60000);
    let res;
    try {
      res = await net.fetch(url, { signal: stop.signal, cache: 'no-store' });
    } catch (e) {
      clearTimeout(idle);
      throw new Error(`Couldn't download the Bruno CLI: ${stop.signal.aborted ? 'no answer in a minute' : e.message}`);
    }
    if (!res.ok) {
      clearTimeout(idle);
      throw new Error(`Couldn't download the Bruno CLI: the server said ${res.status}`);
    }
    const total = Number(res.headers.get('content-length')) || BUNDLE.size;
    const hash = crypto.createHash('sha256');
    const file = await fs.promises.open(zip, 'w');
    let got = 0;
    let shown = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(idle);
        idle = setTimeout(() => stop.abort(), 60000);
        hash.update(value);
        await file.write(value);
        got += value.length;
        if (Date.now() - shown > 150) {
          shown = Date.now();
          progress({ phase: 'download', got, total });
        }
      }
    } catch (e) {
      throw new Error(`The download of the Bruno CLI stopped: ${stop.signal.aborted ? 'no data for a minute' : e.message}`);
    } finally {
      clearTimeout(idle);
      await file.close();
    }
    progress({ phase: 'download', got, total });
    if (hash.digest('hex') !== BUNDLE.sha256) throw new Error('The Bruno CLI downloaded is not the file Git Quick expects (its checksum differs): not installed.');
    progress({ phase: 'unpack' });
    fs.mkdirSync(part, { recursive: true });
    await new Promise((resolve, reject) => {
      execFile(tarProgram(), ['-xf', zip, '-C', part], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
        if (!err) resolve();
        else if (err.code === 'ENOENT') reject(new Error(`Couldn't unpack the Bruno CLI: ${tarProgram()} is not on this computer.`));
        else reject(new Error(`Couldn't unpack the Bruno CLI: ${String(errOut || err.message).trim().split('\n')[0]}`));
      });
    });
    const unpacked = bundledCli(part);
    if (!unpacked || unpacked.version !== BUNDLE.version) throw new Error("Couldn't unpack the Bruno CLI: the zip did not hold it.");
    // in home's place: an earlier one (unfinished, or another version) out of the way first
    if (fs.existsSync(home)) {
      const old = `${home}.old-${Date.now()}`;
      await rename(home, old);
      fs.rm(old, { recursive: true, force: true }, () => {});
    }
    await rename(part, home);
    return bundledCli(home);
  } finally {
    installing = false;
    clean();
  }
}

// runner.js, copied where Node can read it (not inside the packed app); again when it changed.
function runnerFile() {
  const source = fs.readFileSync(path.join(__dirname, 'runner.js'), 'utf8');
  const target = path.join(app.getPath('userData'), 'bruno-runner.js');
  let now = null;
  try {
    now = fs.readFileSync(target, 'utf8');
  } catch {
    // not there yet
  }
  if (now !== source) fs.writeFileSync(target, source);
  return target;
}

module.exports = { findCli, installCli, useCliHome, runnerFile };
