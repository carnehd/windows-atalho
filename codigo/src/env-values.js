// -- The values of a Spring Boot service per environment, for the Values of the Maven page: each key of its
// application.properties / .yml (local) and application-<env>.properties / .yml (dev, sit, prod...), with the value
// each file gives it. Start and Debug then get the values chosen as SPRING_APPLICATION_JSON (over the files). --
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const FILE = /^application(?:-([A-Za-z0-9_.-]+))?\.(properties|ya?ml)$/;
// the usual environments first, in the order they go to production; the others after, by name
const ORDER = ['dev', 'development', 'local-dev', 'test', 'qa', 'int', 'sit', 'stage', 'staging', 'uat', 'preprod', 'pre', 'prod', 'production'];
const MAX_KEYS = 2000;

const resourcesOf = (dir) => path.join(dir, 'src', 'main', 'resources');

// The environments a service has files for (local first), without reading them: for the page to know there is a choice.
function listEnvs(dir) {
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
// the files have them (local first). A file that cannot be read is listed with its error.
function readEnvValues(dir) {
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
  const envs = orderEnvs([...new Set([...files.map((f) => f.env), ...keys.flatMap((k) => Object.keys(values[k]))])]);
  return { files, envs, keys, values };
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

module.exports = { listEnvs, readEnvValues, parseProperties, cleanValues, withValues };
