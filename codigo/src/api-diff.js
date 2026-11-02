// Compare APIs: two OpenAPI 3 or Swagger 2 documents (JSON or YAML) and what changed between them for whoever calls
// the API - the endpoints added, removed or changed (parameters, request body, responses, security), the models
// (schemas) changed with the endpoints that use each - and which changes break a client written for the old one.
// In what a client sends (the request) a new required field, a value no longer accepted or a stricter limit breaks
// it; in what it gets back (the response) a field gone, of another type or now null does.
const yaml = require('js-yaml');

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
const MAX_DEPTH = 12;
const MAX_CHANGES = 300; // per endpoint or model

function parseSpec(text, side) {
  const t = String(text || '').trim();
  if (!t) throw new Error(`${side}: paste a spec, open a file or get one from a URL`);
  let doc;
  try {
    doc = t.startsWith('{') ? JSON.parse(t) : yaml.load(t);
  } catch (e) {
    throw new Error(`${side} is not valid JSON or YAML: ${String(e.message).split('\n')[0]}`);
  }
  if (!doc || typeof doc !== 'object' || !(doc.openapi || doc.swagger) || typeof doc.paths !== 'object') {
    throw new Error(`${side} is not an OpenAPI or Swagger spec: it has no "openapi" (or "swagger") and "paths"`);
  }
  return doc;
}

// A node with its $ref followed ("#/components/schemas/Pet"), a chain of them at most 20 long
function makeDeref(doc) {
  const at = (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
    let n = doc;
    for (const raw of ref.slice(2).split('/')) {
      const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      n = n && typeof n === 'object' ? n[k] : undefined;
    }
    return n && typeof n === 'object' ? n : null;
  };
  return (node) => {
    let n = node;
    for (let i = 0; n && typeof n === 'object' && n.$ref && i < 20; i++) n = at(n.$ref);
    return n && typeof n === 'object' ? n : {};
  };
}

const refName = (node) => (node && typeof node === 'object' && typeof node.$ref === 'string' ? node.$ref.split('/').pop() : '');
const modelsOf = (doc) => (doc.components && doc.components.schemas) || doc.definitions || {};

function side(doc) {
  return { doc, deref: makeDeref(doc), oas3: Boolean(doc.openapi) };
}

// -- endpoints --

// Every operation by "GET /pets/{}": path parameters' names are left out, so a renamed one is the same endpoint
function operations(s) {
  const out = new Map();
  for (const [p, raw] of Object.entries(s.doc.paths || {})) {
    const item = s.deref(raw);
    const names = [...p.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
    for (const m of METHODS) {
      const op = item[m];
      if (!op || typeof op !== 'object') continue;
      const params = new Map();
      for (const pr of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const q = s.deref(pr);
        if (!q.name || !q.in) continue;
        // a path parameter by its place in the path; a header by its name in any case
        const id = q.in === 'path' && names.includes(q.name) ? `#${names.indexOf(q.name)}` : q.in === 'header' ? String(q.name).toLowerCase() : q.name;
        params.set(`${q.in}:${id}`, q);
      }
      out.set(`${m.toUpperCase()} ${p.replace(/\{[^}]*\}/g, '{}')}`, { method: m.toUpperCase(), path: p, op, params });
    }
  }
  return out;
}

function contentSchemas(s, content) {
  const out = {};
  for (const [type, media] of Object.entries(content || {})) out[type] = s.deref(media).schema || {};
  return out;
}

// The body an operation takes: OpenAPI 3's requestBody, Swagger 2's body parameter (or its form fields as one object)
function requestBody(s, e) {
  if (s.oas3) {
    if (!e.op.requestBody) return null;
    const rb = s.deref(e.op.requestBody);
    return { required: Boolean(rb.required), content: contentSchemas(s, rb.content) };
  }
  const consumes = (e.op.consumes || s.doc.consumes || ['application/json'])[0];
  const body = [...e.params.values()].find((p) => p.in === 'body');
  if (body) return { required: Boolean(body.required), content: { [consumes]: body.schema || {} } };
  const form = [...e.params.values()].filter((p) => p.in === 'formData');
  if (!form.length) return null;
  return {
    required: form.some((p) => p.required),
    content: { [consumes]: { type: 'object', properties: Object.fromEntries(form.map((p) => [p.name, p])), required: form.filter((p) => p.required).map((p) => p.name) } },
  };
}

function responses(s, e) {
  const out = new Map();
  const produces = (e.op.produces || s.doc.produces || ['application/json'])[0];
  for (const [code, raw] of Object.entries(e.op.responses || {})) {
    const r = s.deref(raw);
    out.set(String(code), s.oas3 ? contentSchemas(s, r.content) : r.schema ? { [produces]: r.schema } : {});
  }
  return out;
}

const securityNames = (s, e) => {
  const list = e.op.security || s.doc.security || [];
  return [...new Set((Array.isArray(list) ? list : []).flatMap((req) => Object.keys(req || {})))].sort();
};

// -- schemas --

// A schema with its $ref followed and its allOf parts merged into one: their fields and required ones together
function flat(deref, node, depth = 0) {
  const sc = deref(node);
  if (!Array.isArray(sc.allOf) || depth > MAX_DEPTH) return sc;
  const out = { ...sc, properties: { ...(sc.properties || {}) }, required: [...(Array.isArray(sc.required) ? sc.required : [])] };
  delete out.allOf;
  for (const part of sc.allOf) {
    const p = flat(deref, part, depth + 1);
    Object.assign(out.properties, p.properties || {});
    if (Array.isArray(p.required)) out.required.push(...p.required);
    if (!out.type && p.type) out.type = p.type;
  }
  return out;
}

function typeOf(sc) {
  if (sc.type) return Array.isArray(sc.type) ? sc.type.filter((t) => t !== 'null').join(' | ') : String(sc.type);
  if (sc.properties || sc.additionalProperties) return 'object';
  if (sc.items) return 'array';
  if (sc.oneOf || sc.anyOf) return 'one of';
  return '';
}

const nullable = (sc) => sc.nullable === true || (Array.isArray(sc.type) && sc.type.includes('null'));
const at = (where, key) => (where ? `${where}.${key}` : key);

// The changes from schema a to schema b, each with where it is ("owner.name", "tags[]") and whether it breaks a client
// that sends it (req) or one that reads it (res). Named models met inside are not gone into: Models compares each once.
function compareSchemas(ctx, a0, b0, where, depth = 0) {
  if (ctx.changes.length >= MAX_CHANGES || depth > MAX_DEPTH) return;
  const an = refName(a0);
  const bn = refName(b0);
  if (an && bn && (depth > 0 || !ctx.root)) {
    if (an !== bn) ctx.add(where, `model ${an} → ${bn}`, true, true);
    else ctx.models.add(an);
    return;
  }
  const a = flat(ctx.a.deref, a0);
  const b = flat(ctx.b.deref, b0);
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta && tb && ta !== tb) {
    ctx.add(where, `type ${ta} → ${tb}`, true, true);
    return;
  }
  if ((a.format || b.format) && a.format !== b.format) ctx.add(where, `format ${a.format || 'none'} → ${b.format || 'none'}`, Boolean(a.format && b.format), Boolean(a.format && b.format));
  const ea = Array.isArray(a.enum) ? a.enum.map(String) : null;
  const eb = Array.isArray(b.enum) ? b.enum.map(String) : null;
  if (ea && eb) {
    const gone = ea.filter((v) => !eb.includes(v));
    const added = eb.filter((v) => !ea.includes(v));
    if (gone.length) ctx.add(where, `values no longer allowed: ${gone.join(', ')}`, true, false);
    if (added.length) ctx.add(where, `new values: ${added.join(', ')}`, false, true);
  } else if (eb) ctx.add(where, `now limited to: ${eb.join(', ')}`, true, false);
  else if (ea) ctx.add(where, 'no longer limited to a list of values', false, true);
  if (nullable(a) !== nullable(b)) ctx.add(where, nullable(b) ? 'can now be null' : 'can no longer be null', !nullable(b), nullable(b));
  // limits: stricter ones break what a client sends
  for (const [k, stricter] of [['maxLength', (x, y) => y < x], ['minLength', (x, y) => y > x], ['maximum', (x, y) => y < x], ['minimum', (x, y) => y > x], ['maxItems', (x, y) => y < x], ['minItems', (x, y) => y > x]]) {
    if (a[k] === b[k]) continue;
    const tighter = b[k] !== undefined && (a[k] === undefined || stricter(a[k], b[k]));
    ctx.add(where, `${k} ${a[k] ?? 'none'} → ${b[k] ?? 'none'}`, tighter, false);
  }
  if ((a.pattern || b.pattern) && a.pattern !== b.pattern) ctx.add(where, `pattern ${a.pattern || 'none'} → ${b.pattern || 'none'}`, Boolean(b.pattern), false);
  const pa = a.properties || {};
  const pb = b.properties || {};
  // a list of required fields (a Swagger 2 parameter, compared as its own schema, has required: true instead)
  const ra = new Set(Array.isArray(a.required) ? a.required : []);
  const rb = new Set(Array.isArray(b.required) ? b.required : []);
  for (const k of Object.keys(pa)) if (!(k in pb)) ctx.add(at(where, k), 'removed', false, true);
  for (const k of Object.keys(pb)) if (!(k in pa)) ctx.add(at(where, k), rb.has(k) ? 'added, required' : 'added', rb.has(k), false);
  for (const k of Object.keys(pa)) {
    if (!(k in pb)) continue;
    if (!ra.has(k) && rb.has(k)) ctx.add(at(where, k), 'now required', true, false);
    if (ra.has(k) && !rb.has(k)) ctx.add(at(where, k), 'no longer required', false, true);
    compareSchemas(ctx, pa[k], pb[k], at(where, k), depth + 1);
  }
  if (a.items || b.items) compareSchemas(ctx, a.items || {}, b.items || {}, `${where}[]`, depth + 1);
  for (const k of ['oneOf', 'anyOf']) {
    const la = Array.isArray(a[k]) ? a[k].length : 0;
    const lb = Array.isArray(b[k]) ? b[k].length : 0;
    if (la !== lb) ctx.add(where, `${k}: ${la} → ${lb} kinds`, lb < la, lb > la);
  }
}

// A place to note changes: each with whether it breaks, for a request or a response (dir), or both kept (a model).
// root: the schema compared is itself a model (gone into even though it is named); otherwise named models are not.
function changeList(a, b, dir, root = false) {
  const ctx = {
    a, b, dir, root, changes: [], models: new Set(),
    add(where, text, req, res = req) {
      if (this.changes.length >= MAX_CHANGES) return;
      this.changes.push({ where, text, req: Boolean(req), res: Boolean(res), breaking: dir === 'request' ? Boolean(req) : dir === 'response' ? Boolean(res) : undefined });
    },
  };
  return ctx;
}

// The models a schema uses, and the ones they use
function modelsUsed(s, node, out = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return out;
  const name = refName(node);
  if (name) {
    if (out.has(name)) return out;
    out.add(name);
    return modelsUsed(s, s.deref(node), out, depth + 1);
  }
  for (const k of ['properties', 'patternProperties']) for (const v of Object.values(node[k] || {})) modelsUsed(s, v, out, depth + 1);
  for (const k of ['items', 'additionalProperties', 'not']) if (node[k] && typeof node[k] === 'object') modelsUsed(s, node[k], out, depth + 1);
  for (const k of ['allOf', 'oneOf', 'anyOf']) for (const v of Array.isArray(node[k]) ? node[k] : []) modelsUsed(s, v, out, depth + 1);
  return out;
}

// For each endpoint, the models it sends and gets
function endpointModels(s, e) {
  const req = new Set();
  const res = new Set();
  for (const p of e.params.values()) if (p.in !== 'body' && p.in !== 'formData') modelsUsed(s, p.schema || {}, req);
  const body = requestBody(s, e);
  if (body) for (const sc of Object.values(body.content)) modelsUsed(s, sc, req);
  for (const content of responses(s, e).values()) for (const sc of Object.values(content)) modelsUsed(s, sc, res);
  return { req, res };
}

function compareEndpoint(a, b, ea, eb) {
  const out = [];
  const push = (list) => out.push(...list.changes);
  // parameters (the body is compared as the body)
  const params = changeList(a, b, 'request');
  const label = (p) => `${p.in} parameter ${p.name}`;
  for (const [k, p] of ea.params) {
    if (p.in === 'body' || p.in === 'formData') continue;
    if (!eb.params.has(k)) params.add(label(p), 'removed (a value sent is ignored now)', false);
  }
  for (const [k, p] of eb.params) {
    if (p.in === 'body' || p.in === 'formData' || ea.params.has(k)) continue;
    params.add(label(p), p.required ? 'added, required' : 'added', Boolean(p.required));
  }
  for (const [k, pa] of ea.params) {
    const pb = eb.params.get(k);
    if (!pb || pa.in === 'body' || pa.in === 'formData') continue;
    if (pa.name !== pb.name) params.add(label(pa), `renamed ${pa.name} → ${pb.name}`, false);
    if (!pa.required && pb.required) params.add(label(pb), 'now required', true);
    if (pa.required && !pb.required) params.add(label(pb), 'no longer required', false);
    compareSchemas(params, a.oas3 ? pa.schema || {} : pa, b.oas3 ? pb.schema || {} : pb, label(pb));
  }
  push(params);
  // the request body
  const ba = requestBody(a, ea);
  const bb = requestBody(b, eb);
  const body = changeList(a, b, 'request');
  if (!ba && bb) body.add('Request body', bb.required ? 'added, required' : 'added', bb.required);
  if (ba && !bb) body.add('Request body', 'removed', false);
  if (ba && bb) {
    if (!ba.required && bb.required) body.add('Request body', 'now required', true);
    const types = Object.keys(ba.content);
    for (const t of types) if (!(t in bb.content)) body.add('Request body', `no longer accepts ${t}`, true);
    for (const t of Object.keys(bb.content)) if (!(t in ba.content)) body.add('Request body', `now also accepts ${t}`, false);
    for (const t of types) if (t in bb.content) compareSchemas(body, ba.content[t], bb.content[t], types.length > 1 ? `Request body (${t})` : 'Request body');
  }
  push(body);
  // responses
  const ra = responses(a, ea);
  const rb = responses(b, eb);
  const res = changeList(a, b, 'response');
  for (const code of ra.keys()) if (!rb.has(code)) res.add(`Response ${code}`, 'removed', /^2/.test(code));
  for (const code of rb.keys()) if (!ra.has(code)) res.add(`Response ${code}`, 'added', false);
  for (const [code, ca] of ra) {
    const cb = rb.get(code);
    if (!cb) continue;
    const types = Object.keys(ca);
    for (const t of types) if (!(t in cb)) res.add(`Response ${code}`, `no longer gives ${t}`, true);
    for (const t of types) if (t in cb) compareSchemas(res, ca[t], cb[t], types.length > 1 ? `Response ${code} (${t})` : `Response ${code}`);
  }
  push(res);
  // the rest of the operation
  const info = changeList(a, b, 'request');
  if (!ea.op.deprecated && eb.op.deprecated) info.add('Endpoint', 'now deprecated', false);
  if (ea.op.deprecated && !eb.op.deprecated) info.add('Endpoint', 'no longer deprecated', false);
  if (ea.op.operationId && eb.op.operationId && ea.op.operationId !== eb.op.operationId) info.add('Endpoint', `operationId ${ea.op.operationId} → ${eb.op.operationId} (generated clients name the method after it)`, false);
  const sa = securityNames(a, ea);
  const sb = securityNames(b, eb);
  if (sa.join() !== sb.join()) info.add('Security', `${sa.join(', ') || 'none'} → ${sb.join(', ') || 'none'}`, sb.some((n) => !sa.includes(n)));
  push(info);
  return { changes: out, models: new Set([...params.models, ...body.models, ...res.models]) };
}

function compareSpecs(beforeText, afterText) {
  const a = side(parseSpec(beforeText, 'Before'));
  const b = side(parseSpec(afterText, 'After'));
  const opsA = operations(a);
  const opsB = operations(b);
  const info = (s, ops) => {
    const i = s.doc.info || {};
    return { kind: s.doc.openapi ? `OpenAPI ${s.doc.openapi}` : `Swagger ${s.doc.swagger}`, title: String(i.title || ''), version: String(i.version || ''), endpoints: ops.size, models: Object.keys(modelsOf(s.doc)).length };
  };

  // models: each compared once, its changes breaking as the endpoints of the old spec use it (sent, got, both)
  const usedA = new Map(); // model -> { req: Set of endpoints, res: Set }
  for (const [key, e] of opsA) {
    const { req, res } = endpointModels(a, e);
    for (const [set, kind] of [[req, 'req'], [res, 'res']]) {
      for (const m of set) {
        if (!usedA.has(m)) usedA.set(m, { req: new Set(), res: new Set() });
        usedA.get(m)[kind].add(key);
      }
    }
  }
  const ma = modelsOf(a.doc);
  const mb = modelsOf(b.doc);
  const models = [];
  const changedModels = new Map();
  for (const name of [...new Set([...Object.keys(ma), ...Object.keys(mb)])].sort((x, y) => x.localeCompare(y))) {
    const use = usedA.get(name) || { req: new Set(), res: new Set() };
    const usedBy = [...new Set([...use.req, ...use.res])].sort();
    if (!(name in mb)) {
      models.push({ name, state: 'removed', breaking: false, usedBy, changes: [] });
      continue;
    }
    if (!(name in ma)) {
      models.push({ name, state: 'added', breaking: false, usedBy: [], changes: [] });
      continue;
    }
    const ctx = changeList(a, b, 'model', true);
    compareSchemas(ctx, ma[name], mb[name], '');
    if (!ctx.changes.length) continue;
    const changes = ctx.changes.map((c) => ({ where: c.where, text: c.text, req: c.req, res: c.res, breaking: (use.req.size > 0 && c.req) || (use.res.size > 0 && c.res) }));
    const m = { name, state: 'changed', breaking: changes.some((c) => c.breaking), usedBy, changes };
    models.push(m);
    changedModels.set(name, m);
  }

  // endpoints
  const endpoints = [];
  const order = (k) => [k.replace(/^\S+ /, ''), METHODS.indexOf(k.split(' ')[0].toLowerCase())];
  const keys = [...new Set([...opsA.keys(), ...opsB.keys()])].sort((x, y) => {
    const [px, mx] = order(x);
    const [py, my] = order(y);
    return px.localeCompare(py) || mx - my;
  });
  for (const key of keys) {
    const ea = opsA.get(key);
    const eb = opsB.get(key);
    const e = eb || ea;
    const base = { key, method: e.method, path: e.path, summary: String(e.op.summary || '') };
    if (!eb) {
      endpoints.push({ ...base, state: 'removed', breaking: true, changes: [] });
      continue;
    }
    if (!ea) {
      endpoints.push({ ...base, state: 'added', breaking: false, changes: [] });
      continue;
    }
    const { changes } = compareEndpoint(a, b, ea, eb);
    // the models it uses that changed, breaking as it uses them (sent or got)
    const { req, res } = endpointModels(a, ea);
    for (const name of [...new Set([...req, ...res])].sort()) {
      const m = changedModels.get(name);
      if (!m) continue;
      const breaks = m.changes.some((c) => (req.has(name) && c.req) || (res.has(name) && c.res));
      changes.push({ where: `Model ${name}`, text: `changed: ${m.changes.length} change${m.changes.length === 1 ? '' : 's'} (in Models)`, breaking: breaks, model: name });
    }
    if (!changes.length) continue;
    endpoints.push({ ...base, state: 'changed', breaking: changes.some((c) => c.breaking), changes: changes.map(({ where, text, breaking, model }) => ({ where, text, breaking: Boolean(breaking), ...(model ? { model } : {}) })) });
  }
  const count = (list, state) => list.filter((x) => x.state === state).length;
  return {
    before: info(a, opsA),
    after: info(b, opsB),
    summary: {
      added: count(endpoints, 'added'),
      removed: count(endpoints, 'removed'),
      changed: count(endpoints, 'changed'),
      same: keys.length - endpoints.length,
      breaking: endpoints.filter((x) => x.breaking).length,
      models: { added: count(models, 'added'), removed: count(models, 'removed'), changed: count(models, 'changed') },
    },
    endpoints,
    models: models.map((m) => ({ ...m, changes: m.changes.map(({ where, text, breaking }) => ({ where, text, breaking: Boolean(breaking) })) })),
  };
}

module.exports = { compareSpecs, parseSpec };
