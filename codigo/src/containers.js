// Containers page: the Docker or Podman command line, started straight from the app (no shell in between) with the
// environment of the user's shell (see shell.js). Docker is used when it runs, Podman otherwise; their output is read
// into the same shape. Everything the window sends is checked before it reaches the engine.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcMain, shell: electronShell } = require('electron');
const shell = require('./shell');

const REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/; // a container id or name
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_.]{0,199}$/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CONTAINER_PATH = /^\/[^\0:]{0,500}$/;
const RESTART = ['no', 'unless-stopped', 'always', 'on-failure'];
const PULL_TIMEOUT = 30 * 60 * 1000; // a first run may download a big image

// -- The commands the page runs, shown at the bottom of it (the list refresh is left out: it runs every few seconds).
// Values of variables that look like secrets are hidden in what is shown.
let notify = () => {};
let cmdSeq = 0;
const SECRET_KEY = /pass|secret|token|key|pwd|credential/i;

function shownCommand(name, args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    let a = String(args[i]);
    const prev = args[i - 1];
    const env = (prev === '-e' || prev === '--env') ? a : a.startsWith('--env=') ? a.slice(6) : null;
    if (env !== null) {
      const eq = env.indexOf('=');
      if (eq > 0 && SECRET_KEY.test(env.slice(0, eq))) a = a.slice(0, a.length - (env.length - eq - 1)) + '••••';
    }
    out.push(/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  }
  return [name, ...out].join(' ');
}

// The values of those variables, to hide them also where the engine repeats the command (an error message).
function secretValues(args) {
  const values = [];
  args.forEach((a, i) => {
    const env = (args[i - 1] === '-e' || args[i - 1] === '--env') ? String(a) : String(a).startsWith('--env=') ? String(a).slice(6) : null;
    const eq = env ? env.indexOf('=') : -1;
    if (eq > 0 && SECRET_KEY.test(env.slice(0, eq)) && env.length > eq + 1) values.push(env.slice(eq + 1));
  });
  return values;
}

const hide = (text, values) => values.reduce((t, v) => t.split(v).join('••••'), String(text || ''));

const tail = (text, max = 4000) => {
  const t = String(text || '').replace(/\s+$/, '');
  return t.length > max ? `...${t.slice(-max)}` : t;
};

const ENGINES = ['docker', 'podman'];
const ENGINE_NAMES = { docker: 'Docker', podman: 'Podman' };
let engine = null; // the one that answered last; asked first next time

// Where the installers put them on Windows, for when they are not on the PATH.
const WINDOWS_PLACES = {
  docker: ['Docker\\Docker\\resources\\bin\\docker.exe'],
  podman: ['RedHat\\Podman\\podman.exe'],
};

function executable(name, env) {
  if (!shell.IS_WIN) return name;
  const onPath = String(env.PATH || env.Path || '').split(';').filter(Boolean).some((dir) => fs.existsSync(path.join(dir, `${name}.exe`)));
  if (onPath) return name;
  const found = [process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean)
    .flatMap((dir) => WINDOWS_PLACES[name].map((rel) => path.join(dir, rel)))
    .find((f) => fs.existsSync(f));
  return found || name;
}

// Runs docker or podman and collects what it prints. One that is not installed rejects with code 'missing'.
// log: 'out' shows the command and what it printed; 'quiet' only the command and how it ended.
async function cli(args, { timeout = 30000, name = engine || 'docker', log = null } = {}) {
  const env = await shell.loginShellEnv();
  const id = log ? ++cmdSeq : 0;
  if (log) notify({ id, start: true, text: shownCommand(name, args), at: Date.now() });
  const ended = (r) => {
    const secrets = secretValues(args);
    if (log) notify({ id, end: true, code: r.code, out: log === 'out' ? tail(hide(r.stdout, secrets)) : '', err: tail(hide(r.stderr, secrets)) });
    return r;
  };
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(executable(name, env), args, { env, windowsHide: true });
    } catch (e) {
      reject(Object.assign(new Error(e.message), { code: 'missing' }));
      return;
    }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (log) notify({ id, end: true, code: null, err: e.code === 'ENOENT' ? `${name} was not found` : e.message });
      reject(Object.assign(new Error(e.message), { code: e.code === 'ENOENT' ? 'missing' : e.code }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(ended({ code, stdout, stderr }));
    });
  });
}

// "docker: Error response from daemon: Conflict. The container name ..." -> "Conflict. The container name ..."
function dockerError(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^See '.*--help'/.test(l) && !/^Run '.*--help'/.test(l));
  return lines.join('\n').replace(/^(docker: |podman: )?(Error response from daemon: )?/i, '').replace(/^Error: /, '') || `${ENGINE_NAMES[engine] || 'Docker'} failed`;
}

const NOT_INSTALLED = 'Neither Docker nor Podman was found. Install Docker Desktop or Podman (or add docker or podman to the PATH).';

// Ports as "docker ps" prints them: "0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp, 6379/tcp". The IPv4 and IPv6
// copies of one mapping count once; a port that is not published has no host port.
function parsePorts(text) {
  const seen = new Set();
  const out = [];
  for (const part of String(text || '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /(?:.*:(\d+)(?:-\d+)?->)?(\d+)(?:-\d+)?\/(tcp|udp|sctp)$/.exec(part);
    if (!m) continue;
    const entry = { host: m[1] ? Number(m[1]) : null, container: Number(m[2]), proto: m[3] };
    const k = `${entry.host}:${entry.container}/${entry.proto}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(entry);
    }
  }
  return out;
}

function parseLabels(text) {
  const labels = {};
  for (const pair of String(text || '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) labels[pair.slice(0, i).trim()] = pair.slice(i + 1);
  }
  return labels;
}

// Whether one engine is installed and answering. Podman has no daemon of its own on Linux; elsewhere it runs in a
// machine (a VM), and "podman info" fails while that machine is stopped.
async function engineStatus(name) {
  try {
    if (name === 'podman') {
      const r = await cli(['info', '--format', 'json'], { timeout: 20000, name });
      let info = {};
      try {
        info = JSON.parse(r.stdout || '{}');
      } catch {
        // no JSON while the machine is stopped
      }
      const version = (info.version && info.version.Version) || '';
      if (r.code !== 0) return { engine: name, installed: true, running: false, error: dockerError(r.stderr) };
      return { engine: name, installed: true, running: true, client: version, server: version };
    }
    const r = await cli(['version', '--format', '{{json .}}'], { timeout: 15000, name });
    let info = {};
    try {
      info = JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
    } catch {
      // older docker: no JSON when the daemon is down
    }
    const client = (info.Client && info.Client.Version) || '';
    const server = (info.Server && info.Server.Version) || '';
    if (r.code !== 0 || !server) return { engine: name, installed: true, running: false, client, error: dockerError(r.stderr) };
    return { engine: name, installed: true, running: true, client, server };
  } catch (e) {
    return { engine: name, installed: e.code !== 'missing', running: false, error: e.code === 'missing' ? '' : e.message };
  }
}

// The engine that answers, asking first the one that answered last time. When none runs, the first one installed
// is shown as not running (Start opens it).
let lastStatus = '';

function noteStatus(s) {
  const text = s.running
    ? `${ENGINE_NAMES[s.engine]} ${s.server || ''} answers: the list comes from ${s.engine}`.replace('  ', ' ')
    : s.installed
      ? `${ENGINE_NAMES[s.engine]} is installed but not running${s.error ? `: ${s.error.split('\n')[0]}` : ''}`
      : s.error;
  if (text !== lastStatus) {
    lastStatus = text;
    notify({ info: text, at: Date.now() });
  }
  return s;
}

async function status() {
  return noteStatus(await findEngine());
}

async function findEngine() {
  const order = engine ? [engine, ...ENGINES.filter((e) => e !== engine)] : ENGINES;
  const installed = [];
  for (const name of order) {
    const s = await engineStatus(name);
    if (s.running) {
      engine = name;
      return s;
    }
    if (s.installed) installed.push(s);
  }
  if (installed.length) {
    engine = installed[0].engine;
    return installed[0];
  }
  return { engine: null, installed: false, running: false, error: NOT_INSTALLED };
}

// "Up 2 hours", "Exited (0) 3 days ago": Podman's JSON may leave the status text empty.
function since(seconds) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - Number(seconds || 0)));
  if (s < 60) return 'Less than a minute';
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86400), 'day');
}

// One container of "docker ps --format {{json .}}" or of "podman ps --format json", in one shape. Podman gives the
// names, ports and labels as lists and objects where Docker gives text; a pod's infra container is left out.
function containerRow(c) {
  const labels = c.Labels && typeof c.Labels === 'object' ? c.Labels : parseLabels(c.Labels);
  const state = String(c.State || (/^Up/.test(c.Status || '') ? 'running' : 'exited')).toLowerCase();
  const ports = Array.isArray(c.Ports)
    ? dedupePorts(c.Ports.map((p) => ({ host: Number(p.host_port || p.hostPort) || null, container: Number(p.container_port || p.containerPort), proto: p.protocol || 'tcp' })).filter((p) => p.container))
    : parsePorts(c.Ports);
  let status = c.Status || '';
  if (!status) {
    const at = (v) => Number(v) > 0; // a time Podman did not fill in comes as 0
    if (state === 'running') status = at(c.StartedAt) ? `Up ${since(c.StartedAt)}` : 'Up';
    else if (state === 'exited') status = `Exited (${c.ExitCode || 0})${at(c.ExitedAt) ? ` ${since(c.ExitedAt)} ago` : ''}`;
    else status = state.charAt(0).toUpperCase() + state.slice(1);
  }
  const id = String(c.ID || c.Id || '');
  return {
    id,
    short: id.slice(0, 12),
    name: Array.isArray(c.Names) ? c.Names[0] || '' : String(c.Names || '').split(',')[0],
    image: c.Image,
    state,
    status,
    created: typeof c.CreatedAt === 'string' && /\d{4}-\d\d-\d\d/.test(c.CreatedAt) ? c.CreatedAt : c.Created ? new Date(Number(c.Created) * 1000).toISOString() : c.CreatedAt || '',
    ports,
    project: labels['com.docker.compose.project'] || labels['io.podman.compose.project'] || c.PodName || '',
    service: labels['com.docker.compose.service'] || labels['io.podman.compose.service'] || '',
    // a Podman pod without Compose labels: grouped under the pod's name
    pod: Boolean(c.PodName) && !labels['com.docker.compose.project'] && !labels['io.podman.compose.project'],
  };
}

function dedupePorts(list) {
  const seen = new Set();
  return list.filter((p) => {
    const k = `${p.host}:${p.container}/${p.proto}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function list() {
  const podman = engine === 'podman';
  const r = await cli(podman ? ['ps', '-a', '--format', 'json'] : ['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
  if (r.code !== 0) throw new Error(dockerError(r.stderr));
  const raw = podman ? JSON.parse(r.stdout.trim() || '[]') : r.stdout.split('\n').filter((l) => l.trim()).map((line) => JSON.parse(line));
  return raw.filter((c) => !c.IsInfra).map(containerRow);
}

async function images() {
  const r = await cli(['images', '--format', '{{.Repository}}:{{.Tag}}']);
  if (r.code !== 0) return [];
  return [...new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !l.startsWith('<none>'))
    .map((l) => l.replace(/:<none>$/, '')))].sort();
}

// What the details popup shows, from "docker inspect": state and health, how it was started, its environment,
// networks, ports, mounts and labels; the whole JSON too.
function details(c) {
  const labels = (c.Config && c.Config.Labels) || {};
  const state = c.State || {};
  const host = c.HostConfig || {};
  const config = c.Config || {};
  const net = c.NetworkSettings || {};
  const health = state.Health || state.Healthcheck || null;
  const lastCheck = health && Array.isArray(health.Log) && health.Log.length ? health.Log[health.Log.length - 1] : null;
  return {
    id: c.Id,
    short: String(c.Id || '').slice(0, 12),
    name: String(c.Name || '').replace(/^\//, ''),
    image: config.Image || '',
    imageId: String(c.Image || '').replace(/^sha256:/, '').slice(0, 12),
    created: c.Created,
    state: {
      status: state.Status || '',
      running: Boolean(state.Running),
      startedAt: state.StartedAt,
      finishedAt: state.FinishedAt,
      exitCode: state.ExitCode,
      oomKilled: Boolean(state.OOMKilled),
      error: state.Error || '',
      restarts: c.RestartCount || 0,
      health: health ? { status: health.Status, failingStreak: health.FailingStreak || 0, last: lastCheck ? String(lastCheck.Output || '').trim().slice(0, 2000) : '' } : null,
    },
    restart: host.RestartPolicy && host.RestartPolicy.Name ? host.RestartPolicy.Name : 'no',
    command: [...words(config.Entrypoint), ...words(config.Cmd)].join(' '),
    workingDir: config.WorkingDir || '',
    user: config.User || '',
    limits: { memory: host.Memory || 0, cpus: host.NanoCpus ? host.NanoCpus / 1e9 : 0 },
    env: (config.Env || []).map((e) => {
      const i = e.indexOf('=');
      return i === -1 ? { key: e, value: '' } : { key: e.slice(0, i), value: e.slice(i + 1) };
    }),
    ports: Object.entries(net.Ports || {}).map(([inner, binds]) => ({
      container: inner,
      host: [...new Set((binds || []).map((b) => Number(b.HostPort)).filter(Boolean))],
    })).sort((a, b) => parseInt(a.container, 10) - parseInt(b.container, 10)),
    networks: Object.entries(net.Networks || {}).map(([name, n]) => ({ name, ip: n.IPAddress || '', gateway: n.Gateway || '', aliases: (n.Aliases || []).filter((a) => !String(c.Id || '').startsWith(a)) })),
    mounts: (c.Mounts || []).map((m) => ({ type: m.Type, source: m.Name || m.Source || '', target: m.Destination, rw: m.RW !== false })),
    labels: Object.entries(labels).sort((a, b) => a[0].localeCompare(b[0])),
    compose: labels['com.docker.compose.project'] || labels['io.podman.compose.project']
      ? {
        project: labels['com.docker.compose.project'] || labels['io.podman.compose.project'],
        service: labels['com.docker.compose.service'] || labels['io.podman.compose.service'] || '',
        workingDir: labels['com.docker.compose.project.working_dir'] || '',
        files: labels['com.docker.compose.project.config_files'] || '',
      }
      : null,
  };
}

// Podman gives the entrypoint as one string, Docker as a list.
const words = (v) => (Array.isArray(v) ? v : v ? [String(v)] : []);

function ref(value) {
  const v = String(value || '');
  if (!REF.test(v)) throw new Error('Unknown container');
  return v;
}

const port = (value, what) => {
  const text = String(value ?? '').trim();
  if (!/^\d{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) throw new Error(`${what} must be a number between 1 and 65535`);
  return Number(text);
};

// The same quoting rules as a command line: "two words" and 'two words' stay one argument.
function tokenize(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// "docker run -d ..." from the form, every part checked. Returns the arguments after "docker".
function runArgs(spec = {}) {
  const image = String(spec.image || '').trim();
  if (!IMAGE.test(image)) throw new Error('Type an image, for example postgres:16');
  const args = ['run', '-d'];
  const name = String(spec.name || '').trim();
  if (name) {
    if (!REF.test(name)) throw new Error('Use only letters, digits, dots, dashes and underscores in the name');
    args.push('--name', name);
  }
  for (const p of Array.isArray(spec.ports) ? spec.ports : []) {
    const host = String(p.host ?? '').trim();
    const container = String(p.container ?? '').trim();
    if (!host && !container) continue;
    const proto = p.proto === 'udp' ? '/udp' : '';
    args.push('-p', `${host ? `${port(host, 'The PC port')}:` : ''}${port(container, 'The container port')}${proto}`);
  }
  for (const e of Array.isArray(spec.env) ? spec.env : []) {
    const key = String(e.key ?? '').trim();
    if (!key) continue;
    if (!ENV_KEY.test(key)) throw new Error(`"${key}" is not a valid variable name`);
    const value = String(e.value ?? '');
    if (value.length > 4000 || value.includes('\0')) throw new Error(`The value of ${key} is too long`);
    args.push('-e', `${key}=${value}`);
  }
  for (const v of Array.isArray(spec.volumes) ? spec.volumes : []) {
    const source = String(v.source ?? '').trim();
    const target = String(v.target ?? '').trim();
    if (!source && !target) continue;
    if (!(path.isAbsolute(source) || VOLUME_NAME.test(source))) throw new Error(`"${source}" must be a folder on this PC (full path) or a volume name`);
    if (!CONTAINER_PATH.test(target)) throw new Error(`"${target}" must be a path inside the container, starting with /`);
    args.push('-v', `${source}:${target}`);
  }
  const restart = String(spec.restart || 'no');
  if (!RESTART.includes(restart)) throw new Error('Unknown restart choice');
  if (restart !== 'no') args.push('--restart', restart);
  args.push(image);
  const command = String(spec.command || '').trim();
  if (command.length > 2000) throw new Error('The command is too long');
  if (command) args.push(...tokenize(command));
  return args;
}

// Docker Desktop, or the Podman machine, for when the engine is installed but not running.
async function startDesktop() {
  if (engine === 'podman') {
    const env = await shell.loginShellEnv();
    if (process.platform === 'linux') throw new Error('Podman needs no start on Linux: check "podman info" in a terminal');
    spawn(executable('podman', env), ['machine', 'start'], { env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    notify({ id: ++cmdSeq, start: true, text: 'podman machine start', at: Date.now() });
    notify({ id: cmdSeq, end: true, code: 0, out: 'Started in the background: the list fills in once the machine is up' });
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Docker'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (shell.IS_WIN) {
    const exe = [process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean)
      .map((dir) => path.join(dir, 'Docker', 'Docker', 'Docker Desktop.exe'))
      .find((f) => fs.existsSync(f));
    if (!exe) throw new Error('Docker Desktop was not found');
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  throw new Error('Start Docker from your system (for example: sudo systemctl start docker)');
}

// A command typed in the page: arguments for the engine, run without a shell. The engine's own name may lead.
// Commands that need a keyboard are sent to the container's terminal instead.
const MAX_TYPED = 2000;
function typedArgs(text) {
  const line = String(text || '').trim();
  if (!line) throw new Error('Type a command, for example: ps -a');
  if (line.length > MAX_TYPED || line.includes('\0')) throw new Error('The command is too long');
  const args = tokenize(line);
  if (ENGINES.includes(args[0])) args.shift();
  if (!args.length) throw new Error('Type what to run after the engine, for example: ps -a');
  if (args[0] === 'attach' || args.some((a) => /^-(i|t|it|ti)$/.test(a) || a === '--interactive' || a === '--tty')) {
    throw new Error('That needs a keyboard: use Terminal in the menu of the container');
  }
  return args;
}

function registerContainers({ getWindow }) {
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  notify = (payload) => send('dk-cmd', payload);

  // One typed command at a time; Stop ends it (a "logs -f" runs until then).
  let typed = null;
  ipcMain.handle('dk-cmd-run', async (_, text) => {
    try {
      if (typed) throw new Error('A command is still running. Stop it first.');
      const args = typedArgs(text);
      const name = engine || 'docker';
      const env = await shell.loginShellEnv();
      const id = ++cmdSeq;
      notify({ id, start: true, typed: true, text: shownCommand(name, args), at: Date.now() });
      const child = spawn(executable(name, env), args, { env, windowsHide: true, detached: !shell.IS_WIN, stdio: ['ignore', 'pipe', 'pipe'] });
      const current = { child };
      typed = current;
      const out = (chunk) => notify({ id, chunk: chunk.toString('utf8') });
      child.stdout.on('data', out);
      child.stderr.on('data', out);
      child.on('error', (e) => {
        if (typed === current) typed = null;
        notify({ id, end: true, code: null, err: e.code === 'ENOENT' ? `${name} was not found` : e.message });
      });
      child.on('close', (code, signal) => {
        if (typed === current) typed = null;
        notify({ id, end: true, code, stopped: Boolean(signal) });
      });
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });
  ipcMain.handle('dk-cmd-stop', async () => {
    if (!typed) return { error: 'Nothing is running' };
    await shell.killTree(typed.child);
    return { success: true };
  });
  ipcMain.handle('dk-engine', () => engine || 'docker');

  // One log stream at a time: the container whose logs are open.
  let logs = null;
  const stopLogs = () => {
    if (logs && logs.child) logs.child.kill();
    logs = null;
  };

  ipcMain.handle('dk-state', async () => {
    const s = await status();
    if (!s.running) return { status: s, containers: [] };
    try {
      return { status: s, containers: await list() };
    } catch (e) {
      return { status: { ...s, running: false, error: e.message }, containers: [] };
    }
  });

  ipcMain.handle('dk-images', () => images().catch(() => []));

  ipcMain.handle('dk-inspect', async (_, id) => {
    try {
      const r = await cli(['inspect', ref(id)], { log: 'quiet' });
      if (r.code !== 0) return { error: dockerError(r.stderr) };
      const raw = JSON.parse(r.stdout);
      if (!Array.isArray(raw) || !raw[0]) return { error: 'Container not found' };
      return { details: details(raw[0]), json: JSON.stringify(raw[0], null, 2) };
    } catch (e) {
      return { error: e.code === 'missing' ? NOT_INSTALLED : e.message };
    }
  });

  // What it uses right now: CPU, memory, network and disk, processes. Only for a running container.
  ipcMain.handle('dk-stats', async (_, id) => {
    try {
      const podman = engine === 'podman';
      const r = await cli(['stats', '--no-stream', '--format', podman ? 'json' : '{{json .}}', ref(id)], { timeout: 15000 });
      if (r.code !== 0) return { error: dockerError(r.stderr) };
      const s = podman ? [].concat(JSON.parse(r.stdout.trim() || '[]'))[0] || {} : JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
      return {
        cpu: s.CPUPerc || s.cpu_percent || '',
        memory: s.MemUsage || s.mem_usage || '',
        memoryPercent: s.MemPerc || s.mem_percent || '',
        net: s.NetIO || s.net_io || '',
        disk: s.BlockIO || s.block_io || '',
        pids: String(s.PIDs || s.pids || ''),
      };
    } catch (e) {
      return { error: e.code === 'missing' ? NOT_INSTALLED : e.message };
    }
  });

  ipcMain.handle('dk-action', async (_, id, verb) => {
    try {
      const target = ref(id);
      const args = { start: ['start', target], stop: ['stop', target], restart: ['restart', target], remove: ['rm', '-f', target] }[verb];
      if (!args) return { error: 'Unknown action' };
      const r = await cli(args, { timeout: 60000, log: 'out' });
      return r.code === 0 ? { success: true } : { error: dockerError(r.stderr) };
    } catch (e) {
      return { error: e.code === 'missing' ? NOT_INSTALLED : e.message };
    }
  });

  ipcMain.handle('dk-run-preview', (_, spec) => {
    try {
      return { command: [engine || 'docker', ...runArgs(spec)].map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ') };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('dk-run', async (_, spec) => {
    try {
      const r = await cli(runArgs(spec), { timeout: PULL_TIMEOUT, log: 'out' });
      if (r.code !== 0) return { error: dockerError(r.stderr) };
      return { success: true, id: r.stdout.trim().split('\n').pop() };
    } catch (e) {
      return { error: e.code === 'missing' ? NOT_INSTALLED : e.message };
    }
  });

  ipcMain.handle('dk-logs-start', async (_, id) => {
    try {
      const target = ref(id);
      stopLogs();
      const env = await shell.loginShellEnv();
      const logArgs = ['logs', '-f', '--tail', '500', target];
      const child = spawn(executable(engine || 'docker', env), logArgs, { env, windowsHide: true });
      const cmdId = ++cmdSeq;
      notify({ id: cmdId, start: true, text: shownCommand(engine || 'docker', logArgs), at: Date.now() });
      const current = { id: target, child };
      logs = current;
      const out = (chunk) => {
        if (logs === current) send('dk-logs', { id: target, text: chunk.toString('utf8') });
      };
      child.stdout.on('data', out);
      child.stderr.on('data', out);
      child.on('error', (e) => send('dk-logs', { id: target, text: `\n[could not read the logs: ${e.message}]\n` }));
      child.on('close', (code, signal) => {
        if (logs === current) logs = null;
        send('dk-logs-end', { id: target, code });
        notify({ id: cmdId, end: true, code, out: signal ? 'The logs were closed' : '' });
      });
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('dk-logs-stop', () => {
    stopLogs();
    return true;
  });

  // A shell inside the container, in a window of its own: bash when the image has it, sh otherwise.
  ipcMain.handle('dk-terminal', async (_, id) => {
    try {
      const target = ref(id);
      const name = engine || 'docker';
      const exe = executable(name, await shell.loginShellEnv());
      const execArgs = ['exec', '-it', target, 'sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'];
      shell.openInTerminal(os.homedir(), [exe, ...execArgs], name);
      notify({ id: ++cmdSeq, start: true, text: shownCommand(name, execArgs), at: Date.now() });
      notify({ id: cmdSeq, end: true, code: 0, out: `Opened in a ${shell.IS_WIN ? 'PowerShell' : 'Terminal'} window` });
      shell.stepBack();
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('dk-open-port', (_, value) => {
    try {
      const url = `http://localhost:${port(value, 'The port')}`;
      const back = shell.stepBack();
      return electronShell.openExternal(url).then(
        () => ({ success: true }),
        (e) => {
          back();
          return { error: `The browser could not open it: ${e.message}` };
        },
      );
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('dk-start-desktop', async () => {
    try {
      await startDesktop();
      shell.stepBack();
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });

  return {
    stop: () => {
      stopLogs();
      if (typed) shell.killTree(typed.child);
    },
  };
}

module.exports = { registerContainers, parsePorts, parseLabels, runArgs, dockerError, tokenize, details, containerRow, shownCommand, typedArgs };
