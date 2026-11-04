// "Open with": the editors found on this computer (IntelliJ IDEA, Visual Studio Code, Visual Studio), looked for where
// they install themselves (by hand, with the JetBrains Toolbox, per user or for everyone). Only the ones found are
// offered; the repository opens in it as a folder (IntelliJ: a project), in its window when it is open already.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcMain } = require('electron');
const shell = require('./shell');

// The platform when asked (a test can stand in for another one).
const isMac = () => process.platform === 'darwin';
const isWin = () => process.platform === 'win32';

// The folders in a folder whose names match, the newest version first.
function dirs(dir, re) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && re.test(e.name)).map((e) => path.join(dir, e.name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

// An app bundle (a folder) on macOS, a file elsewhere.
function usable(p) {
  try {
    return p.endsWith('.app') ? fs.statSync(p).isDirectory() : fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const COMMUNITY = /CE\b|Community/i;

// Where each editor usually is, in the order they are tried: [id, name, paths].
function places() {
  const home = os.homedir();
  if (isMac()) {
    const apps = ['/Applications', path.join(home, 'Applications')];
    const ideas = apps.flatMap((d) => dirs(d, /^IntelliJ IDEA.*\.app$/i));
    return [
      ['idea', 'IntelliJ IDEA', [...ideas.filter((p) => !COMMUNITY.test(path.basename(p))), path.join(home, 'Library/Application Support/JetBrains/Toolbox/scripts/idea')]],
      ['idea-ce', 'IntelliJ IDEA Community', ideas.filter((p) => COMMUNITY.test(path.basename(p)))],
      ['vscode', 'Visual Studio Code', apps.map((d) => path.join(d, 'Visual Studio Code.app'))],
    ];
  }
  if (isWin()) {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    const idea = (d) => path.join(d, 'bin', 'idea64.exe');
    const toolbox = path.join(local, 'JetBrains', 'Toolbox');
    const ideaDirs = [...dirs(path.join(local, 'Programs'), /^IntelliJ IDEA/i), ...programFiles.flatMap((p) => dirs(path.join(p, 'JetBrains'), /^IntelliJ IDEA/i))];
    // the Toolbox before 2.0: apps/IDEA-U (or IDEA-C)/ch-0/<version>/bin
    const toolboxApp = (name) => dirs(path.join(toolbox, 'apps', name), /^ch-/).flatMap((ch) => dirs(ch, /^\d/).map(idea));
    return [
      ['idea', 'IntelliJ IDEA', [...ideaDirs.filter((d) => !COMMUNITY.test(path.basename(d))).map(idea), path.join(toolbox, 'scripts', 'idea.cmd'), ...toolboxApp('IDEA-U')]],
      ['idea-ce', 'IntelliJ IDEA Community', [...ideaDirs.filter((d) => COMMUNITY.test(path.basename(d))).map(idea), ...toolboxApp('IDEA-C')]],
      ['vscode', 'Visual Studio Code', [path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), ...programFiles.map((p) => path.join(p, 'Microsoft VS Code', 'Code.exe'))]],
      // Visual Studio <year>\<edition>\Common7\IDE\devenv.exe, the newest year first
      ['vs', 'Visual Studio', programFiles.flatMap((p) => dirs(path.join(p, 'Microsoft Visual Studio'), /^\d+$/).flatMap((year) => dirs(year, /./).map((ed) => path.join(ed, 'Common7', 'IDE', 'devenv.exe'))))],
    ];
  }
  return [
    ['idea', 'IntelliJ IDEA', [path.join(home, '.local/share/JetBrains/Toolbox/scripts/idea'), '/snap/bin/intellij-idea-ultimate', '/usr/local/bin/idea', '/usr/bin/idea']],
    ['idea-ce', 'IntelliJ IDEA Community', ['/snap/bin/intellij-idea-community']],
    ['vscode', 'Visual Studio Code', ['/usr/bin/code', '/snap/bin/code', '/usr/local/bin/code']],
  ];
}

// The editors found: [{ id, name, path }], the first place found of each.
function findIdes() {
  const found = [];
  for (const [id, name, paths] of places()) {
    const at = paths.find(usable);
    if (!at) continue;
    // Visual Studio says which: "Visual Studio 2022"
    const year = id === 'vs' ? (/[\\/](\d{4})[\\/]/.exec(at) || [])[1] : '';
    found.push({ id, name: year ? `${name} ${year}` : name, path: at });
  }
  return found;
}

// The folders IntelliJ IDEA is installed in (where its plugins folder is), the newest version first: for the Maven it
// comes with (intellij-maven.js).
function intellijHomes() {
  const home = os.homedir();
  const toolboxApps = (base) => ['IDEA-U', 'IDEA-C'].flatMap((name) => dirs(path.join(base, 'apps', name), /^ch-/).flatMap((ch) => dirs(ch, /^\d/)));
  let found;
  if (isMac()) {
    const apps = ['/Applications', path.join(home, 'Applications')].flatMap((d) => dirs(d, /^IntelliJ IDEA.*\.app$/i));
    // the Toolbox before 2.0: apps/IDEA-U/ch-0/<version>/IntelliJ IDEA.app
    const toolbox = toolboxApps(path.join(home, 'Library/Application Support/JetBrains/Toolbox')).flatMap((v) => dirs(v, /^IntelliJ IDEA.*\.app$/i));
    found = [...apps, ...toolbox].map((app) => path.join(app, 'Contents'));
  } else if (isWin()) {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    found = [...dirs(path.join(local, 'Programs'), /^IntelliJ IDEA/i), ...programFiles.flatMap((p) => dirs(path.join(p, 'JetBrains'), /^IntelliJ IDEA/i)), ...toolboxApps(path.join(local, 'JetBrains', 'Toolbox'))];
  } else {
    found = [...dirs('/opt', /^idea/i), '/snap/intellij-idea-ultimate/current', '/snap/intellij-idea-community/current', ...toolboxApps(path.join(home, '.local/share/JetBrains/Toolbox'))];
  }
  return found.filter((d) => fs.existsSync(path.join(d, 'plugins')));
}

// The editor with the folder: an app bundle through "open" (macOS), which answers at once; a program or script started
// on its own, left running. Resolves with an error text, or null.
function launch(ide, folder) {
  return new Promise((resolve) => {
    let child;
    const bundle = isMac() && ide.endsWith('.app');
    try {
      if (bundle) child = spawn('open', ['-a', ide, folder], { stdio: 'ignore' });
      else if (isWin() && /\.(cmd|bat)$/i.test(ide)) child = spawn('cmd.exe', ['/d', '/s', '/c', `""${ide}" "${folder}""`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
      else child = spawn(ide, [folder], { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (e) {
      resolve(e.message);
      return;
    }
    child.on('error', (e) => resolve(e.code === 'EACCES' ? `${ide} cannot be run` : e.message));
    if (bundle) {
      child.on('close', (code) => resolve(code ? `It did not open (open ended with ${code})` : null));
    } else {
      child.unref();
      setTimeout(() => resolve(null), 300); // what fails to start says so at once
    }
  });
}

function registerIdeOpen({ isKnownRepo }) {
  ipcMain.handle('ide-list', () => findIdes().map(({ id, name }) => ({ id, name })));

  ipcMain.handle('ide-open', async (_, repoPath, id) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    if (!fs.existsSync(repoPath)) return { error: 'Folder not found' };
    const ide = findIdes().find((i) => i.id === String(id));
    if (!ide) return { error: 'It is not on this computer any more' };
    const back = shell.stepBack();
    const error = await launch(ide.path, repoPath);
    if (error) {
      back();
      return { error };
    }
    return { success: true, name: ide.name };
  });
}

module.exports = { registerIdeOpen, findIdes, intellijHomes, launch };
