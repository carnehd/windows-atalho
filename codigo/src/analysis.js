// Analysis page: looks across the microservices of the list. Swagger files: every .yaml / .yml inside the folders to
// look in of each repository (named "swagger" unless the user chose others), with the title and version from its
// info: block.
const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const yaml = require('js-yaml');

// folders that never hold a service's own API definitions, and can be huge
const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', '.idea', '.vscode', '.gradle', '.mvn', 'bin', 'obj', '.next', 'coverage', 'vendor', '.angular', '.cache', 'tmp']);
const MAX_DEPTH = 10;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 2000;
const YAML_FILE = /\.ya?ml$/i;
// where the swagger files are looked for: a folder name (at any depth, any case) or a path from the root of each
// repository; the user may change them on the page
const DEFAULT_FOLDERS = ['swagger'];
const MAX_FOLDERS = 30;

async function entries(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// A folder to look in as the user wrote it: a name (swagger) or a path inside each repository (docs/api), with /.
function cleanFolder(input) {
  const t = String(input || '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '');
  if (!t) throw new Error('Type a folder name, like swagger, or a path, like docs/api');
  if (t.length > 200) throw new Error('That folder is too long');
  if (/^[a-z]:/i.test(t) || t.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error(`"${t.slice(0, 60)}" is not a folder inside a repository`);
  return t;
}

// The list as saved: each one clean, none twice (whatever the case), not too many. Wrong ones left out.
function cleanFolders(list) {
  const out = [];
  for (const f of Array.isArray(list) ? list : []) {
    try {
      const c = cleanFolder(f);
      if (!out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c);
    } catch {
      // not a folder inside a repository
    }
  }
  return out.slice(0, MAX_FOLDERS);
}

// The folders to look in under a repository: those with one of the names (at any depth; not inside another one: its
// files are taken with it) and those at one of the paths. One inside another counts once.
async function lookDirs(root, folders) {
  const names = new Set(folders.filter((f) => !f.includes('/')).map((f) => f.toLowerCase()));
  const found = [];
  for (const f of folders.filter((x) => x.includes('/'))) {
    const dir = path.join(root, ...f.split('/'));
    try {
      if ((await fs.promises.stat(dir)).isDirectory()) found.push(dir);
    } catch {
      // not in this repository
    }
  }
  const walk = async (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const e of await entries(dir)) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (names.has(e.name.toLowerCase())) found.push(full);
      else await walk(full, depth + 1);
    }
  };
  if (names.size) await walk(root, 0);
  const sorted = [...new Set(found)].sort((a, b) => a.length - b.length);
  return sorted.filter((d, i) => !sorted.slice(0, i).some((o) => d.startsWith(o + path.sep)));
}

async function yamlFiles(dir, out, depth = 0) {
  if (depth > 6 || out.length >= MAX_FILES) return out;
  for (const e of await entries(dir)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && !SKIP.has(e.name)) await yamlFiles(full, out, depth + 1);
    else if (e.isFile() && YAML_FILE.test(e.name)) out.push(full);
  }
  return out;
}

const text = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// Name, path, title and version of one file (and what it is: OpenAPI 3.x or Swagger 2.0).
async function describe(file, root) {
  const row = { name: path.basename(file), rel: path.relative(root, file).split(path.sep).join('/'), title: '', version: '', spec: '' };
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_FILE_BYTES) return { ...row, error: 'Too big to read (over 5 MB)' };
    const source = await fs.promises.readFile(file, 'utf8');
    let doc;
    try {
      doc = yaml.load(source, { json: true });
    } catch (e) {
      // several documents in one file: the first one has the info
      if (!/single document/i.test(e.message)) throw e;
      doc = yaml.loadAll(source, null, { json: true }).find((d) => d && typeof d === 'object');
    }
    const info = doc && typeof doc === 'object' && doc.info && typeof doc.info === 'object' ? doc.info : null;
    row.spec = doc && doc.openapi ? `OpenAPI ${text(doc.openapi)}` : doc && doc.swagger ? `Swagger ${text(doc.swagger)}` : '';
    if (!info) return { ...row, error: 'No info: in this file' };
    return { ...row, title: text(info.title), version: text(info.version) };
  } catch (e) {
    return { ...row, error: `Not readable YAML: ${String(e.reason || e.message).split('\n')[0]}` };
  }
}

async function scanSwagger(repos, folders = DEFAULT_FOLDERS) {
  const services = [];
  for (const repo of repos) {
    if (!fs.existsSync(repo.path)) {
      services.push({ path: repo.path, name: repo.name, missing: true, dirs: [], files: [] });
      continue;
    }
    const dirs = await lookDirs(repo.path, folders);
    const files = [];
    for (const dir of dirs) await yamlFiles(dir, files);
    const rows = [];
    for (const f of files.sort((a, b) => a.localeCompare(b))) {
      const row = await describe(f, repo.path);
      // where it is inside the folder it was found in: what a copy elsewhere is matched by
      const dir = dirs.find((d) => f.startsWith(d + path.sep));
      row.inner = path.relative(dir, f).split(path.sep).join('/');
      rows.push(row);
    }
    services.push({ path: repo.path, name: repo.name, dirs: dirs.map((d) => path.relative(repo.path, d).split(path.sep).join('/')), files: rows });
  }
  return services;
}

function registerAnalysis({ listRepos, isKnownRepo, openPath, loadFolders, saveFolders, pickDir }) {
  const folders = () => {
    const saved = loadFolders ? loadFolders() : null;
    return Array.isArray(saved) ? cleanFolders(saved) : [...DEFAULT_FOLDERS];
  };
  // a .yaml inside one of the repositories of the list, nowhere else
  const listedFile = (repoPath, rel) => {
    if (!isKnownRepo(repoPath)) throw new Error('Unknown repository');
    const file = path.resolve(repoPath, String(rel || ''));
    const inside = path.relative(path.resolve(repoPath), file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !YAML_FILE.test(file) || !fs.existsSync(file)) throw new Error('File not found');
    return file;
  };
  ipcMain.handle('an-swagger', async () => {
    try {
      const started = Date.now();
      const looked = folders();
      const services = await scanSwagger(listRepos(), looked);
      return { services, folders: looked, took: Date.now() - started };
    } catch (e) {
      return { error: e.message };
    }
  });
  // The folders to look in, and a new list of them (saved in the app's data).
  ipcMain.handle('an-folders', () => ({ folders: folders() }));
  ipcMain.handle('an-set-folders', (_, list) => {
    try {
      if (!Array.isArray(list)) throw new Error('Not a list of folders');
      if (list.length > MAX_FOLDERS) throw new Error(`At most ${MAX_FOLDERS} folders`);
      const clean = list.map(cleanFolder);
      saveFolders(cleanFolders(clean));
      return { folders: folders() };
    } catch (e) {
      return { error: e.message };
    }
  });
  // A folder chosen in the system's window, inside one of the repositories of the list: its path from that root.
  ipcMain.handle('an-pick-folder', async () => {
    try {
      const picked = await pickDir('Choose a folder with swagger files, inside one of your microservices');
      if (!picked) return { canceled: true };
      const full = path.resolve(picked);
      const repo = listRepos().map((r) => ({ ...r, root: path.resolve(r.path) })).find((r) => full === r.root || full.startsWith(r.root + path.sep));
      if (!repo) throw new Error('That folder is not inside any of the microservices of your list');
      const rel = path.relative(repo.root, full).split(path.sep).join('/');
      if (!rel) throw new Error(`That is the root of ${repo.name}: choose a folder inside it`);
      return { folder: cleanFolder(rel), repo: repo.name };
    } catch (e) {
      return { error: e.message };
    }
  });
  // the text of a file of the list (to compare a microservice's copy with the documentation's)
  ipcMain.handle('an-read', async (_, repoPath, rel) => {
    try {
      const file = listedFile(repoPath, rel);
      const stat = await fs.promises.stat(file);
      if (stat.size > MAX_FILE_BYTES) throw new Error('Too big to read (over 5 MB)');
      return { text: await fs.promises.readFile(file, 'utf8') };
    } catch (e) {
      return { error: e.message };
    }
  });
  // a file of the list, opened with the program the system uses for it
  ipcMain.handle('an-open', async (_, repoPath, rel) => {
    try {
      const error = await openPath(listedFile(repoPath, rel));
      return error ? { error } : { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });
}

module.exports = { registerAnalysis, scanSwagger, describe, cleanFolder, cleanFolders, SKIP, DEFAULT_FOLDERS };
