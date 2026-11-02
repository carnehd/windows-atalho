// Which repositories changed on disk, without asking git: each repository folder is watched (its .git folder too)
// and every change there counts one more for it. The page keeps what git said about a repository with the count it
// had then, so a repository with the same count is not asked again (when the window shows again, say). Not counted:
// lock files, the app's own data folder, and what the app's own git commands write in .git while they run there (and
// a moment after): the index git status refreshes, what a fetch brings. The page asks git again after its own
// commands anyway. HEAD and the branches still count then, so a commit or checkout made elsewhere meanwhile is seen.
// A folder that cannot be watched has no count (-1): it is asked every time, as before.
const fs = require('fs');
const path = require('path');
const gitLog = require('./git-log');

const OWN_WRITE_GRACE_MS = 1500;
const watched = new Map(); // repository path -> { watcher, count }
const ignored = []; // folders whose changes never count

function inside(file, dir) {
  return file === dir || file.startsWith(dir + path.sep);
}

// What the app's own git commands write in .git, apart from HEAD and the branches.
function ownWrite(rel) {
  return (rel === '.git' || rel.startsWith('.git/')) && rel !== '.git/HEAD' && !rel.startsWith('.git/refs/heads/');
}

function watchOne(repoPath) {
  const entry = { watcher: null, count: 0 };
  try {
    entry.watcher = fs.watch(repoPath, { recursive: true, persistent: false }, (_event, name) => {
      if (name) {
        const rel = String(name).split(path.sep).join('/');
        if (rel.endsWith('.lock')) return;
        if (ownWrite(rel) && gitLog.busyIn(repoPath, OWN_WRITE_GRACE_MS)) return;
        const full = path.join(repoPath, String(name));
        if (ignored.some((dir) => inside(full, dir))) return;
      }
      entry.count++;
    });
    entry.watcher.on('error', () => {
      try {
        entry.watcher.close();
      } catch {
        // already closed
      }
      entry.watcher = null;
    });
  } catch {
    entry.watcher = null; // not watchable here (a folder gone, a platform without recursive watching)
  }
  watched.set(repoPath, entry);
}

// The repositories of the list: new ones watched, the ones gone from it no longer.
function sync(paths) {
  const wanted = new Set(paths);
  for (const [p, entry] of watched) {
    if (wanted.has(p)) continue;
    if (entry.watcher) entry.watcher.close();
    watched.delete(p);
  }
  for (const p of wanted) if (!watched.has(p)) watchOne(p);
}

function counts(paths) {
  const out = {};
  for (const p of paths) {
    const entry = watched.get(p);
    out[p] = entry && entry.watcher ? entry.count : -1;
  }
  return out;
}

function ignore(dir) {
  ignored.push(path.resolve(dir));
}

module.exports = { sync, counts, ignore };
