// "Not in the logs": what nobody tried yet, made from the requests of the logs (log-tests.js) with one change each:
// a field taken away, emptied or 0; a query parameter taken away, emptied or 0; an id that is not there; an action on
// something after another one (cancel after pay, pay after cancel...); an endpoint the code has and the logs never
// saw. What the service answers is not known before: Try sends them (each with what it needs made first, so it starts
// from something new) and keeps the answers; the ones ticked become tests that check that answer, as the tests of the
// logs do. The code read by code-answers.js says which answer each one got to (its file and line) and which answers of
// the code no request got to.
const { answerMessage, sameMessage } = require('./code-answers');

const MAX_SCENARIOS = 80;
const MAX_FIELDS = 10;
const SEND_TIMEOUT_MS = 15000;
const CHANGES = ['POST', 'PUT', 'PATCH', 'DELETE'];

const lt = () => require('./log-tests'); // the helpers of the tests of the logs (it requires this file too)

const clone = (v) => JSON.parse(JSON.stringify(v));

function setAt(obj, at, value) {
  let cur = obj;
  for (const k of at.slice(0, -1)) cur = cur[k];
  cur[at[at.length - 1]] = value;
}

function removeAt(obj, at) {
  let cur = obj;
  for (const k of at.slice(0, -1)) cur = cur[k];
  if (Array.isArray(cur)) cur.splice(at[at.length - 1], 1);
  else delete cur[at[at.length - 1]];
}

const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : Array.isArray(v) ? '[]' : String(v));
const label = (at) => at.reduce((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${k}` : String(k)), '');

// What an action on something is called: what comes after its id (POST payments), or its method (DELETE).
function actionName(c) {
  const segs = c.path.split('/');
  const last = segs.map((s, i) => (lt().isIdSegment(s) ? i : -1)).filter((i) => i >= 0).pop();
  const rest = last === undefined ? [] : segs.slice(last + 1).filter(Boolean);
  return rest.length ? `${c.method} ${rest.join('/')}` : c.method;
}

// The variations of the cases of the logs, and the endpoints of the code the logs never saw (a GET with nothing to
// fill in: it is called as it is). Returns [{ id, group, method, template, kind, label, change, steps, made }]:
// steps are [{ caseId, change, setup }] or [{ raw }]; made: where the id is in the answer of the setup.
function variationsOf(cases, code = null) {
  const { chainOf, parseJson, queryPairs, isIdSegment, deepAt } = lt();
  const chain = chainOf(cases);
  const out = [];
  const add = (s) => {
    if (out.length < MAX_SCENARIOS) out.push({ id: `v${out.length + 1}`, ...s });
  };
  // what a case needs made first: the request that made the id it uses (its first one)
  const setupOf = (c) => {
    const producer = (chain.from.get(c.id) || [])[0];
    const set = producer && (chain.sets.get(producer.id) || [])[0];
    return set ? { caseId: producer.id, at: set.at } : null;
  };
  const steps = (c, change, setup) => (setup ? [{ caseId: setup.caseId, setup: true }, { caseId: c.id, change }] : [{ caseId: c.id, change }]);
  const sources = [];
  const taken = new Set();
  for (const c of cases) {
    const key = `${c.method} ${c.template}`;
    if (c.status >= 200 && c.status < 300 && !taken.has(key)) {
      taken.add(key);
      sources.push(c);
    }
  }
  for (const c of sources) {
    const setup = setupOf(c);
    const base = { group: `${c.method} ${c.template}`, method: c.method, template: c.template, made: setup ? setup.at : null };
    const field = (lab, change) => add({ ...base, kind: 'field', label: lab, change, steps: steps(c, change, setup) });
    // the payload: each field taken away, emptied, 0; those of its first item of a list, and of an object in it
    const body = ['POST', 'PUT', 'PATCH'].includes(c.method) ? parseJson(c.rep.payload) : undefined;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const [k, v] of Object.entries(body).slice(0, MAX_FIELDS)) {
        field(`without ${k}`, { op: 'remove', at: [k] });
        if (typeof v === 'string') field(`${k} empty`, { op: 'set', at: [k], value: '' });
        else if (typeof v === 'number') field(`${k} 0`, { op: 'set', at: [k], value: 0 });
        else if (Array.isArray(v)) {
          field(`${k} an empty list`, { op: 'set', at: [k], value: [] });
          if (v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) {
            for (const [kk, vv] of Object.entries(v[0]).slice(0, 6)) {
              if (typeof vv === 'number') field(`${k}[0].${kk} 0`, { op: 'set', at: [k, 0, kk], value: 0 });
              else if (typeof vv === 'string') field(`${k}[0].${kk} empty`, { op: 'set', at: [k, 0, kk], value: '' });
            }
          }
        } else if (v && typeof v === 'object') {
          for (const [kk, vv] of Object.entries(v).slice(0, 6)) {
            if (typeof vv === 'number') field(`${k}.${kk} 0`, { op: 'set', at: [k, kk], value: 0 });
            else if (typeof vv === 'string') field(`${k}.${kk} empty`, { op: 'set', at: [k, kk], value: '' });
          }
        }
      }
    }
    // the query: each parameter taken away, emptied, 0
    for (const [name, value] of queryPairs(c.query)) {
      field(`without ${name}`, { op: 'query', name, remove: true });
      field(`${name} empty`, { op: 'query', name, value: '' });
      if (/^-?\d+(\.\d+)?$/.test(value) && value !== '0') field(`${name} 0`, { op: 'query', name, value: '0' });
    }
    // an id that is not there (unless the logs have it already)
    const segs = c.path.split('/');
    const idAt = segs.map((s, i) => (isIdSegment(s) ? i : -1)).filter((i) => i >= 0).pop();
    if (idAt !== undefined && !cases.some((x) => x.method === c.method && x.template === c.template && x.status === 404)) {
      const seg = segs[idAt];
      const value = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) ? '00000000-0000-0000-0000-000000000000' : /^\d+$/.test(seg) ? '99999999' : `${seg.replace(/\d/g, '0')}`;
      add({ ...base, made: null, kind: 'id', label: 'an id that is not there', change: { op: 'id', index: idAt, value }, steps: [{ caseId: c.id, change: { op: 'id', index: idAt, value } }] });
    }
  }
  // actions on something one after another, as the logs never had them: what it needs made (by the request that
  // made the one a acted on), then a, then b. The actions on the same kind of thing go together, whoever made it.
  const actions = new Map(); // what makes it (method and template) -> { producers, list }
  for (const c of sources) {
    if (!CHANGES.includes(c.method)) continue;
    const setup = setupOf(c);
    if (!setup) continue;
    const producer = cases.find((x) => x.id === setup.caseId);
    const key = `${producer.method} ${producer.template}`;
    if (!actions.has(key)) actions.set(key, { producers: new Map(), list: [] });
    actions.get(key).producers.set(producer.id, setup.at);
    actions.get(key).list.push({ c, setup });
  }
  for (const { producers, list } of actions.values()) {
    // the ids they made, and what happened to each in the logs
    const made = new Set();
    for (const [id, at] of producers) for (const smp of cases.find((x) => x.id === id).samples) made.add(String(deepAt(parseJson(smp.response), at) ?? ''));
    made.delete('');
    const done = new Map(); // id -> [{ key, ok }] in order
    const all = cases.flatMap((c) => c.samples.map((smp) => ({ c, smp }))).sort((a, b) => a.smp.ts - b.smp.ts);
    for (const { c, smp } of all) {
      const seg = c.path.split('/').find((x) => made.has(x));
      if (!seg) continue;
      if (!done.has(seg)) done.set(seg, []);
      done.get(seg).push({ key: `${c.method} ${c.template}`, ok: smp.status >= 200 && smp.status < 300 });
    }
    const seen = (a, b) => [...done.values()].some((l) => l.some((x, i) => x.ok && x.key === `${a.method} ${a.template}` && l.slice(i + 1).some((y) => y.key === `${b.method} ${b.template}`)));
    for (const { c: a, setup } of list) {
      for (const { c: b } of list) {
        if (seen(a, b)) continue;
        add({
          group: `${b.method} ${b.template}`, method: b.method, template: b.template, kind: 'sequence', made: setup.at,
          label: a === b ? `${actionName(b)} twice` : `${actionName(b)} after ${actionName(a)}`,
          change: null, steps: [{ caseId: setup.caseId, setup: true }, { caseId: a.id }, { caseId: b.id }],
        });
      }
    }
  }
  // the endpoints of the code the logs never saw: a GET with nothing in its path or body is called as it is
  for (const e of (code && code.endpoints) || []) {
    if (cases.some((c) => c.method === e.method && c.template === e.template)) continue;
    if (e.method !== 'GET' || /\{/.test(e.path) || e.params.some((p) => p.kind === 'body')) continue;
    add({ group: `${e.method} ${e.template}`, method: e.method, template: e.template, kind: 'call', label: 'never in the logs', change: null, made: null, steps: [{ raw: { method: e.method, path: e.path, query: '', headers: {}, payload: '' } }] });
  }
  return out;
}

// One step's request: the case's (or the raw one), with the change, and the id made by the setup in its path.
function stepRequest(step, casesById, uses, madeId) {
  const { parseJson } = lt();
  const c = step.caseId ? casesById.get(step.caseId) : null;
  const src = c ? c.rep : step.raw;
  const segs = (c ? c.path : step.raw.path).split('/');
  if (madeId != null && c) for (const k of Object.keys(uses.get(c.id) || {})) segs[k] = madeId;
  let query = c ? c.query : step.raw.query || '';
  let payload = src.payload == null ? '' : String(src.payload);
  const ch = step.change;
  if (ch && (ch.op === 'remove' || ch.op === 'set')) {
    const j = clone(parseJson(payload));
    if (ch.op === 'remove') removeAt(j, ch.at);
    else setAt(j, ch.at, clone(ch.value));
    payload = JSON.stringify(j);
  } else if (ch && ch.op === 'query') {
    const parts = query.split('&').filter(Boolean);
    const i = parts.findIndex((p) => decodeURIComponent(p.split('=')[0]) === ch.name);
    if (i >= 0) {
      if (ch.remove) parts.splice(i, 1);
      else parts[i] = `${parts[i].split('=')[0]}=${encodeURIComponent(ch.value)}`;
    }
    query = parts.join('&');
  } else if (ch && ch.op === 'id') segs[ch.index] = ch.value;
  return { c, method: c ? c.method : step.raw.method, path: segs.join('/'), query, headers: src.headers || {}, payload, service: c ? c.service : '' };
}

// What a change does, in a few words: without customer / nif "" / lines[0].quantity 0 / id 99999999.
function changeText(s, casesById) {
  const ch = s.steps[s.steps.length - 1].change;
  if (s.kind === 'sequence') return s.steps.map((st, i) => (i === 0 ? 'makes one' : actionName(casesById.get(st.caseId)))).join(' → ');
  if (s.kind === 'call') return `${s.method} ${s.steps[0].raw.path}`;
  if (!ch) return '';
  if (ch.op === 'remove') return `without ${label(ch.at)}`;
  if (ch.op === 'set') return `${label(ch.at)} ${show(ch.value)}`;
  if (ch.op === 'query') return ch.remove ? `without ?${ch.name}` : `?${ch.name}=${ch.value}`;
  return `id ${ch.value}`;
}

// Sends one scenario, step by step, to the address; returns { exchanges, error }.
async function runScenario(s, { casesById, uses, address, headersFor, fetch }) {
  const { parseJson, deepAt } = lt();
  const exchanges = [];
  let madeId = null;
  for (const step of s.steps) {
    const r = stepRequest(step, casesById, uses, madeId);
    const url = `${address.replace(/\/+$/, '')}${r.path}${r.query ? `?${r.query}` : ''}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    const t0 = Date.now();
    let status;
    let text;
    try {
      const res = await fetch(url, { method: r.method, headers: headersFor(r.headers, r.payload), body: r.payload && r.method !== 'GET' && r.method !== 'HEAD' ? r.payload : undefined, signal: controller.signal });
      status = res.status;
      text = await res.text();
    } catch (e) {
      return { exchanges, error: `${r.method} ${url}: ${controller.signal.aborted ? `no answer in ${SEND_TIMEOUT_MS / 1000} s` : e.cause && e.cause.code ? e.cause.code : e.message}` };
    } finally {
      clearTimeout(timer);
    }
    exchanges.push({ ts: t0, service: r.service, origin: '', method: r.method, uri: `${r.path}${r.query ? `?${r.query}` : ''}`, headers: r.headers, payload: r.payload, status, response: text, duration: Date.now() - t0, traceId: '' });
    if (step.setup) {
      if (status >= 300) return { exchanges, error: `What it needs made first (${r.method} ${r.path}) answered ${status}` };
      madeId = String(deepAt(parseJson(text), s.made) ?? '');
      if (!madeId) return { exchanges, error: `What it needs made first (${r.method} ${r.path}) answered no id` };
    }
  }
  return { exchanges, error: null };
}

// The answer a scenario got, against the code and the logs: { status, message, code: answer, same: the case of the
// logs with the same answer }.
function judge(s, tried, codeEndpoints, cases) {
  const last = tried.exchanges[tried.exchanges.length - 1];
  if (!last || tried.error) return null;
  const message = answerMessage(last.response);
  const ep = (codeEndpoints || []).filter((e) => e.method === s.method && e.template === s.template);
  const code = ep.flatMap((e) => e.answers).find((a) => a.status === last.status && (a.cause === 'ok' || sameMessage(a.message, message))) || null;
  const same = cases.find((c) => c.method === s.method && c.template === s.template && c.status === last.status && answerMessage(c.rep.response) === message) || null;
  return { status: last.status, message, code, same };
}

// The answers of the code nobody got to: not in the logs, nor in what was tried. Each with why, when the code says.
function unreached(codeEndpoints, cases, scenarios) {
  const out = [];
  for (const e of codeEndpoints || []) {
    const got = [
      ...cases.filter((c) => c.method === e.method && c.template === e.template).map((c) => ({ status: c.status, message: answerMessage(c.rep.response) })),
      ...scenarios.filter((s) => s.method === e.method && s.template === e.template && s.result).map((s) => s.result),
    ];
    for (const a of e.answers) {
      if (got.some((g) => g.status === a.status && (a.cause === 'ok' || sameMessage(a.message, g.message)))) continue;
      out.push({ group: `${e.method} ${e.template}`, method: e.method, template: e.template, status: a.status, message: a.message, file: a.file, line: a.line, cause: a.cause, condition: a.condition, never: !cases.some((c) => c.method === e.method && c.template === e.template) });
    }
  }
  return out;
}

module.exports = { variationsOf, stepRequest, changeText, runScenario, judge, unreached, actionName };
