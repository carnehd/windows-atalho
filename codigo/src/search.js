// Search page: text in the files of every microservice of the list, and their file names. Text goes through git grep,
// several repositories at a time, and each one's lines are sent as soon as it finishes; folders without Git are read
// here. File names come from git ls-files (kept until the index changes) or a walk of the folder.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { ipcMain } = require('electron');
const { SKIP } = require('./analysis');

// more processes at once only helps up to a point; on Windows each one costs more to start
const PARALLEL = process.platform === 'win32' ? 4 : 8;
const MAX_LINES = 2000;
const MAX_REPO_LINES = 500;
const MAX_TEXT = 400;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WALK_FILES = 50000;
const MAX_DEPTH = 20;
const NAMES_TTL_MS = 60 * 1000;
const GREP_TIMEOUT_MS = 2 * 60 * 1000;

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const git = (args, cwd) =>
  new Promise((resolve) =>
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: GREP_TIMEOUT_MS }, (error, stdout, stderr) =>
      resolve({ error, stdout: stdout || '', stderr: stderr || '' })
    )
  );

const isGitFolder = (p) => fs.existsSync(path.join(p, '.git'));
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "*.java, pom.xml, !*Test.java, src/test": a name matches in any folder, a word without a dot or * is a folder, ! leaves out.
function filePatterns(text) {
  return String(text || '')
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((p) => {
      const exclude = p.startsWith('!');
      let glob = p.replace(/^!/, '').replace(/^\.?\//, '').replace(/\\/g, '/').slice(0, 200);
      if (!glob) return null;
      if (glob.endsWith('/') || (!glob.includes('.') && !glob.includes('*'))) glob = `${glob.replace(/\/+$/, '')}/**`;
      if (!glob.startsWith('**/')) glob = `**/${glob}`;
      return { exclude, glob };
    })
    .filter(Boolean);
}

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      out += '(?:/.*)?';
      i += 2;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escapeRegExp(c);
  }
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
}

// whether a path (with /) is one the patterns let through
function pathFilter(patterns) {
  const inc = patterns.filter((p) => !p.exclude).map((p) => globToRegExp(p.glob));
  const exc = patterns.filter((p) => p.exclude).map((p) => globToRegExp(p.glob));
  return (rel) => (!inc.length || inc.some((r) => r.test(rel))) && !exc.some((r) => r.test(rel));
}

// The same search as git grep, for the lines read here (folders without Git) and to cut long lines around the match.
function lineMatcher(o) {
  let source = o.mode === 'regex' ? o.text : escapeRegExp(o.text);
  if (o.word) source = `(?<![\\w])(?:${source})(?![\\w])`;
  try {
    return new RegExp(source, o.matchCase ? '' : 'i');
  } catch {
    return null;
  }
}

function excerpt(text, matcher) {
  const clean = text.replace(/\r$/, '');
  if (clean.length <= MAX_TEXT) return clean;
  const m = matcher ? matcher.exec(clean) : null;
  const start = m ? Math.max(0, m.index - 80) : 0;
  return `${start > 0 ? '…' : ''}${clean.slice(start, start + MAX_TEXT)}…`;
}

async function walk(root, keep, onFile) {
  let count = 0;
  const visit = async (dir, depth) => {
    if (depth > MAX_DEPTH || count >= MAX_WALK_FILES) return;
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= MAX_WALK_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await visit(full, depth + 1);
      } else if (e.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (keep(rel)) {
          count++;
          await onFile(rel, full);
        }
      }
    }
  };
  await visit(root, 0);
  return count >= MAX_WALK_FILES;
}

function registerSearch({ listRepos, isKnownRepo, openPath, revealPath }) {
  let job = null;
  let pcre = true; // git grep -P (Perl expressions, like JavaScript's); Git built without it gets -E

  // The branch on origin a repository's main line is: what origin/HEAD points at, else main or master.
  async function originBranch(cwd) {
    const head = await git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], cwd);
    const name = head.stdout.trim();
    if (!head.error && name && name !== 'origin/HEAD') return name;
    for (const b of ['origin/main', 'origin/master', 'origin/develop']) {
      if (!(await git(['rev-parse', '--verify', '--quiet', `refs/remotes/${b}`], cwd)).error) return b;
    }
    return null;
  }

  function grep(repo, o, rev, limit, current) {
    return new Promise((resolve) => {
      const args = ['grep', '-n', '-I', '-z', '--no-color'];
      if (!o.matchCase) args.push('-i');
      if (o.word) args.push('-w');
      args.push(o.mode === 'regex' ? (pcre ? '-P' : '-E') : '-F');
      if (!rev) args.push('--untracked');
      args.push('-e', o.text);
      if (rev) args.push(rev);
      args.push('--', ...o.patterns.map((p) => `:(glob${p.exclude ? ',exclude' : ''})${p.glob}`));
      const matcher = lineMatcher(o);
      const prefix = rev ? `${rev}:` : '';
      const matches = [];
      let truncated = false;
      let rest = '';
      let stderr = '';
      let timedOut = false;
      const child = spawn('git', args, { cwd: repo.path, windowsHide: true });
      current.children.add(child);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, GREP_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (truncated) return;
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines) {
          const [file, num, ...text] = line.split('\0');
          if (!file || !num) continue;
          if (matches.length >= limit) {
            truncated = true;
            child.kill();
            return;
          }
          matches.push({ file: file.startsWith(prefix) ? file.slice(prefix.length) : file, line: Number(num), text: excerpt(text.join('\0'), matcher) });
        }
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        current.children.delete(child);
        if (truncated || current.stopped) return resolve({ matches, truncated });
        if (timedOut) return resolve({ matches, error: 'Took over 2 minutes' });
        // 1 is "nothing found"
        if (code !== 0 && code !== 1 && !matches.length) {
          const msg = stderr.split('\n').map((l) => l.replace(/^(fatal|error): /, '').trim()).filter(Boolean)[0] || `git grep stopped (${code})`;
          return resolve({ matches, error: msg, retry: /perl|pcre/i.test(msg) && o.mode === 'regex' && pcre });
        }
        resolve({ matches });
      };
      child.on('error', (e) => {
        stderr += e.message;
        finish(-1);
      });
      child.on('close', finish);
    });
  }

  async function readFolder(repo, o, limit, current) {
    const matcher = lineMatcher(o);
    if (!matcher) return { matches: [], error: 'Not a valid expression' };
    const keep = pathFilter(o.patterns);
    const matches = [];
    let truncated = false;
    const capped = await walk(repo.path, keep, async (rel, full) => {
      if (truncated || current.stopped) return;
      let buf;
      try {
        const stat = await fs.promises.stat(full);
        if (stat.size > MAX_FILE_BYTES) return;
        buf = await fs.promises.readFile(full);
      } catch {
        return;
      }
      if (buf.subarray(0, 8000).includes(0)) return; // binary
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!matcher.test(lines[i])) continue;
        if (matches.length >= limit) {
          truncated = true;
          return;
        }
        matches.push({ file: rel, line: i + 1, text: excerpt(lines[i], matcher) });
      }
    });
    return { matches, truncated: truncated || capped };
  }

  async function searchRepo(repo, o, current) {
    const limit = Math.max(0, Math.min(MAX_REPO_LINES, MAX_LINES - current.lines));
    if (!fs.existsSync(repo.path)) return { error: 'Folder not found' };
    if (!isGitFolder(repo.path)) {
      if (o.where === 'origin') return { skipped: 'No Git: only the working copy' };
      return readFolder(repo, o, limit, current);
    }
    const rev = o.where === 'origin' ? await originBranch(repo.path) : null;
    if (o.where === 'origin' && !rev) return { error: 'No branch on origin (fetch first)' };
    let r = await grep(repo, o, rev, limit, current);
    if (r.retry) {
      pcre = false;
      r = await grep(repo, o, rev, limit, current);
    }
    return { ...r, rev };
  }

  const stop = () => {
    if (!job) return;
    job.stopped = true;
    for (const c of job.children) c.kill();
    job = null;
  };

  ipcMain.handle('search-text', async (event, raw = {}) => {
    stop();
    const o = {
      id: Number(raw.id) || 0,
      text: String(raw.text || '').slice(0, 1000),
      mode: raw.mode === 'regex' ? 'regex' : 'text',
      matchCase: Boolean(raw.matchCase),
      word: Boolean(raw.word),
      where: raw.where === 'origin' ? 'origin' : 'local',
      patterns: filePatterns(raw.files),
    };
    if (!o.text) return { error: 'Nothing to search for' };
    if (o.text.includes('\n')) return { error: 'One line at a time' };
    const wanted = Array.isArray(raw.repos) ? new Set(raw.repos.map(String)) : null;
    const list = listRepos().filter((r) => !wanted || wanted.has(r.path)).filter((r) => isKnownRepo(r.path));
    const current = { children: new Set(), stopped: false, lines: 0, capped: false };
    job = current;
    const started = Date.now();
    let done = 0;
    const send = (data) => {
      if (!event.sender.isDestroyed()) event.sender.send('search-progress', data);
    };
    await mapLimit(list, PARALLEL, async (repo) => {
      let r;
      if (current.stopped) return;
      if (current.capped) r = { skipped: 'Not searched: the first 2000 lines were found already' };
      else {
        try {
          r = await searchRepo(repo, o, current);
        } catch (e) {
          r = { error: e.message };
        }
      }
      if (current.stopped) return;
      const matches = r.matches || [];
      current.lines += matches.length;
      if (current.lines >= MAX_LINES) current.capped = true;
      done++;
      send({ id: o.id, done, total: list.length, repo: { path: repo.path, name: repo.name, rev: r.rev || null, matches, truncated: Boolean(r.truncated), error: r.error || null, skipped: r.skipped || null } });
    });
    if (job === current) job = null;
    return { id: o.id, took: Date.now() - started, done, total: list.length, lines: current.lines, capped: current.capped, stopped: current.stopped, maxLines: MAX_LINES };
  });

  ipcMain.handle('search-stop', () => {
    stop();
    return { success: true };
  });

  // -- file names --
  const names = new Map();
  async function fileNames(repo) {
    if (!fs.existsSync(repo.path)) return { error: 'Folder not found', files: [] };
    const now = Date.now();
    const cached = names.get(repo.path);
    if (isGitFolder(repo.path)) {
      let stamp = 0;
      try {
        stamp = (await fs.promises.stat(path.join(repo.path, '.git', 'index'))).mtimeMs;
      } catch {
        // a worktree or no commit yet: only the time below
      }
      if (cached && cached.stamp === stamp && now - cached.at < NAMES_TTL_MS) return cached.result;
      const r = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], repo.path);
      const result = r.error && !r.stdout ? { error: r.stderr.trim().split('\n')[0] || r.error.message, files: [] } : { files: r.stdout.split('\0').filter(Boolean) };
      names.set(repo.path, { stamp, at: now, result });
      return result;
    }
    if (cached && now - cached.at < NAMES_TTL_MS) return cached.result;
    const files = [];
    const capped = await walk(repo.path, () => true, (rel) => {
      files.push(rel);
    });
    const result = { files, capped };
    names.set(repo.path, { stamp: 0, at: now, result });
    return result;
  }

  ipcMain.handle('search-names', async (_, paths) => {
    const wanted = Array.isArray(paths) ? new Set(paths.map(String)) : null;
    const list = listRepos().filter((r) => !wanted || wanted.has(r.path));
    const started = Date.now();
    const out = [];
    await mapLimit(list, PARALLEL, async (repo) => {
      const r = await fileNames(repo);
      out.push({ path: repo.path, name: repo.name, files: r.files, error: r.error || null, capped: Boolean(r.capped) });
    });
    return { repos: out, took: Date.now() - started };
  });

  // a file inside one of the repositories of the list, nowhere else
  const listedFile = (repoPath, rel) => {
    if (!isKnownRepo(repoPath)) throw new Error('Unknown repository');
    const file = path.resolve(String(repoPath), String(rel || ''));
    const inside = path.relative(path.resolve(String(repoPath)), file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('File not found');
    if (!fs.existsSync(file)) throw new Error('Not in your working copy');
    return file;
  };
  ipcMain.handle('search-open', async (_, repoPath, rel) => {
    try {
      const error = await openPath(listedFile(repoPath, rel));
      return error ? { error } : { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });
  ipcMain.handle('search-reveal', async (_, repoPath, rel) => {
    try {
      revealPath(listedFile(repoPath, rel));
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });
}

module.exports = { registerSearch, filePatterns, globToRegExp, pathFilter };
