// Analysis page: looks across the microservices of the list. Swagger files: every .yaml / .yml (and the .json that are
// specs) inside the folders to look in of each repository (named "swagger" or "openapi" unless the user chose others)
// and, unless turned off, every file elsewhere that starts as an OpenAPI or Swagger spec (an openapi: or swagger: line
// at the top); with the title and version from its info: block, and a fingerprint of its content.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ipcMain } = require('electron');
const yaml = require('js-yaml');
const { compareSpecs } = require('./api-diff');

// folders that never hold a service's own API definitions, and can be huge
const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', '.idea', '.vscode', '.gradle', '.mvn', 'bin', 'obj', '.next', 'coverage', 'vendor', '.angular', '.cache', 'tmp']);
const MAX_DEPTH = 10;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 2000;
const SPEC_FILE = /\.(ya?ml|json)$/i;
const JSON_FILE = /\.json$/i;
// outside the folders: how many files are looked into per repository, and how much of each
const MAX_LOOKED = 5000;
const HEAD_BYTES = 8192;
const YAML_HEAD = /^['"]?(openapi|swagger)['"]?[ \t]*:/m;
const JSON_HEAD = /"(openapi|swagger)"\s*:\s*"/;
// where the swagger files are looked for: a folder name (at any depth, any case, with or without a final s) or a path
// from the root of each repository; the user may change them on the page
const DEFAULT_FOLDERS = ['swagger', 'openapi'];
const MAX_FOLDERS = 30;
const MAX_DIFFS = 300;

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

// swagger and swaggers, api and apis: the same folder name
const nameKey = (name) => name.toLowerCase().replace(/(.)s$/, '$1');

// The folders to look in under a repository: those with one of the names (at any depth; not inside another one: its
// files are taken with it) and those at one of the paths. One inside another counts once.
async function lookDirs(root, folders) {
  const names = new Set(folders.filter((f) => !f.includes('/')).map(nameKey));
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
      if (names.has(nameKey(e.name))) found.push(full);
      else await walk(full, depth + 1);
    }
  };
  if (names.size) await walk(root, 0);
  const sorted = [...new Set(found)].sort((a, b) => a.length - b.length);
  return sorted.filter((d, i) => !sorted.slice(0, i).some((o) => d.startsWith(o + path.sep)));
}

async function specFiles(dir, out, depth = 0) {
  if (depth > 6 || out.length >= MAX_FILES) return out;
  for (const e of await entries(dir)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && !SKIP.has(e.name)) await specFiles(full, out, depth + 1);
    else if (e.isFile() && SPEC_FILE.test(e.name)) out.push(full);
  }
  return out;
}

// The first bytes of a file (enough to tell a spec), '' when it cannot be read.
async function head(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, bytesRead).replace(/^﻿/, '');
  } catch {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// Outside the folders to look in (taken: their files are listed already), the files that start as a spec.
async function specsElsewhere(root, taken) {
  const out = [];
  let left = MAX_LOOKED;
  const walk = async (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const e of await entries(dir)) {
      if (left <= 0 || out.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.') && !taken.has(full)) await walk(full, depth + 1);
      } else if (e.isFile() && SPEC_FILE.test(e.name)) {
        left--;
        const start = await head(full);
        if ((JSON_FILE.test(e.name) ? JSON_HEAD : YAML_HEAD).test(start)) out.push(full);
      }
    }
  };
  await walk(root, 0);
  return out;
}

const text = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// The same content gives the same fingerprint, whatever the order of its keys, its format (YAML or JSON) or its
// comments.
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v;
}
const fingerprint = (doc) => crypto.createHash('sha1').update(JSON.stringify(stable(doc === undefined ? null : doc))).digest('hex').slice(0, 20);

function parse(file, source) {
  if (JSON_FILE.test(file)) return JSON.parse(source);
  try {
    return yaml.load(source, { json: true });
  } catch (e) {
    // several documents in one file: the first one has the info
    if (!/single document/i.test(e.message)) throw e;
    return yaml.loadAll(source, null, { json: true }).find((d) => d && typeof d === 'object');
  }
}

// Name, path, title and version of one file (and what it is: OpenAPI 3.x or Swagger 2.0). A .yaml with neither
// openapi: nor info: is a part of a spec (the models another one points to with $ref). onlySpec: null for a file that
// is no spec at all (a .json of something else).
async function describe(file, root, onlySpec = false) {
  const row = { name: path.basename(file), rel: path.relative(root, file).split(path.sep).join('/'), title: '', version: '', spec: '' };
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_FILE_BYTES) return { ...row, error: 'Too big to read (over 5 MB)' };
    const doc = parse(file, (await fs.promises.readFile(file, 'utf8')).replace(/^﻿/, ''));
    const obj = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
    const info = obj && obj.info && typeof obj.info === 'object' ? obj.info : null;
    if (onlySpec && !(obj && (obj.openapi || obj.swagger || info))) return null;
    row.spec = obj && obj.openapi ? `OpenAPI ${text(obj.openapi)}` : obj && obj.swagger ? `Swagger ${text(obj.swagger)}` : '';
    row.hash = fingerprint(doc);
    if (!info) return row.spec ? { ...row, error: 'No info: in this file' } : { ...row, part: true };
    return { ...row, title: text(info.title), version: text(info.version) };
  } catch (e) {
    return { ...row, error: `Not readable ${JSON_FILE.test(file) ? 'JSON' : 'YAML'}: ${String(e.reason || e.message).split('\n')[0]}` };
  }
}

async function scanSwagger(repos, folders = DEFAULT_FOLDERS, anywhere = true) {
  const services = [];
  for (const repo of repos) {
    if (!fs.existsSync(repo.path)) {
      services.push({ path: repo.path, name: repo.name, missing: true, dirs: [], files: [] });
      continue;
    }
    const dirs = await lookDirs(repo.path, folders);
    const rows = [];
    for (const dir of dirs) {
      for (const f of await specFiles(dir, [])) {
        const row = await describe(f, repo.path, JSON_FILE.test(f));
        if (!row) continue;
        // where it is inside the folder it was found in: what a copy elsewhere is matched by
        row.inner = path.relative(dir, f).split(path.sep).join('/');
        rows.push(row);
      }
    }
    if (anywhere) {
      for (const f of await specsElsewhere(repo.path, new Set(dirs))) {
        const row = await describe(f, repo.path, true);
        if (row) rows.push({ ...row, inner: row.rel, found: 'content' });
      }
    }
    rows.sort((a, b) => a.rel.localeCompare(b.rel));
    services.push({ path: repo.path, name: repo.name, dirs: dirs.map((d) => path.relative(repo.path, d).split(path.sep).join('/')), files: rows.slice(0, MAX_FILES) });
  }
  return services;
}

function registerAnalysis({ listRepos, isKnownRepo, openPath, loadFolders, saveFolders, loadAnywhere, saveAnywhere, pickDir }) {
  const folders = () => {
    const saved = loadFolders ? loadFolders() : null;
    return Array.isArray(saved) ? cleanFolders(saved) : [...DEFAULT_FOLDERS];
  };
  const anywhere = () => (loadAnywhere ? loadAnywhere() !== false : true);
  // a spec file inside one of the repositories of the list, nowhere else
  const listedFile = (repoPath, rel) => {
    if (!isKnownRepo(repoPath)) throw new Error('Unknown repository');
    const file = path.resolve(repoPath, String(rel || ''));
    const inside = path.relative(path.resolve(repoPath), file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !SPEC_FILE.test(file) || !fs.existsSync(file)) throw new Error('File not found');
    return file;
  };
  const readListed = async (repoPath, rel) => {
    const file = listedFile(repoPath, rel);
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_FILE_BYTES) throw new Error('Too big to read (over 5 MB)');
    return fs.promises.readFile(file, 'utf8');
  };
  ipcMain.handle('an-swagger', async () => {
    try {
      const started = Date.now();
      const looked = folders();
      const elsewhere = anywhere();
      const services = await scanSwagger(listRepos(), looked, elsewhere);
      return { services, folders: looked, anywhere: elsewhere, took: Date.now() - started };
    } catch (e) {
      return { error: e.message };
    }
  });
  // The folders to look in, and a new list of them (saved in the app's data); and whether to look outside them.
  ipcMain.handle('an-folders', () => ({ folders: folders(), anywhere: anywhere() }));
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
  ipcMain.handle('an-set-anywhere', (_, on) => {
    saveAnywhere(Boolean(on));
    return { anywhere: anywhere() };
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
      return { text: await readListed(repoPath, rel) };
    } catch (e) {
      return { error: e.message };
    }
  });
  // What differs between the documentation's copy of a spec and the microservice's (Compare APIs with the
  // documentation as the old one): the endpoints only in the microservice (added), only in the documentation
  // (removed) or changed, and the models.
  ipcMain.handle('an-diff', async (_, pairs) => {
    if (!Array.isArray(pairs)) return { error: 'Not a list' };
    const results = [];
    for (const p of pairs.slice(0, MAX_DIFFS)) {
      try {
        const [doc, svc] = await Promise.all([readListed(p.docRepo, p.docRel), readListed(p.svcRepo, p.svcRel)]);
        const r = compareSpecs(doc, svc);
        results.push({
          summary: r.summary,
          endpoints: r.endpoints.slice(0, 100).map((e) => ({ state: e.state, method: e.method, path: e.path, changes: e.changes.length })),
          models: r.models.slice(0, 100).map((m) => ({ state: m.state, name: m.name })),
        });
      } catch (e) {
        results.push({ error: String(e.message).replace(/^Before/, "The documentation's copy").replace(/^After/, "The microservice's copy") });
      }
    }
    return { results };
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
