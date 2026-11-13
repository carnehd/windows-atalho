// consola-agente: a conversation with Claude CLI or Copilot CLI (the user chooses) in a project folder (left) and each thing it does as it does it
// (right): the files it reads and writes, its searches, its commands and what they print, its subagents. The lines of
// the CLI come from main (agent-console.js) as it wrote them; this page reads them. The page is in Portuguese, as
// the user named it and its buttons.
const AC_READ = new Set(['Read', 'NotebookRead']);
const AC_SEARCH = new Set(['Glob', 'Grep', 'LS', 'ToolSearch']);
const AC_EDIT = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
const AC_AGENT = new Set(['Agent', 'Task']);
const AC_MAX_OUT = 200000;
// what the CLI says that the timeline need not show; "Todos os eventos" shows each of them too
const AC_QUIET_SYSTEM = new Set(['thinking_tokens', 'commands_changed', 'background_tasks_changed', 'task_updated', 'task_progress', 'status', 'session_state_changed', 'hook_started', 'hook_progress', 'hook_response', 'files_persisted']);
const AC_PICK = '__pick';
// The model (an alias the CLI knows; '' is its own default) and the permission mode, as the page offers them.
const AC_MODELS = [['', 'Predefinido'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const AC_MODES = [
  ['default', 'Perguntar', 'Pede autorização para escrever ficheiros e correr comandos'],
  ['acceptEdits', 'Aceitar alterações', 'Escreve ficheiros do projeto sem perguntar; os comandos continuam a pedir'],
  ['plan', 'Só planear', 'Lê e propõe um plano: não altera nada'],
  ['dontAsk', 'Recusar o que pedir', 'O que pediria autorização é recusado, sem perguntar'],
  ['auto', 'Automático', 'Um classificador decide o que é seguro (não está em todos os planos)'],
  ['bypassPermissions', 'Tudo sem perguntar', 'Sem nenhuma pergunta: o Claude pode alterar e apagar ficheiros e correr comandos'],
];
const AC_SAVED = { model: 'acModel', mode: 'acMode', agent: 'acAgent' };
// the agents the page offers, and the modes of permission that Copilot CLI has (the app answers the requests of edits, or all
// of them, for the user: acp.js)
const AC_AGENTS = [['claude', 'Claude CLI'], ['copilot', 'Copilot CLI']];
const AC_COPILOT_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const acIs = () => acS.agentId === 'copilot';
const acName = () => (acIs() ? 'Copilot' : 'Claude');
const acCli = () => (acIs() ? 'Copilot CLI' : 'Claude CLI');
// a text written for Claude, said for the agent in use
const acWho = (text) => (acIs() ? String(text).replace(/Claude CLI/g, 'Copilot CLI').replace(/\bClaude\b/g, 'Copilot') : String(text));
const acModes = () => (acIs() ? AC_MODES.filter((m) => AC_COPILOT_MODES.includes(m[0])) : AC_MODES);

const acS = {
  agent: null, // { found, name, command, version } of the one in use
  agentId: 'claude', // claude | copilot
  agents: null, // both, as main found them
  events: [], // all of the session, in order, as main sent them
  running: false,
  starting: false,
  cwd: null,
  realCwd: null, // the folder as the CLI says it (on macOS /private/var for /var)
  sessionId: null,
  model: '', // the model the CLI says it uses
  choiceModel: '', // the alias chosen ('': the CLI's own)
  copilotModels: [], // the models Copilot CLI lists (main reads them from its help)
  drawer: '', // what the drawer under the box shows: 'time', 'logs', 'procs', or nothing (closed)
  lastTab: 'logs', // the one it opens on
  procSig: '', // of the list of processes as painted
  stopAsked: new Map(), // run id -> when it was asked to end
  logRuns: [], // the folders <tmp>/arranque-<name>/ main found: { id, name, dir, files, process }
  logBase: '', // the folder they are in
  logRun: '', // the one chosen
  logFile: '', // its file
  logFollow: true, // read the end of the file again every 1.5 seconds
  logBusy: false,
  logFresh: true, // the file was just chosen: the end is shown
  logShown: '', // what is on the screen (for the signature, and to copy)
  logSig: '', // of the last paint: the same file, the same size and time is not painted again
  logListSig: '',
  logTick: 0,
  agentsDir: '', // the folder where the agents are (main keeps it)
  agentList: [], // what is in it: { id, name, description, cli, skills }
  agentsNote: '', // what is wrong with the folder, if anything
  agentsTruncated: false,
  subagent: '', // the id of the agent chosen ('': the CLI's own)
  mode: 'default', // the permission mode in force
  finished: false, // ended with Terminar: it is not taken up again
  placeholder: '',
  version: '',
  busy: false,
  turnAt: 0,
  interrupting: false,
  pending: new Map(), // request_id -> { req, card }
  tools: new Map(), // tool_use_id -> { name, input, line, parent }
  groups: new Map(), // tool_use_id of an Agent call -> { el, body, line }
  cost: 0,
  tokens: 0,
  worked: 0,
  inits: 0,
  last: null,
  trimmed: false,
  picked: [], // folders chosen with the dialog
  chosen: null, // the folder in the select, before a session has one
  shown: false,
  counts: {}, // how many lines of each kind the timeline has (the tags)
  off: new Set(), // the kinds the tags hide (kept on this PC)
  tagsAt: 0, // the frame in which the tags are drawn again
};

// -- Small things --

function acEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function acClock(at) {
  const d = new Date(at || Date.now());
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function acMoney(v) {
  if (acIs()) return ''; // Copilot CLI does not say what a session costs
  const n = Number(v) || 0;
  return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'USD', minimumFractionDigits: n < 1 ? 4 : 2, maximumFractionDigits: n < 1 ? 4 : 2 }).format(n);
}

function acCount(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 1000000) return `${(v / 1000).toLocaleString('pt-PT', { maximumFractionDigits: v < 10000 ? 1 : 0 })} mil`;
  return `${(v / 1000000).toLocaleString('pt-PT', { maximumFractionDigits: 1 })} M`;
}

function acDuration(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (s < 60) return `${s.toLocaleString('pt-PT', { maximumFractionDigits: s < 10 ? 1 : 0 })} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(Math.floor(s % 60)).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function acLines(text) {
  const t = String(text || '').replace(/\n$/, '');
  return t ? t.split('\n').length : 0;
}

// a path as the project has it, when it is inside the project folder (as the app gave it, or as the CLI says it)
function acRel(p) {
  const file = String(p || '');
  for (const root of [acS.realCwd, acS.cwd || acS.chosen]) {
    if (root && (file === root || file.startsWith(`${root}/`) || file.startsWith(`${root}\\`))) return file.slice(root.length + 1) || '.';
  }
  return file;
}

// the text of a tool result: a string, or blocks of text (an image is said, not shown)
function acText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content, null, 2);
  return content.map((b) => (b && b.type === 'text' ? String(b.text || '') : b && b.type === 'image' ? '[imagem]' : JSON.stringify(b))).join('\n');
}

function acCut(text) {
  const t = String(text || '');
  return t.length > AC_MAX_OUT ? `${t.slice(0, AC_MAX_OUT)}\n… (cortado: ${acCount(t.length)} caracteres no total)` : t;
}

// Markdown, a little of it: code blocks, `code`, **bold**, headings, lists and paragraphs. Everything escaped first.
function acMarkdown(text) {
  const parts = String(text || '').split(/```[^\n]*\n?/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return `<pre class="ac-code"><code>${acEsc(part.replace(/\n$/, ''))}</code></pre>`;
    const inline = (s) => acEsc(s)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
    return part.split(/\n{2,}/).filter((p) => p.trim()).map((p) => {
      const lines = p.split('\n');
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
        const ordered = /^\s*\d+\./.test(lines[0]);
        const items = lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`).join('');
        return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
      }
      return lines.map((l) => {
        const h = /^#{1,4}\s+(.*)$/.exec(l);
        return h ? `<strong class="ac-h">${inline(h[1])}</strong>` : inline(l);
      }).join('<br>').replace(/^/, '<p>').replace(/$/, '</p>');
    }).join('');
  }).join('');
}

const acNearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60;

function acAppend(box, el) {
  const scroller = box.closest('.ac-scroll') || box;
  const stick = acNearBottom(scroller);
  box.appendChild(el);
  if (stick) scroller.scrollTop = scroller.scrollHeight;
  return el;
}

function acDetails(summary, body, cls = '') {
  const d = document.createElement('details');
  d.className = `ac-out ${cls}`.trim();
  d.innerHTML = `<summary>${acEsc(summary)}</summary><pre></pre>`;
  d.querySelector('pre').textContent = body;
  return d;
}

// -- The timeline --

// where a line goes: inside the group of its subagent, or at the top level
function acBox(parent) {
  const g = parent && acS.groups.get(parent);
  return g ? g.body : $('#acTimeline');
}

function acLine({ kind, label, what = '', title = '', at, parent = null, mono = false }) {
  const el = document.createElement('div');
  el.className = `ac-ev ac-k-${kind}`;
  el.innerHTML = `<div class="ac-ev-row"><span class="ac-ev-time">${acClock(at)}</span><span class="ac-ev-kind">${acEsc(label)}</span><span class="ac-ev-what${mono ? ' mono' : ''}"></span><span class="ac-ev-status"></span></div>`;
  const w = el.querySelector('.ac-ev-what');
  w.textContent = what;
  if (title) w.title = title;
  acTagCount(kind);
  return acAppend(acBox(parent), el);
}

// -- The tags above the timeline: one per kind of event, with how many there are; a click hides or shows that kind --

const AC_TAGS = [
  ['text', 'Texto', 'O que o Claude escreve e quando pensa'],
  ['bash', 'Comandos', 'Os comandos que o Claude corre'],
  ['read', 'Ler', 'Os ficheiros que lê'],
  ['write', 'Alterações', 'Os ficheiros que escreve ou altera'],
  ['search', 'Pesquisas', 'As pesquisas no código e na web'],
  ['agent', 'Subagentes', 'O trabalho que entrega a subagentes'],
  ['ask', 'Autorizações', 'Os pedidos de autorização e as perguntas'],
  ['state', 'Estado', 'A sessão, o modelo, as permissões e o Claude CLI'],
  ['bad', 'Erros', 'Falhas, recusas, limites e tentativas de novo'],
  ['done', 'Resultado', 'O fim de cada resposta, com a duração e o custo'],
  ['other', 'Outros', 'Tarefas, skills, ferramentas e o que só aparece em "Todos os eventos"'],
];
const AC_TAGS_KEY = 'acTagsOff';

function acTagCount(kind) {
  acS.counts[kind] = (acS.counts[kind] || 0) + 1;
  acTagsSoon();
}

// drawn at most once a frame, however many lines arrive
function acTagsSoon() {
  if (acS.tagsAt) return;
  acS.tagsAt = requestAnimationFrame(() => {
    acS.tagsAt = 0;
    acTagsPaint();
  });
}

function acFilterApply() {
  const box = $('#acTimeline');
  for (const [k] of AC_TAGS) box.classList.toggle(`ac-hide-${k}`, acS.off.has(k));
}

function acFilterSave() {
  try {
    if (acS.off.size) localStorage.setItem(AC_TAGS_KEY, JSON.stringify([...acS.off]));
    else localStorage.removeItem(AC_TAGS_KEY);
  } catch {
    // only for this session
  }
}

function acTagsPaint() {
  const bar = $('#acTags');
  if (!bar) return;
  const focused = bar.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused ? (focused.dataset.kind || (focused.classList.contains('ac-tags-all') ? '*' : '')) : '';
  bar.textContent = '';
  const kinds = AC_TAGS.filter(([k]) => (acS.counts[k] || 0) > 0 || acS.off.has(k));
  bar.classList.toggle('hidden', kinds.length === 0);
  for (const [k, label, hint] of kinds) {
    const off = acS.off.has(k);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ac-tag';
    b.dataset.kind = k;
    b.setAttribute('aria-pressed', String(!off));
    b.title = `${acWho(hint)}. ${off ? 'Clica para mostrar' : 'Clica para esconder'}; Shift+clique mostra só este tipo`;
    b.innerHTML = `<span class="ac-tag-dot" aria-hidden="true"></span>${acEsc(label)}<span class="ac-tag-n">${acS.counts[k] || 0}</span>`;
    bar.appendChild(b);
  }
  if (acS.off.size) {
    const hidden = [...acS.off].reduce((n, k) => n + (acS.counts[k] || 0), 0);
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'ac-tags-all';
    all.textContent = hidden ? `Mostrar tudo · ${hidden} ${hidden === 1 ? 'escondido' : 'escondidos'}` : 'Mostrar tudo';
    bar.appendChild(all);
  }
  if (focusKey) {
    const again = focusKey === '*' ? bar.querySelector('.ac-tags-all') : bar.querySelector(`.ac-tag[data-kind="${focusKey}"]`);
    if (again) again.focus();
  }
}

function acTagsSetup() {
  try {
    const saved = JSON.parse(localStorage.getItem(AC_TAGS_KEY));
    if (Array.isArray(saved)) acS.off = new Set(saved.filter((k) => AC_TAGS.some(([x]) => x === k)));
  } catch {
    // none hidden
  }
  acFilterApply();
  $('#acTags').addEventListener('click', (e) => {
    if (e.target.closest('.ac-tags-all')) {
      acS.off.clear();
    } else {
      const b = e.target.closest('.ac-tag');
      if (!b) return;
      const k = b.dataset.kind;
      if (e.shiftKey || e.altKey) {
        // only this kind; the same again brings them all back
        const onlyThis = AC_TAGS.every(([x]) => x === k || acS.off.has(x)) && !acS.off.has(k);
        acS.off = new Set(onlyThis ? [] : AC_TAGS.map(([x]) => x).filter((x) => x !== k));
      } else if (acS.off.has(k)) {
        acS.off.delete(k);
      } else {
        acS.off.add(k);
      }
    }
    acFilterSave();
    acFilterApply();
    acTagsPaint();
  });
}

function acStatus(line, text, cls = '') {
  if (!line) return;
  const s = line.querySelector('.ac-ev-status');
  s.textContent = text;
  s.className = `ac-ev-status ${cls}`.trim();
}

function acGeneric(label, obj, at, parent = null) {
  const line = acLine({ kind: 'other', label, what: '', at, parent });
  const raw = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  line.appendChild(acDetails('JSON', acCut(raw)));
  return line;
}

function acEventLabel(e) {
  return [e.type, e.subtype].filter(Boolean).join(' · ') || 'evento';
}

function acToolLine(block, e, at) {
  const name = String(block.name || '');
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const parent = e.parent_tool_use_id || null;
  let line;
  if (AC_READ.has(name)) {
    line = acLine({ kind: 'read', label: 'Ler', what: acRel(input.file_path || input.notebook_path || input.path), title: input.file_path || '', at, parent, mono: true });
  } else if (AC_SEARCH.has(name)) {
    const where = input.path && acRel(input.path) !== '.' ? ` em ${acRel(input.path)}` : '';
    const what = name === 'Grep' ? `${input.pattern || ''}${input.glob ? ` (${input.glob})` : ''}${where}` : name === 'ToolSearch' ? String(input.query || '') : `${input.pattern || input.path || ''}${name === 'Glob' ? where : ''}`;
    line = acLine({ kind: 'search', label: 'Pesquisar', what, at, parent, mono: true });
  } else if (name === 'Write') {
    line = acLine({ kind: 'write', label: 'Escrever', what: acRel(input.file_path), title: input.file_path || '', at, parent, mono: true });
    if (typeof input.content === 'string') line.appendChild(acDetails(`Conteúdo · ${acLines(input.content)} linhas`, acCut(input.content)));
  } else if (AC_EDIT.has(name)) {
    line = acLine({ kind: 'write', label: 'Alterar', what: acRel(input.file_path || input.notebook_path), title: input.file_path || '', at, parent, mono: true });
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    const diff = edits.filter((x) => x && (typeof x.old_string === 'string' || typeof x.new_string === 'string')).map((x) => [
      ...String(x.old_string || '').split('\n').map((l) => `- ${l}`),
      ...String(x.new_string || '').split('\n').map((l) => `+ ${l}`),
    ].join('\n')).join('\n…\n');
    if (diff) {
      const d = acDetails('Ver a alteração', '');
      const pre = d.querySelector('pre');
      for (const l of acCut(diff).split('\n')) {
        const row = document.createElement('span');
        row.className = l.startsWith('- ') ? 'ac-del' : l.startsWith('+ ') ? 'ac-add' : '';
        row.textContent = `${l}\n`;
        pre.appendChild(row);
      }
      line.appendChild(d);
    }
  } else if (name === 'Bash' || name === 'PowerShell') {
    line = acLine({ kind: 'bash', label: 'Comando', what: String(input.command || ''), title: String(input.description || ''), at, parent, mono: true });
    acStatus(line, input.run_in_background ? 'em segundo plano' : 'a correr', 'run');
  } else if (AC_AGENT.has(name)) {
    const el = document.createElement('div');
    el.className = 'ac-group';
    acAppend(acBox(parent), el);
    const head = document.createElement('div');
    head.className = 'ac-ev ac-k-agent';
    head.innerHTML = `<div class="ac-ev-row"><span class="ac-ev-time">${acClock(at)}</span><span class="ac-ev-kind">Subagente</span><span class="ac-ev-what"></span><span class="ac-ev-status run">a trabalhar</span></div>`;
    head.querySelector('.ac-ev-what').textContent = `${input.description || 'sem descrição'}${input.subagent_type ? ` (${input.subagent_type})` : ''}`;
    acTagCount('agent');
    if (input.prompt) head.appendChild(acDetails('O pedido ao subagente', acCut(String(input.prompt))));
    el.appendChild(head);
    const body = document.createElement('div');
    body.className = 'ac-group-body';
    el.appendChild(body);
    acS.groups.set(block.id, { el, body, line: head });
    line = head;
  } else if (name === 'WebFetch') {
    line = acLine({ kind: 'search', label: 'Abrir', what: String(input.url || ''), at, parent, mono: true });
  } else if (name === 'WebSearch') {
    line = acLine({ kind: 'search', label: 'Pesquisar na web', what: String(input.query || ''), at, parent });
  } else if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    line = acLine({ kind: 'other', label: 'Tarefas', what: `${input.todos.length} tarefas`, at, parent });
    line.appendChild(acDetails('Ver as tarefas', input.todos.map((t) => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'} ${t.content || t.activeForm || ''}`).join('\n')));
  } else if (name === 'Skill') {
    line = acLine({ kind: 'other', label: 'Skill', what: String(input.skill || input.command || ''), at, parent });
  } else {
    line = acLine({ kind: 'other', label: name.startsWith('mcp__') ? 'Ferramenta MCP' : 'Ferramenta', what: name, at, parent, mono: true });
    line.appendChild(acDetails('O que recebe', acCut(JSON.stringify(input, null, 2))));
  }
  acS.tools.set(block.id, { name, input, line, parent });
}

function acToolResult(block, e, at) {
  const tool = acS.tools.get(block.tool_use_id);
  const text = acText(block.content);
  const error = Boolean(block.is_error);
  if (!tool) {
    acGeneric('Resultado de uma ferramenta', block, at, e.parent_tool_use_id || null);
    return;
  }
  const { name, line } = tool;
  // not run: refused by the user, or stopped by an interrupt
  const meta = (Array.isArray(e.tool_result_meta) ? e.tool_result_meta : []).find((m) => m && m.id === block.tool_use_id);
  if (error && meta && meta.non_execution_kind) {
    const stopped = acS.interrupting || /interrupt/i.test(String(meta.non_execution_kind));
    acStatus(line, stopped ? 'interrompido' : 'recusado', 'bad');
    if (text.trim()) line.appendChild(acDetails(`O que o ${acName()} soube`, acCut(text), 'bad'));
    return;
  }
  if (AC_AGENT.has(name)) {
    const r = e.tool_use_result && typeof e.tool_use_result === 'object' ? e.tool_use_result : {};
    // started in the background: it ends with a task_notification
    if (r.isAsync || r.status === 'async_launched') return;
    acStatus(line, error ? 'falhou' : 'terminou', error ? 'bad' : 'good');
    if (text.trim()) line.appendChild(acDetails(error ? 'O erro' : 'O que respondeu', acCut(text), error ? 'bad' : ''));
    return;
  }
  if (name === 'Bash' || name === 'PowerShell') {
    const r = e.tool_use_result && typeof e.tool_use_result === 'object' ? e.tool_use_result : {};
    const n = acLines(text);
    if (r.backgroundTaskId) acStatus(line, 'em segundo plano', 'run');
    else acStatus(line, error ? (r.interrupted ? 'interrompido' : 'falhou') : 'terminou', error ? 'bad' : 'good');
    line.appendChild(acDetails(`Saída · ${n} ${n === 1 ? 'linha' : 'linhas'}`, acCut(text), error ? 'bad' : ''));
    return;
  }
  if (error) {
    acStatus(line, 'falhou', 'bad');
    line.appendChild(acDetails('O erro', acCut(text), 'bad'));
    return;
  }
  if (AC_READ.has(name)) acStatus(line, `${acLines(text)} linhas`, 'good');
  else acStatus(line, '✓', 'good');
  if (!AC_READ.has(name) && !['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'TodoWrite'].includes(name) && text.trim()) {
    line.appendChild(acDetails('Resultado', acCut(text)));
  }
}

// -- The conversation --

function acChatAdd(el) {
  $('#acChatEmpty').classList.add('hidden');
  return acAppend($('#acChat'), el);
}

function acBubble(role, text, at) {
  const el = document.createElement('div');
  el.className = `ac-msg ac-msg-${role}`;
  el.innerHTML = `<div class="ac-msg-who">${role === 'user' ? 'Tu' : acName()} · ${acClock(at)}</div><div class="ac-msg-text"></div>`;
  const t = el.querySelector('.ac-msg-text');
  if (role === 'user') t.textContent = text;
  else t.innerHTML = acMarkdown(text);
  return acChatAdd(el);
}

function acNote(text, cls = '') {
  const el = document.createElement('div');
  el.className = `ac-note ${cls}`.trim();
  el.textContent = text;
  return acChatAdd(el);
}

function acToolTitle(name) {
  if (name === 'Bash' || name === 'PowerShell') return 'correr um comando';
  if (name === 'Write') return 'escrever um ficheiro';
  if (AC_EDIT.has(name)) return 'alterar um ficheiro';
  if (AC_READ.has(name)) return 'ler um ficheiro';
  if (name === 'WebFetch') return 'abrir uma página';
  if (name === 'WebSearch') return 'pesquisar na web';
  if (name === 'ExitPlanMode') return 'sair do modo de plano';
  return `usar ${name}`;
}

function acCard(id, req, at) {
  const name = String(req.tool_name || '');
  const input = req.input && typeof req.input === 'object' ? req.input : {};
  const el = document.createElement('div');
  el.className = 'ac-card';
  el.dataset.request = id;
  const ask = name === 'AskUserQuestion' && Array.isArray(input.questions);
  el.innerHTML = `<div class="ac-card-title">${ask ? `O ${acName()} pergunta` : `O ${acName()} pede autorização para ${acEsc(acToolTitle(name))}`}<span class="ac-card-time">${acClock(at)}</span></div><div class="ac-card-body"></div><div class="ac-card-actions"></div><div class="ac-card-done hidden"></div>`;
  const body = el.querySelector('.ac-card-body');
  const add = (cls, text) => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    body.appendChild(d);
    return d;
  };
  const actions = el.querySelector('.ac-card-actions');
  const button = (label, choice, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-sm ${cls}`.trim();
    b.textContent = label;
    b.dataset.choice = choice;
    actions.appendChild(b);
    return b;
  };
  if (ask) {
    const picks = {};
    input.questions.slice(0, 4).forEach((q, qi) => {
      const box = document.createElement('div');
      box.className = 'ac-q';
      box.innerHTML = `<div class="ac-q-text"></div><div class="ac-q-opts" role="group"></div><input class="input ac-q-other" type="text" placeholder="Outra resposta" spellcheck="false">`;
      box.querySelector('.ac-q-text').textContent = `${q.header ? `${q.header}: ` : ''}${q.question || ''}`;
      const opts = box.querySelector('.ac-q-opts');
      picks[qi] = new Set();
      (Array.isArray(q.options) ? q.options : []).slice(0, 6).forEach((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm ac-q-opt';
        b.setAttribute('aria-pressed', 'false');
        b.textContent = String(o.label || '');
        if (o.description) b.title = String(o.description);
        b.addEventListener('click', () => {
          const set = picks[qi];
          if (!q.multiSelect) {
            set.clear();
            opts.querySelectorAll('.ac-q-opt').forEach((x) => x.setAttribute('aria-pressed', 'false'));
          }
          if (set.has(o.label)) set.delete(o.label);
          else set.add(o.label);
          b.setAttribute('aria-pressed', String(set.has(o.label)));
        });
        opts.appendChild(b);
      });
      body.appendChild(box);
    });
    el.acAnswers = () => {
      const out = {};
      input.questions.slice(0, 4).forEach((q, qi) => {
        const other = el.querySelectorAll('.ac-q-other')[qi].value.trim();
        const chosen = [...picks[qi]];
        if (other) chosen.push(other);
        if (chosen.length) out[q.question] = q.multiSelect ? chosen : chosen[chosen.length - 1];
      });
      return out;
    };
    button('Responder', 'allow', 'btn-primary');
    button('Recusar', 'deny', 'btn-danger');
  } else {
    if (req.title || req.description) add('ac-card-why', String(req.title || req.description));
    if (name === 'Bash' || name === 'PowerShell') add('ac-card-what mono', String(input.command || ''));
    else if (input.file_path || input.notebook_path) add('ac-card-what mono', acRel(input.file_path || input.notebook_path));
    else if (input.url) add('ac-card-what mono', String(input.url));
    if (name === 'ExitPlanMode' && input.plan) {
      const plan = document.createElement('div');
      plan.className = 'ac-card-plan';
      plan.innerHTML = acMarkdown(String(input.plan));
      body.appendChild(plan);
    } else if (name === 'Write' && typeof input.content === 'string') {
      body.appendChild(acDetails(`O que vai escrever · ${acLines(input.content)} linhas`, acCut(input.content)));
    } else if (AC_EDIT.has(name)) {
      const edits = Array.isArray(input.edits) ? input.edits : [input];
      body.appendChild(acDetails('A alteração', acCut(edits.map((x) => `${String(x.old_string || '').split('\n').map((l) => `- ${l}`).join('\n')}\n${String(x.new_string || '').split('\n').map((l) => `+ ${l}`).join('\n')}`).join('\n…\n'))));
    } else if (!['Bash', 'PowerShell', 'Read', 'WebFetch'].includes(name)) {
      body.appendChild(acDetails('O que vai usar', acCut(JSON.stringify(input, null, 2))));
    }
    if (req.decision_reason) add('ac-card-reason', `Porquê: ${req.decision_reason}`);
    // the path the request is about, when the card does not show it already
    if (req.blocked_path && acRel(req.blocked_path) !== acRel(input.file_path || input.notebook_path || '')) add('ac-card-reason mono', `Mexe em: ${acRel(req.blocked_path)}`);
    button('Permitir', 'allow', 'btn-primary');
    if (!req.suppress_always_allow_rule) button('Permitir sempre nesta sessão', 'always');
    button('Recusar', 'deny', 'btn-danger');
  }
  actions.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-choice]');
    if (b) acAnswer(id, b.dataset.choice, el.acAnswers ? el.acAnswers() : undefined);
  });
  acS.pending.set(id, { req, card: el });
  acChatAdd(el);
  const line = acLine({ kind: 'ask', label: ask ? 'Pergunta' : 'Autorização', what: ask ? String((input.questions[0] || {}).question || '') : `${name}${input.command ? `: ${input.command}` : input.file_path ? `: ${acRel(input.file_path)}` : ''}`, at, parent: null, mono: !ask });
  acStatus(line, 'à espera', 'run');
  el.acLine = line;
  return el;
}

function acCardDone(id, text, cls, at) {
  const p = acS.pending.get(id);
  if (!p) return;
  acS.pending.delete(id);
  const { card } = p;
  card.classList.add('done');
  card.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
  card.querySelector('.ac-card-actions').classList.add('hidden');
  const done = card.querySelector('.ac-card-done');
  done.textContent = `${text} · ${acClock(at)}`;
  done.className = `ac-card-done ${cls}`.trim();
  acStatus(card.acLine, text.toLowerCase(), cls);
}

// -- Reading the events --

function acOut(e, ev) {
  const at = ev.at;
  const quiet = (label = acEventLabel(e)) => { if ($('#acAll').checked) acGeneric(label, e, at, e.parent_tool_use_id || null); };
  if (e.type === 'system') {
    const sub = e.subtype;
    if (sub === 'init') {
      acS.sessionId = e.session_id || acS.sessionId;
      acS.model = e.model || acS.model;
      if (e.cwd) acS.realCwd = String(e.cwd);
      acS.inits += 1;
      if (acS.inits === 1) {
        const line = acLine({ kind: 'state', label: 'Sessão', what: `${e.model || ''} · ${acRel(e.cwd || '') === '.' ? 'na pasta do projeto' : e.cwd || ''}`, at });
        line.appendChild(acDetails('Ferramentas, servidores MCP e o resto', acCut(JSON.stringify({ session_id: e.session_id, model: e.model, permissionMode: e.permissionMode, tools: e.tools, mcp_servers: e.mcp_servers, claude_code_version: e.claude_code_version }, null, 2))));
      } else quiet();
      return;
    }
    if (sub === 'session_state_changed') {
      // what the CLI says of itself: working, waiting for nothing, or for an answer
      if (e.state === 'running') {
        acS.busy = true;
        acS.turnAt = acS.turnAt || at;
      } else if (e.state === 'idle') {
        acS.busy = false;
        acS.turnAt = 0;
        acS.interrupting = false;
      }
      return quiet();
    }
    if (sub === 'task_started' && e.task_type === 'local_agent' && e.tool_use_id && !acS.groups.has(e.tool_use_id)) {
      acToolLine({ id: e.tool_use_id, name: 'Agent', input: { description: e.description, subagent_type: e.subagent_type, prompt: e.prompt } }, { parent_tool_use_id: null }, at);
      return;
    }
    if (sub === 'task_started') return quiet();
    if (sub === 'task_progress' && e.tool_use_id && acS.groups.has(e.tool_use_id)) {
      const g = acS.groups.get(e.tool_use_id);
      const n = e.usage && e.usage.tool_uses;
      acStatus(g.line, `a trabalhar${n ? ` · ${n} ${n === 1 ? 'ação' : 'ações'}` : ''}`, 'run');
      return quiet();
    }
    if (sub === 'task_notification') {
      const status = String(e.status || '');
      const how = status === 'completed' ? ['terminou', 'good'] : status === 'stopped' ? ['parado', 'bad'] : status === 'failed' ? ['falhou', 'bad'] : [status || 'terminou', ''];
      const g = e.tool_use_id && acS.groups.get(e.tool_use_id);
      const tool = e.tool_use_id && acS.tools.get(e.tool_use_id);
      if (g) {
        acStatus(g.line, how[0], how[1]);
        // its answer once: from the result of its call, or else from this notification
        const said = [...g.line.querySelectorAll(':scope > details > summary')].some((s) => s.textContent === 'O que respondeu');
        if (e.summary && !said) g.line.appendChild(acDetails('O que respondeu', acCut(String(e.summary))));
      } else if (tool && (tool.name === 'Bash' || tool.name === 'PowerShell')) {
        // the line of the command says it; only a command left in the background is told here
        if (tool.input && tool.input.run_in_background) acStatus(tool.line, how[0], how[1]);
        quiet();
      } else acLine({ kind: 'other', label: 'Tarefa', what: `${e.summary || e.task_id || ''} · ${how[0]}`, at });
      return;
    }
    if (sub === 'api_retry') {
      acLine({ kind: 'bad', label: 'A tentar de novo', what: `tentativa ${e.attempt || '?'} de ${e.max_retries || '?'}${e.error ? ` · ${e.error}` : ''}${e.error_status ? ` (${e.error_status})` : ''}`, at });
      return;
    }
    if (sub === 'compact_boundary') {
      acLine({ kind: 'state', label: 'Resumo', what: 'a conversa foi resumida para caber no contexto', at });
      return;
    }
    if (sub === 'permission_denied') {
      acLine({ kind: 'bad', label: 'Recusado', what: `${e.tool_name || ''} ${e.message || ''}`.trim(), at });
      return;
    }
    if (AC_QUIET_SYSTEM.has(sub)) return quiet();
    acGeneric(acEventLabel(e), e, at, e.parent_tool_use_id || null);
    return;
  }
  if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
    const parent = e.parent_tool_use_id || null;
    if (!parent) {
      acS.busy = true;
      acS.turnAt = acS.turnAt || at;
    }
    for (const block of e.message.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        if (!String(block.text || '').trim()) continue;
        if (parent) {
          const line = acLine({ kind: 'text', label: 'Texto', what: String(block.text).split('\n')[0].slice(0, 200), at, parent });
          if (String(block.text).includes('\n')) line.appendChild(acDetails('Tudo', acCut(block.text)));
        } else acBubble('assistant', block.text, at);
      } else if (block.type === 'thinking') {
        if (String(block.thinking || '').trim()) {
          const line = acLine({ kind: 'text', label: 'A pensar', what: '', at, parent });
          line.appendChild(acDetails('O que pensou', acCut(block.thinking)));
        } else quiet('assistant · thinking');
      } else if (block.type === 'tool_use') {
        acToolLine(block, e, at);
      } else if (block.type === 'redacted_thinking') {
        quiet('assistant · redacted_thinking');
      } else acGeneric(`assistant · ${block.type}`, block, at, parent);
    }
    return;
  }
  if (e.type === 'user' && e.message) {
    const content = e.message.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result') acToolResult(block, e, ev.at);
      else if (block.type === 'text') {
        const text = String(block.text || '');
        if (/^\[Request interrupted/.test(text)) acNote('Interrompido.', 'warn');
        else if (e.parent_tool_use_id && acS.groups.has(e.parent_tool_use_id)) quiet('user · o pedido ao subagente');
        else quiet('user · text');
      } else acGeneric(`user · ${block.type}`, block, ev.at, e.parent_tool_use_id || null);
    }
    return;
  }
  if (e.type === 'result') {
    acS.busy = Number(e.queued_turn_count) > 0;
    const before = acS.cost;
    acS.cost = Number(e.total_cost_usd) || acS.cost;
    const u = e.usage && typeof e.usage === 'object' ? e.usage : {};
    const read = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
    const wrote = Number(u.output_tokens) || 0;
    acS.tokens += read + wrote;
    acS.worked += Number(e.duration_ms) || 0;
    acS.turnAt = acS.busy ? at : 0;
    acS.last = { ms: Number(e.duration_ms) || 0, turns: Number(e.num_turns) || 0, read, wrote, cost: Math.max(0, acS.cost - before), models: Object.keys(e.modelUsage || {}), at };
    const stopped = e.terminal_reason === 'aborted_tools' || e.terminal_reason === 'aborted_streaming' || /interrupt/i.test(String(e.terminal_reason || ''));
    if (stopped) acS.interrupting = false;
    const said = String(e.result || '');
    if (e.is_error && !stopped) {
      const login = /not logged in|\/login|copilot login|sign in|unauthori|authenticat/i.test(said);
      acNote(login ? `O ${acCli()} não tem sessão iniciada neste computador. Abre um terminal, ${acIs() ? `corre "${(acS.agent && acS.agent.command) || 'copilot'} login"` : `corre "${(acS.agent && acS.agent.command) || 'claude'}", escreve /login`} e segue os passos.` : `O pedido falhou: ${said || (Array.isArray(e.errors) ? e.errors.join(' ') : e.subtype || 'erro')}`.slice(0, 1200), 'bad');
    }
    const line = acLine({ kind: e.is_error && !stopped ? 'bad' : 'done', label: stopped ? 'Interrompido' : e.is_error ? 'Falhou' : 'Concluído', what: [acDuration(e.duration_ms), `${e.num_turns || 0} ${e.num_turns === 1 ? 'volta' : 'voltas'}`, acMoney(acS.last.cost)].filter(Boolean).join(' · '), at });
    line.appendChild(acDetails('O resultado', acCut(JSON.stringify({ ...e, result: said.length > 4000 ? `${said.slice(0, 4000)}…` : said }, null, 2))));
    return;
  }
  if (e.type === 'control_request' && e.request && e.request.subtype === 'can_use_tool') {
    acCard(String(e.request_id), e.request, at);
    return;
  }
  if (e.type === 'control_cancel_request') {
    acCardDone(String(e.request_id), 'Cancelado', 'bad', at);
    return;
  }
  if (e.type === 'control_response') return quiet();
  if (e.type === 'stream_event') return quiet();
  if (e.type === 'rate_limit_event') {
    const info = e.rate_limit_info || {};
    if (info.status && info.status !== 'allowed') {
      const back = info.resetsAt ? ` · volta às ${acClock(Number(info.resetsAt) * 1000).slice(0, 5)}` : '';
      acLine({ kind: 'bad', label: 'Limite', what: `${info.status}${info.rateLimitType ? ` (${info.rateLimitType})` : ''}${back}`, at });
    } else quiet();
    return;
  }
  acGeneric(acEventLabel(e), e, at, e.parent_tool_use_id || null);
}

// what the app wrote to the CLI: the user's messages, the answers, the requests to stop
function acIn(e, ev) {
  if (e.type === 'user' && e.message) {
    acBubble('user', String(e.message.content || ''), ev.at);
    acS.busy = true;
    acS.turnAt = acS.turnAt || ev.at;
    return;
  }
  if (e.type === 'control_response' && e.response) {
    const id = String(e.response.request_id || '');
    const r = e.response.response || {};
    const req = acS.pending.get(id);
    if (!req) return;
    const ask = req.req.tool_name === 'AskUserQuestion';
    if (r.behavior === 'allow') acCardDone(id, ask ? 'Respondido' : r.updatedPermissions ? 'Permitido sempre nesta sessão' : 'Permitido', 'good', ev.at);
    else acCardDone(id, 'Recusado', 'bad', ev.at);
    return;
  }
  if (e.type === 'control_request' && e.request && e.request.subtype === 'interrupt') {
    acS.interrupting = true;
    acLine({ kind: 'state', label: 'Interromper', what: `pedido ao ${acName()} para parar`, at: ev.at });
  }
}

function acApply(ev) {
  if (ev.kind === 'out' || ev.kind === 'in') {
    let e = null;
    try {
      e = JSON.parse(ev.line);
    } catch {
      // a line that is not JSON
    }
    if (!e || typeof e !== 'object') {
      if (ev.kind === 'out') acGeneric('Texto do CLI', ev.line, ev.at);
      return;
    }
    if (ev.kind === 'out') acOut(e, ev);
    else acIn(e, ev);
    return;
  }
  if (ev.kind === 'err') {
    const line = acLine({ kind: 'bad', label: 'stderr', what: String(ev.text || '').trim().split('\n')[0].slice(0, 200), at: ev.at });
    if (String(ev.text || '').trim().includes('\n')) line.appendChild(acDetails('Tudo', acCut(ev.text)));
    return;
  }
  if (ev.kind === 'state') {
    acS.cwd = ev.cwd || acS.cwd;
    acS.sessionId = ev.sessionId || acS.sessionId;
    if (typeof ev.model === 'string') acS.choiceModel = ev.model;
    if (typeof ev.subagent === 'string') acS.subagent = ev.subagent;
    if (ev.liveModel) acS.model = ev.liveModel;
    if (typeof ev.mode === 'string' && ev.mode) acS.mode = ev.mode;
    if (typeof ev.finished === 'boolean') acS.finished = ev.finished;
    if (ev.state === 'applied') {
      const what = ev.what === 'model' ? (ev.value || 'predefinido') : (AC_MODES.find((m) => m[0] === ev.value) || [ev.value, ev.value])[1];
      acLine({ kind: 'state', label: ev.what === 'model' ? 'Modelo' : 'Permissões', what, at: ev.at });
    } else if (ev.state === 'refused') {
      acLine({ kind: 'bad', label: ev.what === 'model' ? 'Modelo' : 'Permissões', what: `recusado: ${ev.error || ''}`, at: ev.at });
    } else if (ev.state === 'finished') {
      acS.running = false;
      acS.busy = false;
      acS.turnAt = 0;
      acS.interrupting = false;
      for (const id of [...acS.pending.keys()]) acCardDone(id, 'Cancelado (a conversa terminou)', 'bad', ev.at);
      acLine({ kind: 'state', label: 'Conversa', what: 'terminada por ti', at: ev.at });
      acNote('Conversa terminada. O que foi dito fica aqui para ler; Nova sessão começa outra.', 'warn');
    } else if (ev.state === 'started') {
      acS.running = true;
      acS.starting = false;
      acS.version = ev.version || acS.version;
      if (ev.resumed) acLine({ kind: 'state', label: acCli(), what: 'arrancou de novo e retomou a sessão', at: ev.at });
      if (ev.subagent) {
        const a = acS.agentList.find((x) => x.id === ev.subagent);
        acLine({ kind: 'state', label: 'Agente', what: a ? a.name : ev.subagent, at: ev.at });
      }
    } else if (ev.state === 'agent-warning') {
      for (const w of ev.warnings || []) acLine({ kind: 'bad', label: 'Agente', what: String(w).slice(0, 200), at: ev.at });
    } else if (ev.state === 'ended') {
      acS.running = false;
      acS.busy = false;
      acS.turnAt = 0;
      acS.interrupting = false;
      for (const id of [...acS.pending.keys()]) acCardDone(id, `Cancelado (o ${acCli()} terminou)`, 'bad', ev.at);
      const how = ev.error || `${ev.signal ? `sinal ${ev.signal}` : `código ${ev.code}`}${ev.stderr ? ` · ${ev.stderr}` : ''}`;
      acLine({ kind: ev.code === 0 ? 'state' : 'bad', label: acCli(), what: `terminou (${how})`, at: ev.at });
      if (ev.code !== 0) acNote(`O ${acCli()} terminou: ${how}. O próximo pedido arranca-o de novo e retoma a sessão.`, 'bad');
    } else if (ev.state === 'restart') {
      // Copilot CLI takes its model as it starts: it was stopped, and the next request starts it again on the same session
      acS.running = false;
      acS.busy = false;
      acS.turnAt = 0;
      acSave('model', ev.value || '');
      acLine({ kind: 'state', label: 'Modelo', what: `${ev.value || 'predefinido'} · o próximo pedido retoma a sessão com ele`, at: ev.at });
    } else if (ev.state === 'sigint') {
      acLine({ kind: 'bad', label: 'Interromper', what: `sem resposta: enviado SIGINT ao ${acCli()}`, at: ev.at });
    }
  }
}

function acReset() {
  acS.events = [];
  acS.finished = false;
  acS.running = false;
  acS.starting = false;
  acS.cwd = null;
  acS.realCwd = null;
  acS.sessionId = null;
  acS.model = '';
  acS.busy = false;
  acS.turnAt = 0;
  acS.interrupting = false;
  acS.pending.clear();
  acS.tools.clear();
  acS.groups.clear();
  acS.cost = 0;
  acS.tokens = 0;
  acS.worked = 0;
  acS.inits = 0;
  acS.last = null;
  acS.trimmed = false;
  acS.counts = {};
  acTagsSoon();
  $('#acTimeline').innerHTML = '';
  $('#acChat').querySelectorAll('.ac-msg, .ac-note, .ac-card').forEach((x) => x.remove());
  $('#acChatEmpty').classList.remove('hidden');
}

// the page drawn again from all the events (when it opens, or "Todos os eventos" changes)
function acRebuild(events, extra = {}) {
  const keep = { running: extra.running ?? acS.running, cwd: extra.cwd ?? acS.cwd, sessionId: extra.sessionId ?? acS.sessionId, trimmed: extra.trimmed ?? acS.trimmed };
  acReset();
  Object.assign(acS, keep);
  if (acS.trimmed) acNote('Os eventos mais antigos desta sessão já não estão guardados.', 'warn');
  for (const ev of events) {
    acS.events.push(ev);
    acApply(ev);
  }
  if (extra.pending) {
    // a request the CLI no longer waits for is not answered here
    for (const id of [...acS.pending.keys()]) if (!extra.pending.includes(id)) acCardDone(id, 'Já não está à espera', 'bad', Date.now());
  }
  acPaint();
}

// -- The bar at the top and the foot --

function acProjectName(p) {
  const r = (typeof repos !== 'undefined' ? repos : []).find((x) => x.path === p);
  if (r) return displayName(r);
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
}

function acFillProjects() {
  const sel = $('#acProject');
  const list = (typeof repos !== 'undefined' ? repos : []).map((r) => r.path);
  const all = [...new Set([...(acS.cwd ? [acS.cwd] : []), ...list, ...acS.picked])];
  if (!acS.chosen || !all.includes(acS.chosen)) acS.chosen = acS.cwd || (all.includes(currentRepo) ? currentRepo : all[0]) || null;
  sel.innerHTML = '';
  for (const p of all) {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = acProjectName(p);
    o.title = p;
    sel.appendChild(o);
  }
  const pick = document.createElement('option');
  pick.value = AC_PICK;
  pick.textContent = 'Outra pasta…';
  sel.appendChild(pick);
  sel.value = acS.cwd || acS.chosen || AC_PICK;
}

// The agent: chosen before a session starts (a session belongs to its agent); Nova sessão lets it change. The texts of the page
// that name it say the one in use.
function acFillAgents() {
  const sel = $('#acAgent');
  if (!sel) return;
  sel.innerHTML = '';
  for (const [id, label] of AC_AGENTS) {
    const info = acS.agents && acS.agents[id];
    sel.appendChild(Object.assign(document.createElement('option'), { value: id, textContent: info && !info.found ? `${label} (não encontrado)` : label }));
  }
  sel.value = acS.agentId;
}

function acPaintAgent() {
  const sel = $('#acAgent');
  if (!sel) return;
  if (sel.value !== acS.agentId) sel.value = acS.agentId;
  const locked = Boolean(acS.cwd) && !acS.finished;
  sel.disabled = locked;
  sel.title = locked ? `Esta sessão é do ${acCli()}: Nova sessão para mudar de agente` : 'Com que agente falas: o Claude CLI ou o Copilot CLI, o que tens neste computador';
  $('#acInput').setAttribute('aria-label', `Mensagem para o ${acName()}`);
  $('#acInterrupt').title = `Pede ao ${acName()} para parar o que está a fazer`;
  $('#acEnd').title = `Termina a conversa e o ${acCli()}. O que foi dito fica aqui para ler, e nada a retoma`;
  const intro = $('#acEmptyIntro');
  if (intro) intro.textContent = `Escreve em baixo o que queres que o ${acName()} faça na pasta do projeto. Cada ação que precisa da tua autorização aparece aqui como um cartão.`;
  const note = $('#acEmptyNote');
  if (note) note.textContent = `O ${acCli()} corre neste computador, na pasta do projeto, e envia ${acIs() ? 'ao GitHub' : 'à Anthropic'} o que lê e o que escreves, como num terminal.`;
  const none = $('#acNoAgentText');
  if (none) none.innerHTML = `O ${acCli()} não foi encontrado neste computador. Instala-o e entra uma vez com <code>${acIs() ? 'copilot login' : 'claude'}</code> num terminal.`;
}

async function acChooseAgent(value) {
  const was = acS.agentId;
  const wasModel = acS.choiceModel;
  const wasSub = acS.subagent;
  acS.agentId = value;
  acS.choiceModel = ''; // the model of one agent is no model of the other
  acS.subagent = '';
  acFillChoices();
  acFillSubagent();
  acPaint();
  const r = await window.agentConsole.setChoice('agent', value);
  if (r && r.error) {
    acS.agentId = was;
    acS.choiceModel = wasModel;
    acS.subagent = wasSub;
    acFillChoices();
    acFillSubagent();
    acPaint();
    toast(r.error, 'error');
    return;
  }
  acSave('agent', value);
  await acLoadModels();
  await acRefreshInfo();
  // the agent that this CLI had last time
  const saved = acSaved('subagent');
  if (saved && acAgentsFit().some((a) => a.id === saved)) await acChooseSubagent(saved);
}

function acStateText() {
  if (acS.agent && !acS.agent.found) return [`${acCli()} não encontrado`, 'bad'];
  if (acS.finished) return ['Conversa terminada', ''];
  if (acS.pending.size) return ['À espera da tua resposta', 'ask'];
  if (acS.interrupting) return ['A interromper…', 'run'];
  if (acS.starting && !acS.running) return ['A arrancar…', 'run'];
  if (acS.busy && acS.running) return [`A trabalhar · ${acDuration(Date.now() - (acS.turnAt || Date.now()))}`, 'run'];
  if (acS.running) return ['Pronto', 'good'];
  if (acS.sessionId) return ['Em pausa · o próximo pedido retoma a sessão', ''];
  return ['Sem sessão', ''];
}

function acPaint() {
  if (!$('#agentView')) return;
  const [text, cls] = acStateText();
  $('#acStateText').textContent = text;
  $('#acState').className = `ac-state ${cls}`.trim();
  const live = acS.busy && acS.running && acS.turnAt ? Date.now() - acS.turnAt : 0;
  // the cost and the tokens once an answer has said them; the time worked from the first message
  const meta = acS.last ? [acMoney(acS.cost), `${acCount(acS.tokens)} tokens`, `${acDuration(acS.worked + live)} de trabalho`].filter(Boolean) : live ? [`${acDuration(live)} de trabalho`] : [];
  $('#acMeta').textContent = meta.join(' · ');
  $('#acMeta').title = `O custo é o que o ${acCli()} estima para esta sessão; os tokens somam os lidos e os escritos em cada resposta`;
  acPaintAgent();
  const sel = $('#acProject');
  sel.disabled = Boolean(acS.cwd);
  sel.title = acS.cwd ? `${acS.cwd}\nEsta sessão é deste projeto: Nova sessão para mudar` : `A pasta onde o ${acName()} trabalha`;
  $('#acInterrupt').disabled = acS.finished || !(acS.running && (acS.busy || acS.pending.size)) || acS.interrupting;
  $('#acEnd').disabled = acS.finished || !(acS.cwd || acS.sessionId || acS.events.length);
  $('#acNew').disabled = !(acS.cwd || acS.events.length);
  const found = !acS.agent || acS.agent.found;
  $('#acInput').disabled = acS.finished;
  $('#acInput').placeholder = acS.finished ? 'A conversa terminou. Nova sessão começa outra.' : `Escreve ao ${acName()}… (Enter envia, Shift+Enter muda de linha)`;
  $('#acSend').disabled = acS.finished || !found || !$('#acInput').value.trim();
  acSyncChoices();
  $('#acNoAgent').classList.toggle('hidden', found);
  const l = acS.last;
  $('#acFoot').textContent = l ? [
    `Última resposta: ${acDuration(l.ms)}`,
    `${l.turns} ${l.turns === 1 ? 'volta' : 'voltas'}`,
    `${acCount(l.wrote)} tokens escritos, ${acCount(l.read)} lidos`,
    ...(acMoney(l.cost) ? [acMoney(l.cost)] : []),
    ...(l.models.length ? [l.models.join(', ')] : acS.model ? [acS.model] : []),
    ...(acS.sessionId ? [`sessão ${acS.sessionId.slice(0, 8)}`] : []),
  ].join(' · ') : acS.sessionId ? `Sessão ${acS.sessionId.slice(0, 8)}${acS.model ? ` · ${acS.model}` : ''}` : '';
  if (typeof updateCrumb === 'function' && typeof currentMode !== 'undefined' && currentMode === 'agent') updateCrumb();
}

function acCrumb() {
  const p = acS.cwd || acS.chosen;
  return p ? acProjectName(p) : '';
}

// -- The model and the permissions: two choices over the box to write in, kept on this computer and sent to the CLI at
// once (main asks it with set_model and set_permission_mode). The CLI changes the mode itself too (a plan accepted
// goes to acceptEdits): the box follows what it says. --
// what was chosen is kept for each agent: a model of one is no model of the other
const acKey = (kind) => (kind === 'subagent' ? (acIs() ? 'acSubagentCopilot' : 'acSubagentClaude') : kind === 'model' && acIs() ? 'acModelCopilot' : AC_SAVED[kind]);

function acSaved(kind) {
  try {
    return localStorage.getItem(acKey(kind)) || '';
  } catch {
    return '';
  }
}

function acSave(kind, value) {
  try {
    localStorage.setItem(acKey(kind), value);
  } catch {
    // for this session only
  }
}

// What the model box offers: Claude's aliases, or Copilot's own (Predefinido, Auto, and the ones its help lists, by maker).
const AC_COPILOT_TOP = [['', 'Predefinido'], ['auto', 'Auto (o Copilot escolhe)']];
const AC_MAKERS = [[/^claude/, 'Claude'], [/^gpt|^mai-/, 'GPT'], [/^gemini/, 'Gemini'], [/^grok/, 'Grok']];
const acOption = (value, label) => Object.assign(document.createElement('option'), { value, textContent: label });
const acModelValid = (v) => (acIs() ? AC_COPILOT_TOP.some((m) => m[0] === v) || acS.copilotModels.includes(v) : AC_MODELS.some((m) => m[0] === v));

function acFillModels() {
  const model = $('#acModel');
  model.innerHTML = '';
  if (!acIs()) {
    for (const [value, label] of AC_MODELS) model.appendChild(acOption(value, label));
    return;
  }
  for (const [value, label] of AC_COPILOT_TOP) model.appendChild(acOption(value, label));
  const groups = new Map();
  for (const id of acS.copilotModels) {
    const maker = (AC_MAKERS.find(([rx]) => rx.test(id)) || [null, 'Outros'])[1];
    if (!groups.has(maker)) groups.set(maker, []);
    groups.get(maker).push(id);
  }
  for (const [maker, ids] of groups) {
    const group = Object.assign(document.createElement('optgroup'), { label: maker });
    for (const id of ids) group.appendChild(acOption(id, id));
    model.appendChild(group);
  }
}

// The models Copilot CLI has, asked of main (it reads its help once for each version); the box is filled again with them.
async function acLoadModels() {
  if (!acIs()) return;
  const r = await window.agentConsole.models().catch(() => null);
  if (!r || r.error || !Array.isArray(r.models)) return;
  acS.copilotModels = r.models;
  acFillModels();
  acSyncChoices();
}

function acFillChoices() {
  acFillModels();
  const mode = $('#acMode');
  mode.innerHTML = '';
  for (const [value, label, hint] of acModes()) mode.appendChild(Object.assign(document.createElement('option'), { value, textContent: label, title: acWho(hint) }));
}

function acSyncChoices() {
  const model = $('#acModel');
  const mode = $('#acMode');
  if (!model || !mode) return;
  if (model.value !== acS.choiceModel) model.value = acS.choiceModel;
  if (mode.value !== acS.mode) mode.value = acS.mode;
  const current = acModes().find((m) => m[0] === acS.mode) || acModes()[0];
  // a model that is not in the box yet (the list has not come) is shown all the same
  if (acIs() && acS.choiceModel && ![...model.options].some((o) => o.value === acS.choiceModel)) model.appendChild(acOption(acS.choiceModel, acS.choiceModel));
  model.value = acS.choiceModel;
  $('#acModeHint').textContent = acWho(current[2]);
  mode.classList.toggle('danger', acS.mode === 'bypassPermissions');
  model.title = acIs()
    ? `O modelo do Copilot CLI (--model). Predefinido é o que ele usa sem lhe dizerem nada; mudar com a sessão a decorrer pára-o e o próximo pedido retoma-a com o modelo novo${acS.choiceModel ? `\nPedido: ${acS.choiceModel}` : ''}`
    : acS.model ? `Modelo em uso: ${acS.model}` : `O modelo do ${acCli()}. Predefinido é o que ele usa sem lhe dizerem nada`;
  mode.title = acWho(current[2]);
  acSyncAgents();
}

// -- The agent: the folder where the agents are, the agents in it (for this CLI), and a button that reads the folder again. The
// session starts as the one chosen; it cannot change once the session has started. --
const acAgentName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const acAgentsFit = () => acS.agentList.filter((a) => a.cli === 'both' || a.cli === acS.agentId);

function acFillSubagent() {
  const sel = $('#acSubagent');
  if (!sel) return;
  sel.replaceChildren(acOption('', 'Nenhum (o do CLI)'));
  const fit = acAgentsFit();
  const count = new Map();
  for (const a of fit) count.set(a.name, (count.get(a.name) || 0) + 1);
  for (const a of fit) {
    // two with one name: told apart by where they are
    const where = a.id.split('/').slice(0, -1).filter((x) => !/^(agents|claude|copilot|\.claude|\.github)$/.test(x)).join('/');
    const o = acOption(a.id, count.get(a.name) > 1 && where ? `${a.name} · ${where}` : a.name);
    o.title = a.description;
    sel.appendChild(o);
  }
  sel.value = fit.some((a) => a.id === acS.subagent) ? acS.subagent : '';
}

function acSyncAgents() {
  const folder = $('#acAgentsFolder');
  if (!folder) return;
  const sel = $('#acSubagent');
  const fit = acAgentsFit();
  if (acS.subagent && !fit.some((a) => a.id === acS.subagent) && acS.agentList.length) acS.subagent = '';
  folder.textContent = acS.agentsDir ? acAgentName(acS.agentsDir) : 'Escolher a pasta...';
  folder.title = acS.agentsDir ? `${acS.agentsDir}\nA pasta onde estão os agentes: carrega para escolher outra` : 'A pasta onde estão os agentes';
  sel.disabled = !acS.agentsDir || !fit.length || Boolean(acS.cwd && !acS.finished);
  if (sel.value !== acS.subagent) sel.value = fit.some((a) => a.id === acS.subagent) ? acS.subagent : '';
  sel.title = acS.cwd && !acS.finished ? 'Esta sessão já começou como este agente: Nova sessão para mudar' : 'O agente com que a sessão arranca';
  $('#acAgentsReload').disabled = !acS.agentsDir;
  const chosen = fit.find((a) => a.id === acS.subagent);
  let hint = '';
  if (!acS.agentsDir) hint = 'Escolhe primeiro a pasta onde estão os agentes: uma pasta de agentes, ou uma pasta com vários pacotes.';
  else if (acS.agentsNote) hint = acS.agentsNote;
  else if (!fit.length) hint = `Nenhum agente do ${acCli()} nesta pasta${acS.agentList.length ? ` (há ${acS.agentList.length} de outro CLI)` : ''}.`;
  else if (chosen) hint = chosen.description;
  else hint = `${fit.length} agente${fit.length === 1 ? '' : 's'} para o ${acCli()}${acS.agentsTruncated ? ' (a pasta tem mais do que li)' : ''}`;
  const h = $('#acAgentsHint');
  h.textContent = hint;
  h.title = hint;
}

// What the folder has, read now (asked of main each time: that is what Reload does).
async function acLoadAgents() {
  const r = await window.agentConsole.agents().catch((e) => ({ error: e.message }));
  if (!r || (r.error && !Array.isArray(r.agents))) return null;
  acS.agentsDir = r.dir || '';
  acS.agentList = r.agents || [];
  acS.agentsNote = r.error || '';
  acS.agentsTruncated = Boolean(r.truncated);
  acFillSubagent();
  acSyncAgents();
  return r;
}

async function acPickAgentsFolder() {
  const r = await window.agentConsole.pickAgentsFolder().catch((e) => ({ error: e.message }));
  if (!r || r.canceled) return;
  if (r.error && !Array.isArray(r.agents)) {
    toast(r.error, 'error');
    return;
  }
  acS.agentsDir = r.dir || '';
  acS.agentList = r.agents || [];
  acS.agentsNote = r.error || '';
  acS.agentsTruncated = Boolean(r.truncated);
  acS.subagent = '';
  acFillSubagent();
  acSyncAgents();
  // the one of last time in this folder, if it is there
  const saved = acSaved('subagent');
  if (saved && acAgentsFit().some((a) => a.id === saved)) await acChooseSubagent(saved);
  const n = acAgentsFit().length;
  toast(n ? `${n} agente${n === 1 ? '' : 's'} na pasta` : 'Nenhum agente deste CLI nesta pasta', n ? 'success' : 'info', { plain: true });
}

async function acReloadAgents() {
  const btn = $('#acAgentsReload');
  btn.classList.add('busy');
  const r = await acLoadAgents();
  btn.classList.remove('busy');
  if (!r) {
    toast('Não consegui ler a pasta', 'error');
    return;
  }
  const n = acAgentsFit().length;
  toast(r.error ? r.error : `${n} agente${n === 1 ? '' : 's'} na pasta`, r.error ? 'error' : 'success', { plain: true });
}

async function acChooseSubagent(value) {
  const was = acS.subagent;
  acS.subagent = value;
  acSyncAgents();
  const r = await window.agentConsole.setChoice('subagent', value);
  if (r && r.error) {
    acS.subagent = was;
    acFillSubagent();
    acSyncAgents();
    toast(r.error, 'error');
    if (/recarrega a lista/.test(r.error)) acLoadAgents();
    return;
  }
  acSave('subagent', value);
}

// -- The logs the arrancador agent leaves, <tmp>/arranque-<microservice>/: the microservice, then its file. The end of the file is
// shown above and followed while "Seguir" is on. Main reads only there. --
const AC_LOG_LINES = 3000;
const AC_PROC_WORDS = { running: 'a correr', stopped: 'parado', other: 'é agora de outro processo', unknown: 'sem estado conhecido' };
const acLogAgo = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return 'agora';
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  return s < 86400 ? `há ${Math.round(s / 3600)} h` : `há ${Math.round(s / 86400)} d`;
};
const acLogSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const acLogRunNow = () => acS.logRuns.find((r) => r.id === acS.logRun) || null;

function acFillLogRuns() {
  const sel = $('#acLogRun');
  sel.replaceChildren(acOption('', acS.logRuns.length ? 'Escolher o microserviço...' : 'Nenhum log ainda'));
  for (const r of acS.logRuns) {
    const o = acOption(r.id, r.process && r.process.alive ? `${r.name} (a correr)` : r.name);
    o.title = r.dir;
    sel.appendChild(o);
  }
  sel.value = acLogRunNow() ? acS.logRun : '';
  sel.disabled = !acS.logRuns.length;
}

function acFillLogFiles() {
  const run = acLogRunNow();
  const sel = $('#acLogFile');
  sel.replaceChildren();
  if (run) for (const f of run.files) sel.appendChild(acOption(f.name, `${f.name} (${acLogSize(f.size)})`));
  if (!run) acS.logFile = '';
  else if (!run.files.some((f) => f.name === acS.logFile)) {
    // the log of the microservice first, any log, any file
    acS.logFile = (run.files.find((f) => f.name === `${run.name}.log`) || run.files.find((f) => /\.log$/i.test(f.name)) || run.files[0] || { name: '' }).name;
    acS.logFresh = true;
  }
  sel.value = acS.logFile;
  sel.disabled = !run || !run.files.length;
}

function acSyncLogs() {
  const run = acLogRunNow();
  let text;
  if (!acS.logRuns.length) text = `Nada em ${acS.logBase || 'a pasta temporária'}: o arrancador cria aqui uma pasta arranque-<nome> quando arranca um microserviço`;
  else if (!run) text = `${acS.logRuns.length} microserviço${acS.logRuns.length === 1 ? '' : 's'} com logs em ${acS.logBase}`;
  else text = `${run.dir}${run.process ? ` · processo ${run.process.pid} ${AC_PROC_WORDS[run.process.state] || ''}` : ''}`;
  const hint = $('#acLogHint');
  hint.textContent = text;
  hint.title = text;
  if (!run || !acS.logFile) acLogNone();
  acSyncProcs();
}

// No log chosen: what to do, where the text would be.
function acLogNone() {
  const d = document.createElement('div');
  d.className = 'ac-ll empty';
  d.textContent = acS.logRuns.length ? 'Escolhe um microserviço para ver o fim do log.' : 'Ainda não há logs: aparecem quando o agente arranca um microserviço.';
  $('#acLogText').replaceChildren(d);
  $('#acLogMeta').textContent = '';
  acS.logShown = '';
  acS.logSig = '';
}

function acPaintLog(r, problem) {
  const box = $('#acLogText');
  const scroll = $('#acLogScroll');
  const nearEnd = acS.logFresh || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
  const frag = document.createDocumentFragment();
  const line = (text, cls) => {
    const d = document.createElement('div');
    d.className = `ac-ll${cls ? ` ${cls}` : ''}`;
    d.textContent = text;
    frag.appendChild(d);
  };
  if (problem) line(problem, 'empty');
  else {
    const lines = r.text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const cut = Math.max(0, lines.length - AC_LOG_LINES);
    if (!lines.length) line('O ficheiro está vazio.', 'empty');
    for (const l of lines.slice(cut)) {
      line(l, /\b(ERROR|FATAL|SEVERE)\b|^Caused by:|Exception\b.*:/.test(l) && !/^\s+at /.test(l) ? 'err' : /\bWARN(ING)?\b/.test(l) ? 'warn' : /^\s+at |^\s+\.\.\. \d+ more/.test(l) ? 'trace' : '');
    }
    acS.logShown = lines.slice(cut).join('\n');
    $('#acLogMeta').textContent = [acLogSize(r.size), acLogAgo(r.mtimeMs), r.truncated ? `só o fim (os últimos ${acLogSize(r.maxBytes)})` : '', cut ? `${AC_LOG_LINES} linhas` : ''].filter(Boolean).join(' · ');
  }
  if (problem) $('#acLogMeta').textContent = '';
  box.replaceChildren(frag);
  if (nearEnd) scroll.scrollTop = scroll.scrollHeight;
  acS.logFresh = false;
}

async function acReadLog(quiet) {
  const run = acLogRunNow();
  if (!run || !acS.logFile || acS.logBusy) return;
  const key = `${run.id}/${acS.logFile}`;
  acS.logBusy = true;
  const r = await window.agentConsole.readLog(run.id, acS.logFile).catch((e) => ({ error: e.message }));
  acS.logBusy = false;
  if (key !== `${acS.logRun}/${acS.logFile}`) return; // another one was chosen while it was read
  if (!r || r.error) {
    acS.logSig = '';
    acPaintLog(null, (r && r.error) || 'Não consegui ler o ficheiro');
    if (!quiet) toast((r && r.error) || 'Não consegui ler o ficheiro', 'error');
    return;
  }
  const sig = `${key}|${r.size}|${r.mtimeMs}`;
  if (sig === acS.logSig && !acS.logFresh) {
    $('#acLogMeta').textContent = $('#acLogMeta').textContent.replace(/^([^·]+) · [^·]+/, `$1 · ${acLogAgo(r.mtimeMs)}`);
    return;
  }
  acS.logSig = sig;
  acPaintLog(r);
}

// The folders now. Each ~6 seconds while the page is open it reads them again quietly (a new microservice, a process that stopped).
async function acLoadLogs(manual = false) {
  const r = await window.agentConsole.logs().catch((e) => ({ error: e.message }));
  if (!r || r.error || !Array.isArray(r.runs)) {
    if (manual) toast((r && r.error) || 'Não consegui ler a pasta dos logs', 'error');
    return;
  }
  const first = !acS.logListSig && !acS.logRun;
  acS.logBase = r.base;
  acS.logRuns = r.runs;
  if (first) {
    // the one of last time, if it is still there
    let saved = '';
    try {
      saved = localStorage.getItem('acLogRun') || '';
      acS.logFollow = localStorage.getItem('acLogFollow') !== '0';
    } catch {
      saved = '';
    }
    $('#acLogFollow').checked = acS.logFollow;
    if (saved && r.runs.some((x) => x.id === saved)) acS.logRun = saved;
  }
  if (acS.logRun && !acLogRunNow()) {
    acS.logRun = '';
    acS.logFile = '';
  }
  const sig = JSON.stringify(r.runs.map((x) => [x.id, x.files.map((f) => f.name), x.process && x.process.state]));
  if (sig !== acS.logListSig) {
    acS.logListSig = sig;
    acFillLogRuns();
    acFillLogFiles();
  }
  acSyncLogs();
  if (manual) {
    toast(r.runs.length ? `${r.runs.length} microserviço${r.runs.length === 1 ? '' : 's'} com logs` : 'Nenhum log ainda', r.runs.length ? 'success' : 'info', { plain: true });
    acS.logSig = '';
  }
  if (acLogRunNow() && (manual || first)) acReadLog(true);
}

function acChooseLogRun(id) {
  acS.logRun = id;
  acS.logFile = '';
  acS.logSig = '';
  acS.logShown = '';
  acFillLogFiles();
  acSyncLogs();
  try {
    localStorage.setItem('acLogRun', id);
  } catch {
    // for this session only
  }
  acReadLog();
}

// -- The Java processes the arrancador started (the numbers in the .pid files of those folders): which are still there, and a way to
// stop them so they do not run for ever. Main checks that each is still the agent's before it touches it. --
const AC_PROC_CHIP = { running: 'a correr', stopped: 'parado', other: 'outro processo', unknown: 'desconhecido' };
const AC_FORCE_AFTER_MS = 5000;
const acProcRuns = () => acS.logRuns.filter((r) => r.process);
const acProcRunning = () => acProcRuns().filter((r) => r.process.state === 'running');
const acDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return s < 86400 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
};

function acProcMetaText(p) {
  const bits = [`PID ${p.pid}`];
  if (p.state === 'running' && p.startedMs) bits.push(`a correr há ${acDur(Date.now() - p.startedMs)}`);
  if (p.ports && p.ports.length) bits.push(`porta${p.ports.length === 1 ? '' : 's'} ${p.ports.join(', ')}`);
  return bits.join(' · ');
}

function acProcRow(r) {
  const p = r.process;
  const asked = acS.stopAsked.get(r.id);
  const row = document.createElement('div');
  row.className = 'ac-pr';
  row.dataset.run = r.id;
  row._p = p;
  const name = document.createElement('span');
  name.className = 'ac-pr-name';
  name.textContent = r.name;
  const chip = document.createElement('span');
  chip.className = `ac-pr-chip ${p.state}`;
  chip.textContent = p.state === 'running' && asked ? 'a parar...' : AC_PROC_CHIP[p.state] || p.state;
  if (p.state === 'other') chip.title = `O número ${p.pid} está no ficheiro .pid, mas agora é de outro processo: o do agente já terminou. Não lhe toco`;
  const meta = document.createElement('span');
  meta.className = 'ac-pr-meta';
  meta.textContent = acProcMetaText(p);
  const cmd = document.createElement('span');
  cmd.className = 'ac-pr-cmd';
  cmd.textContent = p.state === 'other' ? '' : p.command || '';
  cmd.title = p.command || '';
  row.append(name, chip, meta, cmd);
  const button = (label, title, handler, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-sm${cls ? ` ${cls}` : ''}`;
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', handler);
    row.appendChild(b);
  };
  button('Ver log', 'Abre o log deste microserviço', () => acViewLogOf(r.id));
  if (p.state === 'running') {
    button('Parar', 'Pede ao processo que termine (SIGTERM): o Spring fecha as ligações', () => acStopProc(r.id, false));
    if (asked && Date.now() - asked > AC_FORCE_AFTER_MS) button('Forçar', 'O processo não terminou: mata-o já (SIGKILL)', () => acStopProc(r.id, true), 'danger');
  }
  return row;
}

function acSyncProcs() {
  const runs = acProcRuns();
  const running = acProcRunning().length;
  const btn = $('#acProcBtn');
  btn.textContent = running ? `Processos · ${running} a correr` : 'Processos';
  btn.classList.toggle('live', running > 0);
  btn.title = running ? 'Há processos Java do agente a correr: abre a lista para os parar' : 'Os processos Java que o agente arrancou, para os parar';
  for (const id of [...acS.stopAsked.keys()]) if (!runs.some((r) => r.id === id && r.process.state === 'running')) acS.stopAsked.delete(id);
  if (acS.drawer !== 'procs') return;
  runs.sort((a, b) => Number(b.process.state === 'running') - Number(a.process.state === 'running') || a.name.localeCompare(b.name));
  const sig = JSON.stringify(runs.map((r) => {
    const asked = acS.stopAsked.get(r.id);
    return [r.id, r.process.pid, r.process.state, r.process.ports, r.process.command, asked ? (Date.now() - asked > AC_FORCE_AFTER_MS ? 2 : 1) : 0];
  }));
  const list = $('#acProcList');
  if (sig !== acS.procSig) {
    acS.procSig = sig;
    list.replaceChildren();
    if (!runs.length) {
      const d = document.createElement('div');
      d.className = 'ac-ll empty';
      d.style.padding = '10px 12px';
      d.textContent = 'Nenhum processo registado: quando o agente arrancar um microserviço, aparece aqui.';
      list.appendChild(d);
    }
    for (const r of runs) list.appendChild(acProcRow(r));
  } else {
    for (const row of list.querySelectorAll('.ac-pr')) row.querySelector('.ac-pr-meta').textContent = acProcMetaText(row._p);
  }
  $('#acProcMeta').textContent = runs.length ? `${running} a correr · ${runs.length - running} sem processo do agente` : '';
  $('#acProcStopAll').disabled = !running;
}

function acViewLogOf(runId) {
  $('#acLogRun').value = runId;
  acChooseLogRun(runId);
  acDrawerSet('logs');
}

// -- The drawer: closed, or open on one tab. A tab chosen again closes it. The tab of the processes says how many are running. --
function acDrawerPaint() {
  const open = Boolean(acS.drawer);
  $('#acDrawer').classList.toggle('open', open);
  $('#acDrawerBody').classList.toggle('hidden', !open);
  for (const [sel, tab] of [['#acTabTime', 'time'], ['#acTabLogs', 'logs'], ['#acProcBtn', 'procs']]) {
    $(sel).classList.toggle('on', acS.drawer === tab);
    $(sel).setAttribute('aria-selected', String(acS.drawer === tab));
  }
  $('#acPanelTime').classList.toggle('hidden', acS.drawer !== 'time');
  $('#acPanelLogs').classList.toggle('hidden', acS.drawer !== 'logs');
  $('#acPanelProcs').classList.toggle('hidden', acS.drawer !== 'procs');
  const toggle = $('#acDrawerToggle');
  toggle.title = open ? 'Fechar a gaveta' : 'Abrir a gaveta';
  toggle.setAttribute('aria-label', toggle.title);
}

function acDrawerSet(tab) {
  acS.drawer = ['time', 'logs', 'procs'].includes(tab) ? tab : '';
  if (acS.drawer) acS.lastTab = acS.drawer;
  try {
    localStorage.setItem('acDrawer', acS.drawer);
  } catch {
    // for this session only
  }
  acDrawerPaint();
  if (acS.drawer === 'procs') {
    acS.procSig = '';
    acSyncProcs();
    acLoadLogs();
  } else if (acS.drawer === 'logs') {
    acS.logFresh = true;
    acS.logSig = '';
    acSyncLogs();
    acReadLog(true);
  } else if (acS.drawer === 'time') {
    // what came while it was shut: the latest is in view
    requestAnimationFrame(() => {
      const sc = $('#acTimeline').closest('.ac-scroll');
      if (sc) sc.scrollTop = sc.scrollHeight;
    });
  }
}

const acDrawerTab = (tab) => acDrawerSet(acS.drawer === tab ? '' : tab);

// After a stop: look again soon, and once the time to force it has passed.
function acProcLookAgain() {
  for (const ms of [1200, 3500, AC_FORCE_AFTER_MS + 1200]) setTimeout(() => acLoadLogs(), ms);
}

async function acStopProc(runId, force) {
  const run = acS.logRuns.find((r) => r.id === runId);
  if (!run || !run.process) return;
  if (force && !(await askConfirm(`Forçar a paragem do ${run.name} (PID ${run.process.pid})?\nÉ como kill -9: o processo não fecha as ligações nem acaba o que estava a fazer.`, { confirm: 'Forçar', cancel: 'Cancelar', danger: true }))) return;
  const r = await window.agentConsole.stopProc(runId, force).catch((e) => ({ error: e.message }));
  if (r && r.error) {
    toast(r.error, 'error');
    acLoadLogs();
    return;
  }
  if (!force) acS.stopAsked.set(runId, Date.now());
  toast(force ? `Enviei kill -9 ao ${run.name} (PID ${run.process.pid})` : `Pedi ao ${run.name} (PID ${run.process.pid}) que termine`, 'success', { plain: true });
  acS.procSig = '';
  acSyncProcs();
  acProcLookAgain();
}

async function acStopAllProcs() {
  await acLoadLogs(); // what is running now, not what it was a moment ago
  const running = acProcRunning();
  if (!running.length) return;
  const names = running.map((r) => `${r.name} (PID ${r.process.pid})`).join('\n');
  if (!(await askConfirm(`Parar ${running.length} processo${running.length === 1 ? '' : 's'} Java do agente?\n${names}`, { confirm: 'Parar', cancel: 'Cancelar', danger: true }))) return;
  let sent = 0;
  for (const r of running) {
    const res = await window.agentConsole.stopProc(r.id, false).catch((e) => ({ error: e.message }));
    if (res && res.error) toast(`${r.name}: ${res.error}`, 'error');
    else {
      sent += 1;
      acS.stopAsked.set(r.id, Date.now());
    }
  }
  if (sent) toast(`Pedi a ${sent} processo${sent === 1 ? '' : 's'} que terminem`, 'success', { plain: true });
  acS.procSig = '';
  acSyncProcs();
  acProcLookAgain();
}

// The folder with all the recipes (the ones the Local setup writes), where the agent reads them.
async function acOpenRecipes() {
  const r = await window.localSetup.recipesFolder().catch((e) => ({ error: e.message }));
  if (r && r.error) toast(r.error, 'error');
  else if (r && r.empty) toast('Ainda não há receitas: faz Analyse de um microserviço no Local setup e ficam escritas aqui', 'info', { plain: true });
}

async function acCopyLog() {
  if (!acS.logShown) return;
  const r = await window.tools.copySecret(acS.logShown).catch((e) => ({ error: e.message }));
  toast(r.error || 'O log foi copiado (limpa-se da área de transferência em 30 segundos)', r.error ? 'error' : 'success', { plain: true });
}

async function acOpenLogFolder() {
  const run = acLogRunNow();
  if (!run) return;
  const r = await window.agentConsole.openLogs(run.id).catch((e) => ({ error: e.message }));
  if (r && r.error) {
    toast(r.error, 'error');
    acLoadLogs();
  }
}

async function acChoose(kind, value) {
  if (kind === 'mode' && value === 'bypassPermissions' && acS.mode !== 'bypassPermissions') {
    const where = acProjectName(acS.cwd || acS.chosen) || 'a pasta do projeto';
    const yes = await askConfirm(`Permitir tudo sem perguntar?\nO ${acName()} poderá alterar e apagar ficheiros e correr comandos em "${where}" sem pedir autorização. Usa isto só numa pasta que podes perder.`, { confirm: 'Permitir tudo', cancel: 'Cancelar', danger: true });
    if (!yes) {
      acSyncChoices();
      return;
    }
  }
  const was = kind === 'model' ? acS.choiceModel : acS.mode;
  if (kind === 'model') acS.choiceModel = value;
  else acS.mode = value;
  acSyncChoices();
  const r = await window.agentConsole.setChoice(kind, value);
  if (r && r.error) {
    if (kind === 'model') acS.choiceModel = was;
    else acS.mode = was;
    acSyncChoices();
    toast(r.error, 'error');
    return;
  }
  // Kept for the next time the app opens once the CLI has taken it (the event 'applied', below), or at once when no CLI
  // is running to say so; "tudo sem perguntar" never.
  if (!acS.running && value !== 'bypassPermissions') acSave(kind, value);
}

// what the user chose last time goes to main when the app has just opened (nothing said yet, no session)
async function acRestoreChoices(info) {
  if (info.running || info.sessionId || info.finished || info.events.length) return;
  // the agent first: the modes and the model are of it
  const agent = acSaved('agent');
  if (AC_AGENTS.some((a) => a[0] === agent) && agent !== info.agentId) {
    const r = await window.agentConsole.setChoice('agent', agent);
    if (!r || !r.error) {
      acS.agentId = agent;
      info = { ...info, model: '', mode: acModes().some((m) => m[0] === info.mode) ? info.mode : 'default' };
      acFillChoices();
    }
  }
  await acLoadModels();
  for (const kind of ['model', 'mode']) {
    const saved = acSaved(kind);
    const current = kind === 'model' ? info.model : info.mode;
    const valid = kind === 'model' ? acModelValid(saved) : acModes().some((m) => m[0] === saved) && saved !== 'bypassPermissions';
    if (saved && valid && saved !== current) await window.agentConsole.setChoice(kind, saved);
    if (saved && valid) {
      if (kind === 'model') acS.choiceModel = saved;
      else acS.mode = saved;
    }
  }
  // the agent of last time, if it is still in the folder
  const savedSub = acSaved('subagent');
  if (savedSub && savedSub !== acS.subagent && acAgentsFit().some((a) => a.id === savedSub)) {
    const r = await window.agentConsole.setChoice('subagent', savedSub);
    if (!r || !r.error) {
      acS.subagent = savedSub;
      acFillSubagent();
    }
  }
}

// -- What the user does --

async function acSend() {
  const box = $('#acInput');
  const text = box.value;
  if (!text.trim() || acS.finished) return;
  const cwd = acS.cwd || acS.chosen;
  if (!cwd) {
    toast('Escolhe primeiro o projeto', 'error');
    return;
  }
  if (!acS.running) acS.starting = true;
  acPaint();
  const r = await window.agentConsole.send(cwd, text);
  if (r && r.error) {
    acS.starting = false;
    acPaint();
    toast(r.error, 'error');
    if (r.code === 'no-agent') acRefreshInfo(true);
    return;
  }
  box.value = '';
  acFit();
  acPaint();
}

async function acAnswer(id, choice, answers) {
  const r = await window.agentConsole.answer(id, choice, answers);
  if (r && r.error) toast(r.error, 'error');
}

async function acInterrupt() {
  const r = await window.agentConsole.interrupt();
  if (r && r.error) toast(r.error, 'error');
}

let acNewTimer = null;
async function acNewSession() {
  const btn = $('#acNew');
  // while it works, a second click ends it
  if ((acS.busy || acS.pending.size) && !btn.classList.contains('confirm')) {
    btn.classList.add('confirm');
    btn.textContent = 'Terminar esta sessão?';
    clearTimeout(acNewTimer);
    acNewTimer = setTimeout(() => {
      btn.classList.remove('confirm');
      btn.textContent = 'Nova sessão';
    }, 4000);
    return;
  }
  clearTimeout(acNewTimer);
  btn.classList.remove('confirm');
  btn.textContent = 'Nova sessão';
  const r = await window.agentConsole.newSession();
  if (r && r.error) toast(r.error, 'error');
  $('#acInput').focus();
}

let acEndTimer = null;
async function acEndSession() {
  const btn = $('#acEnd');
  // while it works, a second click ends it
  if ((acS.busy || acS.pending.size) && !btn.classList.contains('confirm')) {
    btn.classList.add('confirm');
    btn.textContent = 'Terminar mesmo?';
    clearTimeout(acEndTimer);
    acEndTimer = setTimeout(() => {
      btn.classList.remove('confirm');
      btn.textContent = 'Terminar';
    }, 4000);
    return;
  }
  clearTimeout(acEndTimer);
  btn.classList.remove('confirm');
  btn.textContent = 'Terminar';
  const r = await window.agentConsole.endSession();
  if (r && r.error) toast(r.error, 'error');
}

async function acPickFolder() {
  const r = await window.agentConsole.pickFolder();
  if (r && r.path) {
    if (!acS.picked.includes(r.path)) acS.picked.push(r.path);
    acS.chosen = r.path;
  }
  acFillProjects();
  acPaint();
}

function acFit() {
  const box = $('#acInput');
  box.style.height = 'auto';
  box.style.height = `${Math.min(220, Math.max(44, box.scrollHeight + 2))}px`;
}

async function acRefreshInfo(again = false) {
  const info = await window.agentConsole.info(again);
  if (!info || info.error) return;
  acS.agent = info.agent;
  acS.agents = info.agents || null;
  if (info.agentId && info.agentId !== acS.agentId) {
    acS.agentId = info.agentId;
    acFillChoices();
  }
  const known = acS.events.length ? acS.events[acS.events.length - 1].n : 0;
  const latest = info.events.length ? info.events[info.events.length - 1].n : 0;
  // drawn again only when something came that this page did not see (it was reloaded, or opened late)
  if (latest !== known || info.events.length !== acS.events.length) {
    acRebuild(info.events, { running: info.running, cwd: info.cwd, sessionId: info.sessionId, trimmed: info.trimmed, pending: info.pending });
  } else {
    acS.running = info.running;
  }
  // main knows what is in force; on a fresh app, what the user chose last time goes to it first
  acS.choiceModel = info.model || '';
  acS.subagent = info.subagent || '';
  acS.mode = info.mode || 'default';
  acS.finished = Boolean(info.finished);
  if (info.liveModel) acS.model = info.liveModel;
  await acLoadModels();
  await acLoadAgents();
  await acRestoreChoices(info);
  acFillAgents();
  acFillProjects();
  acPaint();
}

function showAgentConsole() {
  acS.shown = true;
  // the projects at once; whether the CLI is there, and the session main keeps, when main has looked
  acFillProjects();
  acPaint();
  // the agents of the folder do not wait for the CLI to be looked for: reading a folder is quick
  acLoadAgents();
  acLoadLogs();
  acRefreshInfo();
  setTimeout(() => $('#acInput').focus(), 0);
}

function setupAgentConsole() {
  if (!$('#agentView') || !window.agentConsole) return;
  window.agentConsole.onEvent((ev) => {
    if (ev.kind === 'state' && ev.agentId && ev.agentId !== acS.agentId) {
      acS.agentId = ev.agentId;
      acS.choiceModel = '';
      acFillChoices();
      acFillAgents();
      acLoadModels();
    }
    if (ev.kind === 'state' && ev.state === 'reset') {
      acReset();
      acFillProjects();
      acPaint();
      return;
    }
    // what the CLI took is kept; what it refused goes back to the one before (the event carries it)
    if (ev.kind === 'state' && (ev.state === 'applied' || ev.state === 'refused') && (ev.what === 'model' || ev.what === 'mode')) {
      const value = ev.what === 'model' ? ev.model : ev.mode;
      if (typeof value === 'string' && value !== 'bypassPermissions') acSave(ev.what, value);
    }
    if (ev.kind === 'state' && ev.state === 'refused') toast(`${ev.what === 'model' ? 'O modelo' : 'As permissões'}: ${ev.error || `o ${acCli()} recusou`}`, 'error');
    if (!ev.transient) acS.events.push(ev);
    acApply(ev);
    acPaint();
  });
  acS.placeholder = $('#acInput').placeholder;
  acFillChoices();
  acFillSubagent();
  acSyncAgents();
  acFillAgents();
  $('#acAgent').addEventListener('change', (e) => acChooseAgent(e.target.value));
  $('#acModel').addEventListener('change', (e) => acChoose('model', e.target.value));
  $('#acLogRun').addEventListener('change', (e) => acChooseLogRun(e.target.value));
  $('#acLogFile').addEventListener('change', (e) => {
    acS.logFile = e.target.value;
    acS.logFresh = true;
    acS.logSig = '';
    acSyncLogs();
    acReadLog();
  });
  $('#acLogReload').addEventListener('click', () => acLoadLogs(true));
  $('#acLogFollow').addEventListener('change', (e) => {
    acS.logFollow = e.target.checked;
    try {
      localStorage.setItem('acLogFollow', e.target.checked ? '1' : '0');
    } catch {
      // for this session only
    }
    if (acS.logFollow) acReadLog(true);
  });
  $('#acTabTime').addEventListener('click', () => acDrawerTab('time'));
  $('#acTabLogs').addEventListener('click', () => acDrawerTab('logs'));
  $('#acProcBtn').addEventListener('click', () => acDrawerTab('procs'));
  $('#acDrawerToggle').addEventListener('click', () => acDrawerSet(acS.drawer ? '' : acS.lastTab));
  try {
    const kept = localStorage.getItem('acDrawer');
    if (['time', 'logs', 'procs'].includes(kept)) {
      acS.drawer = kept;
      acS.lastTab = kept;
    }
  } catch {
    // closed
  }
  acDrawerPaint();
  $('#acRecipesBtn').addEventListener('click', acOpenRecipes);
  $('#acProcStopAll').addEventListener('click', acStopAllProcs);
  $('#acLogCopy').addEventListener('click', acCopyLog);
  $('#acLogOpen').addEventListener('click', acOpenLogFolder);
  $('#acAgentsFolder').addEventListener('click', acPickAgentsFolder);
  $('#acAgentsReload').addEventListener('click', acReloadAgents);
  $('#acSubagent').addEventListener('change', (e) => acChooseSubagent(e.target.value));
  $('#acMode').addEventListener('change', (e) => acChoose('mode', e.target.value));
  $('#acEnd').addEventListener('click', acEndSession);
  $('#acSend').addEventListener('click', acSend);
  $('#acInput').addEventListener('input', () => {
    acFit();
    acPaint();
  });
  $('#acInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      acSend();
    }
  });
  $('#acInterrupt').addEventListener('click', acInterrupt);
  $('#acNew').addEventListener('click', acNewSession);
  $('#acAgainBtn').addEventListener('click', () => acRefreshInfo(true));
  $('#acProject').addEventListener('change', (e) => {
    if (e.target.value === AC_PICK) acPickFolder();
    else {
      acS.chosen = e.target.value;
      acPaint();
    }
  });
  $('#acAll').addEventListener('change', () => acRebuild(acS.events.slice()));
  acTagsSetup();
  // the time it has been working, while it works and the page is open
  setInterval(() => {
    if (typeof currentMode !== 'undefined' && currentMode === 'agent' && acS.busy && acS.running) acPaint();
  }, 1000);
  // the log chosen, while the page is open and "Seguir" is on: its end again every 1.5 seconds, and the folders every ~6 seconds
  setInterval(() => {
    if (typeof currentMode === 'undefined' || currentMode !== 'agent' || document.hidden) return;
    acS.logTick += 1;
    if (acS.logTick % 4 === 0) acLoadLogs();
    if (acS.logFollow && acS.drawer === 'logs' && acLogRunNow() && acS.logFile) acReadLog(true);
  }, 1500);
}

setupAgentConsole();
