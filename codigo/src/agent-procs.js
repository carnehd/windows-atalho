// The Java processes the arrancador agent started (their numbers are in the .pid files of <tmp>/arranque-<name>/, agent-logs.js): which
// are still there, whether a number is still the one the agent started (a number can be given to another process once the first has
// ended), and stopping one. A number is only touched if the process is Java (or its build wrapper) and began before the agent wrote
// the number down. No Electron in this file.
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const JAVA = /(^|[\\/"\s])javaw?(\.exe)?("|\s|$)/i;
const WRAPPER = /(^|[\\/"\s])(mvnw?|gradlew?)(\.cmd|\.bat)?("|\s|$)/i;
const REUSE_SLACK_MS = 5000; // ps counts whole seconds; the number is written right after the start
const MAX_TREE = 50;

const run = (file, args, timeout = 6000) => new Promise((resolve) => {
  execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve({ err, out: String(stdout || '') }));
});

// The command as it is shown: a password or a token given as an option is not (-Dspring.datasource.password=..., --api.key=...).
function maskCommand(cmd) {
  return String(cmd)
    .replace(/((?:-D|--)[^\s=]*?(?:pass|secret|token|key|credential|auth)[^\s=]*)=(?:"[^"]*"|'[^']*'|\S+)/gi, '$1=***')
    .slice(0, 400);
}

const isJavaCommand = (command) => JAVA.test(command) || WRAPPER.test(command);

const aliveByNumber = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
};

// pid -> { startedMs, command }
async function posixInfo(pids) {
  const map = new Map();
  // All of them, then only these: `ps -p a,b` on macOS prints nothing at all when one of the numbers is not a process (a .pid of
  // something that ended is the usual case).
  const wanted = new Set(pids);
  const { out } = await run('ps', ['-ww', '-axo', 'pid=,lstart=,command=']);
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line);
    if (!m || !wanted.has(Number(m[1]))) continue;
    const t = Date.parse(m[2].replace(/\s+/g, ' '));
    map.set(Number(m[1]), { startedMs: Number.isFinite(t) ? t : null, command: m[3] });
  }
  return map;
}

async function windowsInfo(pids) {
  const map = new Map();
  const filter = pids.map((p) => `ProcessId=${Number(p)}`).join(' OR ');
  const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.CommandLine }`;
  const { out } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 15000);
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+)\|(\d+)\|(.*)$/.exec(line.trim());
    if (m) map.set(Number(m[1]), { startedMs: Number(m[2]), command: m[3] });
  }
  return map;
}

// pid -> [ports it listens on], where lsof is (macOS and Linux)
async function listeningPorts(pids) {
  const map = new Map();
  if (IS_WIN || !pids.length) return map;
  const { out } = await run('lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) current = Number(line.slice(1));
    else if (line.startsWith('n') && current) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1));
      if (port > 0 && port < 65536) {
        const list = map.get(current) || [];
        if (!list.includes(port)) list.push(port);
        map.set(current, list);
      }
    }
  }
  for (const list of map.values()) list.sort((a, b) => a - b);
  return map;
}

// For each { pid, at } (at: when the agent wrote the number), its state:
//   running  a process of Java (or its build wrapper) that began before the number was written: the agent's
//   other    the number is there, and it is some other process (the agent's has ended, or the number was given again)
//   stopped  nothing has that number
//   unknown  something has it, and the system would not say what
async function inspect(entries) {
  const result = new Map();
  const pids = [...new Set(entries.map((e) => e.pid))];
  if (!pids.length) return result;
  const info = IS_WIN ? await windowsInfo(pids) : await posixInfo(pids);
  const ports = await listeningPorts([...info.keys()]);
  for (const e of entries) {
    const i = info.get(e.pid);
    if (!i) {
      result.set(e.pid, { state: aliveByNumber(e.pid) ? 'unknown' : 'stopped' });
      continue;
    }
    const ours = i.startedMs === null || i.startedMs <= e.at + REUSE_SLACK_MS;
    result.set(e.pid, {
      state: ours && isJavaCommand(i.command) ? 'running' : 'other',
      command: maskCommand(i.command),
      startedMs: i.startedMs,
      ports: ports.get(e.pid) || [],
    });
  }
  return result;
}

// The processes under a number (a wrapper that started Java), from ps.
async function descendants(pid) {
  if (IS_WIN) return [];
  const { out } = await run('ps', ['-axo', 'pid=,ppid=']);
  const kids = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const list = kids.get(Number(m[2])) || [];
    list.push(Number(m[1]));
    kids.set(Number(m[2]), list);
  }
  const found = [];
  const queue = [pid];
  while (queue.length && found.length < MAX_TREE) {
    for (const k of kids.get(queue.shift()) || []) {
      found.push(k);
      queue.push(k);
    }
  }
  return found;
}

// Asks it to end (SIGTERM: Spring closes its connections), or forces it (SIGKILL): the process and what it started. Only the one the
// agent started: anything else is refused.
async function stop(entry, { force = false } = {}) {
  const now = (await inspect([entry])).get(entry.pid);
  if (!now || now.state === 'stopped') throw new Error('Esse processo já parou: recarrega a lista');
  if (now.state !== 'running') throw new Error('O número desse processo já não é o do agente (é outro processo): não lhe toco');
  if (IS_WIN) {
    const args = ['/PID', String(entry.pid), '/T'];
    if (force) args.push('/F');
    const { err } = await run('taskkill', args, 15000);
    if (err) throw new Error('O Windows não deixou parar o processo');
    return { ok: true, signal: force ? 'force' : 'stop', pids: [entry.pid] };
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  const pids = [...(await descendants(entry.pid)).reverse(), entry.pid];
  const done = [];
  for (const p of pids) {
    try {
      process.kill(p, signal);
      done.push(p);
    } catch {
      // gone already
    }
  }
  return { ok: true, signal, pids: done };
}

module.exports = { inspect, stop, maskCommand, isJavaCommand, descendants, listeningPorts };
