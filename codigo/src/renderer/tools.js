// Tools page: small things developers reach for every day. Most run here in the window (nothing is sent anywhere);
// hashes, the YAML / .properties conversion and the ports in use ask the main process (see src/tools.js).
// Relies on helpers from app.js ($, $$, toast, updateCrumb, CARD_ID).
const TOOLS = [
  { id: 'jwt', title: 'JWT decoder', sub: 'Header, claims, expiry', words: 'token keycloak bearer oauth oidc claims roles', build: buildJwtTool },
  { id: 'time', title: 'Timestamps', sub: 'Epoch to date and back', words: 'epoch unix date time millis seconds iso utc', build: buildTimeTool },
  { id: 'config', title: 'YAML · properties · JSON', sub: 'Spring config formats', words: 'yml yaml properties json spring application convert', build: buildConfigTool },
  { id: 'springenv', title: 'Spring ↔ env vars', sub: 'Properties as environment variables', words: 'spring environment variables env docker compose kubernetes relaxed binding properties yaml', build: buildSpringEnvTool },
  { id: 'encode', title: 'Base64 · URL · HTML', sub: 'Encode and decode', words: 'base64 url encode decode html escape entities percent', build: buildEncodeTool },
  { id: 'escape', title: 'Escape strings', sub: 'Java and JSON string literals', words: 'escape unescape string literal java json quotes text block newline unicode', build: buildEscapeTool },
  { id: 'json', title: 'JSON', sub: 'Format, check, query, Java', words: 'json format minify validate pretty jsonpath java record pojo lombok class', build: buildJsonTool },
  { id: 'jsondiff', title: 'Compare JSON', sub: 'What changed, field by field', words: 'json diff compare difference response fields keys', build: buildJsonDiffTool },
  { id: 'cron', title: 'Spring cron', sub: 'What it means, next runs', words: 'cron schedule scheduled quartz', build: buildCronTool },
  { id: 'case', title: 'Name cases', sub: 'camelCase, snake_case...', words: 'case camel snake kebab constant pascal title naming', build: buildCaseTool },
  { id: 'ids', title: 'UUID · passwords', sub: 'Random ids and secrets', words: 'uuid guid password secret random generate key', build: buildIdsTool },
  { id: 'ptids', title: 'Portuguese IDs', sub: 'NIF, NISS, IBAN, Cartão de Cidadão', words: 'nif niss iban nib cartao cidadao cc portugal validate generate test data contribuinte', build: buildPtIdsTool },
  { id: 'hash', title: 'Hashes', sub: 'MD5, SHA, HMAC', words: 'hash md5 sha sha1 sha256 sha512 hmac checksum digest', build: buildHashTool },
  { id: 'ports', title: 'Ports in use', sub: 'Who listens, end it', words: 'port listen process kill end 8080 lsof netstat pid', build: buildPortsTool },
  { id: 'compare', title: 'Compare texts', sub: 'Two texts, the differences', words: 'diff compare text difference', build: buildCompareTool },
];
const TOOL_KEY = 'toolsCurrent';
let currentTool = 'jwt';
const builtTools = new Map(); // id -> { el, shown() }

function toolTitle(id) {
  const t = TOOLS.find((x) => x.id === id);
  return t ? t.title : '';
}

// -- small builders --
function tEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function toolHead(title, text) {
  const head = tEl('div', 'tool-head');
  head.append(tEl('h2', '', title), tEl('p', '', text));
  return head;
}

function toolArea(placeholder, rows = 5) {
  const a = tEl('textarea', 'tool-area');
  a.placeholder = placeholder;
  a.rows = rows;
  a.spellcheck = false;
  a.setAttribute('autocomplete', 'off');
  return a;
}

function toolInput(placeholder, value = '') {
  const i = tEl('input', 'input tool-input');
  i.placeholder = placeholder;
  i.value = value;
  i.spellcheck = false;
  i.setAttribute('autocomplete', 'off');
  return i;
}

function toolButton(label, onClick, cls = '') {
  const b = tEl('button', `btn btn-sm ${cls}`.trim(), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

async function toolCopy(text, what, secret = false) {
  if (!text) {
    toast('Nothing to copy yet', 'info');
    return;
  }
  const r = await (secret ? window.tools.copySecret(text) : window.tools.copy(text));
  toast(r.error || (secret ? `${what} copied (cleared from the clipboard in 30 seconds)` : `${what} copied`), r.error ? 'error' : 'success');
}

function copyButton(getText, what, secret = false) {
  const b = toolButton('Copy', () => toolCopy(typeof getText === 'function' ? getText() : getText, what, secret), 'tool-copy');
  b.title = `Copy ${what.toLowerCase()}`;
  return b;
}

// A choice of a few options, one pressed.
function toolSegment(options, value, onChange, label) {
  const box = tEl('div', 'tool-seg');
  box.setAttribute('role', 'group');
  if (label) box.setAttribute('aria-label', label);
  const set = (v) => {
    box.dataset.value = v;
    [...box.children].forEach((b) => {
      const on = b.dataset.value === v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  };
  for (const [v, text] of options) {
    const b = tEl('button', 'tool-seg-btn', text);
    b.type = 'button';
    b.dataset.value = v;
    b.addEventListener('click', () => {
      set(v);
      onChange(v);
    });
    box.appendChild(b);
  }
  set(value);
  box.setValue = set;
  return box;
}

// Label, value and a copy button, in a grid of such rows.
function toolFields() {
  const grid = tEl('div', 'tool-fields');
  grid.add = (label, value, opts = {}) => {
    const l = tEl('div', 'tool-label', label);
    const v = tEl('div', `tool-value${opts.cls ? ` ${opts.cls}` : ''}`);
    if (value instanceof Node) v.appendChild(value);
    else v.textContent = value;
    if (opts.title) v.title = opts.title;
    const c = tEl('div', 'tool-field-copy');
    if (opts.copy !== false && (opts.copyText || (typeof value === 'string' && value))) c.appendChild(copyButton(opts.copyText || value, opts.what || label, opts.secret));
    grid.append(l, v, c);
    return v;
  };
  return grid;
}

function toolNote(text, cls = 'tool-error') {
  return tEl('div', cls, text);
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// "in 5 min", "2 h ago"
function relTime(ms) {
  const diff = ms - Date.now();
  const a = Math.abs(diff);
  const units = [[86400000 * 365, 'year'], [86400000 * 30, 'month'], [86400000, 'day'], [3600000, 'h'], [60000, 'min'], [1000, 's']];
  let text = 'now';
  for (const [size, name] of units) {
    if (a >= size) {
      const n = Math.floor(a / size);
      text = name.length > 3 ? `${n} ${name}${n === 1 ? '' : 's'}` : `${n} ${name}`;
      break;
    }
  }
  if (text === 'now') return 'just now';
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

const localDate = (ms) => new Date(ms).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });

// UTF-8 text <-> Base64 (and its URL-safe form)
function utf8ToBase64(text, url = false) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const b64 = btoa(bin);
  return url ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64;
}

function base64ToUtf8(text) {
  let s = String(text).trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('This is not Base64: it has characters Base64 does not use');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

// -- JWT --
function buildJwtTool() {
  const box = tEl('div', 'tool');
  const input = toolArea('Paste a token: eyJhbGciOi... (a "Bearer " in front is fine)', 4);
  const out = tEl('div', 'tool-result');
  box.append(toolHead('JWT decoder', 'Reads the token here in the app: nothing is sent anywhere. The signature is not checked (that needs the key).'), input, out);
  const render = () => {
    out.textContent = '';
    const raw = input.value.trim().replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '');
    if (!raw) return;
    const parts = raw.split('.');
    if (parts.length < 2 || parts.length > 3) {
      out.appendChild(toolNote('A JWT has three parts separated by dots: header.payload.signature'));
      return;
    }
    let header;
    let payload;
    try {
      header = JSON.parse(base64ToUtf8(parts[0]));
      payload = JSON.parse(base64ToUtf8(parts[1]));
    } catch {
      out.appendChild(toolNote('This is not a JWT: its first two parts are not Base64 JSON'));
      return;
    }
    const f = toolFields();
    const time = (sec) => {
      if (typeof sec !== 'number') return null;
      const ms = sec * 1000;
      return `${localDate(ms)} (${relTime(ms)})`;
    };
    if (typeof payload.exp === 'number') {
      const expired = payload.exp * 1000 < Date.now();
      const badge = tEl('span', `tool-badge ${expired ? 'bad' : 'good'}`, expired ? `Expired ${relTime(payload.exp * 1000)}` : `Valid, expires ${relTime(payload.exp * 1000)}`);
      f.add('State', badge, { copy: false });
    }
    const add = (label, value, title) => {
      if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return;
      f.add(label, Array.isArray(value) ? value.join(', ') : String(value), { title });
    };
    add('Algorithm', header.alg);
    add('Key id', header.kid);
    add('Issuer', payload.iss);
    add('Subject', payload.sub);
    add('Username', payload.preferred_username);
    add('Name', payload.name);
    add('Email', payload.email);
    add('Audience', payload.aud);
    add('Client', payload.azp || payload.client_id);
    add('Expires', time(payload.exp), typeof payload.exp === 'number' ? `exp: ${payload.exp}` : '');
    add('Issued', time(payload.iat), typeof payload.iat === 'number' ? `iat: ${payload.iat}` : '');
    add('Not before', time(payload.nbf));
    if (typeof payload.exp === 'number' && typeof payload.iat === 'number') add('Lifetime', `${Math.round((payload.exp - payload.iat) / 60)} min`);
    add('Realm roles', payload.realm_access && payload.realm_access.roles);
    if (payload.resource_access && typeof payload.resource_access === 'object') {
      for (const [client, v] of Object.entries(payload.resource_access)) add(`Roles in ${client}`, v && v.roles);
    }
    add('Roles', payload.roles);
    add('Groups', payload.groups);
    add('Scope', payload.scope);
    add('Signature', parts[2] ? 'Present, not checked here' : 'None (an unsigned token)');
    out.appendChild(f);
    for (const [title, value] of [['Header', header], ['Payload', payload]]) {
      const json = JSON.stringify(value, null, 2);
      const sec = tEl('div', 'tool-section');
      const h = tEl('div', 'tool-section-head');
      h.append(tEl('h3', '', title), copyButton(json, title));
      sec.append(h, tEl('pre', 'tool-out', json));
      out.appendChild(sec);
    }
  };
  input.addEventListener('input', render);
  return { el: box, focus: input };
}

// -- Timestamps --
function parseWhen(text) {
  const t = String(text).trim();
  if (!t) return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    const digits = t.replace(/^-/, '').split('.')[0].length;
    if (digits <= 11) return { ms: n * 1000, as: 'seconds since 1970' };
    if (digits <= 14) return { ms: n, as: 'milliseconds since 1970' };
    if (digits <= 17) return { ms: n / 1000, as: 'microseconds since 1970' };
    return { ms: n / 1e6, as: 'nanoseconds since 1970' };
  }
  let ms = Date.parse(t);
  if (Number.isNaN(ms)) ms = Date.parse(t.replace(' ', 'T'));
  return Number.isNaN(ms) ? { error: 'Type a number of seconds or milliseconds, or a date like 2026-10-28T14:30:00Z' } : { ms, as: 'a date' };
}

function buildTimeTool() {
  const box = tEl('div', 'tool');
  const now = tEl('div', 'tool-now');
  const input = toolInput('1730124600, 1730124600000 or 2026-10-28T14:30:00Z');
  const row = tEl('div', 'tool-row');
  row.append(input, toolButton('Now', () => {
    input.value = String(Math.floor(Date.now() / 1000));
    render();
  }));
  const out = tEl('div', 'tool-result');
  box.append(toolHead('Timestamps', 'A number of seconds or milliseconds since 1970 (as in logs and tokens), or a date: it shows the other forms.'), now, row, out);
  const tick = () => {
    const ms = Date.now();
    now.textContent = `Now: ${Math.floor(ms / 1000)} · ${ms} · ${new Date(ms).toISOString()}`;
  };
  tick();
  let timer = null;
  const render = () => {
    out.textContent = '';
    const w = parseWhen(input.value);
    if (!w) return;
    if (w.error || !Number.isFinite(w.ms)) {
      out.appendChild(toolNote(w.error || 'That date is out of range'));
      return;
    }
    const d = new Date(w.ms);
    if (Number.isNaN(d.getTime())) {
      out.appendChild(toolNote('That date is out of range'));
      return;
    }
    const f = toolFields();
    f.add('Read as', w.as, { copy: false });
    f.add('Local', localDate(w.ms));
    f.add('UTC', d.toISOString());
    const off = -d.getTimezoneOffset();
    const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
    const localIso = new Date(w.ms + off * 60000).toISOString().replace('Z', `${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`);
    f.add('ISO with offset', localIso);
    f.add('Seconds', String(Math.floor(w.ms / 1000)));
    f.add('Milliseconds', String(Math.round(w.ms)));
    f.add('From now', relTime(w.ms), { copy: false });
    out.appendChild(f);
  };
  input.addEventListener('input', render);
  return {
    el: box,
    focus: input,
    shown(on) {
      clearInterval(timer);
      if (on) timer = setInterval(tick, 1000);
    },
  };
}

// -- YAML / properties / JSON --
function buildConfigTool() {
  const box = tEl('div', 'tool');
  let from = 'yaml';
  let to = 'properties';
  const input = toolArea('server:\n  port: 8080\nspring:\n  datasource:\n    url: jdbc:postgresql://localhost:5432/app', 12);
  const output = tEl('pre', 'tool-out tool-out-tall');
  const error = tEl('div', 'tool-error');
  const names = [['yaml', 'YAML'], ['properties', '.properties'], ['json', 'JSON']];
  const other = (v) => names.find(([n]) => n !== v)[0];
  const fromSeg = toolSegment(names, from, (v) => {
    from = v;
    if (from === to) {
      to = other(v);
      toSeg.setValue(to);
    }
    convert();
  }, 'From');
  const toSeg = toolSegment(names, to, (v) => {
    to = v;
    if (from === to) {
      from = other(v);
      fromSeg.setValue(from);
    }
    convert();
  }, 'To');
  const swap = toolButton('⇄ Swap', () => {
    const text = output.textContent;
    [from, to] = [to, from];
    fromSeg.setValue(from);
    toSeg.setValue(to);
    if (text) input.value = text;
    convert();
  });
  swap.title = 'Turn the result into the input';
  const row = tEl('div', 'tool-row');
  row.append(tEl('span', 'tool-label', 'From'), fromSeg, swap, tEl('span', 'tool-label', 'to'), toSeg, copyButton(() => output.textContent, 'Result'));
  const two = tEl('div', 'tool-two');
  two.append(input, output);
  box.append(toolHead('YAML · properties · JSON', 'An application.yml as application.properties and back, or either as JSON. Lists become name[0]; several YAML documents (---) are joined with #--- as Spring Boot reads them.'), row, two, error);
  const convert = debounce(async () => {
    error.textContent = '';
    if (!input.value.trim()) {
      output.textContent = '';
      return;
    }
    const r = await window.tools.convertConfig(input.value, from, to);
    if (r.error) {
      error.textContent = r.error.split('\n')[0];
      return;
    }
    output.textContent = r.text;
  }, 250);
  input.addEventListener('input', convert);
  return { el: box, focus: input };
}

// -- Base64 / URL / HTML --
function htmlUnescape(text) {
  const t = document.createElement('textarea');
  t.innerHTML = text;
  return t.value;
}

function buildEncodeTool() {
  const box = tEl('div', 'tool');
  let kind = 'base64';
  let dir = 'encode';
  const input = toolArea('Text to encode or decode', 6);
  const output = tEl('pre', 'tool-out');
  const error = tEl('div', 'tool-error');
  const run = () => {
    error.textContent = '';
    const t = input.value;
    if (!t) {
      output.textContent = '';
      return;
    }
    try {
      if (kind === 'base64') output.textContent = dir === 'encode' ? utf8ToBase64(t) : base64ToUtf8(t);
      else if (kind === 'base64url') output.textContent = dir === 'encode' ? utf8ToBase64(t, true) : base64ToUtf8(t);
      else if (kind === 'url') output.textContent = dir === 'encode' ? encodeURIComponent(t) : decodeURIComponent(t.replace(/\+/g, '%20'));
      else output.textContent = dir === 'encode'
        ? t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
        : htmlUnescape(t);
    } catch (e) {
      output.textContent = '';
      error.textContent = kind === 'url' ? 'This is not URL-encoded text: a % is not followed by two hex digits' : e.message;
    }
  };
  const row = tEl('div', 'tool-row');
  row.append(
    toolSegment([['base64', 'Base64'], ['base64url', 'Base64 URL'], ['url', 'URL'], ['html', 'HTML']], kind, (v) => { kind = v; run(); }, 'Kind'),
    toolSegment([['encode', 'Encode'], ['decode', 'Decode']], dir, (v) => { dir = v; run(); }, 'Direction'),
    toolButton('⇄ Use the result', () => {
      input.value = output.textContent;
      run();
    }),
    copyButton(() => output.textContent, 'Result'),
  );
  input.addEventListener('input', run);
  box.append(toolHead('Base64 · URL · HTML', 'Text in UTF-8. Base64 URL is the form tokens use (- and _ and no = at the end). URL decoding also turns + into spaces.'), row, input, output, error);
  return { el: box, focus: input };
}

// -- JSON --
// Where a JSON text breaks, and why (JSON.parse here says what, but not where): a small parser that only checks.
function jsonErrorAt(text) {
  let i = 0;
  const fail = (msg) => {
    throw Object.assign(new Error(msg), { pos: i });
  };
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const str = () => {
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        return;
      }
      if (ch < ' ') fail('A line break inside a "string"');
      i++;
    }
    fail('A "string" is not closed');
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === undefined) fail('The JSON ends too soon');
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      ws();
      if (text[i] === close) {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (c === '{') {
          if (text[i] !== '"') fail(text[i] === undefined ? 'The JSON ends too soon' : `A key must be in "double quotes", found ${JSON.stringify(text[i])}`);
          str();
          ws();
          if (text[i] !== ':') fail('Expected : after the key');
          i++;
        }
        value();
        ws();
        if (text[i] === ',') {
          i++;
          ws();
          if (text[i] === close) fail(`A comma before ${close}: JSON does not allow one`);
          continue;
        }
        if (text[i] === close) {
          i++;
          return;
        }
        fail(text[i] === undefined ? `The JSON ends before its ${close}` : `Expected , or ${close}, found ${JSON.stringify(text[i])}`);
      }
    }
    if (c === '"') return str();
    const num = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
    num.lastIndex = i;
    if (/[-\d]/.test(c) && num.test(text)) {
      i = num.lastIndex;
      return;
    }
    for (const word of ['true', 'false', 'null']) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return;
      }
    }
    fail(c === "'" ? "Strings need \"double quotes\", not 'single'" : `Unexpected ${JSON.stringify(c)}`);
  };
  try {
    value();
    ws();
    if (i < text.length) fail('Something after the end of the JSON');
    return 'Not valid JSON';
  } catch (e) {
    if (e.pos === undefined) throw e;
    const before = text.slice(0, e.pos);
    return `${e.message} (line ${before.split('\n').length}, column ${e.pos - before.lastIndexOf('\n')})`;
  }
}

// $.a.b, $.items[0], $.items[*].name, $..id, $['odd key']
function jsonPath(data, path) {
  let p = String(path).trim();
  if (!p) return undefined;
  if (p[0] !== '$') p = `$${p[0] === '[' ? '' : '.'}${p}`;
  const tokens = [];
  const re = /\.\.([A-Za-z_$][\w$-]*|\*)|\.([A-Za-z_$][\w$-]*|\*)|\[(\d+|\*|'[^']*'|"[^"]*"|-?\d*:-?\d*)\]/gy;
  re.lastIndex = 1;
  let m;
  while (re.lastIndex < p.length) {
    const at = re.lastIndex;
    m = re.exec(p);
    if (!m) throw new Error(`The path stops making sense at "${p.slice(at)}"`);
    if (m[1] !== undefined) tokens.push({ deep: true, key: m[1] });
    else if (m[2] !== undefined) tokens.push({ key: m[2] });
    else {
      const b = m[3];
      if (b === '*') tokens.push({ key: '*' });
      else if (/^\d+$/.test(b)) tokens.push({ index: Number(b) });
      else if (b.includes(':')) tokens.push({ slice: b.split(':').map((x) => (x === '' ? null : Number(x))) });
      else tokens.push({ key: b.slice(1, -1) });
    }
  }
  let nodes = [data];
  let many = false;
  const childrenOf = (n) => (Array.isArray(n) ? n : n && typeof n === 'object' ? Object.values(n) : []);
  for (const t of tokens) {
    const next = [];
    if (t.deep) {
      many = true;
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (t.key === '*') next.push(...childrenOf(n));
        else if (!Array.isArray(n) && Object.prototype.hasOwnProperty.call(n, t.key)) next.push(n[t.key]);
        childrenOf(n).forEach(walk);
      };
      nodes.forEach(walk);
    } else if (t.key === '*') {
      many = true;
      nodes.forEach((n) => next.push(...childrenOf(n)));
    } else if (t.index !== undefined) {
      nodes.forEach((n) => { if (Array.isArray(n) && t.index < n.length) next.push(n[t.index]); });
    } else if (t.slice) {
      many = true;
      nodes.forEach((n) => { if (Array.isArray(n)) next.push(...n.slice(t.slice[0] ?? 0, t.slice[1] ?? n.length)); });
    } else {
      nodes.forEach((n) => { if (n && typeof n === 'object' && !Array.isArray(n) && Object.prototype.hasOwnProperty.call(n, t.key)) next.push(n[t.key]); });
    }
    nodes = next;
  }
  return many ? nodes : nodes[0];
}

const pascal = (s) => nameWords(s).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('') || 'Item';
const camel = (s) => {
  const p = pascal(s);
  return p[0].toLowerCase() + p.slice(1);
};
const JAVA_WORDS = new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while record var yield'.split(' '));

// A sample JSON -> Java records (or Lombok classes): one per object, lists as List<...>, names as Java likes them
// (with @JsonProperty when the JSON name differs).
function jsonToJava(value, rootName, style) {
  const types = new Map(); // class name -> [{ name, type, json }]
  let needList = false;
  let needProp = false;
  const box = (t) => ({ int: 'Integer', long: 'Long', double: 'Double', boolean: 'Boolean' }[t] || t);
  const typeOf = (v, name) => {
    if (v === null || v === undefined) return 'Object';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'number') return Number.isInteger(v) ? (Math.abs(v) <= 2147483647 ? 'int' : 'long') : 'double';
    if (typeof v === 'string') return 'String';
    if (Array.isArray(v)) {
      needList = true;
      const first = v.find((x) => x !== null && x !== undefined);
      const single = name.endsWith('ies') ? `${name.slice(0, -3)}y` : name.endsWith('s') && name.length > 3 ? name.slice(0, -1) : `${name}Item`;
      return `List<${box(first === undefined ? 'Object' : typeOf(first, single))}>`;
    }
    let cls = pascal(name);
    let n = 2;
    while (types.has(cls) && types.get(cls).source !== v) cls = `${pascal(name)}${n++}`;
    if (!types.has(cls)) {
      const fields = [];
      types.set(cls, fields);
      fields.source = v;
      for (const [k, val] of Object.entries(v)) {
        let field = camel(k);
        if (JAVA_WORDS.has(field)) field = `${field}Value`;
        if (/^\d/.test(field)) field = `n${field}`;
        if (field !== k) needProp = true;
        fields.push({ name: field, type: typeOf(val, k), json: k });
      }
    }
    return cls;
  };
  const rootType = typeOf(Array.isArray(value) ? value.find((x) => x && typeof x === 'object') || {} : value, rootName || 'Root');
  const lines = [];
  if (needList) lines.push('import java.util.List;');
  if (needProp) lines.push('import com.fasterxml.jackson.annotation.JsonProperty;');
  if (style === 'lombok') lines.push('import lombok.Data;');
  if (lines.length) lines.push('');
  const decl = (f) => `${f.name !== f.json ? `@JsonProperty("${f.json}") ` : ''}${f.type} ${f.name}`;
  for (const [cls, fields] of types) {
    if (style === 'lombok') {
      lines.push('@Data', `public class ${cls} {`);
      for (const f of fields) lines.push(`    ${f.name !== f.json ? `@JsonProperty("${f.json}")\n    ` : ''}private ${f.type} ${f.name};`);
      lines.push('}', '');
    } else {
      lines.push(fields.length ? `public record ${cls}(\n${fields.map((f) => `        ${decl(f)}`).join(',\n')}\n) {}` : `public record ${cls}() {}`, '');
    }
  }
  if (Array.isArray(value)) lines.push(`// The JSON is a list: List<${rootType}>`);
  return lines.join('\n').trim();
}

function buildJsonTool() {
  const box = tEl('div', 'tool');
  const input = toolArea('{"name": "orders", "port": 8080, "tags": ["a", "b"]}', 10);
  const status = tEl('div', 'tool-status');
  let parsed;
  let ok = false;
  const output = tEl('pre', 'tool-out');
  const actions = tEl('div', 'tool-row');
  const show = (text) => {
    output.textContent = text;
  };
  actions.append(
    toolButton('Format', () => ok && show(JSON.stringify(parsed, null, 2))),
    toolButton('Minify', () => ok && show(JSON.stringify(parsed))),
    toolButton('Sort keys', () => {
      if (!ok) return;
      const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
      show(JSON.stringify(sort(parsed), null, 2));
    }),
    toolButton('Put it in the box', () => {
      if (output.textContent) {
        input.value = output.textContent;
        check();
      }
    }),
    copyButton(() => output.textContent, 'JSON'),
    status,
  );
  const query = toolInput('JSONPath: $.items[0].name, $..id, $.tags[*]');
  const queryOut = tEl('pre', 'tool-out');
  const javaOut = tEl('pre', 'tool-out tool-out-tall');
  let style = 'record';
  const rootName = toolInput('Root', 'Root');
  rootName.classList.add('tool-input-short');
  const java = () => {
    javaOut.textContent = ok && parsed && typeof parsed === 'object' ? jsonToJava(parsed, rootName.value.trim() || 'Root', style) : '';
  };
  const runQuery = () => {
    queryOut.textContent = '';
    queryOut.classList.remove('tool-error');
    if (!ok || !query.value.trim()) return;
    try {
      const r = jsonPath(parsed, query.value);
      queryOut.textContent = r === undefined ? 'Nothing there' : JSON.stringify(r, null, 2);
    } catch (e) {
      queryOut.textContent = e.message;
      queryOut.classList.add('tool-error');
    }
  };
  const check = () => {
    const t = input.value;
    status.className = 'tool-status';
    if (!t.trim()) {
      ok = false;
      status.textContent = '';
      output.textContent = '';
      runQuery();
      java();
      return;
    }
    try {
      parsed = JSON.parse(t);
      ok = true;
      const count = (v) => (Array.isArray(v) ? `a list of ${v.length}` : v && typeof v === 'object' ? `${Object.keys(v).length} keys` : typeof v);
      status.textContent = `✓ Valid JSON (${count(parsed)})`;
      status.classList.add('ok');
    } catch {
      ok = false;
      status.textContent = jsonErrorAt(t);
      status.classList.add('bad');
    }
    runQuery();
    java();
  };
  input.addEventListener('input', debounce(check, 200));
  query.addEventListener('input', runQuery);
  rootName.addEventListener('input', java);
  const qHead = tEl('div', 'tool-section-head');
  qHead.append(tEl('h3', '', 'Query'), copyButton(() => queryOut.textContent, 'Result'));
  const jHead = tEl('div', 'tool-section-head');
  jHead.append(tEl('h3', '', 'Java'), toolSegment([['record', 'Records'], ['lombok', 'Lombok classes']], style, (v) => { style = v; java(); }, 'Java style'), rootName, copyButton(() => javaOut.textContent, 'Java code'));
  const q = tEl('div', 'tool-section');
  q.append(qHead, query, queryOut);
  const j = tEl('div', 'tool-section');
  j.append(jHead, javaOut);
  box.append(toolHead('JSON', 'Checks the JSON as you type (and says where it breaks), formats or minifies it, finds values with JSONPath and writes Java types for it.'), input, actions, output, q, j);
  return { el: box, focus: input };
}

// -- Spring cron --
const CRON_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const CRON_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const CRON_MACROS = { '@yearly': '0 0 0 1 1 *', '@annually': '0 0 0 1 1 *', '@monthly': '0 0 0 1 * *', '@weekly': '0 0 0 * * 0', '@daily': '0 0 0 * * *', '@midnight': '0 0 0 * * *', '@hourly': '0 0 * * * *' };
const CRON_FIELDS = [
  { name: 'Second', min: 0, max: 59 },
  { name: 'Minute', min: 0, max: 59 },
  { name: 'Hour', min: 0, max: 23 },
  { name: 'Day of month', min: 1, max: 31 },
  { name: 'Month', min: 1, max: 12, names: CRON_MONTHS, base: 1 },
  { name: 'Day of week', min: 0, max: 7, names: CRON_DAYS, base: 0 },
];

function cronField(text, f) {
  const set = new Set();
  const value = (v) => {
    const up = v.toUpperCase();
    if (f.names && f.names.includes(up)) return f.names.indexOf(up) + f.base;
    if (!/^\d+$/.test(v)) throw new Error(`${f.name}: "${v}" is not a number${f.names ? ' or a name' : ''}`);
    const n = Number(v);
    if (n < f.min || n > f.max) throw new Error(`${f.name}: ${n} is out of ${f.min}-${f.max}`);
    return n;
  };
  for (const part of text.split(',')) {
    if (/[LW#]/i.test(part) && !(f.names && f.names.some((n) => part.toUpperCase().includes(n)))) throw new Error(`${f.name}: L, W and # are not explained here`);
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`${f.name}: the step after / must be a positive number`);
    let lo;
    let hi;
    if (range === '*' || range === '?') {
      lo = f.min;
      hi = f.name === 'Day of week' ? 6 : f.max;
    } else if (range.includes('-')) {
      [lo, hi] = range.split('-').map(value);
      if (hi < lo) throw new Error(`${f.name}: ${range} goes backwards`);
    } else {
      lo = value(range);
      hi = stepText === undefined ? lo : f.max;
    }
    for (let i = lo; i <= hi; i += step) set.add(f.name === 'Day of week' && i === 7 ? 0 : i);
  }
  return set;
}

function describeCronField(text, f, set) {
  if (text === '*' || text === '?') return `every ${f.name.toLowerCase().replace('day of month', 'day').replace('day of week', 'day of the week')}`;
  const nameOf = (n) => (f.name === 'Month' ? CRON_MONTHS[n - 1][0] + CRON_MONTHS[n - 1].slice(1).toLowerCase() : f.name === 'Day of week' ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][n] : String(n));
  const step = /^\*\/(\d+)$/.exec(text);
  const list = [...set].sort((a, b) => a - b);
  if (step) return `every ${step[1]} (${list.slice(0, 8).map(nameOf).join(', ')}${list.length > 8 ? ', ...' : ''})`;
  return list.map(nameOf).join(', ');
}

function cronNext(sets, count) {
  const [sec, min, hour, dom, mon, dow] = sets;
  const out = [];
  let d = new Date(Math.floor(Date.now() / 1000) * 1000 + 1000);
  const limit = Date.now() + 5 * 366 * 86400000;
  for (let guard = 0; out.length < count && guard < 500000 && d.getTime() < limit; guard++) {
    if (!mon.has(d.getMonth() + 1)) d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    else if (!dom.has(d.getDate()) || !dow.has(d.getDay())) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    else if (!hour.has(d.getHours())) d = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1);
    else if (!min.has(d.getMinutes())) d = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes() + 1);
    else if (!sec.has(d.getSeconds())) d = new Date(d.getTime() + 1000);
    else {
      out.push(new Date(d));
      d = new Date(d.getTime() + 1000);
    }
  }
  return out;
}

function buildCronTool() {
  const box = tEl('div', 'tool');
  const input = toolInput('0 */15 * * * *  (second minute hour day month weekday)');
  const chips = tEl('div', 'tool-row');
  for (const [text, label] of [['0 0 * * * *', 'every hour'], ['0 */15 * * * *', 'every 15 min'], ['0 0 9 * * MON-FRI', 'weekdays at 9'], ['0 0 0 1 * *', 'monthly'], ['@daily', '@daily']]) {
    const b = toolButton(label, () => {
      input.value = text;
      render();
    }, 'tool-chip');
    b.title = text;
    chips.appendChild(b);
  }
  const out = tEl('div', 'tool-result');
  box.append(toolHead('Spring cron', 'The expression of @Scheduled(cron = "..."): six fields, seconds first. It says what each field means and when it runs next (this PC\'s time).'), input, chips, out);
  const render = () => {
    out.textContent = '';
    let t = input.value.trim().replace(/^["']|["']$/g, '');
    if (!t) return;
    const notes = [];
    if (CRON_MACROS[t.toLowerCase()]) {
      notes.push(`${t} is ${CRON_MACROS[t.toLowerCase()]}`);
      t = CRON_MACROS[t.toLowerCase()];
    }
    let parts = t.split(/\s+/);
    if (parts.length === 5) {
      notes.push('Five fields is the Unix form: Spring wants six, seconds first. Read here with 0 seconds.');
      parts = ['0', ...parts];
    }
    if (parts.length !== 6) {
      out.appendChild(toolNote(`Spring needs 6 fields (second minute hour day month weekday): this has ${parts.length}`));
      return;
    }
    let sets;
    try {
      sets = parts.map((p, i) => cronField(p, CRON_FIELDS[i]));
    } catch (e) {
      out.appendChild(toolNote(e.message));
      return;
    }
    for (const n of notes) out.appendChild(toolNote(n, 'tool-hint'));
    const f = toolFields();
    parts.forEach((p, i) => f.add(CRON_FIELDS[i].name, `${p}  →  ${describeCronField(p, CRON_FIELDS[i], sets[i])}`, { copy: false }));
    if (!['*', '?'].includes(parts[3]) && !['*', '?'].includes(parts[5])) f.add('Note', 'Day of month and day of week are both set: Spring runs only when both match', { copy: false });
    out.appendChild(f);
    const next = cronNext(sets, 6);
    const sec = tEl('div', 'tool-section');
    sec.appendChild(tEl('h3', '', 'Next runs'));
    if (!next.length) sec.appendChild(toolNote('It never runs (no date matches in the next 5 years)'));
    const list = tEl('ol', 'tool-list');
    for (const d of next) list.appendChild(tEl('li', '', `${localDate(d.getTime())}  ·  ${relTime(d.getTime())}`));
    sec.appendChild(list);
    out.appendChild(sec);
  };
  input.addEventListener('input', render);
  return { el: box, focus: input };
}

// -- Name cases --
function nameWords(s) {
  return String(s)
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const CASES = [
  ['camelCase', (w) => w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join('')],
  ['PascalCase', (w) => w.map((x) => x[0].toUpperCase() + x.slice(1).toLowerCase()).join('')],
  ['snake_case', (w) => w.map((x) => x.toLowerCase()).join('_')],
  ['CONSTANT_CASE', (w) => w.map((x) => x.toUpperCase()).join('_')],
  ['kebab-case', (w) => w.map((x) => x.toLowerCase()).join('-')],
  ['dot.case', (w) => w.map((x) => x.toLowerCase()).join('.')],
  ['Title Case', (w) => w.map((x) => x[0].toUpperCase() + x.slice(1).toLowerCase()).join(' ')],
  ['lower words', (w) => w.map((x) => x.toLowerCase()).join(' ')],
];

function buildCaseTool() {
  const box = tEl('div', 'tool');
  const input = toolArea('order line item, OrderLineItem or order_line_item (one per line)', 3);
  const out = tEl('div', 'tool-result');
  box.append(toolHead('Name cases', 'One name (or one per line) in every common case: for fields, constants, URLs, properties and file names.'), input, out);
  const render = () => {
    out.textContent = '';
    const lines = input.value.split('\n').filter((l) => l.trim());
    if (!lines.length) return;
    const f = toolFields();
    for (const [name, fn] of CASES) f.add(name, lines.map((l) => fn(nameWords(l))).join('\n'), { what: name });
    out.appendChild(f);
  };
  input.addEventListener('input', render);
  return { el: box, focus: input };
}

// -- UUID / passwords / secrets --
function randomInt(max) {
  // without the bias of a plain modulo
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % max;
}

function makePassword(length, sets, avoidAlike) {
  const groups = {
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lower: 'abcdefghijklmnopqrstuvwxyz',
    digits: '0123456789',
    symbols: '!@#$%^&*()-_=+[]{};:,.?/~',
  };
  let chosen = Object.entries(groups).filter(([k]) => sets[k]).map(([, v]) => (avoidAlike ? v.replace(/[0O1lI|]/g, '') : v));
  if (!chosen.length) chosen = [groups.lower];
  const all = chosen.join('');
  // one of each chosen kind, the rest from all of them, then shuffled
  const chars = chosen.map((g) => g[randomInt(g.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return { text: chars.slice(0, length).join(''), bits: Math.round(length * Math.log2(all.length)) };
}

function buildIdsTool() {
  const box = tEl('div', 'tool');
  box.appendChild(toolHead('UUID · passwords', 'Made here with the system\'s secure random numbers. Passwords and secrets are copied without going into the clipboard history, and cleared from it after 30 seconds.'));

  // UUIDs
  const uSec = tEl('div', 'tool-section');
  let count = '1';
  let upper = false;
  let dashes = true;
  const uOut = tEl('pre', 'tool-out');
  const makeIds = () => {
    const n = Number(count);
    uOut.textContent = Array.from({ length: n }, () => {
      let id = crypto.randomUUID();
      if (!dashes) id = id.replace(/-/g, '');
      return upper ? id.toUpperCase() : id;
    }).join('\n');
  };
  const uHead = tEl('div', 'tool-section-head');
  const upperBox = toolCheck('Upper case', false, (v) => { upper = v; makeIds(); });
  const dashBox = toolCheck('Dashes', true, (v) => { dashes = v; makeIds(); });
  uHead.append(tEl('h3', '', 'UUID (v4)'), toolSegment([['1', '1'], ['5', '5'], ['10', '10']], count, (v) => { count = v; makeIds(); }, 'How many'), upperBox, dashBox, toolButton('New', makeIds), copyButton(() => uOut.textContent, 'UUID'));
  uSec.append(uHead, uOut);
  makeIds();

  // passwords
  const pSec = tEl('div', 'tool-section');
  const sets = { upper: true, lower: true, digits: true, symbols: true };
  let avoid = true;
  const length = tEl('input', 'tool-range');
  Object.assign(length, { type: 'range', min: 8, max: 64, value: 20 });
  length.setAttribute('aria-label', 'Length');
  const lengthText = tEl('span', 'tool-label', '20');
  const pOut = tEl('div', 'tool-out tool-secret');
  const pBits = tEl('div', 'tool-hint');
  const makePw = () => {
    const p = makePassword(Number(length.value), sets, avoid);
    pOut.textContent = p.text;
    lengthText.textContent = `${length.value} characters`;
    pBits.textContent = `About ${p.bits} bits of randomness${p.bits >= 100 ? ': strong' : p.bits >= 70 ? ': good' : ': short, add length'}`;
  };
  length.addEventListener('input', makePw);
  const pHead = tEl('div', 'tool-section-head');
  pHead.append(tEl('h3', '', 'Password'), toolButton('New', makePw), copyButton(() => pOut.textContent, 'Password', true));
  const pOpts = tEl('div', 'tool-row');
  pOpts.append(length, lengthText,
    toolCheck('A-Z', true, (v) => { sets.upper = v; makePw(); }),
    toolCheck('a-z', true, (v) => { sets.lower = v; makePw(); }),
    toolCheck('0-9', true, (v) => { sets.digits = v; makePw(); }),
    toolCheck('Symbols', true, (v) => { sets.symbols = v; makePw(); }),
    toolCheck('No look-alikes (0 O 1 l I)', true, (v) => { avoid = v; makePw(); }));
  pSec.append(pHead, pOpts, pOut, pBits);
  makePw();

  // secret keys
  const sSec = tEl('div', 'tool-section');
  let bytes = '32';
  let form = 'base64';
  const sOut = tEl('div', 'tool-out tool-secret');
  const makeSecret = () => {
    const b = crypto.getRandomValues(new Uint8Array(Number(bytes)));
    sOut.textContent = form === 'hex' ? [...b].map((x) => x.toString(16).padStart(2, '0')).join('') : btoa(String.fromCharCode(...b));
  };
  const sHead = tEl('div', 'tool-section-head');
  sHead.append(tEl('h3', '', 'Secret key'),
    toolSegment([['16', '128 bits'], ['32', '256 bits'], ['64', '512 bits']], bytes, (v) => { bytes = v; makeSecret(); }, 'Size'),
    toolSegment([['base64', 'Base64'], ['hex', 'Hex']], form, (v) => { form = v; makeSecret(); }, 'Form'),
    toolButton('New', makeSecret), copyButton(() => sOut.textContent, 'Secret', true));
  sSec.append(sHead, sOut, toolNote('For a JWT HMAC key, an encryption key or an API secret.', 'tool-hint'));
  makeSecret();

  box.append(uSec, pSec, sSec);
  return { el: box };
}

function toolCheck(label, checked, onChange) {
  const l = tEl('label', 'tool-check');
  const c = tEl('input');
  c.type = 'checkbox';
  c.checked = checked;
  c.addEventListener('change', () => onChange(c.checked));
  l.append(c, document.createTextNode(label));
  return l;
}

// -- Hashes --
function buildHashTool() {
  const box = tEl('div', 'tool');
  const input = toolArea('Text to hash', 5);
  const key = toolInput('HMAC key (optional)');
  const out = tEl('div', 'tool-result');
  box.append(toolHead('Hashes', 'Of the text as UTF-8, exactly as typed (a line break at the end counts). With a key, also HMAC-SHA256.'), input, key, out);
  const render = debounce(async () => {
    out.textContent = '';
    if (!input.value) return;
    const r = await window.tools.hash(input.value, key.value);
    if (r.error) {
      out.appendChild(toolNote(r.error));
      return;
    }
    const f = toolFields();
    f.add('MD5', r.md5);
    f.add('SHA-1', r.sha1);
    f.add('SHA-256', r.sha256);
    f.add('SHA-256 (Base64)', r.sha256Base64);
    f.add('SHA-512', r.sha512);
    if (r.hmac256) f.add('HMAC-SHA256', r.hmac256);
    out.appendChild(f);
  }, 150);
  input.addEventListener('input', render);
  key.addEventListener('input', render);
  return { el: box, focus: input };
}

// -- Ports in use --
function buildPortsTool() {
  const box = tEl('div', 'tool');
  const port = toolInput('Port, e.g. 8080 (empty: all)');
  port.classList.add('tool-input-short');
  port.inputMode = 'numeric';
  const state = tEl('span', 'tool-hint');
  const table = tEl('div', 'tool-result');
  const load = async () => {
    const value = port.value.trim();
    if (value && !/^\d{1,5}$/.test(value)) {
      state.textContent = 'A port is a number';
      return;
    }
    state.textContent = 'Looking...';
    const r = await window.tools.ports(value);
    table.textContent = '';
    if (r.error) {
      state.textContent = '';
      table.appendChild(toolNote(r.error));
      return;
    }
    state.textContent = value ? '' : `${r.rows.length} listening`;
    if (!r.rows.length) {
      table.appendChild(toolNote(value ? `Nothing listens on ${value}: it is free` : 'Nothing listens on any port', 'tool-hint'));
      return;
    }
    const grid = tEl('div', 'tool-ports');
    for (const h of ['Port', 'PID', 'Program', 'Command line', '']) grid.appendChild(tEl('div', 'tool-ports-head', h));
    for (const row of r.rows) {
      const p = tEl('div', 'tool-ports-port', String(row.port));
      if (row.local) p.appendChild(tEl('span', 'tool-badge', 'local'));
      const cmd = tEl('div', 'tool-ports-cmd', row.command || '');
      cmd.title = row.command || '';
      const end = toolButton('End', async () => {
        const what = `${row.program || 'the program'} (PID ${row.pid}), listening on ${row.port}`;
        if (!(await window.git.confirm(`End ${what}? It stops at once and anything it did not save is lost.`))) return;
        end.disabled = true;
        const res = await window.tools.endProcess(row.pid);
        if (res.error) toast(res.error, 'error', { title: 'It could not be ended' });
        else toast(`Ended ${row.program || `PID ${row.pid}`}: port ${row.port} is free`, 'success');
        load();
      }, 'btn-danger');
      end.title = `End process ${row.pid}`;
      const endCell = tEl('div', 'tool-ports-end');
      endCell.appendChild(end);
      grid.append(p, tEl('div', 'tool-ports-pid', String(row.pid)), tEl('div', 'tool-ports-prog', row.program || '?'), cmd, endCell);
    }
    table.appendChild(grid);
  };
  port.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') load();
  });
  const row = tEl('div', 'tool-row');
  row.append(port, toolButton('Find', load, 'btn-primary'), toolButton('Show all', () => {
    port.value = '';
    load();
  }), state);
  box.append(toolHead('Ports in use', 'Which program listens on a port, with its command line (a Java one says which service it is). End frees the port: for the Start that fails because 8080 is taken.'), row, table);
  let loaded = false;
  return {
    el: box,
    focus: port,
    shown(on) {
      if (on && !loaded) {
        loaded = true;
        load();
      }
    },
  };
}

// -- Compare two texts --
const MAX_DIFF_EDITS = 3000; // beyond that many changed lines the texts are too different to show line by line

// Myers' diff of two lists of lines: [['=', a, b] | ['-', a] | ['+', b]] in order.
function diffLines(a, b, same) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const trace = [];
  let v = { 1: 0 };
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    if (d > MAX_DIFF_EDITS) return null;
    trace.push(v);
    const next = { ...v };
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[k - 1] ?? -1) < (v[k + 1] ?? -1)) ? v[k + 1] ?? 0 : (v[k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && same(a[x], b[y])) {
        x++;
        y++;
      }
      next[k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    v = next;
  }
  // walk back
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && (vd[k - 1] ?? -1) < (vd[k + 1] ?? -1)) ? k + 1 : k - 1;
    const prevX = vd[prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push(['=', --x, --y]);
    if (prevK === k + 1) ops.push(['+', null, --y]);
    else ops.push(['-', --x, null]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) ops.push(['=', --x, --y]);
  return ops.reverse();
}

function buildCompareTool() {
  const box = tEl('div', 'tool');
  const left = toolArea('The first text (before)', 10);
  const right = toolArea('The second text (after)', 10);
  let ignoreSpace = false;
  let ignoreCase = false;
  let all = false;
  const summary = tEl('span', 'tool-status');
  const out = tEl('div', 'cmp-lines');
  const two = tEl('div', 'tool-two');
  two.append(left, right);
  const row = tEl('div', 'tool-row');
  row.append(
    toolCheck('Ignore spaces', false, (v) => { ignoreSpace = v; render(); }),
    toolCheck('Ignore case', false, (v) => { ignoreCase = v; render(); }),
    toolCheck('Show every line', false, (v) => { all = v; render(); }),
    toolButton('⇄ Swap', () => {
      [left.value, right.value] = [right.value, left.value];
      render();
    }),
    summary,
  );
  const caption = tEl('div', 'tool-hint cmp-caption');
  box.append(toolHead('Compare texts', 'Paste two versions of a text (a config, a response, a list): the lines that differ show in red and green.'), caption, two, row, out);
  const norm = (s) => {
    let t = s;
    if (ignoreSpace) t = t.replace(/\s+/g, ' ').trim();
    if (ignoreCase) t = t.toLowerCase();
    return t;
  };
  const render = debounce(() => {
    out.textContent = '';
    summary.className = 'tool-status';
    if (!left.value && !right.value) {
      summary.textContent = '';
      return;
    }
    const a = left.value.replace(/\r\n?/g, '\n').split('\n');
    const b = right.value.replace(/\r\n?/g, '\n').split('\n');
    if (a.length + b.length > 20000) {
      summary.textContent = 'Too long to compare here (10,000 lines each at most)';
      summary.classList.add('bad');
      return;
    }
    const an = a.map(norm);
    const bn = b.map(norm);
    const ops = diffLines(an, bn, (x, y) => x === y);
    if (!ops) {
      summary.textContent = `The texts are too different to show line by line (more than ${MAX_DIFF_EDITS} lines changed)`;
      summary.classList.add('bad');
      return;
    }
    const added = ops.filter((o) => o[0] === '+').length;
    const removed = ops.filter((o) => o[0] === '-').length;
    if (!added && !removed) {
      summary.textContent = '✓ The texts are the same';
      summary.classList.add('ok');
      return;
    }
    summary.textContent = `${removed} line${removed === 1 ? '' : 's'} removed, ${added} added`;
    // the changed lines with 3 lines around them, unless every line is wanted
    const keep = new Set();
    ops.forEach((o, i) => {
      if (all || o[0] !== '=') for (let j = Math.max(0, i - 3); j <= Math.min(ops.length - 1, i + 3); j++) keep.add(j);
    });
    let gap = false;
    ops.forEach((o, i) => {
      if (!keep.has(i)) {
        if (!gap) out.appendChild(tEl('div', 'cmp-gap', '···'));
        gap = true;
        return;
      }
      gap = false;
      const line = tEl('div', `cmp-line ${o[0] === '+' ? 'add' : o[0] === '-' ? 'del' : 'ctx'}`);
      line.append(
        tEl('span', 'cmp-no', o[1] === null ? '' : String(o[1] + 1)),
        tEl('span', 'cmp-no', o[2] === null ? '' : String(o[2] + 1)),
        tEl('span', 'cmp-sign', o[0] === '=' ? ' ' : o[0]),
        tEl('span', 'cmp-text', o[0] === '+' ? b[o[2]] : a[o[1]]),
      );
      out.appendChild(line);
    });
  }, 250);
  left.addEventListener('input', () => { caption.textContent = ''; render(); });
  right.addEventListener('input', () => { caption.textContent = ''; render(); });
  return {
    el: box,
    focus: left,
    // two texts from elsewhere (the Analysis page), and what they are
    fill(a, b, what) {
      left.value = a;
      right.value = b;
      caption.textContent = what || '';
      render();
    },
  };
}

// Opens the Compare texts tool with two texts in it.
function openInCompare(a, b, what) {
  setMode('tools');
  showTool('compare');
  builtTools.get('compare').fill(a, b, what);
}

// -- Compare JSON --
// Two JSON texts compared field by field: changed values, keys only on one side, different types. The order of the
// keys never counts; the order in lists can be left out too.
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeysDeep(v[k])]));
  return v;
}

function jsonDiff(a, b, opts, at = '$', out = []) {
  const type = (v) => (v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v === 'object' ? 'object' : typeof v);
  const ta = type(a);
  const tb = type(b);
  if (ta !== tb) {
    out.push({ path: at, kind: 'type', left: a, right: b });
    return out;
  }
  const child = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `${at}.${k}` : `${at}['${k}']`);
  if (ta === 'object') {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!(k in a)) out.push({ path: child(k), kind: 'added', right: b[k] });
      else if (!(k in b)) out.push({ path: child(k), kind: 'removed', left: a[k] });
      else jsonDiff(a[k], b[k], opts, child(k), out);
    }
  } else if (ta === 'list') {
    if (opts.ignoreOrder) {
      const key = (v) => JSON.stringify(sortKeysDeep(v));
      const left = a.map(key);
      const right = b.map(key);
      const rest = (keys) => keys.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
      const inRight = rest(right);
      a.forEach((v, i) => {
        if (inRight.get(left[i])) inRight.set(left[i], inRight.get(left[i]) - 1);
        else out.push({ path: `${at}[${i}]`, kind: 'removed', left: v });
      });
      const inLeft = rest(left);
      b.forEach((v, i) => {
        if (inLeft.get(right[i])) inLeft.set(right[i], inLeft.get(right[i]) - 1);
        else out.push({ path: `${at}[${i}]`, kind: 'added', right: v });
      });
    } else {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (i >= a.length) out.push({ path: `${at}[${i}]`, kind: 'added', right: b[i] });
        else if (i >= b.length) out.push({ path: `${at}[${i}]`, kind: 'removed', left: a[i] });
        else jsonDiff(a[i], b[i], opts, `${at}[${i}]`, out);
      }
    }
  } else if (a !== b) {
    out.push({ path: at, kind: 'changed', left: a, right: b });
  }
  return out;
}

const DIFF_KINDS = { changed: ['Changed', 'warn'], added: ['Only on the right', 'good'], removed: ['Only on the left', 'bad'], type: ['Another type', 'warn'] };

function buildJsonDiffTool() {
  const box = tEl('div', 'tool');
  const left = toolArea('{"name": "orders", "port": 8080}', 10);
  const right = toolArea('{"port": 8081, "name": "orders", "debug": true}', 10);
  let ignoreOrder = false;
  const summary = tEl('span', 'tool-status');
  const out = tEl('div', 'tool-result');
  const two = tEl('div', 'tool-two');
  two.append(left, right);
  const row = tEl('div', 'tool-row');
  row.append(
    toolCheck('Ignore the order in lists', false, (v) => { ignoreOrder = v; render(); }),
    toolButton('⇄ Swap', () => {
      [left.value, right.value] = [right.value, left.value];
      render();
    }),
    copyButton(() => diffText(), 'Differences'),
    summary,
  );
  let last = [];
  const show = (v) => (v === undefined ? '' : JSON.stringify(v));
  function diffText() {
    return last.map((d) => `${d.path}\t${DIFF_KINDS[d.kind][0]}\t${show(d.left)}\t${show(d.right)}`).join('\n');
  }
  const render = debounce(() => {
    out.textContent = '';
    summary.className = 'tool-status';
    summary.textContent = '';
    last = [];
    if (!left.value.trim() || !right.value.trim()) return;
    let a;
    let b;
    try {
      a = JSON.parse(left.value);
    } catch {
      summary.textContent = `Left: ${jsonErrorAt(left.value)}`;
      summary.classList.add('bad');
      return;
    }
    try {
      b = JSON.parse(right.value);
    } catch {
      summary.textContent = `Right: ${jsonErrorAt(right.value)}`;
      summary.classList.add('bad');
      return;
    }
    last = jsonDiff(a, b, { ignoreOrder });
    if (!last.length) {
      summary.textContent = '✓ The same JSON (the order of the keys aside)';
      summary.classList.add('ok');
      return;
    }
    const count = (k) => last.filter((d) => d.kind === k).length;
    summary.textContent = [['changed', 'changed'], ['added', 'only on the right'], ['removed', 'only on the left'], ['type', 'of another type']]
      .filter(([k]) => count(k)).map(([k, label]) => `${count(k)} ${label}`).join(', ');
    const grid = tEl('div', 'an-files tool-jdiff');
    for (const h of ['Path', 'Left', 'Right', '']) grid.appendChild(tEl('div', 'an-head', h));
    for (const d of last) {
      const cell = (v) => {
        const c = tEl('div', 'tool-jdiff-val', v === undefined ? '—' : show(v).length > 300 ? `${show(v).slice(0, 300)}…` : show(v));
        if (v !== undefined) c.title = show(v);
        return c;
      };
      const kind = tEl('div', 'an-state');
      kind.appendChild(tEl('span', `an-chip ${DIFF_KINDS[d.kind][1]}`, DIFF_KINDS[d.kind][0]));
      grid.append(tEl('div', 'an-name', d.path), cell(d.left), cell(d.right), kind);
    }
    out.appendChild(grid);
  }, 250);
  left.addEventListener('input', render);
  right.addEventListener('input', render);
  box.append(toolHead('Compare JSON', 'Two JSON texts (two responses, two configs) compared field by field: what changed, and what is only on one side. The order of the keys does not count.'), two, row, out);
  return { el: box, focus: left };
}

// -- Escape strings --
function escapeJava(text, ascii) {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const named = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }[ch];
    if (named) out += named;
    else if (c < 0x20 || c === 0x7f || (ascii && c > 0x7e)) out += ch.split('').map((u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    else out += ch;
  }
  return out;
}

function unescapeJava(text) {
  return text.replace(/\\(u+[0-9a-fA-F]{4}|[0-7]{1,3}|[btnfrs"'\\]|.)/g, (m, e) => {
    if (e[0] === 'u' && e.length > 1) return String.fromCharCode(parseInt(e.replace(/^u+/, ''), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    const known = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', s: ' ', '"': '"', "'": "'", '\\': '\\' }[e];
    if (known === undefined) throw new Error(`${m} is not an escape Java knows`);
    return known;
  });
}

function buildEscapeTool() {
  const box = tEl('div', 'tool');
  let lang = 'java';
  let dir = 'to';
  let style = 'one';
  let ascii = false;
  const input = toolArea('SELECT * FROM orders\nWHERE status = "OPEN"', 6);
  const output = tEl('pre', 'tool-out');
  const error = tEl('div', 'tool-error');
  const styleSeg = toolSegment([['one', 'One string'], ['lines', 'A line each (+)'], ['block', 'Text block']], style, (v) => { style = v; run(); }, 'Java style');
  const asciiBox = toolCheck('Only ASCII (\\uXXXX)', false, (v) => { ascii = v; run(); });
  const run = () => {
    error.textContent = '';
    styleSeg.classList.toggle('hidden', !(lang === 'java' && dir === 'to'));
    asciiBox.classList.toggle('hidden', dir !== 'to');
    const t = input.value;
    if (!t) {
      output.textContent = '';
      return;
    }
    try {
      if (dir === 'to') {
        if (lang === 'json') {
          const j = JSON.stringify(t);
          output.textContent = ascii ? j.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) : j;
        } else if (style === 'block') {
          output.textContent = `"""\n${t.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""')}"""`;
        } else if (style === 'lines') {
          const lines = t.split('\n');
          output.textContent = lines.map((l, i) => `"${escapeJava(l + (i < lines.length - 1 ? '\n' : ''), ascii)}"`).join(' +\n');
        } else {
          output.textContent = `"${escapeJava(t, ascii)}"`;
        }
      } else {
        // a literal, with or without its quotes; several joined with + become one text
        let src = t.trim();
        if (/^"""/.test(src)) src = src.replace(/^"""[ \t]*\n?/, '').replace(/"""$/, '');
        else {
          const parts = src.match(/^"(?:[^"\\]|\\.)*"(?:\s*\+\s*"(?:[^"\\]|\\.)*")*$/s) ? [...src.matchAll(/"((?:[^"\\]|\\.)*)"/gs)].map((m) => m[1]) : [src];
          src = parts.join('');
        }
        output.textContent = lang === 'json' ? JSON.parse(`"${src.replace(/\n/g, '\\n')}"`) : unescapeJava(src);
      }
    } catch (e) {
      output.textContent = '';
      error.textContent = lang === 'json' ? `Not a JSON string: ${e.message}` : e.message;
    }
  };
  const row = tEl('div', 'tool-row');
  row.append(
    toolSegment([['java', 'Java'], ['json', 'JSON']], lang, (v) => { lang = v; run(); }, 'Language'),
    toolSegment([['to', 'Text → literal'], ['from', 'Literal → text']], dir, (v) => { dir = v; run(); }, 'Direction'),
    styleSeg,
    asciiBox,
    copyButton(() => output.textContent, 'Result'),
  );
  input.addEventListener('input', run);
  box.append(toolHead('Escape strings', 'Text as a Java or JSON string literal (quotes, backslashes and line breaks escaped), or a literal back to plain text. In Java: one string, a line each joined with +, or a text block.'), row, input, output, error);
  run();
  return { el: box, focus: input };
}

// -- Spring properties <-> environment variables --
// Spring's relaxed binding: spring.datasource.url <-> SPRING_DATASOURCE_URL; my.list[0].name <-> MY_LIST_0_NAME.
// Dashes are dropped on the way to a variable (Spring reads both), so they cannot come back.
const springToEnv = (key) => key.replace(/\[(\d+)\]/g, '.$1').replace(/-/g, '').replace(/\./g, '_').toUpperCase();
const envToSpring = (name) => name.toLowerCase().split('_').filter(Boolean)
  .map((part, i) => (i && /^\d+$/.test(part) ? `[${part}]` : `${i ? '.' : ''}${part}`)).join('');

function quoteValue(v, style) {
  if (style === 'env') return /^[\w@%+=:,./-]*$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, '\\$1')}"`;
  return `"${v.replace(/(["\\])/g, '\\$1')}"`;
}

function buildSpringEnvTool() {
  const box = tEl('div', 'tool');
  let from = 'properties';
  let format = 'env';
  let back = 'properties';
  const input = toolArea('spring.datasource.url=jdbc:postgresql://db:5432/orders\nspring.jpa.open-in-view=false\nmy.servers[0].host=a.example.com', 9);
  const output = tEl('pre', 'tool-out tool-out-tall');
  const notes = tEl('div', 'tool-hint');
  const error = tEl('div', 'tool-error');
  const fmtSeg = toolSegment([['env', '.env'], ['docker', 'docker -e'], ['compose', 'Compose'], ['k8s', 'Kubernetes']], format, (v) => { format = v; run(); }, 'Output');
  const backSeg = toolSegment([['properties', '.properties'], ['yaml', 'YAML']], back, (v) => { back = v; run(); }, 'Output for variables');
  // name=value pairs from properties lines (or YAML, read as properties first)
  const pairs = async (text, kind) => {
    let src = text;
    if (kind === 'yaml') {
      const r = await window.tools.convertConfig(text, 'yaml', 'properties');
      if (r.error) throw new Error(r.error.split('\n')[0]);
      src = r.text;
    }
    return src.split('\n').map((l) => l.trim()).filter((l) => l && !/^[#!]/.test(l)).map((l) => {
      const m = /^([^=:\s]+)\s*[=:]?\s*(.*)$/.exec(l);
      return m ? [m[1], m[2]] : [l, ''];
    });
  };
  const run = debounce(async () => {
    error.textContent = '';
    notes.textContent = '';
    fmtSeg.classList.toggle('hidden', from === 'env');
    backSeg.classList.toggle('hidden', from !== 'env');
    if (!input.value.trim()) {
      output.textContent = '';
      return;
    }
    try {
      if (from === 'env') {
        const lines = input.value.split('\n').map((l) => l.trim().replace(/^(export\s+|-e\s+)/, '').replace(/^(["'])(.*)\1$/, '$2')).filter((l) => l && !l.startsWith('#'));
        const props = lines.map((l) => {
          const i = l.indexOf('=');
          const name = (i === -1 ? l : l.slice(0, i)).trim();
          const value = i === -1 ? '' : l.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
          return `${envToSpring(name)}=${value}`;
        }).join('\n');
        if (back === 'yaml') {
          const r = await window.tools.convertConfig(props, 'properties', 'yaml');
          if (r.error) throw new Error(r.error);
          output.textContent = r.text;
        } else output.textContent = `${props}\n`;
        notes.textContent = 'Dashes in the names cannot come back from a variable (OPENINVIEW is open-in-view): Spring reads both forms.';
        return;
      }
      const list = await pairs(input.value, from);
      const odd = list.filter(([k]) => /[^A-Za-z0-9.\-[\]]/.test(k)).map(([k]) => k);
      const env = list.filter(([k]) => !odd.includes(k)).map(([k, v]) => [springToEnv(k), v]);
      if (format === 'env') output.textContent = env.map(([k, v]) => `${k}=${quoteValue(v, 'env')}`).join('\n');
      else if (format === 'docker') output.textContent = env.map(([k, v]) => `-e ${k}=${quoteValue(v, 'env')}`).join(' \\\n');
      else if (format === 'compose') output.textContent = `environment:\n${env.map(([k, v]) => `  ${k}: ${quoteValue(v)}`).join('\n')}`;
      else output.textContent = `env:\n${env.map(([k, v]) => `  - name: ${k}\n    value: ${quoteValue(v)}`).join('\n')}`;
      if (odd.length) notes.textContent = `Left out (Spring cannot read these from a variable): ${odd.join(', ')}`;
    } catch (e) {
      output.textContent = '';
      error.textContent = e.message;
    }
  }, 200);
  const row = tEl('div', 'tool-row');
  row.append(
    tEl('span', 'tool-label', 'From'),
    toolSegment([['properties', '.properties'], ['yaml', 'application.yml'], ['env', 'Variables']], from, (v) => { from = v; run(); }, 'From'),
    tEl('span', 'tool-label', 'to'),
    fmtSeg,
    backSeg,
    copyButton(() => output.textContent, 'Result'),
  );
  input.addEventListener('input', run);
  box.append(toolHead('Spring ↔ env vars', 'Spring properties (or a whole application.yml) as environment variables, the way Spring reads them back (SPRING_DATASOURCE_URL), for a .env file, docker run, Compose or Kubernetes. Or variables back to properties.'), row, input, output, notes, error);
  run();
  return { el: box, focus: input };
}

// -- Portuguese IDs --
// Checked and made with their check digits: NIF (tax number), NISS (social security), IBAN PT and the number of the
// Cartão de Cidadão. The made ones are random: valid in form, for tests, nobody's.
const onlyDigits = (v) => String(v || '').replace(/[\s.-]/g, '');
const randDigits = (n) => Array.from({ length: n }, () => randomInt(10)).join('');

function nifCheck(first8) {
  const sum = [...first8].reduce((t, d, i) => t + Number(d) * (9 - i), 0);
  const c = 11 - (sum % 11);
  return c >= 10 ? 0 : c;
}

const NIF_KINDS = [[/^[123]/, 'a person'], [/^45/, 'a non-resident person'], [/^5/, 'a company'], [/^6/, 'a public body'], [/^7/, 'an estate, fund or other entity'], [/^8/, 'a sole trader'], [/^9/, 'an irregular or non-resident entity']];

function checkNif(v) {
  const d = onlyDigits(v);
  if (!/^\d{9}$/.test(d)) return { ok: false, why: 'A NIF has 9 digits' };
  if (/^(0|4(?!5))/.test(d)) return { ok: false, why: 'No NIF starts like that' };
  const c = nifCheck(d.slice(0, 8));
  if (c !== Number(d[8])) return { ok: false, why: `The last digit should be ${c}` };
  const kind = NIF_KINDS.find(([re]) => re.test(d));
  return { ok: true, why: `Valid: ${kind ? kind[1] : 'an entity'}` };
}

function makeNif(kind) {
  const first = kind === 'company' ? '5' : String(1 + randomInt(2));
  const body = first + randDigits(7);
  return body + nifCheck(body);
}

function nissCheck(first10) {
  const w = [29, 23, 19, 17, 13, 11, 7, 5, 3, 2];
  return 9 - ([...first10].reduce((t, d, i) => t + Number(d) * w[i], 0) % 10);
}

function checkNiss(v) {
  const d = onlyDigits(v);
  if (!/^\d{11}$/.test(d)) return { ok: false, why: 'A NISS has 11 digits' };
  if (!/^[12]/.test(d)) return { ok: false, why: 'A NISS starts with 1 (a person) or 2 (a company)' };
  const c = nissCheck(d.slice(0, 10));
  return c === Number(d[10]) ? { ok: true, why: `Valid: ${d[0] === '1' ? 'a person' : 'a company'}` } : { ok: false, why: `The last digit should be ${c}` };
}

const makeNiss = (kind) => {
  const body = (kind === 'company' ? '2' : '1') + randDigits(9);
  return body + nissCheck(body);
};

// the remainder of a long number (as text) by 97
function mod97(numeric) {
  let r = 0;
  for (const ch of numeric) r = (r * 10 + Number(ch)) % 97;
  return r;
}

const ibanNumeric = (s) => s.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));

function checkIban(v) {
  const s = String(v || '').replace(/\s+/g, '').toUpperCase();
  if (!/^PT\d{23}$/.test(s)) return { ok: false, why: 'A Portuguese IBAN is PT and 23 digits (25 characters)' };
  if (mod97(ibanNumeric(s.slice(4) + s.slice(0, 4))) !== 1) return { ok: false, why: 'The check digits do not match (mod 97)' };
  const bban = s.slice(4);
  const nib = 98 - mod97(`${bban.slice(0, 19)}00`);
  if (nib !== Number(bban.slice(19))) return { ok: false, why: `The NIB check digits should be ${String(nib).padStart(2, '0')}` };
  return { ok: true, why: `Valid: bank ${bban.slice(0, 4)}, branch ${bban.slice(4, 8)}, account ${bban.slice(8, 19)}` };
}

function makeIban() {
  const base = randDigits(19);
  const bban = base + String(98 - mod97(`${base}00`)).padStart(2, '0');
  const check = String(98 - mod97(ibanNumeric(`${bban}PT00`))).padStart(2, '0');
  return `PT${check}${bban}`.replace(/(.{4})/g, '$1 ').trim();
}

// Cartão de Cidadão: 8 digits, their check digit, 2 version characters, a check digit over all of it.
const ccValue = (c) => (/\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55);
function ccSum(s) {
  let sum = 0;
  let second = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let v = ccValue(s[i]);
    if (second) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
    second = !second;
  }
  return sum;
}

function checkCc(v) {
  const s = String(v || '').replace(/\s+/g, '').toUpperCase();
  if (!/^\d{9}[A-Z0-9]{2}\d$/.test(s)) return { ok: false, why: 'The number of a Cartão de Cidadão is 8 digits, a digit, 2 letters and a digit (12345678 9 ZZ1)' };
  return ccSum(s) % 10 === 0 ? { ok: true, why: `Valid: civil number ${s.slice(0, 8)}, version ${s.slice(9, 11)}` } : { ok: false, why: 'The check digit does not match' };
}

function makeCc() {
  const civil = randDigits(8);
  const first = nifCheck(civil);
  const version = ['ZZ', 'ZY', 'ZX', 'ZW'][randomInt(4)];
  const head = `${civil}${first}${version}`;
  for (let d = 0; d < 10; d++) {
    if (ccSum(head + d) % 10 === 0) return `${civil} ${first} ${version}${d}`;
  }
  return makeCc();
}

function buildPtIdsTool() {
  const box = tEl('div', 'tool');
  box.appendChild(toolHead('Portuguese IDs', 'Checks a NIF, NISS, IBAN or the number of a Cartão de Cidadão (with its check digits), or makes valid ones for tests. The made ones are random: right in form, nobody\'s.'));
  const kinds = [
    { id: 'nif', title: 'NIF (tax number)', placeholder: '123456789', check: checkNif, make: makeNif, people: true },
    { id: 'niss', title: 'NISS (social security)', placeholder: '12345678902', check: checkNiss, make: makeNiss, people: true },
    { id: 'iban', title: 'IBAN (Portugal)', placeholder: 'PT50 0002 0123 1234 5678 9015 4', check: checkIban, make: makeIban },
    { id: 'cc', title: 'Cartão de Cidadão', placeholder: '12345678 9 ZZ1', check: checkCc, make: makeCc },
  ];
  for (const k of kinds) {
    const sec = tEl('div', 'tool-section pt-id');
    sec.dataset.kind = k.id;
    const head = tEl('div', 'tool-section-head');
    let who = 'person';
    const made = tEl('pre', 'tool-out');
    const make = () => {
      made.textContent = Array.from({ length: 5 }, () => k.make(who)).join('\n');
    };
    head.appendChild(tEl('h3', '', k.title));
    if (k.people) head.appendChild(toolSegment([['person', 'Person'], ['company', 'Company']], who, (v) => { who = v; make(); }, 'For'));
    head.append(toolButton('Make 5', make), copyButton(() => made.textContent, k.title));
    const input = toolInput(`Check one: ${k.placeholder}`);
    const result = tEl('span', 'tool-status');
    const row = tEl('div', 'tool-row');
    row.append(input, result);
    input.addEventListener('input', () => {
      result.className = 'tool-status';
      if (!input.value.trim()) {
        result.textContent = '';
        return;
      }
      const r = k.check(input.value);
      result.textContent = `${r.ok ? '✓' : '✗'} ${r.why}`;
      result.classList.add(r.ok ? 'ok' : 'bad');
    });
    sec.append(head, row, made);
    make();
    box.appendChild(sec);
  }
  return { el: box, focus: box.querySelector('input') };
}

// -- the page --
function renderToolsList() {
  const list = $('#toolsList');
  const q = $('#toolsSearch').value.trim().toLowerCase();
  list.textContent = '';
  const shown = TOOLS.filter((t) => !q || `${t.title} ${t.sub} ${t.words}`.toLowerCase().includes(q));
  for (const t of shown) {
    const item = tEl('div', `repo-item tool-item${t.id === currentTool ? ' active' : ''}`);
    item.dataset.tool = t.id;
    item.tabIndex = 0;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(t.id === currentTool));
    const text = tEl('div', 'repo-item-text');
    text.append(tEl('div', 'repo-item-name', t.title), tEl('div', 'tool-item-sub', t.sub));
    item.appendChild(text);
    item.addEventListener('click', () => showTool(t.id));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        showTool(t.id, true);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...list.querySelectorAll('.tool-item')];
        const next = items[items.indexOf(item) + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) next.focus();
      }
    });
    list.appendChild(item);
  }
  if (!shown.length) list.appendChild(tEl('div', 'sidebar-empty', 'No tool matches'));
}

function showTool(id, focus = false) {
  const tool = TOOLS.find((t) => t.id === id) || TOOLS[0];
  currentTool = tool.id;
  try {
    localStorage.setItem(TOOL_KEY, currentTool);
  } catch {
    // only for this session
  }
  const panel = $('#toolPanel');
  if (!builtTools.has(tool.id)) {
    const built = tool.build();
    built.el.dataset.tool = tool.id;
    builtTools.set(tool.id, built);
    panel.appendChild(built.el);
  }
  for (const [tid, b] of builtTools) {
    const on = tid === tool.id && currentMode === 'tools';
    b.el.classList.toggle('hidden', tid !== tool.id);
    if (b.shown) b.shown(on);
  }
  $$('#toolsList .tool-item').forEach((el) => {
    const on = el.dataset.tool === tool.id;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
  });
  if (focus && builtTools.get(tool.id).focus) builtTools.get(tool.id).focus.focus();
  if (currentMode === 'tools') updateCrumb();
}

function setupTools() {
  try {
    const saved = localStorage.getItem(TOOL_KEY);
    if (TOOLS.some((t) => t.id === saved)) currentTool = saved;
  } catch {
    // the first tool
  }
  renderToolsList();
  showTool(currentTool);
  $('#toolsSearch').addEventListener('input', renderToolsList);
  $('#toolsSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('#toolsList .tool-item');
      if (first) showTool(first.dataset.tool, true);
    } else if (e.key === 'Escape' && e.target.value) {
      e.stopPropagation();
      e.target.value = '';
      renderToolsList();
    }
  });
  // a tool with a clock or a list only runs while the page is open
  new MutationObserver(() => showTool(currentTool)).observe($('#toolsView'), { attributes: true, attributeFilter: ['class'] });
}

if (!CARD_ID) setupTools();
