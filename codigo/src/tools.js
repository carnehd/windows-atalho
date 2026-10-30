// Tools page, the parts that need Node: hashes (MD5 is not in the browser), YAML / .properties / JSON conversion,
// the programs listening on a port (and ending one), and copying long or secret text. The rest of the page runs in
// the window (see renderer/tools.js).
const { execFile } = require('child_process');
const crypto = require('crypto');
const { ipcMain, clipboard } = require('electron');
const yaml = require('js-yaml');
const shell = require('./shell');

const MAX_TEXT = 2 * 1024 * 1024;

const text = (value) => {
  const t = String(value ?? '');
  if (t.length > MAX_TEXT) throw new Error('The text is too long (2 MB at most)');
  return t;
};

// -- Hashes --
function hashes(input, key) {
  const data = Buffer.from(text(input), 'utf8');
  const out = {};
  for (const algo of ['md5', 'sha1', 'sha256', 'sha512']) out[algo] = crypto.createHash(algo).update(data).digest('hex');
  out.sha256Base64 = crypto.createHash('sha256').update(data).digest('base64');
  if (key) out.hmac256 = crypto.createHmac('sha256', Buffer.from(text(key), 'utf8')).update(data).digest('hex');
  return out;
}

// -- .properties --
function unescapeProperty(value) {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => {
    if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return { t: '\t', n: '\n', r: '\r', f: '\f' }[c] ?? c;
  });
}

// key=value, key: value or key value; # and ! comments; a line ending in \ goes on. "#---" starts a new document,
// as in Spring Boot.
function parseProperties(source) {
  const docs = [[]];
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^\s+/, '');
    if (/^#---\s*$/.test(line) || /^!---\s*$/.test(line)) {
      docs.push([]);
      continue;
    }
    if (!line || line[0] === '#' || line[0] === '!') continue;
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '');
    const m = /^((?:\\.|[^=:\s\\])+)\s*[=:\s]\s*(.*)$/.exec(line);
    const key = unescapeProperty(m ? m[1] : line);
    docs[docs.length - 1].push([key, m ? unescapeProperty(m[2]) : '']);
  }
  return docs.filter((d, i) => d.length || i === 0).map((pairs) => unflatten(pairs));
}

// "a.b[0].c" -> ['a', 'b', 0, 'c']
function keyPath(key) {
  const parts = [];
  for (const piece of key.split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(piece);
    if (!m) {
      parts.push(piece);
      continue;
    }
    if (m[1]) parts.push(m[1]);
    for (const idx of m[2].match(/\d+/g) || []) parts.push(Number(idx));
  }
  return parts;
}

// Text that looks like a number or a boolean becomes one, so the YAML reads naturally.
function typed(value) {
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(value)) return Number(value);
  if (value === 'true' || value === 'false') return value === 'true';
  return value;
}

function unflatten(pairs) {
  const root = {};
  for (const [key, value] of pairs) {
    const parts = keyPath(key);
    let node = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      if (last) {
        node[part] = typed(value);
        return;
      }
      if (node[part] === null || typeof node[part] !== 'object') node[part] = typeof parts[i + 1] === 'number' ? [] : {};
      node = node[part];
    });
  }
  return root;
}

function escapeProperty(value, isKey) {
  let s = String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  if (isKey) s = s.replace(/([=:\s#!])/g, '\\$1');
  else s = s.replace(/^\s/, (c) => `\\${c}`);
  return s;
}

function flatten(value, prefix, out) {
  if (Array.isArray(value)) {
    if (!value.length && prefix) out.push([prefix, '']);
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value);
    if (!entries.length && prefix) out.push([prefix, '']);
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out.push([prefix, value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value)]);
  }
  return out;
}

function toProperties(docs) {
  return docs.map((doc) => flatten(doc, '', []).map(([k, v]) => `${escapeProperty(k, true)}=${escapeProperty(v, false)}`).join('\n')).join('\n#---\n');
}

// YAML, .properties or JSON to another of them. YAML may hold several documents (---): .properties joins them with
// "#---" (Spring Boot reads both), JSON makes a list of them.
function convertConfig(source, from, to) {
  const input = text(source);
  if (!input.trim()) return '';
  let docs;
  if (from === 'yaml') docs = yaml.loadAll(input).filter((d) => d !== undefined && d !== null);
  else if (from === 'properties') docs = parseProperties(input);
  else if (from === 'json') {
    const value = JSON.parse(input);
    docs = Array.isArray(value) && to !== 'json' && value.every((d) => d && typeof d === 'object' && !Array.isArray(d)) ? value : [value];
  } else throw new Error('Unknown format');
  if (to === 'yaml') return docs.map((d) => yaml.dump(d, { lineWidth: -1, noRefs: true })).join('---\n');
  if (to === 'properties') return `${toProperties(docs)}\n`;
  if (to === 'json') return `${JSON.stringify(docs.length === 1 ? docs[0] : docs, null, 2)}\n`;
  throw new Error('Unknown format');
}

// -- Ports --
function run(file, args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err || (err && typeof err.code === 'number' && stdout), code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: err && err.code === 'ENOENT' });
    });
  });
}

const portOf = (address) => Number(String(address).slice(String(address).lastIndexOf(':') + 1)) || null;

// Every TCP port something listens on (or one port): port, process id, program and its command line.
async function listening(onlyPort) {
  const want = onlyPort ? Number(onlyPort) : null;
  if (want !== null && !(Number.isInteger(want) && want >= 1 && want <= 65535)) throw new Error('A port is a number between 1 and 65535');
  const rows = [];
  if (shell.IS_WIN) {
    const r = await run('netstat', ['-ano', '-p', 'TCP']);
    const r6 = await run('netstat', ['-ano', '-p', 'TCPv6']);
    for (const line of `${r.stdout}\n${r6.stdout}`.split(/\r?\n/)) {
      const m = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
      if (m) rows.push({ port: portOf(m[1]), address: m[1], pid: Number(m[2]) });
    }
    const pids = [...new Set(rows.map((r) => r.pid))].filter((p) => p > 4);
    const names = new Map();
    const list = await run('tasklist', ['/FO', 'CSV', '/NH']);
    for (const line of list.stdout.split(/\r?\n/)) {
      const m = /^"([^"]*)","(\d+)"/.exec(line);
      if (m) names.set(Number(m[2]), m[1]);
    }
    const commands = new Map();
    if (pids.length) {
      const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "${pids.slice(0, 200).map((p) => `ProcessId=${p}`).join(' OR ')}" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`], { timeout: 20000 });
      for (const line of ps.stdout.split(/\r?\n/)) {
        const tab = line.indexOf('\t');
        if (tab > 0) commands.set(Number(line.slice(0, tab)), line.slice(tab + 1).trim());
      }
    }
    for (const r of rows) {
      r.program = names.get(r.pid) || (r.pid === 4 ? 'System' : '');
      r.command = commands.get(r.pid) || '';
    }
  } else {
    const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
    const r = await run(lsof, ['-nP', want ? `-iTCP:${want}` : '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
    if (r.missing) throw new Error('lsof was not found: install it to see the ports in use');
    let pid = 0;
    let program = '';
    for (const line of r.stdout.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1));
      else if (line[0] === 'c') program = line.slice(1);
      else if (line[0] === 'n') rows.push({ port: portOf(line.slice(1)), address: line.slice(1), pid, program });
    }
    const pids = [...new Set(rows.map((x) => x.pid))];
    if (pids.length) {
      const ps = await run('/bin/ps', ['-o', 'pid=,command=', '-p', pids.join(',')]);
      const commands = new Map(ps.stdout.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), m[2]]));
      for (const x of rows) x.command = commands.get(x.pid) || '';
    }
  }
  // one row per port and process (IPv4 and IPv6 count once)
  const seen = new Set();
  return rows
    .filter((x) => x.port && (!want || x.port === want))
    .filter((x) => {
      const k = `${x.port}/${x.pid}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((x) => ({ port: x.port, pid: x.pid, program: x.program || '', command: String(x.command || '').slice(0, 2000), local: /^(127\.0\.0\.1|\[::1\]|localhost)/.test(x.address) }))
    .sort((a, b) => a.port - b.port || a.pid - b.pid);
}

async function endProcess(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 4) throw new Error('Unknown process');
  if (id === process.pid || id === process.ppid) throw new Error('That is Git Quick itself');
  if (shell.IS_WIN) {
    const r = await run('taskkill', ['/PID', String(id), '/T', '/F']);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'It could not be ended');
    return true;
  }
  process.kill(id, 'SIGTERM');
  // still there after 3 seconds: ended for good
  await new Promise((resolve) => setTimeout(resolve, 3000));
  try {
    process.kill(id, 0);
    process.kill(id, 'SIGKILL');
  } catch {
    // gone
  }
  return true;
}

function registerTools({ copySecret }) {
  const call = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      return { error: e.message };
    }
  };
  ipcMain.handle('tools-hash', (_, input, key) => call(() => hashes(input, key ? String(key) : '')));
  ipcMain.handle('tools-config', (_, source, from, to) => call(() => ({ text: convertConfig(source, String(from), String(to)) })));
  ipcMain.handle('tools-ports', (_, port) => call(async () => ({ rows: await listening(port ? String(port).trim() : '') })));
  ipcMain.handle('tools-end-process', (_, pid) => call(async () => ({ success: await endProcess(pid) })));
  ipcMain.handle('tools-copy', (_, value) => call(() => {
    const t = text(value);
    if (!t) throw new Error('Nothing to copy');
    clipboard.writeText(t);
    return { success: true };
  }));
  // a password made here: left out of the clipboard history and cleared after a while, as the Vault does
  ipcMain.handle('tools-copy-secret', (_, value) => call(() => {
    const t = text(value);
    if (!t) throw new Error('Nothing to copy');
    copySecret(t);
    return { success: true };
  }));
}

module.exports = { registerTools, convertConfig, parseProperties, hashes, listening };
