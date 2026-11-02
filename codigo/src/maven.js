const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const shell = require('./shell');
const { SKIP } = require('./analysis');
const GitService = require('./git-service');
const envValues = require('./env-values');

const { IS_WIN, psQuote } = shell;
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
// branch, pull) --
const MACRO_LIMITS = { count: 30, steps: 15, name: 60, text: 400 };
const SERVER_GOALS = /(^|\s)spring-boot:run(\s|$)/;
// Under the command: the values the application gets over its files (the Values button), and where they come from.
const valuesLine = (values, note) => (values ? `  SPRING_APPLICATION_JSON: ${String(note || `${Object.keys(values).length} values`).slice(0, 300)}\n` : '');
// A step that starts the application does not end by itself, so it can only be the last one.
const keepsRunning = (step) => (step.kind === 'preset' && ['start', 'debug'].includes(step.preset)) || (step.kind === 'custom' && SERVER_GOALS.test(step.goals));
const GIT_KINDS = new Set(['changes', 'fetch', 'checkout', 'branch', 'pull', 'unstash']);
const MAVEN_KINDS = new Set(['preset', 'custom']);
// Local changes: asked when the macro runs (stash, discard or stop), or always the same answer.
const CHANGES_POLICIES = ['ask', 'stash', 'discard', 'stop'];
// A branch a step names: only the characters branch names use, never an option or a range. Git has the last word
// (check-ref-format) when the step runs.
const branchText = (v) => String(v || '').trim().slice(0, 200);
const isBranchName = (t) => /^[\w./-]+$/.test(t) && !t.startsWith('-') && !t.startsWith('/') && !t.endsWith('/') && !t.endsWith('.') && !t.endsWith('.lock') && !t.includes('..') && !t.includes('//');

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
function buildScript(dir, args, wrapper = findWrapper(dir)) {
  const exe = wrapper ? wrapperCall(dir, wrapper) : 'mvn';
  return [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `& ${psQuote(exe)} ${args.map(psQuote).join(' ')}`,
    'exit $LASTEXITCODE',
  ].join('; ');
}

// The command a run starts, in the folder chosen for the repository: PowerShell with the script on Windows. On macOS
// and Linux Maven starts straight from the app, no shell in between, with the environment of the user's shell (see
// shell.js, so a Mac app opened from the Finder still finds Homebrew's mvn and SDKMAN's Java): the project's mvnw
// (through sh, so it works even without the executable bit a Windows checkout leaves off) or mvn, in its own process
// group so Stop can end Maven and the Java it started together.
function startMaven(dir, args, env, wrapper = findWrapper(dir)) {
  if (IS_WIN) return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', buildScript(dir, args, wrapper)], { cwd: dir, windowsHide: true, ...(env ? { env } : {}) });
  if (wrapper) return spawn('/bin/sh', [wrapperCall(dir, wrapper), ...args], { cwd: dir, env, detached: true });
  return spawn('mvn', args, { cwd: dir, env, detached: true });
}

// "Separate window": the same command in PowerShell (Windows) or Terminal (macOS), left open when it ends.
const mavenArgv = (dir, args, wrapper = findWrapper(dir)) => {
  if (!wrapper) return ['mvn', ...args];
  return IS_WIN ? [wrapperCall(dir, wrapper), ...args] : ['/bin/sh', wrapperCall(dir, wrapper), ...args];
};
const terminalScript = (dir, args) => shell.terminalScript(dir, mavenArgv(dir, args));

function registerMaven({ isKnownRepo, getWindow, loadPorts, savePorts, loadDir, saveDir, loadMacros, saveMacros }) {
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
  const macroList = () => {
    const list = loadMacros ? loadMacros() : [];
    return Array.isArray(list) ? list : [];
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

  // Maven once, its output added to the run's log; resolves with the exit code.
  function runStep(run, dir, args, env) {
    return new Promise((resolve) => {
      let settled = false;
      const end = (code) => {
        if (settled) return;
        settled = true;
        run.child = null;
        resolve(code);
      };
      const child = startMaven(dir, args, env, findWrapper(dir, run.repo));
      run.child = child;
      const append = (chunk) => write(run, chunk.toString('utf8'));
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', (e) => {
        const why = e.code === 'ENOENT' && !IS_WIN
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
    const wrapper = findWrapper(dir, repoPath);
    return {
      hasPom: fs.existsSync(path.join(dir, 'pom.xml')),
      dir: rel,
      lostDir: lost || null,
      folders: pomFolders(repoPath),
      wrapper: Boolean(wrapper),
      wrapperDir: wrapper ? relOf(repoPath, path.dirname(wrapper)) : null,
      options: OPTIONS.map(({ id, args, label }) => ({ id, flag: args.join(' '), label })),
      profiles: pomProfiles(dir),
      // the environments with an application-<env> file: Start and Debug can take their values (the Values button)
      valueEnvs: envValues.listEnvs(dir),
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
      // the values chosen per environment go to the application only: a build or the tests run with the files
      const values = SERVER_GOALS.test(args.join(' ')) ? envValues.cleanValues(request.values) : null;
      const env = envValues.withValues(IS_WIN || request.external ? null : await shell.loginShellEnv(), values);
      const k = key(repoPath);
      const current = runs.get(k);
      if (current && current.active) throw new Error('A command is already running in this repository. Stop it first.');
      const command = `mvn ${args.join(' ')}`;

      if (request.external) {
        shell.openInTerminal(dir, mavenArgv(dir, args, findWrapper(dir, repoPath)), 'maven');
        shell.stepBack();
        return { success: true, external: true, command, valuesLeft: Boolean(values) };
      }

      const run = newRun(repoPath, command, `> ${command}${rel ? `   (in ${rel}/)` : ''}\n${valuesLine(values, request.valuesNote)}`);
      runs.set(k, run);
      announce();
      runStep(run, dir, args, env).then((code) => finishRun(run, code));
      return { success: true, command, startedAt: run.startedAt, log: run.log, id: run.id, written: run.written };
    } catch (e) {
      return { error: e.message };
    }
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
      if (macro.steps.some((st) => MAVEN_KINDS.has(st.kind)) && !fs.existsSync(path.join(dir, 'pom.xml'))) throw new Error('No pom.xml in this repository');
      const ctx = { answers: cleanAnswers(macro, answers), stash: null };
      if (macro.steps.some((st) => GIT_KINDS.has(st.kind)) && !(await new GitService(repoPath).isGitRepo())) throw new Error('This folder has no Git, and the macro has git steps');
      const k = key(repoPath);
      const previous = runs.get(k);
      const busy = Boolean(previous && previous.active);
      if (busy && !macro.steps.some((st) => st.kind === 'stop')) throw new Error('Something is running in this repository. Stop it first, or begin the macro with a Stop step.');
      const ports = portsFor(repoPath);
      const plan = macro.steps.map((st, i) => {
        if (st.kind === 'stop') return { stop: true, label: 'Stop what is running' };
        if (GIT_KINDS.has(st.kind)) return { git: st, label: gitStepLabel(st, ctx.answers, i) };
        return { args: stepArgs(st, ports), label: `mvn ${stepArgs(st, ports).join(' ')}` };
      });
      const env = IS_WIN ? null : await shell.loginShellEnv();
      const values = envValues.cleanValues(valuesRequest && valuesRequest.values);
      const run = newRun(repoPath, macro.name, `> macro ${macro.name}: ${plan.length} step${plan.length === 1 ? '' : 's'}${rel ? `   (in ${rel}/)` : ''}\n`, {
        // marks: when each step began, and how long it took once it ended (for the list of steps by the output)
        macro: { id: macro.id, name: macro.name, step: 0, total: plan.length, steps: plan.map((p) => p.label), marks: [] },
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
              previous.cancelled = true;
              if (previous.child) await killTree(previous.child);
              await Promise.race([previous.done, new Promise((r) => setTimeout(r, 15000))]);
              write(run, 'Stopped.\n');
            } else write(run, 'Nothing was running.\n');
            ended();
            continue;
          }
          if (p.git) code = await runGitStep(run, p.git, i, ctx);
          else {
            // the step that starts the application gets the values chosen per environment; the others, the files
            const starts = values && SERVER_GOALS.test(p.args.join(' '));
            if (starts) write(run, valuesLine(values, valuesRequest.valuesNote));
            code = await runStep(run, dir, p.args, starts ? envValues.withValues(env, values) : env);
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
    run.cancelled = true;
    if (run.child) await killTree(run.child);
    return { success: true };
  });

  ipcMain.handle('mvn-clear', (_, repoPath) => {
    const run = runs.get(key(String(repoPath)));
    if (run && !run.active) runs.delete(key(String(repoPath)));
    return true;
  });

  const stopAll = () =>
    Promise.all(
      [...runs.values()].filter((r) => r.active).map((r) => {
        r.cancelled = true;
        return r.child ? killTree(r.child) : null;
      })
    );
  return { stopAll };
}

module.exports = { registerMaven, PRESETS, OPTIONS, DEFAULT_PORTS, parsePorts, tokenize, buildScript, terminalScript, pomProfiles, withOptions, findWrapper, pomFolders, cleanMacro };
