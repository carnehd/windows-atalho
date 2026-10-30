// Builds a trace (a waterfall of spans, like Datadog's) from the logs of one request.
// A span is one service's part of the request: its logs with the same spanId (or, without spanIds, its logs
// close together in time). Each span is linked to its caller, by order of confidence:
//   1. parentSpanId (or parent_span_id, parentId) on its logs;
//   2. the W3C traceparent it received, 00-<trace id>-<caller span>-01;
//   3. the span of another service that contains it in time.
// Fields are read from the log itself and from its message when the message is JSON (as many application loggers write it).

const W3C = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i;

function fieldsOf(rec) {
  const raw = rec.raw || {};
  const msg = typeof rec.message === 'string' ? rec.message.trim() : '';
  let json = rec.json || null; // the JSON in the message, read by the logs service
  if (!json && msg.startsWith('{') && msg.endsWith('}')) {
    try {
      json = JSON.parse(msg);
    } catch {
      json = null;
    }
  }
  return json && typeof json === 'object' ? { ...json, ...raw } : raw;
}

const pick = (f, names) => {
  for (const n of names) if (f[n] != null && f[n] !== '') return String(f[n]);
  return null;
};

function traceIdOf(f) {
  const direct = pick(f, ['traceId', 'trace_id', 'trace.id', 'traceID']);
  if (direct) return direct;
  const m = W3C.exec(pick(f, ['traceparent']) || '');
  return m ? m[1] : null;
}

function durationOf(rec, f) {
  const d = Number(pick(f, ['durationMs', 'duration_ms', 'duration']));
  if (Number.isFinite(d) && d > 0) return d;
  const m = /\bin (\d+) ?ms\b/.exec(rec.message || '');
  return m ? Number(m[1]) : null;
}

function buildTrace(records) {
  const logs = [...records].filter((r) => r.ts != null).sort((a, b) => a.ts - b.ts);
  const spans = new Map();
  const loose = [];
  logs.forEach((rec, index) => {
    const f = fieldsOf(rec);
    const item = { rec, f, index };
    const spanId = pick(f, ['spanId', 'span_id', 'span.id']);
    if (!spanId) {
      loose.push(item);
      return;
    }
    const key = `${rec.service}|${spanId}`;
    if (!spans.has(key)) spans.set(key, { key, service: rec.service, spanId, items: [] });
    spans.get(key).items.push(item);
  });
  const bounds = (s) => {
    s.start = s.items[0].rec.ts;
    s.end = s.items[s.items.length - 1].rec.ts;
  };
  for (const s of spans.values()) bounds(s);
  // Logs without a spanId join the span of the same service that is running at that time, or one of their own.
  for (const item of loose) {
    let best = null;
    let bestGap = Infinity;
    for (const s of spans.values()) {
      if (s.service !== item.rec.service) continue;
      const gap = item.rec.ts < s.start ? s.start - item.rec.ts : item.rec.ts > s.end ? item.rec.ts - s.end : 0;
      if (gap <= 1000 && gap < bestGap) { best = s; bestGap = gap; }
    }
    if (!best) {
      const key = `${item.rec.service}|-`;
      if (!spans.has(key)) spans.set(key, { key, service: item.rec.service, spanId: null, items: [] });
      best = spans.get(key);
    }
    best.items.push(item);
    best.items.sort((a, b) => a.rec.ts - b.rec.ts);
    bounds(best);
  }

  const list = [...spans.values()];
  for (const s of list) {
    bounds(s);
    // "POST /api/orders 201 in 230 ms" at the end of a span says when it started
    for (const { rec, f } of s.items) {
      const d = durationOf(rec, f);
      if (d && rec.ts - d < s.start) s.start = rec.ts - d;
    }
    const withPath = s.items.find(({ f }) => f.method && (f.path || f.uri));
    s.name = withPath ? `${withPath.f.method} ${withPath.f.path || withPath.f.uri}` : String(s.items[0].rec.message || '').split('\n')[0].slice(0, 90);
    s.error = s.items.some(({ rec, f }) => rec.level === 'error' || Number(f.status) >= 500);
    s.status = Math.max(0, ...s.items.map(({ f }) => Number(f.status) || 0)) || null;
    const withParent = s.items.find(({ f }) => pick(f, ['parentSpanId', 'parent_span_id', 'parentId', 'parent.id']));
    if (withParent) {
      s.parentSpanId = pick(withParent.f, ['parentSpanId', 'parent_span_id', 'parentId', 'parent.id']);
      s.linkedBy = 'parentSpanId';
    } else {
      const withTp = s.items.find(({ f }) => W3C.test(pick(f, ['traceparent']) || ''));
      const caller = withTp && W3C.exec(pick(withTp.f, ['traceparent']))[2];
      if (caller && caller !== s.spanId) {
        s.parentSpanId = caller;
        s.linkedBy = 'traceparent';
      }
    }
  }
  const bySpanId = new Map(list.filter((s) => s.spanId).map((s) => [s.spanId, s]));
  for (const s of list) {
    const p = s.parentSpanId && bySpanId.get(s.parentSpanId);
    if (p && p !== s) {
      s.parent = p;
      continue;
    }
    // no ids: the shortest span of another service that contains this one
    let best = null;
    for (const o of list) {
      if (o === s || o.service === s.service) continue;
      if (o.start <= s.start && s.end <= o.end + 5 && o.end - o.start > s.end - s.start && (!best || o.end - o.start < best.end - best.start)) best = o;
    }
    if (best) {
      s.parent = best;
      s.linkedBy = 'time';
    } else {
      s.linkedBy = s.linkedBy && s.parentSpanId ? 'missing parent' : 'root';
    }
  }
  // no loops
  for (const s of list) {
    const seen = new Set([s]);
    for (let p = s.parent; p; p = p.parent) {
      if (seen.has(p)) { s.parent = null; s.linkedBy = 'root'; break; }
      seen.add(p);
    }
  }

  const children = new Map(list.map((s) => [s, []]));
  const roots = [];
  for (const s of list) (s.parent ? children.get(s.parent) : roots).push(s);
  const byStart = (a, b) => a.start - b.start || a.end - b.end;
  roots.sort(byStart);
  const out = [];
  const walk = (s, depth) => {
    out.push({
      id: s.key,
      service: s.service,
      origin: s.items[0].rec.origin || 'openshift',
      name: s.name,
      spanId: s.spanId,
      parentId: s.parent ? s.parent.key : null,
      linkedBy: s.linkedBy,
      depth,
      start: s.start,
      end: s.end,
      duration: s.end - s.start,
      error: s.error,
      status: s.status,
      logs: s.items.map((i) => i.index),
    });
    children.get(s).sort(byStart).forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  const start = out.length ? Math.min(...out.map((s) => s.start)) : null;
  const end = out.length ? Math.max(...out.map((s) => s.end)) : null;
  return {
    spans: out,
    logs,
    start,
    end,
    duration: start == null ? 0 : end - start,
    services: new Set(logs.map((l) => l.service)).size,
    errors: logs.filter((l) => l.level === 'error').length,
  };
}

module.exports = { buildTrace, traceIdOf, fieldsOf };
