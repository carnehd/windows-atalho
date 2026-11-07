// View API: an OpenAPI 3 or Swagger 2 document (JSON or YAML) turned into what the Tools page shows: the endpoints by
// group, what each one takes and answers as trees of fields with their rules in words, an example of each body, and the
// models with the endpoints that use them. Both kinds of spec come out the same; a part in another file is named, not read.
const { parseSpec, side, operations, requestBody, flat, typeOf, refName, modelsOf, modelsUsed, endpointModels } = require('./api-diff');

const MAX_DEPTH = 8;
const MAX_FIELDS = 1500; // in one tree: a spec can nest without end
const MAX_LIST = 100; // values listed of an enum
const NO_FORMAT = new Set(['int32', 'int64', 'float', 'double']);

const STATUS = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No content', 301: 'Moved', 302: 'Found', 304: 'Not modified',
  400: 'Bad request', 401: 'Not signed in', 403: 'Forbidden', 404: 'Not found', 405: 'Method not allowed', 406: 'Not acceptable',
  409: 'Conflict', 410: 'Gone', 412: 'Precondition failed', 413: 'Too large', 415: 'Unsupported type', 422: 'Not valid',
  429: 'Too many requests', 500: 'Server error', 501: 'Not implemented', 502: 'Bad gateway', 503: 'Unavailable', 504: 'Timeout',
  default: 'Any other answer',
};

const text = (v, max = 6000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const shown = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

// What a value may be, in words: "1 to 5", "up to 200 characters", "one of: A, B"
function rulesOf(sc) {
  const out = [];
  if (Array.isArray(sc.enum)) {
    const list = sc.enum.slice(0, MAX_LIST).map(shown).join(', ');
    out.push(`one of: ${list}${sc.enum.length > MAX_LIST ? `, and ${sc.enum.length - MAX_LIST} more` : ''}`);
  }
  // 3.0 says exclusiveMinimum: true beside the minimum; 3.1 gives the number itself
  const lowNo = typeof sc.exclusiveMinimum === 'number';
  const highNo = typeof sc.exclusiveMaximum === 'number';
  const low = lowNo ? sc.exclusiveMinimum : sc.minimum;
  const high = highNo ? sc.exclusiveMaximum : sc.maximum;
  const lowOut = lowNo || sc.exclusiveMinimum === true;
  const highOut = highNo || sc.exclusiveMaximum === true;
  if (low !== undefined && high !== undefined && !lowOut && !highOut) out.push(`${low} to ${high}`);
  else {
    if (low !== undefined) out.push(`${lowOut ? 'over' : 'at least'} ${low}`);
    if (high !== undefined) out.push(`${highOut ? 'under' : 'at most'} ${high}`);
  }
  const size = (min, max, what) => {
    if (min !== undefined && max !== undefined) out.push(min === max ? `exactly ${min} ${what}` : `${min} to ${max} ${what}`);
    else if (max !== undefined) out.push(`up to ${max} ${what}`);
    else if (min !== undefined) out.push(`at least ${min} ${what}`);
  };
  size(sc.minLength, sc.maxLength, 'characters');
  size(sc.minItems, sc.maxItems, 'items');
  if (sc.uniqueItems) out.push('no repeats');
  if (sc.pattern) out.push(`pattern: ${sc.pattern}`);
  if (sc.nullable === true || (Array.isArray(sc.type) && sc.type.includes('null'))) out.push('can be null');
  if (sc.readOnly) out.push('only in answers');
  if (sc.writeOnly) out.push('only when sending');
  if (sc.default !== undefined) out.push(`default: ${shown(sc.default)}`);
  return out;
}

function typeWords(sc) {
  const base = typeOf(sc) || 'any';
  return sc.format && !NO_FORMAT.has(sc.format) ? `${base} · ${sc.format}` : base;
}

// A schema as a tree: its type and rules in words, and its fields. A model that holds itself stops at its second time.
function viewOf(ctx, node, depth = 0, trail = []) {
  if (!node || typeof node !== 'object') return { type: 'any', rules: [], description: '', children: [] };
  if (typeof node.$ref === 'string' && !node.$ref.startsWith('#')) {
    ctx.external.add(node.$ref.split('#')[0]);
    return { type: `in ${node.$ref}`, external: true, rules: [], description: '', children: [] };
  }
  const ref = refName(node);
  const sc = flat(ctx.s.deref, node);
  const view = { type: ref || typeWords(sc), ref, rules: rulesOf(sc), description: text(sc.description), children: [] };
  if (sc.example !== undefined) view.example = shown(sc.example);
  if (sc.deprecated) view.deprecated = true;
  if (ref && trail.includes(ref)) {
    view.again = true;
    return view;
  }
  const next = ref ? [...trail, ref] : trail;
  if (depth >= MAX_DEPTH || ctx.count > MAX_FIELDS) {
    view.cut = true;
    return view;
  }
  const child = (name, required, value) => {
    ctx.count += 1;
    return { name, required, ...viewOf(ctx, value, depth + 1, next) };
  };
  if (sc.items && typeof sc.items === 'object') {
    const item = viewOf(ctx, sc.items, depth, next);
    view.type = `list of ${item.type}`;
    view.children = item.children;
    view.ref = item.ref || '';
    view.rules.push(...item.rules.map((r) => `each: ${r}`));
    if (!view.description) view.description = item.description;
  } else if (sc.properties && typeof sc.properties === 'object') {
    const needed = new Set(Array.isArray(sc.required) ? sc.required : []);
    view.children = Object.entries(sc.properties).map(([name, value]) => child(name, needed.has(name), value));
  } else if (sc.additionalProperties && typeof sc.additionalProperties === 'object') {
    const item = viewOf(ctx, sc.additionalProperties, depth, next);
    view.type = `map of ${item.type}`;
    view.children = item.children;
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (!Array.isArray(sc[key])) continue;
    if (!ref) view.type = key === 'oneOf' ? 'one of these' : 'any of these';
    view.children.push(...sc[key].map((part, i) => child(refName(part) || `option ${i + 1}`, false, part)));
  }
  return view;
}

// An example made from a schema: its own when it has one, else a value that fits its type and rules. seen: the models on
// the way here, so one that holds itself ends. left: how many values it may still make, as models that all hold each
// other would otherwise make more than can ever be written.
function madeExample(s, node, seen = [], depth = 0, left = { values: MAX_FIELDS }) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH || left.values <= 0) return undefined;
  left.values -= 1;
  if (typeof node.$ref === 'string' && !node.$ref.startsWith('#')) return undefined;
  const ref = refName(node);
  if (ref && seen.includes(ref)) return undefined;
  const next = ref ? [...seen, ref] : seen;
  const sc = flat(s.deref, node);
  if (sc.example !== undefined) return sc.example;
  if (Array.isArray(sc.examples) && sc.examples.length) return sc.examples[0];
  if (sc.default !== undefined) return sc.default;
  if (Array.isArray(sc.enum) && sc.enum.length) return sc.enum[0];
  if (Array.isArray(sc.oneOf) && sc.oneOf.length) return madeExample(s, sc.oneOf[0], next, depth + 1, left);
  if (Array.isArray(sc.anyOf) && sc.anyOf.length) return madeExample(s, sc.anyOf[0], next, depth + 1, left);
  const type = typeOf(sc);
  if (type.includes('array')) {
    const item = madeExample(s, sc.items, next, depth + 1, left);
    return item === undefined ? [] : [item];
  }
  if (type.includes('object')) {
    const out = {};
    for (const [name, value] of Object.entries(sc.properties || {})) {
      const v = madeExample(s, value, next, depth + 1, left);
      if (v !== undefined) out[name] = v;
    }
    if (!sc.properties && sc.additionalProperties && typeof sc.additionalProperties === 'object') {
      const v = madeExample(s, sc.additionalProperties, next, depth + 1, left);
      if (v !== undefined) out.key = v;
    }
    return out;
  }
  if (type.includes('integer')) return sc.minimum !== undefined ? sc.minimum : 1;
  if (type.includes('number')) return sc.minimum !== undefined ? sc.minimum : 1.5;
  if (type.includes('boolean')) return true;
  if (type.includes('string')) {
    const formats = { 'date-time': '2026-01-31T10:00:00Z', date: '2026-01-31', time: '10:00:00Z', uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6', email: 'someone@example.com', uri: 'https://example.com', url: 'https://example.com', byte: 'dGV4dA==', ipv4: '192.0.2.1' };
    if (formats[sc.format]) return formats[sc.format];
    return sc.minLength > 6 ? 'x'.repeat(sc.minLength) : 'string';
  }
  return undefined;
}

// The example of a body as JSON: the one written beside it in the spec, else one made from its schema.
function bodyExample(s, media, schema) {
  const m = media && typeof media === 'object' ? media : {};
  let value;
  let own = false;
  if (m.example !== undefined) {
    value = m.example;
    own = true;
  } else if (m.examples && typeof m.examples === 'object') {
    const first = Object.values(m.examples)[0];
    if (first !== undefined) {
      value = s.deref(first).value !== undefined ? s.deref(first).value : first;
      own = true;
    }
  }
  if (value === undefined) {
    value = madeExample(s, schema);
    own = Boolean(schema && flat(s.deref, schema).example !== undefined);
  }
  if (value === undefined) return null;
  return { text: typeof value === 'string' ? value : JSON.stringify(value, null, 2), own };
}

// The bodies of an endpoint, with OpenAPI 3 and Swagger 2 made one: { contentType, view, example }
function bodyOf(ctx, schema, media, contentType) {
  ctx.count = 0;
  return { contentType, view: viewOf(ctx, schema), example: bodyExample(ctx.s, media, schema) };
}

function fieldNames(view, out = []) {
  for (const c of (view && view.children) || []) {
    out.push(c.name);
    fieldNames(c, out);
  }
  return out;
}

// Who may call it, as the spec names its ways in. apiKey: the header or query field to send.
function authOf(doc, name) {
  const schemes = (doc.components && doc.components.securitySchemes) || doc.securityDefinitions || {};
  const sc = schemes[name] && typeof schemes[name] === 'object' ? schemes[name] : {};
  if (sc.type === 'apiKey') return { name, kind: 'apiKey', field: text(sc.name), in: text(sc.in), label: `${text(sc.name) || name} (${text(sc.in) || 'key'})` };
  if (sc.type === 'http' && String(sc.scheme).toLowerCase() === 'bearer') return { name, kind: 'bearer', label: `Bearer token${sc.bearerFormat ? ` (${text(sc.bearerFormat)})` : ''}` };
  if ((sc.type === 'http' && String(sc.scheme).toLowerCase() === 'basic') || sc.type === 'basic') return { name, kind: 'basic', label: 'Basic login' };
  if (sc.type === 'oauth2') return { name, kind: 'bearer', label: 'OAuth2 token' };
  if (sc.type === 'openIdConnect') return { name, kind: 'bearer', label: 'OpenID Connect token' };
  return { name, kind: 'other', label: name };
}

function serversOf(doc) {
  if (doc.openapi) {
    return (Array.isArray(doc.servers) ? doc.servers : []).filter((x) => x && x.url).map((x) => {
      // {env} in the address: its default value
      const vars = x.variables && typeof x.variables === 'object' ? x.variables : {};
      const url = String(x.url).replace(/\{([^}]+)\}/g, (all, k) => (vars[k] && vars[k].default !== undefined ? vars[k].default : all));
      return { url, description: text(x.description, 200) };
    });
  }
  if (!doc.host) return doc.basePath ? [{ url: String(doc.basePath), description: '' }] : [];
  const scheme = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes[0] : 'https';
  return [{ url: `${scheme}://${doc.host}${doc.basePath || ''}`, description: '' }];
}

function paramOf(ctx, p) {
  // OpenAPI 3 has its type under schema, Swagger 2 beside its name
  const schema = p.schema || p;
  ctx.count = 0;
  const view = viewOf(ctx, schema);
  const example = p.example !== undefined ? p.example : view.example !== undefined ? view.example : madeExample(ctx.s, schema);
  return { ...view, name: String(p.name), in: String(p.in), required: Boolean(p.required) || p.in === 'path', description: text(p.description) || view.description, deprecated: Boolean(p.deprecated), example: example === undefined ? undefined : shown(example) };
}

function readSpec(specText) {
  const doc = parseSpec(specText, 'This');
  const s = side(doc);
  const ctx = { s, external: new Set(), count: 0 };
  const tagInfo = new Map((Array.isArray(doc.tags) ? doc.tags : []).filter((t) => t && t.name).map((t) => [String(t.name), text(t.description, 600)]));
  const groups = new Map([...tagInfo.keys()].map((name) => [name, []]));
  const endpoints = [];
  const usedBy = new Map();
  for (const e of operations(s).values()) {
    const op = e.op;
    const id = `${e.method} ${e.path}`;
    const params = [...e.params.values()].filter((p) => p.in !== 'body' && p.in !== 'formData').map((p) => paramOf(ctx, p));
    // the body: with its media type's own example, when OpenAPI 3 has one
    const rb = requestBody(s, e);
    let body = null;
    if (rb) {
      const [contentType, schema] = Object.entries(rb.content)[0] || ['', {}];
      const media = doc.openapi && op.requestBody ? (s.deref(op.requestBody).content || {})[contentType] : null;
      const m = media ? s.deref(media) : null;
      const swaggerBody = !doc.openapi ? [...e.params.values()].find((p) => p.in === 'body') : null;
      body = { required: rb.required, description: text(doc.openapi ? s.deref(op.requestBody).description : swaggerBody && swaggerBody.description), others: Object.keys(rb.content).slice(1), ...bodyOf(ctx, schema, m, contentType) };
    }
    const answers = [];
    for (const [code, raw] of Object.entries(op.responses || {})) {
      const r = s.deref(raw);
      const produces = (op.produces || doc.produces || ['application/json'])[0];
      const content = doc.openapi ? (r.content && typeof r.content === 'object' ? r.content : {}) : r.schema ? { [produces]: { schema: r.schema, ...(r.examples && r.examples[produces] !== undefined ? { example: r.examples[produces] } : {}) } } : {};
      const [contentType, rawMedia] = Object.entries(content)[0] || ['', null];
      const media = rawMedia ? s.deref(rawMedia) : null;
      const part = media && media.schema ? bodyOf(ctx, media.schema, media, contentType) : media ? { contentType, view: null, example: bodyExample(s, media, null) } : { contentType: '', view: null, example: null };
      answers.push({ status: String(code), meaning: STATUS[code] || '', description: text(r.description), ...part });
    }
    answers.sort((a, b) => (a.status === 'default') - (b.status === 'default') || a.status.localeCompare(b.status));
    const auth = (Array.isArray(op.security) ? op.security : Array.isArray(doc.security) ? doc.security : []).flatMap((req) => Object.keys(req || {}));
    const tag = Array.isArray(op.tags) && op.tags.length ? String(op.tags[0]) : 'Other';
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(id);
    const used = endpointModels(s, e);
    for (const name of [...used.req, ...used.res]) usedBy.set(name, new Set([...(usedBy.get(name) || []), id]));
    endpoints.push({
      id,
      method: e.method,
      path: e.path,
      summary: text(op.summary, 300),
      description: text(op.description),
      operationId: text(op.operationId, 200),
      deprecated: Boolean(op.deprecated),
      tag,
      auth: [...new Set(auth)].map((name) => authOf(doc, name)),
      params,
      body,
      answers,
      words: [e.method, e.path, op.summary, op.description, op.operationId, tag, ...params.map((p) => p.name), ...fieldNames(body && body.view), ...answers.flatMap((a) => fieldNames(a.view))].filter(Boolean).join(' ').toLowerCase(),
    });
  }
  const models = Object.entries(modelsOf(doc)).map(([name, raw]) => {
    ctx.count = 0;
    const node = { $ref: `${doc.openapi ? '#/components/schemas/' : '#/definitions/'}${name}` };
    const view = viewOf(ctx, node);
    const example = bodyExample(s, null, node);
    return { name, description: view.description || text((raw || {}).description), view, example, usedBy: [...(usedBy.get(name) || [])], words: [name, view.description, ...fieldNames(view)].filter(Boolean).join(' ').toLowerCase() };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const info = doc.info && typeof doc.info === 'object' ? doc.info : {};
  return {
    title: text(info.title, 200) || 'An API with no title',
    version: info.version === undefined ? '' : String(info.version),
    description: text(info.description),
    kind: doc.openapi ? `OpenAPI ${doc.openapi}` : `Swagger ${doc.swagger}`,
    servers: serversOf(doc),
    groups: [...groups.entries()].filter(([, ids]) => ids.length).map(([name, ids]) => ({ name, description: tagInfo.get(name) || '', ids })),
    endpoints,
    models,
    external: [...ctx.external].filter(Boolean).sort(),
  };
}

module.exports = { readSpec, viewOf, madeExample, rulesOf, modelsUsed };
