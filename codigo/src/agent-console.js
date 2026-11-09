// consola-agente: a conversation with Claude CLI, the one on this computer, in a project folder, and each thing it
// does as it does it. The app starts the CLI with stream-json in and out. Each line it writes goes to the page as it
// is. What the user writes, and the answers to its permission requests, go to its input in the form it reads
// (control_request / control_response, as the Agent SDK speaks to it).
// One session at a time. The process stays open between messages. If it ends, the next message starts it again with
// --resume and the session's id.
const { ipcMain, dialog, app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const shell = require('./shell');
const agents = require('./agent-review');

// --permission-prompt-tool stdio: the permission requests come on its output and the answers go to its input.
// --allow-dangerously-skip-permissions only makes "bypassPermissions" a mode that can be chosen; it is never on until
// the user picks it (the page asks first).
const ARGS = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--allow-dangerously-skip-permissions'];
// What the page can choose: a model alias the CLI knows ('' is its own default) and one of its permission modes.
// Anything else is refused, so the page cannot hand the CLI what it likes. They go to it as control requests (set_model,
// set_permission_mode), the first thing after it starts and whenever the user changes them.
const MODELS = ['', 'fable', 'opus', 'sonnet', 'haiku'];
const MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'];
const MAX_MESSAGE = 100000;
// what is kept of a session for a page that opens again: the oldest go first past this
const MAX_KEPT = 50000;
const MAX_KEPT_CHARS = 60 * 1024 * 1024;
const INTERRUPT_WAIT_MS = 5000;
const END_WAIT_MS = 3000;
const DENIED = 'The user refused this in QuickDeck.';

// The rules an "allow always" adds: the ones the CLI suggests, kept to this session (never written to a settings
// file); else one for this tool, and for a command only this command.
function sessionRules(req) {
  const given = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [];
  const rules = given.filter((p) => p && typeof p === 'object' && (
    (p.type === 'addRules' && p.behavior === 'allow') || p.type === 'addDirectories' || (p.type === 'setMode' && p.mode === 'acceptEdits')
  )).map((p) => ({ ...p, destination: 'session' }));
  if (rules.length) return rules;
  const rule = { toolName: String(req.tool_name || '') };
  if (rule.toolName === 'Bash' && req.input && typeof req.input.command === 'string') rule.ruleContent = req.input.command;
  return [{ type: 'addRules', rules: [rule], behavior: 'allow', destination: 'session' }];
}

// The answer to a permission request: choice allow | always | deny; answers: for AskUserQuestion, { question: label }.
function permissionAnswer(req, choice, answers) {
  const input = req.input && typeof req.input === 'object' ? req.input : {};
  if (choice === 'deny') return { behavior: 'deny', message: DENIED };
  if (req.tool_name === 'AskUserQuestion') {
    const given = {};
    for (const [q, a] of Object.entries(answers && typeof answers === 'object' ? answers : {})) {
      const value = Array.isArray(a) ? a.map((x) => String(x).slice(0, 2000)).join(', ') : String(a ?? '').slice(0, 2000);
      if (value) given[String(q).slice(0, 2000)] = value;
    }
    return { behavior: 'allow', updatedInput: { ...input, answers: given } };
  }
  const out = { behavior: 'allow', updatedInput: input };
  if (choice === 'always' && !req.suppress_always_allow_rule) out.updatedPermissions = sessionRules(req);
  return out;
}

function registerAgentConsole({ getWindow, isKnownRepo, withDialog }) {
  const picked = new Set(); // folders the user chose with the dialog, in this run of the app
  const s = {
    cwd: null,
    sessionId: null,
    child: null,
    starting: null,
    events: [],
    chars: 0,
    trimmed: false,
    n: 0,
    pending: new Map(), // request_id -> the can_use_tool request
    interrupt: null, // { id, timer }
    stderr: '',
    model: '', // the alias chosen ('': the CLI's own)
    mode: 'default', // the permission mode in force (what was chosen, or what the CLI says it is now)
    liveModel: '', // the model the CLI says it uses
    finished: false, // ended by the user: it is not taken up again
    controls: new Map(), // request_id -> { kind, value, prev } of a change asked and not answered yet
  };

  const guard = (fn) => async (_, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { error: e && typeof e.error === 'string' ? e.error : String((e && e.message) || e), code: (e && e.code) || 'failed' };
    }
  };

  // to the page, and kept: kind out (a line of the CLI), in (a line the app wrote to it), err (its stderr), state
  const emit = (event) => {
    // transient: told to the page, not part of the history (a choice the user made)
    if (event.transient) {
      const live = getWindow();
      if (live && !live.isDestroyed()) live.webContents.send('agent-console-event', { n: 0, at: Date.now(), ...event });
      return;
    }
    const ev = { n: ++s.n, at: Date.now(), ...event };
    s.events.push(ev);
    s.chars += (ev.line || ev.text || '').length + 60;
    while (s.events.length > MAX_KEPT || s.chars > MAX_KEPT_CHARS) {
      const old = s.events.shift();
      s.chars -= (old.line || old.text || '').length + 60;
      s.trimmed = true;
    }
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('agent-console-event', ev);
  };
  const stateOf = () => ({ running: Boolean(s.child), cwd: s.cwd, sessionId: s.sessionId, pending: [...s.pending.keys()], model: s.model, liveModel: s.liveModel, mode: s.mode, finished: s.finished });

  const write = (obj) => {
    if (!s.child || !s.child.stdin.writable) throw new Error('O Claude CLI não está a correr');
    const line = JSON.stringify(obj);
    s.child.stdin.write(`${line}\n`);
    emit({ kind: 'in', line });
  };

  // A change of model or mode asked of the CLI. prev: what it goes back to if the CLI refuses.
  const askChange = (kind, value, prev) => {
    const id = `gq-set-${kind}-${s.n + 1}`;
    s.controls.set(id, { kind, value, prev });
    const request = kind === 'model' ? { subtype: 'set_model', ...(value ? { model: value } : {}) } : { subtype: 'set_permission_mode', mode: value };
    write({ type: 'control_request', request_id: id, request });
  };

  const take = (line) => {
    const text = line.replace(/\r$/, '');
    if (!text.trim()) return;
    emit({ kind: 'out', line: text });
    let e;
    try {
      e = JSON.parse(text);
    } catch {
      return;
    }
    if (!e || typeof e !== 'object') return;
    if (e.type === 'system' && e.subtype === 'init' && typeof e.session_id === 'string') s.sessionId = e.session_id;
    if (e.type === 'system' && e.subtype === 'init' && typeof e.model === 'string') s.liveModel = e.model;
    // the mode the CLI says it is in (it changes it too: a plan accepted goes to acceptEdits); not while a change of
    // ours is on its way, whose events come one behind
    if (e.type === 'system' && (e.subtype === 'status' || e.subtype === 'init') && MODES.includes(e.permissionMode)
      && e.permissionMode !== s.mode && ![...s.controls.values()].some((c) => c.kind === 'mode')) {
      s.mode = e.permissionMode;
      emit({ kind: 'state', state: 'choice', what: 'mode', transient: true, ...stateOf() });
    }
    if (e.type === 'control_response' && e.response && s.controls.has(e.response.request_id)) {
      const c = s.controls.get(e.response.request_id);
      s.controls.delete(e.response.request_id);
      if (e.response.subtype === 'success') {
        const got = e.response.response && typeof e.response.response === 'object' ? e.response.response : {};
        if (c.kind === 'model' && typeof got.model === 'string') s.liveModel = got.model;
        if (c.kind === 'mode' && MODES.includes(got.mode)) s.mode = got.mode;
        emit({ kind: 'state', state: 'applied', what: c.kind, value: c.kind === 'model' ? (got.model || '') : (got.mode || c.value), ...stateOf() });
      } else {
        s[c.kind] = c.prev;
        emit({ kind: 'state', state: 'refused', what: c.kind, error: String(e.response.error || 'o Claude CLI recusou').slice(0, 300), ...stateOf() });
      }
    }
    if (e.type === 'result' && typeof e.session_id === 'string') s.sessionId = e.session_id;
    if (e.type === 'control_request' && e.request && typeof e.request_id === 'string') {
      if (e.request.subtype === 'can_use_tool') s.pending.set(e.request_id, e.request);
      // nothing else is asked of a host that did not say it handles it; if it is, it is told so, not left waiting
      else {
        try {
          write({ type: 'control_response', response: { subtype: 'error', request_id: e.request_id, error: `QuickDeck does not handle ${String(e.request.subtype).slice(0, 60)}` } });
        } catch {
          // it has ended
        }
      }
    }
    if (e.type === 'control_cancel_request' && typeof e.request_id === 'string') s.pending.delete(e.request_id);
    if (e.type === 'control_response' && e.response && s.interrupt && e.response.request_id === s.interrupt.id) {
      clearTimeout(s.interrupt.timer);
      s.interrupt = null;
    }
  };

  async function start() {
    const agent = await agents.findAgent('claude');
    if (!agent || !agent.found) throw { code: 'no-agent', error: 'O Claude CLI não está neste computador. Instala-o, entra uma vez com "claude" num terminal e volta aqui.' };
    if (!s.cwd || !fs.existsSync(s.cwd)) throw new Error('A pasta do projeto já não existe');
    // session_state_changed events (running, idle, requires_action): the page knows when it works
    const env = { ...agents.agentEnv(await shell.loginShellEnv()), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };
    const args = [...ARGS, ...(s.sessionId ? ['--resume', s.sessionId] : [])];
    let child;
    try {
      child = spawn(agent.file, args, { cwd: s.cwd, env, windowsHide: true, detached: !shell.IS_WIN, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`O Claude CLI não arrancou: ${e.message}`);
    }
    s.child = child;
    s.stderr = '';
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buffer += d;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (s.child === child) take(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      if (s.child !== child) return;
      s.stderr = (s.stderr + d).slice(-4000);
      emit({ kind: 'err', text: String(d).slice(0, 20000) });
    });
    child.stdin.on('error', () => {});
    const ended = (code, signal, error) => {
      if (s.child !== child) return;
      if (buffer.trim()) take(buffer);
      buffer = '';
      s.child = null;
      s.pending.clear();
      s.controls.clear();
      if (s.interrupt) clearTimeout(s.interrupt.timer);
      s.interrupt = null;
      emit({ kind: 'state', state: 'ended', code: code ?? null, signal: signal || null, error: error || null, stderr: s.stderr.trim().split('\n').slice(-3).join('\n').slice(0, 600), ...stateOf() });
    };
    child.on('error', (e) => ended(null, null, `O Claude CLI não arrancou: ${e.message}`));
    child.on('close', (code, signal) => ended(code, signal, null));
    emit({ kind: 'state', state: 'started', resumed: args.includes('--resume'), version: agent.version || '', ...stateOf() });
    // the choices of the user, before the first message: it takes them at once (and a mode it does not allow here, such
    // as auto on some plans, comes back refused and goes back to the usual)
    try {
      if (s.model) askChange('model', s.model, '');
      if (s.mode !== 'default') askChange('mode', s.mode, 'default');
    } catch {
      // it has ended already
    }
  }

  async function ensureRunning() {
    if (s.finished) throw new Error('Esta conversa terminou: carrega em Nova sessão para começar outra');
    if (s.child) return;
    if (!s.starting) s.starting = start().finally(() => { s.starting = null; });
    await s.starting;
  }

  async function end() {
    const child = s.child;
    s.child = null;
    s.pending.clear();
    s.controls.clear();
    if (s.interrupt) clearTimeout(s.interrupt.timer);
    s.interrupt = null;
    if (!child) return;
    // its input closed first: it ends its turn and stops; forced after a few seconds
    try {
      child.stdin.end();
    } catch {
      // closed already
    }
    const closed = new Promise((resolve) => child.once('close', resolve));
    const late = new Promise((resolve) => setTimeout(() => resolve('late'), END_WAIT_MS));
    if (child.exitCode === null && child.signalCode === null && (await Promise.race([closed, late])) === 'late') await shell.killTree(child);
  }

  ipcMain.handle('agent-console-info', guard(async (again) => {
    const agent = await agents.findAgent('claude', Boolean(again));
    return {
      agent: agent ? { found: agent.found, name: agent.name, command: agent.command, version: agent.version } : { found: false },
      ...stateOf(),
      trimmed: s.trimmed,
      events: s.events.slice(),
    };
  }));

  // The model or the permission mode, for this session and the next: to the CLI at once when it is running.
  ipcMain.handle('agent-console-set', guard(async (kind, value) => {
    const v = String(value ?? '');
    if (kind === 'model') {
      if (!MODELS.includes(v)) throw new Error('Modelo desconhecido');
      const prev = s.model;
      s.model = v;
      if (s.child && !s.finished) askChange('model', v, prev);
    } else if (kind === 'mode') {
      if (!MODES.includes(v)) throw new Error('Modo de permissões desconhecido');
      const prev = s.mode;
      s.mode = v;
      if (s.child && !s.finished) askChange('mode', v, prev);
    } else throw new Error('Escolha desconhecida');
    emit({ kind: 'state', state: 'choice', what: kind, transient: true, ...stateOf() });
    return { ok: true };
  }));

  // "Terminar": the conversation ends, the CLI with it; what was said stays to read, and nothing takes it up again.
  ipcMain.handle('agent-console-end', guard(async () => {
    if (s.finished) return { ok: true };
    await end();
    s.finished = true;
    emit({ kind: 'state', state: 'finished', ...stateOf() });
    return { ok: true };
  }));

  ipcMain.handle('agent-console-folder', guard(async () => {
    const win = getWindow();
    const res = await withDialog(() => dialog.showOpenDialog(win, { title: 'A pasta do projeto para o Claude', properties: ['openDirectory'] }));
    if (!res || res.canceled || !res.filePaths || !res.filePaths[0]) return { path: null };
    picked.add(res.filePaths[0]);
    return { path: res.filePaths[0] };
  }));

  ipcMain.handle('agent-console-send', guard(async (cwd, text) => {
    const message = String(text ?? '');
    if (!message.trim()) throw new Error('Escreve primeiro o que queres pedir');
    if (message.length > MAX_MESSAGE) throw new Error(`A mensagem é longa demais (mais de ${MAX_MESSAGE / 1000} mil caracteres)`);
    if (!s.cwd) {
      const dir = String(cwd || '');
      if (!dir || !(isKnownRepo(dir) || picked.has(dir))) throw new Error('Escolhe primeiro o projeto');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('A pasta do projeto já não existe');
      s.cwd = dir;
    } else if (cwd && cwd !== s.cwd) {
      throw new Error('Esta sessão é de outro projeto: começa uma nova sessão para mudar');
    }
    await ensureRunning();
    write({ type: 'user', message: { role: 'user', content: message }, parent_tool_use_id: null, session_id: s.sessionId || '' });
    return { ok: true };
  }));

  ipcMain.handle('agent-console-permission', guard(async (requestId, choice, answers) => {
    const req = s.pending.get(String(requestId));
    if (!req) throw new Error('Este pedido já não está à espera de resposta');
    const how = ['allow', 'always', 'deny'].includes(choice) ? choice : 'deny';
    write({ type: 'control_response', response: { subtype: 'success', request_id: String(requestId), response: permissionAnswer(req, how, answers) } });
    s.pending.delete(String(requestId));
    return { ok: true };
  }));

  // the CLI is asked to stop its turn; if it does not answer in a few seconds, it gets SIGINT
  ipcMain.handle('agent-console-interrupt', guard(async () => {
    if (!s.child) return { ok: true };
    if (s.interrupt) return { ok: true };
    const id = `gq-interrupt-${s.n + 1}`;
    write({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });
    const child = s.child;
    s.interrupt = {
      id,
      timer: setTimeout(() => {
        s.interrupt = null;
        if (s.child === child && child.exitCode === null) {
          emit({ kind: 'state', state: 'sigint', ...stateOf() });
          try {
            child.kill('SIGINT');
          } catch {
            // gone already
          }
        }
      }, INTERRUPT_WAIT_MS),
    };
    return { ok: true };
  }));

  ipcMain.handle('agent-console-new', guard(async () => {
    await end();
    s.finished = false;
    s.liveModel = '';
    s.cwd = null;
    s.sessionId = null;
    s.events = [];
    s.chars = 0;
    s.trimmed = false;
    emit({ kind: 'state', state: 'reset', ...stateOf() });
    return { ok: true };
  }));

  app.on('before-quit', () => {
    if (!s.child) return;
    try {
      s.child.stdin.end();
    } catch {
      // closed already
    }
    shell.killTree(s.child);
  });
}

module.exports = { registerAgentConsole, sessionRules, permissionAnswer, ARGS, MODELS, MODES };
