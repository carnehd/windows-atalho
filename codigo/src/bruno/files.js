// Changing the files of a collection: a request and the environments. They are read and written by Bruno's own code
// (@usebruno/lang, which comes with the CLI), so a file saved here is the file the Bruno app would save: blocks in
// its order, nothing lost (what the page does not change, as docs or settings, stays as it was).
const fs = require('fs');
const path = require('path');
const { shell: electronShell } = require('electron');
const { findCli } = require('./cli');
const { bruBlocks, bruPairs } = require('./collection');

const AUTH_MODES = ['none', 'inherit', 'bearer', 'basic', 'apikey'];
const BODY_TEXT = ['json', 'text', 'xml'];
const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
const VAR_NAME = /^[A-Za-z0-9_.-]{1,80}$/;

let lang = null;

async function findLang() {
  if (lang) return lang;
  const cli = await findCli();
  if (!cli.ok) throw new Error(`${cli.reason} Changing the requests needs it too: ${cli.hint}`);
  let mod;
  try {
    mod = require(require.resolve('@usebruno/lang', { paths: [cli.dir] }));
  } catch {
    mod = null;
  }
  if (!mod || typeof mod.bruToJsonV2 !== 'function' || typeof mod.jsonToBruV2 !== 'function') throw new Error('This Bruno CLI does not bring the parts that write .bru files');
  lang = mod;
  return lang;
}

// A file written whole or not at all: next to it first, then put in its place.
function writeWhole(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const stampOf = (file) => fs.statSync(file).mtimeMs;
const str = (v) => (v === undefined || v === null ? '' : String(v)).replace(/[\r\n]+/g, ' ');
const rows = (list, fields = {}) => (Array.isArray(list) ? list : []).filter((r) => r && str(r.name).trim()).map((r) => ({ name: str(r.name).trim(), value: str(r.value), enabled: r.enabled !== false, ...fields }));

// -- A request: what the page changes, out of Bruno's JSON and back into it --
function editable(json) {
  const http = json.http || {};
  const auth = json.auth || {};
  const body = json.body || {};
  return {
    name: (json.meta && json.meta.name) || '',
    type: (json.meta && json.meta.type) || 'http',
    method: String(http.method || 'get').toUpperCase(),
    url: http.url || '',
    bodyMode: http.body || 'none',
    authMode: http.auth || 'none',
    params: (json.params || []).map((p) => ({ name: p.name, value: p.value, enabled: p.enabled !== false, type: p.type === 'path' ? 'path' : 'query' })),
    headers: (json.headers || []).map((h) => ({ name: h.name, value: h.value, enabled: h.enabled !== false })),
    auth: {
      bearer: { token: (auth.bearer && auth.bearer.token) || '' },
      basic: { username: (auth.basic && auth.basic.username) || '', password: (auth.basic && auth.basic.password) || '' },
      apikey: { key: (auth.apikey && auth.apikey.key) || '', value: (auth.apikey && auth.apikey.value) || '', placement: (auth.apikey && auth.apikey.placement) || 'header' },
    },
    body: {
      json: body.json || '',
      text: body.text || '',
      xml: body.xml || '',
      formUrlEncoded: (body.formUrlEncoded || []).map((r) => ({ name: r.name, value: r.value, enabled: r.enabled !== false })),
      multipartForm: (body.multipartForm || []).map((r) => ({ name: r.name, value: Array.isArray(r.value) ? r.value.join('|') : r.value, enabled: r.enabled !== false, type: r.type === 'file' ? 'file' : 'text' })),
    },
    script: { req: (json.script && json.script.req) || '', res: (json.script && json.script.res) || '' },
    tests: json.tests || '',
    assertions: (json.assertions || []).map((a) => ({ name: a.name, value: a.value, enabled: a.enabled !== false })),
  };
}

function applyEdit(json, e) {
  const method = String(e.method || 'GET').toLowerCase();
  if (!/^[a-z]+$/.test(method)) throw new Error('That method is not one');
  // the name in its meta block (the file keeps its own name); one line
  const name = str(e.name).replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A request needs a name');
  json.meta = { ...(json.meta || {}), name: name.slice(0, 120) };
  json.http ={ ...(json.http || {}), method, url: str(e.url).trim(), body: str(e.bodyMode) || 'none', auth: str(e.authMode) || 'none' };
  json.params = [...rows((e.params || []).filter((p) => p.type !== 'path'), { type: 'query' }), ...rows((e.params || []).filter((p) => p.type === 'path'), { type: 'path' })];
  json.headers = rows(e.headers);
  // the auth of the mode chosen; the others stay only if the file had them
  const auth = { ...(json.auth || {}) };
  const given = e.auth || {};
  if (e.authMode === 'bearer' || auth.bearer) auth.bearer = { token: str(given.bearer && given.bearer.token) };
  if (e.authMode === 'basic' || auth.basic) auth.basic = { username: str(given.basic && given.basic.username), password: str(given.basic && given.basic.password) };
  if (e.authMode === 'apikey' || auth.apikey) {
    const k = given.apikey || {};
    auth.apikey = { key: str(k.key), value: str(k.value), placement: k.placement === 'queryparams' ? 'queryparams' : 'header' };
  }
  json.auth = auth;
  const body = { ...(json.body || {}) };
  const b = e.body || {};
  for (const mode of BODY_TEXT) body[mode] = typeof b[mode] === 'string' ? b[mode].replace(/\r\n/g, '\n') : body[mode];
  body.formUrlEncoded = rows(b.formUrlEncoded);
  body.multipartForm = (Array.isArray(b.multipartForm) ? b.multipartForm : [])
    .filter((r) => r && str(r.name).trim())
    .map((r) => {
      const file = r.type === 'file';
      return { name: str(r.name).trim(), value: file ? str(r.value).split('|').map((f) => f.trim()).filter(Boolean) : str(r.value), enabled: r.enabled !== false, type: file ? 'file' : 'text', contentType: '' };
    });
  json.body = body;
  const script = e.script || {};
  json.script = { ...(json.script || {}), req: String(script.req || '').replace(/\r\n/g, '\n'), res: String(script.res || '').replace(/\r\n/g, '\n') };
  json.tests = String(e.tests || '').replace(/\r\n/g, '\n');
  json.assertions = rows(e.assertions);
  return json;
}

async function readRequest(file) {
  const L = await findLang();
  return { edit: editable(L.bruToJsonV2(fs.readFileSync(file, 'utf8'))), stamp: stampOf(file) };
}

// `stamp`: when the page read it; changed on disk since (another editor, a git pull), it is not written over.
async function saveRequest(file, edit, stamp) {
  const L = await findLang();
  if (!edit || typeof edit !== 'object') throw new Error('Nothing to save');
  if (stamp && Math.abs(stampOf(file) - stamp) > 1) throw new Error('The file changed on disk after it was opened here. Revert to see it as it is now, then change it again.');
  const current = L.bruToJsonV2(fs.readFileSync(file, 'utf8'));
  // an auth this page does not edit (OAuth 2, Digest...) can stay as it is
  if (!AUTH_MODES.includes(edit.authMode) && edit.authMode !== (current.http || {}).auth) throw new Error('That auth is not one this page knows');
  const json = applyEdit(current, edit);
  const text = L.jsonToBruV2(json);
  L.bruToJsonV2(text); // it reads back, or nothing is written
  writeWhole(file, text);
  return readRequest(file);
}

// -- A request as a file: duplicated, moved to another folder, renamed (its name and its file, as Bruno does), sent
// to the Trash. The file of a name: the name without what a file name cannot have. --
const fileNameOf = (name) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^[.\s]+/, '').trim().slice(0, 100) || 'request';
const requestName = (name) => {
  const n = str(name).replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!n) throw new Error('A request needs a name');
  return n;
};
const sameFile = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());

const seqOf = (file) => Number((bruPairs(bruBlocks(fs.readFileSync(file, 'utf8')).meta).find((p) => p.key === 'seq') || {}).value) || 0;

// After the folders in a folder: the seq one past the highest of their folder.bru.
function nextFolderSeq(dir) {
  let max = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try {
      max = Math.max(max, seqOf(path.join(dir, e.name, 'folder.bru')));
    } catch {
      // no folder.bru: not one to count
    }
  }
  return max + 1;
}

// A folder for requests, made where it is not there: `rel` from the top of the collection, a / for one inside
// another (Products/Orders). Each one made has a folder.bru with its name, last among its neighbours, as Bruno makes
// it. Returns the folder, and those made (to take away if what comes next fails).
function makeFolders(root, rel) {
  const names = String(rel || '').split('/').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!names.length) throw new Error('A folder needs a name');
  let dir = root;
  const made = [];
  names.forEach((name, i) => {
    const file = fileNameOf(name);
    if ((i === 0 && file.toLowerCase() === 'environments') || file === 'node_modules') throw new Error(`${file} cannot be a folder of requests: another name`);
    const next = path.join(dir, file);
    if (fs.existsSync(next)) {
      if (!fs.statSync(next).isDirectory()) throw new Error(`There is a file called ${file} there`);
    } else {
      const seq = nextFolderSeq(dir);
      fs.mkdirSync(next);
      made.push(next);
      fs.writeFileSync(path.join(next, 'folder.bru'), `meta {\n  name: ${name.slice(0, 120)}\n  seq: ${seq}\n}\n`);
    }
    dir = next;
  });
  return { dir, made };
}

// After the requests of a folder: the seq one past the highest there.
function nextSeq(dir) {
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.bru') || name === 'folder.bru' || name === 'collection.bru') continue;
    try {
      max = Math.max(max, seqOf(path.join(dir, name)));
    } catch {
      // not one to count
    }
  }
  return max + 1;
}

async function writeRequest(file, json) {
  const L = await findLang();
  const text = L.jsonToBruV2(json);
  L.bruToJsonV2(text); // it reads back, or nothing is written
  writeWhole(file, text);
}

const readJson = async (file) => (await findLang()).bruToJsonV2(fs.readFileSync(file, 'utf8'));
const taken = (target) => new Error(`There is a ${path.basename(target)} in that folder already`);

// A copy next to it, called `name`, last in its folder. Returns its file.
async function duplicateRequest(file, name) {
  const n = requestName(name);
  const target = path.join(path.dirname(file), `${fileNameOf(n)}.bru`);
  if (fs.existsSync(target)) throw taken(target);
  const json = await readJson(file);
  json.meta = { ...(json.meta || {}), name: n, seq: nextSeq(path.dirname(file)) };
  await writeRequest(target, json);
  return target;
}

// Its name and its file's name. Returns its file.
async function renameRequest(file, name) {
  const n = requestName(name);
  const json = await readJson(file);
  const target = path.join(path.dirname(file), `${fileNameOf(n)}.bru`);
  if (!sameFile(target, file) && fs.existsSync(target)) throw taken(target);
  json.meta = { ...(json.meta || {}), name: n };
  await writeRequest(file, json);
  if (target !== file) fs.renameSync(file, target);
  return target;
}

// Into another folder (`dir`, checked by the caller), last there. Returns its file.
async function moveRequest(file, dir) {
  if (sameFile(path.resolve(dir), path.dirname(file))) throw new Error('It is in that folder already');
  const target = path.join(dir, path.basename(file));
  if (fs.existsSync(target)) throw taken(target);
  const json = await readJson(file);
  json.meta = { ...(json.meta || {}), seq: nextSeq(dir) };
  await writeRequest(target, json);
  fs.unlinkSync(file);
  return target;
}

// A copy of a request in the app's own folder of saved requests (data/saved-requests, out of every repository), the
// file as it is. The folder is a Bruno collection of its own (Bruno opens it); a name there already gets a number
// (Reindex 2.bru), unless it is that same request: then it is there already.
function keepRequest(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'bruno.json');
  if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, `${JSON.stringify({ version: '1', name: 'Saved in Git Quick', type: 'collection', ignore: ['node_modules', '.git'] }, null, 2)}\n`);
  const text = fs.readFileSync(file);
  const base = path.basename(file, '.bru');
  for (let n = 1; ; n++) {
    const target = path.join(dir, `${base}${n > 1 ? ` ${n}` : ''}.bru`);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, text);
      return { target, already: false };
    }
    if (fs.readFileSync(target).equals(text)) return { target, already: true };
  }
}

// To the Trash, not deleted: it can come back from there.
async function deleteRequest(file) {
  await electronShell.trashItem(file);
}

// -- Environments: environments/<name>.bru, a variable a line; a secret one keeps its value out of the file (the
// Bruno app holds it), so the page lists it but does not write a value for it --
const envFile = (root, name) => path.join(root, 'environments', `${name}.bru`);

async function readEnvironments(root) {
  const L = await findLang();
  const dir = path.join(root, 'environments');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.bru')).map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
  return names.sort((a, b) => a.localeCompare(b)).map((name) => {
    let json = { variables: [] };
    try {
      json = L.bruToEnvJsonV2(fs.readFileSync(envFile(root, name), 'utf8')) || json;
    } catch {
      // a file Bruno cannot read: listed empty
    }
    return { name, vars: (json.variables || []).map((v) => ({ key: v.name, value: v.secret ? '' : str(v.value), enabled: v.enabled !== false, secret: Boolean(v.secret) })) };
  });
}

// `from`: the name it had (a rename), or none for a new one.
async function saveEnvironment(root, { name, from, vars }) {
  const variables = (Array.isArray(vars) ? vars : []).map((v) => ({ name: v.key, value: v.value, enabled: v.enabled, secret: v.secret }));
  const L = await findLang();
  name = str(name).trim();
  if (!ENV_NAME.test(name)) throw new Error(`"${name}" cannot be an environment name: letters, numbers, spaces, . _ and - (up to 40)`);
  const seen = new Set();
  for (const v of variables) {
    const n = str(v.name).trim();
    if (!n) continue;
    if (!VAR_NAME.test(n)) throw new Error(`"${n}" cannot be a variable name: letters, numbers, . _ and -`);
    if (seen.has(n)) throw new Error(`${n} is there twice`);
    seen.add(n);
  }
  fs.mkdirSync(path.join(root, 'environments'), { recursive: true });
  const target = envFile(root, name);
  const renamed = from && from !== name;
  if ((!from || renamed) && fs.existsSync(target)) throw new Error(`There is already an environment called ${name}`);
  let json = { variables: [] };
  if (from && fs.existsSync(envFile(root, from))) json = L.bruToEnvJsonV2(fs.readFileSync(envFile(root, from), 'utf8')) || json;
  const before = new Map((json.variables || []).map((v) => [v.name, v]));
  json = {
    ...json,
    variables: variables
      .filter((v) => str(v.name).trim())
      .map((v) => {
        const n = str(v.name).trim();
        const old = before.get(n);
        // a secret one as it was in the file (its value is not there)
        if (v.secret || (old && old.secret)) return { ...(old || {}), name: n, value: (old && old.value) || '', enabled: v.enabled !== false, secret: true };
        return { name: n, value: str(v.value), enabled: v.enabled !== false, secret: false };
      }),
  };
  const text = L.envJsonToBruV2(json);
  L.bruToEnvJsonV2(text);
  writeWhole(target, text);
  if (renamed && fs.existsSync(envFile(root, from))) fs.unlinkSync(envFile(root, from));
  return { name };
}

// To the Trash, not deleted: it can come back from there.
async function deleteEnvironment(root, name) {
  const file = envFile(root, str(name));
  if (!ENV_NAME.test(str(name)) || !fs.existsSync(file)) throw new Error('That environment is not there any more');
  await electronShell.trashItem(file);
  return { success: true };
}

module.exports = { readRequest, saveRequest, duplicateRequest, renameRequest, moveRequest, makeFolders, keepRequest, deleteRequest, readEnvironments, saveEnvironment, deleteEnvironment };
