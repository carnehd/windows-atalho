// Messages (Containers page): what goes through a Pub/Sub emulator or a Redis that runs in a container of this computer.
// Only what the engine says the container publishes is reached, on 127.0.0.1; nothing the service uses is changed.
// Pub/Sub keeps nothing for whoever is not subscribed, and a message taken from a subscription of the service would not reach
// the service: so the app makes a subscription of its own for each topic (git-quick-view-<topic>) and reads only those. What
// was published before they exist cannot be seen. Redis is asked over its own protocol, read commands only, and MONITOR
// gives what it receives as it comes. The messages read from Pub/Sub are kept in memory while the app runs.
const http = require('http');
const net = require('net');
const { ipcMain } = require('electron');
const { engineCall, findEngine, listContainers, REF } = require('./containers');
const { call } = require('./new-database');

const VIEW_PREFIX = 'git-quick-view-';
const PROJECT = /^[A-Za-z][A-Za-z0-9-]{0,62}$/;
const DEFAULT_PROJECT = 'local-project';
const MAX_MESSAGES = 2000;
const PULL_MAX = 1000;
const HTTP_TIMEOUT_MS = 8000;
const REDIS_TIMEOUT_MS = 8000;
const MAX_KEYS = 1000;
const MAX_VALUE_BYTES = 200000;
const MAX_ITEMS = 200;
const WATCH_FLUSH_MS = 200;
const WATCH_BATCH = 500;

// A Pub/Sub emulator, as the image of Google's emulators or the name says.
const PUBSUB_IMAGE = /pubsub|pub-sub|(cloud-sdk|google-cloud-cli):.*emulators/i;

async function runningContainer(name) {
  if (!REF.test(String(name))) throw new Error('Unknown container');
  await findEngine();
  const c = (await listContainers()).find((x) => x.name === name);
  if (!c) throw new Error(`There is no container ${name} any more`);
  if (c.state !== 'running') throw new Error(`${name} is not running`);
  return c;
}

function hostPort(c, wanted) {
  const p = c.ports.find((x) => x.container === wanted && x.host) || c.ports.find((x) => x.host);
  if (!p) throw new Error(`${c.name} publishes no port on this computer: it cannot be reached from here`);
  return p.host;
}

// -- Pub/Sub --

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, timeout: HTTP_TIMEOUT_MS, headers: text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {} }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => {
        const said = Buffer.concat(parts).toString('utf8');
        let data = {};
        try {
          data = said.trim() ? JSON.parse(said) : {};
        } catch {
          data = { text: said };
        }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('It did not answer in time')));
    req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? 'The emulator does not answer yet: it may still be starting' : e.message)));
    req.end(text);
  });
}

// The project it was started with: --project=x in its command, else a variable, else the usual one for local work.
async function projectOf(name) {
  try {
    const engine = await engineCall();
    const r = await call(engine.exe, ['inspect', name], engine.env, { timeout: 15000 });
    const [info] = JSON.parse(r.stdout);
    const words = [...((info.Config && info.Config.Cmd) || []), ...((info.Config && info.Config.Entrypoint) || [])].map(String);
    const given = words.flatMap((w) => w.split(/\s+/)).find((w) => /^--project=/.test(w));
    if (given && PROJECT.test(given.slice(10))) return given.slice(10);
    const env = ((info.Config && info.Config.Env) || []).map(String).find((e) => /^(PUBSUB_PROJECT_ID|GOOGLE_CLOUD_PROJECT|GCP_PROJECT_ID)=/.test(e));
    if (env && PROJECT.test(env.split('=')[1])) return env.split('=')[1];
  } catch {
    // the usual one, then
  }
  return DEFAULT_PROJECT;
}

const lastPart = (full) => String(full || '').split('/').pop();

// Its subscriptions for all its topics, made when they are not there: messages published from now on are kept for us.
async function viewersOf(port, project) {
  const api = (method, path, body) => request(port, method, `/v1/projects/${encodeURIComponent(project)}${path}`, body);
  const listed = await api('GET', '/topics?pageSize=1000');
  if (listed.status !== 200) throw new Error(`The emulator said ${listed.status}: ${(listed.data.error && listed.data.error.message) || 'it did not list the topics'}`);
  const topics = (listed.data.topics || []).map((t) => lastPart(t.name));
  const subs = ((await api('GET', '/subscriptions?pageSize=1000')).data.subscriptions || []).map((s) => ({ name: lastPart(s.name), topic: lastPart(s.topic) }));
  const have = new Set(subs.map((s) => s.name));
  await Promise.all(topics.filter((t) => !have.has(`${VIEW_PREFIX}${t}`)).map((t) => api('PUT', `/subscriptions/${encodeURIComponent(`${VIEW_PREFIX}${t}`)}`, { topic: `projects/${project}/topics/${t}` })));
  return { api, topics, subs: subs.filter((s) => !s.name.startsWith(VIEW_PREFIX)) };
}

// Before anything is published (Local setup, once it made the emulator): nothing it publishes then is missed.
async function watchPubsub(name) {
  const c = await runningContainer(name);
  await viewersOf(hostPort(c, 8085), await projectOf(name));
}

function decode(data) {
  const raw = Buffer.from(String(data || ''), 'base64');
  const text = raw.toString('utf8');
  return text.includes('�') ? { text: `(binary, ${raw.length} bytes) ${String(data).slice(0, 2000)}`, binary: true } : { text, binary: false };
}

// -- Redis, over its own protocol: read commands only --

class RedisError extends Error {}

function encode(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

// One reply from at, or null when it has not all come yet: { value, next }.
function parseReply(buf, at = 0) {
  const end = buf.indexOf('\r\n', at);
  if (end < 0) return null;
  const kind = String.fromCharCode(buf[at]);
  const line = buf.toString('utf8', at + 1, end);
  const next = end + 2;
  if (kind === '+') return { value: line, next };
  if (kind === '-') return { value: new RedisError(line), next };
  if (kind === ':') return { value: Number(line), next };
  if (kind === '$') {
    const n = Number(line);
    if (n < 0) return { value: null, next };
    if (buf.length < next + n + 2) return null;
    return { value: buf.subarray(next, next + n), next: next + n + 2 };
  }
  if (kind === '*') {
    const n = Number(line);
    if (n < 0) return { value: null, next };
    const list = [];
    let from = next;
    for (let i = 0; i < n; i++) {
      const item = parseReply(buf, from);
      if (!item) return null;
      list.push(item.value);
      from = item.next;
    }
    return { value: list, next: from };
  }
  throw new Error('Redis answered in a way that was not understood');
}

function openRedis(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const conn = {
      waiting: [],
      buffer: Buffer.alloc(0),
      onPush: null,
      call: (...args) => new Promise((ok, no) => {
        conn.waiting.push({ ok, no });
        socket.write(encode(args));
      }),
      close: () => socket.destroy(),
      // QUIT, and Redis closes it at its side too
      quit: () => {
        socket.end(encode(['QUIT']));
        setTimeout(() => socket.destroy(), 1000).unref();
      },
    };
    const failAll = (e) => conn.waiting.splice(0).forEach((w) => w.no(e));
    socket.setTimeout(REDIS_TIMEOUT_MS);
    socket.once('connect', () => {
      socket.setTimeout(0);
      resolve(conn);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Redis did not answer in time'));
    });
    socket.on('error', (e) => {
      reject(new Error(e.code === 'ECONNREFUSED' ? 'Redis does not answer yet: it may still be starting' : e.message));
      failAll(e);
    });
    socket.on('close', () => {
      failAll(new Error('Redis closed the connection'));
      if (conn.onClose) conn.onClose();
    });
    socket.on('data', (d) => {
      conn.buffer = conn.buffer.length ? Buffer.concat([conn.buffer, d]) : d;
      for (;;) {
        const r = parseReply(conn.buffer);
        if (!r) break;
        conn.buffer = conn.buffer.subarray(r.next);
        const w = conn.waiting.shift();
        if (w) {
          if (r.value instanceof RedisError) w.no(r.value);
          else w.ok(r.value);
        } else if (conn.onPush) conn.onPush(r.value);
      }
    });
  });
}

// As text a person reads: control characters and what is not text, written as \xNN.
function printable(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''));
  const text = buf.toString('utf8');
  const clean = text.includes('�')
    ? [...buf].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`)).join('')
    : text;
  // eslint-disable-next-line no-control-regex
  return clean.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

const pretty = (text) => {
  const t = String(text).trim();
  if (!/^[[{]/.test(t)) return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
};

// A password wrong or missing, in a form the page can ask for it.
function redisProblem(e) {
  const said = String((e && e.message) || e);
  if (/NOAUTH|WRONGPASS|invalid password|AUTH.*without any password/i.test(said)) return { code: 'password', error: /NOAUTH/.test(said) ? 'This Redis asks for a password' : 'Redis did not take that password' };
  return { code: 'failed', error: said };
}

async function connectRedis(port, password) {
  const conn = await openRedis(port);
  try {
    if (password) await conn.call('AUTH', password);
    await conn.call('PING');
  } catch (e) {
    conn.close();
    throw e;
  }
  return conn;
}

function registerContainerMessages({ getWindow }) {
  const kept = new Map(); // container id -> { seq, messages }
  const watches = new Map(); // container name -> { conn, timer, lines, own }
  const send = (event) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('container-messages-event', event);
  };
  const guard = (fn) => async (_, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e && e.code === 'password') return e;
      return { error: String((e && e.message) || e) };
    }
  };

  const keptFor = (c) => {
    if (!kept.has(c.id)) {
      kept.set(c.id, { seq: 0, messages: [] });
      if (kept.size > 5) kept.delete(kept.keys().next().value);
    }
    return kept.get(c.id);
  };

  // What was published since the last time, from our subscriptions only, and what the emulator has.
  ipcMain.handle('messages-pubsub-read', guard(async (name, wantProject, since) => {
    const c = await runningContainer(name);
    const port = hostPort(c, 8085);
    const project = PROJECT.test(String(wantProject || '')) ? String(wantProject) : await projectOf(name);
    const { api, topics, subs } = await viewersOf(port, project);
    const box = keptFor(c);
    await Promise.all(topics.map(async (topic) => {
      const sub = encodeURIComponent(`${VIEW_PREFIX}${topic}`);
      const pulled = await api('POST', `/subscriptions/${sub}:pull`, { maxMessages: PULL_MAX, returnImmediately: true });
      const got = pulled.data.receivedMessages || [];
      if (!got.length) return;
      await api('POST', `/subscriptions/${sub}:acknowledge`, { ackIds: got.map((m) => m.ackId) });
      for (const m of got) {
        const body = m.message || {};
        const { text, binary } = decode(body.data);
        box.messages.push({ seq: ++box.seq, topic, id: String(body.messageId || ''), at: body.publishTime || '', text, binary, attributes: body.attributes || {}, orderingKey: body.orderingKey || '' });
      }
    }));
    if (box.messages.length > MAX_MESSAGES) box.messages.splice(0, box.messages.length - MAX_MESSAGES);
    const from = Number(since) || 0;
    return { port, project, topics, subscriptions: subs, messages: box.messages.filter((m) => m.seq > from), seq: box.seq };
  }));

  const own = (watch, addr) => {
    if (watch && addr) watch.own.add(addr);
  };

  // A short connection for a read, with its own address taken out of what MONITOR shows.
  const withRedis = async (name, password, db, fn) => {
    const c = await runningContainer(name);
    const conn = await connectRedis(hostPort(c, 6379), password);
    try {
      const info = await conn.call('CLIENT', 'INFO').catch(() => null);
      const addr = info ? (/addr=(\S+)/.exec(printable(info)) || [])[1] : '';
      own(watches.get(name), addr);
      if (Number(db) > 0) await conn.call('SELECT', Number(db));
      return await fn(conn, c);
    } finally {
      conn.close();
    }
  };
  const redisGuard = (fn) => guard(async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      throw redisProblem(e);
    }
  });

  // Its databases with keys, and the first ones of the one chosen, with the type and the time left of each.
  ipcMain.handle('messages-redis-keys', redisGuard((name, input) => {
    const { password = '', db = 0, match = '*' } = input && typeof input === 'object' ? input : {};
    return withRedis(name, password, db, async (conn, c) => {
      const info = printable(await conn.call('INFO', 'keyspace'));
      const dbs = [...info.matchAll(/^db(\d+):keys=(\d+)/gm)].map((m) => ({ db: Number(m[1]), keys: Number(m[2]) }));
      const raw = [];
      let cursor = '0';
      do {
        const [next, part] = await conn.call('SCAN', cursor, 'MATCH', String(match || '*').slice(0, 300), 'COUNT', 500);
        cursor = printable(next);
        raw.push(...part);
      } while (cursor !== '0' && raw.length < MAX_KEYS);
      const list = raw.slice(0, MAX_KEYS);
      const types = await Promise.all(list.map((k) => conn.call('TYPE', k)));
      const ttls = await Promise.all(list.map((k) => conn.call('PTTL', k)));
      const keys = list.map((k, i) => ({ key: printable(k), raw: k.toString('base64'), type: printable(types[i]), ttlMs: Number(ttls[i]) })).sort((a, b) => a.key.localeCompare(b.key));
      return { port: hostPort(c, 6379), dbs, keys, more: cursor !== '0' };
    });
  }));

  // What one key holds. Read commands only, and no more than a person can read.
  ipcMain.handle('messages-redis-value', redisGuard((name, input) => {
    const { password = '', db = 0, raw = '', type = '' } = input && typeof input === 'object' ? input : {};
    const key = Buffer.from(String(raw), 'base64');
    return withRedis(name, password, db, async (conn) => {
      const lines = (pairs) => pairs.join('\n');
      switch (String(type)) {
        case 'string': {
          const size = Number(await conn.call('STRLEN', key));
          const part = await conn.call('GETRANGE', key, 0, MAX_VALUE_BYTES - 1);
          return { text: pretty(printable(part)), total: size, shown: Math.min(size, MAX_VALUE_BYTES), unit: 'bytes' };
        }
        case 'hash': {
          const total = Number(await conn.call('HLEN', key));
          const [, items] = await conn.call('HSCAN', key, 0, 'COUNT', MAX_ITEMS);
          const out = [];
          for (let i = 0; i < items.length; i += 2) out.push(`${printable(items[i])} = ${printable(items[i + 1])}`);
          return { text: lines(out), total, shown: out.length, unit: 'fields' };
        }
        case 'list': {
          const total = Number(await conn.call('LLEN', key));
          const items = await conn.call('LRANGE', key, 0, MAX_ITEMS - 1);
          return { text: lines(items.map(printable)), total, shown: items.length, unit: 'items' };
        }
        case 'set': {
          const total = Number(await conn.call('SCARD', key));
          const [, items] = await conn.call('SSCAN', key, 0, 'COUNT', MAX_ITEMS);
          return { text: lines(items.map(printable)), total, shown: items.length, unit: 'members' };
        }
        case 'zset': {
          const total = Number(await conn.call('ZCARD', key));
          const items = await conn.call('ZRANGE', key, 0, MAX_ITEMS - 1, 'WITHSCORES');
          const out = [];
          for (let i = 0; i < items.length; i += 2) out.push(`${printable(items[i + 1])}  ${printable(items[i])}`);
          return { text: lines(out), total, shown: out.length, unit: 'members' };
        }
        case 'stream': {
          const total = Number(await conn.call('XLEN', key));
          const items = await conn.call('XREVRANGE', key, '+', '-', 'COUNT', MAX_ITEMS);
          const out = items.map(([id, fields]) => {
            const pairs = [];
            for (let i = 0; i < fields.length; i += 2) pairs.push(`${printable(fields[i])}=${printable(fields[i + 1])}`);
            return `${printable(id)}  ${pairs.join(' ')}`;
          });
          return { text: lines(out), total, shown: out.length, unit: 'entries' };
        }
        default:
          return { text: '', total: 0, shown: 0, unit: '', gone: true };
      }
    });
  }));

  const stopWatch = (name) => {
    const w = watches.get(name);
    if (!w) return;
    watches.delete(name);
    clearInterval(w.timer);
    w.conn.onClose = null;
    w.conn.quit();
  };

  // MONITOR: all that Redis receives, as it comes, without what this page asks. In batches, so a busy one does not flood the page.
  ipcMain.handle('messages-redis-watch', redisGuard(async (name, password) => {
    stopWatch(name);
    const c = await runningContainer(name);
    const conn = await connectRedis(hostPort(c, 6379), password);
    const watch = { conn, lines: [], own: new Set(), timer: null };
    watches.set(name, watch);
    await conn.call('MONITOR');
    conn.onPush = (value) => {
      const m = /^(\d+\.\d+) \[(\d+) ([^\]]*)\] (.*)$/s.exec(typeof value === 'string' ? value : printable(value));
      if (m) watch.lines.push({ time: Number(m[1]) * 1000, db: Number(m[2]), client: m[3], text: m[4] });
    };
    conn.onClose = () => {
      if (watches.get(name) === watch) {
        stopWatch(name);
        send({ name, type: 'ended' });
      }
    };
    watch.timer = setInterval(() => {
      if (!watch.lines.length) return;
      // by now the address of a read of ours is known, even if its first command came before it
      const taken = watch.lines.splice(0).filter((l) => !watch.own.has(l.client));
      const dropped = Math.max(0, taken.length - WATCH_BATCH);
      if (taken.length) send({ name, type: 'lines', lines: taken.slice(-WATCH_BATCH), dropped });
    }, WATCH_FLUSH_MS);
    return { success: true, port: hostPort(c, 6379) };
  }));

  ipcMain.handle('messages-redis-unwatch', guard((name) => {
    stopWatch(name);
    return { success: true };
  }));

  return { stopAll: () => [...watches.keys()].forEach(stopWatch) };
}

module.exports = { registerContainerMessages, watchPubsub, parseReply, encode, printable, pretty, decode, PUBSUB_IMAGE, VIEW_PREFIX };
