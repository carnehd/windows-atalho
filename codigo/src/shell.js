// Starting command line tools from the app: the environment to find them in, and a separate terminal window.
const { spawn } = require('child_process');
const { app, BrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// macOS and Linux: an app opened from the Finder or the Dock gets a short PATH (no Homebrew, no SDKMAN, no Docker), so
// tools are looked up with the environment the user's own shell sets up, read once from a login shell (as a new
// Terminal window would have it). Windows programs get the full PATH, so there it is the app's own.
let shellEnv = null;

function loginShellEnv() {
  if (IS_WIN) return Promise.resolve(process.env);
  if (shellEnv) return Promise.resolve(shellEnv);
  return new Promise((resolve) => {
    const mark = '__GIT_QUICK_ENV__';
    const env = { ...process.env };
    let out = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const parts = out.split(mark);
      if (parts.length >= 3) {
        for (const entry of parts[1].split('\0')) {
          const i = entry.indexOf('=');
          if (i > 0) env[entry.slice(0, i).replace(/^\n+/, '')] = entry.slice(i + 1);
        }
      }
      // the usual places, in case the shell could not be read
      env.PATH = [...new Set([...(env.PATH || '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin'])].join(':');
      shellEnv = env;
      resolve(env);
    };
    let child;
    try {
      child = spawn(process.env.SHELL || '/bin/zsh', ['-ilc', `printf '${mark}'; env -0; printf '${mark}'`], { stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
    } catch {
      finish();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, 10000);
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); finish(); });
    child.on('close', () => { clearTimeout(timer); finish(); });
  });
}

// The script a separate window runs on macOS: a login shell that cds to the folder, runs the command and then stays
// open there (as PowerShell's -NoExit does on Windows).
function terminalScript(cwd, argv) {
  const shell = process.env.SHELL || '/bin/zsh';
  return [`#!${shell} -il`, `cd ${shQuote(cwd)} || exit 1`, argv.map(shQuote).join(' '), `exec ${shQuote(shell)} -l`, ''].join('\n');
}

// Runs a command in a window of its own that the app does not control: PowerShell on Windows; Terminal on macOS,
// through a small .command file (one per name, written again each time).
function openInTerminal(cwd, argv, name = 'command') {
  if (IS_WIN) {
    const script = ['[Console]::OutputEncoding = [Text.Encoding]::UTF8', `& ${argv.map(psQuote).join(' ')}`].join('; ');
    spawn('powershell.exe', ['-NoExit', '-NoProfile', '-Command', script], { cwd, detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform !== 'darwin') throw new Error('A separate window is only available on Windows and macOS');
  const dir = path.join(os.tmpdir(), 'git-quick');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${crypto.createHash('sha1').update(`${cwd}\0${argv.join('\0')}`).digest('hex').slice(0, 12)}.command`);
  fs.writeFileSync(file, terminalScript(cwd, argv), { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  spawn('open', ['-a', 'Terminal', file], { detached: true, stdio: 'ignore' }).unref();
}

// A command line typed by the user, in a separate window: PowerShell runs it as typed on Windows; on macOS the .command
// file cds to the folder, runs it in the login shell and leaves the shell open.
function openShellCommand(cwd, command) {
  if (IS_WIN) {
    spawn('powershell.exe', ['-NoExit', '-NoProfile', '-Command', command], { cwd, detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform !== 'darwin') throw new Error('A separate window is only available on Windows and macOS');
  const shell = process.env.SHELL || '/bin/zsh';
  const dir = path.join(os.tmpdir(), 'git-quick');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `command-${crypto.createHash('sha1').update(`${cwd}\0${command}`).digest('hex').slice(0, 12)}.command`);
  fs.writeFileSync(file, [`#!${shell} -il`, `cd ${shQuote(cwd)} || exit 1`, command, `exec ${shQuote(shell)} -l`, ''].join('\n'), { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  spawn('open', ['-a', 'Terminal', file], { detached: true, stdio: 'ignore' }).unref();
}

// The app's windows float over the others, and a pinned one stays up when another app gets the focus, so a browser,
// terminal or folder window opened from the app would land behind it. They stop floating until one of them gets the
// focus back (not another window of the app, such as a sign-in window). Returns the way back, for when nothing opened
// after all.
function stepBack() {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isAlwaysOnTop());
  if (wins.length === 0) return () => {};
  const restore = () => {
    app.removeListener('browser-window-focus', onFocus);
    wins.forEach((w) => {
      if (!w.isDestroyed()) w.setAlwaysOnTop(true);
    });
  };
  const onFocus = (e, win) => {
    if (wins.includes(win)) restore();
  };
  wins.forEach((w) => w.setAlwaysOnTop(false));
  app.on('browser-window-focus', onFocus);
  return restore;
}

// Ends a command with everything it started: taskkill /T on Windows; elsewhere its process group (it was started
// with detached: true), asked first and forced after a few seconds.
function killTree(child) {
  return new Promise((resolve) => {
    if (IS_WIN) {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      k.on('close', resolve);
      k.on('error', resolve);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const signal = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      signal('SIGKILL');
      resolve();
    }, 4000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    signal('SIGTERM');
  });
}

module.exports = { IS_WIN, psQuote, shQuote, loginShellEnv, terminalScript, openInTerminal, openShellCommand, stepBack, killTree };
