// A small log explorer: searches logs in a local test file, in Elasticsearch, or in Elasticsearch through
// a Grafana datasource. Credentials live in data/logs-config.json (the data folder is never committed) and
// stay in the main process: the page only gets a summary without secrets.
const fs = require('fs');
const path = require('path');
const { buildTrace } = require('./logs-trace');

const CONFIG_NAME = 'logs-config.json';
const SOURCES = ['local', 'elasticsearch', 'grafana'];

const DEFAULT_CONFIG = {
  _help: [
    'source: "local" (test logs made by the Generate button), "elasticsearch" or "grafana".',
    'Credentials stay in this file, in the data folder, which Git ignores. Do not share it.',
    'Grafana login: "browserLogin": true opens a window with the Grafana (Keycloak) login, like the log-explorer, and keeps',
    '  the session in data/grafana-session.json. Or set grafana.token (a service account token) or grafana.cookie (grafana_session=...).',
    'fields: names of the time, message, level and service fields in your logs (dots for nested fields).',
    'json.* fields: the JSON the application logger writes in the message (json.traceId, json.severity, json.descricao...). The list shows',
    '  json.descricao as the message and json.severity as the level, and json.* works in columns and searches.',
    'kc.* fields: the Keycloak events written as type=LOGIN_ERROR, realmId=..., error=... (kc.type, kc.error...).',
    'defaultColumns: the extra columns shown until you choose your own with + Column.',
    'curlBaseUrl: the address the curl button puts before a request that logged only its path, for example',
    '  "http://api.{env}.example.pt/{service}" ({env} and {service} come from the log). Empty: <host>.',
    'Search syntax: words must all match, "exact phrase", -word to exclude, field:value, * as a wildcard.',
    'watchIntervalSeconds: how often the watches look for new logs. watchNotifications: show a Windows notification.',
    'environments: a name and a search for each environment, like the log-explorer config.json, for example',
    '  "keycloak DEV": "kubernetes.namespace_name:\\"iam-nprod-keycloak\\" AND (message:\\"realmName DEV\\" OR message:\\"deployment.environment dev\\")".',
    'defaultEnvironment: the one chosen when the app starts ("" for all environments). The ones below match the test logs.',
    'gcp: the GCP logs, a second origin next to OpenShift (the index above). index: their index pattern, for example',
    '  "app*,backoffice*,portal*"; localFile: the GCP test logs; fields: their level and service fields;',
    '  environmentField: in GCP the environment is this field, taken from the end of the environment name (keycloak DEV = dev).',
    '  The "sources": { "gcp": ... } part of the log-explorer config.json is read too.',
  ],
  source: 'local',
  maxResults: 200,
  timeoutMs: 15000,
  watchIntervalSeconds: 30,
  watchNotifications: true,
  environments: { DEV: 'env:dev', SIT: 'env:sit', UAT: 'env:uat', PRD: 'env:prd' },
  defaultEnvironment: '',
  fields: { time: '@timestamp', message: 'message', level: 'level', service: 'service' },
  defaultColumns: ['json.traceId', 'json.spanId', 'json.traceparent'],
  curlBaseUrl: '',
  local: { file: 'logs/test-logs.jsonl' },
  gcp: { label: 'GCP', index: '', localFile: 'logs/test-logs-gcp.jsonl', fields: { level: 'severity', service: 'service' }, environmentField: 'environment' },
  elasticsearch: { url: '', index: 'logs-*', username: '', password: '', apiKey: '' },
  grafana: { url: '', orgId: 1, datasourceUid: '', browserLogin: false, token: '', cookie: '', index: 'logs-*' },
};

// ---------- small helpers ----------

// Reads "a.b.c" as a literal key first (Elasticsearch often stores dotted names flat), then as a nested path.
function getField(obj, name) {
  if (!obj || !name) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  let cur = obj;
  for (const part of String(name).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function toMs(value) {
  if (typeof value === 'number') return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function levelOf(raw) {
  const s = String(raw || '').toLowerCase();
  if (/^(error|err|fatal|critical|severe|emerg|alert)$/.test(s)) return 'error';
  if (/^(warn|warning|notice)$/.test(s)) return 'warn';
  if (/^(debug|trace|fine|finer|finest|verbose)$/.test(s)) return 'debug';
  return 'info';
}

// The kind of error a message is: the exception class, or the first line with ids, numbers and quoted
// values replaced by #, so "Payment PAY-1 failed after 5000 ms" and "Payment PAY-2 failed after 5000 ms" match.
function errorTypeOf(message) {
  let first = String(message || '').split(/\r?\n/)[0].trim();
  if (first.startsWith('{')) {
    try {
      const j = JSON.parse(first);
      first = String(j.descricao || j.message || j.msg || j.error || first).split(/\r?\n/)[0].trim();
    } catch {
      // not JSON after all
    }
  }
  // "2026-10-21 20:04:40,646 ERROR [Connector] ..." -> "[Connector] ..."
  first = first.replace(/^\[?\d{4}-\d{2}-\d{2}[ T][\d:.,]+(?:Z|[+-]\d{2}:?\d{2})?\]?\s+(?:(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SEVERE)\s+)?/i, '');
  const ex = /^((?:[a-z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error))\b/.exec(first);
  if (ex) return ex[1];
  const type = first
    .replace(/"[^"]*"|'[^']*'/g, '"…"')
    .replace(/[\w.:@/-]*\d[\w.:@/-]*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return type || '(empty message)';
}

function logText(value) {
  if (value == null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

// "keycloak DEV" -> dev, "PREPRD" -> preprod: the value of the GCP environment field (as the log-explorer does).
const ENV_KEYS = { dev: 'dev', sit: 'sit', uat: 'uat', preprd: 'preprod', preprod: 'preprod', prd: 'prd' };
function envKeyOf(name) {
  const m = /(dev|sit|uat|preprd|preprod|prd)\s*$/i.exec(String(name || ''));
  return m ? ENV_KEYS[m[1].toLowerCase()] : null;
}

// The application logger writes a JSON object in the message (traceId, severity, descricao...). Those are the json.* fields:
// Elasticsearch does not have them as fields, so they are read from the message here.
function messageJson(message) {
  const m = typeof message === 'string' ? message.trim() : '';
  if (!m.startsWith('{') || !m.endsWith('}')) return null;
  try {
    const j = JSON.parse(m);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

// Keycloak events (org.keycloak.events) write type=LOGIN_ERROR, realmId=..., error=... in the text: the kc.*
// fields, read the way the log-explorer does (key=value, key="value", "key":"value" and key: value).
function keycloakEvent(text) {
  const t = String(text || '');
  if (!/realmId/i.test(t) || !/\btype\b/i.test(t)) return null;
  const out = {};
  for (const m of t.matchAll(/"?([A-Za-z_]\w*)"?\s*[=:]\s*(?:"([^"]*)"|([^,\s}\]]+))/g)) {
    const v = m[2] ?? m[3];
    if (!(m[1] in out) && v !== undefined) out[m[1]] = v;
  }
  return out.type && /^[A-Z_]{3,}$/.test(out.type) ? out : null;
}

// A json.* or kc.* field. json.*: from the JSON in the message, else the same field at the top (GCP and test logs
// keep it there). kc.*: from the Keycloak event in the text.
function messageField(src, rec, name, messageName) {
  if (name.startsWith('kc.')) {
    const kc = rec ? rec.kc : keycloakEvent(getField(src, messageName));
    return kc ? kc[name.slice(3)] : undefined;
  }
  const path = name.slice(5);
  const json = rec ? rec.json : messageJson(getField(src, messageName));
  const v = json ? getField(json, path) : undefined;
  return v !== undefined ? v : getField(src, path);
}

function normalize(src, id, fields) {
  const ts = toMs(getField(src, fields.time) ?? src['@timestamp'] ?? src.timestamp);
  const message = getField(src, fields.message) ?? src.message ?? src.log ?? src.msg ?? '';
  const text = typeof message === 'string' ? message : JSON.stringify(message);
  const json = messageJson(text);
  // with the logger's JSON: its severity is the real level, and descricao (with the stack trace) the message
  const levelRaw = (json && json.severity) ?? getField(src, fields.level) ?? src.level ?? src.severity ?? getField(src, 'log.level') ?? '';
  const said = json && [json.descricao, json.message, json.msg, json.errorMessage].find((v) => typeof v === 'string' && v);
  const service = getField(src, fields.service) ?? src.service ?? getField(src, 'kubernetes.pod_name')
    ?? getField(src, 'kubernetes.container_name') ?? src.app ?? '';
  const shown = said ? (json.stackTrace ? `${said}\n${json.stackTrace}` : said) : text;
  const kc = keycloakEvent(shown);
  return {
    id: String(id),
    ts,
    level: levelOf(levelRaw),
    levelRaw: String(levelRaw),
    service: String(service),
    message: shown,
    raw: src,
    ...(json && { json }),
    ...(kc && { kc }),
  };
}

// ---------- local search: same simple syntax as the Elasticsearch query_string we send ----------

// The local search reads the same syntax as the Elasticsearch query_string we send: words are joined by AND,
// OR and NOT (or -word), "exact phrase", field:value, field:(a OR b), ( ) groups and * as a wildcard.
// AND binds tighter than OR, so "a b OR c" is (a AND b) OR c.
function tokenize(q) {
  const tokens = [];
  const s = String(q || '');
  const termRe = /(-?)(?:([A-Za-z_@][\w.@]*):)?(?:"([^"]*)"?|([^\s()"]+))/y;
  const groupRe = /(-?)([A-Za-z_@][\w.@]*):\(/y;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { tokens.push({ t: c }); i++; continue; }
    if (c === '-' && s[i + 1] === '(') { tokens.push({ t: 'NOT' }); i++; continue; }
    groupRe.lastIndex = i;
    let m = groupRe.exec(s);
    if (m) {
      if (m[1]) tokens.push({ t: 'NOT' });
      tokens.push({ t: 'FIELD(', field: m[2] });
      i = groupRe.lastIndex;
      continue;
    }
    termRe.lastIndex = i;
    m = termRe.exec(s);
    if (!m || !m[0]) { i++; continue; }
    i = termRe.lastIndex;
    const quoted = m[3] !== undefined;
    const value = quoted ? m[3] : m[4];
    if (!quoted && !m[1] && !m[2]) {
      if (/^(AND|&&)$/.test(value)) { tokens.push({ t: 'AND' }); continue; }
      if (/^(OR|\|\|)$/.test(value)) { tokens.push({ t: 'OR' }); continue; }
      if (/^(NOT|!)$/.test(value)) { tokens.push({ t: 'NOT' }); continue; }
    }
    if (!value && !m[2]) continue;
    if (m[1]) tokens.push({ t: 'NOT' });
    tokens.push({ t: 'TERM', field: m[2] || null, value: value || '', text: m[0].replace(/^-/, '') });
  }
  return tokens;
}

// Returns a tree of { and: [] }, { or: [] }, { not: node } and { term } nodes, or null for an empty search.
function parseQuery(q) {
  const tokens = tokenize(q);
  let pos = 0;
  const peek = () => tokens[pos];
  const simplify = (kind, items) => (items.length === 1 ? items[0] : items.length ? { [kind]: items } : null);
  function parseOr(field) {
    const items = [];
    let left = parseAnd(field);
    if (left) items.push(left);
    while (peek() && peek().t === 'OR') {
      pos++;
      left = parseAnd(field);
      if (left) items.push(left);
    }
    return simplify('or', items);
  }
  function parseAnd(field) {
    const items = [];
    while (peek() && peek().t !== ')' && peek().t !== 'OR') {
      if (peek().t === 'AND') { pos++; continue; }
      const node = parseUnary(field);
      if (node) items.push(node);
    }
    return simplify('and', items);
  }
  function parseUnary(field) {
    const tk = tokens[pos++];
    if (!tk) return null;
    if (tk.t === 'NOT') {
      const inner = parseUnary(field);
      return inner ? { not: inner } : null;
    }
    if (tk.t === '(' || tk.t === 'FIELD(') {
      const inner = parseOr(tk.t === 'FIELD(' ? tk.field : field);
      if (peek() && peek().t === ')') pos++;
      return inner;
    }
    if (tk.t === ')') return null; // a stray ")" is ignored
    return { term: { ...tk, field: tk.field || field } };
  }
  const tree = parseOr(null);
  // unmatched ")" at the top: read what follows too
  while (pos < tokens.length) {
    pos++;
    const more = parseOr(null);
    if (more) return tree ? { and: [tree, more] } : more;
  }
  return tree;
}

function matcherFor(value) {
  const v = value.toLowerCase();
  if (!v.includes('*') && !v.includes('?')) return (s) => s.includes(v);
  const re = new RegExp(v.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'));
  return (s) => re.test(s);
}

function haystack(obj, out = []) {
  for (const v of Object.values(obj || {})) {
    if (v && typeof v === 'object') haystack(v, out);
    else if (v != null) out.push(String(v));
  }
  return out;
}

function compileQuery(q, fields = DEFAULT_CONFIG.fields) {
  const tree = parseQuery(q);
  if (!tree) return () => true;
  const prepare = (node) => {
    if (node.term) return { term: { ...node.term, test: matcherFor(node.term.value), testText: matcherFor(node.term.text) } };
    if (node.not) return { not: prepare(node.not) };
    if (node.and) return { and: node.and.map(prepare) };
    return { or: node.or.map(prepare) };
  };
  const compiled = prepare(tree);
  return (src, rec) => {
    let all = null;
    const termMatches = (t) => {
      let fieldValue;
      if (t.field && /^(json|kc)\./.test(t.field)) fieldValue = messageField(src, rec, t.field, fields.message);
      else if (t.field) fieldValue = getField(src, fields[t.field] || t.field);
      if (t.field && fieldValue !== undefined) {
        return t.test(String(typeof fieldValue === 'object' ? JSON.stringify(fieldValue) : fieldValue).toLowerCase());
      }
      // a word with a colon that is not a field (a URL, a time) is searched as plain text
      if (all === null) all = haystack(src).join('\n').toLowerCase();
      return t.field ? t.testText(all) : t.test(all);
    };
    const run = (node) => {
      if (node.term) return termMatches(node.term);
      if (node.not) return !run(node.not);
      if (node.and) return node.and.every(run);
      return node.or.some(run);
    };
    return run(compiled);
  };
}

// ---------- remote searches ----------

const ERROR_LEVELS = '(error OR ERROR OR Error OR fatal OR FATAL OR critical OR CRITICAL OR severe OR SEVERE)';
const queryString = (query) => ({ query_string: { query, default_operator: 'AND', analyze_wildcard: true, allow_leading_wildcard: true, lenient: true } });
const esName = (name) => String(name).replace(/([^\w.@])/g, '\\$1');

// json.* and kc.* fields are not in Elasticsearch (they are inside the message), so json.severity:ERROR is searched
// as the phrase "severity ERROR" in the message (the JSON or the key=value text split into words reads like
// that). A json.* field is also looked for at the top, where GCP logs keep it; a kc.* field only in Keycloak events.
function esJsonTerms(query, messageName) {
  return String(query || '').replace(/(^|[\s(])(-?)(json|kc)\.([\w.@]+):(?:"((?:[^"\\]|\\.)*)"|([^\s()"]+))/g, (all, pre, neg, kind, path, quoted, bare) => {
    const msg = esName(messageName);
    const key = path.split('.').pop();
    const inMessage = quoted === undefined && /[*?]/.test(bare) ? `${msg}:${bare}` : `${msg}:"${key} ${quoted ?? bare}"`;
    if (kind === 'kc') return `${pre}${neg}(${inMessage} AND ${msg}:realmId)`; // only Keycloak events carry realmId
    const own = `${esName(path)}:${quoted === undefined ? bare : `"${quoted}"`}`;
    return `${pre}${neg}(${inMessage} OR ${own})`;
  });
}

// filters: { kind: 'query', q } for a watch, { kind: 'field', field, value } for a service tab.
function esBody({ query, from, to, size, fields, filters = [], errorsOnly = false, aggs, sortOrder = 'desc' }) {
  const filter = [{ range: { [fields.time]: { gte: Math.floor(from), lte: Math.ceil(to), format: 'epoch_millis' } } }];
  if (query && query.trim()) filter.push(queryString(esJsonTerms(query, fields.message)));
  for (const f of filters) {
    if (f.kind === 'field') filter.push({ match_phrase: { [f.field]: f.value } });
    else if (f.q && f.q.trim()) filter.push(queryString(esJsonTerms(f.q, fields.message)));
  }
  // an error: the level field, or the severity the application logger writes in the message
  if (errorsOnly) filter.push({ query_string: { query: `${esName(fields.level)}:${ERROR_LEVELS} OR ${esName(fields.message)}:("severity ERROR" OR "severity FATAL")`, lenient: true } });
  return {
    size,
    track_total_hits: true,
    sort: [{ [fields.time]: { order: sortOrder, unmapped_type: 'date' } }],
    query: { bool: { filter } },
    ...(aggs && { aggs }),
  };
}

function describeNetworkError(e, what) {
  const text = `${e?.cause?.code || ''} ${e?.code || ''} ${e?.message || e}`;
  if (e?.name === 'AbortError' || /timed? ?out/i.test(text)) return `${what}: no answer in time (VPN on? right address?)`;
  if (/NAME_NOT_RESOLVED|ENOTFOUND/i.test(text)) return `${what}: the host name does not resolve (VPN on?)`;
  if (/CONNECTION_REFUSED|ECONNREFUSED/i.test(text)) return `${what}: connection refused (service down or wrong port?)`;
  if (/CERT|SSL|certificate/i.test(text)) return `${what}: the TLS certificate is not trusted on this PC`;
  return `${what}: ${String(e?.message || e).slice(0, 200)}`;
}

function shortHost(url) {
  try { return new URL(url).host; } catch { return String(url || ''); }
}

// ---------- test log generator ----------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// liveFrom: only the requests after that time, for the "keep adding test logs" mode.
function generateLogs({ now = Date.now(), seed = now, days = 7, liveFrom = null } = {}) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const int = (a, b) => a + Math.floor(r() * (b - a + 1));
  const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');
  const users = Array.from({ length: 40 }, (_, i) => ({ name: `username${101 + i}`, id: `u-${1001 + i}` }));
  const ips = Array.from({ length: 12 }, () => `10.0.${int(0, 9)}.${int(2, 250)}`);
  const logs = [];
  let env = 'dev';
  const pickEnv = () => { const x = r(); return x < 0.4 ? 'dev' : x < 0.65 ? 'sit' : x < 0.85 ? 'uat' : 'prd'; };
  const add = (ts, level, service, message, extra = {}) => {
    logs.push({ '@timestamp': new Date(ts).toISOString(), level, service, env, host: `${service}-${env}-${hex(5)}`, message, ...extra });
  };
  // GCP logs (written to their own file): severity, service and environment, like services on GCP.
  const addGcp = (ts, severity, service, message, extra = {}) => {
    logs.push({ '@timestamp': new Date(ts).toISOString(), severity, service, environment: env, message, ...extra, _origin: 'gcp' });
  };

  // One request goes through the gateway and one or more services, with the same traceId. Each service
  // has its own spanId and names its caller in parentSpanId; its first line also carries the W3C traceparent
  // it received (00-<traceId>-<caller span>-01). Times add up, so the gateway's "in N ms" is the real total.
  function request(ts, { failPayment = false } = {}) {
    env = failPayment ? 'prd' : pickEnv();
    const traceId = hex(32);
    const u = pick(users);
    const user = u.name;
    const who = { user, userId: u.id };
    const g = hex(16);
    const called = (parent) => ({ traceId, parentSpanId: parent, traceparent: `00-${traceId}-${parent}-01` });
    const kind = r();
    if (kind < 0.3) {
      const a = hex(16);
      add(ts, 'INFO', 'api-gateway', 'Request received POST /api/login', { traceId, spanId: g, method: 'POST', path: '/api/login' });
      const authAt = ts + int(2, 6);
      add(authAt, 'DEBUG', 'auth-service', `Checking the password of user ${user}`, { ...called(g), spanId: a, ...who });
      const authEnd = authAt + int(8, 45);
      const ok = r() > 0.12;
      if (ok) add(authEnd, 'INFO', 'auth-service', `User ${user} logged in`, { traceId, spanId: a, parentSpanId: g, ...who });
      else add(authEnd, 'WARN', 'auth-service', `Invalid password for user ${user} from ${pick(ips)}`, { traceId, spanId: a, parentSpanId: g, ...who });
      const end = authEnd + int(2, 6);
      add(end, 'INFO', 'api-gateway', `POST /api/login ${ok ? 200 : 401} in ${end - ts} ms`, { traceId, spanId: g, method: 'POST', path: '/api/login', status: ok ? 200 : 401 });
      return;
    }
    if (kind < 0.55) {
      const id = int(1000, 99999);
      const o = hex(16);
      add(ts, 'INFO', 'api-gateway', `Request received GET /api/orders/${id}`, { traceId, spanId: g, method: 'GET', path: `/api/orders/${id}` });
      const at = ts + int(1, 4);
      const cached = r() < 0.25;
      const took = cached ? int(1, 4) : int(6, 50);
      add(at + took, 'DEBUG', 'orders-service', cached ? `Order ORD-${id} loaded from cache` : `Order ORD-${id} loaded from the database in ${took} ms`, { ...called(g), spanId: o });
      const end = at + took + int(1, 5);
      add(end, 'INFO', 'api-gateway', `GET /api/orders/${id} 200 in ${end - ts} ms`, { traceId, spanId: g, method: 'GET', path: `/api/orders/${id}`, status: 200 });
      return;
    }
    // New order: gateway -> orders -> payments, then orders -> notifications
    const order = `ORD-${int(10000, 99999)}`;
    const pay = `PAY-${int(10000, 99999)}`;
    const amount = (int(500, 25000) / 100).toFixed(2);
    const o = hex(16);
    const p = hex(16);
    const n = hex(16);
    add(ts, 'INFO', 'api-gateway', 'Request received POST /api/orders', { traceId, spanId: g, method: 'POST', path: '/api/orders' });
    add(ts + 3, 'INFO', 'orders-service', `Order ${order} created for user ${user} (${int(1, 6)} items)`, { ...called(g), spanId: o, ...who, orderId: order });
    const payAt = ts + int(5, 9);
    add(payAt, 'DEBUG', 'payments-service', `Charging ${amount} EUR for ${order} (${pay})`, { ...called(o), spanId: p, paymentId: pay, orderId: order });
    const inOrders = { traceId, spanId: o, parentSpanId: g, orderId: order };
    const inPayments = { traceId, spanId: p, parentSpanId: o, paymentId: pay, orderId: order };
    const b = hex(16);
    const inBank = { traceId, spanId: b, method: 'POST', uri: '/v1/authorise', paymentId: pay };
    addGcp(payAt + 1, 'INFO', 'bank-adapter', 'Request received: POST /v1/authorise', { ...inBank, traceparent: `00-${traceId}-${p}-01` });
    if (failPayment || r() < 0.02) {
      addGcp(payAt + 4998, 'ERROR', 'bank-adapter', 'Bank API did not answer within 4990 ms', inBank);
      addGcp(payAt + 4999, 'ERROR', 'bank-adapter', 'Response fulfilled: 504 in 4998 ms', { ...inBank, status: 504 });
      add(payAt + 5000, 'ERROR', 'payments-service', `Payment ${pay} failed: timeout calling bank gateway after 5000 ms`, inPayments);
      if (r() < 0.3) {
        add(payAt + 5001, 'ERROR', 'payments-service',
          `java.net.SocketTimeoutException: Read timed out\n\tat java.net.SocketInputStream.socketRead0(Native Method)\n\tat com.shop.payments.BankClient.authorise(BankClient.java:88)\n\tat com.shop.payments.PaymentService.pay(PaymentService.java:142)`,
          { traceId, spanId: p, parentSpanId: o, paymentId: pay });
      }
      add(payAt + 5004, 'ERROR', 'orders-service', `Order ${order} could not be paid: payments-service answered 504`, inOrders);
      const end = payAt + 5006 + int(0, 3);
      add(end, 'WARN', 'api-gateway', `POST /api/orders 502 in ${end - ts} ms`, { traceId, spanId: g, method: 'POST', path: '/api/orders', status: 502 });
      return;
    }
    const slow = r() < 0.08;
    const bank = slow ? int(2000, 4500) : int(60, 180);
    if (slow) addGcp(payAt + bank - 20, 'WARNING', 'bank-adapter', `Bank API answered slowly: ${bank - 22} ms`, inBank);
    addGcp(payAt + bank - 2, 'INFO', 'bank-adapter', `Response fulfilled: 200 in ${bank - 3} ms`, { ...inBank, status: 200 });
    if (slow) add(payAt + bank - 5, 'WARN', 'payments-service', `Slow response from bank gateway: ${bank} ms`, inPayments);
    const payEnd = payAt + bank + int(3, 10);
    add(payEnd, 'INFO', 'payments-service', `Payment ${pay} authorised: ${amount} EUR`, inPayments);
    const mailAt = payEnd + int(2, 6);
    add(mailAt, 'DEBUG', 'notification-service', `Sending the order-confirmation email to user ${user}`, { ...called(o), spanId: n, ...who });
    const mailEnd = mailAt + int(30, 140);
    const inMail = { traceId, spanId: n, parentSpanId: o, ...who };
    const e = hex(16);
    const inSender = { traceId, spanId: e, method: 'POST', uri: '/v1/emails' };
    addGcp(mailAt + 1, 'INFO', 'email-sender', 'Request received: POST /v1/emails', { ...inSender, traceparent: `00-${traceId}-${n}-01` });
    if (r() > 0.03) {
      addGcp(mailEnd - 2, 'INFO', 'email-sender', `Response fulfilled: 202 in ${mailEnd - mailAt - 3} ms`, { ...inSender, status: 202 });
      add(mailEnd, 'INFO', 'notification-service', `Email sent to user ${user} (template order-confirmation)`, inMail);
    } else {
      addGcp(mailEnd - 3, 'ERROR', 'email-sender', 'SMTP connection refused (smtp.internal:25)', inSender);
      addGcp(mailEnd - 2, 'ERROR', 'email-sender', `Response fulfilled: 503 in ${mailEnd - mailAt - 3} ms`, { ...inSender, status: 503 });
      add(mailEnd, 'ERROR', 'notification-service', 'Could not send email: SMTP connection refused (smtp.internal:25)', inMail);
    }
    const orderEnd = mailEnd + int(1, 4);
    add(orderEnd, 'INFO', 'orders-service', `Order ${order} completed`, inOrders);
    const end = orderEnd + int(1, 3);
    add(end, 'INFO', 'api-gateway', `POST /api/orders 201 in ${end - ts} ms`, { traceId, spanId: g, method: 'POST', path: '/api/orders', status: 201 });
  }

  // Keycloak as on an OpenShift cluster: the application logger writes a JSON in the message (descricao, severity, traceId,
  // spanId, traceparent, with headers, corpoPedido and corpoResposta kept as JSON text), Keycloak events are text
  // (type=LOGIN_ERROR, realmId=...), and every line has hostname, kubernetes.* and structured.* fields.
  // Keycloak calls a users service on GCP with the W3C trace id of its traceparent, as the real one does.
  const realms = { dev: 'DEV', sit: 'SIT', uat: 'UAT', prd: 'PRD' };
  const realmIds = Object.fromEntries(Object.values(realms).map((n) => [n, `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`]));
  const kcClients = ['portal-web', 'mobile-app', 'backoffice'];
  const kcPod = () => {
    const pod = `keycloak-${env}-${int(0, 2)}`;
    return { pod, host: `worker-${1 + (pod.charCodeAt(pod.length - 1) % 4)}.ocp.example.test`, thread: `executor-thread-${int(1, 40)}` };
  };
  const kcLine = (ts, ctx, level, message, logger, extra = {}) => {
    logs.push({
      '@timestamp': new Date(ts).toISOString(),
      hostname: ctx.host,
      kubernetes: { container_name: 'keycloak', labels: { app: 'keycloak', env }, namespace_name: `iam-keycloak-${env}`, pod_name: ctx.pod },
      level,
      env,
      message,
      structured: { loggerName: logger, threadName: ctx.thread },
      ...extra,
    });
  };
  const kcJson = (ts, ctx, severity, fields) => {
    const json = { timestamp: new Date(ts).toISOString(), severity, traceId: ctx.traceId, spanId: ctx.spanId, traceparent: ctx.traceparent, realmName: ctx.realm, 'deployment.environment': env, ...fields };
    kcLine(ts, ctx, severity === 'WARN' ? 'warning' : severity.toLowerCase(), JSON.stringify(json), fields.class);
  };
  const kcEvent = (type, ctx, u, client, ip, more = '') => `type=${type}, realmId=${realmIds[ctx.realm]}, realmName=${ctx.realm}, clientId=${client}, userId=${u.id}, ipAddress=${ip}${more}, auth_method=openid-connect, grant_type=password, username=${u.name}`;

  function keycloakRequest(ts) {
    env = pickEnv();
    const u = pick(users);
    const client = pick(kcClients);
    const ip = pick(ips);
    const w3c = hex(32);
    const ctx = { ...kcPod(), realm: realms[env], traceId: hex(32), spanId: hex(16), traceparent: `00-${w3c}-${hex(16)}-01` };
    const uri = `/realms/${ctx.realm}/protocol/openid-connect/token`;
    const filter = 'pt.example.keycloak.spi.filter.MdcLoggingFilter';
    const validar = 'pt.example.keycloak.spi.authenticator.v002.ValidarUtilizadorExecutor';
    const srClient = 'pt.example.keycloak.spi.client.UsersClient';
    kcJson(ts, ctx, 'INFO', {
      descricao: `Request received: POST ${uri}`, class: filter, logType: 'REQUEST', uri, method: 'POST',
      headers: JSON.stringify({ 'content-type': 'application/x-www-form-urlencoded', 'user-agent': pick(['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'okhttp/4.12.0', 'Dart/3.4 (dart:io)']), 'x-forwarded-for': ip }),
      corpoPedido: JSON.stringify({ grant_type: 'password', client_id: client, username: u.name, scope: 'openid' }),
    });
    let t = ts + int(2, 8);
    kcJson(t, ctx, 'INFO', { descricao: `ValidarUtilizadorExecutor: a validar utilizador username=${u.name}`, class: validar, logType: 'AUTH' });
    // the users service on GCP
    const out = hex(16);
    const srPath = `/utilizadores/${u.id}`;
    t += int(1, 4);
    kcJson(t, ctx, 'INFO', { descricao: `Invoking operation: [USR-03] GET http://users-service:8080${srPath}`, class: srClient, logType: 'OUTBOUND_REQUEST', operation: 'USR-03', traceparent: `00-${w3c}-${out}-01` });
    const sr = { traceId: w3c, spanId: hex(16), method: 'GET', uri: srPath, operation: 'USR-03' };
    const srFails = r() < 0.05;
    const srTook = int(8, 60);
    addGcp(t + 2, 'INFO', 'users-service', `Request received: GET ${srPath}`, { ...sr, traceparent: `00-${w3c}-${out}-01`, headers: JSON.stringify({ accept: 'application/json', traceparent: `00-${w3c}-${out}-01`, 'x-canal': client }) });
    if (srFails) addGcp(t + srTook - 1, 'ERROR', 'users-service', 'Falha ao ler o utilizador: org.postgresql.util.PSQLException: Connection refused', { ...sr, 'error.type': 'org.postgresql.util.PSQLException' });
    addGcp(t + srTook, srFails ? 'ERROR' : 'INFO', 'users-service', `Response fulfilled: ${srFails ? 500 : 200} in ${srTook - 2} ms`, {
      ...sr, status: srFails ? 500 : 200,
      corpoResposta: JSON.stringify(srFails ? { codigo: 'USR-500', mensagem: 'Erro interno' } : { id: u.id, username: u.name, estado: 'ATIVO', contactos: { email: `${u.name}@example.pt`, telemovel: `91${int(1000000, 9999999)}` } }),
    });
    t += srTook + int(1, 3);
    kcJson(t, ctx, srFails ? 'ERROR' : 'INFO', { descricao: `Received response for operation [USR-03]: ${srFails ? 500 : 200} in ${srTook + 1} ms`, class: srClient, logType: 'OUTBOUND_RESPONSE', operation: 'USR-03', status: srFails ? 500 : 200, duration: srTook + 1 });
    t += int(2, 10);
    const ok = !srFails && r() > 0.15;
    if (srFails) {
      kcJson(t, ctx, 'ERROR', {
        descricao: 'Falha ao validar o utilizador: o users-service respondeu 500', class: validar, logType: 'ERROR',
        stackTrace: `pt.example.keycloak.spi.client.UsersException: HTTP 500 em USR-03\n\tat ${srClient}.obter(UsersClient.java:77)\n\tat ${validar}.authenticate(ValidarUtilizadorExecutor.java:54)`,
      });
    }
    // the Keycloak event, as text (org.keycloak.events), with the trace id at the top like the real ones
    const error = srFails ? 'unknown_error' : pick(['invalid_user_credentials', 'invalid_user_credentials', 'user_not_found', 'user_disabled']);
    kcLine(t + 1, ctx, ok ? 'info' : 'warning', ok ? kcEvent('LOGIN', ctx, u, client, ip) : kcEvent('LOGIN_ERROR', ctx, u, client, ip, `, error=${error}`), 'org.keycloak.events', { traceId: w3c });
    const status = ok ? 200 : srFails ? 500 : 401;
    t += int(2, 5);
    kcJson(t, ctx, ok ? 'INFO' : 'WARN', {
      descricao: `Response fulfilled: ${status} in ${t - ts} ms`, class: filter, logType: 'RESPONSE', uri, method: 'POST', status, duration: t - ts,
      corpoResposta: JSON.stringify(ok ? { token_type: 'Bearer', expires_in: 300, scope: 'openid profile email' } : { error: srFails ? 'unknown_error' : 'invalid_grant', error_description: srFails ? 'Unexpected error' : 'Invalid user credentials' }),
    });
  }

  if (liveFrom != null) {
    for (let ts = liveFrom + int(500, 3000); ts < now; ts += int(2e3, 7e3)) {
      if (r() < 0.3) keycloakRequest(ts);
      else request(ts);
    }
    return logs.filter((l) => { const t = Date.parse(l['@timestamp']); return t > liveFrom && t <= now; })
      .sort((a, b) => a['@timestamp'].localeCompare(b['@timestamp']));
  }
  const start = now - days * 86400e3;
  // Busier in the last 24 hours, so short time ranges have something to show.
  for (let ts = start; ts < now - 86400e3; ts += int(60e3, 600e3)) request(ts);
  for (let ts = now - 86400e3; ts < now - 60e3; ts += int(15e3, 70e3)) request(ts);
  // An incident two hours ago in PRD: the bank gateway stops answering for ten minutes.
  const incident = now - 2 * 3600e3;
  for (let ts = incident; ts < incident + 10 * 60e3; ts += int(4e3, 15e3)) request(ts, { failPayment: true });
  env = 'prd';
  add(incident - 30e3, 'WARN', 'payments-service', 'Bank gateway health check failed (1 of 3)');
  add(incident + 10 * 60e3 + 5e3, 'INFO', 'payments-service', 'Bank gateway health check OK again');
  // Keycloak logins, more of them in the last 24 hours, and its own background lines.
  for (let ts = start + int(1e3, 60e3); ts < now - 86400e3; ts += int(5 * 60e3, 20 * 60e3)) keycloakRequest(ts);
  for (let ts = now - 86400e3 + int(1e3, 30e3); ts < now - 60e3; ts += int(60e3, 240e3)) keycloakRequest(ts);
  for (let ts = start; ts < now; ts += int(40 * 60e3, 120 * 60e3)) {
    env = pickEnv();
    const ctx = kcPod();
    if (r() < 0.15) {
      kcLine(ts, ctx, 'error', 'Uncaught server error: java.lang.NullPointerException: Cannot invoke "org.keycloak.models.UserModel.getId()" because "user" is null', 'org.keycloak.services', { traceId: hex(32) });
    } else {
      kcLine(ts, ctx, 'info', `ISPN000094: Received new cluster view for channel ISPN: [${ctx.pod}-${int(10000, 99999)}|${int(2, 30)}] (3) [keycloak-${env}-0, keycloak-${env}-1, keycloak-${env}-2]`, 'org.infinispan.CLUSTER');
    }
  }
  // Some background noise from every service.
  for (let ts = start; ts < now; ts += int(20 * 60e3, 60 * 60e3)) {
    const service = pick(['api-gateway', 'auth-service', 'orders-service', 'payments-service', 'notification-service']);
    env = pickEnv();
    add(ts, 'DEBUG', service, `Health check OK (heap ${int(180, 620)} MB, ${int(4, 40)} threads busy)`);
  }
  for (let ts = start; ts < now; ts += int(30 * 60e3, 90 * 60e3)) {
    env = pickEnv();
    addGcp(ts, 'DEBUG', pick(['bank-adapter', 'email-sender']), `Instance healthy (${int(1, 4)} of 4 instances busy)`);
  }
  return logs.filter((l) => Date.parse(l['@timestamp']) <= now).sort((a, b) => a['@timestamp'].localeCompare(b['@timestamp']));
}

// ---------- the service ----------

const ORIGINS = ['openshift', 'gcp', 'both'];

// How the app logs in to Grafana: a service account token, a pasted grafana_session cookie, or (browserLogin)
// a login in a window, like the log-explorer, with the requests made inside a Grafana page (grafanaBrowser).
function grafanaAuth(cfg, hasBrowser) {
  const g = cfg.grafana;
  if (g.token) return 'token';
  if (g.cookie) return 'cookie';
  if (g.browserLogin && hasBrowser) return 'browser';
  return 'none';
}

// What logs-config.json still needs before the app can log in to Grafana.
function grafanaMissing(cfg) {
  const g = cfg.grafana || {};
  return [
    ...(cfg.source !== 'grafana' ? [`"source": "grafana" (now "${cfg.source}")`] : []),
    ...(!g.url ? ['grafana.url'] : []),
    ...(!g.datasourceUid ? ['grafana.datasourceUid'] : []),
  ];
}

function cookieHeader(value) {
  const v = String(value || '').trim().replace(/^cookie:\s*/i, '');
  return /=/.test(v) ? v : `grafana_session=${v}`;
}

function loginNeeded(message) {
  const e = new Error(message);
  e.code = 'GRAFANA_LOGIN';
  return e;
}

function createLogsService({ dataDir, fetch, grafanaBrowser = null }) {
  const configFile = path.join(dataDir, CONFIG_NAME);
  const localCache = new Map(); // file -> { mtimeMs, size, records }
  const grafanaRoutes = new Map(); // Grafana base|datasource -> the _msearch route that works there (resources or proxy)
  const ERROR_SAMPLE = 2000;
  const TRACE_WINDOW_MS = 2 * 3600e3;
  const TRACE_MAX_LOGS = 1000;
  const MAX_SERVICES = 30;

  function loadConfig() {
    if (!fs.existsSync(configFile)) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (e) {
      throw new Error(`${CONFIG_NAME} is not valid JSON: ${e.message}`);
    }
    const cfg = { ...DEFAULT_CONFIG, ...raw };
    for (const k of ['fields', 'local', 'elasticsearch', 'grafana']) cfg[k] = { ...DEFAULT_CONFIG[k], ...(raw[k] || {}) };
    for (const k of Object.keys(DEFAULT_CONFIG.fields)) if (!cfg.fields[k]) cfg.fields[k] = DEFAULT_CONFIG.fields[k];
    cfg.defaultColumns = Array.isArray(raw.defaultColumns) ? raw.defaultColumns.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim()).slice(0, 10) : DEFAULT_CONFIG.defaultColumns;
    // GCP: our "gcp" section, or the "sources": { "gcp": { index, environmentField, levelField } } of the log-explorer
    const le = raw.sources && raw.sources.gcp && typeof raw.sources.gcp === 'object' ? raw.sources.gcp : null;
    const g = raw.gcp && typeof raw.gcp === 'object' ? raw.gcp : {};
    cfg.gcp = {
      ...DEFAULT_CONFIG.gcp,
      ...(le && { index: le.index || '', environmentField: le.environmentField || DEFAULT_CONFIG.gcp.environmentField }),
      ...g,
      fields: { ...DEFAULT_CONFIG.gcp.fields, ...(le && le.levelField && { level: le.levelField }), ...(g.fields || {}) },
    };
    const envs = raw.environments && typeof raw.environments === 'object' && !Array.isArray(raw.environments) ? raw.environments : DEFAULT_CONFIG.environments;
    cfg.environments = Object.fromEntries(Object.entries(envs).filter(([name, q]) => name && typeof q === 'string'));
    if (!Object.prototype.hasOwnProperty.call(cfg.environments, cfg.defaultEnvironment)) cfg.defaultEnvironment = '';
    cfg.maxResults = Math.min(Math.max(Number(cfg.maxResults) || 200, 1), 5000);
    cfg.timeoutMs = Math.min(Math.max(Number(cfg.timeoutMs) || 15000, 1000), 120000);
    return cfg;
  }

  const localFile = (cfg) => path.resolve(dataDir, cfg.local.file || DEFAULT_CONFIG.local.file);
  const remoteIndex = (cfg) => (cfg.source === 'elasticsearch' ? cfg.elasticsearch.index : cfg.grafana.index) || '*';

  // The origins a search looks at: OpenShift (the index or file above) and GCP (the gcp section).
  function originSpecs(cfg) {
    const g = cfg.gcp;
    const openshift = { id: 'openshift', label: 'OpenShift', fields: cfg.fields, file: localFile(cfg), index: remoteIndex(cfg) };
    const gcpOn = cfg.source === 'local' ? Boolean(g.localFile) : Boolean(String(g.index || '').trim());
    const gcp = gcpOn ? {
      id: 'gcp',
      label: g.label || 'GCP',
      fields: { ...cfg.fields, ...g.fields },
      file: path.resolve(dataDir, g.localFile || DEFAULT_CONFIG.gcp.localFile),
      index: String(g.index || '').trim(),
      envField: g.environmentField || 'environment',
    } : null;
    return { openshift, gcp };
  }

  function specsFor(cfg, origin) {
    const { openshift, gcp } = originSpecs(cfg);
    const o = ORIGINS.includes(origin) ? origin : 'openshift';
    if (o === 'gcp') {
      if (!gcp) throw new Error(`GCP is not set up: fill in gcp.index in ${CONFIG_NAME}.`);
      return [gcp];
    }
    if (o === 'both') return gcp ? [openshift, gcp] : [openshift];
    return [openshift];
  }

  // What the page may know: no passwords, tokens or keys.
  function info() {
    const base = { configFile };
    let cfg;
    try {
      cfg = loadConfig();
    } catch (e) {
      return { ...base, error: e.message };
    }
    const source = cfg.source;
    const { gcp } = originSpecs(cfg);
    const common = {
      maxResults: cfg.maxResults,
      fields: cfg.fields,
      defaultColumns: cfg.defaultColumns,
      curlBaseUrl: typeof cfg.curlBaseUrl === 'string' ? cfg.curlBaseUrl : '',
      watchIntervalSeconds: Number(cfg.watchIntervalSeconds) || 30,
      environments: Object.keys(cfg.environments),
      defaultEnvironment: cfg.defaultEnvironment,
      origins: { openshift: { label: 'OpenShift' }, gcp: gcp ? { label: gcp.label, fields: gcp.fields } : null },
      grafanaSetup: { missing: grafanaMissing(cfg), token: Boolean(cfg.grafana && cfg.grafana.token) },
    };
    if (source === 'local') {
      const file = localFile(cfg);
      return { ...base, ...common, source, label: 'Local test logs', target: file, exists: fs.existsSync(file) };
    }
    if (source === 'elasticsearch') {
      const e = cfg.elasticsearch;
      return { ...base, ...common, source, label: 'Elasticsearch', target: `${shortHost(e.url)} · ${e.index}${gcp ? ` + ${gcp.index}` : ''}`, configured: Boolean(e.url) };
    }
    if (source === 'grafana') {
      const g = cfg.grafana;
      const auth = grafanaAuth(cfg, Boolean(grafanaBrowser));
      return { ...base, ...common, source, label: 'Grafana', target: `${shortHost(g.url)} · ${g.index}${gcp ? ` + ${gcp.index}` : ''}`, configured: Boolean(g.url && g.datasourceUid), grafanaAuth: auth };
    }
    return { ...base, error: `Unknown source "${source}" in ${CONFIG_NAME}. Use ${SOURCES.join(', ')}.` };
  }

  function readLocal(spec) {
    const file = spec.file;
    if (!fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    const cached = localCache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.origin === spec.id) return cached.records;
    const records = [];
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      try {
        records.push({ ...normalize(JSON.parse(line), `${spec.id}-${i + 1}`, spec.fields), origin: spec.id });
      } catch {
        // a broken line is skipped, the rest still loads
      }
    });
    records.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
    localCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, origin: spec.id, records });
    return records;
  }

  // One POST, inside the Grafana page (browser login) or with fetch; resolves to { status, text }.
  async function postOnce(url, headers, payload, contentType, cfg, what, target) {
    if (target.browser) {
      // inside the Grafana page, with the session of the login window (see grafana-browser.js)
      const r = await grafanaBrowser.request(target.base, url, { method: 'POST', headers: { ...headers, 'content-type': contentType }, body: payload, timeoutMs: cfg.timeoutMs });
      return { status: r.status, text: r.text };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': contentType }, body: payload, signal: controller.signal });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      throw new Error(describeNetworkError(e, what));
    } finally {
      clearTimeout(timer);
    }
  }

  // Grafana takes Elasticsearch searches only through _msearch (a POST to <index>/_search gets 403). Like the
  // log-explorer: the datasource's resources route first, then the older proxy route, and the one that works is kept.
  async function grafanaMsearch(target, body, cfg, what) {
    const payload = `${JSON.stringify({ index: target.index, ignore_unavailable: true })}\n${JSON.stringify(body)}\n`;
    const known = grafanaRoutes.get(target.routeKey);
    let res;
    for (const route of known ? [known] : ['resources', 'proxy']) {
      res = await postOnce(target.routes[route], target.headers, payload, 'application/x-ndjson', cfg, what, target);
      if (known || ![400, 403, 404, 405, 500].includes(res.status)) {
        if (res.status < 300) grafanaRoutes.set(target.routeKey, route);
        break;
      }
    }
    return res;
  }

  async function post(url, headers, body, cfg, what, target = {}) {
    const res = target.msearch
      ? await grafanaMsearch(target, body, cfg, what)
      : await postOnce(url, headers, JSON.stringify(body), 'application/json', cfg, what, target);
    const { text } = res;
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    const isGrafana = cfg.source === 'grafana';
    // a web page instead of data is a login page (Grafana or the proxy in front of it), not "no logs"
    if (isGrafana && res.status < 400 && json == null && /^\s*</.test(String(text || ''))) {
      throw loginNeeded('Grafana answered with its login page: you are not logged in, or the session expired. Press "Log in to Grafana".');
    }
    if (isGrafana && res.status === 401 && target.auth === 'cookie') {
      throw loginNeeded('Grafana no longer accepts the cookie (it expired or is not valid). Press "Log in to Grafana" to paste a new one or log in through a window.');
    }
    if (isGrafana && res.status === 401 && target.auth === 'none') {
      throw loginNeeded('Grafana needs a login: press "Log in to Grafana".');
    }
    if (res.status === 401 || res.status === 403) throw new Error(`${what} refused the request (${res.status}${json?.message ? `: ${json.message}` : ''}). Check the login and the datasource in ${CONFIG_NAME}.`);
    if (res.status === 404) throw new Error(`${what} answered 404: check the address, the index or the datasource uid in ${CONFIG_NAME}.`);
    if (res.status >= 400) throw new Error(`${what} answered ${res.status}: ${json?.error?.reason || json?.message || String(text).slice(0, 200)}`);
    if (target.msearch) {
      const one = (json && json.responses && json.responses[0]) || {};
      if (one.error) throw new Error(`${what}: ${one.error.root_cause?.[0]?.reason || one.error.reason || JSON.stringify(one.error).slice(0, 200)}`);
      return one;
    }
    return json || {};
  }

  function remoteTarget(cfg, index) {
    if (cfg.source === 'elasticsearch') {
      const e = cfg.elasticsearch;
      if (!e.url) throw new Error(`Fill in elasticsearch.url in ${CONFIG_NAME}.`);
      const headers = {};
      if (e.apiKey) headers.Authorization = `ApiKey ${e.apiKey}`;
      else if (e.username) headers.Authorization = `Basic ${Buffer.from(`${e.username}:${e.password || ''}`).toString('base64')}`;
      return { what: 'Elasticsearch', headers, url: `${String(e.url).replace(/\/+$/, '')}/${encodeURIComponent(index)}/_search` };
    }
    const g = cfg.grafana;
    if (!g.url || !g.datasourceUid) throw new Error(`Fill in grafana.url and grafana.datasourceUid in ${CONFIG_NAME}.`);
    const base = String(g.url).replace(/\/+$/, '');
    const auth = grafanaAuth(cfg, Boolean(grafanaBrowser));
    const headers = { 'X-Grafana-Org-Id': String(g.orgId || 1) };
    if (auth === 'token') headers.Authorization = `Bearer ${g.token}`;
    if (auth === 'cookie') headers.Cookie = cookieHeader(g.cookie);
    const uid = encodeURIComponent(g.datasourceUid);
    return {
      what: 'Grafana', headers, base, auth, browser: auth === 'browser', msearch: true, index, routeKey: `${base}|${g.datasourceUid}`,
      routes: { resources: `${base}/api/datasources/uid/${uid}/resources/_msearch`, proxy: `${base}/api/datasources/proxy/uid/${uid}/_msearch` },
    };
  }

  async function remoteSearch(cfg, spec, p, { size, aggs, sortOrder } = {}) {
    const target = remoteTarget(cfg, spec.index);
    const t0 = Date.now();
    const body = esBody({ query: p.query, from: p.from, to: p.to, size, fields: spec.fields, filters: p.filters, errorsOnly: p.errorsOnly, aggs, sortOrder });
    const r = await post(target.url, target.headers, body, cfg, spec.id === 'gcp' ? `${target.what} (${spec.label})` : target.what, target);
    return {
      hits: (r.hits?.hits || []).map((h, i) => ({ ...normalize(h._source || {}, h._id || i, spec.fields), origin: spec.id })),
      total: r.hits?.total?.value ?? r.hits?.total ?? 0,
      took: r.took ?? Date.now() - t0,
      aggregations: r.aggregations,
    };
  }

  // The filters of one origin: the environment (its search in OpenShift, its environment field in GCP),
  // the service tab and the watch tab.
  function filtersFor(cfg, spec, params) {
    const filters = [];
    if (params.env) {
      if (spec.id === 'gcp') {
        const key = envKeyOf(params.env);
        if (key) filters.push({ kind: 'query', q: `${spec.envField}:${key === 'preprod' ? '(preprod OR preprd)' : key}` });
      } else if (cfg.environments[params.env].trim()) {
        filters.push({ kind: 'query', q: cfg.environments[params.env] });
      }
    }
    if (params.service) filters.push({ kind: 'field', field: spec.fields.service, value: params.service });
    if (params.watch) filters.push({ kind: 'query', q: params.watch });
    return filters;
  }

  function prepare(params = {}) {
    const cfg = loadConfig();
    if (!SOURCES.includes(cfg.source)) throw new Error(`Unknown source "${cfg.source}" in ${CONFIG_NAME}. Use ${SOURCES.join(', ')}.`);
    const from = Number(params.from);
    const to = Number(params.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error('Choose a valid time range.');
    const clean = {
      env: params.env ? String(params.env) : '',
      service: params.service ? String(params.service) : '',
      watch: params.watch ? String(params.watch).slice(0, 2000) : '',
    };
    if (clean.env && cfg.environments[clean.env] === undefined) throw new Error(`The environment "${clean.env}" is not in ${CONFIG_NAME} any more. Choose another one.`);
    const specs = specsFor(cfg, params.origin);
    const p = { query: String(params.query || '').slice(0, 2000), from, to, errorType: params.errorType ? String(params.errorType) : '' };
    // one set of search parameters per origin
    const runs = specs.map((spec) => ({ spec, p: { ...p, filters: filtersFor(cfg, spec, clean) } }));
    return { cfg, p, runs, origins: specs.map((s) => s.id) };
  }

  // Every local log of one origin in the range that passes the search and the filters, newest first.
  function localMatches(spec, p) {
    const records = readLocal(spec);
    if (!records) return null;
    const tests = [compileQuery(p.query, spec.fields)];
    for (const f of p.filters) {
      if (f.kind === 'query') tests.push(compileQuery(f.q, spec.fields));
      else tests.push((raw, rec) => (f.field === spec.fields.service ? rec.service : logText(getField(raw, f.field))) === f.value);
    }
    return records.filter((rec) => rec.ts != null && rec.ts >= p.from && rec.ts <= p.to
      && (!p.errorsOnly || rec.level === 'error') && tests.every((t) => t(rec.raw, rec)));
  }

  const newestFirst = (lists) => lists.flat().sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const noLocalLogs = (cfg, runs) => cfg.source === 'local' && runs.every(({ spec }) => !readLocal(spec));

  // Errors are grouped in the app, so for Elasticsearch it looks at the newest ERROR_SAMPLE errors of each origin.
  async function errorList(cfg, runs) {
    const parts = await Promise.all(runs.map(async ({ spec, p }) => {
      if (cfg.source === 'local') return { list: localMatches(spec, { ...p, errorsOnly: true }) || [], sampled: 0 };
      const r = await remoteSearch(cfg, spec, { ...p, errorsOnly: true }, { size: ERROR_SAMPLE });
      return { list: r.hits, sampled: r.total > r.hits.length ? r.hits.length : 0 };
    }));
    return { list: newestFirst(parts.map((x) => x.list)), sampled: parts.reduce((a, x) => a + x.sampled, 0) };
  }

  async function search(params = {}) {
    const { cfg, p, runs, origins } = prepare(params);
    const t0 = Date.now();
    const base = { source: cfg.source, maxResults: cfg.maxResults, origins };
    if (noLocalLogs(cfg, runs)) return { ...base, hits: [], total: 0, took: 0, missing: true };
    if (p.errorType) {
      const { list, sampled } = await errorList(cfg, runs);
      const same = list.filter((h) => errorTypeOf(h.message) === p.errorType);
      return { ...base, hits: same.slice(0, cfg.maxResults), total: same.length, took: Date.now() - t0, sampled };
    }
    if (cfg.source === 'local') {
      const lists = runs.map(({ spec, p: rp }) => localMatches(spec, rp) || []);
      const all = newestFirst(lists);
      return { ...base, hits: all.slice(0, cfg.maxResults), total: all.length, took: Date.now() - t0 };
    }
    const rs = await Promise.all(runs.map(({ spec, p: rp }) => remoteSearch(cfg, spec, rp, { size: cfg.maxResults })));
    return {
      ...base,
      hits: newestFirst(rs.map((r) => r.hits)).slice(0, cfg.maxResults),
      total: rs.reduce((a, r) => a + r.total, 0),
      took: Math.max(0, ...rs.map((r) => r.took)),
    };
  }

  // How many logs each service has for the same search, for the service tabs.
  async function services(params = {}) {
    const { cfg, p, runs } = prepare({ ...params, service: '' });
    const merge = (parts) => {
      const m = new Map();
      for (const { name, count, origin } of parts.flat()) {
        const cur = m.get(name) || { name, count: 0, origin };
        cur.count += count;
        m.set(name, cur);
      }
      return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, MAX_SERVICES);
    };
    const tally = (list) => {
      const m = new Map();
      for (const h of list) if (h.service) m.set(h.service, { name: h.service, origin: h.origin, count: (m.get(h.service)?.count || 0) + 1 });
      return [...m.values()];
    };
    if (p.errorType) {
      const { list, sampled } = await errorList(cfg, runs);
      const same = list.filter((h) => errorTypeOf(h.message) === p.errorType);
      return { services: merge([tally(same)]), total: same.length, sampled };
    }
    if (cfg.source === 'local') {
      const lists = runs.map(({ spec, p: rp }) => localMatches(spec, rp) || []);
      return { services: merge(lists.map(tally)), total: lists.reduce((a, l) => a + l.length, 0) };
    }
    let total = 0;
    let sampled = 0;
    const parts = await Promise.all(runs.map(async ({ spec, p: rp }) => {
      // A terms aggregation on the service field; text fields need their .keyword twin.
      for (const field of [spec.fields.service, `${spec.fields.service}.keyword`]) {
        try {
          const r = await remoteSearch(cfg, spec, rp, { size: 0, aggs: { s: { terms: { field, size: MAX_SERVICES } } } });
          const buckets = r.aggregations?.s?.buckets || [];
          if (buckets.length || r.total === 0) {
            total += r.total;
            return buckets.filter((b) => b.key !== '').map((b) => ({ name: String(b.key), count: b.doc_count, origin: spec.id }));
          }
        } catch (e) {
          if (!/answered 400/.test(e.message)) throw e;
        }
      }
      const r = await remoteSearch(cfg, spec, rp, { size: 1000 });
      total += r.total;
      sampled += r.hits.length;
      return tally(r.hits);
    }));
    return { services: merge(parts), total, ...(sampled && { sampled }) };
  }

  // Errors grouped by kind (see errorTypeOf), the most frequent first.
  async function errorTypes(params = {}) {
    const { cfg, runs } = prepare(params);
    if (noLocalLogs(cfg, runs)) return { types: [], errors: 0, sampled: 0 };
    const { list, sampled } = await errorList(cfg, runs);
    const groups = new Map();
    for (const h of list) {
      const type = errorTypeOf(h.message);
      let g = groups.get(type);
      if (!g) {
        g = { type, count: 0, services: new Map(), sample: h.message, last: h.ts };
        groups.set(type, g);
      }
      g.count++;
      if (h.service) g.services.set(h.service, (g.services.get(h.service) || 0) + 1);
      if (h.ts > g.last) { g.last = h.ts; g.sample = h.message; }
    }
    const types = [...groups.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, 40).map((g) => ({
      type: g.type,
      count: g.count,
      services: [...g.services].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name),
      sample: String(g.sample).slice(0, 300),
      last: g.last,
    }));
    return { types, errors: list.length, sampled };
  }

  // Every log of one request in every origin, two hours either side of the log, as a trace. A request can have
  // more than one id (Keycloak logs its own traceId and the W3C one in traceparent; GCP only knows the W3C one),
  // so the logs with any of them are taken, as the log-explorer does.
  async function trace(params = {}) {
    const cfg = loadConfig();
    const ids = [...new Set([...(Array.isArray(params.traceIds) ? params.traceIds : []), params.traceId].map((x) => String(x || '').trim()).filter(Boolean))];
    if (!ids.length || ids.some((x) => !/^[\w.:-]{6,128}$/.test(x))) throw new Error('This log has no trace id to follow.');
    const id = ids[0];
    const ts = Number(params.ts) || Date.now();
    const p = { query: ids.map((x) => `"${x}"`).join(' OR '), from: ts - TRACE_WINDOW_MS, to: ts + TRACE_WINDOW_MS, filters: [] };
    const specs = specsFor(cfg, 'both');
    const lists = await Promise.all(specs.map(async (spec) => {
      if (cfg.source === 'local') return (localMatches(spec, p) || []).slice(0, TRACE_MAX_LOGS);
      return (await remoteSearch(cfg, spec, p, { size: TRACE_MAX_LOGS, sortOrder: 'asc' })).hits;
    }));
    const hits = lists.flat().sort((a, b) => a.ts - b.ts).slice(0, TRACE_MAX_LOGS);
    return { traceId: id, traceIds: ids, ...buildTrace(hits), origins: specs.map((s) => s.id), truncated: lists.some((l) => l.length >= TRACE_MAX_LOGS), maxLogs: TRACE_MAX_LOGS };
  }

  // For the watches: how many logs match a search in a time window, and the newest one's time.
  async function count(params = {}) {
    const { cfg, runs } = prepare(params);
    let total = 0;
    let newest = null;
    for (const { spec, p } of runs) {
      let n;
      let ts;
      if (cfg.source === 'local') {
        const all = localMatches(spec, p) || [];
        n = all.length;
        ts = all.length ? all[0].ts : null;
      } else {
        const r = await remoteSearch(cfg, spec, p, { size: 1 });
        n = r.total;
        ts = r.hits.length ? r.hits[0].ts : null;
      }
      total += n;
      if (ts != null && (newest == null || ts > newest)) newest = ts;
    }
    return { total, newest };
  }

  // Writes the generated logs to the OpenShift file and, when it is set up, the GCP one.
  function writeTestLogs(cfg, logs, append) {
    const { openshift, gcp } = originSpecs(cfg);
    const out = [[openshift, logs.filter((l) => l._origin !== 'gcp')], ...(gcp ? [[gcp, logs.filter((l) => l._origin === 'gcp')]] : [])];
    const counts = {};
    for (const [spec, list] of out) {
      const lines = list.map(({ _origin, ...l }) => JSON.stringify(l));
      fs.mkdirSync(path.dirname(spec.file), { recursive: true });
      if (append) { if (lines.length) fs.appendFileSync(spec.file, lines.join('\n') + '\n'); }
      else fs.writeFileSync(spec.file, lines.length ? lines.join('\n') + '\n' : '');
      counts[spec.id] = lines.length;
    }
    return counts;
  }

  // "Keep adding test logs": new requests from the newest test log (at most 5 minutes back) until now.
  function appendLiveTestLogs(now = Date.now()) {
    const cfg = loadConfig();
    if (cfg.source !== 'local') return { added: 0, openshift: 0, gcp: 0 };
    const records = readLocal(originSpecs(cfg).openshift);
    if (!records) return { added: 0, openshift: 0, gcp: 0 };
    const newest = records.length && records[0].ts != null ? records[0].ts : now - 60e3;
    const logs = generateLogs({ now, seed: now, liveFrom: Math.max(newest, now - 5 * 60e3) });
    if (!logs.length) return { added: 0, openshift: 0, gcp: 0 };
    const counts = writeTestLogs(cfg, logs, true);
    return { added: Object.values(counts).reduce((a, b) => a + b, 0), openshift: 0, gcp: 0, ...counts };
  }

  // Rewrites logs-config.json with one change, keeping everything else as it is.
  function changeConfig(change) {
    loadConfig(); // creates it when missing and stops on broken JSON
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    change(raw);
    fs.writeFileSync(`${configFile}.tmp`, JSON.stringify(raw, null, 2) + '\n');
    fs.renameSync(`${configFile}.tmp`, configFile);
  }

  async function grafanaUserWithCookie(cfg, cookie) {
    const base = String(cfg.grafana.url || '').replace(/\/+$/, '');
    if (!base) throw new Error(`Fill in grafana.url in ${CONFIG_NAME} first.`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(cfg.timeoutMs, 10000));
    let res;
    let text;
    try {
      res = await fetch(`${base}/api/user`, { headers: { Cookie: cookieHeader(cookie), 'X-Grafana-Org-Id': String(cfg.grafana.orgId || 1) }, signal: controller.signal });
      text = await res.text();
    } catch (e) {
      throw new Error(describeNetworkError(e, 'Grafana'));
    } finally {
      clearTimeout(timer);
    }
    let user = null;
    try { user = JSON.parse(text); } catch { /* a web page: not logged in */ }
    if (res.status === 401 || res.status === 403 || !user || !user.login) throw loginNeeded('Grafana did not accept this cookie. Copy it again from a browser where you are logged in to Grafana.');
    if (res.status >= 400) throw new Error(`Grafana /api/user answered ${res.status}`);
    return { login: user.login, name: user.name, email: user.email };
  }

  async function grafanaCookieLogin(value) {
    const cfg = loadConfig();
    if (cfg.source !== 'grafana') throw new Error(`The cookie is for "source": "grafana" in ${CONFIG_NAME}.`);
    const v = String(value || '').trim().replace(/^cookie:\s*/i, '');
    if (!v) throw new Error('Paste the value of the grafana_session cookie.');
    const user = await grafanaUserWithCookie(cfg, v);
    changeConfig((raw) => { raw.grafana = { ...(raw.grafana || {}), cookie: v }; });
    return { success: true, user };
  }

  function clearGrafanaCookie() {
    changeConfig((raw) => { if (raw.grafana) raw.grafana.cookie = ''; });
    return { success: true };
  }

  // The login state when the app uses a cookie (null when it does not).
  async function grafanaCookieStatus() {
    const cfg = loadConfig();
    if (cfg.source !== 'grafana' || grafanaAuth(cfg, Boolean(grafanaBrowser)) !== 'cookie') return null;
    try {
      return { loggedIn: true, via: 'cookie', user: await grafanaUserWithCookie(cfg, cfg.grafana.cookie) };
    } catch (e) {
      return { loggedIn: false, via: 'cookie', ...(e.code ? {} : { error: e.message }) };
    }
  }

  // The Grafana address when the app logs in through a window (browserLogin), else null.
  function grafanaLoginBase() {
    const cfg = loadConfig();
    if (cfg.source !== 'grafana' || !cfg.grafana.browserLogin || !grafanaBrowser || cfg.grafana.token || !cfg.grafana.url) return null;
    return String(cfg.grafana.url).replace(/\/+$/, '');
  }

  // The login window was asked for: browserLogin is turned on, so the session it gets is used. Returns the address.
  function useBrowserLogin() {
    const cfg = loadConfig();
    const missing = grafanaMissing(cfg);
    if (missing.length) throw new Error(`To log in to Grafana, fill in ${missing.join(', ')} in ${CONFIG_NAME}.`);
    if (cfg.grafana.token) throw new Error(`Grafana uses the token in ${CONFIG_NAME} (grafana.token): there is nothing to log in.`);
    if (!grafanaBrowser) throw new Error('The Grafana login window is not available.');
    if (!cfg.grafana.browserLogin) changeConfig((raw) => { raw.grafana = { ...(raw.grafana || {}), browserLogin: true }; });
    return grafanaLoginBase();
  }

  function settings() {
    const cfg = loadConfig();
    return {
      source: cfg.source,
      watchIntervalMs: Math.min(Math.max(Number(cfg.watchIntervalSeconds) || 30, 5), 3600) * 1000,
      watchNotifications: cfg.watchNotifications !== false,
    };
  }

  function generate({ now = Date.now(), seed } = {}) {
    const cfg = loadConfig();
    const logs = generateLogs({ now, seed: seed ?? now });
    const counts = writeTestLogs(cfg, logs, false);
    localCache.clear();
    return { file: localFile(cfg), count: Object.values(counts).reduce((a, b) => a + b, 0), ...counts, from: Date.parse(logs[0]['@timestamp']), to: Date.parse(logs[logs.length - 1]['@timestamp']) };
  }

  return { info, search, services, errorTypes, trace, count, generate, appendLiveTestLogs, settings, grafanaLoginBase, useBrowserLogin, grafanaCookieLogin, clearGrafanaCookie, grafanaCookieStatus, configFile };
}

module.exports = { createLogsService, generateLogs, parseQuery, compileQuery, esBody, esJsonTerms, normalize, errorTypeOf, envKeyOf, DEFAULT_CONFIG };
