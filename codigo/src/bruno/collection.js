// Reading a Bruno collection from disk, quickly and without the CLI: where the collections of a repository are (every
// folder with a bruno.json, a few levels down), the folders and requests of one in Bruno's order, its environments,
// and what a request will send.
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', '.idea', '.vscode', '.mvn', '.gradle']);
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'connect', 'trace'];
const MAX_DEPTH = 4;

const slash = (p) => p.split(path.sep).join('/');

// -- The collections of a repository: every folder with a bruno.json, a few levels down --
function findCollections(repo) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'bruno.json')) {
      let name = path.basename(dir);
      try {
        name = JSON.parse(fs.readFileSync(path.join(dir, 'bruno.json'), 'utf8')).name || name;
      } catch {
        // its folder's name then
      }
      found.push({ dir, rel: slash(path.relative(repo, dir)), name });
      return; // a collection inside a collection is a folder of it
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
  };
  walk(repo, 0);
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

// -- .bru files: blocks `name {` ... `}` at the start of a line. Text blocks (a body, a script, tests, docs) are kept
// as their text; the others are read as `key: value` lines, a ~ before the key for one switched off. --
function bruBlocks(text) {
  const out = {};
  let name = null;
  let lines = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (name === null) {
      const m = line.match(/^([a-z][\w:-]*)\s*[{[]\s*$/i);
      if (m) {
        name = m[1];
        lines = [];
      }
    } else if (line === '}' || line === ']') {
      out[name] = lines.map((l) => l.replace(/^ {2}/, '')).join('\n');
      name = null;
    } else lines.push(line);
  }
  return out;
}

function bruPairs(block) {
  if (block === undefined) return [];
  return block
    .split('\n')
    .map((line) => line.match(/^(~?)([^:\s][^:]*?):\s?(.*)$/))
    .filter(Boolean)
    .map(([, off, key, value]) => ({ key: key.trim(), value, enabled: !off }));
}

const pairsObject = (block) => Object.fromEntries(bruPairs(block).map((p) => [p.key, p.value]));

function readBru(file) {
  try {
    return bruBlocks(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function requestSummary(file, blocks) {
  const meta = pairsObject(blocks.meta);
  const method = METHODS.find((m) => blocks[m] !== undefined);
  const http = method ? pairsObject(blocks[method]) : {};
  return {
    name: meta.name || path.basename(file, '.bru'),
    seq: Number(meta.seq) || 0,
    method: method ? method.toUpperCase() : meta.type === 'graphql' ? 'GQL' : '?',
    url: http.url || '',
  };
}

// The folders and requests of a collection, as Bruno lists them: folders first, each part in its `seq` order.
function readTree(root, dir = root) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const folders = [];
  const requests = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = slash(path.relative(root, full));
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || (dir === root && e.name === 'environments')) continue;
      const items = readTree(root, full);
      if (!items.length) continue;
      const meta = pairsObject(readBru(path.join(full, 'folder.bru')).meta);
      folders.push({ type: 'folder', name: meta.name || e.name, seq: Number(meta.seq) || 0, path: rel, items });
    } else if (e.isFile() && e.name.endsWith('.bru') && e.name !== 'folder.bru' && e.name !== 'collection.bru') {
      requests.push({ type: 'request', path: rel, ...requestSummary(full, readBru(full)) });
    }
  }
  const order = (a, b) => (a.seq || Infinity) - (b.seq || Infinity) || a.name.localeCompare(b.name, undefined, { numeric: true });
  return [...folders.sort(order), ...requests.sort(order)];
}

function readEnvironments(root) {
  const dir = path.join(root, 'environments');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.bru')).map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
  return names.sort().map((name) => {
    const blocks = readBru(path.join(dir, `${name}.bru`));
    const secret = (blocks['vars:secret'] || '').split(/[\n,]/).map((s) => s.trim().replace(/^~/, '')).filter(Boolean);
    return { name, vars: [...bruPairs(blocks.vars), ...secret.map((key) => ({ key, value: '', enabled: true, secret: true }))] };
  });
}

// -- The collection's .env, if it has one: Bruno and its CLI read it, for {{process.env.NAME}} and
// bru.getProcessEnv("NAME"). Its values are shown as the Bruno app shows them: as they are (the CLI masks them in its
// own output and reports, not the app). --
function dotEnvOf(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, '.env'), 'utf8');
  } catch {
    return null;
  }
  const values = new Map(); // a name twice: the last one counts, as in Bruno
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const raw = m[2].trim();
    values.delete(m[1]);
    values.set(m[1], /^(['"`])[\s\S]*\1$/.test(raw) ? raw.slice(1, -1) : raw.replace(/(^|\s+)#.*$/, ''));
  }
  return values;
}

function readDotEnv(root) {
  const values = dotEnvOf(root);
  return values ? { names: [...values].map(([key, value]) => ({ key, value, set: value.length > 0 })) } : null;
}

// What a request will send, from its file: for the page before it is sent.
function requestDetail(file) {
  const blocks = readBru(file);
  const bodyBlock = Object.keys(blocks).find((k) => k.startsWith('body:'));
  const tests = blocks.tests ? blocks.tests.trim() : '';
  return {
    ...requestSummary(file, blocks),
    params: bruPairs(blocks['params:query']),
    pathParams: bruPairs(blocks['params:path']),
    headers: bruPairs(blocks.headers),
    body: bodyBlock ? { mode: bodyBlock.slice(5), text: blocks[bodyBlock] } : null,
    asserts: bruPairs(blocks.assert),
    tests,
    scripts: ['script:pre-request', 'script:post-response'].filter((k) => blocks[k] && blocks[k].trim()).map((k) => k.slice(7)),
    docs: blocks.docs ? blocks.docs.trim() : '',
  };
}

module.exports = { findCollections, readTree, readEnvironments, readDotEnv, requestDetail, bruBlocks, bruPairs, slash };
