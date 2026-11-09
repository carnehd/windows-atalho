// -- The values of a Spring Boot service per environment, for the Values of the Maven page: each key of its
// application.properties / .yml (local) and application-<env>.properties / .yml (dev, sit, prod...), with the value
// each file gives it. Start and Debug then get the values chosen as SPRING_APPLICATION_JSON (over the files).
// The environments of a Helm chart in a k8s folder come too (helm-values.js): each ${NAME} of the files with the
// value that environment's chart gives NAME. --
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const helm = require('./helm-values');

const FILE = /^application(?:-([A-Za-z0-9_.-]+))?\.(properties|ya?ml)$/;
// the usual environments first, in the order they go to production; the others after, by name
const ORDER = ['k8s-local', 'dev', 'development', 'local-dev', 'test', 'tst', 'qa', 'int', 'sit', 'stage', 'staging', 'uat', 'preprod', 'preprd', 'pre', 'prod', 'prd', 'production', 'dr'];
// a chart's local environment is a cluster's, not this computer's: named apart from the local of the files
const helmEnvName = (env) => (env === 'local' ? 'k8s-local' : env);
const MAX_KEYS = 2000;

const resourcesOf = (dir) => path.join(dir, 'src', 'main', 'resources');

// The environments a service has files for (local first), and those of the Helm chart of its k8s folder (root: the
// repository, whose k8s folder counts too), without reading them: for the page to know there is a choice.
function listEnvs(dir, root) {
  let names = [];
  try {
    names = fs.readdirSync(resourcesOf(dir));
  } catch {
    return [];
  }
  const envs = new Set();
  for (const n of names) {
    const m = FILE.exec(n);
    if (m) envs.add(m[1] || 'local');
  }
  if (envs.has('local')) for (const e of helm.listHelmEnvs(dir, root)) envs.add(helmEnvName(e));
  return orderEnvs([...envs]);
}

const envRank = (e) => (e === 'local' ? -1 : ORDER.includes(e) ? ORDER.indexOf(e) : ORDER.length);
const orderEnvs = (envs) => envs.sort((a, b) => envRank(a) - envRank(b) || a.localeCompare(b));

// A .properties file as Java reads it: # and ! comments, key=value, key: value or key value, a line ending in \ going
// on, and the escapes (\t \n \uXXXX, \= \: \\...).
function parseProperties(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const unescape = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => {
    if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return { t: '\t', n: '\n', r: '\r', f: '\f' }[c] ?? c;
  });
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^\s+/, '');
    if (!line || line[0] === '#' || line[0] === '!') continue;
    // an odd number of \ at the end: the next line goes on this one
    while (/(?:^|[^\\])(?:\\\\)*\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '');
    let k = 0;
    while (k < line.length && !'=: \t\f'.includes(line[k])) k += line[k] === '\\' ? 2 : 1;
    const key = unescape(line.slice(0, k));
    let rest = line.slice(k).replace(/^[ \t\f]*/, '');
    if (rest[0] === '=' || rest[0] === ':') rest = rest.slice(1).replace(/^[ \t\f]*/, '');
    if (key) out.push([key, unescape(rest)]);
  }
  return out;
}

// A YAML document as Spring flattens it: a.b.c for maps, a[0] for lists; values as text.
function flatten(value, prefix, out) {
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Array.isArray(value) ? value.map((v, i) => [`${prefix}[${i}]`, v]) : Object.entries(value).map(([k, v]) => [prefix ? `${prefix}.${k}` : k, v]);
    if (!entries.length && prefix) out.push([prefix, '']);
    for (const [k, v] of entries) flatten(v, k, out);
  } else if (prefix) out.push([prefix, value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value)]);
  return out;
}

// The documents of a YAML file: one that says spring.config.activate.on-profile (or spring.profiles) is that
// environment's; the others are the file's own.
function parseYaml(text, fileEnv) {
  const docs = [];
  yaml.loadAll(text, (doc) => {
    if (!doc || typeof doc !== 'object') return;
    const pairs = flatten(doc, '', []);
    const on = pairs.find(([k]) => k === 'spring.config.activate.on-profile' || k === 'spring.profiles');
    const env = on && /^[A-Za-z0-9_.-]+$/.test(on[1]) ? on[1] : fileEnv;
    docs.push({ env, pairs: pairs.filter(([k]) => k !== 'spring.config.activate.on-profile' && k !== 'spring.profiles') });
  });
  return docs;
}

// Every key and what each environment's file gives it ({ key: { local: '8081', dev: ... } }), the keys in the order
// the files have them (local first). A file that cannot be read is listed with its error. root: the repository, for
// its k8s folder.
function readEnvValues(dir, root) {
  const res = resourcesOf(dir);
  let names = [];
  try {
    names = fs.readdirSync(res);
  } catch {
    return { files: [], envs: [], keys: [], values: {} };
  }
  const files = [];
  const values = {};
  const keys = [];
  const put = (env, key, value) => {
    if (!(key in values)) {
      if (keys.length >= MAX_KEYS) return;
      values[key] = {};
      keys.push(key);
    }
    values[key][env] = value;
  };
  const found = names.map((n) => [n, FILE.exec(n)]).filter(([, m]) => m);
  // local first, then by environment; of one environment the .yml before the .properties (which Spring puts over it)
  const envOf = (m) => m[1] || 'local';
  found.sort(([a, ma], [b, mb]) => envRank(envOf(ma)) - envRank(envOf(mb)) || envOf(ma).localeCompare(envOf(mb))
    || (ma[2] === 'properties') - (mb[2] === 'properties') || a.localeCompare(b));
  for (const [name, m] of found) {
    const env = envOf(m);
    try {
      const text = fs.readFileSync(path.join(res, name), 'utf8');
      if (m[2] === 'properties') {
        for (const [k, v] of parseProperties(text)) put(env, k, v);
        files.push({ env, file: name });
      } else {
        for (const doc of parseYaml(text, env)) for (const [k, v] of doc.pairs) put(doc.env, k, v);
        files.push({ env, file: name });
      }
    } catch (e) {
      files.push({ env, file: name, error: String(e.message || e).split('\n')[0] });
    }
  }
  if (files.some((f) => f.env === 'local' && !f.error)) addHelmEnvs(dir, root, { files, keys, values });
  const envs = orderEnvs([...new Set([...files.map((f) => f.env), ...keys.flatMap((k) => Object.keys(values[k]))])]);
  return { files, envs, keys, values };
}

// The name of the variable Spring reads for a key (relaxed binding): server.port from SERVER_PORT.
const envNameOf = (key) => key.replace(/\[(\d+)\]/g, '_$1').replace(/-/g, '').replace(/\./g, '_').toUpperCase();

// A value with the ${NAME:default} an environment gives NAME put in; the others as they are (their defaults too).
function resolveWith(text, vars) {
  const s = String(text);
  let out = '';
  let at = 0;
  let i = s.indexOf('${');
  while (i !== -1) {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === '$' && s[j + 1] === '{') {
        depth += 1;
        j += 1;
      } else if (s[j] === '}' && --depth === 0) break;
    }
    if (j >= s.length) break;
    const inner = s.slice(i + 2, j);
    const colon = inner.indexOf(':');
    const name = (colon === -1 ? inner : inner.slice(0, colon)).trim();
    out += s.slice(at, i);
    if (VAR_NAME.test(name) && Object.prototype.hasOwnProperty.call(vars, name)) out += vars[name];
    else out += colon === -1 ? s.slice(i, j + 1) : `\${${inner.slice(0, colon)}:${resolveWith(inner.slice(colon + 1), vars)}}`;
    at = j + 1;
    i = s.indexOf('${', at);
  }
  return out + s.slice(at);
}

// The environments of the Helm chart: for each key, the value of its own file of that environment (dev: application-dev)
// or the local one, with what the chart gives its variables; set only where that changes it, or where the file is the
// environment's own (an environment that sets nothing keeps the local value, in italics).
function addHelmEnvs(dir, root, { files, keys, values }) {
  let charts = [];
  try {
    charts = helm.readHelmEnvs(dir, root);
  } catch (e) {
    files.push({ env: 'k8s', file: 'k8s', error: String(e.message || e).split('\n')[0], helm: true });
    return;
  }
  for (const h of charts) {
    const env = helmEnvName(h.env);
    for (const key of keys) {
      const own = values[key][env];
      const base = own !== undefined ? own : values[key].local;
      if (base === undefined) continue;
      const relaxed = envNameOf(key);
      const got = Object.prototype.hasOwnProperty.call(h.vars, relaxed) ? h.vars[relaxed] : resolveWith(base, h.vars);
      if (got !== base || own !== undefined) values[key][env] = got;
    }
    for (const file of h.files) files.push({ env, file, helm: true, unread: h.unread.slice(0, 20) });
  }
}

// The variables a value reads, as Spring resolves ${NAME:default}: the name up to the first ':', the default up to the
// '}' that closes it (a ${...} in it counted, and read too). Only names a variable can have: ${a.b} reads a key.
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
function placeholdersIn(text, out = []) {
  const s = String(text);
  let i = s.indexOf('${');
  while (i !== -1) {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === '$' && s[j + 1] === '{') {
        depth += 1;
        j += 1;
      } else if (s[j] === '}' && --depth === 0) break;
    }
    if (j >= s.length) break; // never closed: not one
    const inner = s.slice(i + 2, j);
    const colon = inner.indexOf(':');
    const name = (colon === -1 ? inner : inner.slice(0, colon)).trim();
    const def = colon === -1 ? null : inner.slice(colon + 1);
    if (VAR_NAME.test(name)) out.push({ name, def });
    if (def !== null) placeholdersIn(def, out);
    i = s.indexOf('${', j + 1);
  }
  return out;
}

// The variables the files of one environment read (local: application.yml / .properties), in the order the files have
// them: each once, with the first default given (null: none); keys: the keys that read it.
function placeholdersOf(table, env = 'local') {
  const found = new Map();
  for (const key of table.keys || []) {
    const value = table.values[key][env];
    if (value === undefined) continue;
    for (const p of placeholdersIn(value)) {
      const had = found.get(p.name);
      if (!had) found.set(p.name, { name: p.name, def: p.def, keys: [key] });
      else {
        if (had.def === null && p.def !== null) had.def = p.def;
        if (!had.keys.includes(key)) had.keys.push(key);
      }
    }
  }
  return [...found.values()];
}

// The values chosen, as they may go to the app: plain keys, text values, not too many nor too long.
function cleanValues(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const [k, v] of Object.entries(input).slice(0, MAX_KEYS)) {
    if (!/^[A-Za-z0-9_.\-[\]]{1,200}$/.test(k) || v === null || v === undefined) continue;
    out[k] = String(v).slice(0, 4000);
  }
  return Object.keys(out).length ? out : null;
}

// The environment of a spring-boot:run with the values chosen: the app reads SPRING_APPLICATION_JSON over its files.
function withValues(env, values) {
  if (!values) return env;
  return { ...(env || process.env), SPRING_APPLICATION_JSON: JSON.stringify(values) };
}

module.exports = { listEnvs, readEnvValues, parseProperties, placeholdersIn, placeholdersOf, cleanValues, withValues, resolveWith, envNameOf };
