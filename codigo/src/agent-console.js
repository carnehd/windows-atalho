// consola-agente: a conversation with Claude CLI or with Copilot CLI (the user chooses), the one on this computer, in a
// project folder, and each thing it does as it does it. The app starts Claude CLI with stream-json in and out; Copilot CLI
// with --acp (acp.js), and what it says goes to the page in the form of Claude's. Each line it writes goes to the page as it
// is. What the user writes, and the answers to its permission requests, go to its input in the form it reads
// (control_request / control_response, as the Agent SDK speaks to it).
// One session at a time. The process stays open between messages. If it ends, the next message starts it again with
// --resume and the session's id.
const { ipcMain, dialog, app, shell: electronShell } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const shell = require('./shell');
const consoleAgents = require('./console-agents');
const agentLogs = require('./agent-logs');
const agentProcs = require('./agent-procs');
const agents = require('./agent-review');
const { COPILOT_MODES, Translator, pickOption } = require('./acp');

// --permission-prompt-tool stdio: the permission requests come on its output and the answers go to its input.
// --allow-dangerously-skip-permissions only makes "bypassPermissions" a mode that can be chosen; it is never on until
// the user picks it (the page asks first).
const ARGS = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--allow-dangerously-skip-permissions'];
// What the page can choose: a model alias the CLI knows ('' is its own default) and one of its permission modes.
// Anything else is refused, so the page cannot hand the CLI what it likes. They go to it as control requests (set_model,
// set_permission_mode), the first thing after it starts and whenever the user changes them.
const MODELS = ['', 'fable', 'opus', 'sonnet', 'haiku'];
const MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'];
// Copilot CLI takes its model when it starts (--model): the ones it knows are read from its own help (`copilot help config`,
// which asks nobody), and these are what is used when that cannot be read (the list of 1.0.108).
const COPILOT_MODELS_FALLBACK = [
  'claude-sonnet-5.5', 'claude-sonnet-5', 'claude-fable-5.1', 'claude-fable-5',
  'claude-opus-5.5', 'claude-opus-5', 'claude-opus-4.8', 'claude-opus-4.8-fast',
  'claude-sonnet-4.6', 'claude-haiku-5.5', 'claude-haiku-4.5', 'gpt-6.1-sol',
  'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.3-codex',
  'mai-code-1.1-flash', 'gemini-4-argon', 'gemini-3.8-flash', 'grok-4.7',
  'grok-4.6', 'kimi-k3',
];
const COPILOT_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
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

// The models in `copilot help config`: the lines "- "name"" under `model`, up to the blank line.
function parseCopilotModels(text) {
  const lines = String(text).split('\n');
  const at = lines.findIndex((l) => /^\s*`model`:/.test(l));
  if (at < 0) return [];
  const found = [];
  for (const line of lines.slice(at + 1)) {
    const m = /^\s*-\s*"([^"]+)"\s*$/.exec(line);
    if (m) {
      if (COPILOT_MODEL_ID.test(m[1])) found.push(m[1]);
    } else if (found.length) break;
  }
  return [...new Set(found)];
}

function registerAgentConsole({ getWindow, isKnownRepo, withDialog, dataDir }) {
  const picked = new Set(); // folders the user chose with the dialog, in this run of the app
  const s = {
    cwd: null,
    agent: 'claude', // claude | copilot: chosen before the session starts
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
    agentsDir: '', // the folder where the agents are (chosen by the user, kept in data/agent-console.json)
    subagent: '', // the id of the agent chosen in that folder ('': the CLI's own)
    overlay: null, // the temporary folder the session started with, that has that agent
  };

  // The folder of the agents is the only thing kept of this page, in a file of its own.
  const settingsFile = dataDir ? path.join(dataDir, 'agent-console.json') : null;
  try {
    const kept = settingsFile ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
    if (kept && typeof kept.agentsDir === 'string') s.agentsDir = kept.agentsDir;
  } catch {
    // nothing kept yet
  }
  const keepSettings = () => {
    if (!settingsFile) return;
    try {
      fs.writeFileSync(settingsFile, JSON.stringify({ agentsDir: s.agentsDir }, null, 2));
    } catch {
      // for this run only
    }
  };
  // What the folder has now, for the page: no path of a file, only what a person chooses by.
  const listAgents = () => {
    if (!s.agentsDir) return { dir: '', agents: [], truncated: false };
    let isDir = false;
    try {
      isDir = fs.statSync(s.agentsDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return { dir: s.agentsDir, agents: [], truncated: false, error: 'A pasta já não existe' };
    const { agents: found, truncated } = consoleAgents.scanAgents(s.agentsDir);
    return { dir: s.agentsDir, truncated, agents: found.map(({ id, name, description, cli, skills }) => ({ id, name, description, cli, skills })) };
  };
  const dropOverlay = () => {
    consoleAgents.removeOverlay(s.overlay);
    s.overlay = null;
  };

  // The models Copilot CLI offers, read once for each version of it; those of its own help, else the fallback.
  let modelsKept = null; // { key, promise }: what is asked once is shared by those who ask while it is on its way
  async function copilotModels(again = false) {
    const agent = await agents.findAgent('copilot', again);
    if (!agent || !agent.found) return { models: COPILOT_MODELS_FALLBACK, source: 'fallback' };
    const key = `${agent.file}|${agent.version || ''}`;
    if (!again && modelsKept && modelsKept.key === key) return modelsKept.promise;
    const promise = (async () => {
      let models = [];
      try {
        const env = agents.agentEnv(await shell.loginShellEnv());
        const text = await new Promise((resolve, reject) => {
          execFile(agent.file, ['help', 'config'], { env, timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, shell: /\.(cmd|bat)$/i.test(agent.file) }, (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout))));
        });
        models = parseCopilotModels(text);
      } catch {
        models = [];
      }
      return models.length ? { models, source: 'cli' } : { models: COPILOT_MODELS_FALLBACK, source: 'fallback' };
    })();
    modelsKept = { key, promise };
    return promise;
  }

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
  const stateOf = () => ({ running: Boolean(s.child), agentId: s.agent, cwd: s.cwd, sessionId: s.sessionId, pending: [...s.pending.keys()], model: s.model, liveModel: s.liveModel, mode: s.mode, finished: s.finished, subagent: s.subagent, agentsDir: s.agentsDir });

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

  // -- Copilot CLI: ACP, JSON-RPC lines on its input and output. What it says goes to the page in Claude's form. --
  const copilot = { id: 0, calls: new Map(), tr: null, loading: false, turn: null, queue: [], modes: {} };
  const copilotReset = () => {
    const calls = [...copilot.calls.values()];
    copilot.calls.clear();
    copilot.tr = null;
    copilot.loading = false;
    copilot.turn = null;
    copilot.queue = [];
    for (const c of calls) c.reject(new Error('O Copilot CLI terminou'));
  };
  const rawSend = (obj) => {
    if (!s.child || !s.child.stdin.writable) throw new Error('O Copilot CLI não está a correr');
    s.child.stdin.write(`${JSON.stringify(obj)}\n`);
  };
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++copilot.id;
    copilot.calls.set(id, { resolve, reject, method });
    try {
      rawSend({ jsonrpc: '2.0', id, method, params });
    } catch (e) {
      copilot.calls.delete(id);
      reject(e);
    }
  });
  const out = (event) => emit({ kind: 'out', line: JSON.stringify(event) });
  const echo = (event) => emit({ kind: 'in', line: JSON.stringify(event) });

  // a request of the agent for permission: the mode can answer for the user; else the page asks
  const handlePermission = (m) => {
    const p = m.params || {};
    const call = p.toolCall || {};
    const edits = ['edit', 'delete', 'move'].includes(String(call.kind || ''));
    if (s.mode === 'bypassPermissions' || (s.mode === 'acceptEdits' && edits)) {
      const optionId = pickOption(p.options, 'allow');
      rawSend({ jsonrpc: '2.0', id: m.id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } });
      return;
    }
    const id = `acp-${m.id}`;
    const ev = copilot.tr.permission(id, call, p.options);
    s.pending.set(id, { acp: true, rpcId: m.id, options: p.options, input: ev.request.input });
    out(ev);
  };

  const takeAcp = (line) => {
    const text = line.replace(/\r$/, '');
    if (!text.trim()) return;
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (m.id !== undefined && !m.method && copilot.calls.has(m.id)) {
      const c = copilot.calls.get(m.id);
      copilot.calls.delete(m.id);
      if (m.error) c.reject(Object.assign(new Error(String((m.error && m.error.message) || 'erro')), { code: m.error && m.error.code, data: m.error && m.error.data }));
      else c.resolve(m.result || {});
      return;
    }
    if (m.method === 'session/update' && m.params) {
      if (copilot.loading || !copilot.tr) return; // what a session loaded says again is not said twice
      for (const ev of copilot.tr.update(m.params.update || {})) out(ev);
      return;
    }
    if (m.method === 'session/request_permission' && m.id !== undefined && copilot.tr) {
      handlePermission(m);
      return;
    }
    // nothing else is asked of a client that did not say it does it
    if (m.method && m.id !== undefined) {
      try {
        rawSend({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `QuickDeck does not handle ${String(m.method).slice(0, 60)}` } });
      } catch {
        // it has ended
      }
    }
  };

  // one turn at a time: what is written meanwhile waits for its turn
  const pump = () => {
    if (copilot.turn || !copilot.queue.length || !copilot.tr) return;
    const message = copilot.queue.shift();
    const at = Date.now();
    out({ type: 'system', subtype: 'session_state_changed', state: 'running', session_id: s.sessionId });
    const turn = rpc('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: message }] });
    copilot.turn = turn;
    const done = (stopReason, error, usage) => {
      if (copilot.turn !== turn) return;
      copilot.turn = null;
      if (s.interrupt) {
        clearTimeout(s.interrupt.timer);
        s.interrupt = null;
      }
      if (copilot.tr) for (const ev of copilot.tr.turnEnd({ stopReason, ms: Date.now() - at, error, usage })) out(ev);
      out({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: s.sessionId });
      pump();
    };
    turn.then((r) => done((r && r.stopReason) || 'end_turn', null, r && r.usage), (e) => done('error', e, null));
  };
  const promptCopilot = (message) => {
    echo({ type: 'user', message: { role: 'user', content: message }, parent_tool_use_id: null, session_id: s.sessionId || '' });
    copilot.queue.push(message);
    pump();
  };

  // plan: the plan mode of the agent; any other: its usual one (the other modes are of the app: it answers the requests)
  const copilotSetMode = async (v) => {
    const id = copilot.modes[v === 'plan' ? 'plan' : 'agent'];
    if (id) await rpc('session/set_mode', { sessionId: s.sessionId, modeId: id });
  };

  const interruptCopilot = () => {
    if (!copilot.turn || s.interrupt) return;
    const id = `gq-interrupt-${s.n + 1}`;
    echo({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });
    for (const [rid, req] of [...s.pending]) {
      if (!req.acp) continue;
      try {
        rawSend({ jsonrpc: '2.0', id: req.rpcId, result: { outcome: { outcome: 'cancelled' } } });
      } catch {
        // it has ended
      }
      s.pending.delete(rid);
      out({ type: 'control_cancel_request', request_id: rid });
    }
    try {
      rawSend({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: s.sessionId } });
    } catch {
      // it has ended
    }
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
  };

  // initialize, then the session: new, or the one of before when the process had ended
  async function handshake(resume) {
    await rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'QuickDeck', version: app.getVersion() } });
    let res = null;
    if (resume && s.sessionId) {
      copilot.loading = true;
      try {
        res = await rpc('session/load', { sessionId: s.sessionId, cwd: s.cwd, mcpServers: [] });
      } catch {
        res = null;
        s.sessionId = null;
      } finally {
        copilot.loading = false;
      }
    }
    if (!res) {
      res = await rpc('session/new', { cwd: s.cwd, mcpServers: [] });
      s.sessionId = String(res.sessionId || '');
    }
    const modes = res.modes && Array.isArray(res.modes.availableModes) ? res.modes.availableModes : [];
    copilot.modes = Object.fromEntries(modes.map((x) => [String(x.id).split('#').pop(), x.id]));
    copilot.tr = new Translator(s.sessionId, { cwd: s.cwd, model: s.model });
    out(copilot.tr.init(s.mode));
    if (s.mode === 'plan') await copilotSetMode('plan').catch(() => {});
  }

  async function start() {
    const isCopilot = s.agent === 'copilot';
    const who = isCopilot ? 'Copilot CLI' : 'Claude CLI';
    const agent = await agents.findAgent(s.agent);
    if (!agent || !agent.found) throw { code: 'no-agent', error: isCopilot ? 'O Copilot CLI não está neste computador. Instala-o, entra uma vez com "copilot login" num terminal e volta aqui.' : 'O Claude CLI não está neste computador. Instala-o, entra uma vez com "claude" num terminal e volta aqui.' };
    if (!s.cwd || !fs.existsSync(s.cwd)) throw new Error('A pasta do projeto já não existe');
    const base = agents.agentEnv(await shell.loginShellEnv());
    // session_state_changed events (running, idle, requires_action): the page knows when it works
    const env = isCopilot ? base : { ...base, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };
    // started as the agent chosen from the folder: a folder of its own with it (and its skills) as this CLI reads them, taken with
    // --add-dir and --agent; made again each time the CLI starts, from what the file says now
    let asAgent = [];
    dropOverlay();
    if (s.subagent) {
      const found = consoleAgents.scanAgents(s.agentsDir).agents.find((a) => a.id === s.subagent && consoleAgents.fitsCli(a, isCopilot ? 'copilot' : 'claude'));
      if (!found) throw new Error('O agente escolhido já não está na pasta: recarrega a lista e escolhe outro');
      let made;
      try {
        made = consoleAgents.makeOverlay(found, isCopilot ? 'copilot' : 'claude', s.agentsDir);
      } catch (e) {
        throw new Error(`Não consegui preparar o agente ${found.name}: ${e.message}`);
      }
      s.overlay = made.dir;
      // a path with a space, for a command of Windows that goes through cmd
      const quoted = (v) => (/\s/.test(v) && /\.(cmd|bat)$/i.test(agent.file) ? `"${v}"` : v);
      asAgent = made.args.map(quoted);
      if (made.warnings.length) emit({ kind: 'state', state: 'agent-warning', warnings: made.warnings, ...stateOf() });
    }
    const args = isCopilot ? ['--acp', ...(s.model ? ['--model', s.model] : []), ...asAgent] : [...ARGS, ...(s.sessionId ? ['--resume', s.sessionId] : []), ...asAgent];
    const read = isCopilot ? takeAcp : take;
    let child;
    try {
      child = spawn(agent.file, args, { cwd: s.cwd, env, windowsHide: true, detached: !shell.IS_WIN, shell: /\.(cmd|bat)$/i.test(agent.file), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`O ${who} não arrancou: ${e.message}`);
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
        if (s.child === child) read(line);
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
      if (buffer.trim()) read(buffer);
      buffer = '';
      s.child = null;
      s.pending.clear();
      s.controls.clear();
      if (isCopilot) copilotReset();
      if (s.interrupt) clearTimeout(s.interrupt.timer);
      s.interrupt = null;
      emit({ kind: 'state', state: 'ended', code: code ?? null, signal: signal || null, error: error || null, stderr: s.stderr.trim().split('\n').slice(-3).join('\n').slice(0, 600), ...stateOf() });
    };
    child.on('error', (e) => ended(null, null, `O ${who} não arrancou: ${e.message}`));
    child.on('close', (code, signal) => ended(code, signal, null));
    const resumed = isCopilot ? Boolean(s.sessionId) : args.includes('--resume');
    emit({ kind: 'state', state: 'started', resumed, version: agent.version || '', ...stateOf() });
    if (isCopilot) {
      try {
        await handshake(resumed);
      } catch (e) {
        const said = String((e && e.message) || e);
        try {
          child.kill();
        } catch {
          // gone already
        }
        throw new Error(/auth|login|sign.?in|unauthori|credential/i.test(said) ? 'O Copilot CLI não tem sessão iniciada neste computador. Abre um terminal, corre "copilot login" e segue os passos.' : `O Copilot CLI não arrancou a sessão: ${said}`);
      }
      return;
    }
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
    copilotReset();
    if (s.interrupt) clearTimeout(s.interrupt.timer);
    s.interrupt = null;
    if (!child) {
      dropOverlay();
      return;
    }
    // its input closed first: it ends its turn and stops; forced after a few seconds
    try {
      child.stdin.end();
    } catch {
      // closed already
    }
    const closed = new Promise((resolve) => child.once('close', resolve));
    const late = new Promise((resolve) => setTimeout(() => resolve('late'), END_WAIT_MS));
    if (child.exitCode === null && child.signalCode === null && (await Promise.race([closed, late])) === 'late') await shell.killTree(child);
    dropOverlay();
  }

  ipcMain.handle('agent-console-info', guard(async (again) => {
    const [claude, copilotInfo] = await Promise.all([agents.findAgent('claude', Boolean(again)), agents.findAgent('copilot', Boolean(again))]);
    const shown = (a) => (a ? { id: a.id, found: a.found, name: a.name, command: a.command, version: a.version } : { found: false });
    const now = s.agent === 'copilot' ? copilotInfo : claude;
    return {
      agent: shown(now),
      agents: { claude: shown(claude), copilot: shown(copilotInfo) },
      ...stateOf(),
      trimmed: s.trimmed,
      events: s.events.slice(),
    };
  }));

  // The agents in the folder chosen, read again each time it is asked (that is what Reload does).
  ipcMain.handle('agent-console-agents', guard(() => listAgents()));

  // The folder of the agents: the user chooses it, and it is kept for the next time.
  ipcMain.handle('agent-console-agents-folder', guard(async () => {
    const win = getWindow();
    const res = await withDialog(() => dialog.showOpenDialog(win, { title: 'A pasta onde estão os agentes', defaultPath: s.agentsDir || undefined, properties: ['openDirectory'] }));
    if (!res || res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true, ...listAgents() };
    s.agentsDir = res.filePaths[0];
    keepSettings();
    const listed = listAgents();
    if (s.subagent && !listed.agents.some((a) => a.id === s.subagent && consoleAgents.fitsCli(a, s.agent))) s.subagent = '';
    emit({ kind: 'state', state: 'choice', what: 'subagent', transient: true, ...stateOf() });
    return listed;
  }));

  // The logs of the microservices the arrancador agent started (<tmp>/arranque-<name>/): the folders, the end of one file, and the
  // folder opened in the file manager. Read only, and only there (agent-logs.js). GQ_ARRANQUE_BASE moves it in a test, not in the exe.
  const logsBase = () => (!app.isPackaged && process.env.GQ_ARRANQUE_BASE) || agentLogs.defaultBase();
  // The list also says what each process is now (agent-procs.js): running, another process has the number, stopped, or not known.
  ipcMain.handle('agent-console-logs', guard(async () => {
    const listed = agentLogs.listRuns(logsBase());
    const entries = listed.runs.filter((r) => r.process).map((r) => ({ pid: r.process.pid, at: r.process.at }));
    const seen = entries.length ? await agentProcs.inspect(entries) : new Map();
    for (const r of listed.runs) {
      if (!r.process) continue;
      const i = seen.get(r.process.pid) || { state: 'unknown' };
      r.process = { pid: r.process.pid, state: i.state, alive: i.state === 'running', command: i.command || '', startedMs: i.startedMs || 0, ports: i.ports || [] };
    }
    return listed;
  }));
  // Stops the process of one run: the number is read again from its .pid file here (the page only names the run), and is only touched
  // if it is still the Java process the agent started. Asked first (SIGTERM), forced on request (SIGKILL).
  ipcMain.handle('agent-console-proc-stop', guard(async (run, force) => {
    const entry = agentLogs.pidEntry(logsBase(), String(run || ''));
    if (!entry) throw new Error('Esse microserviço já não tem um processo registado: recarrega a lista');
    return agentProcs.stop(entry, { force: force === true });
  }));
  ipcMain.handle('agent-console-log-read', guard((run, file) => agentLogs.readTail(logsBase(), String(run || ''), String(file || ''))));
  ipcMain.handle('agent-console-logs-open', guard(async (run) => {
    const dir = agentLogs.runDir(logsBase(), String(run || ''));
    if (!dir) throw new Error('Esse microserviço já não tem pasta de logs: recarrega a lista');
    const failed = await electronShell.openPath(dir);
    if (failed) throw new Error(failed);
    return { ok: true };
  }));

  // The models Copilot CLI offers (for the choice of the page).
  ipcMain.handle('agent-console-models', guard((again) => copilotModels(Boolean(again))));

  // The agent (before the session starts), the model or the permission mode, for this session and the next: to the agent at
  // once when it is running.
  ipcMain.handle('agent-console-set', guard(async (kind, value) => {
    const v = String(value ?? '');
    if (kind === 'agent') {
      if (!['claude', 'copilot'].includes(v)) throw new Error('Agente desconhecido');
      if (s.cwd && !s.finished) throw new Error('Esta sessão já começou: carrega em Nova sessão para mudar de agente');
      if (v !== s.agent) {
        s.agent = v;
        s.model = '';
        s.subagent = ''; // the agents of one are not the agents of the other
        if (v === 'copilot' && !COPILOT_MODES.includes(s.mode)) s.mode = 'default';
      }
    } else if (kind === 'model') {
      if (s.agent === 'copilot') {
        // '' is the CLI's own choice, auto lets it pick; any other is one of the models it lists
        const { models } = await copilotModels();
        if (v && v !== 'auto' && !models.includes(v)) throw new Error('Modelo desconhecido');
        if (v !== s.model) {
          if (s.child && !s.finished) {
            if (copilot.turn || s.pending.size || s.starting) throw new Error('Espera que o Copilot acabe o pedido antes de mudar de modelo');
            s.model = v;
            // Copilot CLI takes its model as it starts: it stops here, and the next message starts it again on the same session
            await end();
            emit({ kind: 'state', state: 'restart', what: 'model', value: v, ...stateOf() });
          } else s.model = v;
        }
      } else {
        if (!MODELS.includes(v)) throw new Error('Modelo desconhecido');
        const prev = s.model;
        s.model = v;
        if (s.child && !s.finished) askChange('model', v, prev);
      }
    } else if (kind === 'subagent') {
      // the agent is chosen before the session starts: it is how the CLI starts
      if (s.cwd && !s.finished) throw new Error('Esta sessão já começou: carrega em Nova sessão para mudar de agente');
      if (v && !listAgents().agents.some((a) => a.id === v && consoleAgents.fitsCli(a, s.agent))) throw new Error('Agente desconhecido nesta pasta: recarrega a lista');
      s.subagent = v;
    } else if (kind === 'mode') {
      if (!(s.agent === 'copilot' ? COPILOT_MODES : MODES).includes(v)) throw new Error('Modo de permissões desconhecido');
      const prev = s.mode;
      s.mode = v;
      if (s.agent === 'copilot') {
        // plan is the agent's own mode; the others are of the app (it answers the requests): the agent only has to leave plan
        if (s.child && !s.finished && copilot.tr && (v === 'plan' || prev === 'plan')) {
          copilotSetMode(v).then(() => emit({ kind: 'state', state: 'applied', what: 'mode', value: v, ...stateOf() })).catch((e) => {
            s.mode = prev;
            emit({ kind: 'state', state: 'refused', what: 'mode', error: String((e && e.message) || e).slice(0, 300), ...stateOf() });
          });
        }
      } else if (s.child && !s.finished) askChange('mode', v, prev);
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
    const res = await withDialog(() => dialog.showOpenDialog(win, { title: `A pasta do projeto para o ${s.agent === 'copilot' ? 'Copilot' : 'Claude'}`, properties: ['openDirectory'] }));
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
    if (s.agent === 'copilot') promptCopilot(message);
    else write({ type: 'user', message: { role: 'user', content: message }, parent_tool_use_id: null, session_id: s.sessionId || '' });
    return { ok: true };
  }));

  ipcMain.handle('agent-console-permission', guard(async (requestId, choice, answers) => {
    const req = s.pending.get(String(requestId));
    if (!req) throw new Error('Este pedido já não está à espera de resposta');
    const how = ['allow', 'always', 'deny'].includes(choice) ? choice : 'deny';
    if (req.acp) {
      const optionId = pickOption(req.options, how);
      rawSend({ jsonrpc: '2.0', id: req.rpcId, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } });
      echo({ type: 'control_response', response: { subtype: 'success', request_id: String(requestId), response: how === 'deny' ? { behavior: 'deny', message: DENIED } : { behavior: 'allow', updatedInput: req.input, ...(how === 'always' ? { updatedPermissions: [{ type: 'addRules', behavior: 'allow', destination: 'session' }] } : {}) } } });
      s.pending.delete(String(requestId));
      return { ok: true };
    }
    write({ type: 'control_response', response: { subtype: 'success', request_id: String(requestId), response: permissionAnswer(req, how, answers) } });
    s.pending.delete(String(requestId));
    return { ok: true };
  }));

  // the CLI is asked to stop its turn; if it does not answer in a few seconds, it gets SIGINT
  ipcMain.handle('agent-console-interrupt', guard(async () => {
    if (!s.child) return { ok: true };
    if (s.interrupt) return { ok: true };
    if (s.agent === 'copilot') {
      interruptCopilot();
      return { ok: true };
    }
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
    dropOverlay();
    if (!s.child) return;
    try {
      s.child.stdin.end();
    } catch {
      // closed already
    }
    shell.killTree(s.child);
  });
}

module.exports = { registerAgentConsole, sessionRules, permissionAnswer, parseCopilotModels, ARGS, MODELS, MODES, COPILOT_MODELS_FALLBACK };
