// consola-agente: a conversation with Claude CLI in a project folder (left) and each thing it does as it does it
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
const AC_SAVED = { model: 'acModel', mode: 'acMode' };

const acS = {
  agent: null, // { found, name, command, version }
  events: [], // all of the session, in order, as main sent them
  running: false,
  starting: false,
  cwd: null,
  realCwd: null, // the folder as the CLI says it (on macOS /private/var for /var)
  sessionId: null,
  model: '', // the model the CLI says it uses
  choiceModel: '', // the alias chosen ('': the CLI's own)
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
    b.title = `${hint}. ${off ? 'Clica para mostrar' : 'Clica para esconder'}; Shift+clique mostra só este tipo`;
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
    if (text.trim()) line.appendChild(acDetails('O que o Claude soube', acCut(text), 'bad'));
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
  el.innerHTML = `<div class="ac-msg-who">${role === 'user' ? 'Tu' : 'Claude'} · ${acClock(at)}</div><div class="ac-msg-text"></div>`;
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
  el.innerHTML = `<div class="ac-card-title">${ask ? 'O Claude pergunta' : `O Claude pede autorização para ${acEsc(acToolTitle(name))}`}<span class="ac-card-time">${acClock(at)}</span></div><div class="ac-card-body"></div><div class="ac-card-actions"></div><div class="ac-card-done hidden"></div>`;
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
      const login = /not logged in|\/login/i.test(said);
      acNote(login ? `O Claude CLI não tem sessão iniciada neste computador. Abre um terminal, corre "${(acS.agent && acS.agent.command) || 'claude'}", escreve /login e segue os passos.` : `O pedido falhou: ${said || (Array.isArray(e.errors) ? e.errors.join(' ') : e.subtype || 'erro')}`.slice(0, 1200), 'bad');
    }
    const line = acLine({ kind: e.is_error && !stopped ? 'bad' : 'done', label: stopped ? 'Interrompido' : e.is_error ? 'Falhou' : 'Concluído', what: `${acDuration(e.duration_ms)} · ${e.num_turns || 0} ${e.num_turns === 1 ? 'volta' : 'voltas'} · ${acMoney(acS.last.cost)}`, at });
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
    acLine({ kind: 'state', label: 'Interromper', what: 'pedido ao Claude para parar', at: ev.at });
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
      if (ev.resumed) acLine({ kind: 'state', label: 'Claude CLI', what: 'arrancou de novo e retomou a sessão', at: ev.at });
    } else if (ev.state === 'ended') {
      acS.running = false;
      acS.busy = false;
      acS.turnAt = 0;
      acS.interrupting = false;
      for (const id of [...acS.pending.keys()]) acCardDone(id, 'Cancelado (o Claude CLI terminou)', 'bad', ev.at);
      const how = ev.error || `${ev.signal ? `sinal ${ev.signal}` : `código ${ev.code}`}${ev.stderr ? ` · ${ev.stderr}` : ''}`;
      acLine({ kind: ev.code === 0 ? 'state' : 'bad', label: 'Claude CLI', what: `terminou (${how})`, at: ev.at });
      if (ev.code !== 0) acNote(`O Claude CLI terminou: ${how}. O próximo pedido arranca-o de novo e retoma a sessão.`, 'bad');
    } else if (ev.state === 'sigint') {
      acLine({ kind: 'bad', label: 'Interromper', what: 'sem resposta: enviado SIGINT ao Claude CLI', at: ev.at });
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

function acStateText() {
  if (acS.agent && !acS.agent.found) return ['Claude CLI não encontrado', 'bad'];
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
  const meta = acS.last ? [acMoney(acS.cost), `${acCount(acS.tokens)} tokens`, `${acDuration(acS.worked + live)} de trabalho`] : live ? [`${acDuration(live)} de trabalho`] : [];
  $('#acMeta').textContent = meta.join(' · ');
  $('#acMeta').title = 'O custo é o que o Claude CLI estima para esta sessão; os tokens somam os lidos e os escritos em cada resposta';
  const sel = $('#acProject');
  sel.disabled = Boolean(acS.cwd);
  sel.title = acS.cwd ? `${acS.cwd}\nEsta sessão é deste projeto: Nova sessão para mudar` : 'A pasta onde o Claude trabalha';
  $('#acInterrupt').disabled = acS.finished || !(acS.running && (acS.busy || acS.pending.size)) || acS.interrupting;
  $('#acEnd').disabled = acS.finished || !(acS.cwd || acS.sessionId || acS.events.length);
  $('#acNew').disabled = !(acS.cwd || acS.events.length);
  const found = !acS.agent || acS.agent.found;
  $('#acInput').disabled = acS.finished;
  $('#acInput').placeholder = acS.finished ? 'A conversa terminou. Nova sessão começa outra.' : acS.placeholder;
  $('#acSend').disabled = acS.finished || !found || !$('#acInput').value.trim();
  acSyncChoices();
  $('#acNoAgent').classList.toggle('hidden', found);
  const l = acS.last;
  $('#acFoot').textContent = l ? [
    `Última resposta: ${acDuration(l.ms)}`,
    `${l.turns} ${l.turns === 1 ? 'volta' : 'voltas'}`,
    `${acCount(l.wrote)} tokens escritos, ${acCount(l.read)} lidos`,
    acMoney(l.cost),
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
function acSaved(kind) {
  try {
    return localStorage.getItem(AC_SAVED[kind]) || '';
  } catch {
    return '';
  }
}

function acSave(kind, value) {
  try {
    localStorage.setItem(AC_SAVED[kind], value);
  } catch {
    // for this session only
  }
}

function acFillChoices() {
  const model = $('#acModel');
  model.innerHTML = '';
  for (const [value, label] of AC_MODELS) model.appendChild(Object.assign(document.createElement('option'), { value, textContent: label }));
  const mode = $('#acMode');
  mode.innerHTML = '';
  for (const [value, label, hint] of AC_MODES) mode.appendChild(Object.assign(document.createElement('option'), { value, textContent: label, title: hint }));
}

function acSyncChoices() {
  const model = $('#acModel');
  const mode = $('#acMode');
  if (!model || !mode) return;
  if (model.value !== acS.choiceModel) model.value = acS.choiceModel;
  if (mode.value !== acS.mode) mode.value = acS.mode;
  const current = AC_MODES.find((m) => m[0] === acS.mode) || AC_MODES[0];
  $('#acModeHint').textContent = current[2];
  mode.classList.toggle('danger', acS.mode === 'bypassPermissions');
  model.title = acS.model ? `Modelo em uso: ${acS.model}` : 'O modelo do Claude CLI. Predefinido é o que ele usa sem lhe dizerem nada';
  mode.title = current[2];
}

async function acChoose(kind, value) {
  if (kind === 'mode' && value === 'bypassPermissions' && acS.mode !== 'bypassPermissions') {
    const where = acProjectName(acS.cwd || acS.chosen) || 'a pasta do projeto';
    const yes = await askConfirm(`Permitir tudo sem perguntar?\nO Claude poderá alterar e apagar ficheiros e correr comandos em "${where}" sem pedir autorização. Usa isto só numa pasta que podes perder.`, { confirm: 'Permitir tudo', cancel: 'Cancelar', danger: true });
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
  for (const kind of ['model', 'mode']) {
    const saved = acSaved(kind);
    const current = kind === 'model' ? info.model : info.mode;
    const valid = kind === 'model' ? AC_MODELS.some((m) => m[0] === saved) : AC_MODES.some((m) => m[0] === saved) && saved !== 'bypassPermissions';
    if (saved && valid && saved !== current) await window.agentConsole.setChoice(kind, saved);
    if (saved && valid) {
      if (kind === 'model') acS.choiceModel = saved;
      else acS.mode = saved;
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
  acS.mode = info.mode || 'default';
  acS.finished = Boolean(info.finished);
  if (info.liveModel) acS.model = info.liveModel;
  await acRestoreChoices(info);
  acFillProjects();
  acPaint();
}

function showAgentConsole() {
  acS.shown = true;
  // the projects at once; whether the CLI is there, and the session main keeps, when main has looked
  acFillProjects();
  acPaint();
  acRefreshInfo();
  setTimeout(() => $('#acInput').focus(), 0);
}

function setupAgentConsole() {
  if (!$('#agentView') || !window.agentConsole) return;
  window.agentConsole.onEvent((ev) => {
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
    if (ev.kind === 'state' && ev.state === 'refused') toast(`${ev.what === 'model' ? 'O modelo' : 'As permissões'}: ${ev.error || 'o Claude CLI recusou'}`, 'error');
    if (!ev.transient) acS.events.push(ev);
    acApply(ev);
    acPaint();
  });
  acS.placeholder = $('#acInput').placeholder;
  acFillChoices();
  $('#acModel').addEventListener('change', (e) => acChoose('model', e.target.value));
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
}

setupAgentConsole();
