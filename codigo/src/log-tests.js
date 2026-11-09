// Bruno tests from the logs: the requests a service answered, with their payload and their response, become Bruno
// requests that send the same thing again and check that the answer is still the one in the logs. A request is in
// the logs as the application logger writes it at work (a REQUEST line with method, uri, headers and corpoPedido,
// and a RESPONSE line with status and corpoResposta, both with the same traceId and spanId) or as one line with both.
// The logs come from the Logs page's search (logs-service.js); the tests go to a folder of a Bruno collection of a
// repository, written by Bruno's own code (bruno/files.js), and run from the Bruno page.
const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const { findCollections, readEnvironments, readTree, slash } = require('./bruno/collection');
const files = require('./bruno/files');
const { readCodeAnswers } = require('./code-answers');
const variations = require('./log-variations');

const MAX_CASES = 200;
const MAX_CHECKS = 60;
const MAX_TEXT_CHECK = 300;
const MAX_DOCS = 3000;
const TRACE_EXTRA_MS = 15 * 60e3;
const MORE_FOLDER = 'Not in the logs';

// Where the application loggers put each part (the first one found, in the JSON of the message first, then at the top)
const FIELDS = {
  method: ['method', 'httpMethod', 'http.method', 'request.method', 'http.request.method'],
  uri: ['uri', 'url', 'path', 'requestUri', 'requestURI', 'request.uri', 'request.url', 'http.url', 'url.path', 'endpoint'],
  query: ['queryString', 'query', 'url.query'],
  status: ['status', 'statusCode', 'httpStatus', 'responseStatus', 'response.status', 'http.status_code', 'http.response.status_code'],
  payload: ['corpoPedido', 'requestBody', 'request.body', 'payload', 'requestPayload', 'body'],
  response: ['corpoResposta', 'responseBody', 'response.body', 'responsePayload', 'response'],
  headers: ['headers', 'requestHeaders', 'request.headers'],
  traceId: ['traceId', 'trace_id', 'trace.id'],
  spanId: ['spanId', 'span_id', 'span.id'],
  logType: ['logType', 'log.type'],
  duration: ['duration', 'durationMs', 'elapsed', 'took'],
};

// Not a request to test: health checks, API docs, the browser's own
const SKIP_PATH = /^\/(actuator|health|healthz|ready|readyz|live|livez|metrics|prometheus|favicon\.ico|swagger|swagger-ui|v[23]\/api-docs|webjars|error)(\/|$|\.)/i;
// Headers the logs carry that a test does not send again: the transport's, the tracing's, the proxies'
const DROP_HEADER = /^(host|content-length|connection|keep-alive|accept-encoding|user-agent|traceparent|tracestate|x-b3-.*|b3|x-request-id|x-correlation-id|x-forwarded-.*|forwarded|x-real-ip|via|postman-token|cookie|sec-.*|origin|referer|cache-control|pragma|upgrade-insecure-requests|x-amzn-.*|expect)$/i;
const SECRET_HEADER = /^(authorization|proxy-authorization|x-api-key|apikey|api-key|x-auth-token)$/i;
// Keys whose values change from one request to the next (ids, numbers, times, tokens), unless the request sent them
const VOLATILE_KEY = /(^|[._-])(id|uuid|guid|number|numero|nr|ref|reference|token|nonce|signature|etag|hash|version)$|(Id|ID|Uuid|Number|Numero|Ref|Token|At|Date|Time|Timestamp)$|^(date|time|timestamp|created|updated|modified|expires|expiry|now|instant|requestId|traceId|spanId)$|_(at|date|time)$/;
const VOLATILE_VALUE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?|[0-9a-f]{20,}|eyJ[\w-]+\.[\w-]+\.[\w-]*)$/i;
// Keys that name what a request made, for the ids a later request uses in its path
const ID_KEY = /^(id|uuid|guid|key|code|ref|reference|number|numero)$|(Id|ID|_id|Uuid|Number|Code|Ref)$/;

// Reads "a.b.c" as a literal key first, then as a nested path (as logs-service.js does).
function getField(obj, name) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  let cur = obj;
  for (const part of String(name).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// The first of the names a log has, in the JSON of its message, then at its top.
function pick(rec, names) {
  for (const n of names) {
    for (const src of [rec.json, rec.raw]) {
      const v = getField(src, n);
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return undefined;
}

// Like pick, but an empty value counts: corpoPedido "" is a request without a body, not one without a payload logged.
function pickBody(rec, names) {
  for (const n of names) {
    for (const src of [rec.json, rec.raw]) {
      const v = getField(src, n);
      if (v !== undefined && v !== null) return typeof v === 'string' ? v : JSON.stringify(v);
    }
  }
  return undefined;
}

const firstLine = (rec) => String((rec.json && (rec.json.descricao || rec.json.message || rec.json.msg)) || rec.message || '').split('\n')[0].trim();

// What one log says about a request: its part (request, response, both or an outgoing call) and the pieces it has.
function partOf(rec) {
  const text = firstLine(rec);
  const logType = String(pick(rec, FIELDS.logType) || '').toUpperCase();
  if (/OUTBOUND|CLIENT/.test(logType) || /^(Invoking operation|Received response for operation)/i.test(text)) return { kind: 'outbound' };
  const said = text.match(/^Request received:?\s+([A-Z]+)\s+(\S+)/);
  const answered = text.match(/^Response fulfilled:?\s+(\d{3})\b/);
  const method = String(pick(rec, FIELDS.method) || (said && said[1]) || '').toUpperCase();
  let uri = pick(rec, FIELDS.uri) ?? (said && said[2]);
  uri = typeof uri === 'string' ? uri : '';
  const query = pick(rec, FIELDS.query);
  if (uri && typeof query === 'string' && query && !uri.includes('?')) uri += `${query.startsWith('?') ? '' : '?'}${query}`;
  const statusRaw = pick(rec, FIELDS.status) ?? (answered && answered[1]);
  const status = /^\d{3}$/.test(String(statusRaw)) ? Number(statusRaw) : null;
  const response = pickBody(rec, FIELDS.response);
  const payload = pickBody(rec, FIELDS.payload);
  const isResponse = logType === 'RESPONSE' || Boolean(answered);
  const isRequest = logType === 'REQUEST' || Boolean(said);
  let kind = null;
  if (isResponse) kind = 'response';
  else if (isRequest) kind = 'request';
  else if (method && uri && status != null) kind = 'both';
  if (!kind) return { kind: null };
  let headers = pick(rec, FIELDS.headers);
  if (typeof headers === 'string') {
    try {
      headers = JSON.parse(headers);
    } catch {
      headers = null;
    }
  }
  const traceId = pick(rec, FIELDS.traceId);
  const spanId = pick(rec, FIELDS.spanId);
  const duration = Number(pick(rec, FIELDS.duration));
  return {
    kind,
    method: /^[A-Z]{3,7}$/.test(method) ? method : '',
    uri,
    status,
    payload,
    response,
    headers: headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : null,
    traceId: traceId ? String(traceId) : '',
    spanId: spanId ? String(spanId) : '',
    duration: Number.isFinite(duration) ? duration : null,
  };
}

// The requests of the logs, each with its response: a REQUEST line and the RESPONSE line of the same trace and span
// (of the same service) make one, as does a line with both. Returns them oldest first, and what was left out.
function exchangesFrom(records) {
  const sorted = [...records].filter((r) => r && r.ts != null).sort((a, b) => a.ts - b.ts);
  const pending = new Map(); // trace|span -> the requests still without their response, oldest first
  const out = [];
  const left = { noResponse: 0, noRequest: 0, outbound: 0, notTested: 0 };
  const keyOf = (rec, p) => (p.traceId ? `${rec.origin || ''}|${rec.service || ''}|${p.traceId}|${p.spanId}` : '');
  const exchange = (req, reqPart, res, resPart) => ({
    ts: (req || res).ts,
    service: (req || res).service || '',
    origin: (req || res).origin || '',
    method: (reqPart && reqPart.method) || resPart.method,
    uri: (reqPart && reqPart.uri) || resPart.uri,
    headers: (reqPart && reqPart.headers) || resPart.headers || null,
    payload: reqPart ? reqPart.payload : resPart.payload,
    status: resPart.status,
    response: resPart.response,
    duration: resPart.duration,
    traceId: (reqPart && reqPart.traceId) || resPart.traceId,
  });
  for (const rec of sorted) {
    const p = partOf(rec);
    if (p.kind === 'outbound') {
      left.outbound++;
      continue;
    }
    if (!p.kind) continue;
    const key = keyOf(rec, p);
    if (p.kind === 'request') {
      if (!key) {
        left.noResponse++;
        continue;
      }
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push({ rec, p });
      continue;
    }
    // a response, or a line with both: the request of the same trace and span when there is one
    const waiting = key && pending.get(key);
    if (waiting && waiting.length) {
      const i = Math.max(0, waiting.findIndex((w) => !p.uri || !w.p.uri || w.p.uri === p.uri));
      const [{ rec: req, p: reqPart }] = waiting.splice(i, 1);
      if (!waiting.length) pending.delete(key);
      if (p.status == null) continue;
      out.push(exchange(req, reqPart, rec, p));
    } else if (p.method && p.uri && p.status != null) {
      out.push(exchange(null, null, rec, p));
    } else left.noRequest++;
  }
  for (const list of pending.values()) left.noResponse += list.length;
  return { exchanges: out, left };
}

// -- Parts of a request --
function splitUri(uri) {
  let s = String(uri || '').trim();
  const abs = s.match(/^https?:\/\/[^/?#]+/i);
  if (abs) s = s.slice(abs[0].length) || '/';
  if (!s.startsWith('/')) s = `/${s}`;
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  const q = s.indexOf('?');
  return { path: q >= 0 ? s.slice(0, q) : s, query: q >= 0 ? s.slice(q + 1) : '', origin: abs ? abs[0] : '' };
}

const isIdSegment = (seg) => /\d/.test(seg) && /^[\w.~-]+$/.test(seg) && !/^v\d+(\.\d+)?$/i.test(seg);
const templateOf = (p) => p.split('/').map((seg) => (isIdSegment(seg) ? '{id}' : seg)).join('/');

function parseJson(text) {
  if (typeof text !== 'string') return undefined;
  const t = text.trim();
  if (!t || !/^[[{"\d\-tfn]/.test(t)) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

const canonical = (text) => {
  const j = parseJson(text);
  return j !== undefined ? JSON.stringify(j) : String(text || '').trim();
};

const queryPairs = (query) => (query ? query.split('&').filter(Boolean).map((part) => {
  const i = part.indexOf('=');
  const dec = (s) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      return s;
    }
  };
  return i < 0 ? [dec(part), ''] : [dec(part.slice(0, i)), dec(part.slice(i + 1))];
}) : []);

// -- The cases: one per request (method, address, payload) and status, with every time the logs have it --
function casesFrom(exchanges) {
  const byKey = new Map();
  let skipped = 0;
  for (const ex of exchanges) {
    const { path: p, query, origin } = splitUri(ex.uri);
    if (ex.method === 'OPTIONS' || ex.method === 'HEAD' || SKIP_PATH.test(p)) {
      skipped++;
      continue;
    }
    const key = [ex.method, p, query, canonical(ex.payload), ex.status].join('\u0000');
    let c = byKey.get(key);
    if (!c) {
      c = { key, method: ex.method, path: p, query, origin, template: templateOf(p), status: ex.status, service: ex.service, samples: [] };
      byKey.set(key, c);
    }
    c.samples.push(ex);
  }
  const cases = [...byKey.values()].sort((a, b) => a.samples[0].ts - b.samples[0].ts).slice(0, MAX_CASES);
  cases.forEach((c, i) => {
    c.id = `c${i + 1}`;
    c.first = c.samples[0].ts;
    c.last = c.samples[c.samples.length - 1].ts;
    c.rep = c.samples[c.samples.length - 1]; // the newest: its request and response make the test
  });
  return { cases, skipped, more: Math.max(0, byKey.size - MAX_CASES) };
}

// -- What a test checks: the leaves of the response, each by its type and, when it does not change, by its value --
function leavesOf(value, at = [], out = [], inList = false) {
  if (out.length >= MAX_CHECKS * 2) return out;
  if (Array.isArray(value)) {
    out.push({ at, value, type: 'array', inList });
    if (value.length && value[0] !== null && typeof value[0] === 'object') leavesOf(value[0], [...at, 0], out, inList || at.length === 0);
    else if (value.length) out.push({ at: [...at, 0], value: value[0], type: typeOf(value[0]), inList: inList || at.length === 0 });
    return out;
  }
  if (value && typeof value === 'object') {
    if (at.length) out.push({ at, value, type: 'object', inList });
    for (const [k, v] of Object.entries(value)) leavesOf(v, [...at, k], out, inList);
    return out;
  }
  out.push({ at, value, type: typeOf(value), inList });
  return out;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

const deepAt = (obj, at) => at.reduce((v, k) => (v == null ? undefined : v[k]), obj);
const label = (at) => at.reduce((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${k}` : String(k)), '') || 'the answer';
const lastKey = (at) => [...at].reverse().find((k) => typeof k === 'string') || '';

// Every value a request sent, with the keys it was sent under ('/' for a path segment): a response value equal to one
// of them comes from the request. extra: the payloads of the earlier requests whose ids it uses (what they made).
function sentValues(c, extra = []) {
  const out = new Map();
  const add = (v, key) => {
    const k = String(v);
    if (!out.has(k)) out.set(k, new Set());
    out.get(k).add(key);
  };
  for (const seg of c.path.split('/')) if (seg) add(seg, '/');
  for (const [k, v] of queryPairs(c.query)) if (v) add(v, k);
  const walk = (v, key) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, k));
    else if (v !== null && v !== undefined && v !== '') add(v, key);
  };
  for (const payload of [c.rep.payload, ...extra]) walk(parseJson(payload), '');
  return out;
}

// The response's value came from the request: sent under the same key, in the path, or long enough not to be chance.
function echoed(sent, v, key) {
  const keys = v === null ? null : sent.get(String(v));
  return Boolean(keys && (keys.has(key) || keys.has('/') || String(v).length >= 4));
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The ids later requests use in their path: what an earlier request got back (an invoice's id) becomes a variable
// that request sets after it runs (vars:post-response), and the later ones put {{invoiceId}} in their address.
// Only between the cases chosen, in their order. Each value made gets its own variable (two invoices made:
// invoiceId and invoiceId2), so a later request takes the one it used. Returns { sets: id -> [{ name, expr, at }],
// uses: id -> { segment: name }, from: id -> [the cases whose variables it uses] }.
function chainOf(chosen) {
  const sets = new Map();
  const uses = new Map();
  const from = new Map();
  const values = new Map(); // value -> { name, producer }
  const taken = new Set();
  const varName = (c, at) => {
    const key = lastKey(at);
    let base;
    if (key && key.toLowerCase() !== 'id') base = key.replace(/[^\w]/g, '_');
    else {
      const seg = c.template.split('/').filter((x) => x && x !== '{id}' && !/^api$/i.test(x) && !/^v\d+$/i.test(x)).pop() || 'item';
      const one = seg.replace(/ies$/i, 'y').replace(/(ss)$/i, '$1').replace(/s$/i, '');
      base = `${one.replace(/[^A-Za-z0-9]+(.)?/g, (_, ch) => (ch ? ch.toUpperCase() : ''))}Id`;
    }
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
    taken.add(name);
    return name;
  };
  for (const c of chosen) {
    // what this request uses from the earlier ones
    const used = {};
    const producers = new Set();
    c.path.split('/').forEach((seg, i) => {
      const v = seg && isIdSegment(seg) ? values.get(seg) : null;
      if (v) {
        used[i] = v.name;
        producers.add(v.producer);
      }
    });
    if (Object.keys(used).length) {
      uses.set(c.id, used);
      from.set(c.id, [...producers]);
    }
    // what it gives the later ones: the id-like values of its responses (every time the logs have it)
    const body = c.status < 300 ? parseJson(c.rep.response) : undefined;
    if (body === undefined) continue;
    const bodies = c.samples.map((x) => parseJson(x.response));
    const own = new Set([...c.path.split('/'), ...queryPairs(c.query).map(([, v]) => v)]); // what it was asked for, not made
    for (const leaf of leavesOf(body)) {
      if (leaf.inList || !['number', 'string'].includes(leaf.type) || !ID_KEY.test(lastKey(leaf.at)) || leaf.at.some((k) => typeof k === 'number')) continue;
      const fresh = [...new Set(bodies.map((b) => deepAt(b, leaf.at)).filter((x) => x != null).map(String))].filter((v) => isIdSegment(v) && !values.has(v) && !own.has(v));
      if (!fresh.length) continue;
      const expr = `res.body${leaf.at.map((k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join('')}`;
      if (!sets.has(c.id)) sets.set(c.id, []);
      let entry = sets.get(c.id).find((x) => x.expr === expr);
      if (!entry) {
        entry = { name: varName(c, leaf.at), expr, at: leaf.at };
        sets.get(c.id).push(entry);
      }
      for (const v of fresh) values.set(v, { name: entry.name, producer: c });
    }
  }
  // a variable nobody uses is not set; those left are named again in order (invoiceId, invoiceId2...)
  const usedNames = new Set([...uses.values()].flatMap((u) => Object.values(u)));
  const rename = new Map();
  const again = new Set();
  for (const [id, list] of [...sets]) {
    const kept = list.filter((x) => usedNames.has(x.name));
    if (!kept.length) {
      sets.delete(id);
      continue;
    }
    for (const x of kept) {
      const base = x.name.replace(/\d+$/, '');
      let name = base;
      for (let n = 2; again.has(name); n++) name = `${base}${n}`;
      again.add(name);
      rename.set(x.name, name);
      x.name = name;
    }
    sets.set(id, kept);
  }
  for (const u of uses.values()) for (const k of Object.keys(u)) u[k] = rename.get(u[k]) || u[k];
  return { sets, uses, from };
}

// The checks of one case: { fields, values, unchecked: [labels] }, each a line of a Bruno test. chain: { chained: the
// ids its address takes from earlier tests (value -> variable), extra: those tests' payloads, made: the paths it sets
// variables from }.
function checksOf(c, { chained = new Map(), extra = [], made = [] } = {}) {
  const body = parseJson(c.rep.response);
  const text = c.rep.response;
  if (body === undefined) {
    if (!text || !text.trim()) return { fields: [], values: [], unchecked: [], text: null, kind: 'empty' };
    const same = c.samples.every((x) => x.response === text);
    return { fields: [], values: [], unchecked: [], text: same && text.length <= 1000 ? text : null, kind: 'text' };
  }
  const sent = sentValues(c, extra);
  const others = c.samples.slice(0, -1).map((x) => parseJson(x.response));
  const madeAt = new Set(made.map((at) => JSON.stringify(at)));
  const fields = [];
  const values = [];
  const unchecked = [];
  // a text with an id the address took from an earlier test ("Invoice FT 2026/1 is paid already"): the same text
  // with that test's variable in its place
  const withIds = (v) => {
    let parts = [v];
    for (const [id, { variable }] of chained) {
      const re = new RegExp(`(?<![A-Za-z0-9_.])${escRe(id)}(?![A-Za-z0-9_])`);
      parts = parts.flatMap((p) => (typeof p !== 'string' ? [p] : p.split(re).flatMap((x, i) => (i ? [{ variable }, x] : [x]))));
    }
    return parts.length > 1 ? parts.filter((p) => p !== '') : null;
  };
  for (const leaf of leavesOf(body)) {
    if (fields.length + values.length >= MAX_CHECKS) break;
    const name = label(leaf.at);
    const key = lastKey(leaf.at);
    const changes = others.some((o) => JSON.stringify(deepAt(o, leaf.at)) !== JSON.stringify(leaf.value));
    if (leaf.type === 'array') {
      if (leaf.at.length && !leaf.inList && !changes) values.push({ at: leaf.at, name, length: leaf.value.length });
      else fields.push({ at: leaf.at, name, type: 'array' });
      continue;
    }
    if (leaf.type === 'object') {
      fields.push({ at: leaf.at, name, type: 'object' });
      continue;
    }
    const v = leaf.value;
    if (madeAt.has(JSON.stringify(leaf.at))) {
      // what this request makes (the new invoice's id): its type only, a later test uses it
      fields.push({ at: leaf.at, name, type: leaf.type });
      continue;
    }
    const link = v !== null && chained.get(String(v));
    if (link && (JSON.stringify(leaf.at) === JSON.stringify(link.at) || key.toLowerCase() === link.variable.replace(/\d+$/, '').toLowerCase())) {
      values.push({ at: leaf.at, name, variable: link.variable });
      continue;
    }
    const volatile = !echoed(sent, v, key) && (VOLATILE_KEY.test(key) || (typeof v === 'string' && VOLATILE_VALUE.test(v)));
    const template = typeof v === 'string' && !volatile && chained.size ? withIds(v) : null;
    if (!leaf.inList && !changes && template) values.push({ at: leaf.at, name, template });
    else if (!leaf.inList && !changes && !volatile && !(typeof v === 'string' && v.length > MAX_TEXT_CHECK)) values.push({ at: leaf.at, name, value: v });
    else {
      if (v !== null) fields.push({ at: leaf.at, name, type: leaf.type });
      if (!leaf.inList && (changes || volatile)) unchecked.push(name);
    }
  }
  return { fields, values, unchecked, text: null, kind: 'json' };
}

const lit = (v) => JSON.stringify(v);
const atCall = (at) => `at(${at.map(lit).join(', ')})`;

function testsCode(checks) {
  if (checks.kind === 'empty') return '';
  if (checks.kind === 'text') {
    if (checks.text == null) return '';
    return `test("same answer as in the logs", function () {\n  expect(res.getBody()).to.equal(${lit(checks.text)});\n});`;
  }
  const a = (word) => (/^[aeiou]/.test(word) ? 'an' : 'a');
  const lines = ['const body = res.getBody();', 'const at = (...path) => path.reduce((v, k) => (v == null ? undefined : v[k]), body);'];
  if (checks.fields.length) {
    lines.push('', 'test("same fields as in the logs", function () {');
    for (const f of checks.fields) lines.push(`  expect(${atCall(f.at)}, ${lit(f.name)}).to.be.${a(f.type)}(${lit(f.type)});`);
    lines.push('});');
  }
  if (checks.values.length) {
    lines.push('', 'test("same values as in the logs", function () {');
    for (const v of checks.values) {
      if (v.variable) lines.push(`  expect(String(${atCall(v.at)}), ${lit(v.name)}).to.equal(String(bru.getVar(${lit(v.variable)})));`);
      else if (v.template) lines.push(`  expect(${atCall(v.at)}, ${lit(v.name)}).to.equal(${v.template.map((p) => (typeof p === 'string' ? lit(p) : `bru.getVar(${lit(p.variable)})`)).join(' + ')});`);
      else if (v.length !== undefined) lines.push(`  expect(${atCall(v.at)}, ${lit(v.name)}).to.have.lengthOf(${v.length});`);
      else lines.push(`  expect(${atCall(v.at)}, ${lit(v.name)}).to.equal(${lit(v.value)});`);
    }
    lines.push('});');
  }
  return lines.join('\n');
}

const pad = (n) => String(n).padStart(2, '0');
const when = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// The name of a case's test: method, address and status (with a number when two are alike).
function namesOf(cases) {
  const seen = new Map();
  const out = new Map();
  for (const c of cases) {
    const base = `${c.method} ${c.path}${c.query ? `?${c.query}` : ''} (${c.status})`.replace(/\s+/g, ' ').slice(0, 110);
    const n = (seen.get(base.toLowerCase()) || 0) + 1;
    seen.set(base.toLowerCase(), n);
    out.set(c.id, n > 1 ? `${base} ${n}` : base);
  }
  return out;
}

// Its file: the name without what a file name cannot have (the address's / become -).
const fileOf = (name) => `${name.replace(/(^|\d )([A-Z]+) \/ /, '$1$2 root ').replace(/(^|\d )([A-Z]+) \/(?=[\w{])/, '$1$2 ').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim().slice(0, 120) || 'request'}.bru`;

const camel = (header) => header.toLowerCase().replace(/[^a-z0-9]+(.)?/g, (_, ch) => (ch ? ch.toUpperCase() : ''));

// The Bruno request of a case: { json for Bruno's writer, summary for the page }.
function requestOf(c, { name, seq, base, sets, uses, from = new Map() }) {
  const used = uses.get(c.id) || {};
  const segs = c.path.split('/').map((seg, i) => (used[i] ? `{{${used[i]}}}` : seg));
  // the ids its address takes from an earlier test: in its response they are checked against the same variable, where
  // the response has them under the key they came from (id, or invoiceId), not any key with the same number
  const madeAt = new Map((from.get(c.id) || []).flatMap((p) => (sets.get(p.id) || []).map((x) => [x.name, x.at])));
  const chained = new Map(c.path.split('/').map((seg, i) => [seg, used[i] && { variable: used[i], at: madeAt.get(used[i]) || ['id'] }]).filter(([, v]) => v));
  const pathText = segs.join('/');
  const params = queryPairs(c.query).map(([k, v]) => ({ name: k, value: v, enabled: true, type: 'query' }));
  const url = `${String(base || '').replace(/\/+$/, '')}${pathText}${c.query ? `?${c.query}` : ''}`;
  const headers = [];
  const secrets = [];
  let contentType = '';
  for (const [k, v] of Object.entries(c.rep.headers || {})) {
    const value = Array.isArray(v) ? v.join(', ') : String(v);
    if (/^content-type$/i.test(k)) contentType = value;
    if (DROP_HEADER.test(k) || (/^accept$/i.test(k) && value.trim() === '*/*')) continue;
    if (SECRET_HEADER.test(k)) {
      secrets.push(camel(k));
      headers.push({ name: k, value: `{{${camel(k)}}}`, enabled: true });
    } else headers.push({ name: k, value: value.replace(/[\r\n]+/g, ' '), enabled: true });
  }
  const payload = c.rep.payload;
  let mode = 'none';
  const body = {};
  if (payload && payload.trim()) {
    const json = parseJson(payload);
    if (/x-www-form-urlencoded/i.test(contentType)) {
      mode = 'formUrlEncoded';
      const pairs = json && typeof json === 'object' && !Array.isArray(json) ? Object.entries(json).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]) : queryPairs(payload.trim());
      body.formUrlEncoded = pairs.map(([k, v]) => ({ name: k, value: v, enabled: true }));
    } else if (json !== undefined && typeof json === 'object') {
      mode = 'json';
      body.json = JSON.stringify(json, null, 2);
    } else if (/xml/i.test(contentType) || /^\s*</.test(payload)) {
      mode = 'xml';
      body.xml = payload;
    } else {
      mode = 'text';
      body.text = payload;
    }
    if (mode === 'json' && !headers.some((h) => /^content-type$/i.test(h.name))) headers.push({ name: 'content-type', value: 'application/json', enabled: true });
  }
  const checks = checksOf(c, { chained, extra: (from.get(c.id) || []).map((p) => p.rep.payload), made: (sets.get(c.id) || []).map((x) => x.at) });
  const tests = testsCode(checks);
  const response = c.rep.response && c.rep.response.trim() ? c.rep.response : '';
  const pretty = (() => {
    const j = parseJson(response);
    const t = j !== undefined ? JSON.stringify(j, null, 2) : response;
    return t.length > MAX_DOCS ? `${t.slice(0, MAX_DOCS)}\n…` : t;
  })();
  const docs = [
    `Made by QuickDeck from the logs${c.service ? ` of ${c.service}` : ''}: the request of ${when(c.rep.ts)} and its response${c.rep.traceId ? ` (trace ${c.rep.traceId})` : ''}.${c.samples.length > 1 ? ` The logs have it ${c.samples.length} times.` : ''}`,
    ...(Object.keys(used).length ? ['', `Its address uses ${[...new Set(Object.values(used))].map((v) => `{{${v}}}`).join(', ')}: set by an earlier test of this folder, from what it made.`] : []),
    ...(secrets.length ? ['', `${secrets.map((s) => `{{${s}}}`).join(', ')}: the logs do not have it. Set it in the environment.`] : []),
    ...(checks.unchecked.length ? ['', `Not checked by value, as it changes from one request to the next: ${checks.unchecked.slice(0, 20).join(', ')}${checks.unchecked.length > 20 ? '…' : ''}.`] : []),
    ...(pretty ? ['', 'The response in the logs:', '', '```', pretty, '```'] : []),
  ].join('\n');
  const json = {
    meta: { name, type: 'http', seq: String(seq) },
    http: { method: c.method.toLowerCase(), url, body: mode, auth: 'none' },
    params,
    headers,
    body,
    ...(sets.get(c.id) && { vars: { req: [], res: sets.get(c.id).map((s) => ({ name: s.name, value: s.expr, enabled: true })) } }),
    assertions: [{ name: 'res.status', value: `eq ${c.status}`, enabled: true }],
    tests,
    docs,
  };
  return {
    json,
    summary: {
      url,
      values: checks.values.length,
      fields: checks.fields.length,
      kind: checks.kind,
      unchecked: checks.unchecked,
      sets: (sets.get(c.id) || []).map((s) => s.name),
      uses: [...new Set(Object.values(used))],
      secrets,
    },
  };
}

// The address a test puts before the path: the collection's variable for it ({{baseUrl}}), else the host the logs saw.
function baseOptions(collectionDir, cases) {
  const out = [];
  for (const env of readEnvironments(collectionDir)) {
    for (const v of env.vars || []) {
      if (!v.secret && /^https?:\/\//i.test(String(v.value || '').trim()) && !out.some((o) => o.value === `{{${v.key}}}`)) out.push({ value: `{{${v.key}}}`, label: `{{${v.key}}} (${env.name}: ${String(v.value).trim()})`, prefer: /^(base_?url|baseUri|host|url|api_?url)$/i.test(v.key) });
    }
  }
  out.sort((a, b) => Number(b.prefer) - Number(a.prefer));
  for (const c of cases.slice().reverse()) {
    const h = c.rep.headers && Object.entries(c.rep.headers).find(([k]) => /^(x-forwarded-host|host)$/i.test(k));
    const proto = c.rep.headers && Object.entries(c.rep.headers).find(([k]) => /^x-forwarded-proto$/i.test(k));
    const addr = c.origin || (h ? `${proto ? proto[1] : 'http'}://${h[1]}` : '');
    if (addr && !out.some((o) => o.value === addr)) out.push({ value: addr, label: `${addr} (from the logs)` });
  }
  return out.map(({ value, label: l }) => ({ value, label: l }));
}

// The folder of the tests, inside the collection: a relative path without .. (Products/From the logs).
function folderRel(folder) {
  const parts = String(folder || '').split(/[\\/]+/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!parts.length) throw new Error('Choose a folder for the tests');
  if (parts.some((p) => p === '.' || p === '..')) throw new Error('The folder is inside the collection: no .. in it');
  return parts;
}

// The address the tests use, to send from here: an address, or a {{variable}} (and what follows it) from the
// environments of the collection, local first. Returns { address, env, vars }: vars are that environment's.
function resolveAddress(base, collectionDir) {
  const b = String(base || '').trim();
  const envs = readEnvironments(collectionDir);
  const m = /^\{\{\s*([^}\s]+)\s*\}\}(.*)$/.exec(b);
  const varsOf = (env) => new Map(((env && env.vars) || []).map((v) => [v.key, String(v.value || '')]));
  if (!m) {
    if (!/^https?:\/\/[^/]/i.test(b)) throw new Error('Put an address (http://...) or a variable of the collection in Address');
    const env = envs.find((e) => e.name === 'local') || envs[0];
    return { address: b.replace(/\/+$/, ''), env: env ? env.name : '', vars: varsOf(env) };
  }
  const has = (e) => e.vars.some((v) => v.key === m[1] && String(v.value || '').trim());
  const env = envs.find((e) => e.name === 'local' && has(e)) || envs.find(has);
  if (!env) throw new Error(`{{${m[1]}}} has no value in the environments of the collection: put the address in Address`);
  const value = String(env.vars.find((v) => v.key === m[1]).value).trim();
  if (/\{\{/.test(value) || !/^https?:\/\//i.test(value)) throw new Error(`{{${m[1]}}} in ${env.name} is not an address (${value})`);
  return { address: `${value.replace(/\/+$/, '')}${m[2]}`.replace(/\/+$/, ''), env: env.name, vars: varsOf(env) };
}

const isLocal = (address) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/:]+\.localhost)(:\d+)?(\/|$)/i.test(address);
// An address or environment that reads as production (prd, prod, production as a word of its own; not preprod or
// product): the variations make, change and cancel things, so they are never sent there.
const PRODUCTION = /(^|[^a-z])(prd|prod|production)([^a-z]|$)/i;
const NOT_THERE = 'It looks like production: the variations make, change and cancel things, so they are not sent there. Use a local, DEV or SIT address.';

// The headers a request of the logs is sent again with from here: the ones a test keeps, a secret one from the
// environment's variable of its name (else without it).
const headersFor = (vars) => (headers, payload) => {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const value = Array.isArray(v) ? v.join(', ') : String(v);
    if (DROP_HEADER.test(k) || (/^accept$/i.test(k) && value.trim() === '*/*')) continue;
    if (SECRET_HEADER.test(k)) {
      const secret = vars.get(camel(k));
      if (secret) out[k] = secret;
      continue;
    }
    out[k] = value.replace(/[\r\n]+/g, ' ');
  }
  if (payload && String(payload).trim() && parseJson(payload) !== undefined && !Object.keys(out).some((k) => /^content-type$/i.test(k))) out['content-type'] = 'application/json';
  return out;
};

// What was tried, as cases (one exchange each), so its tests are made as those of the logs are.
function triedCases(s) {
  return s.tried.exchanges.map((ex, i) => {
    const { path: p, query } = splitUri(ex.uri);
    return { id: `${s.id}-${i + 1}`, method: ex.method, path: p, query, origin: '', template: templateOf(p), status: ex.status, service: ex.service, samples: [ex], rep: ex, first: ex.ts, last: ex.ts };
  });
}

// The tests of a scenario tried: one file in "Not in the logs", or a folder with its steps (what it needs made first,
// then the request it checks).
function scenarioItem(s, moreDir, base, casesById) {
  const r = s.result;
  const title = `${s.method} ${s.template} (${r.status}) ${s.label}`.replace(/\s+/g, ' ').slice(0, 90).trim();
  const cs = triedCases(s);
  const chain = chainOf(cs);
  const multi = cs.length > 1;
  const dir = multi ? path.join(moreDir, fileOf(title).replace(/\.bru$/, '')) : moreDir;
  const what = variations.changeText(s, casesById);
  let summary = null;
  const steps = cs.map((c, i) => {
    const last = i === cs.length - 1;
    const name = multi ? `${i + 1} ${c.method} ${c.template} (${c.status})${i === 0 && !last ? ' makes one' : ''}`.slice(0, 70).trim() : title;
    const req = requestOf(c, { name, seq: i + 1, base, ...chain });
    if (!last) {
      req.json.tests = '';
      req.json.docs = i === 0 ? `Makes what the next steps use, so they start from something new.` : `Step ${i + 1} of ${cs.length}: done before the last one.`;
    } else {
      const lines = req.json.docs.split('\n');
      const how = s.kind === 'sequence' ? `actions in an order the logs did not have (${what})` : s.kind === 'call' ? `an endpoint of the code the logs never had (${what})` : `a request of the logs with one change (${what})`;
      lines[0] = `Made by QuickDeck from what the logs did not have: ${how}.${multi ? ' The steps before make what it needs, so it starts from something new.' : ''}`;
      lines.splice(1, 0, '', `It answered ${r.status} when tried${r.code ? `, as the code says: ${path.basename(r.code.file)}:${r.code.line}${r.code.condition ? ` (${r.code.condition})` : ''}` : ''}.${r.same ? ` The logs have this answer too.` : ''}`);
      req.json.docs = lines.join('\n').replace('The response in the logs:', 'The response when tried:');
      summary = req.summary;
    }
    return { name, file: path.join(dir, fileOf(name)), json: req.json };
  });
  const file = multi ? dir : steps[0].file;
  return { id: s.id, name: title, file, dir, multi, exists: fs.existsSync(file), steps, summary };
}

function registerLogTests({ logs, listRepos, isKnownRepo, fetch }) {
  const found = new Map(); // token -> { cases, at, more }
  const guard = (fn) => async (_, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { error: e.message, ...(e.code && { code: e.code }) };
    }
  };

  const collectionsFor = (service) => {
    const list = [];
    for (const r of listRepos()) {
      for (const col of findCollections(r.path)) list.push({ repo: r.path, repoName: r.name, dir: col.dir, rel: col.rel, name: col.name });
    }
    const svc = String(service || '').toLowerCase();
    const score = (c) => (!svc ? 0 : (c.repoName.toLowerCase() === svc || path.basename(c.repo).toLowerCase() === svc ? 4 : 0) + (String(c.name).toLowerCase() === svc ? 2 : 0) + (svc.includes(path.basename(c.repo).toLowerCase()) ? 1 : 0));
    const best = list.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s)[0];
    return { collections: list, suggested: best && best.s > 0 ? best.c.dir : '' };
  };

  const collectionOf = (repo, dir) => {
    if (!isKnownRepo(repo)) throw new Error('Unknown repository');
    const root = path.resolve(String(dir || ''));
    const rel = path.relative(path.resolve(repo), root);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(path.join(root, 'bruno.json'))) throw new Error('That is not a Bruno collection of this repository');
    return root;
  };

  const foundOf = (token) => {
    const f = found.get(token);
    if (!f) throw new Error('These requests are from an older search: press Bruno tests again.');
    return f;
  };

  // What the tests of the chosen cases will be, in the folder chosen: names, files (there already or not), checks;
  // and those of the scenarios tried, in its folder "Not in the logs".
  function plan(token, { repo, dir, folder, base, ids }) {
    const f = foundOf(token);
    const root = collectionOf(repo, dir);
    const parts = folderRel(folder);
    const folderDir = path.join(root, ...parts);
    const chosen = f.cases.filter((c) => (ids || []).includes(c.id));
    const names = namesOf(f.cases);
    const { sets, uses, from } = chainOf(chosen);
    const none = new Map();
    const items = f.cases.map((c, i) => {
      const name = names.get(c.id);
      const file = path.join(folderDir, fileOf(name));
      const on = chosen.includes(c);
      const r = requestOf(c, { name, seq: i + 1, base, sets: on ? sets : none, uses: on ? uses : none, from: on ? from : none });
      return { id: c.id, name, file, exists: fs.existsSync(file), json: r.json, summary: r.summary };
    });
    const moreDir = path.join(folderDir, MORE_FOLDER);
    const casesById = new Map(f.cases.map((c) => [c.id, c]));
    const more = f.more && f.more.repo === path.resolve(repo) ? f.more.scenarios.filter((s) => s.result).map((s) => scenarioItem(s, moreDir, base, casesById)) : [];
    return { root, parts, folderDir, items, more };
  }

  // The scenarios and what the code answers, for the page.
  function moreSummary(f, root, base) {
    const casesById = new Map(f.cases.map((c) => [c.id, c]));
    let where = null;
    try {
      const w = resolveAddress(base, root);
      const local = isLocal(w.address);
      where = { address: w.address, env: w.env, local, ...(!local && (PRODUCTION.test(w.address) || PRODUCTION.test(w.env)) && { error: NOT_THERE }) };
    } catch (e) {
      where = { error: e.message };
    }
    const code = f.more.code;
    return {
      code: code ? { controllers: code.controllers, endpoints: code.endpoints.length, answers: code.endpoints.reduce((a, e) => a + e.answers.length, 0) } : null,
      codeError: f.more.codeError,
      where,
      tried: f.more.tried,
      scenarios: f.more.scenarios.map((s) => ({
        id: s.id, group: s.group, method: s.method, template: s.template, kind: s.kind, label: s.label, steps: s.steps.length,
        change: variations.changeText(s, casesById),
        tried: s.tried ? { error: s.tried.error, at: s.tried.at, address: s.tried.address } : null,
        result: s.result ? { status: s.result.status, message: s.result.message, code: s.result.code && { file: path.basename(s.result.code.file), line: s.result.code.line, condition: s.result.code.condition, cause: s.result.code.cause }, same: s.result.same ? `${s.result.same.method} ${s.result.same.path} (${s.result.same.status})` : null } : null,
        suggest: Boolean(s.suggest),
      })),
      unreached: f.more.tried || !f.more.scenarios.length ? variations.unreached(code && code.endpoints, f.cases, f.more.scenarios).map((u) => ({ ...u, file: path.basename(u.file) })) : [],
      groups: [...new Set([...f.cases.map((c) => `${c.method} ${c.template}`), ...((code && code.endpoints) || []).map((e) => `${e.method} ${e.template}`)])],
      logs: Object.fromEntries([...new Set(f.cases.map((c) => `${c.method} ${c.template}`))].map((g) => [g, [...new Set(f.cases.filter((c) => `${c.method} ${c.template}` === g).map((c) => c.status))].sort()])),
    };
  }

  ipcMain.handle('logtests-find', guard(async (params) => {
    const read = await logs.forTests(params || {});
    let records = read.records;
    // the other line of a request the search found only one of (a search for a word of its payload): its trace
    const half = exchangesFrom(records).left.noResponse;
    if (half && read.traceIds.length) {
      const more = await logs.byTraceIds(read.traceIds, read.from - TRACE_EXTRA_MS, read.to + TRACE_EXTRA_MS);
      const seen = new Set(records.map((r) => `${r.origin}|${r.id}`));
      records = records.concat(more.filter((r) => !seen.has(`${r.origin}|${r.id}`)));
    }
    const { exchanges, left } = exchangesFrom(records);
    const { cases, skipped, more } = casesFrom(exchanges);
    left.notTested = skipped;
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    found.clear(); // one search at a time: the page shows the last one
    found.set(token, { cases, at: Date.now(), more: null });
    const services = [...new Set(cases.map((c) => c.service).filter(Boolean))];
    const { collections, suggested } = collectionsFor(services.length === 1 ? services[0] : '');
    return {
      token,
      read: records.length,
      truncated: read.truncated,
      maxLogs: read.maxLogs,
      left,
      more,
      services,
      cases: cases.map((c) => {
        const body = parseJson(c.rep.response);
        return {
          id: c.id, method: c.method, path: c.path, query: c.query, template: c.template, status: c.status, service: c.service,
          count: c.samples.length, first: c.first, last: c.last,
          payload: c.rep.payload === undefined ? 'missing' : c.rep.payload.trim() ? 'yes' : 'none',
          response: body !== undefined ? 'json' : c.rep.response && c.rep.response.trim() ? 'text' : 'empty',
        };
      }),
      collections: collections.map((c) => ({ ...c, bases: baseOptions(c.dir, cases) })),
      suggested,
    };
  }));

  // "Not in the logs": the variations of the requests of the logs, and what the code of the collection's repository
  // can answer (read again when the collection is another repository's).
  ipcMain.handle('logtests-more', guard(async (token, opts) => {
    const f = foundOf(token);
    const root = collectionOf(opts.repo, opts.dir);
    const repo = path.resolve(opts.repo);
    if (!f.more || f.more.repo !== repo) {
      let code = null;
      let codeError = null;
      try {
        code = readCodeAnswers(repo);
      } catch (e) {
        codeError = e.message;
      }
      f.more = { repo, code, codeError, scenarios: variations.variationsOf(f.cases, code), tried: false };
    }
    return moreSummary(f, root, opts.base);
  }));

  // Sends the scenarios (ids, or all) to the address of the tests and keeps what each got; the answers of a kind the
  // logs do not have (one of each) are suggested.
  ipcMain.handle('logtests-try', guard(async (token, opts, ids) => {
    const f = foundOf(token);
    const root = collectionOf(opts.repo, opts.dir);
    if (!f.more || f.more.repo !== path.resolve(opts.repo)) throw new Error('Open "Not in the logs" again');
    const where = resolveAddress(opts.base, root);
    if (!isLocal(where.address) && (PRODUCTION.test(where.address) || PRODUCTION.test(where.env))) throw new Error(NOT_THERE);
    const casesById = new Map(f.cases.map((c) => [c.id, c]));
    const { uses } = chainOf(f.cases);
    const list = f.more.scenarios.filter((s) => !Array.isArray(ids) || ids.includes(s.id));
    for (const s of list) {
      const r = await variations.runScenario(s, { casesById, uses, address: where.address, headersFor: headersFor(where.vars), fetch });
      s.tried = { ...r, at: Date.now(), address: where.address };
      s.result = variations.judge(s, s.tried, f.more.code && f.more.code.endpoints, f.cases);
    }
    const answers = new Set();
    for (const s of f.more.scenarios) {
      s.suggest = false;
      if (!s.result) continue;
      const key = `${s.group}|${s.result.status}|${s.result.message}`;
      // a sequence is new even when its last answer is one of the logs (cancel twice: 204 again)
      s.suggest = (!s.result.same || s.kind === 'sequence') && s.result.status < 500 && !answers.has(key);
      answers.add(key);
    }
    f.more.tried = true;
    return moreSummary(f, root, opts.base);
  }));

  // The page's choices changed: the names, which are there already, the checks and the text of one of them.
  ipcMain.handle('logtests-plan', guard(async (token, opts, previewId) => {
    const p = plan(token, opts || {});
    let preview = null;
    let previewSteps = null;
    const item = previewId && p.items.find((it) => it.id === previewId);
    const moreItem = previewId && p.more.find((it) => it.id === previewId);
    try {
      if (item) preview = await files.bruText(item.json);
      else if (moreItem) {
        preview = await files.bruText(moreItem.steps[moreItem.steps.length - 1].json);
        previewSteps = moreItem.multi ? moreItem.steps.map((st) => st.name) : null;
      }
    } catch (e) {
      preview = { error: e.message };
    }
    return {
      folder: slash(path.relative(p.root, p.folderDir)),
      items: p.items.map((it) => ({ id: it.id, name: it.name, file: path.basename(it.file), exists: it.exists, ...it.summary })),
      more: p.more.map((it) => ({ id: it.id, name: it.name, file: slash(path.relative(p.folderDir, it.file)), exists: it.exists, multi: it.multi, steps: it.steps.length, ...it.summary })),
      preview: preview && preview.error ? null : preview,
      previewSteps,
      previewError: preview && preview.error ? preview.error : null,
    };
  }));

  // Writes the tests of the chosen cases, in their order, after the requests the folder has (a test with the same
  // name is written over), and those of the chosen scenarios in "Not in the logs" (a scenario of steps in a folder of
  // its own, written again whole). Returns the folder and the files.
  ipcMain.handle('logtests-create', guard(async (token, opts) => {
    const p = plan(token, opts || {});
    const chosen = p.items.filter((it) => (opts.ids || []).includes(it.id));
    const chosenMore = p.more.filter((it) => (opts.more || []).includes(it.id));
    if (!chosen.length && !chosenMore.length) throw new Error('Choose one request at least');
    const { dir, made } = files.makeFolders(p.root, p.parts.join('/'));
    const replacing = new Set(chosen.filter((it) => it.exists).map((it) => path.basename(it.file)));
    let seq = files.nextSeq(dir, replacing);
    const written = [];
    let replaced = replacing.size;
    try {
      for (const it of chosen) {
        it.json.meta.seq = String(seq++);
        await files.writeRequest(it.file, it.json);
        written.push(slash(path.relative(p.root, it.file)));
      }
      if (chosenMore.length) {
        const { dir: moreDir } = files.makeFolders(p.root, [...p.parts, MORE_FOLDER].join('/'));
        const singles = chosenMore.filter((it) => !it.multi);
        let mseq = files.nextSeq(moreDir, new Set(singles.filter((it) => it.exists).map((it) => path.basename(it.file))));
        for (const it of chosenMore) {
          if (it.exists) replaced++;
          if (!it.multi) {
            it.steps[0].json.meta.seq = String(mseq++);
            await files.writeRequest(it.file, it.steps[0].json);
            written.push(slash(path.relative(p.root, it.file)));
            continue;
          }
          const rel = slash(path.relative(p.root, it.dir));
          files.makeFolders(p.root, rel);
          // the folder shows in Bruno with the scenario's name as it reads (its / and all), not its file name
          const about = path.join(it.dir, 'folder.bru');
          if (fs.existsSync(about)) fs.writeFileSync(about, fs.readFileSync(about, 'utf8').replace(/^ {2}name: .*$/m, () => `  name: ${it.name}`));
          // written again whole: the steps of before go
          for (const old of fs.readdirSync(it.dir)) if (old.endsWith('.bru') && old !== 'folder.bru') fs.rmSync(path.join(it.dir, old));
          for (const [i, st] of it.steps.entries()) {
            st.json.meta.seq = String(i + 1);
            await files.writeRequest(st.file, st.json);
            written.push(slash(path.relative(p.root, st.file)));
          }
        }
      }
    } catch (e) {
      if (!written.length) for (const d of made.reverse()) fs.rmSync(d, { recursive: true, force: true });
      throw e;
    }
    const folder = slash(path.relative(p.root, dir));
    const inTree = (list) => list.some((x) => (x.type === 'folder' ? x.path === folder || inTree(x.items) : false));
    return { folder, written, replaced, tests: chosen.length + chosenMore.length, listed: inTree(readTree(p.root)) };
  }));
}

module.exports = { registerLogTests, exchangesFrom, casesFrom, chainOf, checksOf, requestOf, namesOf, fileOf, templateOf, splitUri, partOf, testsCode, parseJson, queryPairs, isIdSegment, deepAt, resolveAddress, headersFor, triedCases, scenarioItem, isLocal, PRODUCTION };
