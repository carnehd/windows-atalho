// What a Spring service can answer, read from its Java code with simple rules (no compiler, no LLM, nothing sent
// anywhere): its endpoints (@RestController with @GetMapping, @PostMapping...) and, for each one, the statuses it
// answers with and their messages: throw new ResponseStatusException(HttpStatus.CONFLICT, "..."), an exception with
// @ResponseStatus or an @ExceptionHandler of a @ControllerAdvice, ResponseEntity.created/noContent/status(...). Each
// with its file and line, and what makes it happen as far as the code says: what the request sends (a condition on a
// parameter), what exists (another condition), or another service failing (a throw inside a catch). The methods of the
// same class an endpoint calls (find(id)...) are read too. log-tests.js compares them with the answers of the logs.
const fs = require('fs');
const path = require('path');

const STATUS = {
  OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, MOVED_PERMANENTLY: 301, FOUND: 302, SEE_OTHER: 303, NOT_MODIFIED: 304,
  BAD_REQUEST: 400, UNAUTHORIZED: 401, PAYMENT_REQUIRED: 402, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408, CONFLICT: 409, GONE: 410, PRECONDITION_FAILED: 412, PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_ENTITY: 422, UNPROCESSABLE_CONTENT: 422, LOCKED: 423, FAILED_DEPENDENCY: 424, PRECONDITION_REQUIRED: 428, TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500, NOT_IMPLEMENTED: 501, BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503, GATEWAY_TIMEOUT: 504,
};
const MAPPINGS = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE', RequestMapping: null };
const ENTITY = { created: 201, accepted: 202, noContent: 204, ok: 200, notFound: 404, badRequest: 400, unprocessableEntity: 422, internalServerError: 500 };
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'out', '.idea', '.gradle', '.mvn', 'test', 'bin', 'generated-sources']);
const MAX_FILES = 3000;
const MAX_FILE = 400000;
// a catch of another service answering "not there" or "bad request" depends on what exists there; any other, on it failing
const CALL_ERROR = /RestClient|HttpClient|HttpServer|WebClient|Feign|IOException|Timeout|Connect|ResourceAccess|Socket|Retry|CallNotPermitted|Unavailable/;
const CALL_THERE = /NotFound|BadRequest|Conflict|UnprocessableEntity|Forbidden|Unauthorized/;

// The code with comments blanked and the text of strings blanked (quotes kept), at the same places: braces and
// keywords found in it are code; the strings are read from the code itself at the same places.
function mask(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  const blank = (ch) => out.push(ch === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') blank(src[i++]);
    } else if (c === '/' && d === '*') {
      blank(src[i++]);
      blank(src[i++]);
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank(src[i++]);
      if (i < n) {
        blank(src[i++]);
        blank(src[i++]);
      }
    } else if (c === '"' && src.startsWith('"""', i)) {
      out.push('"', ' ', ' ');
      i += 3;
      while (i < n && !src.startsWith('"""', i)) blank(src[i++]);
      if (i < n) {
        out.push(' ', ' ', '"');
        i += 3;
      }
    } else if (c === '"' || c === "'") {
      out.push(c);
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < n) blank(src[i++]);
        blank(src[i++]);
      }
      if (i < n) out.push(src[i++]);
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

// The closing one of the ({[ at `at`, in masked code; -1 when there is none.
function closing(m, at) {
  const open = m[at];
  const close = { '(': ')', '{': '}', '[': ']' }[open];
  let depth = 0;
  for (let i = at; i < m.length; i++) {
    if (m[i] === open) depth++;
    else if (m[i] === close && --depth === 0) return i;
  }
  return -1;
}

const unescape = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, ch) => (ch.length === 5 ? String.fromCharCode(parseInt(ch.slice(1), 16)) : { n: '\n', t: '\t', r: '', b: '', f: '' }[ch] ?? ch));

// The string literals between from and to: [{ text, start, end }], read from the code.
function literals(src, m, from, to) {
  const out = [];
  for (let i = from; i < to; i++) {
    if (m[i] !== '"') continue;
    if (m.startsWith('"  ', i) && src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      if (end < 0 || end > to) break;
      out.push({ text: src.slice(i + 3, end).replace(/^\s*\n/, ''), start: i, end: end + 3 });
      i = end + 2;
      continue;
    }
    const end = m.indexOf('"', i + 1);
    if (end < 0 || end > to) break;
    out.push({ text: unescape(src.slice(i + 1, end)), start: i, end: end + 1 });
    i = end;
  }
  return out;
}

function lineAt(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// The annotations in a piece of masked code: [{ name, args: [from, to] or null, start, end }].
function annotationsIn(m, from, to) {
  const out = [];
  const re = /@([A-Za-z_][\w.]*)/g;
  re.lastIndex = from;
  let x;
  while ((x = re.exec(m)) && x.index < to) {
    const name = x[1].split('.').pop();
    let end = x.index + x[0].length;
    let args = null;
    const after = /^\s*\(/.exec(m.slice(end, end + 50));
    if (after) {
      const open = end + after[0].length - 1;
      const close = closing(m, open);
      if (close > 0) {
        args = [open + 1, close];
        end = close + 1;
      }
    }
    out.push({ name, args, start: x.index, end });
    re.lastIndex = end;
  }
  return out;
}

// The paths of a mapping annotation: its value or path (one or a list), else its first strings; [''] for none.
function mappingPaths(src, m, a) {
  if (!a.args) return [''];
  const [from, to] = a.args;
  const text = m.slice(from, to);
  const named = /\b(value|path)\s*=\s*/.exec(text);
  if (named) {
    const at = from + named.index + named[0].length;
    const end = m[at] === '{' ? closing(m, at) + 1 : (m.indexOf('"', m.indexOf('"', at) + 1) + 1 || to);
    const list = literals(src, m, at, end).map((l) => l.text);
    return list.length ? list : [''];
  }
  if (/=/.test(text.split(',')[0])) return [''];
  const first = m[from + text.search(/\S/)] === '{' ? closing(m, from + text.search(/\S/)) + 1 : to;
  const list = literals(src, m, from, first).map((l) => l.text);
  return list.length ? list : [''];
}

const joinPath = (a, b) => `/${[a, b].map((p) => String(p || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
const templateOfPath = (p) => p.replace(/\{[^}]*\}/g, '{id}').replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

// The members of a class body (masked), at its first level: methods with their annotations, parameters and body.
function membersOf(src, m, bodyFrom, bodyTo) {
  const out = [];
  let start = bodyFrom;
  let depth = 0;
  for (let i = bodyFrom; i < bodyTo; i++) {
    const ch = m[i];
    if (ch === '(' || ch === '[') {
      i = Math.max(i, closing(m, i));
      continue;
    }
    if (ch === '{') {
      if (depth === 0) {
        const end = closing(m, i);
        if (end < 0) break;
        const header = m.slice(start, i);
        const anns = annotationsIn(m, start, i);
        // the header without its annotations: "public Invoice pay(PaymentRequest in) throws X"
        let bare = '';
        let last = start;
        for (const a of anns) {
          bare += m.slice(last, a.start);
          last = a.end;
        }
        bare += m.slice(last, i);
        const sig = /([A-Za-z_]\w*)\s*\(([^()]*)\)\s*(?:throws\s+[\w.,\s]+)?\s*$/.exec(bare);
        if (sig && !/\b(class|record|interface|enum|new)\b/.test(bare) && !/^[A-Z]/.test(sig[1]) && !/=\s*$/.test(header.trim())) {
          // the parameters, with their own annotations: the ( after its name, outside the annotations
          let open = -1;
          for (const x of header.matchAll(new RegExp(`\\b${sig[1]}\\s*\\(`, 'g'))) {
            const at = start + x.index;
            if (!anns.some((a) => at >= a.start && at < a.end)) open = at + x[0].length - 1;
          }
          const close = open > 0 ? closing(m, open) : -1;
          const params = [];
          if (open > 0 && close > open) {
            let p0 = open + 1;
            let d = 0;
            for (let j = open + 1; j <= close; j++) {
              const cj = m[j];
              if (cj === '(' || cj === '<' || cj === '{') d++;
              else if (cj === ')' || cj === '>' || cj === '}') d--;
              if ((cj === ',' && d === 0) || j === close) {
                const part = m.slice(p0, j);
                const pa = annotationsIn(m, p0, j);
                const name = (/([A-Za-z_]\w*)\s*$/.exec(part.replace(/@[\w.]+(\s*\([^)]*\))?/g, ' ')) || [])[1];
                if (name) params.push({ name, annotations: pa.map((x) => x.name), anns: pa });
                p0 = j + 1;
              }
            }
          }
          out.push({ name: sig[1], annotations: anns, params, body: [i + 1, end], at: start + header.search(/\S|$/) });
        }
        i = end;
        start = end + 1;
        continue;
      }
    }
    if (ch === ';' && depth === 0) start = i + 1;
  }
  return out;
}

// The classes of a file: [{ name, annotations, extends, body: [from, to], at }] (nested ones too).
function classesOf(m) {
  const out = [];
  const re = /\b(class|record|interface|enum)\s+([A-Za-z_]\w*)([^{;]*)\{/g;
  let x;
  while ((x = re.exec(m))) {
    const open = x.index + x[0].length - 1;
    const close = closing(m, open);
    if (close < 0) break;
    // its annotations: the code before it, back to the last ; } or {
    let from = x.index;
    while (from > 0 && !/[;{}]/.test(m[from - 1])) from--;
    const ext = /\bextends\s+([\w.]+)/.exec(x[3]);
    out.push({ kind: x[1], name: x[2], annotations: annotationsIn(m, from, x.index), extends: ext ? ext[1].split('.').pop() : '', body: [open + 1, close], at: x.index });
  }
  return out;
}

function statusOfArgs(m, a) {
  if (!a || !a.args) return null;
  const s = /HttpStatus\.([A-Z_]+)/.exec(m.slice(a.args[0], a.args[1]));
  return s ? STATUS[s[1]] || null : null;
}

function javaFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= MAX_FILES || depth > 14) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.java') && out.length < MAX_FILES) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

// The message of a throw: its strings in order, … where code goes between them ("Invoice … is paid already").
function messageOf(src, m, from, to) {
  const lits = literals(src, m, from, to);
  if (!lits.length) return '';
  let msg = '';
  lits.forEach((l, i) => {
    if (i > 0 && /[^\s+]/.test(m.slice(lits[i - 1].end, l.start))) msg += '…';
    msg += l.text;
  });
  if (/\+\s*[^\s)]/.test(m.slice(lits[lits.length - 1].end, to))) msg += '…';
  if (/[^\s(,]\s*\+\s*$/.test(m.slice(Math.max(from, lits[0].start - 60), lits[0].start))) msg = `…${msg}`;
  return msg.replace(/\s+/g, ' ').trim();
}

// What makes a throw happen: inside a catch (another service), or the if around it (what is sent, or what exists).
function causeOf(src, m, body, at, inputs) {
  // the blocks around it, from the closest
  let depth = 0;
  for (let i = at - 1; i >= body[0]; i--) {
    const ch = m[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth > 0) {
        depth--;
        continue;
      }
      const head = headOf(src, m, i, body[0]);
      if (head && head.word === 'catch') return CALL_THERE.test(head.inside) && !CALL_ERROR.test(head.inside.replace(/HttpClientErrorException|WebClientResponseException|FeignException/g, '')) ? { cause: 'there', condition: head.inside } : { cause: 'dependency', condition: head.inside };
      if (head && (head.word === 'if' || head.word === 'while')) return { cause: refersTo(head.inside, inputs) ? 'input' : 'state', condition: head.inside };
    }
  }
  // without braces: if (x) throw ...;
  const head = headOf(src, m, at, body[0]);
  if (head && head.word === 'if') return { cause: refersTo(head.inside, inputs) ? 'input' : 'state', condition: head.inside };
  return { cause: 'state', condition: '' };
}

// What is right before `at` (a { or a statement): "word (inside)", as if (...), catch (...), for (...); else null.
function headOf(src, m, at, floor) {
  let j = at - 1;
  while (j > floor && /\s/.test(m[j])) j--;
  if (m[j] !== ')') return null;
  let depth = 0;
  let k = j;
  for (; k > floor; k--) {
    if (m[k] === ')') depth++;
    else if (m[k] === '(' && --depth === 0) break;
  }
  const word = /([A-Za-z]+)\s*$/.exec(m.slice(Math.max(floor, k - 20), k));
  return word ? { word: word[1], inside: src.slice(k + 1, j).replace(/\s+/g, ' ').trim() } : null;
}

const refersTo = (text, inputs) => inputs.some((n) => new RegExp(`(^|[^\\w.])${n}\\b`).test(text));

// Reads the endpoints of a repository and what each can answer.
function readCodeAnswers(root) {
  const files = javaFiles(root);
  const parsed = [];
  for (const file of files) {
    let src;
    try {
      if (fs.statSync(file).size > MAX_FILE) continue;
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!/@(Rest)?Controller(Advice)?\b|@ResponseStatus\b|Exception\b/.test(src)) continue;
    const m = mask(src);
    parsed.push({ file, src, m, line: lineAt(src), classes: classesOf(m) });
  }
  // exceptions with a status: @ResponseStatus on the class, an @ExceptionHandler, or the class it extends
  const exStatus = new Map();
  const exParent = new Map();
  for (const f of parsed) {
    for (const c of f.classes) {
      if (c.extends) exParent.set(c.name, c.extends);
      const rs = c.annotations.find((a) => a.name === 'ResponseStatus');
      if (rs && statusOfArgs(f.m, rs)) exStatus.set(c.name, statusOfArgs(f.m, rs));
      if (!c.annotations.some((a) => /^(Rest)?ControllerAdvice$/.test(a.name))) continue;
      for (const meth of membersOf(f.src, f.m, c.body[0], c.body[1])) {
        const eh = meth.annotations.find((a) => a.name === 'ExceptionHandler');
        if (!eh || !eh.args) continue;
        const names = [...f.m.slice(eh.args[0], eh.args[1]).matchAll(/([A-Za-z_]\w*)\s*\.\s*class/g)].map((x) => x[1]);
        const body = f.m.slice(meth.body[0], meth.body[1]);
        const st = statusOfArgs(f.m, meth.annotations.find((a) => a.name === 'ResponseStatus'))
          || (/HttpStatus\.([A-Z_]+)/.exec(body) && STATUS[/HttpStatus\.([A-Z_]+)/.exec(body)[1]])
          || (/ResponseEntity\s*\.\s*(\w+)\s*\(/.exec(body) && ENTITY[/ResponseEntity\s*\.\s*(\w+)\s*\(/.exec(body)[1]]);
        if (st) for (const n of names) exStatus.set(n, st);
      }
    }
  }
  const statusOfException = (name) => {
    for (let n = name, k = 0; n && k < 6; n = exParent.get(n), k++) if (exStatus.has(n)) return exStatus.get(n);
    return null;
  };

  const endpoints = [];
  const controllers = [];
  for (const f of parsed) {
    for (const c of f.classes) {
      const isController = c.annotations.some((a) => a.name === 'RestController' || a.name === 'Controller');
      if (!isController) continue;
      controllers.push(c.name);
      const base = mappingPaths(f.src, f.m, c.annotations.find((a) => a.name === 'RequestMapping') || {})[0];
      const members = membersOf(f.src, f.m, c.body[0], c.body[1]);
      const byName = new Map();
      for (const meth of members) if (!byName.has(meth.name)) byName.set(meth.name, meth);
      const rel = path.relative(root, f.file).split(path.sep).join('/');
      // what a method answers: its throws, and those of the methods of this class it calls
      const answersOf = (meth, inputs, seen = new Set()) => {
        if (seen.has(meth.name) || seen.size > 6) return [];
        seen.add(meth.name);
        const [from, to] = meth.body;
        const body = f.m.slice(from, to);
        const own = meth.params.map((p) => p.name);
        // a loop over what was sent is what was sent too: for (LineRequest l : in.lines())
        for (const loop of body.matchAll(/for\s*\(\s*(?:final\s+)?[\w<>.,?\s[\]]+?\s+([A-Za-z_]\w*)\s*:\s*([^)]*)\)/g)) {
          if (refersTo(loop[2], [...inputs, ...own])) own.push(loop[1]);
        }
        const out = [];
        for (const t of body.matchAll(/\bthrow\b/g)) {
          const at = from + t.index;
          const end = f.m.indexOf(';', at);
          if (end < 0 || end > to) continue;
          const stmt = f.m.slice(at, end);
          let status = null;
          const hs = /HttpStatus\.([A-Z_]+)/.exec(stmt);
          if (hs) status = STATUS[hs[1]] || null;
          if (!status) {
            const ex = /new\s+([A-Za-z_][\w.]*)\s*\(/.exec(stmt);
            if (ex) status = statusOfException(ex[1].split('.').pop());
          }
          if (!status) continue;
          const statusAt = hs ? at + hs.index + hs[0].length : at;
          out.push({ status, message: messageOf(f.src, f.m, statusAt, end), file: rel, line: f.line(at), ...causeOf(f.src, f.m, meth.body, at, [...inputs, ...own]) });
        }
        for (const call of body.matchAll(/(^|[^\w.])([a-z_]\w*)\s*\(/g)) {
          const helper = byName.get(call[2]);
          if (helper && helper !== meth) out.push(...answersOf(helper, [], seen));
        }
        return out;
      };
      for (const meth of members) {
        const map = meth.annotations.find((a) => a.name in MAPPINGS);
        if (!map) continue;
        let method = MAPPINGS[map.name];
        if (!method) {
          const rm = map.args && /RequestMethod\.([A-Z]+)/.exec(f.m.slice(map.args[0], map.args[1]));
          method = rm ? rm[1] : 'GET';
        }
        const body = f.m.slice(meth.body[0], meth.body[1]);
        // what it answers when it goes well
        const ok = new Set();
        const rs = statusOfArgs(f.m, meth.annotations.find((a) => a.name === 'ResponseStatus'));
        if (rs) ok.add(rs);
        for (const e of body.matchAll(/ResponseEntity\s*\.\s*(\w+)\s*\(([^;]*)/g)) {
          if (e[1] === 'status') {
            const s = /HttpStatus\.([A-Z_]+)/.exec(e[2]);
            if (s && STATUS[s[1]]) ok.add(STATUS[s[1]]);
          } else if (ENTITY[e[1]]) ok.add(ENTITY[e[1]]);
        }
        if (!ok.size) ok.add(200);
        const inputs = meth.params.filter((p) => p.annotations.some((a) => /^(RequestBody|RequestParam|PathVariable|RequestHeader|Valid|Validated|ModelAttribute)$/.test(a))).map((p) => p.name);
        const answers = [...[...ok].map((status) => ({ status, message: '', file: rel, line: f.line(meth.at), cause: 'ok', condition: '' })), ...answersOf(meth, inputs)];
        // the same answer reached from two places once
        const unique = [];
        for (const a of answers) if (!unique.some((u) => u.status === a.status && u.message === a.message)) unique.push(a);
        const params = meth.params.map((p) => ({ name: p.name, kind: (p.annotations.find((a) => /^(RequestBody|RequestParam|PathVariable|RequestHeader)$/.test(a)) || '').replace(/^Request|^Path/, '').toLowerCase() }));
        for (const p of mappingPaths(f.src, f.m, map)) {
          const full = joinPath(base, p);
          endpoints.push({ method, path: full, template: templateOfPath(full), controller: c.name, name: meth.name, file: rel, line: f.line(meth.at), params, answers: unique });
        }
      }
    }
  }
  return { controllers: [...new Set(controllers)], endpoints, files: files.length };
}

// The message an answer has: a problem detail's detail, else message / error / mensagem / descricao, else its text.
function answerMessage(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  try {
    const j = JSON.parse(t);
    if (j && typeof j === 'object') {
      for (const k of ['detail', 'message', 'mensagem', 'descricao', 'error_description', 'error', 'title']) if (typeof j[k] === 'string' && j[k]) return j[k];
      return '';
    }
  } catch {
    // text
  }
  return t.slice(0, 300);
}

// Whether an answer's message is the one the code writes ("Invoice … is paid already" with … for what changes).
function sameMessage(codeMessage, message) {
  if (!codeMessage) return true;
  const re = new RegExp(`^${codeMessage.split('…').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`);
  return re.test(String(message || '').trim());
}

module.exports = { readCodeAnswers, answerMessage, sameMessage, mask, templateOfPath };
