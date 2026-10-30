const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const shell = require('./shell');
const { SKIP } = require('./analysis');

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

// -- Macros: several commands saved under a name, for every microservice, run one after the other --
const MACRO_LIMITS = { count: 30, steps: 15, name: 60, text: 400 };
const SERVER_GOALS = /(^|\s)spring-boot:run(\s|$)/;
// A step that starts the application does not end by itself, so it can only be the last one.
const keepsRunning = (step) => (step.kind === 'preset' && ['start', 'debug'].includes(step.preset)) || (step.kind === 'custom' && SERVER_GOALS.test(step.goals));

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
  const steps = raw.map((step, i) => {
    const kind = step && step.kind;
    if (kind === 'stop') return { kind };
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
  const id = typeof input.id === 'string' && /^[\w-]{1,64}$/.test(input.id) ? input.id : crypto.randomUUID();
  return { id, name, steps };
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
  if (IS_WIN) return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', buildScript(dir, args, wrapper)], { cwd: dir, windowsHide: true });
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
  // run of the same repository takes its place (a macro that stops it first), so their output does not mix.
  function newRun(repoPath, command, header, extra = {}) {
    const run = { child: null, active: true, cancelled: false, muted: false, repo: repoPath, command, log: header, exitCode: null, startedAt: Date.now(), endedAt: null, ...extra };
    run.done = new Promise((resolve) => (run.resolveDone = resolve));
    return run;
  }
  const write = (run, text) => {
    run.log = (run.log + text).slice(-MAX_LOG_CHARS);
    if (!run.muted) send('mvn-output', { repo: run.repo, text });
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
    if (runs.get(key(run.repo)) === run) send('mvn-exit', { repo: run.repo, exitCode, endedAt: run.endedAt, failedStep: run.failedStep || null, stopped: run.cancelled });
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
      ports,
      ...presetView(ports),
      run: run && {
        command: run.command,
        log: run.log,
        running: run.active,
        exitCode: run.exitCode,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        macro: run.macro || null,
        stepCommand: run.stepCommand || null,
        failedStep: run.failedStep || null,
        stopped: run.cancelled,
      },
    };
  }

  ipcMain.handle('mvn-info', (_, repoPath) => {
    if (!isKnownRepo(repoPath)) return { error: 'Unknown repository' };
    return infoFor(repoPath);
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
      const env = IS_WIN || request.external ? null : await shell.loginShellEnv();
      const k = key(repoPath);
      const current = runs.get(k);
      if (current && current.active) throw new Error('A command is already running in this repository. Stop it first.');
      const command = `mvn ${args.join(' ')}`;

      if (request.external) {
        shell.openInTerminal(dir, mavenArgv(dir, args, findWrapper(dir, repoPath)), 'maven');
        shell.stepBack();
        return { success: true, external: true, command };
      }

      const run = newRun(repoPath, command, `> ${command}${rel ? `   (in ${rel}/)` : ''}\n`);
      runs.set(k, run);
      announce();
      runStep(run, dir, args, env).then((code) => finishRun(run, code));
      return { success: true, command, startedAt: run.startedAt, log: run.log };
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

  // The steps of a macro in the repository's folder, one after the other; the first that fails ends it. A Stop step
  // ends what was running in the repository when the macro began (the app started before, or the same macro), so a
  // macro can stop the app, build and start it again.
  ipcMain.handle('mvn-macro-run', async (_, repoPath, id) => {
    try {
      if (!isKnownRepo(repoPath)) throw new Error('Unknown repository');
      const macro = macroList().find((m) => m.id === String(id));
      if (!macro) throw new Error('That macro is gone');
      const { dir, rel } = chosenDir(repoPath);
      if (!fs.existsSync(path.join(dir, 'pom.xml'))) throw new Error('No pom.xml in this repository');
      const k = key(repoPath);
      const previous = runs.get(k);
      const busy = Boolean(previous && previous.active);
      if (busy && !macro.steps.some((st) => st.kind === 'stop')) throw new Error('Something is running in this repository. Stop it first, or begin the macro with a Stop step.');
      const ports = portsFor(repoPath);
      const plan = macro.steps.map((st) => (st.kind === 'stop' ? { stop: true, label: 'Stop what is running' } : { args: stepArgs(st, ports), label: `mvn ${stepArgs(st, ports).join(' ')}` }));
      const env = IS_WIN ? null : await shell.loginShellEnv();
      const run = newRun(repoPath, macro.name, `> macro ${macro.name}: ${plan.length} step${plan.length === 1 ? '' : 's'}${rel ? `   (in ${rel}/)` : ''}\n`, {
        macro: { id: macro.id, name: macro.name, step: 0, total: plan.length, steps: plan.map((p) => p.label) },
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
          run.stepCommand = p.label;
          send('mvn-step', { repo: repoPath, step: i + 1, total: plan.length, command: p.label });
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
            continue;
          }
          code = await runStep(run, dir, p.args, env);
          write(run, `[exit code ${code}]\n`);
          if (code !== 0) {
            failedStep = i + 1;
            break;
          }
        }
        finishRun(run, code, { failedStep });
      })();
      return { success: true, command: macro.name, startedAt: run.startedAt, log: run.log, macro: run.macro };
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
