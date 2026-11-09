// Agent Client Protocol (ACP): the language of `copilot --acp`, JSON-RPC 2.0 lines on stdin and stdout. consola-agente talks
// to Copilot CLI through it, and tells the page what it says in the form the page already reads: the stream-json of Claude
// CLI (assistant and user messages with text, thinking, tool_use and tool_result blocks, result, control_request). Nothing
// here starts a process or touches a file: it only turns what one side says into what the other reads.

// the permission modes the page offers for Copilot: default asks, plan plans, acceptEdits and bypassPermissions are the
// app's (it answers the requests of edits, or all of them, for the user)
const COPILOT_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

// ACP content, in any of its forms, as text
function textOf(content) {
  if (content == null) return '';
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join('\n');
  if (typeof content === 'string') return content;
  if (content.type === 'content') return textOf(content.content);
  if (content.type === 'text') return String(content.text || '');
  if (content.type === 'diff') return `${content.path || ''}\n${String(content.newText || '')}`.trim();
  if (content.type === 'terminal') return '';
  if (content.type === 'resource_link') return String(content.uri || content.name || '');
  if (content.type === 'resource' && content.resource) return String(content.resource.text || content.resource.uri || '');
  return '';
}

const pathOf = (call) => {
  const raw = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {};
  const at = Array.isArray(call.locations) && call.locations[0] && call.locations[0].path;
  return String(at || raw.path || raw.file_path || raw.filePath || raw.fileName || '');
};

// An edit as Copilot says it: a patch in a string ("*** Add File: x", the lines with + and -) ...
function patchOf(text) {
  const t = String(text || '');
  const add = /^\*\*\* Add File: (.+)$/m.exec(t);
  const update = /^\*\*\* Update File: (.+)$/m.exec(t);
  const del = /^\*\*\* Delete File: (.+)$/m.exec(t);
  const file = (add || update || del || [])[1];
  if (!file) return null;
  const lines = t.split('\n');
  return {
    file: file.trim(),
    added: Boolean(add),
    deleted: Boolean(del),
    oldText: lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1)).join('\n'),
    newText: lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n'),
  };
}

// ... or a unified diff
function unifiedOf(text) {
  const t = String(text || '');
  if (!/^@@ /m.test(t)) return null;
  const lines = t.split('\n');
  return {
    created: /^create file mode/m.test(t) || /^--- (a)?\/dev\/null/m.test(t),
    oldText: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1)).join('\n'),
    newText: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n'),
  };
}

// what a tool call ended with, as text: for an edit its own words ("Added 1 file(s): ...") rather than the file again
function resultText(u) {
  const out = u.rawOutput;
  const said = out && typeof out === 'object' && typeof out.content === 'string' ? out.content : typeof out === 'string' ? out : '';
  const hasDiff = Array.isArray(u.content) && u.content.some((c) => c && c.type === 'diff');
  if (hasDiff && said) return said;
  return textOf(u.content) || said || (out ? JSON.stringify(out) : '');
}

// A tool call of ACP as the name and input of the tool that the page knows (Read, Edit, Write, Bash, Grep, WebFetch...)
function toolFromAcp(call) {
  const raw = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {};
  const title = String(call.title || '').trim();
  const kind = String(call.kind || 'other');
  const diff = Array.isArray(call.content) ? call.content.find((c) => c && c.type === 'diff') : null;
  if (kind === 'read') return { name: 'Read', input: { file_path: pathOf(call) || title } };
  if (kind === 'edit') {
    const patch = typeof call.rawInput === 'string' ? patchOf(call.rawInput) : null;
    const unified = raw.diff ? unifiedOf(raw.diff) : null;
    const file = (diff && diff.path) || pathOf(call) || (patch && patch.file) || title;
    if (patch && patch.deleted) return { name: 'Bash', input: { command: `rm ${file}`, description: title } };
    const oldText = diff ? diff.oldText : patch ? patch.oldText : unified ? unified.oldText : '';
    const newText = diff ? diff.newText : patch ? patch.newText : unified ? unified.newText : '';
    const isNew = diff ? !diff.oldText : patch ? patch.added : unified ? unified.created : false;
    if (isNew) return { name: 'Write', input: { file_path: file, content: String(newText || '') } };
    return { name: 'Edit', input: { file_path: file, old_string: String(oldText || ''), new_string: String(newText || '') } };
  }
  if (kind === 'execute') return { name: 'Bash', input: { command: String(raw.command || raw.cmd || title), description: title } };
  if (kind === 'search') return { name: 'Grep', input: { pattern: String(raw.pattern || raw.query || title), path: pathOf(call) } };
  if (kind === 'fetch') return { name: 'WebFetch', input: { url: String(raw.url || title), prompt: title } };
  if (kind === 'delete' || kind === 'move') return { name: 'Bash', input: { command: title, description: title } };
  if (kind === 'switch_mode') return { name: 'ExitPlanMode', input: { plan: textOf(call.content) || title } };
  return { name: (title.split(/\s+/)[0] || 'Tool').slice(0, 40), input: { ...raw, description: title } };
}

// The option of a request for permission that an answer of the page means: allow, always (for the session) or deny. null
// when the agent gave none of that kind (then the request is cancelled).
function pickOption(options, choice) {
  const list = Array.isArray(options) ? options : [];
  const want = choice === 'always' ? ['allow_always', 'allow_once'] : choice === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of want) {
    const found = list.find((o) => o && o.kind === kind && o.optionId);
    if (found) return String(found.optionId);
  }
  return null;
}

// The updates of one session, as the events Claude's form has for them. Text and thoughts come in pieces: they are kept until
// something else comes (a tool, the end of the turn) and said once, as a message.
class Translator {
  constructor(sessionId, { cwd = '', model = '' } = {}) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.model = model;
    this.text = '';
    this.thought = '';
    this.said = '';
    this.tools = new Map();
    this.calls = 0;
    this.plans = 0;
  }

  init(mode = 'default') {
    return { type: 'system', subtype: 'init', session_id: this.sessionId, model: this.model, cwd: this.cwd, permissionMode: mode, tools: [], mcp_servers: [] };
  }

  assistant(blocks) {
    return { type: 'assistant', message: { role: 'assistant', model: this.model, content: blocks }, parent_tool_use_id: null, session_id: this.sessionId };
  }

  toolResult(id, text, isError) {
    return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: Boolean(isError) }] }, parent_tool_use_id: null, session_id: this.sessionId };
  }

  // what is kept of text and thoughts, as one message
  flush() {
    const blocks = [];
    if (this.thought.trim()) blocks.push({ type: 'thinking', thinking: this.thought });
    if (this.text.trim()) {
      blocks.push({ type: 'text', text: this.text });
      this.said = this.text;
    }
    this.thought = '';
    this.text = '';
    return blocks.length ? [this.assistant(blocks)] : [];
  }

  update(u) {
    const out = [];
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        this.text += textOf(u.content);
        break;
      case 'agent_thought_chunk':
        this.thought += textOf(u.content);
        break;
      case 'tool_call': {
        out.push(...this.flush());
        const id = String(u.toolCallId || `call-${this.calls + 1}`);
        if (this.tools.has(id)) break;
        const tool = toolFromAcp(u);
        this.tools.set(id, tool);
        this.calls += 1;
        out.push(this.assistant([{ type: 'tool_use', id, name: tool.name, input: tool.input }]));
        if (u.status === 'completed' || u.status === 'failed') out.push(this.toolResult(id, resultText(u), u.status === 'failed'));
        break;
      }
      case 'tool_call_update': {
        const id = String(u.toolCallId || '');
        if (!id) break;
        if (!this.tools.has(id)) {
          out.push(...this.flush());
          const tool = toolFromAcp(u);
          this.tools.set(id, tool);
          this.calls += 1;
          out.push(this.assistant([{ type: 'tool_use', id, name: tool.name, input: tool.input }]));
        }
        if (u.status === 'completed' || u.status === 'failed') {
          out.push(this.toolResult(id, resultText(u), u.status === 'failed'));
        }
        break;
      }
      case 'plan': {
        out.push(...this.flush());
        const entries = Array.isArray(u.entries) ? u.entries : [];
        const id = `plan-${++this.plans}`;
        const todos = entries.map((e) => ({ content: String(e.content || ''), status: e.status === 'in_progress' || e.status === 'completed' ? e.status : 'pending', activeForm: String(e.content || '') }));
        out.push(this.assistant([{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }]), this.toolResult(id, 'Plano atualizado', false));
        break;
      }
      default:
        // commands available, modes, config, usage: nothing to show
        break;
    }
    return out;
  }

  // The end of a turn: what is kept is said, then the result. stopReason: end_turn, cancelled, refusal, max_tokens...;
  // error: what the agent answered instead (an Error).
  turnEnd({ stopReason = 'end_turn', ms = 0, error = null, usage = null } = {}) {
    const out = this.flush();
    const cancelled = stopReason === 'cancelled';
    const failed = Boolean(error) || stopReason === 'refusal';
    out.push({
      type: 'result',
      subtype: failed ? 'error_during_execution' : 'success',
      is_error: failed && !cancelled,
      result: error ? String(error.message || error) : failed ? 'O agente recusou-se a continuar.' : this.said,
      session_id: this.sessionId,
      duration_ms: ms,
      num_turns: this.calls,
      total_cost_usd: 0,
      // the tokens as Claude's form says them: what was read (new, from the cache, written to it) and what was written
      usage: usage && typeof usage === 'object' ? {
        input_tokens: Math.max(0, (Number(usage.inputTokens) || 0) - (Number(usage.cachedReadTokens) || 0) - (Number(usage.cachedWriteTokens) || 0)),
        cache_read_input_tokens: Number(usage.cachedReadTokens) || 0,
        cache_creation_input_tokens: Number(usage.cachedWriteTokens) || 0,
        output_tokens: Number(usage.outputTokens) || 0,
      } : {},
      terminal_reason: cancelled ? 'aborted_streaming' : stopReason === 'max_tokens' || stopReason === 'max_turn_requests' ? stopReason : 'completed',
      queued_turn_count: 0,
    });
    this.calls = 0;
    return out;
  }

  // A request for permission, as the page asks the user: the tool it is about, and the reason
  permission(requestId, call, options) {
    const tool = toolFromAcp(call);
    const hasAlways = Array.isArray(options) && options.some((o) => o && o.kind === 'allow_always');
    return {
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: tool.name,
        input: tool.input,
        tool_use_id: String(call.toolCallId || ''),
        title: String(call.title || ''),
        permission_suggestions: [],
        suppress_always_allow_rule: !hasAlways,
      },
    };
  }
}

module.exports = { COPILOT_MODES, textOf, toolFromAcp, pickOption, Translator };
