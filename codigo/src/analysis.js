// Analysis page: looks across the microservices of the list. Swagger files: every .yaml / .yml inside a folder
// named "swagger" (at any depth, any case) of each repository, with the title and version from its info: block.
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

async function entries(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// The folders named swagger under a repository (not inside another swagger folder: its files are taken with it).
async function swaggerDirs(root) {
  const found = [];
  const walk = async (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const e of await entries(dir)) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.name.toLowerCase() === 'swagger') found.push(full);
      else await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  return found;
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

async function scanSwagger(repos) {
  const services = [];
  for (const repo of repos) {
    if (!fs.existsSync(repo.path)) {
      services.push({ path: repo.path, name: repo.name, missing: true, dirs: [], files: [] });
      continue;
    }
    const dirs = await swaggerDirs(repo.path);
    const files = [];
    for (const dir of dirs) await yamlFiles(dir, files);
    const rows = [];
    for (const f of files.sort((a, b) => a.localeCompare(b))) {
      const row = await describe(f, repo.path);
      // where it is inside its swagger folder: what a copy elsewhere is matched by
      const dir = dirs.find((d) => f.startsWith(d + path.sep));
      row.inner = path.relative(dir, f).split(path.sep).join('/');
      rows.push(row);
    }
    services.push({ path: repo.path, name: repo.name, dirs: dirs.map((d) => path.relative(repo.path, d).split(path.sep).join('/')), files: rows });
  }
  return services;
}

function registerAnalysis({ listRepos, isKnownRepo, openPath }) {
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
      const services = await scanSwagger(listRepos());
      return { services, took: Date.now() - started };
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

module.exports = { registerAnalysis, scanSwagger, describe, SKIP };
