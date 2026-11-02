// The Bruno CLI: Node and the @usebruno/cli package, found once (again when asked). Git Quick does not ship it: it
// uses `bru` on the PATH, the one npm installed for every project, or one that npx keeps in its cache. runner.js, which
// goes around it, is copied where Node can read it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
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
  cliFound = null;
  return {
    ok: false,
    node: Boolean(node),
    reason: node ? 'The Bruno CLI is not on this computer.' : 'Node.js is not on this computer (the Bruno CLI runs on it).',
    hint: node ? INSTALL_HINT : 'Install Node.js, then: npm install -g @usebruno/cli',
  };
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

module.exports = { findCli, runnerFile };
