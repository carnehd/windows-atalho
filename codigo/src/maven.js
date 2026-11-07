const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const shell = require('./shell');
const { SKIP } = require('./analysis');
const GitService = require('./git-service');
const envValues = require('./env-values');
const runEnv = require('./run-env');
const containers = require('./containers');
const { NO_QUESTIONS } = require('./terminal');
const { intellijMaven } = require('./intellij-maven');

const { IS_WIN, psQuote, shQuote } = shell;
// The Maven wrapper a project may carry: mvnw.cmd on Windows, the mvnw shell script elsewhere.
const WRAPPER = IS_WIN ? 'mvnw.cmd' : 'mvnw';

// The wrapper for a folder: in it, or in a folder above it inside the repository (a module of a multi-module project
// uses the one at the top). Its full path, or null.
function findWrapper(dir, root = dir) {
  const top = path.resolve(root);
  let d = path.resolve(dir);
  for (;;) {
    const file = path.join(d, WRAPPER);
    if (fs.existsSync(file)) return file;
    const up = path.dirname(d);
    if (d === top || up === d || path.relative(top, up).startsWith('..')) return null;
    d = up;
  }
}
const hasWrapper = (dir) => Boolean(findWrapper(dir));
// how the wrapper is called from the folder the command runs in: ./mvnw, or ../mvnw from a module
const wrapperCall = (dir, file) => {
  const rel = path.relative(dir, file);
  if (rel.startsWith('..')) return rel;
  return IS_WIN ? `.\\${rel}` : `./${rel}`;
};

// The Maven a command runs with in a folder of a repository: as IntelliJ runs it when IntelliJ has the project
// (intellij-maven.js: its Maven, settings file, local repository, offline), else the project's mvnw, else mvn.
// { file: the mvn or mvnw to start (null: mvn on the PATH), wrapper: that is the project's mvnw, args: the flags of
// IntelliJ's settings, intellij: what was taken from it (for the output and the window) }
function mavenFor(dir, root = dir) {
  const wrapper = findWrapper(dir, root);
  const ij = intellijMaven(root, dir, wrapper ? "the project's mvnw" : 'mvn');
  const file = (ij && ij.file) || wrapper;
  return { file, wrapper: Boolean(wrapper) && file === wrapper, args: ij ? ij.args : [], intellij: ij };
}
// how it is called from the folder the command runs in: ./mvnw (../mvnw from a module), its full path, or mvn
const mavenExe = (dir, m) => (!m.file ? 'mvn' : m.wrapper ? wrapperCall(dir, m.file) : m.file);
// The flags of IntelliJ's settings the command does not set itself, then the command's arguments.
function mavenArgs(m, args) {
  const has = (re) => args.some((a) => re.test(a));
  const extra = [];
  for (let i = 0; i < m.args.length; i++) {
    const a = m.args[i];
    if (a === '-s') {
      if (!has(/^(-s|--settings)$/)) extra.push(a, m.args[i + 1]);
      i++;
    } else if (a.startsWith('-Dmaven.repo.local=')) {
      if (!has(/^-Dmaven\.repo\.local=/)) extra.push(a);
    } else if (a === '-o') {
      if (!has(/^(-o|--offline)$/)) extra.push(a);
    } else extra.push(a);
  }
  return [...extra, ...args];
}
// Under the command in the output: what IntelliJ's settings gave Maven, and what of them could not be taken.
const mavenLine = (m) => {
  const ij = m && m.intellij;
  if (!ij) return '';
  return `${ij.applies ? `  ${ij.said}\n` : ''}${ij.notes.map((n) => `  IntelliJ: ${n}\n`).join('')}`;
};

const DEFAULT_PORTS = { debug: 5005, server: null };

// server: the port the application listens on; null keeps the project's own setting (server.port, 8080 by default).
const serverArgs = (ports) => (ports.server ? [`-Dspring-boot.run.arguments=--server.port=${ports.server}`] : []);

// Start and Debug take the ports saved for the repository; the other presets are fixed.
const PRESETS = {
  'clean-install': { label: () => 'clean install', args: () => ['clean', 'install'] },
  'install-skip-tests': { label: () => 'clean install -DskipTests', args: () => ['clean', 'install', '-DskipTests'] },
  test: { label: () => 'test', args: () => ['test'] },
  start: {
    label: (p) => `spring-boot:run${p.server ? ` on port ${p.server}` : ''}`,
    args: (p) => ['spring-boot:run', ...serverArgs(p)],
  },
  debug: {
    label: (p) => `spring-boot:run (debug on port ${p.debug}${p.server ? `, app on port ${p.server}` : ''})`,
    args: (p) => [
      'spring-boot:run',
      `-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:${p.debug}`,
      ...serverArgs(p),
    ],
  },
  'spotless-apply': { label: () => 'spotless:apply', args: () => ['spotless:apply'] },
  'spotless-check': { label: () => 'spotless:check', args: () => ['spotless:check'] },
};

// Options that can be added to any command, from the list under it. Only these flags (and profiles the pom.xml has)
// are accepted from the window.
const OPTIONS = [
  { id: 'skip-tests', args: ['-DskipTests'], label: 'Skip tests' },
  { id: 'offline', args: ['-o'], label: 'Offline: only what is already downloaded' },
  { id: 'update', args: ['-U'], label: 'Update snapshots: get the latest SNAPSHOT dependencies' },
  { id: 'quiet', args: ['-q'], label: 'Quiet: show only errors' },
  { id: 'errors', args: ['-e'], label: 'Error details (stack traces)' },
  { id: 'debug-output', args: ['-X'], label: 'Debug output (very long)' },
  { id: 'threads', args: ['-T', '1C'], label: 'Parallel build: one thread per CPU core' },
];

// The ids of the <profile> entries in the project's pom.xml (comments left out).
function pomProfiles(dir) {
  try {
    const xml = fs.readFileSync(path.join(dir, 'pom.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const block = /<profiles>([\s\S]*?)<\/profiles>/.exec(xml);
    if (!block) return [];
    const ids = [...block[1].matchAll(/<profile>[\s\S]*?<id>\s*([^<\s]+)\s*<\/id>/g)].map((m) => m[1]);
    return [...new Set(ids)].filter((id) => /^[A-Za-z0-9._-]+$/.test(id));
  } catch {
    return [];
  }
}

// The chosen options after the command's own arguments; a flag the command already has is not added twice.
function withOptions(args, request, profiles) {
  const out = [...args];
  const chosen = new Set(Array.isArray(request.options) ? request.options.map(String) : []);
  for (const o of OPTIONS) if (chosen.has(o.id) && !out.includes(o.args[0])) out.push(...o.args);
  const picked = (Array.isArray(request.profiles) ? request.profiles.map(String) : []).filter((p) => profiles.includes(p));
  if (picked.length) out.push(`-P${[...new Set(picked)].join(',')}`);
  return out;
}

// Accepts numbers or text from the form. Empty debug means the default; empty server means the project's setting.
function parsePorts(input = {}) {
  const read = (value, name) => {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (!/^\d{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) throw new Error(`The ${name} must be a number between 1 and 65535`);
    return Number(text);
  };
  const ports = { debug: read(input.debug, 'debug port') || DEFAULT_PORTS.debug, server: read(input.server, 'app port') };
  if (ports.server === ports.debug) throw new Error('The debug port and the app port must be different');
  return ports;
}
const MAX_LOG_CHARS = 400000;
const MAX_LINE_CHARS = 4000;
const UNSAFE_CHARS = /[;|&`$<>\r\n]/;

function tokenize(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// The folders of a repository with a pom.xml in them ('' is its root): where Maven can run. Build output, dependencies
// and hidden folders are left out.
function pomFolders(root, maxDepth = 6) {
  const found = [];
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || visited++ > 4000 || found.length >= 300) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'pom.xml')) found.push(path.relative(root, dir).split(path.sep).join('/'));
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return found.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

// -- Macros: several commands saved under a name, for every microservice, run one after the other: Maven commands in
// the microservice's folder, and git steps in its repository (what to do with local changes, switch or create a
// branch, pull). A Go to a module step changes the folder the Maven steps after it run in. --
const MACRO_LIMITS = { count: 30, steps: 15, name: 60, text: 400 };
// My commands: Maven goals saved under a name, for every repository (the list on the Maven page)
const SAVED_LIMITS = { count: 50, name: 60, goals: 400 };
const SERVER_GOALS = /(^|\s)spring-boot:run(\s|$)/;
// Under the command: the values the application gets over its files (the Values button), and where they come from.
const valuesLine = (values, note) => (values ? `  SPRING_APPLICATION_JSON: ${String(note || `${Object.keys(values).length} values`).slice(0, 300)}\n` : '');

// -- Start in container: the jar Maven builds, run by Docker or Podman in a Java image, with no file added to the
// microservice's folder (the jar is mounted read-only). The port and the variables of the dialog go to the container,
// the values of the Values button as SPRING_APPLICATION_JSON. --
const CONTAINER_LABEL = 'git-quick=maven';
const DEFAULT_JAVA = 21;

// The Java version of the pom.xml: java.version, maven.compiler.release or .source, or the compiler's <release>.
function pomJava(dir) {
  try {
    const xml = fs.readFileSync(path.join(dir, 'pom.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const m = /<(java\.version|maven\.compiler\.release|maven\.compiler\.source|release)>\s*(?:1\.)?(\d{1,2})\s*</.exec(xml);
    return m ? Number(m[2]) : null;
  } catch {
    return null;
  }
}

// A container name from the folder, as Docker takes it: letters, digits, _ . -, a letter or digit first.
const containerName = (dir) => path.basename(dir).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 60) || 'app';

// What the dialog starts with for a folder never started in a container. vars null: the variables of Env.
const containerDefaults = (dir, ports) => ({
  image: `eclipse-temurin:${pomJava(dir) || DEFAULT_JAVA}-jre`,
  name: containerName(dir),
  port: ports.server || 8080,
  debug: false,
  debugPort: ports.debug || 5005,
  build: true,
  values: true,
  vars: null,
  proxy: { on: false, url: '', noProxy: '' },
  options: '',
});

const portOf = (value, what) => {
  const n = Number(String(value ?? '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${what} must be a number between 1 and 65535`);
  return n;
};

function cleanContainerSpec(input = {}) {
  const image = String(input.image || '').trim();
  if (!containers.IMAGE.test(image)) throw new Error('Type the image to run the jar in, for example eclipse-temurin:21-jre');
  const name = String(input.name || '').trim();
  if (!containers.REF.test(name)) throw new Error('Name the container: letters, digits, dots, dashes and underscores');
  const spec = {
    image,
    name,
    port: portOf(input.port, 'The port'),
    debug: Boolean(input.debug),
    debugPort: portOf(input.debugPort ?? 5005, 'The debug port'),
    build: input.build !== false,
    values: input.values !== false,
    vars: runEnv.cleanRunEnv({ vars: Array.isArray(input.vars) ? input.vars : [] }).vars,
    proxy: cleanProxy(input.proxy),
    options: cleanRunOptions(input.options),
  };
  if (spec.debug && spec.debugPort === spec.port) throw new Error('The debug port has to differ from the port of the app');
  return spec;
}

// More options of "docker run" / "podman run", as the user types them (--network, --label, -v, --add-host...): they go
// before the image. Not those the page needs to be its own: the container's name (Stop and the next start use it), and
// in the foreground with no terminal (its output is followed in the page).
const RUN_OPTIONS_MAX = 1000;
function cleanRunOptions(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  if (text.length > RUN_OPTIONS_MAX) throw new Error(`The extra options are too long (${RUN_OPTIONS_MAX} characters at most)`);
  if (/[\0\r\n]/.test(text)) throw new Error('The extra options go on one line');
  if (/["']/.test(text.replace(/"[^"]*"|'[^']*'/g, ''))) throw new Error('A quote of the extra options is not closed');
  const tokens = tokenize(text);
  if (!tokens[0].startsWith('-')) throw new Error(`The extra options start with - or --, for example --network my-net (not "${tokens[0].slice(0, 40)}")`);
  for (const t of tokens) {
    const flag = t.split('=')[0];
    const short = /^-[A-Za-z]+$/.test(t) ? t.slice(1) : '';
    if (flag === '--name') throw new Error('The name of the container goes in Container, not in the extra options');
    if (flag === '--detach' || short.includes('d')) throw new Error('Not -d / --detach: the page follows the container\'s output, and Stop stops it');
    if (/^--(interactive|tty)$/.test(flag) || /[it]/.test(short)) throw new Error('Not -i / -t: the container runs with no terminal to type in');
  }
  return text;
}

// The proxy the application in the container goes out through: on or off, its address (http://host:port, a user and
// password allowed) and the hosts it is not for (commas). Only an address in use is checked.
function cleanProxy(input) {
  const on = Boolean(input && input.on);
  let url = String((input && input.url) || '').trim();
  const noProxy = String((input && input.noProxy) || '').split(/[\s,;|]+/).filter(Boolean).join(',');
  if (url.length > 300 || noProxy.length > 1000) throw new Error('The proxy is too long');
  if (on) {
    if (!url) throw new Error('Type the proxy, for example http://proxy:8080');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`"${url.slice(0, 60)}" is not a proxy address: http://host:port`);
    }
    if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error('The proxy is an http:// or https:// address');
    if (!u.port) throw new Error('The proxy needs its port, for example http://proxy:8080');
    url = `${u.protocol}//${u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : ''}${u.host}`;
  }
  return { on, url, noProxy };
}

// Inside a container, the PC and the container itself are never behind the proxy.
const NO_PROXY_ALWAYS = ['localhost', '127.0.0.1', 'host.docker.internal', 'host.containers.internal'];

// What the application in the container gets for the proxy: the variables tools read (both cases), and for Java,
// which reads none of them, the system properties to add to JAVA_TOOL_OPTIONS.
function proxySettings(proxy) {
  if (!proxy || !proxy.on || !proxy.url) return null;
  const u = new URL(proxy.url);
  const hosts = [...new Set([...NO_PROXY_ALWAYS, ...proxy.noProxy.split(',').filter(Boolean)])];
  // Java: | between them, *.domain for a domain, no address ranges
  const javaHosts = hosts.filter((h) => !h.includes('/')).map((h) => (h.startsWith('.') ? `*${h}` : h)).join('|');
  const port = u.port;
  const java = ['http', 'https'].map((p) => `-D${p}.proxyHost=${u.hostname} -D${p}.proxyPort=${port}`).join(' ') + ` -Dhttp.nonProxyHosts=${javaHosts}`;
  const shown = proxy.url.replace(/\/\/[^@/]*@/, '//***@');
  const env = [];
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY']) env.push([name, proxy.url, shown], [name.toLowerCase(), proxy.url, shown]);
  env.push(['NO_PROXY', hosts.join(','), hosts.join(',')], ['no_proxy', hosts.join(','), hosts.join(',')]);
  return { env, java };
}

// What docker or podman says when the image cannot be got through the network (a proxy, a certificate, no DNS).
const NET_TROUBLE = /proxyconnect|x509|certificate|i\/o timeout|TLS handshake|no such host|connection refused|connection reset|dial tcp|context deadline exceeded/i;

// After that: the image is the engine's own download, which the proxy of the dialog does not reach.
function pullHint(engine) {
  const own = engine === 'podman'
    ? 'Podman: set HTTP_PROXY and HTTPS_PROXY in Windows (or your shell), then podman machine stop and podman machine start'
    : 'Docker Desktop: Settings > Resources > Proxies';
  return `\nThe image could not be downloaded: a proxy or a certificate is in the way. Use this PC's proxy reaches the application in the container, not this download, which is ${engine === 'podman' ? 'Podman' : 'Docker'}'s own. ${own}. Or put your company's registry in Java image (for example registry.company/eclipse-temurin:21-jre), or pull the image once by hand.\n`;
}

// Windows' "Don't use the proxy for" list (Internet Settings), as NO_PROXY reads it; [] when there is none.
function windowsProxyOverride() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyOverride'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const m = !err && /ProxyOverride\s+REG_\w+\s+(.+)/i.exec(String(stdout || ''));
      resolve(m ? m[1].trim().split(';') : []);
    });
  });
}

const OTHER_JAR = /-(sources|javadoc|tests|test-sources)\.jar$/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// The jars in target/ that can run (not the sources, javadoc or tests ones): { file, mtime, size }.
function targetJars(dir) {
  const out = [];
  try {
    for (const f of fs.readdirSync(path.join(dir, 'target'))) {
      if (!f.endsWith('.jar') || OTHER_JAR.test(f)) continue;
      const file = path.join(dir, 'target', f);
      const st = fs.statSync(file);
      if (st.isFile()) out.push({ file, mtime: st.mtimeMs, size: st.size });
    }
  } catch {
    // not built yet
  }
  return out;
}

// The jar to run when no build says which: the newest (an older one of another version left in target/ is not it), and
// of those written with it, the biggest (the one Spring Boot repackages with its dependencies).
function newestJar(dir) {
  const jars = targetJars(dir).sort((a, b) => b.mtime - a.mtime);
  if (!jars.length) return null;
  return jars.filter((j) => jars[0].mtime - j.mtime < 60000).sort((a, b) => b.size - a.size)[0];
}

// The jar a build made, from what Maven said: Spring Boot's repackaged one ("Attaching repackaged archive <jar> with
// classifier", "Replacing main artifact <jar> with repackaged archive": said even when the jar was up to date and not
// written again), else maven-jar-plugin's "Building jar: <jar>". null when it named none in target/.
function jarSaid(text, dir) {
  const target = path.resolve(dir, 'target');
  const named = (re) => {
    let found = null;
    for (const m of String(text).replace(ANSI, '').matchAll(re)) {
      const file = path.resolve(dir, m[1].trim());
      if (path.dirname(file) === target && !OTHER_JAR.test(file) && fs.existsSync(file)) found = file;
    }
    return found;
  };
  return named(/(?:Attaching repackaged archive|Replacing main artifact) (.+?\.jar) with /g) || named(/Building jar: (.+?\.jar)\s*$/gm);
}

// "12 s ago", "3 h ago"
function agoText(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// "docker run" for the jar: removed when it stops, labelled as this page's, its port (and the debug one) published, the
// application told its port (SERVER_PORT, unless a variable sets it) and the variables switched on; the jar mounted
// read-only. shown: the same with the values of the variables hidden.
function containerArgs(spec, jar, values) {
  const given = spec.vars.filter((v) => v.enabled !== false);
  const own = new Map(given.map((v) => [v.name, v.value]));
  // [name, value, shown]: what the output shows of it, its value for the app's own, … for the user's
  const env = [];
  if (!own.has('SERVER_PORT')) env.push(['SERVER_PORT', String(spec.port), String(spec.port)]);
  // JAVA_TOOL_OPTIONS: the user's, then the proxy for Java, then Debug's agent
  const proxy = proxySettings(spec.proxy);
  const jdwp = spec.debug ? `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:${spec.debugPort}` : '';
  const added = [proxy ? proxy.java : '', jdwp].filter(Boolean).join(' ');
  if (added) {
    const java = [own.get('JAVA_TOOL_OPTIONS'), added].filter(Boolean).join(' ');
    env.push(['JAVA_TOOL_OPTIONS', java, own.has('JAVA_TOOL_OPTIONS') ? null : java]);
  }
  // the user's variables win over the proxy's
  if (proxy) for (const [name, value, shown] of proxy.env) if (!own.has(name)) env.push([name, value, shown]);
  for (const v of given) if (!(added && v.name === 'JAVA_TOOL_OPTIONS')) env.push([v.name, v.value, null]);
  if (values) env.push(['SPRING_APPLICATION_JSON', JSON.stringify(values), null]);
  // a field of --mount with a comma or a quote in it is quoted, as CSV
  const csv = (t) => (/[",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
  const head = ['run', '--rm', '--name', spec.name, '--label', CONTAINER_LABEL, '-p', `${spec.port}:${spec.port}`, ...(spec.debug ? ['-p', `${spec.debugPort}:${spec.debugPort}`] : [])];
  // the user's extra options; the value of a variable among them hidden as the dialog's are
  const extra = tokenize(spec.options || '');
  const extraShown = extra.map((a, i) => {
    const env = extra[i - 1] === '-e' || extra[i - 1] === '--env' ? a : a.startsWith('--env=') ? a.slice(6) : null;
    const eq = env === null ? -1 : env.indexOf('=');
    return eq > 0 ? `${a.slice(0, a.length - env.length + eq + 1)}\u2026` : a;
  });
  const tail = ['--mount', ['type=bind', csv(`source=${jar}`), 'target=/app/app.jar', 'readonly'].join(','), spec.image, 'java', '-jar', '/app/app.jar'];
  return {
    args: [...head, ...extra, ...env.flatMap(([k, v]) => ['-e', `${k}=${v}`]), ...tail],
    shown: [...head, ...extraShown, ...env.flatMap(([k, , shown]) => ['-e', shown === null ? `${k}=\u2026` : `${k}=${shown}`]), ...tail].map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' '),
  };
}

// The command to paste in a terminal of this PC, the values of the variables in it (Copy): quoted for PowerShell on
// Windows, for sh elsewhere. Windows PowerShell gives a program an argument with a space in "..." and leaves what is in
// it as it is: a double quote in it is written \", and the \ at its end doubled (or they would end it).
const psArg = (a) => {
  const escaped = a.replace(/(\\*)"/g, '$1$1\\"');
  return psQuote(/\s/.test(a) ? escaped.replace(/(\\+)$/, '$1$1') : escaped);
};
function pastedCommand(name, args) {
  const quote = (a) => (/^[\w./:=+-]+$/.test(a) ? a : IS_WIN ? psArg(a) : shQuote(a));
  return [name, ...args].map(quote).join(' ');
}

// docker or podman once, what it printed collected (inspect, rm, stop).
const engineOnce = (call, args, timeout = 60000) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(call.exe, args, { env: call.env, windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout, stderr: e.message });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

// A step that starts the application does not end by itself, so it can only be the last one.
const keepsRunning = (step) => (step.kind === 'preset' && ['start', 'debug'].includes(step.preset)) || (step.kind === 'custom' && SERVER_GOALS.test(step.goals));
const GIT_KINDS = new Set(['changes', 'fetch', 'checkout', 'branch', 'pull', 'unstash']);
const MAVEN_KINDS = new Set(['preset', 'custom']);
// The folder a Go to a module step names, relative to the root of the repository ('' is the root): a path inside it,
// never one that leaves it. Whether it has a pom.xml is seen when the macro runs, in the repository it runs in.
function moduleDir(value, i) {
  const t = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (t.length > 200) throw new Error(`Step ${i + 1}: the folder is too long`);
  if (t && (/^\/|^[A-Za-z]:/.test(t) || t.split('/').some((p) => p === '..' || p === '.' || !p) || !/^[\w.@+ \/-]+$/.test(t))) {
    throw new Error(`Step ${i + 1}: "${t}" is not a folder of the repository (one inside it, as orders-api or services/orders-api)`);
  }
  return t;
}
// Local changes: asked when the macro runs (stash, discard or stop), or always the same answer.
const CHANGES_POLICIES = ['ask', 'stash', 'discard', 'stop'];
// A branch a step names: only the characters branch names use, never an option or a range. Git has the last word
// (check-ref-format) when the step runs.
const branchText = (v) => String(v || '').trim().slice(0, 200);
const isBranchName = (t) => /^[\w./-]+$/.test(t) && !t.startsWith('-') && !t.startsWith('/') && !t.endsWith('/') && !t.endsWith('.') && !t.endsWith('.lock') && !t.includes('..') && !t.includes('//');

// A saved command as it is kept: its goals (without mvn) and the name the list shows, the goals when none is given.
function cleanSavedCommand(input = {}) {
  const goals = String(input.goals || '').trim().replace(/^mvn(w)?(\.cmd)?\s+/i, '');
  if (!goals) throw new Error('Type the Maven goals, e.g. clean verify');
  if (goals.length > SAVED_LIMITS.goals) throw new Error('The goals are too long');
  if (UNSAFE_CHARS.test(goals)) throw new Error('Only Maven arguments are allowed (no ; | & ` $ < >)');
  const name = String(input.name || '').trim().slice(0, SAVED_LIMITS.name) || goals.slice(0, SAVED_LIMITS.name);
  const id = typeof input.id === 'string' && /^[\w-]{1,64}$/.test(input.id) ? input.id : crypto.randomUUID();
  return { id, name, goals };
}

function cleanMacro(input = {}) {
  const name = String(input.name || '').trim().slice(0, MACRO_LIMITS.name);
  if (!name) throw new Error('Give the macro a name');
  const raw = Array.isArray(input.steps) ? input.steps : [];
  if (!raw.length) throw new Error('Add at least one step');
  if (raw.length > MACRO_LIMITS.steps) throw new Error(`A macro has ${MACRO_LIMITS.steps} steps at most`);
  const text = (v, i) => {
    const t = String(v || '').trim().replace(/^mvn(w)?(\.cmd)?\s+/i, '').slice(0, MACRO_LIMITS.text);
    if (UNSAFE_CHARS.test(t)) throw new Error(`Step ${i + 1}: only Maven arguments are allowed (no ; | & \` $ < >)`);
    return t;
  };
  const branch = (v, i, what, required) => {
    const t = branchText(v);
    if (!t && required) throw new Error(`Step ${i + 1}: type ${what}`);
    if (t && !isBranchName(t)) throw new Error(`Step ${i + 1}: "${t}" is not a branch name`);
    return t;
  };
  const steps = raw.map((step, i) => {
    const kind = step && step.kind;
    if (kind === 'stop' || kind === 'fetch' || kind === 'unstash') return { kind };
    if (kind === 'module') return { kind, dir: moduleDir(step.dir, i) };
    if (kind === 'changes') return { kind, policy: CHANGES_POLICIES.includes(step.policy) ? step.policy : 'ask' };
    if (kind === 'checkout') return { kind, branch: branch(step.branch, i, 'the branch to switch to, e.g. develop', true) };
    if (kind === 'branch') return { kind, base: branch(step.base, i, 'the branch on origin it starts from, e.g. develop', true) };
    if (kind === 'pull') return { kind, from: branch(step.from, i, '', false) };
    if (kind === 'preset') {
      if (!Object.prototype.hasOwnProperty.call(PRESETS, step.preset)) throw new Error(`Step ${i + 1}: unknown command`);
      return { kind, preset: step.preset, extra: text(step.extra, i) };
    }
    if (kind === 'custom') {
      const goals = text(step.goals, i);
      if (!goals) throw new Error(`Step ${i + 1}: type the Maven goals, e.g. clean verify`);
      return { kind, goals };
    }
    throw new Error(`Step ${i + 1}: unknown kind of step`);
  });
  const early = steps.findIndex((st, i) => keepsRunning(st) && i < steps.length - 1);
  if (early !== -1) throw new Error(`Step ${early + 1} starts the app, which keeps running: it has to be the last step`);
  const unstash = steps.findIndex((st, i) => st.kind === 'unstash' && !steps.slice(0, i).some((s) => s.kind === 'changes'));
  if (unstash !== -1) throw new Error(`Step ${unstash + 1} brings back the changes a Local changes step stashed: put one before it`);
  const id = typeof input.id === 'string' && /^[\w-]{1,64}$/.test(input.id) ? input.id : crypto.randomUUID();
  return { id, name, steps };
}

// What to do with the local changes when a macro runs: the answer given when it started (for a step that asks, or
// that discards them, which is never done without saying so), else the step's own. A step that asks and got no answer
// stops the macro when there are changes.
const changesPolicy = (step, answers) => {
  if (step.policy === 'ask' || step.policy === 'discard') return answers.changes || (step.policy === 'ask' ? 'stop' : 'discard');
  return step.policy;
};
const CHANGES_LABELS = { stash: 'stash them', discard: 'discard them', stop: 'stop if there are any' };

// A git step as the output and the status show it.
function gitStepLabel(step, answers, i) {
  switch (step.kind) {
    case 'changes':
      return `Local changes: ${CHANGES_LABELS[changesPolicy(step, answers)]}`;
    case 'fetch':
      return 'git fetch --all --prune --tags';
    case 'checkout':
      return `git checkout ${step.branch}`;
    case 'branch':
      return `New branch ${answers.branches[i]} from origin/${step.base}`;
    case 'pull':
      return step.from ? `git pull origin ${step.from}` : 'git pull';
    default:
      return 'Bring back the stashed changes (git stash pop)';
  }
}

// What is asked when a macro starts: the name of each new branch (by the step's place) and, when there are local
// changes, what to do with them.
function cleanAnswers(macro, input = {}) {
  const typed = input && typeof input.branches === 'object' && input.branches ? input.branches : {};
  const branches = {};
  macro.steps.forEach((st, i) => {
    if (st.kind !== 'branch') return;
    const name = branchText(typed[i]);
    if (!name) throw new Error(`Step ${i + 1}: type the name of the new branch`);
    if (!isBranchName(name)) throw new Error(`"${name}" is not a valid branch name`);
    branches[i] = name;
  });
  const changes = ['stash', 'discard', 'stop'].includes(input && input.changes) ? input.changes : null;
  return { branches, changes };
}

// Windows: mvn and mvnw are .cmd files, which only a shell can start, so they run through PowerShell (which also gives
// UTF-8 output). Every argument is single-quoted: PowerShell 5.1 otherwise splits unquoted arguments like -Dfoo.bar=1
// at the dot.
function buildScript(dir, args, m = mavenFor(dir)) {
  return [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `& ${psQuote(mavenExe(dir, m))} ${mavenArgs(m, args).map(psQuote).join(' ')}`,
    'exit $LASTEXITCODE',
  ].join('; ');
}

// The command a run starts, in the folder chosen for the repository: PowerShell with the script on Windows. On macOS
// and Linux Maven starts straight from the app, no shell in between, with the environment of the user's shell (see
// shell.js, so a Mac app opened from the Finder still finds Homebrew's mvn and SDKMAN's Java): IntelliJ's Maven or the
// project's mvnw (through sh, so it works even without the executable bit a Windows checkout leaves off) or mvn, in
// its own process group so Stop can end Maven and the Java it started together.
function startMaven(dir, args, env, m = mavenFor(dir)) {
  if (IS_WIN) return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', buildScript(dir, args, m)], { cwd: dir, windowsHide: true, ...(env ? { env } : {}) });
  if (m.file) return spawn('/bin/sh', [mavenExe(dir, m), ...mavenArgs(m, args)], { cwd: dir, env, detached: true });
  return spawn('mvn', mavenArgs(m, args), { cwd: dir, env, detached: true });
}

// A command line typed under the output, as typed, in the system shell: PowerShell on Windows, the user's shell
// elsewhere (in its own process group, for Stop). Nobody can answer it: git asks for nothing, no pager, no colours.
function startLine(dir, line, env) {
  const vars = { ...(env || process.env), ...NO_QUESTIONS };
  if (IS_WIN) return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${line}`], { cwd: dir, env: vars, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return spawn(process.env.SHELL || '/bin/zsh', ['-c', line], { cwd: dir, env: vars, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

// "Separate window": the same command in PowerShell (Windows) or Terminal (macOS), left open when it ends.
const mavenArgv = (dir, args, m = mavenFor(dir)) => {
  if (!m.file) return ['mvn', ...mavenArgs(m, args)];
  return IS_WIN ? [mavenExe(dir, m), ...mavenArgs(m, args)] : ['/bin/sh', mavenExe(dir, m), ...mavenArgs(m, args)];
};
const terminalScript = (dir, args) => shell.terminalScript(dir, mavenArgv(dir, args));

function registerMaven({ isKnownRepo, getWindow, loadPorts, savePorts, loadDir, saveDir, loadMacros, saveMacros, loadCommands, saveCommands, loadRunEnv, saveRunEnv, loadContainer, saveContainer, resolveProxy }) {
  const portsFor = (repoPath) => {
    try {
      return parsePorts(loadPorts(repoPath) || {});
    } catch {
      return { ...DEFAULT_PORTS };
    }
  };
  const presetView = (ports) => ({
    presets: Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, p.label(ports)])),
    commands: Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, `mvn ${p.args(ports).join(' ')}`])),
  });

  // The folder the commands of a repository run in: the one chosen (inside it, with a pom.xml), else its root.
  const relOf = (root, dir) => path.relative(root, dir).split(path.sep).join('/');
  function chosenDir(repoPath) {
    const rel = String((loadDir && loadDir(repoPath)) || '');
    if (!rel) return { dir: repoPath, rel: '' };
    const dir = path.resolve(repoPath, rel);
    const inside = path.relative(path.resolve(repoPath), dir);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !fs.existsSync(path.join(dir, 'pom.xml'))) return { dir: repoPath, rel: '', lost: rel };
    return { dir, rel: relOf(repoPath, dir) };
  }
  // The environment variables Start and Debug give the application (run-env.js), saved for the repository.
  const runEnvFor = (repoPath) => {
    try {
      return runEnv.cleanRunEnv((loadRunEnv && loadRunEnv(repoPath)) || {});
    } catch {
      return { ...runEnv.EMPTY };
    }
  };
  // What Start in container starts with: what was chosen for the repository last time, else the defaults. Only Build
  // first switched on the bar (never started): the variables still those of Env (vars null).
  const containerFor = (repoPath) => {
    const { dir } = chosenDir(repoPath);
    const defaults = containerDefaults(dir, portsFor(repoPath));
    try {
      const saved = loadContainer && loadContainer(repoPath);
      if (!saved) return defaults;
      const spec = cleanContainerSpec({ ...defaults, ...saved });
      return Array.isArray(saved.vars) ? spec : { ...spec, vars: null };
    } catch {
      return defaults;
    }
  };
  const macroList = () => {
    const list = loadMacros ? loadMacros() : [];
    return Array.isArray(list) ? list : [];
  };
  const commandList = () => {
    const list = loadCommands ? loadCommands() : [];
    return Array.isArray(list) ? list.filter((c) => c && typeof c.id === 'string' && typeof c.goals === 'string') : [];
  };

  const runs = new Map();
  const key = (p) => path.resolve(p).toLowerCase();

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const killTree = shell.killTree;

  // The repositories with a run going (and its command), for the dot in the list; sent whenever one starts or ends.
  // (a macro: the step it is on, so the list shows when it is the one that starts the app)
  const runningRepos = () => [...runs.values()].filter((r) => r.active).map((r) => ({ repo: r.repo, command: r.macro ? r.stepCommand || r.command : r.command }));
  const announce = () => send('mvn-running', runningRepos());

  // A run: one command, or the steps of a macro one after the other. active until its last step ends; muted once another
  // run of the same repository takes its place (a macro that stops it first), so their output does not mix. written
  // counts what its output has had so far: the window, which gets the output both as it comes and whole (when the run
  // starts, when the page is read again), adds only what it does not have yet.
  let lastRunId = 0;
  function newRun(repoPath, command, header, extra = {}) {
    const run = { id: ++lastRunId, child: null, active: true, cancelled: false, muted: false, repo: repoPath, command, log: header, written: header.length, exitCode: null, startedAt: Date.now(), endedAt: null, ...extra };
    run.done = new Promise((resolve) => (run.resolveDone = resolve));
    return run;
  }
  const write = (run, text) => {
    run.log = (run.log + text).slice(-MAX_LOG_CHARS);
    run.written += text.length;
    if (!run.muted) send('mvn-output', { repo: run.repo, text, id: run.id, end: run.written });
  };

  // Maven once (or, with line, that command line in the system shell), its output added to the run's log (and given to
  // tap); resolves with the exit code.
  function runStep(run, dir, args, env, tap = null, line = null) {
    return new Promise((resolve) => {
      let settled = false;
      const end = (code) => {
        if (settled) return;
        settled = true;
        run.child = null;
        resolve(code);
      };
      const child = line === null ? startMaven(dir, args, env, run.maven || mavenFor(dir, run.repo)) : startLine(dir, line, env);
      run.child = child;
      const append = (chunk) => {
        const text = chunk.toString('utf8');
        write(run, text);
        if (tap) tap(text);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', (e) => {
        const why = e.code === 'ENOENT' && !IS_WIN && line === null
          ? 'Maven (mvn) was not found. Install it (for example: brew install maven) or add the Maven wrapper (mvnw) to the project.'
          : e.message;
        write(run, `\n[failed to start: ${why}]\n`);
        setTimeout(() => end(-1), 1000);
      });
      child.on('close', end);
    });
  }

  function finishRun(run, exitCode, extra = {}) {
    Object.assign(run, { active: false, child: null, exitCode, endedAt: Date.now() }, extra);
    run.resolveDone();
    if (runs.get(key(run.repo)) === run) send('mvn-exit', { repo: run.repo, exitCode, endedAt: run.endedAt, failedStep: run.failedStep || null, failedGit: Boolean(run.failedGit), stopped: run.cancelled, marks: run.macro ? run.macro.marks : null });
    announce();
  }

  // Stop: Maven and the Java it started, or the docker command. A container is stopped by the engine first: ending the
  // command alone would leave it running on Windows.
  async function stopRun(run, wait = 10) {
    run.cancelled = true;
    if (run.container && run.container.started) await engineOnce(run.container.call, ['stop', '-t', String(wait), run.container.name], (wait + 20) * 1000);
    if (run.child) await killTree(run.child);
  }

  // docker run, its output added to the run's log (and given to tap); resolves with its exit code.
  function runEngine(run, call, args, tap = null) {
    return new Promise((resolve) => {
      let settled = false;
      const end = (code) => {
        if (settled) return;
        settled = true;
        run.child = null;
        resolve(code);
      };
      const child = spawn(call.exe, args, { env: call.env, windowsHide: true, detached: !IS_WIN });
      run.child = child;
      const append = (chunk) => {
        const text = chunk.toString('utf8');
        write(run, text);
        if (tap) tap(text);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', (e) => {
        write(run, `\n[failed to start ${call.name}: ${e.message}]\n`);
        end(-1);
      });
      child.on('close', end);
    });
  }

  // A container of the same name left from before: removed when this page started it (its label), else the run stops.
  async function clearOldContainer(run, call, name) {
    const r = await engineOnce(call, ['container', 'inspect', '--format', '{{index .Config.Labels "git-quick"}}', name]);
    if (r.code !== 0) return 0;
    if (r.stdout.trim() !== 'maven') {
      write(run, `\nA container named ${name} already exists, and it was not started here: choose another name, or remove it in Containers.\n`);
      return 1;
    }
    write(run, `\nRemoving the ${name} container started before.\n`);
    const rm = await engineOnce(call, ['rm', '-f', name]);
    if (rm.code !== 0) {
      write(run, `${containers.dockerError(rm.stderr)}\n`);
      return 1;
    }
    return 0;
  }

  function resolveArgs(repoPath, request) {
    if (!isKnownRepo(repoPath)) throw new Error('Unknown repository');
    const { dir } = chosenDir(repoPath);
    if (!fs.existsSync(path.join(dir, 'pom.xml'))) throw new Error('No pom.xml in this repository');
    if (request.preset) {
      const preset = PRESETS[request.preset];
      if (!preset) throw new Error('Unknown command');
      return withOptions(preset.args(portsFor(repoPath)), request, pomProfiles(dir));
    }
    const text = String(request.custom || '').trim().replace(/^mvn(w)?(\.cmd)?\s+/i, '');
    if (!text) throw new Error('Type the Maven goals to run, e.g. clean verify');
    if (UNSAFE_CHARS.test(text)) throw new Error('Only Maven arguments are allowed (no ; | & ` $ < >)');
    return withOptions(tokenize(text), request, pomProfiles(dir));
  }

  // What a step of a macro runs, with the ports saved for the repository; a Stop step runs nothing.
  const stepArgs = (step, ports) => (step.kind === 'preset' ? [...PRESETS[step.preset].args(ports), ...tokenize(step.extra || '')] : tokenize(step.goals));

  // A git step of a macro, in the repository's root, what it did written to the output. Resolves with 0, or 1 when it
  // failed (the macro ends there). ctx holds the answers given when it started and the stash it made.
  async function runGitStep(run, step, i, ctx) {
    const service = new GitService(run.repo);
    const git = service.git;
    const say = (text) => write(run, `${text}\n`);
    const fail = (text) => {
      say(GitService.cleanError(text).replace(/^(error|fatal): /gm, ''));
      return 1;
    };
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    try {
      switch (step.kind) {
        case 'changes': {
          const status = await git.status();
          if (!status.files.length) {
            say('No local changes.');
            return 0;
          }
          const what = `${plural(status.files.length, 'file')} changed on ${status.current}`;
          const policy = changesPolicy(step, ctx.answers);
          if (policy === 'stop') return fail(`${what}: the macro stops here. Commit, stash or revert them, or run it again and choose what to do with them.`);
          if (policy === 'stash') {
            const message = `${run.macro.name} ${new Date().toLocaleString()}`;
            const r = await service.stashPush(message, null, true);
            if (r.error) return fail(`Could not stash them: ${r.error}`);
            ctx.stash = (await git.revparse(['refs/stash'])).trim();
            say(`${what}: stashed as "${message}" (with the new files). They are in the Stash tab.`);
            return 0;
          }
          // every changed path, a renamed file's old one too: what the Changes tab's Revert takes back
          const files = [...new Set(status.files.flatMap((f) => [f.path, f.from]).filter(Boolean))];
          const r = await service.revertFiles(files);
          if (r.error) return fail(`Could not discard them: ${r.error}`);
          say(`${what}: discarded.`);
          return 0;
        }
        case 'fetch': {
          const r = await service.fetch();
          if (r.error) return fail(`Could not fetch: ${r.error}`);
          say(r.warning || 'Fetched every branch and tag from origin.');
          return 0;
        }
        case 'checkout': {
          if ((await git.status()).current === step.branch) {
            say(`Already on ${step.branch}.`);
            return 0;
          }
          const r = await service.checkout(step.branch);
          if (r.error) return fail(`Could not switch to ${step.branch}: ${r.error}`);
          say(`Switched to ${step.branch}.`);
          return 0;
        }
        case 'branch': {
          const name = ctx.answers.branches[i];
          // one made before (the same task again): the macro goes on from it
          if (await service.refExists(`refs/heads/${name}`)) {
            const r = await service.checkout(name);
            if (r.error) return fail(`${name} already exists, and switching to it failed: ${r.error}`);
            say(`${name} already exists: switched to it.`);
            return 0;
          }
          const r = await service.createBranchFrom(name, step.base);
          if (r.error) return fail(`Could not create ${name}: ${r.error}`);
          say(`Created ${name} from origin/${step.base} (fetched first, so it is up to date) and switched to it.`);
          return 0;
        }
        case 'pull': {
          const status = await git.status();
          if (status.detached || !status.current) return fail('Not on a branch (detached HEAD): nothing to pull into.');
          const before = await git.revparse(['HEAD']).catch(() => '');
          let r;
          if (step.from) {
            try {
              await git.raw(['pull', '--no-rebase', 'origin', step.from]);
              r = (await service.stoppedOnConflicts('pull')) || { success: true };
            } catch (e) {
              r = (await service.stoppedOnConflicts('pull')) || { error: e.message };
            }
          } else if (!status.tracking) {
            say(`${status.current} is not on origin yet: nothing to pull.`);
            return 0;
          } else r = await service.pull();
          if (r.error) return fail(r.conflict ? `${r.error}\nResolve them in the Changes tab.` : `Could not pull: ${r.error}`);
          const after = await git.revparse(['HEAD']).catch(() => '');
          if (before && before.trim() === after.trim()) say('Already up to date.');
          else {
            const stat = before ? (await git.raw(['diff', '--shortstat', before.trim(), 'HEAD']).catch(() => '')).trim() : '';
            say(`Pulled${step.from ? ` origin/${step.from} into ${status.current}` : ''}${stat ? `: ${stat}` : ''}.`);
          }
          return 0;
        }
        default: {
          if (!ctx.stash) {
            say('Nothing was stashed: nothing to bring back.');
            return 0;
          }
          const list = (await git.raw(['stash', 'list', '--format=%H'])).split('\n').map((l) => l.trim());
          const at = list.indexOf(ctx.stash);
          if (at === -1) {
            say('The stash it made is gone: nothing to bring back.');
            return 0;
          }
          try {
            await git.raw(['stash', 'pop', `stash@{${at}}`]);
          } catch (e) {
            const conflict = await service.stoppedOnConflicts('stash pop');
            return fail(conflict ? `${conflict.error}\nThe changes are also kept in the Stash tab.` : `Could not bring them back: ${e.message}\nThey are still in the Stash tab.`);
          }
          ctx.stash = null;
          say('Brought back the changes it stashed.');
          return 0;
        }
      }
    } catch (e) {
      return fail(e.message);
    }
  }

  function infoFor(repoPath) {
    const run = runs.get(key(repoPath));
    const ports = portsFor(repoPath);
    const { dir, rel, lost } = chosenDir(repoPath);
    const maven = mavenFor(dir, repoPath);
    const ij = maven.intellij;
    return {
      hasPom: fs.existsSync(path.join(dir, 'pom.xml')),
      dir: rel,
      lostDir: lost || null,
      folders: pomFolders(repoPath),
      wrapper: maven.wrapper,
      wrapperDir: maven.wrapper ? relOf(repoPath, path.dirname(maven.file)) : null,
      // what IntelliJ's settings change in how Maven runs, and what of them could not be taken
      intellij: ij && (ij.applies || ij.notes.length) ? { applies: ij.applies, said: ij.said, notes: ij.notes } : null,
      options: OPTIONS.map(({ id, args, label }) => ({ id, flag: args.join(' '), label })),
      profiles: pomProfiles(dir),
      // the environments with an application-<env> file: Start and Debug can take their values (the Values button)
      valueEnvs: envValues.listEnvs(dir),
      runEnv: runEnvFor(repoPath),
      container: containerFor(repoPath),
      ports,
      ...presetView(ports),
      run: run && {
        id: run.id,
        command: run.command,
        log: run.log,
        written: run.written,
        running: run.active,
        exitCode: run.exitCode,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        macro: run.macro || null,
        stepCommand: run.stepCommand || null,
        failedStep: run.failedStep || null,
        failedGit: Boolean(run.failedGit),
        stopped: run.cancelled,
      },
    };
  }

  ipcMain.handle('mvn-info', (_, repoPath) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return infoFor(repoPath);
  });

  // The values of each environment, from the application*.properties / .yml of the folder the commands run in.
  ipcMain.handle('mvn-env-values', (_, repoPath) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    const { dir, rel } = chosenDir(repoPath);
    return { dir: rel, ...envValues.readEnvValues(dir) };
  });

  // Saved per repository; used the next time Start or Debug runs.
  ipcMain.handle('mvn-set-ports', (_, repoPath, input) => {
    try {
      if (!isKnownRepo(repoPath)) throw new Error('Unknown repository');
      const ports = parsePorts(input);
      savePorts(repoPath, ports);
      return { ports, ...presetView(ports) };
    } catch (e) {
      return { error: e.message };
    }
  });

  // The environment variables of Start and Debug, saved for the repository (those switched off too): used the next time
  // one starts.
  ipcMain.handle('mvn-set-run-env', (_, repoPath, input) => {
    try {
      if (!isKnownRepo(repoPath)) throw new Error('Unknown repository');
      const clean = runEnv.cleanRunEnv(input);
      saveRunEnv(repoPath, clean.vars.length ? clean : null);
      return { runEnv: clean };
    } catch (e) {
      return { error: e.message };
    }
  });

  // The run configurations IntelliJ keeps for the repository that carry profiles or variables, to take them from.
  ipcMain.handle('mvn-intellij-configs', (_, repoPath) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return { configs: runEnv.readIntellijConfigs(repoPath, chosenDir(repoPath).dir) };
  });

  // The folder of the repository the commands run in (where its pom.xml is); '' is the root.
  ipcMain.handle('mvn-set-dir', (_, repoPath, rel) => {
    try {
      if (!isKnownRepo(repoPath)) throw new Error('Unknown repository');
      const run = runs.get(key(repoPath));
      if (run && run.active) throw new Error('A command is running in this repository. Stop it first.');
      const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (clean) {
        const dir = path.resolve(repoPath, clean);
        const inside = path.relative(path.resolve(repoPath), dir);
        if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('The folder has to be inside the repository');
        if (!fs.existsSync(path.join(dir, 'pom.xml'))) throw new Error('No pom.xml in that folder');
      }
      saveDir(repoPath, clean);
      return infoFor(repoPath);
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('mvn-run', async (_, repoPath, request = {}) => {
    try {
      const args = resolveArgs(repoPath, request);
      const { dir, rel } = chosenDir(repoPath);
      // the values chosen per environment and the variables go to the application only: a build or the tests run with
      // the files and the user's own environment
      const starts = SERVER_GOALS.test(args.join(' '));
      const values = starts ? envValues.cleanValues(request.values) : null;
      const appEnv = starts ? runEnvFor(repoPath) : null;
      const env = envValues.withValues(runEnv.withRunEnv(IS_WIN || request.external ? null : await shell.loginShellEnv(), appEnv), values);
      const k = key(repoPath);
      const current = runs.get(k);
      if (current && current.active) throw new Error('A command is already running in this repository. Stop it first.');
      const command = `mvn ${args.join(' ')}`;
      const maven = mavenFor(dir, repoPath);

      if (request.external) {
        shell.openInTerminal(dir, mavenArgv(dir, args, maven), 'maven');
        shell.stepBack();
        return { success: true, external: true, command, valuesLeft: Boolean(values), envLeft: runEnv.hasRunEnv(appEnv) };
      }

      const run = newRun(repoPath, command, `> ${command}${rel ? `   (in ${rel}/)` : ''}\n${mavenLine(maven)}${valuesLine(values, request.valuesNote)}${runEnv.runEnvLines(appEnv)}`, { maven });
      runs.set(k, run);
      announce();
      runStep(run, dir, args, env).then((code) => finishRun(run, code));
      return { success: true, command, startedAt: run.startedAt, log: run.log, id: run.id, written: run.written };
    } catch (e) {
      return { error: e.message };
    }
  });

  // The line under the output: a command typed there runs as Run runs, in the folder chosen, Stop ends it, and its
  // output comes after what is there. mvn (or mvnw) is the same Maven as Run (the project's mvnw when it has one), with
  // the variables Run gives it: Env and Values to spring-boot:run only. Anything else goes to the system shell, with the
  // variables of Env and the Values, as the application has them. Nothing carries to the next command: a cd or a
  // variable set in a line is gone after it.
  ipcMain.handle('mvn-line', async (_, repoPath, request = {}) => {
    try {
      if (!isKnownRepo(repoPath)) throw new Error('Unknown repository');
      const line = String(request.line || '').trim();
      if (!line) throw new Error('Type a command');
      if (line.length > MAX_LINE_CHARS || line.includes('\0')) throw new Error('The command is too long');
      const { dir, rel } = chosenDir(repoPath);
      const k = key(repoPath);
      const current = runs.get(k);
      if (current && current.active) throw new Error('A command is already running in this repository. Stop it first.');
      // mvn alone, without what only a shell reads (a pipe, a variable): Maven as Run starts it
      const maven = /^mvnw?(\.cmd)?(\s|$)/i.test(line) && !UNSAFE_CHARS.test(line);
      const args = maven ? tokenize(line.replace(/^\S+\s*/, '')) : null;
      const app = !maven || SERVER_GOALS.test(args.join(' '));
      const values = app ? envValues.cleanValues(request.values) : null;
      const appEnv = app ? runEnvFor(repoPath) : null;
      const env = envValues.withValues(runEnv.withRunEnv(IS_WIN ? null : await shell.loginShellEnv(), appEnv), values);
      // what the output had stays above it, with how that ended
      const before = current ? `${current.log}${current.exitCode !== null && !current.macro ? `\n[exit code ${current.exitCode}]\n` : ''}\n` : '';
      const mvnCall = maven ? mavenFor(dir, repoPath) : null;
      const header = `${IS_WIN ? '>' : '$'} ${line}${rel ? `   (in ${rel}/)` : ''}\n${mavenLine(mvnCall)}${valuesLine(values, request.valuesNote)}${runEnv.runEnvLines(appEnv)}`;
      const run = newRun(repoPath, line, (before + header).slice(-MAX_LOG_CHARS), { typed: true, maven: mvnCall });
      runs.set(k, run);
      announce();
      runStep(run, dir, args, env, null, maven ? null : line).then((code) => finishRun(run, code));
      return { success: true, command: line, startedAt: run.startedAt, log: run.log, id: run.id, written: run.written };
    } catch (e) {
      return { error: e.message };
    }
  });

  // The proxy this PC goes out through, for the dialog to offer: the system's, as Chromium finds it (a PAC script too),
  // else HTTPS_PROXY or HTTP_PROXY; and the hosts not behind it (NO_PROXY, and on Windows the list of its settings).
  ipcMain.handle('mvn-container-proxy', async () => {
    const env = IS_WIN ? process.env : await shell.loginShellEnv().catch(() => process.env);
    let url = '';
    let from = '';
    try {
      const rule = resolveProxy ? String(await resolveProxy('https://registry-1.docker.io')) : '';
      const m = /\b(PROXY|HTTPS)\s+([^\s;]+)/i.exec(rule);
      if (m) {
        url = `${m[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${m[2]}`;
        from = IS_WIN ? "Windows' settings" : "the system's settings";
      }
    } catch {
      // no proxy found that way
    }
    if (!url) {
      const name = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].find((n) => env[n]);
      if (name) {
        url = String(env[name]).trim();
        from = name.toUpperCase();
      }
    }
    const hosts = String(env.NO_PROXY || env.no_proxy || '').split(/[\s,;]+/);
    if (IS_WIN) hosts.push(...(await windowsProxyOverride()));
    const noProxy = [...new Set(hosts.map((h) => h.trim().replace(/^\*\./, '.')).filter((h) => h && h !== '<local>' && !NO_PROXY_ALWAYS.includes(h)))].join(',');
    return { url, from, noProxy };
  });

  // Start in container, the dialog: what it starts with, the engine that would run it, the jar built so far.
  ipcMain.handle('mvn-container-info', async (_, repoPath) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    const { dir } = chosenDir(repoPath);
    const jar = newestJar(dir);
    let engine;
    try {
      const call = await containers.engineCall();
      engine = { name: call.name, label: call.label };
    } catch (e) {
      engine = { error: e.message };
    }
    return { spec: containerFor(repoPath), engine, jar: jar ? { name: path.relative(dir, jar.file).split(path.sep).join('/'), ago: agoText(jar.mtime) } : null };
  });

  // What the dialog would run: its fields checked, the jar (the newest in target/), the engine's name.
  const containerCall = (repoPath, input, engineName) => {
    if (!isKnownRepo(repoPath)) throw new Error('Unknown repository');
    const { dir } = chosenDir(repoPath);
    const spec = cleanContainerSpec(input);
    const newest = newestJar(dir);
    return { spec, jar: newest ? newest.file : path.join(dir, 'target', '*.jar'), name: engineName === 'podman' ? 'podman' : 'docker' };
  };

  // The command the dialog would run, as the output shows it (the values of the variables hidden).
  ipcMain.handle('mvn-container-preview', (_, repoPath, input, engineName, withValues) => {
    try {
      const { spec, jar, name } = containerCall(repoPath, input, engineName);
      return { command: `${name} ${containerArgs(spec, jar, withValues ? {} : null).shown}` };
    } catch (e) {
      return { error: e.message };
    }
  });

  // The same with the values of the variables in it, to paste in a terminal (Copy).
  ipcMain.handle('mvn-container-copy', (_, repoPath, input, engineName, valuesRequest = {}) => {
    try {
      const { spec, jar, name } = containerCall(repoPath, input, engineName);
      const values = spec.values ? envValues.cleanValues(valuesRequest && valuesRequest.values) : null;
      return { command: pastedCommand(name, containerArgs(spec, jar, values).args) };
    } catch (e) {
      return { error: e.message };
    }
  });

  // Build first, switched on the bar: saved with the rest of what Start in container starts with.
  ipcMain.handle('mvn-container-build', (_, repoPath, on) => {
    try {
      if (!isKnownRepo(repoPath)) throw new Error('Unknown repository');
      saveContainer(repoPath, { ...(loadContainer(repoPath) || {}), build: Boolean(on) });
      return { spec: containerFor(repoPath) };
    } catch (e) {
      return { error: e.message };
    }
  });

  // Start in container: what the dialog chose, saved for the repository; then the jar built (when asked) and the
  // container started, its output in the page. Stop stops the container (stopRun).
  ipcMain.handle('mvn-container-run', async (_, repoPath, input = {}, valuesRequest = {}) => {
    try {
      if (!isKnownRepo(repoPath)) throw new Error('Unknown repository');
      const { dir, rel } = chosenDir(repoPath);
      if (!fs.existsSync(path.join(dir, 'pom.xml'))) throw new Error('No pom.xml in this repository');
      const spec = cleanContainerSpec(input);
      saveContainer(repoPath, spec);
      const k = key(repoPath);
      const current = runs.get(k);
      if (current && current.active) throw new Error('A command is already running in this repository. Stop it first.');
      const call = await containers.engineCall();
      const values = spec.values ? envValues.cleanValues(valuesRequest && valuesRequest.values) : null;
      const command = `container ${spec.name}`;
      const maven = mavenFor(dir, repoPath);
      const run = newRun(repoPath, command, `> Start in container: ${spec.name} (${spec.image}) with ${call.label}${rel ? `   (in ${rel}/)` : ''}\n`, { container: { name: spec.name, call, started: false }, maven });
      runs.set(k, run);
      announce();
      (async () => {
        let code = 0;
        // the jar: the one the build named (written now, or up to date), else the newest in target/
        let picked = null;
        let note = '';
        if (spec.build) {
          write(run, `\n\u25B6 mvn package -DskipTests\n${mavenLine(maven)}`);
          const began = Date.now();
          let said = '';
          code = await runStep(run, dir, ['package', '-DskipTests'], IS_WIN ? null : await shell.loginShellEnv(), (text) => (said = (said + text).slice(-200000)));
          const named = code === 0 && !run.cancelled ? jarSaid(said, dir) : null;
          if (named) {
            const mtime = fs.statSync(named).mtimeMs;
            picked = { file: named, mtime };
            // a second clock tick of slack: some file systems keep the time to the second
            note = mtime >= began - 2000 ? 'built now' : `up to date: Maven found nothing changed since it was built, ${agoText(mtime)}`;
          } else if (code === 0 && !run.cancelled) {
            picked = newestJar(dir);
            if (picked) note = `the newest in target/ (Maven did not say which jar it built), built ${agoText(picked.mtime)}`;
          }
        } else {
          picked = newestJar(dir);
          if (picked) note = `built ${agoText(picked.mtime)} (not built now: Build first is off)`;
        }
        const jar = picked && !run.cancelled ? picked.file : null;
        if (code === 0 && !run.cancelled && !jar) {
          write(run, '\nNo jar in target/: tick Build first, or build it (mvn package).\n');
          code = 1;
        }
        if (jar) write(run, `\nJar: ${path.relative(dir, jar).split(path.sep).join('/')}, ${note}\n`);
        if (jar && !run.cancelled) code = await clearOldContainer(run, call, spec.name);
        if (jar && code === 0 && !run.cancelled) {
          const { args, shown } = containerArgs(spec, jar, values);
          write(run, `\n\u25B6 ${call.name} ${shown}\n${valuesLine(values, valuesRequest && valuesRequest.valuesNote)}`);
          run.container.started = true;
          let said = '';
          code = await runEngine(run, call, args, (text) => (said = (said + text).slice(-20000)));
          // the engine could not get the image (125: docker's or podman's own error, not the application's)
          if (code === 125 && NET_TROUBLE.test(said)) write(run, pullHint(call.name));
        }
        finishRun(run, code);
      })();
      return { success: true, command, startedAt: run.startedAt, log: run.log, id: run.id, written: run.written, spec };
    } catch (e) {
      return { error: e.message };
    }
  });

  // My commands: read, saved (a new one, or one changed: its id kept) and deleted; the names are not repeated
  ipcMain.handle('mvn-commands', () => ({ commands: commandList() }));
  ipcMain.handle('mvn-command-save', (_, input) => {
    try {
      const command = cleanSavedCommand(input);
      const list = commandList();
      const i = list.findIndex((c) => c.id === command.id);
      if (list.some((c) => c.id !== command.id && c.name.toLowerCase() === command.name.toLowerCase())) throw new Error(`A command is already called ${command.name}`);
      if (i === -1 && list.length >= SAVED_LIMITS.count) throw new Error(`You already have ${SAVED_LIMITS.count} commands`);
      const next = i === -1 ? [...list, command] : list.map((c) => (c.id === command.id ? command : c));
      saveCommands(next);
      return { commands: next, id: command.id };
    } catch (e) {
      return { error: e.message };
    }
  });
  ipcMain.handle('mvn-command-delete', (_, id) => {
    const next = commandList().filter((c) => c.id !== String(id));
    saveCommands(next);
    return { commands: next };
  });

  ipcMain.handle('mvn-macros', () => ({ macros: macroList() }));

  ipcMain.handle('mvn-macro-save', (_, input) => {
    try {
      const macro = cleanMacro(input);
      const list = macroList();
      const i = list.findIndex((m) => m.id === macro.id);
      if (i === -1 && list.length >= MACRO_LIMITS.count) throw new Error(`You already have ${MACRO_LIMITS.count} macros`);
      const next = i === -1 ? [...list, macro] : list.map((m) => (m.id === macro.id ? macro : m));
      saveMacros(next);
      return { macros: next, id: macro.id };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('mvn-macro-delete', (_, id) => {
    const next = macroList().filter((m) => m.id !== String(id));
    saveMacros(next);
    return { macros: next };
  });

  // The steps of a macro one after the other, Maven's in the microservice's folder and git's in its repository; the
  // first that fails ends it. A Stop step ends what was running in the repository when the macro began (the app started
  // before, or the same macro), so a macro can stop the app, build and start it again. answers: what was asked when it
  // started (the names of new branches, what to do with local changes).
  ipcMain.handle('mvn-macro-run', async (_, repoPath, id, answers, valuesRequest = {}) => {
    try {
      if (!isKnownRepo(repoPath)) throw new Error('Unknown repository');
      const macro = macroList().find((m) => m.id === String(id));
      if (!macro) throw new Error('That macro is gone');
      const { dir, rel } = chosenDir(repoPath);
      // the folder each Maven step runs in: the one of Runs in, until a Go to a module step changes it
      const dirs = [];
      let here = dir;
      macro.steps.forEach((st, i) => {
        if (st.kind === 'module') {
          const target = path.resolve(repoPath, st.dir);
          const inside = path.relative(path.resolve(repoPath), target);
          if (inside.startsWith('..') || path.isAbsolute(inside) || !fs.existsSync(path.join(target, 'pom.xml'))) {
            throw new Error(`Step ${i + 1}: ${st.dir ? `this repository has no module ${st.dir}/ (a folder with a pom.xml)` : 'the root of this repository has no pom.xml'}`);
          }
          here = target;
        }
        dirs[i] = here;
      });
      const noPom = macro.steps.findIndex((st, i) => MAVEN_KINDS.has(st.kind) && !fs.existsSync(path.join(dirs[i], 'pom.xml')));
      if (noPom !== -1) throw new Error(dirs[noPom] === dir && !rel ? 'No pom.xml in this repository' : `Step ${noPom + 1}: no pom.xml in ${relOf(repoPath, dirs[noPom]) || 'the root'}`);
      const ctx = { answers: cleanAnswers(macro, answers), stash: null };
      if (macro.steps.some((st) => GIT_KINDS.has(st.kind)) && !(await new GitService(repoPath).isGitRepo())) throw new Error('This folder has no Git, and the macro has git steps');
      const k = key(repoPath);
      const previous = runs.get(k);
      const busy = Boolean(previous && previous.active);
      if (busy && !macro.steps.some((st) => st.kind === 'stop')) throw new Error('Something is running in this repository. Stop it first, or begin the macro with a Stop step.');
      const ports = portsFor(repoPath);
      const plan = macro.steps.map((st, i) => {
        if (st.kind === 'stop') return { stop: true, label: 'Stop what is running' };
        if (st.kind === 'module') return { module: dirs[i], label: st.dir ? `Go to the module ${st.dir}/` : 'Go to the root of the repository' };
        if (GIT_KINDS.has(st.kind)) return { git: st, label: gitStepLabel(st, ctx.answers, i) };
        // where it runs, when it is not where the macro began
        const where = dirs[i] === dir ? '' : `   (in ${relOf(repoPath, dirs[i]) || 'the root'}/)`.replace('the root/', 'the root');
        return { args: stepArgs(st, ports), dir: dirs[i], label: `mvn ${stepArgs(st, ports).join(' ')}${where}` };
      });
      const env = IS_WIN ? null : await shell.loginShellEnv();
      const values = envValues.cleanValues(valuesRequest && valuesRequest.values);
      const appEnv = runEnvFor(repoPath);
      const maven = plan.some((p) => p.args) ? mavenFor(dir, repoPath) : null;
      const run = newRun(repoPath, macro.name, `> macro ${macro.name}: ${plan.length} step${plan.length === 1 ? '' : 's'}${rel ? `   (in ${rel}/)` : ''}\n${mavenLine(maven)}`, {
        // marks: when each step began, and how long it took once it ended (for the list of steps by the output)
        macro: { id: macro.id, name: macro.name, step: 0, total: plan.length, steps: plan.map((p) => p.label), marks: [] },
        maven,
      });
      if (busy) previous.muted = true;
      runs.set(k, run);
      announce();
      (async () => {
        let code = 0;
        let failedStep = null;
        for (let i = 0; i < plan.length && !run.cancelled; i++) {
          const p = plan[i];
          run.macro.step = i + 1;
          run.macro.marks[i] = { at: Date.now() };
          const ended = () => (run.macro.marks[i].ms = Date.now() - run.macro.marks[i].at);
          run.stepCommand = p.label;
          send('mvn-step', { repo: repoPath, step: i + 1, total: plan.length, command: p.label, git: Boolean(p.git), marks: run.macro.marks });
          announce();
          write(run, `\n▶ ${i + 1}/${plan.length}  ${p.label}\n`);
          if (p.stop) {
            if (busy && previous.active) {
              write(run, `Stopping ${previous.command}...\n`);
              await stopRun(previous);
              await Promise.race([previous.done, new Promise((r) => setTimeout(r, 15000))]);
              write(run, 'Stopped.\n');
            } else write(run, 'Nothing was running.\n');
            ended();
            continue;
          }
          if (p.module) {
            write(run, `The Maven steps after this one run in ${relOf(repoPath, p.module) ? `${relOf(repoPath, p.module)}/` : 'the root of the repository'}.\n`);
            ended();
            continue;
          }
          if (p.git) code = await runGitStep(run, p.git, i, ctx);
          else {
            // the step that starts the application gets the values chosen per environment and the variables; the
            // others, the files
            const starts = SERVER_GOALS.test(p.args.join(' '));
            if (starts) write(run, valuesLine(values, valuesRequest.valuesNote) + runEnv.runEnvLines(appEnv));
            // Maven as the folder of the step finds it (its mvnw, from a module: ../mvnw)
            if (p.dir !== dir) run.maven = mavenFor(p.dir, repoPath);
            else run.maven = maven;
            code = await runStep(run, p.dir, p.args, starts ? envValues.withValues(runEnv.withRunEnv(env, appEnv), values) : env);
            write(run, `[exit code ${code}]\n`);
          }
          ended();
          if (code !== 0) {
            // stopped is not failed: Stop ends the step with the code the kill gives it
            if (!run.cancelled) failedStep = i + 1;
            break;
          }
        }
        finishRun(run, code, { failedStep, failedGit: Boolean(failedStep && plan[failedStep - 1].git) });
      })();
      return { success: true, command: macro.name, startedAt: run.startedAt, log: run.log, id: run.id, written: run.written, macro: run.macro };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('mvn-running', () => runningRepos());

  ipcMain.handle('mvn-stop', async (_, repoPath) => {
    const run = runs.get(key(String(repoPath)));
    if (!run || !run.active) return { error: 'Nothing is running' };
    await stopRun(run);
    return { success: true };
  });

  ipcMain.handle('mvn-clear', (_, repoPath) => {
    const run = runs.get(key(String(repoPath)));
    if (run && !run.active) runs.delete(key(String(repoPath)));
    // one going on carries on: only what it said so far goes (written still counts all of it)
    else if (run) run.log = '';
    return true;
  });

  const stopAll = () =>
    Promise.all(
      [...runs.values()].filter((r) => r.active).map((r) => stopRun(r, 3))
    );
  return { stopAll };
}

module.exports = { registerMaven, PRESETS, OPTIONS, DEFAULT_PORTS, parsePorts, tokenize, buildScript, terminalScript, pomProfiles, withOptions, findWrapper, mavenFor, mavenArgs, pomFolders, cleanMacro, cleanContainerSpec, containerArgs, pastedCommand, newestJar, jarSaid, pomJava };
