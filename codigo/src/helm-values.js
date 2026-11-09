// -- The environments of a Helm chart in a k8s folder, for the Values of the Maven page: each values-<env>.yaml (or
// <env>/values.yaml) over the chart's values.yaml, and the variables the chart gives the application, as its templates
// say: the data of its ConfigMaps and the env of its Deployments. Only the simple forms are read ({{ .Values.a.b }},
// with | quote, | default, text around it, and a range over a map); a Secret never is. --
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const VALUES_FILE = /^values[-.]([A-Za-z0-9_-]+)\.ya?ml$/;
const ENV_NAME = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_DEPTH = 5;
const MAX_FILES = 400;
const MAX_BYTES = 1024 * 1024;
// the kinds whose variables go to the application
const WORKLOADS = /^(Deployment|StatefulSet|DaemonSet|Job|CronJob|Pod|ReplicaSet)$/;

// The k8s folders that may belong to the service in dir: its own, then those of the folders above it up to root.
function k8sFolders(dir, root) {
  const out = [];
  const top = path.resolve(root || dir);
  let at = path.resolve(dir);
  for (let i = 0; i < 6; i++) {
    const k = path.join(at, 'k8s');
    try {
      if (fs.statSync(k).isDirectory()) out.push(k);
    } catch {
      // none here
    }
    if (at === top || path.dirname(at) === at || !at.startsWith(top)) break;
    at = path.dirname(at);
  }
  return out;
}

// The files under a folder, a few levels down, hidden folders left out.
function walk(dir, depth = 0, out = []) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1, out);
    else if (e.isFile() && out.length < MAX_FILES) out.push(p);
  }
  return out;
}

const readText = (file) => {
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const loadYaml = (file) => {
  const text = readText(file);
  if (text === null) return {};
  try {
    const doc = yaml.load(text);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
};

// The folder of the chart a file belongs to: the nearest with a Chart.yaml, up to the k8s folder; else the k8s folder.
function chartOf(file, k8s) {
  let at = path.dirname(file);
  while (at.startsWith(k8s)) {
    if (fs.existsSync(path.join(at, 'Chart.yaml'))) return at;
    if (at === k8s) break;
    at = path.dirname(at);
  }
  return k8s;
}

// Each environment's values file, by chart: values-<env>.yaml, values.<env>.yaml or <env>/values.yaml.
function envFilesOf(k8s) {
  const found = [];
  for (const file of walk(k8s)) {
    const name = path.basename(file);
    let env = null;
    const m = VALUES_FILE.exec(name);
    if (m) env = m[1];
    else if (/^values\.ya?ml$/.test(name)) {
      const parent = path.dirname(file);
      // a values.yaml in a folder of its own that is not a chart: that folder is the environment
      if (parent !== k8s && !fs.existsSync(path.join(parent, 'Chart.yaml')) && ENV_NAME.test(path.basename(parent))) env = path.basename(parent);
    }
    if (!env || !ENV_NAME.test(env) || /^(schema|default|defaults|common|base)$/i.test(env)) continue;
    found.push({ env, file, chart: chartOf(file, k8s) });
  }
  return found;
}

// The environments a k8s folder has, without reading the files: for the page to know there is a choice.
function listHelmEnvs(dir, root) {
  const envs = new Set();
  for (const k8s of k8sFolders(dir, root)) for (const f of envFilesOf(k8s)) envs.add(f.env);
  return [...envs];
}

// values.yaml with the environment's file over it, as Helm merges them: maps into maps, the rest replaced.
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
  return out;
}

const valueAt = (values, dotted) => dotted.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), values);
const asText = (v) => (v === null || v === undefined ? undefined : typeof v === 'object' ? undefined : String(v));
const unquote = (s) => {
  const t = s.trim();
  if (/^".*"$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  return /^'.*'$/.test(t) ? t.slice(1, -1).replace(/''/g, "'") : t;
};

// One {{ ... }} action, of the forms read: .Values.a.b, | quote, | default "x", | toString, default "x" .Values.a.b,
// quote .Values.a.b. vars: $k / $v of a range. undefined: a form not read.
function action(expr, values, vars = {}) {
  const parts = expr.split('|').map((p) => p.trim()).filter(Boolean);
  let value;
  let known = false;
  const first = parts.shift() || '';
  const head = /^(?:(quote|toString)\s+)?(?:default\s+("(?:[^"\\]|\\.)*"|'[^']*'|[\w.-]+)\s+)?(\.Values(?:\.[A-Za-z0-9_-]+)+|\$[A-Za-z_]\w*)$/.exec(first);
  if (head) {
    known = true;
    value = head[3].startsWith('$') ? vars[head[3]] : asText(valueAt(values, head[3].slice('.Values.'.length)));
    if ((value === undefined || value === '') && head[2] !== undefined) value = unquote(head[2]);
  } else if (/^("(?:[^"\\]|\\.)*"|'[^']*')$/.test(first)) {
    known = true;
    value = unquote(first);
  }
  if (!known) return undefined;
  for (const p of parts) {
    const d = /^default\s+("(?:[^"\\]|\\.)*"|'[^']*'|[\w.-]+)$/.exec(p);
    if (d) {
      if (value === undefined || value === '') value = unquote(d[1]);
    } else if (!/^(quote|squote|toString|trim)$/.test(p)) return undefined;
  }
  return value === undefined ? null : value;
}

// A value of a template line: plain text, or text with {{ }} in it. undefined: not read; null: given nothing.
function evaluate(raw, values, vars) {
  const text = raw.trim().replace(/\s+#.*$/, '');
  if (!text.includes('{{')) return unquote(text);
  let out = '';
  let at = 0;
  const re = /\{\{-?\s*(.*?)\s*-?\}\}/g;
  let m;
  const outer = /^"(.*)"$/.test(text) ? text.slice(1, -1) : text;
  while ((m = re.exec(outer))) {
    const got = action(m[1], values, vars);
    if (got === undefined) return undefined;
    out += outer.slice(at, m.index) + (got === null ? '' : got);
    at = m.index + m[0].length;
  }
  out += outer.slice(at);
  return out;
}

// The variables the templates of a chart give the application, with one environment's values: { NAME: text }, and
// the names that are there in a form not read.
function varsOf(chart, values) {
  const vars = {};
  const unread = new Set();
  const templates = walk(path.join(chart, 'templates')).filter((f) => /\.(ya?ml|tpl)$/.test(f));
  for (const file of templates) {
    const text = readText(file);
    if (text === null) continue;
    for (const doc of text.split(/^---\s*$/m)) {
      const kind = (/^kind:\s*["']?(\w+)/m.exec(doc) || [])[1];
      if (!kind || kind === 'Secret') continue;
      const lines = doc.split('\n');
      if (kind === 'ConfigMap') readData(lines, values, vars, unread);
      else if (WORKLOADS.test(kind)) readEnv(lines, values, vars, unread);
    }
  }
  return { vars, unread: [...unread] };
}

const indentOf = (line) => line.length - line.trimStart().length;

// data: of a ConfigMap: KEY: value lines, and a range over a map of the values.
function readData(lines, values, vars, unread) {
  const at = lines.findIndex((l) => /^data:\s*$/.test(l));
  if (at < 0) return;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (indentOf(line) === 0 && !/^\s*\{\{/.test(line)) break;
    const range = /\{\{-?\s*range\s+\$(\w+)\s*,\s*\$(\w+)\s*:=\s*\.Values\.([\w.-]+)\s*-?\}\}/.exec(line);
    if (range) {
      const body = [];
      for (i += 1; i < lines.length && !/\{\{-?\s*end\s*-?\}\}/.test(lines[i]); i++) body.push(lines[i]);
      const map = valueAt(values, range[3]);
      if (!map || typeof map !== 'object') continue;
      for (const [k, v] of Object.entries(map)) {
        const scope = { [`$${range[1]}`]: k, [`$${range[2]}`]: asText(v) };
        for (const b of body) {
          const kv = /^\s*(.+?):\s(.*)$/.exec(b);
          if (!kv) continue;
          const name = evaluate(kv[1], values, scope);
          const value = evaluate(kv[2], values, scope);
          if (name && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) && value !== undefined && value !== null) vars[name] = value;
        }
      }
      continue;
    }
    if (/^\s*\{\{/.test(line)) continue; // an if, a with...: what is inside is read as it is
    const kv = /^\s+([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (/^[|>]/.test(kv[2].trim())) {
      unread.add(kv[1]);
      continue;
    }
    const value = evaluate(kv[2], values, {});
    if (value === undefined) unread.add(kv[1]);
    else if (value !== null) vars[kv[1]] = value;
  }
}

// env: of a workload: - name: X with value: ...; one with valueFrom (a Secret, a field) is not read.
function readEnv(lines, values, vars, unread) {
  for (let i = 0; i < lines.length; i++) {
    const name = /^\s*-\s*name:\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*$/.exec(lines[i]);
    if (!name) continue;
    const next = lines[i + 1] || '';
    const value = /^\s*value:\s*(.*)$/.exec(next);
    if (value) {
      const got = evaluate(value[1], values, {});
      if (got === undefined) unread.add(name[1]);
      else if (got !== null) vars[name[1]] = got;
      i += 1;
    }
  }
}

// Every environment of the charts of the service in dir: { env, files (relative to root), vars, unread }. The first
// chart that has an environment gives it (the service's own k8s folder before the repository's).
function readHelmEnvs(dir, root) {
  const top = path.resolve(root || dir);
  const out = new Map();
  for (const k8s of k8sFolders(dir, root)) {
    for (const f of envFilesOf(k8s)) {
      if (out.has(f.env)) continue;
      const baseFile = ['values.yaml', 'values.yml'].map((n) => path.join(f.chart, n)).find((p) => fs.existsSync(p) && p !== f.file);
      const values = merge(baseFile ? loadYaml(baseFile) : {}, loadYaml(f.file));
      const { vars, unread } = varsOf(f.chart, values);
      const rel = (p) => path.relative(top, p).split(path.sep).join('/');
      out.set(f.env, { env: f.env, files: [rel(f.file)], vars, unread });
    }
  }
  return [...out.values()];
}

module.exports = { listHelmEnvs, readHelmEnvs, k8sFolders, envFilesOf, varsOf, evaluate, merge };
