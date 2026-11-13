// The logs the arrancador agent leaves: one folder for each microservice, <tmp>/arranque-<name>/ (/tmp on macOS and Linux, the
// TEMP folder on Windows), with its <name>.log, <name>.pid and contentores.txt. Only reads, and only there: the folders called
// arranque-<name>, the plain files in them (no link is followed), and the end of one file. No Electron in this file.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUN = /^arranque-([A-Za-z0-9][A-Za-z0-9._-]{0,79})$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHOWN = /\.(log|txt|pid|out|err)$/i;
const MAX_RUNS = 100;
const MAX_FILES = 40;
const TAIL_BYTES = 256 * 1024;

const defaultBase = () => (process.platform === 'win32' ? os.tmpdir() : '/tmp');

// A file made by a program in colour (Spring does): the escape codes and the other control characters are not text.
function cleanText(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// A path inside the folder of the run, only if it is a plain file (lstat: a link is not one).
function plainFile(dir, name) {
  if (!FILE.test(name) || !SHOWN.test(name)) return null;
  const file = path.join(dir, name);
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? { file, st } : null;
  } catch {
    return null;
  }
}

function runDir(base, run) {
  if (!RUN.test(String(run))) return null;
  const dir = path.join(base, run);
  try {
    return fs.lstatSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

function listFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    const p = plainFile(dir, name);
    if (p) files.push({ name, size: p.st.size, mtimeMs: Math.round(p.st.mtimeMs) });
  }
  // the logs first, the newest first
  files.sort((a, b) => Number(/\.log$/i.test(b.name)) - Number(/\.log$/i.test(a.name)) || b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return files.slice(0, MAX_FILES);
}

// The process the agent started: its number, when the agent wrote it, and whether a process with that number is there now (the
// number may be another one's if the machine has run a long while: agent-procs.js tells them apart).
function pidOf(dir, name) {
  const p = plainFile(dir, `${name}.pid`);
  if (!p || p.st.size > 32) return null;
  let text = '';
  try {
    text = fs.readFileSync(p.file, 'utf8').trim();
  } catch {
    return null;
  }
  if (!/^[0-9]{1,10}$/.test(text)) return null;
  const pid = Number(text);
  const at = Math.round(p.st.mtimeMs); // when the agent wrote it, just after it started the process
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (e) {
    alive = Boolean(e && e.code === 'EPERM'); // there, and not ours
  }
  return { pid, alive, at };
}

// The pid the agent wrote for a run, read again now: { pid, at } or null.
function pidEntry(base, run) {
  const m = RUN.exec(String(run));
  const dir = m && runDir(base, run);
  const found = dir && pidOf(dir, m[1]);
  return found ? { pid: found.pid, at: found.at } : null;
}

function listRuns(base) {
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return { base, runs: [] };
  }
  const runs = [];
  for (const id of names) {
    const m = RUN.exec(id);
    const dir = m && runDir(base, id);
    if (!dir) continue;
    const files = listFiles(dir);
    runs.push({ id, name: m[1], dir, files, updated: files.reduce((t, f) => Math.max(t, f.mtimeMs), 0), process: pidOf(dir, m[1]) });
  }
  runs.sort((a, b) => b.updated - a.updated || a.name.localeCompare(b.name));
  return { base, runs: runs.slice(0, MAX_RUNS) };
}

// The end of a file (the last bytes, from a whole line on), as text.
function readTail(base, run, name, maxBytes = TAIL_BYTES) {
  const dir = runDir(base, run);
  if (!dir) throw new Error('Esse microserviço já não tem pasta de logs: recarrega a lista');
  const p = plainFile(dir, name);
  if (!p) throw new Error('Esse ficheiro já não está lá: recarrega a lista');
  const size = p.st.size;
  const start = Math.max(0, size - maxBytes);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(p.file, 'r');
  let got = 0;
  try {
    got = fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.subarray(0, got).toString('utf8');
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  return { text: cleanText(text), size, mtimeMs: Math.round(p.st.mtimeMs), truncated: start > 0, maxBytes };
}

module.exports = { defaultBase, listRuns, readTail, runDir, pidEntry, cleanText, RUN, TAIL_BYTES };
