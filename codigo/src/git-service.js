const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { simpleGit } = require('simple-git');

const STATUS_LETTERS = { M: 'M', T: 'M', A: 'A', C: 'A', '?': 'A', D: 'D', R: 'R', U: 'U' };

function cleanError(message) {
  const lines = String(message).split('\n');
  const first = lines.findIndex((l) => /^(error|fatal):/.test(l));
  return (first > 0 ? lines.slice(first) : lines).join('\n').trim();
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_DIFF_CHARS = 400000;
const MAX_PREVIEW_BYTES = 400000;
const FULL_CONTEXT = 1000000;
const MAX_COUNTED_UNTRACKED = 200;
const SYNC_TIMEOUT_MS = 2 * 60 * 1000; // a pull of many: how long Git may stay silent before it is stopped

// Hunk headers ("@@ -172,13 +172,12 @@ pushTo(target)") name the function a change is in. Git has patterns for many
// languages but has to be told which files are which, and has none for JavaScript, so diffs read this attributes
// file and the "gqjs" pattern below. A repository's own .gitattributes still wins over it.
const DIFF_ATTRIBUTES = [
  '*.java diff=java', '*.kt diff=kotlin', '*.kts diff=kotlin', '*.py diff=python', '*.cs diff=csharp', '*.go diff=golang',
  '*.rs diff=rust', '*.php diff=php', '*.rb diff=ruby', '*.c diff=cpp', '*.h diff=cpp', '*.cpp diff=cpp', '*.hpp diff=cpp',
  '*.css diff=css', '*.scss diff=css', '*.less diff=css', '*.html diff=html', '*.htm diff=html', '*.md diff=markdown',
  '*.js diff=gqjs', '*.jsx diff=gqjs', '*.mjs diff=gqjs', '*.cjs diff=gqjs', '*.ts diff=gqjs', '*.tsx diff=gqjs',
].join('\n') + '\n';
const JS_FUNCNAME = [
  '!^[ \t]*(if|else|for|while|do|switch|case|catch|return|try|finally|with|typeof|new|await|throw|yield)([ \t(;{]|$)',
  '^[ \t]*((export[ \t]+)?(default[ \t]+)?(async[ \t]+)?function[ \t*]*[A-Za-z_$][A-Za-z0-9_$]*[ \t]*\\(.*)$',
  '^[ \t]*((export[ \t]+)?(default[ \t]+)?(abstract[ \t]+)?class[ \t]+[A-Za-z_$][A-Za-z0-9_$]*.*)$',
  '^[ \t]*((static[ \t]+|async[ \t]+|get[ \t]+|set[ \t]+|public[ \t]+|private[ \t]+|protected[ \t]+)*[A-Za-z_$][A-Za-z0-9_$]*[ \t]*\\([^;]*\\)[ \t]*(:[^{;]*)?\\{.*)$',
  '^[ \t]*((export[ \t]+)?(const|let|var)[ \t]+[A-Za-z_$][A-Za-z0-9_$]*[ \t]*=[ \t]*(async[ \t]*)?(function|\\([^)]*\\)[ \t]*=>|[A-Za-z_$][A-Za-z0-9_$]*[ \t]*=>).*)$',
].join('\n');
let diffAttributesFile;

const PARK_DEFAULT_FOLDER = 'local-changes';
const PARK_MARKER = '# Git Quick: files kept out of commits';
const MAX_PARKED_FILES = 2000;
const MAX_SIDE_BYTES = 5 * 1024 * 1024; // the most a diff side may be to change it from the app

// "git diff --no-index" compares two files on disk. It exits with 1 when they differ, which is not an error.
function gitNoIndexDiff(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.code !== 1) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

// A file's whole content as one block of added lines, in unified diff form (Git has no diff for such a file).
async function newFileDiff(full, label) {
  const { size } = await fs.promises.stat(full);
  const handle = await fs.promises.open(full, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(Math.min(size, MAX_PREVIEW_BYTES));
    await handle.read(buffer, 0, buffer.length, 0);
  } finally {
    await handle.close();
  }
  const header = `diff --git a/${label} b/${label}\nnew file\n`;
  if (buffer.subarray(0, 8000).includes(0)) return { diff: `${header}Binary files /dev/null and b/${label} differ\n`, truncated: false };
  const lines = buffer.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return { diff: header, truncated: false };
  return {
    diff: `${header}--- /dev/null\n+++ b/${label}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`,
    truncated: size > MAX_PREVIEW_BYTES,
  };
}

// A folder inside the repository, written with forward slashes. Kept to plain names so it is also a literal
// .gitignore pattern (no wildcards, no leading # or !, no trailing spaces).
function cleanFolder(name) {
  const text = String(name ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!text) throw new Error('Choose a folder name');
  const parts = text.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error('Use a folder inside the repository, without . or .. in the path');
  if (parts[0].toLowerCase() === '.git') throw new Error('The .git folder cannot be used');
  if (!parts.every((p) => /^[A-Za-z0-9._ -]+$/.test(p) && p.trim() === p)) {
    throw new Error('Use only letters, digits, spaces, dots, dashes and underscores in the folder name');
  }
  return parts.join('/');
}

// "notes.txt" -> "notes (2).txt" while the name is taken.
function freeName(file) {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

async function moveFile(src, dest) {
  try {
    await fs.promises.rename(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fs.promises.copyFile(src, dest);
    await fs.promises.unlink(src);
  }
}

// Removes the folders a move left empty, up to (not including) the repository root.
async function removeEmptyDirs(dir, root) {
  let current = dir;
  while (path.relative(root, current) && !path.relative(root, current).startsWith('..')) {
    try {
      await fs.promises.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

// Written once per run to the temp folder (Git cannot read files inside the app's asar archive).
function diffConfigArgs() {
  if (diffAttributesFile === undefined) {
    try {
      const file = path.join(os.tmpdir(), 'git-quick-diff.gitattributes');
      fs.writeFileSync(file, DIFF_ATTRIBUTES);
      diffAttributesFile = file.replace(/\\/g, '/');
    } catch {
      diffAttributesFile = null;
    }
  }
  const args = ['-c', `diff.gqjs.xfuncname=${JS_FUNCNAME}`];
  if (diffAttributesFile) args.push('-c', `core.attributesFile=${diffAttributesFile}`);
  return args;
}

// Lines from "git diff --name-status" or "git log --name-status": "M<TAB>path" or "R100<TAB>old<TAB>new".
function parseNameStatus(text) {
  return String(text)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [code, a, b] = line.split('\t');
      const letter = STATUS_LETTERS[code[0]] || 'M';
      return b ? { file: b, from: a, letter } : { file: a, letter };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

// Output of "git log --name-status --format=%x1e%H%x1f%s%x1f%an%x1f%cI": one record per commit, files below the header.
function parseLogWithFiles(text) {
  return String(text)
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [header, ...rest] = chunk.split('\n');
      const [hash, message, author, date] = header.split('\x1f');
      return { hash: hash.slice(0, 7), fullHash: hash, message, author, date, files: parseNameStatus(rest.join('\n')) };
    });
}

// Addresses a clone may come from: https, ssh, git or user@host:path. Anything else (ext::, local paths, options)
// is refused, so the value can never make Git run a command or read an option.
const CLONE_URL = /^(?:(?:https?|ssh|git):\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/;

// Clones into <parent>/<name> and returns that folder. Git is told not to ask for a user name in a terminal (there is
// none), so a private repository without saved credentials fails instead of waiting forever.
async function cloneRepo(url, parent, name) {
  const source = String(url || '').trim();
  if (!CLONE_URL.test(source)) throw new Error('Use an https://, ssh:// or git@host:path address');
  const folder = String(name || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(folder) || /^\.+$/.test(folder)) throw new Error('Use only letters, digits, dots, dashes and underscores in the folder name');
  const base = String(parent || '');
  if (!base || !path.isAbsolute(base) || !fs.existsSync(base) || !fs.statSync(base).isDirectory()) throw new Error('Choose the folder to clone into');
  const target = path.join(base, folder);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) throw new Error(`${target} already exists and is not empty`);
  await new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    execFile('git', ['clone', '--', source, target], { cwd: base, env, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, _out, stderr) => {
      if (err) reject(new Error(cleanError(stderr || err.message)));
      else resolve();
    });
  });
  return target;
}

class GitService {
  constructor(repoPath) {
    try {
      this.git = simpleGit(repoPath);
    } catch {
      const err = new Error('Folder not found');
      this.git = new Proxy({}, { get: () => async () => { throw err; } });
    }
    this.repoPath = repoPath;
  }

  async isGitRepo() {
    try {
      return await this.git.checkIsRepo();
    } catch {
      return false;
    }
  }

  async getRoot() {
    try {
      return (await this.git.revparse(['--show-toplevel'])).trim();
    } catch {
      return null;
    }
  }

  async getSummary() {
    try {
      const status = await this.git.status();
      return {
        branch: status.current,
        changes: status.files.length,
        ahead: status.ahead,
        behind: status.behind,
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  async getStatus() {
    try {
      const status = await this.git.status();
      const branch = status.current;
      const ahead = status.ahead;
      const behind = status.behind;

      const entries = status.files
        .map((f) => {
          const idx = f.index.trim();
          const wd = f.working_dir.trim();
          const conflicted = status.conflicted.includes(f.path);
          const staged = !conflicted && idx !== '' && idx !== '?';
          const code = conflicted ? 'U' : staged ? idx : wd;
          return {
            file: f.path,
            from: f.from && f.from !== f.path ? f.from : undefined,
            letter: STATUS_LETTERS[code] || 'M',
            staged,
            unstaged: conflicted || wd !== '',
            untracked: idx === '?',
          };
        })
        .sort((a, b) => a.file.localeCompare(b.file));

      const counts = await this.lineCounts(status);
      for (const e of entries) Object.assign(e, counts.get(e.file) || {});
      // When each file last changed on disk; a deleted file has none.
      await Promise.all(entries.map(async (e) => {
        if (e.letter === 'D') return;
        try {
          e.mtime = (await fs.promises.stat(path.join(this.repoPath, e.file))).mtimeMs;
        } catch {
          // gone meanwhile
        }
      }));

      // A merge or revert that stopped on conflicts, and the message Git prepared for its commit.
      const operation = await this.operation();
      let operationMessage = '';
      if (operation) {
        const rel = (await this.git.raw(['rev-parse', '--git-path', 'MERGE_MSG'])).trim();
        const text = await fs.promises.readFile(path.resolve(this.repoPath, rel), 'utf8').catch(() => '');
        operationMessage = text.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
      }

      return {
        branch,
        ahead,
        behind,
        entries,
        changes: entries.length,
        isClean: status.isClean(),
        tracking: status.tracking,
        lastFetch: await this.lastFetch(),
        operation,
        operationMessage,
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  // When origin was last asked for news (a fetch or a pull): the time of .git/FETCH_HEAD; null when never.
  async lastFetch() {
    try {
      const file = (await this.git.raw(['rev-parse', '--git-path', 'FETCH_HEAD'])).trim();
      return (await fs.promises.stat(path.resolve(this.repoPath, file))).mtimeMs;
    } catch {
      return null;
    }
  }

  async getBranches() {
    try {
      const summary = await this.git.branch(['-a']);
      const local = [];
      const remote = [];
      for (const [name, info] of Object.entries(summary.branches)) {
        if (name.startsWith('remotes/')) {
          const shortName = name.replace(/^remotes\/origin\//, '');
          if (shortName !== 'HEAD') {
            remote.push({ name: shortName, fullName: name, current: false });
          }
        } else {
          local.push({ name, current: info.current });
        }
      }
      return { local, remote, current: summary.current };
    } catch (e) {
      return { error: e.message };
    }
  }

  async checkout(branch) {
    try {
      await this.git.checkout(branch);
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  // New branches copy the latest origin/<base> (origin/main unless another one is chosen), fetched first.
  // --no-track keeps the first push going to origin/<name> instead of the base branch.
  async createBranchFrom(name, base = 'main') {
    try {
      const branch = String(name || '').trim();
      const from = String(base || '').trim() || 'main';
      if (!branch || branch.startsWith('-')) return { error: 'Invalid branch name' };
      if (from.startsWith('-')) return { error: 'Invalid base branch' };
      for (const [value, label] of [[branch, 'branch name'], [from, 'base branch']]) {
        try {
          await this.git.raw(['check-ref-format', '--branch', value]);
        } catch {
          return { error: `"${value}" is not a valid ${label}` };
        }
      }
      try {
        await this.git.fetch('origin', from);
      } catch (e) {
        const reason = cleanError(e.message).split('\n')[0];
        return { error: `Could not fetch origin/${from}. Check that the remote "origin" has a branch called "${from}". (${reason})` };
      }
      if (!(await this.refExists(`refs/remotes/origin/${from}`))) return { error: `origin/${from} was not found after fetching` };
      await this.git.checkout(['-b', branch, '--no-track', `refs/remotes/origin/${from}`]);
      return { success: true, base: from };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // A pull merges (Git refuses a pull of a branch that went another way when pull.rebase is not set), and when the
  // merge stops on conflicts it says which files have them.
  async pull() {
    try {
      const result = await this.git.pull(undefined, undefined, { '--no-rebase': null });
      // simple-git does not always fail when the merge stops on a conflict
      return (await this.stoppedOnConflicts('pull')) || { success: true, summary: result.summary };
    } catch (e) {
      return (await this.stoppedOnConflicts('pull')) || { error: e.message };
    }
  }

  // One repository of a pull of many: fetch, then move the branch forward to its branch on origin, only when that
  // needs no merge (fast-forward). Anything else is reported and the repository is left as it was, so it never stops
  // half-way in a merge while the others go on. Git is stopped when it gives no sign of life for a while.
  async syncPull() {
    const git = simpleGit({ baseDir: this.repoPath, timeout: { block: SYNC_TIMEOUT_MS } });
    const failed = (e, branch) => ({
      state: 'error',
      branch,
      message: /block timeout reached/.test(e.message)
        ? `Git gave no answer in ${SYNC_TIMEOUT_MS / 60000} minutes`
        : cleanError(e.message).replace(/^(error|fatal): /gm, '').replace(/\n?Aborting\s*$/, ''),
    });
    let status;
    try {
      status = await git.status();
    } catch (e) {
      return failed(e, '');
    }
    const branch = status.detached ? '' : status.current || '';
    if (!branch || branch === 'HEAD') return { state: 'skipped', branch: '', message: 'Not on a branch (detached HEAD)' };
    const op = await this.operation();
    if (op) return { state: 'skipped', branch, message: `A ${op} is waiting to be finished or aborted` };
    if (!status.tracking) return { state: 'skipped', branch, message: `${branch} has no branch on origin to pull from` };
    try {
      await git.fetch(['--prune']);
    } catch (e) {
      return failed(e, branch);
    }
    const after = await git.status();
    const commits = (n) => `${n} commit${n === 1 ? '' : 's'}`;
    if (!after.behind) {
      return { state: 'current', branch, message: after.ahead ? `Already up to date (${commits(after.ahead)} to push)` : 'Already up to date' };
    }
    if (after.ahead) {
      return { state: 'error', branch, message: `${branch} and ${after.tracking} both have new commits (${after.ahead} here, ${after.behind} there). Pull it on its own to merge them.` };
    }
    try {
      const before = (await git.revparse(['HEAD'])).trim();
      await git.raw(['merge', '--ff-only', '@{u}']);
      const stat = (await git.raw(['diff', '--shortstat', before, 'HEAD']).catch(() => '')).trim();
      return { state: 'updated', branch, commits: after.behind, message: `${commits(after.behind)} pulled${stat ? `: ${stat}` : ''}` };
    } catch (e) {
      return failed(e, branch);
    }
  }

  // For "Fetch several": origin's news for every branch, stopped when Git gives no sign of life for a while.
  async fetchAllQuiet() {
    try {
      await simpleGit({ baseDir: this.repoPath, timeout: { block: SYNC_TIMEOUT_MS } }).fetch(['--all', '--prune']);
      return { success: true };
    } catch (e) {
      return { error: /block timeout reached/.test(e.message) ? `Git gave no answer in ${SYNC_TIMEOUT_MS / 60000} minutes` : cleanError(e.message) };
    }
  }

  // After a pull, merge or revert: the files left in conflict, as an error that names them; null when there are none.
  async stoppedOnConflicts(what) {
    const conflicted = await this.git.status().then((st) => st.conflicted).catch(() => []);
    if (!conflicted.length) return null;
    return { error: `The ${what} stopped on conflicts in:\n${conflicted.map((f) => `\t${f}`).join('\n')}`, conflict: true };
  }

  // A merge, revert or cherry-pick that stopped on conflicts and waits to be committed or aborted.
  async operation() {
    for (const [name, ref] of [['merge', 'MERGE_HEAD'], ['revert', 'REVERT_HEAD'], ['cherry-pick', 'CHERRY_PICK_HEAD']]) {
      if (await this.refExists(ref)) return name;
    }
    return null;
  }

  // Goes back to how things were before the merge (or revert) that stopped on conflicts.
  async abortOperation() {
    try {
      const op = await this.operation();
      if (!op) return { error: 'There is no merge or revert to abort' };
      await this.git.raw([op, '--abort']);
      return { success: true, operation: op };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // Commits only the chosen files (as they are in the working tree); other changes, staged or not, stay as they are.
  async commit(message, files) {
    try {
      const paths = [...new Set((files || []).map(String).filter(Boolean))];
      if (paths.length === 0) return { error: 'Select at least one file to commit' };
      const status = await this.git.status();
      const operation = await this.operation();
      let result;
      if (operation) {
        // A merge (a pull that stopped on conflicts) or a revert is committed whole: Git refuses a commit of only some
        // files then. The files in conflict must all be chosen, without the markers Git left in them.
        const left = status.conflicted.filter((f) => !paths.includes(f));
        if (left.length) return { error: `Finish the ${operation} first: choose ${left.join(', ')} too (in conflict) for this commit.` };
        for (const f of status.conflicted) {
          const text = await fs.promises.readFile(path.join(this.repoPath, f), 'utf8').catch(() => '');
          if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) return { error: `${f} still has conflict markers (<<<<<<<, =======, >>>>>>>). Resolve them first.` };
        }
        await this.git.add(['--', ...paths]);
        result = await this.git.commit(message);
      } else {
        const untracked = paths.filter((p) => status.not_added.includes(p));
        if (untracked.length > 0) await this.git.add(['--', ...untracked]);
        result = await this.git.commit(message, paths);
      }
      return {
        success: true,
        summary: { changes: result.summary.changes, insertions: result.summary.insertions, deletions: result.summary.deletions },
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  // Where a push goes when no branch was chosen: the upstream on origin, otherwise a branch with the same name.
  async pushContext(target) {
    const status = await this.git.status();
    if (!status.current || status.detached) throw new Error('Detached HEAD: check out a branch before pushing');
    const remotes = await this.git.getRemotes();
    if (!remotes.some((r) => r.name === 'origin')) throw new Error('The repository has no remote called "origin"');
    const upstream = status.tracking && status.tracking.startsWith('origin/') ? status.tracking.slice('origin/'.length) : '';
    const branch = String(target || '').trim() || upstream || status.current;
    if (branch.startsWith('-')) throw new Error('Invalid branch name');
    try {
      await this.git.raw(['check-ref-format', '--branch', branch]);
    } catch {
      throw new Error(`"${branch}" is not a valid branch name`);
    }
    const targetExists = await this.refExists(`refs/remotes/origin/${branch}`);
    return { status, current: status.current, upstream, target: branch, targetExists };
  }

  // Prints the hash when the ref is a commit and nothing otherwise. The output is checked because simple-git
  // does not treat a silent non-zero exit (what --quiet gives) as an error.
  async refExists(ref) {
    try {
      return Boolean((await this.git.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim());
    } catch {
      return false;
    }
  }

  // Commits on the current branch that origin/<target> does not have yet, with the files each one touches,
  // plus the net list of files the push would change. Compared with origin as of the last fetch.
  async getUnpushed(target) {
    try {
      const ctx = await this.pushContext(target);
      const range = ctx.targetExists ? [`origin/${ctx.target}..HEAD`] : ['HEAD', '--not', '--remotes=origin'];
      const log = await this.git.raw(['log', ...range, '--topo-order', '--name-status', '--format=%x1e%H%x1f%s%x1f%an%x1f%cI']);
      const commits = parseLogWithFiles(log);
      let behind = 0;
      if (ctx.targetExists) {
        behind = Number((await this.git.raw(['rev-list', '--count', `HEAD..origin/${ctx.target}`])).trim()) || 0;
      }
      let files = [];
      if (commits.length > 0) {
        // Net change: against the target branch, or against the parent of the oldest new commit when origin lacks it.
        let base = ctx.targetExists ? `origin/${ctx.target}` : `${commits[commits.length - 1].fullHash}^`;
        if (!(await this.refExists(base))) base = EMPTY_TREE;
        files = parseNameStatus(await this.git.raw(['diff', '--name-status', base, 'HEAD']));
      }
      return {
        current: ctx.current,
        upstream: ctx.upstream,
        target: ctx.target,
        targetExists: ctx.targetExists,
        behind,
        commits,
        files,
      };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // Throws away the local changes of these files. Files in the last commit go back to it (index and working tree);
  // files added since then are removed from Git and deleted, and so are files Git does not track yet.
  // Only paths Git lists as changed are accepted, so nothing outside that list can be touched.
  async revertFiles(files) {
    try {
      const paths = [...new Set((files || []).map(String).filter(Boolean))];
      if (paths.length === 0) return { error: 'Select at least one file to revert' };
      const status = await this.git.status();
      const changed = new Set(status.files.flatMap((f) => [f.path, f.from].filter(Boolean)));
      const unknown = paths.find((p) => !changed.has(p));
      if (unknown) return { error: `"${unknown}" has no changes to revert` };

      const untracked = paths.filter((p) => status.not_added.includes(p));
      const tracked = paths.filter((p) => !status.not_added.includes(p));
      const inHead = new Set();
      if (tracked.length > 0 && (await this.refExists('HEAD'))) {
        // Literal pathspecs: a file called "*.js" means only that file.
        const out = await this.git.raw(['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...tracked]);
        out.split('\0').filter(Boolean).forEach((p) => inHead.add(p));
      }
      const added = tracked.filter((p) => !inHead.has(p));
      const restore = tracked.filter((p) => inHead.has(p));
      if (added.length > 0) await this.git.raw(['--literal-pathspecs', 'rm', '-f', '-q', '--', ...added]);
      if (restore.length > 0) await this.git.raw(['--literal-pathspecs', 'checkout', 'HEAD', '--', ...restore]);
      if (untracked.length > 0) await this.git.raw(['--literal-pathspecs', 'clean', '-f', '-q', '--', ...untracked]);
      return { success: true, restored: restore.length, deleted: added.length + untracked.length };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // Ignores <folder> in this clone only: .git/info/exclude is never committed or pushed. Returns whether it was added.
  async excludeFolder(folder) {
    const rel = (await this.git.raw(['rev-parse', '--git-path', 'info/exclude'])).trim();
    const file = path.resolve(this.repoPath, rel);
    const line = `/${folder}/`;
    let text = '';
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      // no exclude file yet
    }
    if (text.split(/\r?\n/).some((l) => l.trim() === line)) return false;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const gap = text && !text.endsWith('\n') ? '\n' : '';
    await fs.promises.appendFile(file, `${gap}${PARK_MARKER}\n${line}\n`);
    return true;
  }

  // Moves changed files into a folder that Git ignores (see excludeFolder), keeping their paths inside it, so they
  // leave the commit list but stay on disk. A file that is in the last commit goes back to that version where it
  // was (otherwise Git would show it as deleted); a new file is simply moved, and unstaged if it was staged.
  // Only files Git lists as changed are accepted.
  async parkFiles(entries, folderName) {
    try {
      const folder = cleanFolder(folderName);
      const list = (Array.isArray(entries) ? entries : [])
        .map((e) => ({ file: String((e && e.file) || '') }))
        .filter((e) => e.file);
      if (list.length === 0) return { error: 'Select at least one file' };
      const status = await this.git.status();
      const byPath = new Map(status.files.map((f) => [f.path, f]));
      const inFolder = (p) => p === folder || p.startsWith(`${folder}/`);
      for (const e of list) {
        const f = byPath.get(e.file);
        if (!f) return { error: `"${e.file}" has no changes` };
        if (status.conflicted.includes(e.file)) return { error: `"${e.file}" has a conflict. Resolve it first.` };
        if (inFolder(e.file)) return { error: `"${e.file}" is already inside ${folder}` };
        if (!fs.existsSync(path.join(this.repoPath, e.file))) return { error: `"${e.file}" was deleted, so there is nothing to move` };
        e.from = f.from && f.from !== f.path ? f.from : null;
      }
      const tracked = (await this.git.raw(['--literal-pathspecs', 'ls-files', '--', folder])).trim();
      if (tracked) return { error: `${folder} has files in Git. Choose a folder that is not part of the repository.` };

      const inHead = new Set();
      const paths = list.flatMap((e) => [e.file, e.from].filter(Boolean));
      if (await this.refExists('HEAD')) {
        const out = await this.git.raw(['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...paths]);
        out.split('\0').filter(Boolean).forEach((p) => inHead.add(p));
      }

      // The ignore rule first, so the moved files never show up as new.
      const excludeAdded = await this.excludeFolder(folder);
      const moved = [];
      for (const e of list) {
        const src = path.join(this.repoPath, e.file);
        const dest = freeName(path.join(this.repoPath, folder, e.file));
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await moveFile(src, dest);
        await removeEmptyDirs(path.dirname(src), this.repoPath);
        moved.push(path.relative(this.repoPath, dest).split(path.sep).join('/'));
      }
      const unstage = list.map((e) => e.file).filter((p) => !inHead.has(p) && !status.not_added.includes(p));
      if (unstage.length > 0) await this.git.raw(['--literal-pathspecs', 'rm', '--cached', '-q', '--', ...unstage]);
      const restore = paths.filter((p) => inHead.has(p));
      if (restore.length > 0) await this.git.raw(['--literal-pathspecs', 'checkout', 'HEAD', '--', ...restore]);
      return { success: true, folder, moved, restored: restore.length, excludeAdded };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // Pushes the current branch to origin/<target>. Never forces: a rejected push comes back as an error to read.
  async pushTo(target) {
    try {
      const ctx = await this.pushContext(target);
      const args = ['origin', `HEAD:refs/heads/${ctx.target}`];
      // The first push of a branch under its own name sets the upstream, so plain pull works afterwards.
      if (!ctx.status.tracking && ctx.target === ctx.current) args.unshift('-u');
      await this.git.push(args);
      return { success: true, target: ctx.target };
    } catch (e) {
      // Git puts the reason on the "! [rejected] ... (fetch first)" line, above the "error:" line that cleanError keeps.
      const rejected = /\[rejected\][^\n]*\(([^)]+)\)/.exec(e.message);
      return { error: `${rejected ? `Push rejected (${rejected[1]}). ` : ''}${cleanError(e.message)}` };
    }
  }

  async stageAll() {
    try {
      await this.git.add('-A');
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  async stageFile(file) {
    try {
      await this.git.add(file);
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  async unstageFile(file) {
    try {
      await this.git.reset(['HEAD', '--', file]);
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  // Lines added and removed per changed file (HEAD against the working tree). Binary files are marked as such.
  // Untracked files are counted by reading them, up to a limit, since Git has no diff for them yet.
  async lineCounts(status) {
    const counts = new Map();
    try {
      const base = (await this.refExists('HEAD')) ? 'HEAD' : EMPTY_TREE;
      const out = await this.git.raw(['diff', '--numstat', '-z', '-M', base, '--']);
      const fields = out.split('\0');
      for (let i = 0; i < fields.length; i++) {
        const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(fields[i]);
        if (!m) continue;
        let file = m[3];
        // A rename is "<add>\t<del>\t" followed by the old and the new path as their own fields.
        if (file === '') {
          file = fields[i + 2];
          i += 2;
        }
        counts.set(file, m[1] === '-' ? { binary: true } : { add: Number(m[1]), del: Number(m[2]) });
      }
      for (const file of status.not_added.slice(0, MAX_COUNTED_UNTRACKED)) {
        try {
          const full = path.join(this.repoPath, file);
          const { size } = await fs.promises.stat(full);
          if (size > MAX_PREVIEW_BYTES) continue;
          const buf = await fs.promises.readFile(full);
          if (buf.subarray(0, 8000).includes(0)) counts.set(file, { binary: true });
          else counts.set(file, { add: buf.length === 0 ? 0 : buf.toString('utf8').split('\n').length - (buf[buf.length - 1] === 10 ? 1 : 0), del: 0 });
        } catch {
          // unreadable: no count
        }
      }
    } catch {
      // counts are a nicety: the status still works without them
    }
    return counts;
  }

  // What committing this file would record: HEAD against the working tree, renames included.
  // options.full returns the whole file as context instead of three lines around each change.
  // Untracked files have no diff in Git, so their content comes back as one block of added lines.
  async getFileDiff(file, from, options = {}) {
    try {
      const target = String(file || '');
      if (!target) return { error: 'No file' };
      const status = await this.git.status();
      if (status.not_added.includes(target)) return await this.untrackedDiff(target);
      const base = (await this.refExists('HEAD')) ? 'HEAD' : EMPTY_TREE;
      const paths = from && String(from) !== target ? [String(from), target] : [target];
      const context = options && options.full ? FULL_CONTEXT : 3;
      const out = await this.git.raw([...diffConfigArgs(), 'diff', '--no-color', '--no-ext-diff', '-M', `-U${context}`, base, '--', ...paths]);
      return { file: target, diff: out.slice(0, MAX_DIFF_CHARS), truncated: out.length > MAX_DIFF_CHARS, full: Boolean(options && options.full) };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // Only called for paths Git itself lists as untracked, so the file is inside the repository.
  async untrackedDiff(file) {
    return { file, ...(await newFileDiff(path.join(this.repoPath, file), file)) };
  }

  // The folders this app added to .git/info/exclude (each line right after its marker comment).
  async parkedFolders() {
    const rel = (await this.git.raw(['rev-parse', '--git-path', 'info/exclude'])).trim();
    let text = '';
    try {
      text = await fs.promises.readFile(path.resolve(this.repoPath, rel), 'utf8');
    } catch {
      return [];
    }
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const folders = [];
    lines.forEach((line, i) => {
      if (line !== PARK_MARKER) return;
      const m = /^\/(.+)\/$/.exec(lines[i + 1] || '');
      if (!m) return;
      try {
        const folder = cleanFolder(m[1]);
        if (!folders.includes(folder)) folders.push(folder);
      } catch {
        // not a folder this app could have written
      }
    });
    return folders;
  }

  // Where a kept copy came from. "name (2).txt" is a second copy of "name.txt" when only the latter exists.
  originalFor(rel) {
    if (fs.existsSync(path.join(this.repoPath, rel))) return rel;
    const m = /^(.*) \((\d+)\)(\.[^./]*)?$/.exec(rel);
    if (m && fs.existsSync(path.join(this.repoPath, `${m[1]}${m[3] || ''}`))) return `${m[1]}${m[3] || ''}`;
    return rel;
  }

  // Files in each ignored folder, with whether the same path exists in the project and has changes there.
  async listParked() {
    try {
      const folders = await this.parkedFolders();
      if (folders.length === 0) return { folders: [] };
      const status = await this.git.status();
      const changed = new Set(status.files.flatMap((f) => [f.path, f.from].filter(Boolean)));
      const result = [];
      for (const folder of folders) {
        const root = path.join(this.repoPath, folder);
        const files = [];
        let truncated = false;
        const walk = async (dir) => {
          let entries;
          try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            if (files.length >= MAX_PARKED_FILES) {
              truncated = true;
              return;
            }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else if (e.isFile()) {
              const rel = path.relative(root, full).split(path.sep).join('/');
              const { size, mtimeMs } = await fs.promises.stat(full);
              const original = this.originalFor(rel);
              files.push({ file: rel, original, size, mtime: mtimeMs, inProject: fs.existsSync(path.join(this.repoPath, original)), projectChanged: changed.has(original) });
            }
          }
        };
        const exists = fs.existsSync(root);
        if (exists) await walk(root);
        files.sort((a, b) => a.file.localeCompare(b.file));
        result.push({ folder, exists, files, truncated });
      }
      return { folders: result };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // A kept copy, by its folder and its path inside it. Only folders this app registered, only files inside them.
  async resolveParked(folder, file) {
    const clean = cleanFolder(folder);
    if (!(await this.parkedFolders()).includes(clean)) throw new Error('Unknown ignored folder');
    const root = path.join(this.repoPath, clean);
    const full = path.resolve(root, String(file || ''));
    if (!full.startsWith(root + path.sep)) throw new Error('Unknown file');
    const stat = await fs.promises.stat(full).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error('The file is no longer there');
    const rel = path.relative(root, full).split(path.sep).join('/');
    return { folder: clean, root, full, rel, original: this.originalFor(rel) };
  }

  // The project's file (left) against the kept copy (right); the whole copy when the project has no such file.
  async parkedDiff(folder, file, options = {}) {
    try {
      const p = await this.resolveParked(folder, file);
      if (!fs.existsSync(path.join(this.repoPath, p.original))) {
        return { file: p.rel, original: p.original, inProject: false, ...(await newFileDiff(p.full, `${p.folder}/${p.rel}`)) };
      }
      const context = options && options.full ? FULL_CONTEXT : 3;
      const out = await gitNoIndexDiff(this.repoPath, [...diffConfigArgs(), 'diff', '--no-index', '--no-color', '--no-ext-diff', `-U${context}`, '--', p.original, `${p.folder}/${p.rel}`]);
      return { file: p.rel, original: p.original, inProject: true, diff: out.slice(0, MAX_DIFF_CHARS), truncated: out.length > MAX_DIFF_CHARS, full: Boolean(options && options.full) };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // Moves a kept copy back to its place in the project, where it counts as a change again. Refused when that
  // would overwrite work: the project's file has uncommitted changes, or exists without being in Git.
  async restoreParked(folder, file) {
    try {
      const p = await this.resolveParked(folder, file);
      const target = path.join(this.repoPath, p.original);
      const status = await this.git.status();
      const changed = new Set(status.files.flatMap((f) => [f.path, f.from].filter(Boolean)));
      if (changed.has(p.original)) return { error: `${p.original} has changes that are not committed. Commit or revert them first, so they are not lost.` };
      if (fs.existsSync(target)) {
        const inHead = (await this.refExists('HEAD'))
          && (await this.git.raw(['--literal-pathspecs', 'ls-tree', '--name-only', 'HEAD', '--', p.original])).trim() !== '';
        if (!inHead) return { error: `${p.original} already exists and is not in Git, so it would be lost. Move it away first.` };
        await fs.promises.unlink(target);
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await moveFile(p.full, target);
      await removeEmptyDirs(path.dirname(p.full), p.root);
      return { success: true, file: p.original };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // One side of a diff the app can show: 'work' (a changed file in the working copy), 'head' (that file in the
  // last commit, read only), 'project' and 'parked' (the project's file and its kept copy, in the Ignored tab).
  async resolveDiffSide(side) {
    const kind = side && side.kind;
    if (kind === 'project' || kind === 'parked') {
      const p = await this.resolveParked(side.folder, side.file);
      return { full: kind === 'parked' ? p.full : path.join(this.repoPath, p.original) };
    }
    const file = String((side && side.file) || '');
    if (kind === 'head') return { head: file };
    if (kind !== 'work') throw new Error('Unknown side');
    // only a file Git lists as changed, inside the repository
    const status = await this.git.status();
    if (!status.files.some((f) => f.path === file)) throw new Error('This file has no changes any more');
    const full = path.resolve(this.repoPath, file);
    if (!full.startsWith(this.repoPath + path.sep)) throw new Error('Unknown file');
    return { full };
  }

  async readDiffSide(side) {
    try {
      const s = await this.resolveDiffSide(side);
      if (s.head !== undefined) return { text: await this.git.raw(['show', `HEAD:${s.head}`]) };
      const stat = await fs.promises.stat(s.full).catch(() => null);
      if (!stat || !stat.isFile()) return { error: 'The file is no longer there' };
      if (stat.size > MAX_SIDE_BYTES) return { error: 'The file is too big to change here' };
      return { text: await fs.promises.readFile(s.full, 'utf8') };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  async writeDiffSide(side, text) {
    try {
      if (typeof text !== 'string') return { error: 'Nothing to write' };
      if (Buffer.byteLength(text) > MAX_SIDE_BYTES) return { error: 'The file is too big to change here' };
      const s = await this.resolveDiffSide(side);
      if (s.head !== undefined) return { error: 'The last commit cannot be changed' };
      const stat = await fs.promises.stat(s.full).catch(() => null);
      if (!stat || !stat.isFile()) return { error: 'The file is no longer there' };
      await fs.promises.writeFile(s.full, text);
      return { success: true };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // A branch the menus name by its full ref: refs/heads/<name> or refs/remotes/<remote>/<name>.
  // With tags: true a tag is accepted too (its log, a branch started from it).
  async branchTarget(ref, { tags = false } = {}) {
    const target = String(ref || '');
    if (!(tags ? /^refs\/(heads|remotes|tags)\/./ : /^refs\/(heads|remotes)\/./).test(target)) throw new Error('Unknown branch');
    if (!(await this.refExists(target))) throw new Error('Branch not found');
    return target;
  }

  // The history of a branch with Git's own graph: one row per line of `git log --graph`. A commit row also has its
  // hash, message, author, date and the branch and tag names that point at it.
  async getBranchGraph(ref, count = 200) {
    try {
      const target = await this.branchTarget(ref, { tags: true });
      const n = Math.min(Math.max(Math.round(Number(count)) || 200, 1), 500);
      // full ref names, so a local feature/x and the remote origin/x cannot be mixed up
      const out = await this.git.raw(['log', '--graph', '--date-order', '--decorate=full', `-n${n}`, '--format=%x1f%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%D', target, '--']);
      const rows = out.split('\n').filter((l) => l.trim()).map((line) => {
        const cut = line.indexOf('\x1f');
        if (cut === -1) return { graph: line.replace(/\s+$/, '') };
        const [hash, short, author, date, message, refs] = line.slice(cut + 1).split('\x1f');
        return { graph: line.slice(0, cut).replace(/\s+$/, ''), hash, short, author, date, message, refs: refs ? refs.split(', ').filter(Boolean) : [] };
      });
      const shown = rows.filter((r) => r.hash).length;
      const total = shown < n ? shown : Number((await this.git.raw(['rev-list', '--count', target, '--'])).trim()) || shown;
      return { ref: target, rows, shown, total };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // Merges a branch into the current one. When the merge stops on conflicts it says which files have them, as a pull does.
  async mergeBranch(ref) {
    const conflicts = () => this.stoppedOnConflicts('merge');
    try {
      const target = await this.branchTarget(ref);
      const current = (await this.git.raw(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
      if (!current) return { error: 'You are not on a branch (detached HEAD). Switch to a branch first.' };
      // the short name (main, origin/main) is what the merge commit message names
      const out = await this.git.raw(['merge', '--no-edit', target.replace(/^refs\/(heads|remotes)\//, '')]);
      return (await conflicts()) || { success: true, upToDate: /Already up.to.date/i.test(out) };
    } catch (e) {
      return (await conflicts()) || { error: cleanError(e.message) };
    }
  }

  // How many commits of a local branch no other branch, remote branch or tag has: deleting it would lose them.
  async branchOnlyCommits(name) {
    try {
      const branch = String(name || '');
      await this.branchTarget(`refs/heads/${branch}`);
      const out = await this.git.raw(['rev-list', '--count', `refs/heads/${branch}`, '--not', `--exclude=${branch}`, '--branches', '--remotes', '--tags']);
      return { count: Number(out.trim()) || 0 };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // A new branch starting at another branch (local or remote), switched to right away. Like createBranchFrom it does
  // not track the branch it starts from, so its first push goes to origin/<new name>.
  async createBranchAt(name, ref) {
    try {
      const branch = String(name || '').trim();
      if (!branch || branch.startsWith('-')) return { error: 'Invalid branch name' };
      try {
        await this.git.raw(['check-ref-format', '--branch', branch]);
      } catch {
        return { error: `"${branch}" is not a valid branch name` };
      }
      const target = await this.branchTarget(ref, { tags: true });
      if (await this.refExists(`refs/heads/${branch}`)) return { error: `fatal: a branch named '${branch}' already exists` };
      await this.git.raw(['checkout', '-b', branch, '--no-track', target]);
      return { success: true };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  async getLog(count = 15) {
    try {
      const log = await this.git.log({ maxCount: count });
      return log.all.map((entry) => ({
        hash: entry.hash.substring(0, 7),
        message: entry.message,
        author: entry.author_name,
        date: entry.date,
      }));
    } catch (e) {
      return { error: e.message };
    }
  }

  stashRef(index) {
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash');
    return `stash@{${index}}`;
  }

  async stashPush(message, files, includeUntracked) {
    try {
      const args = ['push'];
      if (includeUntracked) args.push('-u');
      if (message && message.trim()) args.push('-m', message.trim());
      if (Array.isArray(files) && files.length > 0) args.push('--', ...files.map(String));
      await this.git.stash(args);
      return { success: true };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  async stashList() {
    try {
      const out = await this.git.raw(['stash', 'list', '--format=%gd%x1f%gs%x1f%cI']);
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [ref, subject, date] = line.split('\x1f');
          const named = /^On /.test(subject);
          const m = /^(?:On|WIP on) (.+?): (.*)$/.exec(subject);
          return {
            index: Number(/\{(\d+)\}/.exec(ref)[1]),
            named,
            branch: m ? m[1] : '',
            message: m ? m[2] : subject,
            date,
          };
        });
    } catch (e) {
      return { error: e.message };
    }
  }

  async stashFiles(index) {
    try {
      const ref = this.stashRef(index);
      let out;
      try {
        out = await this.git.raw(['stash', 'show', '--name-only', '--include-untracked', ref]);
      } catch {
        out = await this.git.raw(['stash', 'show', '--name-only', ref]);
      }
      return out.split('\n').filter(Boolean);
    } catch (e) {
      return { error: e.message };
    }
  }

  async stashRun(command, index) {
    try {
      await this.git.stash([command, this.stashRef(index)]);
      if (command !== 'drop') {
        const { conflicted } = await this.git.status();
        if (conflicted.length > 0) {
          return {
            error: `Conflicts in: ${conflicted.join(', ')}. Resolve them${command === 'pop' ? ' (the stash was kept)' : ''}.`,
            conflict: true,
          };
        }
      }
      return { success: true };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  stashApply(index) {
    return this.stashRun('apply', index);
  }

  stashPop(index) {
    return this.stashRun('pop', index);
  }

  stashDrop(index) {
    return this.stashRun('drop', index);
  }

  async deleteBranch(branch) {
    try {
      await this.git.deleteLocalBranch(branch, true);
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  // Branches first, with the ones deleted on origin pruned; then the tags, without pruning, so a tag made here and not
  // pushed yet is kept. A tag that cannot be fetched (origin has another commit under that name) is only a warning.
  async fetch() {
    try {
      await this.git.fetch(['--all', '--prune']);
    } catch (e) {
      return { error: e.message };
    }
    try {
      await this.git.fetch(['--all', '--tags', '--no-prune']);
      return { success: true };
    } catch (e) {
      return { success: true, warning: cleanError(e.message) };
    }
  }

  // -- Commits: change or undo the last one, revert any, see what one changed --

  // A commit the app names by its hash; never an option, a range or a path. Returns the full hash.
  async commitTarget(hash) {
    const h = String(hash || '');
    if (!/^[0-9a-f]{4,40}$/i.test(h)) throw new Error('Unknown commit');
    const full = (await this.git.raw(['rev-parse', '--verify', '--quiet', `${h}^{commit}`]).catch(() => '')).trim();
    if (!full) throw new Error('Commit not found');
    return full;
  }

  // The last commit, and what may be done to it: it can still be changed while no branch on origin has it.
  async lastCommit() {
    try {
      if (!(await this.refExists('HEAD'))) return { error: 'There are no commits yet' };
      const out = await this.git.raw(['log', '-1', '--format=%H%x1f%h%x1f%P%x1f%cI%x1f%B', 'HEAD', '--']);
      const [hash, short, parents, date, ...body] = out.split('\x1f');
      const message = body.join('\x1f').trim();
      const onOrigin = (await this.git.raw(['branch', '-r', '--contains', 'HEAD'])).trim();
      const parentList = parents.trim() ? parents.trim().split(' ') : [];
      return { hash, short, message, date, merge: parentList.length > 1, root: parentList.length === 0, pushed: Boolean(onOrigin) };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // Changes the last commit: a new message, and the chosen files added to it (none: only the message changes).
  // --only keeps anything else that is staged out of it, as a normal commit of chosen files does.
  async amendCommit(message, files) {
    try {
      const last = await this.lastCommit();
      if (last.error) return last;
      if (last.pushed) return { error: `${last.short} is already on origin, so it cannot be changed. Use Revert in the Log instead.` };
      if (await this.operation()) return { error: 'Finish or abort the merge first' };
      const text = String(message || '').trim();
      if (!text) return { error: 'Write a commit message' };
      const paths = [...new Set((files || []).map(String).filter(Boolean))];
      if (paths.length > 0) {
        const status = await this.git.status();
        const untracked = paths.filter((p) => status.not_added.includes(p));
        if (untracked.length > 0) await this.git.add(['--', ...untracked]);
      }
      await this.git.raw(['commit', '--amend', '--only', '-m', text, ...(paths.length ? ['--', ...paths] : [])]);
      return { success: true };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // Takes back the last commit: its changes go back to Changes (staged) and nothing is lost. Not for a commit origin
  // already has (that needs Revert) nor for a merge commit.
  async undoLastCommit() {
    try {
      const last = await this.lastCommit();
      if (last.error) return last;
      if (last.pushed) return { error: `${last.short} is already on origin, so it cannot be undone here. Use Revert in the Log instead.` };
      if (last.merge) return { error: `${last.short} is a merge commit. Use Revert in the Log to undo it.` };
      if (await this.operation()) return { error: 'Finish or abort the merge first' };
      // the first commit has no parent to go back to: the branch goes back to having no commits
      if (last.root) await this.git.raw(['update-ref', '-d', 'HEAD']);
      else await this.git.raw(['reset', '--soft', 'HEAD~1']);
      return { success: true, short: last.short, message: last.message };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // A new commit that undoes another one, also one origin already has. A merge commit is undone against its first
  // parent (the branch it was merged into). Stops on conflicts like a merge.
  async revertCommit(hash) {
    const nothing = { error: 'Nothing to revert: the changes of that commit are already undone here.' };
    try {
      const commit = await this.commitTarget(hash);
      if (await this.operation()) return { error: 'Finish or abort the merge first' };
      const parents = (await this.git.raw(['rev-list', '--parents', '-n1', commit])).trim().split(' ').length - 1;
      const before = (await this.git.revparse(['HEAD'])).trim();
      await this.git.raw(['revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), commit]);
      const conflict = await this.stoppedOnConflicts('revert');
      if (conflict) return conflict;
      // Its changes are already gone: Git has nothing to commit, says so only on stdout (which simple-git does not
      // count as a failure) and some versions leave the revert waiting.
      if ((await this.git.revparse(['HEAD'])).trim() === before) {
        if (await this.operation()) await this.git.raw(['revert', '--abort']).catch(() => {});
        return nothing;
      }
      return { success: true };
    } catch (e) {
      const conflict = await this.stoppedOnConflicts('revert');
      if (conflict) return conflict;
      if (/nothing to commit/i.test(e.message)) {
        if (await this.operation()) await this.git.raw(['revert', '--abort']).catch(() => {});
        return nothing;
      }
      return { error: cleanError(e.message) };
    }
  }

  // One page of the current branch's history (or of options.ref: a branch, a tag or a commit, as Compare names them),
  // newest first, with the files of each commit (a merge: against its first parent), the branch and tag names on it,
  // and whether origin has it. With options.base too, only the commits ref has that base has not ("base..ref"). A
  // search keeps the commits whose message, author or hash has the text (looking through the latest 5000). With
  // options.graph (and no search) the commits come in the order of Git's graph, from the first one, with the graph:
  // one row per line of `git log --graph`, a commit's row with its hash.
  async getLogPage(options = {}) {
    try {
      if (!(await this.refExists('HEAD'))) return { commits: [], total: 0, more: false, head: '' };
      const skip = Math.max(0, Math.round(Number(options.skip)) || 0);
      const count = Math.min(Math.max(Math.round(Number(options.count)) || 100, 1), 500);
      const query = String(options.query || '').trim().toLowerCase().slice(0, 200);
      const graph = Boolean(options.graph) && !query;
      const format = '--format=%x1e%H%x1f%s%x1f%an%x1f%cI%x1f%P%x1f%D';
      const tip = options.ref ? await this.compareTarget(options.ref) : 'HEAD';
      const spec = options.base ? [`${await this.compareTarget(options.base)}..${tip}`] : [tip];
      let total;
      let args;
      if (query) {
        const all = await this.git.raw(['log', '-n5000', '--format=%H%x1f%s%x1f%an%x1f%ae', ...spec, '--']);
        const found = all.split('\n').filter(Boolean).map((l) => l.split('\x1f'))
          .filter(([h, subject, name, email]) => h.startsWith(query) || [subject, name, email].some((v) => (v || '').toLowerCase().includes(query)))
          .map(([h]) => h);
        total = found.length;
        const page = found.slice(skip, skip + count);
        if (page.length === 0) return { commits: [], total, more: false, head: (await this.git.revparse(['HEAD'])).trim() };
        args = ['--no-walk=unsorted', ...page];
      } else {
        total = Number((await this.git.raw(['rev-list', '--count', ...spec, '--'])).trim()) || 0;
        args = graph ? ['--topo-order', `-n${skip + count}`, ...spec] : [`--skip=${skip}`, `-n${count}`, ...spec];
      }
      const run = (extra) => this.git.raw(['log', '--decorate=full', '--name-status', ...extra, format, ...args, '--']);
      // --diff-merges is newer Git (2.31); without it a merge simply lists no files
      const out = await run(['--diff-merges=first-parent']).catch(() => run([]));
      const commits = out.split('\x1e').map((c) => c.trim()).filter(Boolean).map((chunk) => {
        const [header, ...rest] = chunk.split('\n');
        const [hash, message, author, date, parents, refs] = header.split('\x1f');
        return {
          hash: hash.slice(0, 7), fullHash: hash, message, author, date,
          parents: parents ? parents.split(' ') : [],
          refs: refs ? refs.split(', ').filter(Boolean) : [],
          files: parseNameStatus(rest.join('\n')),
        };
      });
      // commits no branch on any remote has yet (all of them when there is no remote)
      const hasRemote = (await this.git.getRemotes()).length > 0;
      const local = new Set(hasRemote ? (await this.git.raw(['rev-list', '-n2000', tip, '--not', '--remotes'])).split('\n').filter(Boolean) : []);
      for (const c of commits) c.pushed = hasRemote && !local.has(c.fullHash);
      const branch = (await this.git.raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim(); // none on no branch
      const page = { commits, total, more: (graph ? 0 : skip) + commits.length < total, head: (await this.git.revparse(['HEAD'])).trim(), branch };
      if (graph) {
        // --graph sorts as --topo-order does, so its commits are the ones above, in its order
        const out = await this.git.raw(['log', '--graph', '--format=%x1f%H', `-n${skip + count}`, ...spec, '--']);
        page.graph = out.split('\n').filter((l) => l.trim()).map((line) => {
          const cut = line.indexOf('\x1f');
          return cut === -1 ? { graph: line.replace(/\s+$/, '') } : { graph: line.slice(0, cut).replace(/\s+$/, ''), hash: line.slice(cut + 1).trim() };
        });
      }
      return page;
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // What one commit changed in one file: against its first parent (the empty tree for the first commit).
  async getCommitFileDiff(hash, file, from, options = {}) {
    try {
      const commit = await this.commitTarget(hash);
      const target = String(file || '');
      if (!target) return { error: 'No file' };
      const base = (await this.refExists(`${commit}^`)) ? `${commit}^` : EMPTY_TREE;
      const paths = from && String(from) !== target ? [String(from), target] : [target];
      const context = options && options.full ? FULL_CONTEXT : 3;
      const out = await this.git.raw([...diffConfigArgs(), 'diff', '--no-color', '--no-ext-diff', '-M', `-U${context}`, base, commit, '--', ...paths]);
      return { file: target, diff: out.slice(0, MAX_DIFF_CHARS), truncated: out.length > MAX_DIFF_CHARS, full: Boolean(options && options.full) };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // -- Compare: two points of the history, each a branch (yours or on origin), a tag or any commit --

  // A side as the app names it: a full ref under refs/heads, refs/remotes or refs/tags, or a commit hash; never an
  // option, a range or a path. Returns the commit it points at.
  async compareTarget(side) {
    const s = String(side || '');
    if (s === EMPTY_TREE) return s; // before the first commit
    const ok = s === 'HEAD' || (/^refs\/(heads|remotes|tags)\/[^\s~^:?*[\\]+$/.test(s) && !s.includes('..')) || /^[0-9a-f]{4,40}$/i.test(s);
    if (!ok) throw new Error('Unknown branch, tag or commit');
    const full = (await this.git.raw(['rev-parse', '--verify', '--quiet', `${s}^{commit}`]).catch(() => '')).trim();
    if (!full) throw new Error(`${s.replace(/^refs\/(heads|remotes|tags)\//, '')} not found`);
    return full;
  }

  // What can be compared: your branches, the ones on the remotes and the tags (newest version first).
  async compareRefs() {
    try {
      const branches = await this.git.raw(['for-each-ref', '--format=%(refname)', '--sort=refname', 'refs/heads', 'refs/remotes']);
      const tagsOut = await this.git.raw(['for-each-ref', '--format=%(refname)%1f%(objectname)%1f%(*objectname)', '--sort=-v:refname', 'refs/tags']);
      const local = [];
      const remote = [];
      for (const ref of branches.split('\n').filter(Boolean)) {
        if (ref.startsWith('refs/heads/')) local.push({ ref, name: ref.slice(11) });
        else if (!ref.endsWith('/HEAD')) remote.push({ ref, name: ref.slice(13) });
      }
      const tags = tagsOut.split('\n').filter(Boolean).map((line) => {
        const [ref, object, peeled] = line.split('\x1f');
        return { ref, name: ref.slice(10), hash: peeled || object };
      });
      const hasHead = await this.refExists('HEAD');
      const current = (await this.git.raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
      const head = hasHead ? (await this.git.revparse(['HEAD'])).trim() : '';
      return { local, remote, tags, head, current: current.startsWith('refs/heads/') ? current : '' };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // The latest commits of one side, each with its tags and the version it is on: the nearest tag below it and how many
  // commits came after that tag ("v1.0.2 +2"), as git describe says; none when no tag is below it.
  async compareCommits(side, count = 100) {
    try {
      const tip = await this.compareTarget(side);
      const n = Math.min(Math.max(Math.round(Number(count)) || 100, 1), 300);
      const out = await this.git.raw(['log', `-n${n}`, '--decorate=full', '--format=%H%x1f%s%x1f%an%x1f%cI%x1f%D', tip, '--']);
      const commits = out.split('\n').filter(Boolean).map((line) => {
        const [hash, message, author, date, refs] = line.split('\x1f');
        const tags = (refs || '').split(', ').filter((r) => r.startsWith('tag: ')).map((r) => r.slice(5).replace(/^refs\/tags\//, ''));
        return { hash: hash.slice(0, 7), fullHash: hash, message, author, date, tags, version: null };
      });
      const hasTags = (await this.git.raw(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/tags'])).trim();
      if (hasTags && commits.length) {
        const described = await this.git.raw(['describe', '--tags', '--always', '--abbrev=40', ...commits.map((c) => c.fullHash)]).catch(() => '');
        described.split('\n').filter(Boolean).forEach((line, i) => {
          const c = commits[i];
          if (!c || line === c.fullHash) return;
          const m = line.match(/^(.+)-(\d+)-g[0-9a-f]{40}$/);
          c.version = m ? { tag: m[1], after: Number(m[2]) } : { tag: line, after: 0 };
        });
      }
      const total = commits.length < n ? commits.length : Number((await this.git.raw(['rev-list', '--count', tip, '--'])).trim()) || n;
      return { tip, commits, total };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // From one side to the other: the files that differ (with lines added and removed), the commits the second side
  // has that the first has not, and how many the first has that the second has not.
  // With options.mergeBase (the Log's Base <- Compare, as on GitHub) the files go from where the two sides split
  // (their merge base, returned as base) to `to`, so what `from` gained since is left out.
  async compare(from, to, options = {}) {
    try {
      const a = await this.compareTarget(from);
      const b = await this.compareTarget(to);
      let base = a;
      if (options.mergeBase && a !== EMPTY_TREE) {
        base = (await this.git.raw(['merge-base', a, b]).catch(() => '')).trim();
        if (!base) return { error: 'These two have no history in common' };
      }
      const [names, nums, log, ahead, behind] = await Promise.all([
        this.git.raw(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--name-status', '-M', base, b, '--']),
        this.git.raw(['diff', '--no-color', '--no-ext-diff', '--numstat', '-M', '-z', base, b, '--']),
        this.git.raw(['log', '-n300', '--format=%H%x1f%s%x1f%an%x1f%cI', ...this.range(a, b), '--']),
        this.git.raw(['rev-list', '--count', ...this.range(a, b), '--']),
        a === EMPTY_TREE ? '0' : this.git.raw(['rev-list', '--count', `${b}..${a}`, '--']),
      ]);
      // --numstat -z: "added<TAB>removed<TAB>path\0", or for a rename "added<TAB>removed<TAB>\0old\0new\0".
      const lines = new Map();
      const parts = nums.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const m = parts[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
        if (!m) continue;
        let file = m[3];
        if (!file) {
          file = parts[i + 2];
          i += 2;
        }
        lines.set(file, m[1] === '-' ? { binary: true } : { added: Number(m[1]), removed: Number(m[2]) });
      }
      const files = parseNameStatus(names).map((f) => ({ ...f, ...(lines.get(f.file) || {}) }));
      const commits = log.split('\n').filter(Boolean).map((line) => {
        const [hash, message, author, date] = line.split('\x1f');
        return { hash: hash.slice(0, 7), fullHash: hash, message, author, date };
      });
      const aheadN = Number(ahead.trim()) || 0;
      const behindN = Number(behind.trim()) || 0;
      // nothing from a to b: the commits the other way (b..a), for a preview
      let back = [];
      if (!aheadN && behindN) {
        const out = await this.git.raw(['log', '-n100', '--decorate=full', '--format=%H%x1f%s%x1f%an%x1f%cI%x1f%D', `${b}..${a}`, '--']);
        back = out.split('\n').filter(Boolean).map((line) => {
          const [hash, message, author, date, refs] = line.split('\x1f');
          return { hash: hash.slice(0, 7), fullHash: hash, message, author, date, refs: refs ? refs.split(', ').filter(Boolean) : [] };
        });
      }
      return { from: a, to: b, base, files, commits, ahead: aheadN, behind: behindN, back };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // "a..b" for git log and rev-list; all of b when a is the empty tree (from before the first commit).
  range(a, b) {
    return a === EMPTY_TREE ? [b] : [`${a}..${b}`];
  }

  // The tags, newest version first (the branch list shows them after the branches).
  async listTags() {
    try {
      const out = await this.git.raw(['for-each-ref', '--sort=-v:refname', '--format=%(refname:strip=2)', 'refs/tags']);
      return { tags: out.split('\n').filter(Boolean) };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // Goes to the commit of a tag, on no branch (detached HEAD). Changed files that the switch would overwrite stop it.
  async checkoutTag(name) {
    try {
      const tag = await this.tagName(name);
      if (!(await this.refExists(`refs/tags/${tag}`))) return { error: `Tag ${tag} not found` };
      await this.git.raw(['checkout', '--detach', `refs/tags/${tag}`]);
      return { success: true };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // One file from one side to the other.
  async compareFileDiff(from, to, file, oldFile, options = {}) {
    try {
      const a = await this.compareTarget(from);
      const b = await this.compareTarget(to);
      const target = String(file || '');
      if (!target) return { error: 'No file' };
      const paths = oldFile && String(oldFile) !== target ? [String(oldFile), target] : [target];
      const context = options && options.full ? FULL_CONTEXT : 3;
      const out = await this.git.raw([...diffConfigArgs(), 'diff', '--no-color', '--no-ext-diff', '-M', `-U${context}`, a, b, '--', ...paths]);
      return { file: target, diff: out.slice(0, MAX_DIFF_CHARS), truncated: out.length > MAX_DIFF_CHARS, full: Boolean(options && options.full) };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // -- Tags --

  async tagName(name) {
    const tag = String(name || '').trim();
    if (!tag || tag.startsWith('-')) throw new Error('Invalid tag name');
    try {
      await this.git.raw(['check-ref-format', `refs/tags/${tag}`]);
    } catch {
      throw new Error(`"${tag}" is not a valid tag name`);
    }
    return tag;
  }

  // The version after the highest vX.Y.Z tag (the last number plus one), or v1.0.0 when there is none.
  async suggestTag() {
    try {
      const out = await this.git.raw(['tag', '--list', '--sort=-v:refname']);
      const latest = out.split('\n').map((t) => t.trim()).find((t) => /^v?\d+\.\d+\.\d+$/.test(t));
      if (!latest) return { name: 'v1.0.0' };
      const [, v, major, minor, patch] = /^(v?)(\d+)\.(\d+)\.(\d+)$/.exec(latest);
      return { name: `${v}${major}.${minor}.${Number(patch) + 1}`, latest };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // An annotated tag (the kind releases use) on a commit, pushed to origin right away when asked.
  async createTag(name, hash, push) {
    try {
      const tag = await this.tagName(name);
      const commit = await this.commitTarget(hash);
      if (await this.refExists(`refs/tags/${tag}`)) return { error: `A tag named ${tag} already exists` };
      await this.git.raw(['tag', '-a', tag, '-m', tag, commit]);
      if (!push) return { success: true, tag, pushed: false };
      const pushed = await this.pushTag(tag);
      return pushed.error ? { success: true, tag, pushed: false, pushError: pushed.error } : { success: true, tag, pushed: true };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  async pushTag(name) {
    try {
      const tag = await this.tagName(name);
      if (!(await this.refExists(`refs/tags/${tag}`))) return { error: `Tag ${tag} not found` };
      await this.git.raw(['push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
      return { success: true, tag };
    } catch (e) {
      const rejected = /\[rejected\][^\n]*\(([^)]+)\)/.exec(e.message);
      return { error: `${rejected ? `Push rejected (${rejected[1]}). ` : ''}${cleanError(e.message)}` };
    }
  }

  // Whether origin has the tag. Asks origin, so it needs the network.
  async tagOnOrigin(name) {
    try {
      const tag = await this.tagName(name);
      return { onOrigin: Boolean((await this.git.raw(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])).trim()) };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // Deletes a tag here and, when asked, on origin first (if that fails the tag is still here to try again).
  async deleteTag(name, alsoOrigin) {
    try {
      const tag = await this.tagName(name);
      if (alsoOrigin) await this.git.raw(['push', 'origin', '--delete', `refs/tags/${tag}`]);
      await this.git.raw(['tag', '-d', tag]);
      return { success: true, tag };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // -- Branches: rename, delete on origin --

  // A new name for a local branch. Its link to origin/<old name> is dropped, so the next push makes origin/<new name>;
  // origin/<old name> stays on origin until it is deleted there.
  async renameBranch(oldName, newName) {
    try {
      const from = String(oldName || '');
      await this.branchTarget(`refs/heads/${from}`);
      const to = String(newName || '').trim();
      if (!to || to.startsWith('-')) return { error: 'Invalid branch name' };
      try {
        await this.git.raw(['check-ref-format', '--branch', to]);
      } catch {
        return { error: `"${to}" is not a valid branch name` };
      }
      if (to === from) return { error: 'That is already its name' };
      if (await this.refExists(`refs/heads/${to}`)) return { error: `fatal: a branch named '${to}' already exists` };
      const upstream = (await this.git.raw(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${from}`])).trim();
      await this.git.raw(['branch', '-m', from, to]);
      if (upstream) await this.git.raw(['branch', '--unset-upstream', to]).catch(() => {});
      return { success: true, name: to, oldUpstream: upstream };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // The origin branch behind refs/remotes/origin/<name>, as <name>.
  async originBranch(ref) {
    const target = await this.branchTarget(ref);
    const m = /^refs\/remotes\/origin\/(.+)$/.exec(target);
    if (!m || m[1] === 'HEAD') throw new Error('Only branches on origin can be deleted here');
    return m[1];
  }

  // How many commits of a branch on origin no other branch (local or remote) or tag has: deleting it would lose them.
  async remoteOnlyCommits(ref) {
    try {
      const name = await this.originBranch(ref);
      const out = await this.git.raw(['rev-list', '--count', `refs/remotes/origin/${name}`, '--not', '--branches', `--exclude=origin/${name}`, '--remotes', '--tags']);
      return { count: Number(out.trim()) || 0 };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  async deleteRemoteBranch(ref) {
    try {
      const name = await this.originBranch(ref);
      await this.git.raw(['push', 'origin', '--delete', `refs/heads/${name}`]);
      return { success: true, name };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }

  // Makes a plain folder a Git repository, on a branch called main (older Git: its own default name).
  async initRepo() {
    try {
      if (fs.existsSync(path.join(this.repoPath, '.git'))) return { error: 'This folder is already a Git repository' };
      try {
        await this.git.raw(['init', '-b', 'main']);
      } catch {
        await this.git.raw(['init']);
      }
      return { success: true };
    } catch (e) {
      return { error: cleanError(e.message) };
    }
  }
}

module.exports = GitService;
module.exports.cleanFolder = cleanFolder;
module.exports.cloneRepo = cloneRepo;
module.exports.PARK_DEFAULT_FOLDER = PARK_DEFAULT_FOLDER;
