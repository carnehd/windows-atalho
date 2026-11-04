// Calls between microservices, for the Analysis page: who calls whom among the microservices of the list, on a map.
// Two sources. Their configuration: the URLs of their local application files, their Feign clients and the Kafka
// topics of their code, matched to the microservice that listens on that port or has that name. And, while watching,
// the TCP connections their running processes open, on this computer (lsof, netstat) and inside their containers
// (/proc/net/tcp through docker or podman): a connection to a port another one listens on is a call to it. Nothing is
// installed, and nothing in the microservices changes.
const { execFile } = require('child_process');
const dns = require('dns');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcMain } = require('electron');
const shell = require('./shell');
const envValues = require('./env-values');
const containers = require('./containers');

const IS_WIN = process.platform === 'win32';
const TICK_MS = 3000;
const MAX_WATCH_MS = 60 * 60 * 1000; // watching stops by itself after an hour
const MAX_IDS = 5000; // connections counted per arrow
const JAVA_LIMITS = { files: 3000, total: 20000, size: 400 * 1024 };

// -- configuration --

// keys whose URLs are not calls to another service: the service's own, its docs, its logging
const SKIP_KEYS = /^(server\.|management\.|springdoc\.|spring\.application\.|logging\.|info\.|spring\.config\.|spring\.profiles\.|spring\.devtools\.)/i;
const SCHEME_PORTS = { http: 80, https: 443, postgresql: 5432, mysql: 3306, mariadb: 3306, sqlserver: 1433, mongodb: 27017, redis: 6379, rediss: 6380, amqp: 5672, amqps: 5671, kafka: 9092, ldap: 389, ldaps: 636 };
const SCHEME_KINDS = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', oracle: 'Oracle', sqlserver: 'SQL Server', mongodb: 'MongoDB', redis: 'Redis', rediss: 'Redis', amqp: 'RabbitMQ', amqps: 'RabbitMQ', kafka: 'Kafka' };
// what usually listens on a port, for a name when nothing else says
const PORT_KINDS = { 5432: 'PostgreSQL', 3306: 'MySQL', 1521: 'Oracle', 1433: 'SQL Server', 27017: 'MongoDB', 6379: 'Redis', 5672: 'RabbitMQ', 9092: 'Kafka', 9093: 'Kafka', 29092: 'Kafka', 2181: 'ZooKeeper', 8761: 'Eureka', 9200: 'Elasticsearch', 8500: 'Consul' };
// and what an image is
const IMAGE_KINDS = [[/postgres/i, 'PostgreSQL'], [/mysql/i, 'MySQL'], [/mariadb/i, 'MariaDB'], [/oracle|gvenzl/i, 'Oracle'], [/mssql|sqlserver/i, 'SQL Server'], [/mongo/i, 'MongoDB'], [/redis|valkey/i, 'Redis'], [/rabbitmq/i, 'RabbitMQ'], [/kafka|redpanda|confluentinc\/cp-server/i, 'Kafka'], [/zookeeper/i, 'ZooKeeper'], [/keycloak/i, 'Keycloak'], [/elasticsearch|opensearch/i, 'Elasticsearch'], [/wiremock/i, 'WireMock'], [/localstack/i, 'LocalStack']];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal', 'host.containers.internal', 'gateway.docker.internal']);

// The addresses in a value: URLs (http, jdbc:..., mongodb://...) and, for a key that holds brokers, a host:port list.
// [{ scheme, host, port }]
function addressesIn(key, value) {
  const text = String(value || '');
  const out = [];
  for (const m of text.matchAll(/jdbc:oracle:thin:@(?:\/\/)?([\w.-]+):(\d+)/gi)) out.push({ scheme: 'oracle', host: m[1].toLowerCase(), port: Number(m[2]) });
  for (const m of text.matchAll(/(?:jdbc:)?([a-z][a-z0-9+.-]*):\/\/(?:[^@/\s,;]*@)?(\[[0-9a-f:]+\]|[\w.-]+)(?::(\d{1,5}))?/gi)) {
    const scheme = m[1].toLowerCase();
    if (!(scheme in SCHEME_PORTS) && !m[3]) continue;
    if (['file', 'classpath', 'jar'].includes(scheme)) continue;
    const port = m[3] ? Number(m[3]) : SCHEME_PORTS[scheme];
    if (port) out.push({ scheme, host: m[2].replace(/^\[|\]$/g, '').toLowerCase(), port });
  }
  if (!out.length && /(bootstrap[-.]?servers|brokers|addresses)$/i.test(key)) {
    const scheme = /rabbit/i.test(key) ? 'amqp' : 'kafka';
    for (const part of text.split(',')) {
      const m = /^\s*([\w.-]+):(\d{1,5})\s*$/.exec(part);
      if (m) out.push({ scheme, host: m[1].toLowerCase(), port: Number(m[2]) });
    }
  }
  return out;
}

// ${key} and ${key:default} of a value, from the other keys (a few levels deep); unknown ones take their default.
function resolveValue(value, props, depth = 0) {
  return String(value).replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (m, k, def) => {
    if (depth < 5 && props.has(k.trim())) return resolveValue(props.get(k.trim()), props, depth + 1);
    return def !== undefined ? def : m;
  });
}

// A short name from the key a URL is in: catalog.environment.pricing-url -> pricing.
function nameFromKey(key) {
  const parts = String(key).split('.').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].replace(/\[\d+\]$/, '').replace(/[-_]?(base[-_]?)?(url|uri|host|address|endpoint|servers?)$/i, '');
    if (p && !/^(url|uri|host|base|address|endpoint|servers?|bootstrap|datasource|spring|client|api|services?)$/i.test(p)) return p;
  }
  return '';
}

// The Java (and Kotlin) files of a service's own code, as many as the limits let in.
async function codeFiles(dir, budget) {
  const out = [];
  const walk = async (d, depth) => {
    if (depth > 20 || out.length >= JAVA_LIMITS.files || budget.left <= 0) return;
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= JAVA_LIMITS.files || budget.left <= 0) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (/\.(java|kt)$/.test(e.name)) {
        out.push(p);
        budget.left--;
      }
    }
  };
  for (const lang of ['java', 'kotlin']) await walk(path.join(dir, 'src', 'main', lang), 0);
  return out;
}

const strings = (text) => [...String(text).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
// an attribute of an annotation: name = "x", name = {"a", "b"}, name = CONSTANT, name = {A, B}
function attr(body, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(\\{[^}]*\\}|"(?:[^"\\\\]|\\\\.)*"|[\\w.]+)`).exec(body);
  if (!m) return null;
  const v = m[1];
  if (v[0] === '"') return strings(v);
  if (v[0] === '{') return [...strings(v), ...[...v.matchAll(/(?:^|[{,\s])([A-Za-z_][\w.]*)(?=\s*[,}])/g)].map((x) => `#${x[1]}`)];
  return [`#${v}`];
}

// What a file of code says it calls: Feign clients, Kafka topics it listens to or sends to, local URLs written in it.
// Constants and @Value fields of the file are followed to their text or key.
function callsInCode(text, file) {
  const out = { feign: [], consumes: [], produces: [], urls: [] };
  if (!/FeignClient|KafkaListener|\.send\s*\(|ProducerRecord|https?:\/\/(localhost|127\.0\.0\.1|host\.)/.test(text)) return out;
  const kafka = /kafka/i.test(text);
  const consts = new Map();
  for (const m of text.matchAll(/\b(?:val|String)\s+([A-Za-z_]\w*)\s*(?::\s*String\s*)?=\s*"((?:[^"\\]|\\.)*)"/g)) consts.set(m[1], m[2]);
  for (const m of text.matchAll(/@Value\(\s*"\$\{([^}:]+)(?::[^}]*)?\}"\s*\)\s*(?:(?:private|protected|public|final|lateinit|var|val)\s+)*(?:String\s+)?([A-Za-z_]\w*)/g)) consts.set(m[2], `\${${m[1]}}`);
  const value = (v) => {
    if (!v.startsWith('#')) return v;
    const name = v.slice(1).split('.').pop();
    return consts.has(name) ? consts.get(name) : null;
  };
  const where = path.basename(file);
  for (const m of text.matchAll(/@FeignClient\s*\(([^)]*)\)/g)) {
    const body = m[1];
    const name = (attr(body, 'name') || attr(body, 'value') || (/^\s*"/.test(body) ? strings(body).slice(0, 1) : []) || []).map(value).filter(Boolean)[0] || '';
    const url = (attr(body, 'url') || []).map(value).filter(Boolean)[0] || '';
    if (name || url) out.feign.push({ name, url, where });
  }
  for (const m of text.matchAll(/@KafkaListener\s*\(([^)]*)\)/g)) {
    for (const t of (attr(m[1], 'topics') || []).map(value).filter(Boolean)) out.consumes.push({ topic: t, where });
  }
  // what is sent, in a file that has to do with Kafka (a send of mail or of a websocket is something else)
  if (kafka) {
    for (const m of text.matchAll(/(?:\.send(?:Default)?|new\s+ProducerRecord\s*(?:<[^>]*>)?)\s*\(\s*("(?:[^"\\]|\\.)*"|[A-Za-z_][\w.]*)\s*,/g)) {
      const t = m[1][0] === '"' ? m[1].slice(1, -1) : value(`#${m[1]}`);
      if (t) out.produces.push({ topic: t, where });
    }
  }
  // a URL written in the code, but not in the API's documentation (its own address as the server of its OpenAPI)
  if (!/io\.swagger|org\.springdoc|@OpenAPIDefinition/.test(text)) {
    for (const m of text.matchAll(/"(https?:\/\/(?:localhost|127\.0\.0\.1|host\.docker\.internal|host\.containers\.internal):\d{1,5}[^"]*)"/g)) out.urls.push({ url: m[1], where });
  }
  return out;
}

// What one service's configuration and code say: its port and name, the addresses it is set to call (with the key or
// file that says so), the Feign clients by name, the topics it sends to and listens to, and its Kafka brokers.
async function readServiceConfig(dir, budget) {
  const ev = envValues.readEnvValues(dir);
  const props = new Map();
  for (const k of ev.keys) {
    const v = ev.values[k].local;
    if (v !== undefined) props.set(k, v);
  }
  const get = (k) => (props.has(k) ? resolveValue(props.get(k), props) : '');
  const port = Number(get('server.port')) || null;
  const appName = get('spring.application.name');
  const calls = [];
  const brokers = [];
  const topics = { produces: [], consumes: [] };
  const fileOf = ev.files.find((f) => f.env === 'local');
  const file = fileOf ? fileOf.file : 'application.properties';
  for (const [key] of props) {
    const m = /^spring\.cloud\.stream\.bindings\.(.+)\.destination$/.exec(key);
    if (m) {
      for (const t of get(key).split(',').map((x) => x.trim()).filter(Boolean)) (/-out-\d+$|output/i.test(m[1]) ? topics.produces : topics.consumes).push({ topic: t, why: `${key} in ${file}` });
      continue;
    }
    if (SKIP_KEYS.test(key)) continue;
    const value = get(key);
    for (const a of addressesIn(key, value)) {
      if (/kafka/i.test(key) || a.scheme === 'kafka') brokers.push({ ...a, scheme: 'kafka', why: `${key} in ${file}` });
      else calls.push({ ...a, name: nameFromKey(key), why: `${key} in ${file}` });
    }
  }
  const feign = [];
  const files = await codeFiles(dir, budget);
  for (const f of files) {
    let text;
    try {
      const st = await fs.promises.stat(f);
      if (st.size > JAVA_LIMITS.size) continue;
      text = await fs.promises.readFile(f, 'utf8');
    } catch {
      continue;
    }
    const found = callsInCode(text, f);
    for (const x of found.feign) {
      const url = x.url ? resolveValue(x.url, props) : '';
      const a = url ? addressesIn('', url)[0] : null;
      if (a) calls.push({ ...a, name: x.name || '', why: `@FeignClient in ${x.where}` });
      else if (x.name) feign.push({ name: resolveValue(x.name, props), why: `@FeignClient in ${x.where}` });
    }
    for (const x of found.consumes) topics.consumes.push({ topic: resolveValue(x.topic, props), why: `@KafkaListener in ${x.where}` });
    for (const x of found.produces) topics.produces.push({ topic: resolveValue(x.topic, props), why: `send in ${x.where}` });
    for (const x of found.urls) for (const a of addressesIn('', x.url)) calls.push({ ...a, name: '', why: `a URL in ${x.where}` });
  }
  // a Kafka topic is letters, digits, . _ and - (a key not found, or a path, is not one)
  const clean = (list) => list.filter((t) => /^[\w.-]{1,249}$/.test(t.topic || ''));
  return { port, appName, calls, feign, brokers, topics: { produces: clean(topics.produces), consumes: clean(topics.consumes) } };
}

// -- the network --

function run(file, args, { timeout = 15000, env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...(env ? { env } : {}) }, (err, stdout) => {
      resolve({ ok: !err || Boolean(stdout), missing: Boolean(err && err.code === 'ENOENT'), stdout: String(stdout || '') });
    });
  });
}

// "127.0.0.1:8081", "[::1]:8081", "*:8081" -> { ip, port }
function splitAddress(text) {
  const s = String(text).trim();
  const i = s.lastIndexOf(':');
  if (i <= 0) return null;
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port)) return null;
  return { ip: s.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase(), port };
}

// lsof -nP -iTCP -sTCP:LISTEN,ESTABLISHED -FpcnT: the ports listened on and the open connections, with their process.
function parseLsof(text) {
  const listen = [];
  const conns = [];
  const programs = new Map();
  let pid = 0;
  let name = null;
  const flush = (state) => {
    if (!name) return;
    if (state === 'LISTEN') {
      const a = splitAddress(name);
      if (a) listen.push({ pid, port: a.port });
    } else if (state === 'ESTABLISHED' && name.includes('->')) {
      const [l, r] = name.split('->').map(splitAddress);
      if (l && r) conns.push({ pid, local: l, remote: r });
    }
    name = null;
  };
  for (const line of String(text).split('\n')) {
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === 'p') {
      pid = Number(rest);
      name = null;
    } else if (tag === 'c') programs.set(pid, rest);
    else if (tag === 'n') name = rest;
    else if (tag === 'T' && rest.startsWith('ST=')) flush(rest.slice(3));
  }
  return { listen, conns, programs };
}

// netstat -ano: "TCP 127.0.0.1:53422 127.0.0.1:8081 ESTABLISHED 1234" and "TCP 0.0.0.0:8081 0.0.0.0:0 LISTENING 1234"
function parseNetstat(text) {
  const listen = [];
  const conns = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+)\s+(\S+)\s+(LISTENING|ESTABLISHED)\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const pid = Number(m[4]);
    const l = splitAddress(m[1]);
    if (!l) continue;
    if (/^LISTENING$/i.test(m[3])) listen.push({ pid, port: l.port });
    else {
      const r = splitAddress(m[2]);
      if (r) conns.push({ pid, local: l, remote: r });
    }
  }
  return { listen, conns, programs: new Map() };
}

// /proc/net/tcp and tcp6 of a container (with its /etc/hosts and /proc/net/route after them, read in one go): its
// listening ports, its open connections, and the addresses it reaches this computer by.
const hexIp4 = (h) => [h.slice(6, 8), h.slice(4, 6), h.slice(2, 4), h.slice(0, 2)].map((x) => parseInt(x, 16)).join('.');
function hexIp(h) {
  if (h.length === 8) return hexIp4(h);
  // IPv6, four 32-bit words each little-endian; an IPv4 one inside it (::ffff:a.b.c.d) as IPv4
  const words = [0, 8, 16, 24].map((i) => h.slice(i, i + 8)).map((w) => [w.slice(6, 8), w.slice(4, 6), w.slice(2, 4), w.slice(0, 2)].join(''));
  const full = words.join('').toLowerCase();
  if (/^0{20}ffff/.test(full)) return hexIp4(h.slice(24, 32));
  if (/^0{31}1$/.test(full)) return '::1';
  return full.match(/.{4}/g).map((x) => x.replace(/^0+(?=.)/, '')).join(':');
}
function parseProcNet(text) {
  const listen = new Set();
  const conns = [];
  const hostIps = new Set();
  for (const line of String(text).split('\n')) {
    let m = /^\s*\d+:\s+([0-9A-F]+):([0-9A-F]{4})\s+([0-9A-F]+):([0-9A-F]{4})\s+([0-9A-F]{2})\s/i.exec(line);
    if (m) {
      const lport = parseInt(m[2], 16);
      if (m[5] === '0A') listen.add(lport);
      else if (m[5] === '01') conns.push({ local: { ip: hexIp(m[1]), port: lport }, remote: { ip: hexIp(m[3]), port: parseInt(m[4], 16) } });
      continue;
    }
    m = /^\s*(\d+\.\d+\.\d+\.\d+)\s+.*\b(host\.containers\.internal|host\.docker\.internal)\b/.exec(line);
    if (m) {
      hostIps.add(m[1]);
      continue;
    }
    // the default route: its gateway is this computer (or the machine the engine runs in)
    m = /^\S+\s+00000000\s+([0-9A-F]{8})\s/i.exec(line);
    if (m && m[1] !== '00000000') hostIps.add(hexIp4(m[1]));
  }
  return { listen, conns, hostIps };
}

const isLoopback = (ip) => /^127\./.test(ip) || ip === '::1' || ip === '0.0.0.0' || ip === '::';
function ownAddresses() {
  const out = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) out.add(String(a.address).toLowerCase().replace(/%.*$/, ''));
  return out;
}
// the usual addresses a container reaches the computer by, besides what its /etc/hosts and routes say
const ENGINE_HOST_IPS = ['192.168.65.254', '192.168.127.254', '169.254.1.2', '10.0.2.2', '10.88.0.1'];

// A path as a container's mounts show it, as this computer has it (Podman on Windows: /mnt/c/...; Docker Desktop:
// /run/desktop/mnt/host/c/...).
function hostPath(source) {
  const s = String(source || '');
  const m = /^(?:\/run\/desktop\/mnt\/host|\/mnt)\/([a-z])\/(.*)$/i.exec(s);
  if (m && IS_WIN) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
  return s;
}
const pathKey = (p) => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
// whether a command line or a path is in the folder
function inFolder(text, folder) {
  const hay = IS_WIN ? String(text).toLowerCase().replace(/\//g, '\\') : String(text);
  const dir = pathKey(folder);
  return hay.includes(dir + path.sep) || hay.endsWith(dir) || hay.includes(`${dir}"`) || hay.includes(`${dir} `);
}
// The classes a java command line names (com.example.catalog.CatalogApplication): its main class among them.
function classesIn(command) {
  return [...String(command).matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]).filter((t) => /^[a-zA-Z_][\w$]*(\.[a-zA-Z_][\w$]*)*\.[A-Z][\w$]*$/.test(t));
}
// The microservice whose code has a class: a java process started with its classpath in a file of its own (Windows
// does that when it is long: spring-boot:run, IntelliJ) has no folder in its command line, but its main class.
function serviceOfClass(command, list) {
  const found = new Set();
  for (const cls of classesIn(command)) {
    const rel = cls.split('.');
    for (const s of list) {
      if (['java', 'kotlin'].some((lang) => ['.java', '.kt'].some((ext) => fs.existsSync(`${path.join(s.dir, 'src', 'main', lang, ...rel)}${ext}`)))) found.add(s);
    }
    if (found.size) break;
  }
  // two of the list with the same class (copies of one service): not known which
  return found.size === 1 ? [...found][0] : null;
}
const MAVEN_LAUNCHER = /org\.codehaus\.plexus\.classworlds|maven-wrapper|MavenWrapperMain/;
// the programs of Docker, Podman and WSL that carry a container's connections to this computer: the container's call,
// not one of their own
const ENGINE_RELAY = /^(com\.docke|com\.docker|docker|vpnkit|gvproxy|wslrelay|slirp4netns|pasta|rootlessport|qemu|krunkit|vfkit|podman|conmon)/i;
const isJava = (program, command) => /^javaw?(\.exe)?$/i.test(program || '') || /(^|[\\/"\s])javaw?(\.exe)?["\s]/i.test(` ${command || ''} `);
// What a program that calls a microservice is, for its name on the map.
function clientName(program, command) {
  const all = `${program || ''} ${command || ''}`;
  if (/bruno/i.test(all)) return 'Bruno';
  if (/postman/i.test(all)) return 'Postman';
  if (/insomnia/i.test(all)) return 'Insomnia';
  if (/^curl(\.exe)?$/i.test(program || '')) return 'curl';
  if (/chrome|firefox|safari|msedge|brave|opera|vivaldi/i.test(all)) return 'Browser';
  if (/git[ -]?quick/i.test(all)) return 'Git Quick';
  if (/idea|intellij/i.test(all)) return 'IntelliJ';
  if (/^javaw?(\.exe)?$/i.test(program || '')) return 'A Java program';
  return String(program || 'A program').replace(/\.exe$/i, '');
}
// how a java process was started, from its command line
function startedBy(command) {
  if (/idea_rt\.jar|-Didea\./.test(command)) return 'from IntelliJ';
  if (/\s-jar\s/.test(command)) return 'java -jar';
  if (/target[\\/]classes/.test(command)) return 'spring-boot:run';
  return 'java';
}

// -- the map --

function registerServiceMap({ listRepos, loadDir }) {
  // the microservices of the list: a name and the folder their code is in (the Maven page's folder when chosen)
  const services = () => listRepos().map((r) => {
    const rel = loadDir ? String(loadDir(r.path) || '') : '';
    const dir = rel ? path.resolve(r.path, rel) : r.path;
    return { id: `svc:${pathKey(r.path)}`, name: r.name, repo: r.path, dir: fs.existsSync(dir) ? dir : r.path };
  }).filter((s) => fs.existsSync(path.join(s.dir, 'pom.xml')) || fs.existsSync(path.join(s.dir, 'build.gradle')) || fs.existsSync(path.join(s.dir, 'build.gradle.kts')) || fs.existsSync(path.join(s.dir, 'src', 'main', 'resources')));

  let config = null; // { at, key, list: [{ service, cfg }] }
  let reading = null;
  // read once, and again when asked or when the list (or a folder chosen on the Maven page) changes
  async function readConfig(force = false) {
    const now = services();
    const key = now.map((s) => `${s.id}>${s.dir}`).join('\n');
    if (config && !force && config.key === key) return config;
    if (reading) return reading;
    reading = (async () => {
      const budget = { left: JAVA_LIMITS.total };
      const list = [];
      for (const s of now) {
        try {
          list.push({ service: s, cfg: await readServiceConfig(s.dir, budget) });
        } catch {
          list.push({ service: s, cfg: { port: null, appName: '', calls: [], feign: [], brokers: [], topics: { produces: [], consumes: [] } } });
        }
      }
      config = { at: Date.now(), key, list };
      reading = null;
      // the processes are matched to the microservices again
      for (const p of watch.commands.values()) delete p.service;
      return config;
    })();
    return reading;
  }

  // what watching has seen
  const watch = { on: false, since: 0, until: 0, stoppedBy: '', samples: 0, timer: null, busy: false, notes: [], edges: new Map(), commands: new Map(), inspected: new Map(), engine: null, engineAt: 0, last: null };

  async function engine() {
    if (watch.engine !== null && Date.now() - watch.engineAt < 30000) return watch.engine;
    watch.engineAt = Date.now();
    try {
      watch.engine = await containers.engineCall();
    } catch (e) {
      watch.engine = { error: e.message };
    }
    return watch.engine;
  }

  // the sockets of this computer, and the command line of each process that has one (asked once per process)
  async function hostSockets() {
    let socks;
    if (IS_WIN) {
      const [a, b] = await Promise.all([run('netstat', ['-ano', '-p', 'TCP']), run('netstat', ['-ano', '-p', 'TCPv6'])]);
      socks = parseNetstat(`${a.stdout}\n${b.stdout}`);
      const unknown = [...new Set([...socks.listen, ...socks.conns].map((x) => x.pid))].filter((p) => p > 4 && !watch.commands.has(p));
      if (unknown.length) {
        const names = new Map();
        const list = await run('tasklist', ['/FO', 'CSV', '/NH']);
        for (const line of list.stdout.split(/\r?\n/)) {
          const m = /^"([^"]*)","(\d+)"/.exec(line);
          if (m) names.set(Number(m[2]), m[1]);
        }
        // the command lines of the Java ones, and of those with a connection on this computer (a client of one),
        // only: asking Windows for them is slow
        const local = new Set(socks.conns.filter((c) => isLoopback(c.remote.ip)).map((c) => c.pid));
        const javas = unknown.filter((p) => /^javaw?\.exe$/i.test(names.get(p) || '') || local.has(p));
        const commands = new Map();
        for (let i = 0; i < javas.length; i += 100) {
          const part = javas.slice(i, i + 100);
          const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "${part.map((p) => `ProcessId=${p}`).join(' OR ')}" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`], { timeout: 20000 });
          for (const line of ps.stdout.split(/\r?\n/)) {
            const tab = line.indexOf('\t');
            if (tab > 0) commands.set(Number(line.slice(0, tab)), line.slice(tab + 1).trim());
          }
        }
        for (const p of unknown) watch.commands.set(p, { program: names.get(p) || '', command: commands.get(p) || '' });
      }
    } else {
      const r = await run(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN,ESTABLISHED', '-FpcnT']);
      if (r.missing) throw new Error('lsof was not found: install it to see the connections');
      socks = parseLsof(r.stdout);
      const unknown = [...socks.programs.keys()].filter((p) => !watch.commands.has(p));
      if (unknown.length) {
        const ps = await run('/bin/ps', ['-ww', '-o', 'pid=,command=', '-p', unknown.join(',')]);
        const commands = new Map(ps.stdout.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), m[2]]));
        for (const p of unknown) watch.commands.set(p, { program: socks.programs.get(p) || '', command: commands.get(p) || '' });
      }
    }
    return socks;
  }

  // the running containers: their published ports, their addresses, and the microservice each one is (by the folder
  // it mounts, as Start in container does, or by its name)
  async function runningContainers(list) {
    const e = await engine();
    if (!e || e.error) return { error: e ? e.error : 'No container engine', rows: [] };
    const podman = e.name === 'podman';
    const r = await run(e.exe, podman ? ['ps', '--format', 'json'] : ['ps', '--no-trunc', '--format', '{{json .}}'], { env: e.env, timeout: 15000 });
    let raw = [];
    try {
      raw = podman ? JSON.parse(r.stdout.trim() || '[]') : r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return { error: `${e.label} did not answer as expected`, rows: [] };
    }
    const rows = raw.filter((c) => !c.IsInfra).map(containers.containerRow).filter((c) => c.state === 'running');
    const fresh = rows.filter((c) => !watch.inspected.has(c.id));
    if (fresh.length) {
      const ins = await run(e.exe, ['inspect', ...fresh.map((c) => c.id)], { env: e.env, timeout: 20000 });
      let docs = [];
      try {
        docs = JSON.parse(ins.stdout || '[]');
      } catch {
        docs = [];
      }
      for (const c of fresh) {
        const d = docs.find((x) => String(x.Id || x.ID || '').startsWith(c.id) || c.id.startsWith(String(x.Id || '')));
        const ips = new Set();
        const ns = (d && d.NetworkSettings) || {};
        if (ns.IPAddress) ips.add(ns.IPAddress);
        for (const n of Object.values(ns.Networks || {})) if (n && n.IPAddress) ips.add(n.IPAddress);
        const mounts = ((d && d.Mounts) || []).map((m) => hostPath(m.Source || m.source || ''));
        const image = String((d && d.Config && d.Config.Image) || c.image || '');
        watch.inspected.set(c.id, { ips: [...ips], mounts, image });
      }
    }
    const byName = (n) => list.find((s) => [s.name, path.basename(s.repo), path.basename(s.dir), s.appName].filter(Boolean).some((x) => String(x).toLowerCase() === String(n).toLowerCase()));
    return {
      engine: e,
      rows: rows.map((c) => {
        const info = watch.inspected.get(c.id) || { ips: [], mounts: [], image: c.image };
        const service = list.find((s) => info.mounts.some((m) => inFolder(m, s.dir) || inFolder(m, s.repo))) || byName(c.name) || (c.service ? byName(c.service) : null) || null;
        const kind = (IMAGE_KINDS.find(([re]) => re.test(info.image || c.image || '')) || [])[1] || '';
        return { id: c.id, name: c.name, ports: c.ports, ips: info.ips, image: info.image || c.image, service, kind };
      }),
    };
  }

  // the sockets inside a container: what it opened, and how it reaches this computer
  async function containerSockets(e, c) {
    const r = await run(e.exe, ['exec', c.id, 'cat', '/proc/net/tcp', '/proc/net/tcp6', '/etc/hosts', '/proc/net/route'], { env: e.env, timeout: 8000 });
    return parseProcNet(r.stdout);
  }

  const add = (from, to, id, via) => {
    if (!from || !to || from === to) return;
    const k = `${from}|${to}`;
    let edge = watch.edges.get(k);
    if (!edge) {
      edge = { from, to, ids: new Set(), open: 0, openIds: new Set(), last: 0, via: new Set(), first: Date.now() };
      watch.edges.set(k, edge);
    }
    if (edge.ids.size < MAX_IDS) edge.ids.add(id);
    edge.openIds.add(id);
    edge.last = Date.now();
    edge.via.add(via);
  };

  // what a port of this computer is: a microservice, a container, a program, or nothing
  function localTarget(port, ctx) {
    const ctr = ctx.published.get(port);
    if (ctr) return ctr.service ? ctr.service.id : `ctr:${ctr.name}`;
    for (const pid of ctx.listen.get(port) || []) {
      const s = ctx.pidService.get(pid);
      if (s) return s.id;
    }
    if (ctx.listen.has(port)) return `proc:${port}`;
    const byPort = ctx.byPort.get(port);
    if (byPort) return byPort.id;
    return `free:${port}`;
  }

  async function sample() {
    if (watch.busy) return;
    watch.busy = true;
    const notes = [];
    try {
      const cfg = await readConfig();
      const list = cfg.list.map((x) => ({ ...x.service, appName: x.cfg.appName, port: x.cfg.port }));
      let socks = { listen: [], conns: [] };
      try {
        socks = await hostSockets();
      } catch (e) {
        notes.push(e.message);
      }
      const ctrs = await runningContainers(list).catch((e) => ({ error: e.message, rows: [] }));
      if (ctrs.error && !/not running|not found|Neither/i.test(ctrs.error)) notes.push(`Containers not looked into: ${ctrs.error}`);
      const listen = new Map();
      for (const l of socks.listen) listen.set(l.port, new Set([...(listen.get(l.port) || []), l.pid]));
      // which process is which microservice: a Java one with the microservice's folder in its command line (the
      // longest folder that fits, Maven itself left out), else the one whose code has its main class
      const pidService = new Map();
      for (const pid of new Set([...socks.listen, ...socks.conns].map((x) => x.pid))) {
        const p = watch.commands.get(pid);
        if (!p || !p.command || MAVEN_LAUNCHER.test(p.command) || !isJava(p.program, p.command)) continue;
        if (p.service === undefined) {
          const fits = list.filter((s) => inFolder(p.command, s.dir) || inFolder(p.command, s.repo)).sort((a, b) => b.dir.length - a.dir.length);
          p.service = fits.length ? fits[0].id : (serviceOfClass(p.command, list) || {}).id || null;
        }
        const s = p.service && list.find((x) => x.id === p.service);
        if (s) pidService.set(pid, s);
      }
      const published = new Map();
      for (const c of ctrs.rows) for (const p of c.ports) if (p.host && p.proto === 'tcp') published.set(p.host, c);
      const byPort = new Map(list.filter((s) => s.port).map((s) => [s.port, s]));
      const ctx = { listen, pidService, published, byPort };
      const own = ownAddresses();
      for (const e of watch.edges.values()) e.openIds = new Set();
      const running = new Map(); // service id -> how it runs
      for (const [pid, s] of pidService) {
        const p = watch.commands.get(pid);
        const ports = [...listen].filter(([, pids]) => pids.has(pid)).map(([port]) => port).sort((a, b) => a - b);
        const was = running.get(s.id);
        running.set(s.id, { how: startedBy(p.command), pid, ports: [...new Set([...(was ? was.ports : []), ...ports])] });
      }
      for (const c of ctrs.rows) if (c.service) running.set(c.service.id, { how: 'container', container: c.name, engine: ctrs.engine.label, ports: c.ports.filter((p) => p.host).map((p) => p.host) });
      // the connections the microservices' processes opened on this computer
      for (const cn of socks.conns) {
        const s = pidService.get(cn.pid);
        if (!s) continue;
        const ownPorts = listen.get(cn.local.port);
        if (ownPorts && ownPorts.has(cn.pid)) continue; // a call it answers, not one it makes
        const id = `${cn.pid}:${cn.local.port}>${cn.remote.ip}:${cn.remote.port}`;
        if (own.has(cn.remote.ip) || isLoopback(cn.remote.ip)) {
          const to = localTarget(cn.remote.port, ctx);
          add(s.id, to, id, published.has(cn.remote.port) ? 'to-container' : 'host');
        } else add(s.id, `ip:${cn.remote.ip}:${cn.remote.port}`, id, 'outside');
      }
      // calls into a microservice's own port (not its debugger's) from a program that is not one of them: a browser,
      // Postman, curl, Bruno... a client
      const httpPort = new Map();
      for (const [pid, s] of pidService) if ((listen.get(s.port || 8080) || new Set()).has(pid)) httpPort.set(s.port || 8080, s);
      for (const c of ctrs.rows) if (c.service) for (const p of c.ports) if (p.host && p.container === (c.service.port || 8080)) httpPort.set(p.host, c.service);
      for (const cn of socks.conns) {
        if (pidService.has(cn.pid) || !(own.has(cn.remote.ip) || isLoopback(cn.remote.ip))) continue;
        const s = httpPort.get(cn.remote.port);
        const mine = listen.get(cn.local.port);
        if (!s || (mine && mine.has(cn.pid))) continue;
        const p = watch.commands.get(cn.pid) || {};
        // Maven; and the app's own Bruno runs, which the Bruno page tells (noteClient) and would count twice
        if (MAVEN_LAUNCHER.test(p.command || '') || /bruno-runner/.test(p.command || '') || ENGINE_RELAY.test(p.program || '')) continue;
        add(`client:${clientName(p.program, p.command)}`, s.id, `${cn.pid}:${cn.local.port}>${cn.remote.port}`, 'client');
      }
      // and those inside their containers
      if (ctrs.engine) {
        const byIp = new Map();
        for (const c of ctrs.rows) for (const ip of c.ips) byIp.set(ip, c);
        for (const c of ctrs.rows.filter((x) => x.service)) {
          const inside = await containerSockets(ctrs.engine, c).catch(() => null);
          if (!inside) continue;
          const hostIps = new Set([...inside.hostIps, ...ENGINE_HOST_IPS]);
          for (const cn of inside.conns) {
            if (inside.listen.has(cn.local.port) || isLoopback(cn.remote.ip)) continue;
            const id = `${c.id}:${cn.local.port}>${cn.remote.ip}:${cn.remote.port}`;
            const other = byIp.get(cn.remote.ip);
            if (other) add(c.service.id, other.service ? other.service.id : `ctr:${other.name}`, id, 'between-containers');
            else if (hostIps.has(cn.remote.ip)) add(c.service.id, localTarget(cn.remote.port, ctx), id, 'container-to-host');
            else add(c.service.id, `ip:${cn.remote.ip}:${cn.remote.port}`, id, 'outside');
          }
        }
      }
      for (const e of watch.edges.values()) e.open = e.openIds.size;
      watch.samples++;
      watch.notes = notes;
      watch.last = { at: Date.now(), ctx, ctrs: ctrs.rows, running, programs: new Map([...listen].map(([port, pids]) => [port, [...pids].map((p) => (watch.commands.get(p) || {}).program).filter(Boolean)[0] || ''])) };
    } finally {
      watch.busy = false;
    }
  }

  // A request a page of the app sent (Bruno's): a call from that client to the microservice on its port. Too short to
  // be caught on the network, so it is told.
  let told = 0;
  async function noteClient(name, url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!LOCAL_HOSTS.has(host) && !ownAddresses().has(host)) return;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const cfg = await readConfig();
    const ctx = watch.last ? watch.last.ctx : { listen: new Map(), pidService: new Map(), published: new Map(), byPort: new Map() };
    ctx.byPort = new Map(cfg.list.filter((x) => x.cfg.port).map((x) => [x.cfg.port, x.service]));
    const to = localTarget(port, ctx);
    if (!to.startsWith('svc:')) return;
    add(`client:${name}`, to, `${name}:${++told}`, 'client');
    const e = watch.edges.get(`client:${name}|${to}`);
    if (e) e.openIds.clear(); // it is over already
  }

  function startWatch() {
    if (watch.on) return;
    watch.on = true;
    watch.since = Date.now();
    watch.until = 0;
    watch.stoppedBy = '';
    const tick = async () => {
      if (!watch.on) return;
      if (Date.now() - watch.since > MAX_WATCH_MS) {
        stopWatch('time');
        return;
      }
      await sample().catch(() => {});
      if (watch.on) watch.timer = setTimeout(tick, TICK_MS);
    };
    tick();
  }
  function stopWatch(by = 'user') {
    watch.on = false;
    watch.until = Date.now();
    watch.stoppedBy = by;
    clearTimeout(watch.timer);
    watch.timer = null;
  }

  // host names of the configuration, looked up once, so a connection to an address is named after the host it is
  const lookups = new Map();
  function lookup(host) {
    if (lookups.has(host)) return lookups.get(host);
    const p = new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), 1500);
      dns.lookup(host, { all: true }, (err, list) => {
        clearTimeout(timer);
        resolve(err ? [] : list.map((x) => x.address.toLowerCase()));
      });
    });
    lookups.set(host, p);
    return p;
  }

  // The map: every microservice with a call or running, what they call (databases, brokers, other hosts too), and the
  // arrows with what was seen and what the configuration says.
  async function snapshot() {
    const cfg = await readConfig();
    const list = cfg.list.map((x) => ({ ...x.service, appName: x.cfg.appName, port: x.cfg.port, cfg: x.cfg }));
    const last = watch.last;
    const ctx = last ? last.ctx : { listen: new Map(), pidService: new Map(), published: new Map(), byPort: new Map() };
    ctx.byPort = new Map(list.filter((s) => s.port).map((s) => [s.port, s]));
    const nodes = new Map();
    const edges = new Map();
    const svcById = new Map(list.map((s) => [s.id, s]));
    const node = (id, extra = {}) => {
      if (!nodes.has(id)) nodes.set(id, { id, ...extra });
      else Object.assign(nodes.get(id), Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== '')));
      return nodes.get(id);
    };
    const edge = (from, to) => {
      const k = `${from}|${to}`;
      if (!edges.has(k)) edges.set(k, { from, to, config: [], topics: [], seen: null });
      return edges.get(k);
    };
    const say = (e, why) => {
      if (!e.config.includes(why)) e.config.push(why);
    };
    // a node for an address: the microservice, container or program on this computer's port, or another host (the
    // hosts of the configuration looked up, so a connection to one of their addresses is named after it)
    const ipNames = new Map();
    const hosts = [...new Map(list.flatMap((s) => [...s.cfg.calls, ...s.cfg.brokers]).filter((c) => !LOCAL_HOSTS.has(c.host) && !/^[\d.]+$|:/.test(c.host)).map((c) => [`${c.host}:${c.port}`, c])).values()];
    await Promise.all(hosts.map(async (c) => {
      for (const ip of await lookup(c.host)) if (!ipNames.has(`${ip}:${c.port}`)) ipNames.set(`${ip}:${c.port}`, { host: c.host, port: c.port, scheme: c.scheme });
    }));
    const describeTarget = (id, hint = {}) => {
      if (id.startsWith('svc:')) return id;
      if (id === 'kafka') {
        node(id, { kind: 'infra', name: 'Kafka', sub: 'no brokers in the configuration' });
        return id;
      }
      if (id.startsWith('name:')) {
        node(id, { kind: 'outside', name: id.slice(5), sub: 'by name: not a microservice of the list' });
        return id;
      }
      if (id.startsWith('ctr:')) {
        const c = (last ? last.ctrs : []).find((x) => `ctr:${x.name}` === id);
        const port = c && c.ports.find((p) => p.host);
        node(id, { kind: c && c.kind ? 'infra' : 'outside', name: (c && c.kind) || id.slice(4), sub: `${id.slice(4)} container${port ? ` · :${port.host}` : ''}` });
        return id;
      }
      if (id.startsWith('proc:') || id.startsWith('free:')) {
        const port = Number(id.slice(5));
        const kind = SCHEME_KINDS[hint.scheme] || PORT_KINDS[port] || '';
        if (id.startsWith('proc:')) {
          const program = last ? last.programs.get(port) : '';
          node(id, { kind: kind ? 'infra' : 'outside', name: kind || hint.name || program || `:${port}`, sub: `${program ? `${program} · ` : ''}localhost:${port}` });
        } else if (last) node(id, { kind: 'nothing', name: kind || hint.name || `:${port}`, sub: `localhost:${port} · not listening`, port });
        // nothing looked at yet: not known whether something listens there
        else node(id, { kind: kind ? 'infra' : 'outside', name: kind || hint.name || `:${port}`, sub: `localhost:${port}`, port });
        return id;
      }
      // ip:a.b.c.d:port, or host:name:port
      const m = /^(ip|host):(.+):(\d+)$/.exec(id);
      const named = m && m[1] === 'ip' ? ipNames.get(`${m[2]}:${m[3]}`) : null;
      const host = named ? named.host : m ? m[2] : id;
      const port = m ? Number(m[3]) : null;
      const kind = SCHEME_KINDS[hint.scheme || (named && named.scheme)] || PORT_KINDS[port] || '';
      const nid = `host:${host}:${port}`;
      node(nid, { kind: kind ? 'infra' : 'outside', name: hint.name || kind || host.split('.')[0], sub: `${host}:${port}` });
      return nid;
    };
    const addressTarget = (a, hint) => {
      if (LOCAL_HOSTS.has(a.host)) return describeTarget(localTarget(a.port, ctx), { ...hint, scheme: a.scheme });
      return describeTarget(`host:${a.host}:${a.port}`, { ...hint, scheme: a.scheme });
    };
    // what the configuration says
    const kafkaOf = (s) => (s.cfg.brokers.length ? addressTarget(s.cfg.brokers[0], { scheme: 'kafka' }) : describeTarget('kafka', {}));
    for (const s of list) {
      for (const c of s.cfg.calls) {
        if (LOCAL_HOSTS.has(c.host) && c.port === s.port) continue; // itself
        const to = addressTarget(c, { name: c.name });
        if (to !== s.id) say(edge(s.id, to), c.why);
      }
      for (const b of s.cfg.brokers) say(edge(s.id, addressTarget(b, { scheme: 'kafka' })), b.why);
      for (const f of s.cfg.feign) {
        const other = list.find((o) => o !== s && [o.appName, o.name, path.basename(o.repo)].filter(Boolean).some((x) => x.toLowerCase() === f.name.toLowerCase()));
        const to = other ? other.id : describeTarget(`name:${f.name}`);
        say(edge(s.id, to), `${f.why} (by name: ${f.name})`);
      }
      for (const t of s.cfg.topics.produces) {
        const e = edge(s.id, kafkaOf(s));
        say(e, `sends to ${t.topic}: ${t.why}`);
        if (!e.topics.includes(t.topic)) e.topics.push(t.topic);
      }
      for (const t of s.cfg.topics.consumes) {
        const e = edge(kafkaOf(s), s.id);
        say(e, `listens to ${t.topic}: ${t.why}`);
        if (!e.topics.includes(t.topic)) e.topics.push(t.topic);
      }
    }
    // what was seen
    for (const w of watch.edges.values()) {
      if (w.from.startsWith('client:')) {
        const name = w.from.slice(7);
        node(w.from, { kind: 'client', name, sub: name === 'Bruno' ? 'from the Bruno page' : 'a program on this computer' });
      }
      const to = describeTarget(w.to, {});
      const e = edge(w.from, to);
      const seen = e.seen || { count: 0, open: 0, last: 0, via: [] };
      seen.count += w.ids.size;
      seen.open += w.open;
      seen.last = Math.max(seen.last, w.last);
      seen.via = [...new Set([...seen.via, ...w.via])];
      e.seen = seen;
    }
    // the Kafka node(s): named Kafka
    for (const n of nodes.values()) if (n.id === 'kafka') Object.assign(n, { kind: 'infra', name: 'Kafka', sub: 'its brokers are not in the configuration' });
    for (const e of edges.values()) {
      if (!e.topics.length) continue;
      const k = e.from.startsWith('svc:') ? e.to : e.from;
      const n = nodes.get(k);
      if (n && n.kind !== 'infra') Object.assign(n, { kind: 'infra', name: 'Kafka' });
    }
    // a microservice that only listens to a topic connects to the broker too: that connection goes on the arrow of
    // the topic (from the broker to it), not on one of its own the other way
    for (const e of [...edges.values()]) {
      if (!e.topics.length || !e.to.startsWith('svc:')) continue;
      const back = edges.get(`${e.to}|${e.from}`);
      if (!back || back.topics.length) continue;
      for (const why of back.config) say(e, why);
      if (back.seen) e.seen = e.seen ? { ...e.seen, count: e.seen.count + back.seen.count, open: e.seen.open + back.seen.open, last: Math.max(e.seen.last, back.seen.last) } : back.seen;
      edges.delete(`${e.to}|${e.from}`);
    }
    // the microservices: those with an arrow, and those running (as the last look found them)
    const running = last ? last.running : new Map();
    const used = new Set([...edges.values()].flatMap((e) => [e.from, e.to]));
    for (const s of list) {
      const r = running.get(s.id) || null;
      if (!used.has(s.id) && !r) continue;
      node(s.id, { kind: 'service', name: s.name, repo: s.repo, port: s.port, appName: s.appName, running: r });
    }
    for (const e of edges.values()) {
      if (!nodes.has(e.from) && svcById.has(e.from)) node(e.from, { kind: 'service', name: svcById.get(e.from).name, repo: svcById.get(e.from).repo, port: svcById.get(e.from).port, running: null });
      if (!nodes.has(e.to) && svcById.has(e.to)) node(e.to, { kind: 'service', name: svcById.get(e.to).name, repo: svcById.get(e.to).repo, port: svcById.get(e.to).port, running: null });
    }
    return {
      watching: watch.on,
      since: watch.since,
      until: watch.until,
      stoppedBy: watch.stoppedBy,
      samples: watch.samples,
      notes: watch.notes,
      readAt: cfg.at,
      services: list.length,
      nodes: [...nodes.values()].map((n) => (n.running ? { ...n, running: { ...n.running } } : n)),
      edges: [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to)),
    };
  }

  const call = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      return { error: e.message };
    }
  };
  ipcMain.handle('calls-snapshot', () => call(snapshot));
  ipcMain.handle('calls-watch', (_, on) => call(async () => {
    if (on) startWatch();
    else stopWatch('user');
    return snapshot();
  }));
  ipcMain.handle('calls-clear', () => call(async () => {
    watch.edges.clear();
    return snapshot();
  }));
  ipcMain.handle('calls-rescan', () => call(async () => {
    await readConfig(true);
    watch.commands.clear();
    watch.inspected.clear();
    return snapshot();
  }));
  return { stop: () => stopWatch('quit'), noteClient: (name, url) => noteClient(name, url).catch(() => {}) };
}

module.exports = { registerServiceMap, addressesIn, resolveValue, nameFromKey, callsInCode, readServiceConfig, parseLsof, parseNetstat, parseProcNet, hexIp, hostPath, inFolder, startedBy, classesIn, serviceOfClass, clientName };
