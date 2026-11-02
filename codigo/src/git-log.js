// Every git process the app starts, for the Git panel at the bottom of the window: the command, the folder it ran in,
// when, how long it took and how it ended. Caught where Node starts any process (ChildProcess#spawn, the step that
// spawn, execFile and simple-git all go through), so a git call is listed whichever file makes it. In memory only:
// the last MAX_ENTRIES.
const { ChildProcess } = require('child_process');
const path = require('path');

const MAX_ENTRIES = 1000;
const MAX_ARG_CHARS = 400; // a long argument (a commit message) is cut
const MAX_ARGS = 80; // and so is a long list of files
const SEND_EVERY_MS = 100; // the changes go to the window together, not one message per process

const entries = [];
let nextId = 1;
let listedFrom = 1; // after Clear, what started before it is not listed again when it ends
let listener = null;
const pending = new Map();
let timer = null;
let installed = false;
// per folder: how many git commands run there now, and when the last one ended (for busyIn)
const activity = new Map();
const byChild = new WeakMap(); // the process -> its entry, for mark

const isGit = (file) => /^git(\.exe)?$/i.test(path.basename(String(file || '')));

// As it would be typed: quoted when it has a space or a character a shell reads, control characters spelled out,
// and the user and password (or token) of an address hidden.
function shownArg(arg) {
  let s = String(arg)
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')
    .replace(/^(http\..*extraheader=[^:]*:\s*).+$/i, '$1***');
  if (s.length > MAX_ARG_CHARS) s = `${s.slice(0, MAX_ARG_CHARS)}…`;
  s = s.replace(/[\x00-\x1f\x7f]/g, (c) => (c === '\n' ? '\\n' : c === '\t' ? '\\t' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));
  return s === '' || /[\s"'`$\\|&;<>(){}*?!#~]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

function commandLine(args) {
  const list = (Array.isArray(args) ? args.slice(1) : []).map(String); // the first is the program itself
  const shown = list.slice(0, MAX_ARGS).map(shownArg);
  if (list.length > MAX_ARGS) shown.push(`… (${list.length - MAX_ARGS} more)`);
  return ['git', ...shown].join(' ');
}

function changed(entry) {
  if (entry.id < listedFrom || !listener) return;
  pending.set(entry.id, { ...entry });
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const batch = [...pending.values()];
    pending.clear();
    if (listener && batch.length) listener(batch);
  }, SEND_EVERY_MS);
}

function track(child, options, started) {
  const entry = {
    id: nextId++,
    at: Date.now(),
    cwd: options.cwd ? String(options.cwd) : process.cwd(),
    command: commandLine(options.args),
    running: true,
    ms: 0,
    code: null,
    signal: null,
    error: '',
  };
  entries.push(entry);
  byChild.set(child, entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  const here = activity.get(entry.cwd) || { running: 0, endedAt: 0 };
  activity.set(entry.cwd, here);
  // a git that is not there (or cannot run) does not start: no exit comes, only an error to whoever started it
  if (typeof started === 'number' && started < 0) {
    Object.assign(entry, { running: false, error: 'Git could not start (is it installed?)' });
  } else {
    here.running++;
    child.once('exit', (code, signal) => {
      Object.assign(entry, { running: false, ms: Date.now() - entry.at, code, signal });
      here.running--;
      here.endedAt = Date.now();
      changed(entry);
    });
  }
  changed(entry);
}

function install() {
  if (installed) return;
  installed = true;
  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function spawnAndLog(options) {
    const started = spawn.call(this, options);
    try {
      if (options && isGit(options.file)) track(this, options, started);
    } catch {
      // the list never stops a command
    }
    return started;
  };
}

function outcome(e) {
  if (e.running) return 'running';
  if (e.error) return e.error;
  if (e.signal) return `stopped (${e.signal}) after ${e.ms} ms`;
  return e.code ? `exit ${e.code}, ${e.ms} ms` : `${e.ms} ms`;
}

const stamp = (ms) => {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

// Whether the app runs git in this folder (or in one inside it) now, or did less than graceMs ago.
function busyIn(dir, graceMs) {
  const root = path.resolve(dir);
  const now = Date.now();
  for (const [cwd, a] of activity) {
    const at = path.resolve(cwd);
    if ((at === root || at.startsWith(root + path.sep)) && (a.running > 0 || now - a.endedAt < graceMs)) return true;
  }
  return false;
}

module.exports = {
  install,
  busyIn,
  list: () => entries.filter((e) => e.id >= listedFrom).map((e) => ({ ...e })),
  // as text, one line each: for Copy
  text: () => entries.filter((e) => e.id >= listedFrom).map((e) => `${stamp(e.at)}  ${e.cwd}  ${e.command}  (${outcome(e)})`).join('\n'),
  clear() {
    entries.length = 0;
    pending.clear();
    listedFrom = nextId;
  },
  onChange(fn) {
    listener = fn;
  },
  // Fields added to the entry of a process the app started (typed: a command typed at the foot of the Git panel, whose
  // output the panel shows under it). Its id, or null when it is not a git command.
  mark(child, fields) {
    const entry = byChild.get(child);
    if (!entry) return null;
    Object.assign(entry, fields);
    changed(entry);
    return entry.id;
  },
};
