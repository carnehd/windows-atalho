// -- Format in the Maven output: JSON, SQL and XML that a log line has on one line, laid out on lines of their own
// under the text of the line, indented, with their parts marked for colour (maven.js paints them with CSS highlights,
// so the output stays one text). What was written is kept: only the spaces between the parts change, nothing is read
// and written again (a long number, 1.50, the escapes of a string stay as they came). --
const LOG_FMT_MIN = 40; // a shorter JSON, SQL or XML stays on its line
const LOG_FMT_MAX_LINE = 200000; // a longer line is left as it came
const LOG_FMT_INDENT = '    '; // a block under the text of its line
const LOG_FMT_WORTH = /[{[<]|select|insert|update|delete|with|merge/i;

// What a block writes: the text from the start of its first line, and the marks of its parts, [start, end, kind]
// flat (kind: key, str, num, kw).
function logWriter(indent, unit) {
  const w = { text: indent, marks: [], level: 0, fresh: true };
  w.put = (t, kind) => {
    if (kind) w.marks.push(w.text.length, w.text.length + t.length, kind);
    w.text += t;
    w.fresh = false;
  };
  w.nl = (level) => {
    w.text += `\n${indent}${unit.repeat(Math.max(0, level))}`;
    w.level = level;
    w.fresh = true;
  };
  return w;
}

// -- JSON: an object, or an array with objects or arrays in it. Strict, so "[main]", "{}" or a Java toString() are
// not taken for it. --
const JSON_ATOM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

function readJson(s, i) {
  const toks = [];
  let p = i;
  const ws = () => {
    while (s[p] === ' ' || s[p] === '\t') p++;
  };
  const str = () => {
    for (let q = p + 1; q < s.length; q++) {
      const c = s.charCodeAt(q);
      if (c === 34) {
        const t = s.slice(p, q + 1);
        p = q + 1;
        return t;
      }
      if (c === 92) q++;
      else if (c < 32) return null;
    }
    return null;
  };
  const value = (depth) => {
    ws();
    const c = s[p];
    if (c === '{' || c === '[') {
      if (depth > 100) return false;
      const close = c === '{' ? '}' : ']';
      toks.push({ k: 'open', t: c });
      p++;
      ws();
      if (s[p] === close) {
        toks.push({ k: 'close', t: close });
        p++;
        return true;
      }
      for (;;) {
        if (c === '{') {
          ws();
          if (s[p] !== '"') return false;
          const key = str();
          if (key === null) return false;
          toks.push({ k: 'key', t: key });
          ws();
          if (s[p] !== ':') return false;
          toks.push({ k: 'colon', t: ':' });
          p++;
        }
        if (!value(depth + 1)) return false;
        ws();
        if (s[p] === ',') {
          toks.push({ k: 'comma', t: ',' });
          p++;
        } else if (s[p] === close) {
          toks.push({ k: 'close', t: close });
          p++;
          return true;
        } else return false;
      }
    }
    if (c === '"') {
      const t = str();
      if (t === null) return false;
      toks.push({ k: 'str', t });
      return true;
    }
    JSON_ATOM.lastIndex = p;
    const m = JSON_ATOM.exec(s);
    if (!m) return false;
    toks.push({ k: /^[tfn]/.test(m[0]) ? 'kw' : 'num', t: m[0] });
    p += m[0].length;
    return true;
  };
  if (!value(0)) return null;
  const worth = toks[0].t === '{' || toks.some((t, n) => n > 0 && t.k === 'open');
  return worth ? { end: p, toks } : null;
}

function writeJson(w, toks) {
  let level = 0;
  toks.forEach((tk, n) => {
    if (tk.k === 'open') {
      w.put(tk.t);
      if (toks[n + 1].k !== 'close') w.nl(++level);
    } else if (tk.k === 'close') {
      if (toks[n - 1].k !== 'open') w.nl(--level);
      w.put(tk.t);
    } else if (tk.k === 'comma') {
      w.put(',');
      w.nl(level);
    } else if (tk.k === 'colon') w.put(': ');
    else w.put(tk.t, tk.k);
  });
}

function findJson(s, from, limit) {
  const at = /[{[]/g;
  at.lastIndex = from;
  for (let m, tries = 0; (m = at.exec(s)) && m.index < limit && tries < 30; tries++) {
    const r = readJson(s, m.index);
    if (r && r.end - m.index >= LOG_FMT_MIN) return { start: m.index, end: r.end, write: (indent) => logBlock(indent, '  ', writeJson, r.toks) };
  }
  return null;
}

// -- XML: an element to its end tag (a <?xml ...?> before it), with two elements or more. "<init>" of a stack trace or
// List<String> do not close, so they are not taken for it. --
const XML_NAME = /[A-Za-z_][\w.:-]*/y;
const XML_ATTR = /\s+([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/y;

function readXml(s, i) {
  const toks = [];
  const stack = [];
  let p = i;
  let elements = 0;
  const name = (q) => {
    XML_NAME.lastIndex = q;
    const m = XML_NAME.exec(s);
    return m ? m[0] : '';
  };
  const spaces = (q) => {
    while (s[q] === ' ' || s[q] === '\t') q++;
    return q;
  };
  if (s.startsWith('<?xml', p)) {
    const e = s.indexOf('?>', p);
    if (e === -1) return null;
    toks.push({ k: 'decl', t: s.slice(p, e + 2) });
    p = spaces(e + 2);
  }
  while (p < s.length && toks.length < 20000) {
    const marks = [['<!--', '-->', 'comment'], ['<![CDATA[', ']]>', 'cdata']].find(([open]) => s.startsWith(open, p));
    if (marks) {
      const e = s.indexOf(marks[1], p);
      if (e === -1) return null;
      toks.push({ k: marks[2], t: s.slice(p, e + marks[1].length) });
      p = e + marks[1].length;
    } else if (s[p] === '<' && s[p + 1] === '/') {
      const n = name(p + 2);
      const q = spaces(p + 2 + n.length);
      if (!n || s[q] !== '>' || stack.pop() !== n) return null;
      toks.push({ k: 'close', name: n });
      p = q + 1;
      if (!stack.length) return elements > 1 ? { end: p, toks } : null;
    } else if (s[p] === '<') {
      const n = name(p + 1);
      if (!n) return null;
      const attrs = [];
      let q = p + 1 + n.length;
      for (let a; (XML_ATTR.lastIndex = q), (a = XML_ATTR.exec(s)); q = XML_ATTR.lastIndex) attrs.push({ name: a[1], value: a[2] });
      q = spaces(q);
      const self = s.startsWith('/>', q);
      if (!self && s[q] !== '>') return null;
      toks.push({ k: self ? 'self' : 'open', name: n, attrs });
      elements++;
      p = q + (self ? 2 : 1);
      if (self && !stack.length) return elements > 1 ? { end: p, toks } : null;
      if (!self) stack.push(n);
    } else {
      const e = s.indexOf('<', p);
      if (!stack.length || e === -1) return null;
      toks.push({ k: 'text', t: s.slice(p, e) });
      p = e;
    }
  }
  return null;
}

function writeXml(w, toks) {
  let level = 0;
  const line = (lv) => {
    if (!w.fresh) w.nl(lv);
  };
  const tag = (tk) => {
    w.put(`<${tk.name}`, 'kw');
    tk.attrs.forEach((a) => {
      w.put(' ');
      w.put(a.name, 'key');
      w.put('=');
      w.put(a.value, 'str');
    });
    w.put(tk.k === 'self' ? '/>' : '>', 'kw');
  };
  const close = (tk) => w.put(`</${tk.name}>`, 'kw');
  for (let n = 0; n < toks.length; n++) {
    const tk = toks[n];
    const a = toks[n + 1];
    const b = toks[n + 2];
    if (tk.k === 'open' || tk.k === 'self') {
      line(level);
      tag(tk);
      if (tk.k === 'self') continue;
      // <price>12.50</price> and <empty></empty> on one line
      if (a && a.k === 'close') {
        close(a);
        n += 1;
      } else if (a && a.k === 'text' && b && b.k === 'close') {
        w.put(a.t);
        close(b);
        n += 2;
      } else level++;
    } else if (tk.k === 'close') {
      level--;
      line(level);
      close(tk);
    } else if (tk.k === 'text') {
      if (tk.t.trim()) {
        line(level);
        w.put(tk.t.trim());
      }
    } else {
      line(level);
      w.put(tk.t, tk.k === 'decl' ? 'kw' : '');
    }
  }
}

function findXml(s, from, limit) {
  const at = /<[A-Za-z_?]/g;
  at.lastIndex = from;
  for (let m, tries = 0; (m = at.exec(s)) && m.index < limit && tries < 30; tries++) {
    const r = readXml(s, m.index);
    if (r && r.end - m.index >= LOG_FMT_MIN) return { start: m.index, end: r.end, write: (indent) => logBlock(indent, '  ', writeXml, r.toks) };
  }
  return null;
}

// -- SQL: a select, insert, update, delete, with or merge, after something that says it is SQL (Hibernate:, the
// org.hibernate.SQL logger, "Executing prepared SQL statement [...]", MyBatis' "Preparing:") or at the start of the
// line. Laid out as Hibernate's format_sql does: each clause on a line, under it what it has, one column a line,
// "and" and "or" on lines of their own, a subquery further in. --
const SQL_START = /\b(?:select|insert\s+into|update|delete\s+from|with|merge\s+into)\b/gi;
const SQL_CONTEXT = /hibernate|sql|quer(?:y|ies)|statement|preparing|jdbc|executing|r2dbc|jooq/i;
const SQL_TOKEN = /\s+|'(?:[^']|'')*'|"[^"]*"|`[^`]*`|--.*|\/\*[\s\S]*?\*\/|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_][\w$#]*|:[A-Za-z_]\w*|\?\d*|<>|<=|>=|!=|\|\||::|\S/y;
const SQL_CLAUSES = [
  'select distinct', 'select', 'from', 'where', 'group by', 'order by', 'having', 'limit', 'offset', 'fetch first', 'fetch next',
  'union all', 'union', 'intersect', 'except', 'minus', 'insert into', 'values', 'update', 'set', 'delete from', 'returning',
  'merge into', 'using', 'when not matched', 'when matched', 'with recursive', 'with', 'on conflict', 'for update',
  'left outer join', 'right outer join', 'full outer join', 'left join', 'right join', 'full join', 'inner join', 'cross join', 'join',
].map((c) => c.split(' '));
const SQL_ALONE = new Set(['union all', 'union', 'intersect', 'except', 'minus']);
const SQL_KW = new Set(
  ('select from where and or not in is null like ilike between exists join left right inner outer full cross on as distinct case when ' +
    'then else end insert into values update set delete group by order asc desc having limit offset fetch first next rows row only ' +
    'union all intersect except minus with recursive returning merge using matched conflict do nothing for nulls last true false any some')
    .split(' ')
);
const SQL_CLOSE = { '[': ']', '(': ')', '"': '"', "'": "'" };

// The statement from i to the end of the line, or to what closes the bracket or quote before it.
function readSql(s, i, strict) {
  const close = SQL_CLOSE[s[i - 1]] || '';
  const toks = [];
  let p = i;
  let end = i;
  let depth = 0;
  let ws = false;
  while (p < s.length && toks.length < 20000) {
    if ((close === '"' || close === "'") && s[p] === close) break;
    SQL_TOKEN.lastIndex = p;
    const t = SQL_TOKEN.exec(s)[0];
    p += t.length;
    if (/^\s/.test(t)) {
      ws = true;
      continue;
    }
    if (t === ')' && !depth && close === ')') break;
    if (t === ']' && !depth && close === ']') break;
    if (t === ')') depth--;
    toks.push({ t, ws, word: /^[A-Za-z_]/.test(t) ? t.toLowerCase() : '', d: depth });
    if (t === '(') depth++;
    ws = false;
    end = p;
  }
  const top = (w) => toks.some((tk) => tk.word === w && tk.d === 0);
  const first = toks[0].word;
  const shaped =
    first === 'select' ? top('from')
    : first === 'insert' ? toks.some((tk) => tk.word === 'values' || tk.word === 'select')
    : first === 'update' ? toks.length > 3 && top('set')
    : first === 'delete' ? toks.length > 2
    : first === 'with' ? toks.some((tk) => tk.word === 'select')
    : top('using');
  // at the start of a line, with nothing to say it is SQL: only with what prose has not (a comma is not enough)
  const sqlish = !strict || toks.some((tk) => /^(?:[*.(=?<>']|<>|<=|>=|!=)/.test(tk.t));
  return shaped && sqlish ? { end, toks } : null;
}

const sqlClauseAt = (toks, n) =>
  SQL_CLAUSES.find((words) => words.every((word, k) => toks[n + k] && toks[n + k].word === word && toks[n + k].d === toks[n].d));

const sqlKind = (tk) => (tk.word ? (SQL_KW.has(tk.word) ? 'kw' : '') : tk.t[0] === "'" ? 'str' : /^(?:\d|\?|:\w)/.test(tk.t) ? 'num' : '');

function writeSql(w, toks) {
  // a query, and each subquery in it: the level of its clauses, the clause it is in, the brackets open in it
  const frames = [{ base: 0, clause: '', depth: 0, open: 0 }];
  let between = false;
  for (let n = 0; n < toks.length; n++) {
    const tk = toks[n];
    const f = frames[frames.length - 1];
    const join = /join$/.test(f.clause);
    if (tk.word && !f.depth) {
      const clause = sqlClauseAt(toks, n);
      if (clause) {
        if (!w.fresh) w.nl(f.base);
        clause.forEach((word, k) => {
          if (k) w.put(' ');
          w.put(toks[n + k].t, 'kw');
        });
        n += clause.length - 1;
        f.clause = clause.join(' ');
        between = false;
        if (!SQL_ALONE.has(f.clause)) w.nl(f.base + 1);
        continue;
      }
      if (tk.word === 'on' && join) {
        w.nl(f.base + 2);
        w.put(tk.t, 'kw');
        continue;
      }
      if ((tk.word === 'and' || tk.word === 'or') && !between && (join || f.clause === 'where' || f.clause === 'having')) {
        w.nl(f.base + (join ? 2 : 1));
        w.put(tk.t, 'kw');
        continue;
      }
    }
    if (tk.t === '(' && toks[n + 1] && (toks[n + 1].word === 'select' || toks[n + 1].word === 'with')) {
      if (!w.fresh && tk.ws) w.put(' ');
      w.put('(');
      frames.push({ base: w.level + 1, clause: '', depth: 0, open: w.level });
      continue;
    }
    if (tk.t === ')' && !f.depth && frames.length > 1) {
      frames.pop();
      w.nl(f.open);
      w.put(')');
      continue;
    }
    if (tk.t === ',' && !f.depth && f.clause && !SQL_ALONE.has(f.clause)) {
      w.put(',');
      w.nl(f.base + 1);
      continue;
    }
    if (tk.t === '(') f.depth++;
    else if (tk.t === ')' && f.depth) f.depth--;
    if (!w.fresh && tk.ws) w.put(' ');
    w.put(tk.t, sqlKind(tk));
    if (tk.word === 'between') between = true;
    else if (tk.word === 'and') between = false;
  }
}

function findSql(s, from, limit) {
  SQL_START.lastIndex = from;
  for (let m; (m = SQL_START.exec(s)) && m.index < limit; ) {
    const before = s.slice(0, m.index);
    const said = SQL_CONTEXT.test(before);
    if (before.trim() && !said) continue;
    const r = readSql(s, m.index, !said);
    if (r && r.end - m.index >= LOG_FMT_MIN) return { start: m.index, end: r.end, write: (indent) => logBlock(indent, '    ', writeSql, r.toks) };
  }
  return null;
}

function logBlock(indent, unit, write, toks) {
  const w = logWriter(indent, unit);
  write(w, toks);
  return w;
}

// The first JSON, XML or SQL from `from` on (the one that starts first: a JSON in a string of a query stays in it).
function findLogBlock(s, from) {
  let best = findJson(s, from, s.length);
  const xml = findXml(s, from, best ? best.start : s.length);
  if (xml) best = xml;
  const sql = findSql(s, from, best ? best.start : s.length);
  return sql || best;
}

// One line (no line end), formatted: { text, marks }, or null when it has nothing to format.
function formatLogLine(line) {
  if (line.length < LOG_FMT_MIN || line.length > LOG_FMT_MAX_LINE || !LOG_FMT_WORTH.test(line)) return null;
  const blocks = [];
  for (let from = 0, b; blocks.length < 20 && (b = findLogBlock(line, from)); from = b.end) blocks.push(b);
  if (!blocks.length) return null;
  const head = line.slice(0, blocks[0].start).trimEnd();
  const indent = head ? LOG_FMT_INDENT : '';
  let text = head;
  const marks = [];
  const add = (t, m = []) => {
    const at = text ? text.length + 1 : 0;
    for (let k = 0; k < m.length; k += 3) marks.push(m[k] + at, m[k + 1] + at, m[k + 2]);
    text = text ? `${text}\n${t}` : t;
  };
  blocks.forEach((b, n) => {
    const w = b.write(indent);
    add(w.text, w.marks);
    const after = line.slice(b.end, n + 1 < blocks.length ? blocks[n + 1].start : line.length).trim();
    if (after) add(indent + after);
  });
  return { text, marks };
}

// Whole lines (a line not ended yet stays as it is): the text with the JSON, SQL and XML in them formatted, and the
// marks of their parts in that text.
function formatLogLines(text) {
  let out = '';
  const marks = [];
  for (let start = 0; start < text.length; ) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl + 1;
    const line = text.slice(start, end);
    const f = nl === -1 ? null : formatLogLine(line.replace(/\r?\n$/, ''));
    if (f) {
      for (let k = 0; k < f.marks.length; k += 3) marks.push(f.marks[k] + out.length, f.marks[k + 1] + out.length, f.marks[k + 2]);
      out += `${f.text}\n`;
    } else out += line;
    start = end;
  }
  return { text: out, marks };
}
