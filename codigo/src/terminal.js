// The terminal under the Help commands: runs one command line at a time, as typed, in the system shell (PowerShell on
// Windows, the user's shell elsewhere) in a repository of the list or the home folder. There is no keyboard on the
// other end, so Git is told not to ask (no password prompt, no editor, no pager); commands that ask questions go to a
// real terminal window instead.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { ipcMain } = require('electron');
const shell = require('./shell');

const MAX_COMMAND = 4000;

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
      const env = {
        ...(await shell.loginShellEnv()),
        GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_PAGER: 'cat', PAGER: 'cat', TERM: 'dumb',
      };
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

  return { stop: () => (run ? shell.killTree(run.child) : Promise.resolve()) };
}

module.exports = { registerTerminal };
