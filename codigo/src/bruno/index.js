// Bruno: the requests of a Bruno collection in a repository (a folder with a bruno.json), sent with the Bruno CLI
// (`bru run`) so that scripts, tests and asserts work as they do in Bruno. collection.js reads the files, cli.js finds
// the CLI, runner.js goes around it: it keeps the variables the scripts set from one send to the next (per collection,
// until the app closes, as the Bruno app does) and hands each result over as soon as it comes.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcMain, shell: electronShell } = require('electron');
const shell = require('../shell');
const { findCollections, readTree, readEnvironments, readDotEnv, requestDetail, slash } = require('./collection');
const { findCli, installCli, useCliHome, runnerFile } = require('./cli');
const files = require('./files');

const MARK = '\u001eGQ-BRUNO ';
const MAX_LOG = 400000;

const keyOf = (p) => (shell.IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
const inside = (root, p) => {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const gitOk = (cwd, args) => new Promise((resolve) => execFile('git', args, { cwd, windowsHide: true }, (err) => resolve(!err)));

// Whether git keeps the .env out: 'ignored'; 'tracked' (it is in git already: its secrets with it); 'open' (not ignored,
// a commit of everything takes it); null outside a repository.
async function dotEnvInGit(root) {
  if (await gitOk(root, ['ls-files', '--error-unmatch', '--', '.env'])) return 'tracked';
  if (await gitOk(root, ['check-ignore', '-q', '--', '.env'])) return 'ignored';
  return (await gitOk(root, ['rev-parse', '--is-inside-work-tree'])) ? 'open' : null;
}

// savedDir: the app's own folder of requests saved from here (Save in QuickDeck); cliHome: where Install puts the Bruno
// CLI
// onRequest: told the address of each request sent (Analysis > Calls between microservices shows Bruno calling it)
function registerBruno({ isKnownRepo, getWindow, savedDir, cliHome, onRequest = null }) {
  useCliHome(cliHome);
  const send = (channel, data) => {
    if (channel === 'bruno-result' && onRequest && data && data.result && data.result.request && data.result.request.url) {
      try {
        onRequest(String(data.result.request.url));
      } catch {
        // the map is not the run's business
      }
    }
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  };
  const varsByCollection = new Map(); // collection folder -> the variables its scripts set
  const runs = new Map(); // run id -> { child, stopped }

  // The collection folder asked for, if it is one of the repository's.
  const collectionOf = (repo, dir) => {
    if (!isKnownRepo(repo)) throw new Error('Unknown repository');
    const root = path.resolve(String(dir || ''));
    if (!inside(repo, root) || !fs.existsSync(path.join(root, 'bruno.json'))) throw new Error('That is not a Bruno collection of this repository');
    return root;
  };
  const guard = (fn) => async (_, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { error: e.message };
    }
  };

  ipcMain.handle('bruno-collections', guard(async (repo) => {
    if (!isKnownRepo(repo)) throw new Error('Unknown repository');
    return { collections: findCollections(String(repo)) };
  }));

  ipcMain.handle('bruno-read', guard(async (repo, dir) => {
    const root = collectionOf(repo, dir);
    // the environments as Bruno reads them (with the CLI's parser), else as this app does
    const envs = await files.readEnvironments(root).catch(() => readEnvironments(root));
    const dotenv = readDotEnv(root);
    if (dotenv) dotenv.git = await dotEnvInGit(root);
    return { tree: readTree(root), envs, dotenv, vars: varsByCollection.get(keyOf(root)) || {} };
  }));

  ipcMain.handle('bruno-request', guard(async (repo, dir, rel) => {
    const root = collectionOf(repo, dir);
    const file = path.resolve(root, String(rel));
    if (!inside(root, file) || !file.endsWith('.bru') || !fs.existsSync(file)) throw new Error('That request is not there any more');
    // what the page edits; without the CLI's parser, only what it shows
    let edit = null;
    let editError = null;
    try {
      edit = await files.readRequest(file);
    } catch (e) {
      editError = e.message;
    }
    return { request: requestDetail(file), edit: edit && edit.edit, stamp: edit && edit.stamp, editError };
  }));

  const requestFile = (root, rel) => {
    const file = path.resolve(root, String(rel));
    if (!inside(root, file) || !file.endsWith('.bru') || !fs.existsSync(file)) throw new Error('That request is not there any more');
    return file;
  };

  ipcMain.handle('bruno-save-request', guard(async (repo, dir, rel, edit, stamp) => {
    const file = requestFile(collectionOf(repo, dir), rel);
    const saved = await files.saveRequest(file, edit, Number(stamp) || 0);
    return { request: requestDetail(file), edit: saved.edit, stamp: saved.stamp };
  }));

  // A request's file: duplicated (arg: the copy's name), renamed (arg: the name), moved (arg: the folder, '' for the
  // top), moved to a new folder (arg: its path, Products/Orders), sent to the Trash (not while a run goes), or kept
  // as a copy in the app's folder of saved requests. Returns where it is now (none once deleted).
  ipcMain.handle('bruno-request-op', guard(async (repo, dir, kind, rel, arg) => {
    const root = collectionOf(repo, dir);
    const file = requestFile(root, rel);
    // a copy in the app's folder of saved requests: the request stays as it is (a run may go on)
    if (kind === 'keep') {
      const kept = files.keepRequest(file, savedDir);
      return { path: slash(path.relative(root, file)), kept: kept.target, already: kept.already };
    }
    if (runs.size) throw new Error('A run is still going. Stop it first.');
    let to = null;
    if (kind === 'duplicate') to = await files.duplicateRequest(file, arg);
    else if (kind === 'rename') to = await files.renameRequest(file, arg);
    else if (kind === 'move') {
      const where = path.resolve(root, String(arg || ''));
      const parts = slash(path.relative(root, where)).split('/').filter(Boolean);
      const folder = inside(root, where) && fs.existsSync(where) && fs.statSync(where).isDirectory();
      if (!folder || parts[0] === 'environments' || parts.some((p) => p.startsWith('.') || p === 'node_modules')) throw new Error('That is not a folder of the collection');
      to = await files.moveRequest(file, where);
    } else if (kind === 'move-new') {
      const { dir: where, made } = files.makeFolders(root, arg);
      try {
        to = await files.moveRequest(file, where);
      } catch (e) {
        made.reverse().forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
        throw e;
      }
    } else if (kind === 'delete') await files.deleteRequest(file);
    else throw new Error('A request cannot do that');
    return { path: to ? slash(path.relative(root, to)) : null };
  }));

  // The folder of saved requests, in Finder / Explorer (made if it is not there yet).
  ipcMain.handle('bruno-saved-folder', guard(async () => {
    fs.mkdirSync(savedDir, { recursive: true });
    const error = await electronShell.openPath(savedDir);
    if (error) throw new Error(error);
    return { dir: savedDir };
  }));

  ipcMain.handle('bruno-save-env', guard(async (repo, dir, env) => files.saveEnvironment(collectionOf(repo, dir), env || {})));

  ipcMain.handle('bruno-delete-env', guard(async (repo, dir, name) => files.deleteEnvironment(collectionOf(repo, dir), name)));

  ipcMain.handle('bruno-cli', guard(async (again) => findCli(Boolean(again))));

  // Install: the Bruno CLI into the data folder, how far it got sent as it goes (bruno-cli-progress)
  ipcMain.handle('bruno-cli-install', guard(async () => {
    if (runs.size) throw new Error('A run is still going. Stop it first.');
    await installCli((p) => send('bruno-cli-progress', p));
    return { success: true, cli: await findCli(true) };
  }));

  ipcMain.handle('bruno-clear-vars', guard(async (repo, dir) => {
    varsByCollection.delete(keyOf(collectionOf(repo, dir)));
    return { success: true };
  }));

  // Sends a request, a folder (with what is in its folders) or the whole collection ('').
  ipcMain.handle('bruno-run', guard(async (repo, dir, { id, target, env }) => {
    const root = collectionOf(repo, dir);
    const where = target ? path.resolve(root, String(target)) : root;
    if (!inside(root, where) || !fs.existsSync(where)) throw new Error('That request is not there any more');
    const cli = await findCli();
    if (!cli.ok) throw new Error(`${cli.reason} Install it from the note above the requests, or with: ${cli.hint}`);
    if (runs.size) throw new Error('A run is still going. Stop it first.');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-quick-bruno-'));
    const varsFile = path.join(tmp, 'vars.json');
    const reportFile = path.join(tmp, 'report.json');
    fs.writeFileSync(varsFile, JSON.stringify(varsByCollection.get(keyOf(root)) || {}));
    const args = [runnerFile(), cli.dir, varsFile, 'run'];
    if (target) args.push(slash(path.relative(root, where)));
    if (target && fs.statSync(where).isDirectory()) args.push('-r');
    if (env) args.push('--env', String(env));
    args.push('--reporter-json', reportFile);
    const shellEnv = await shell.loginShellEnv();
    const child = spawn(cli.node, args, {
      cwd: root,
      // the one QuickDeck installed: run by the app itself, as Node
      env: { ...shellEnv, FORCE_COLOR: '0', NO_COLOR: '1', ...(cli.electronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      detached: !shell.IS_WIN,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const run = { child, stopped: false, results: 0 };
    runs.set(id, run);
    let rest = '';
    let logged = 0;
    const out = (chunk) => {
      const lines = (rest + chunk.toString('utf8')).split('\n');
      rest = lines.pop();
      const text = [];
      for (const line of lines) {
        const at = line.indexOf(MARK);
        if (at === -1) {
          text.push(line);
          continue;
        }
        try {
          const data = JSON.parse(line.slice(at + MARK.length));
          if (data.warning) text.push(data.warning);
          else {
            run.results++;
            send('bruno-result', { id, result: { ...data, file: data.file ? slash(String(data.file)) : null } });
          }
        } catch {
          text.push(line);
        }
      }
      if (text.length && logged < MAX_LOG) {
        const piece = `${text.join('\n')}\n`;
        logged += piece.length;
        send('bruno-output', { id, text: piece });
      }
    };
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    child.on('error', (e) => send('bruno-output', { id, text: `${e.message}\n` }));
    child.on('close', (code, signal) => {
      if (rest) out('\n');
      runs.delete(id);
      try {
        varsByCollection.set(keyOf(root), JSON.parse(fs.readFileSync(varsFile, 'utf8')) || {});
      } catch {
        // the variables stay as they were
      }
      // no result came on the way (a CLI the runner does not know): the CLI's own report
      if (!run.results) {
        try {
          const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
          for (const it of Array.isArray(report) ? report : [report]) {
            for (const r of (it && it.results) || []) {
              send('bruno-result', {
                id,
                result: {
                  file: r.test && r.test.filename ? slash(String(r.test.filename)) : null,
                  status: r.status,
                  error: r.error ? String(r.error) : null,
                  request: r.request || {},
                  response: { ...(r.response || {}), time: r.response && r.response.responseTime },
                  asserts: (r.assertionResults || []).map((a) => ({ name: `${a.lhsExpr}: ${a.rhsExpr}`, status: a.status, error: a.error || null })),
                  tests: (r.testResults || []).map((t) => ({ name: t.description, status: t.status, error: t.error || null })),
                },
              });
            }
          }
        } catch {
          // nothing to show but the output
        }
      }
      fs.rm(tmp, { recursive: true, force: true }, () => {});
      send('bruno-done', { id, code, signal, stopped: run.stopped, vars: varsByCollection.get(keyOf(root)) || {} });
    });
    return { success: true, cli: { version: cli.version, from: cli.from } };
  }));

  ipcMain.handle('bruno-stop', guard(async (id) => {
    const run = runs.get(id);
    if (!run) return { success: true };
    run.stopped = true;
    await shell.killTree(run.child);
    return { success: true };
  }));

  return {
    stopAll: () => Promise.all([...runs.values()].map((r) => shell.killTree(r.child))),
  };
}

module.exports = { registerBruno };
