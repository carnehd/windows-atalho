// The terminal under the Help commands: runs one command line at a time, as typed, in the system shell (PowerShell on
// Windows, the user's shell elsewhere) in a repository of the list or the home folder. There is no keyboard on the
// other end, so Git is told not to ask (no password prompt, no editor, no pager); commands that ask questions go to a
// real terminal window instead.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { ipcMain } = require('electron');
const shell = require('./shell');
const gitLog = require('./git-log');

const MAX_COMMAND = 4000;
// Nobody can answer git here: no password prompt, no editor, no pager, no colours.
const NO_QUESTIONS = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_PAGER: 'cat', PAGER: 'cat', TERM: 'dumb' };

// The words of a command line as a shell splits them: apart at spaces, except inside quotes ("..." or '...'), which can
// sit inside a word (--format="%h %s").
function words(text) {
  const out = [];
  let word = null;
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word = word ?? '';
    } else if (/\s/.test(ch)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? '') + ch;
  }
  if (quote) throw new Error('A quote is not closed');
  if (word !== null) out.push(word);
  return out;
}

function registerTerminal({ isKnownRepo, getWindow }) {
  let run = null;
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const folder = (cwd) => {
    const dir = String(cwd || '');
    if (dir && (isKnownRepo(dir) || path.resolve(dir) === path.resolve(os.homedir()))) return dir;
    throw new Error('Choose a folder from the list');
  };
  const commandLine = (text) => {
    const command = String(text || '').trim();
    if (!command) throw new Error('Type a command');
    if (command.length > MAX_COMMAND || command.includes('\0')) throw new Error('The command is too long');
    return command;
  };

  ipcMain.handle('term-home', () => os.homedir());

  ipcMain.handle('term-run', async (_, cwd, text) => {
    try {
      const dir = folder(cwd);
      const command = commandLine(text);
      if (run) throw new Error('A command is still running. Stop it first.');
      const env = { ...(await shell.loginShellEnv()), ...NO_QUESTIONS };
      const child = shell.IS_WIN
        ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(process.env.SHELL || '/bin/zsh', ['-c', command], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const current = { child };
      run = current;
      const out = (chunk) => send('term-output', { text: chunk.toString('utf8') });
      child.stdout.on('data', out);
      child.stderr.on('data', out);
      child.on('error', (e) => send('term-output', { text: `${e.message}\n` }));
      child.on('close', (code, signal) => {
        if (run === current) run = null;
        send('term-exit', { code, signal });
      });
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('term-stop', async () => {
    if (!run) return { error: 'Nothing is running' };
    await shell.killTree(run.child);
    return { success: true };
  });

  ipcMain.handle('term-external', (_, cwd, text) => {
    try {
      shell.openShellCommand(folder(cwd), commandLine(text));
      shell.stepBack();
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });

  // -- The line at the foot of the Git panel: git itself (no shell), one command at a time, in a repository of the
  // list. What is typed after "git" are its arguments; quotes keep words together (commit -m "two words"). It is
  // listed in the panel like every git command the app runs, marked as typed, and its output goes under it. --
  let gitRun = null;

  ipcMain.handle('term-git-run', async (_, cwd, text) => {
    try {
      const dir = String(cwd || '');
      if (!isKnownRepo(dir)) throw new Error('Choose a repository first');
      const args = words(commandLine(text).replace(/^git(\s+|$)/i, ''));
      if (!args.length) throw new Error('Type a git command, for example: status');
      if (gitRun) throw new Error('A git command is still running. Stop it first.');
      const env = { ...(shell.IS_WIN ? process.env : await shell.loginShellEnv()), ...NO_QUESTIONS };
      const child = spawn('git', args, { cwd: dir, env, windowsHide: true, detached: !shell.IS_WIN, stdio: ['ignore', 'pipe', 'pipe'] });
      const id = gitLog.mark(child, { typed: true });
      const current = { child, id };
      gitRun = current;
      const out = (chunk) => send('term-git-output', { id, text: chunk.toString('utf8') });
      child.stdout.on('data', out);
      child.stderr.on('data', out);
      child.on('error', (e) => send('term-git-output', { id, text: e.code === 'ENOENT' ? 'Git was not found: is it installed?\n' : `${e.message}\n` }));
      child.on('close', (code, signal) => {
        if (gitRun === current) gitRun = null;
        send('term-git-exit', { id, code, signal, repo: dir });
      });
      return { success: true, id };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('term-git-stop', async () => {
    if (!gitRun) return { error: 'Nothing is running' };
    await shell.killTree(gitRun.child);
    return { success: true };
  });

  const stopAll = () => Promise.all([run, gitRun].filter(Boolean).map((r) => shell.killTree(r.child)));
  return { stop: stopAll };
}

module.exports = { registerTerminal, words, NO_QUESTIONS };
