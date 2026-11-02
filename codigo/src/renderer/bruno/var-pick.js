// -- A click on a {{variable}} in a field of the request (the address, a param, a header, the body): a list of every
// variable there is, to put another in its place. The environment's, those the scripts kept, those of the other
// environments (with which ones have it) and the .env's, each with its value; the one clicked marked. Type to filter,
// arrows and Enter to pick, Esc to close. Put in as typed (Cmd+Z takes it back), so the draft follows. --
let bruVarPick = null; // the list open: { menu, field, start, end }

// The {{...}} the caret is in: where it starts and ends, and its name.
function bruVarAt(field) {
  const at = field.selectionStart;
  if (at === null || at !== field.selectionEnd) return null;
  for (const m of field.value.matchAll(/\{\{\s*([^{}\s]*)\s*\}\}/g)) {
    if (at > m.index && at < m.index + m[0].length) return { start: m.index, end: m.index + m[0].length, name: m[1] };
  }
  return null;
}

// Every variable, once, in groups: [{ name, value, group }].
function bruAllVars() {
  const out = new Map();
  const add = (name, value, group) => {
    if (name && !out.has(name)) out.set(name, { name, value, group });
  };
  const env = bru.envs.find((e) => e.name === bru.env);
  if (env) for (const v of env.vars) if (v.enabled) add(v.key, v.secret ? '(secret)' : v.value, `Environment ${env.name}`);
  for (const [k, v] of Object.entries(bru.vars || {})) add(k, bruUnset(v) ? 'undefined' : typeof v === 'string' ? v : JSON.stringify(v), 'Kept by the scripts');
  const elsewhere = new Map();
  for (const e of bru.envs) {
    if (e === env) continue;
    for (const v of e.vars) if (!out.has(v.key)) elsewhere.set(v.key, [...(elsewhere.get(v.key) || []), e.name]);
  }
  for (const [k, envs] of elsewhere) add(k, `in ${envs.join(', ')}`, 'Other environments');
  for (const n of (bru.dotenv && bru.dotenv.names) || []) add(`process.env.${n.key}`, n.set ? n.value : '(empty)', '.env');
  return [...out.values()];
}

function openBrunoVarPick(field, token, x, y) {
  closeBrunoVarPick(false);
  const menu = bruEl('div', 'clip-menu bru-snip-menu bru-varpick');
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Variables');
  const find = bruInput('', 'Find a variable', '', 'bru-snip-find');
  find.setAttribute('aria-label', 'Find a variable');
  const list = bruEl('div', 'bru-snip-list');
  list.setAttribute('role', 'listbox');
  menu.append(find, list);
  const all = bruAllVars();
  const draw = () => {
    const q = find.value.trim().toLowerCase();
    list.innerHTML = '';
    let group = null;
    for (const v of all) {
      if (q && !`${v.name} ${v.value}`.toLowerCase().includes(q)) continue;
      if (v.group !== group) {
        group = v.group;
        list.appendChild(bruEl('div', 'sel-group', group));
      }
      const item = bruEl('button', `clip-menu-item bru-snip-item${v.name === token.name ? ' current' : ''}`);
      item.type = 'button';
      item.tabIndex = -1;
      item.setAttribute('role', 'option');
      item.title = `{{${v.name}}} = ${v.value}`;
      item.append(bruEl('code', 'bru-snip-code', v.name), bruEl('span', 'bru-snip-what', v.value === '' ? '(empty)' : v.value));
      item.varName = v.name;
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => useBrunoVar(v.name));
      list.appendChild(item);
    }
    if (!list.children.length) list.appendChild(bruEl('div', 'bru-dim bru-snip-none', all.length ? 'None has that.' : 'No variables yet: an environment, a script (bru.setVar) or the .env gives them.'));
    const items = [...list.querySelectorAll('.bru-snip-item')];
    mark(items.find((i) => i.varName === token.name && !q) || items[0]);
  };
  const mark = (item) => {
    list.querySelectorAll('.bru-snip-item.active').forEach((x) => {
      x.classList.remove('active');
      x.setAttribute('aria-selected', 'false');
    });
    if (!item) return;
    item.classList.add('active');
    item.setAttribute('aria-selected', 'true');
    const top = item.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + item.offsetHeight - list.clientHeight;
  };
  find.addEventListener('input', draw);
  find.addEventListener('keydown', (e) => {
    const items = [...list.querySelectorAll('.bru-snip-item')];
    const i = items.findIndex((x) => x.classList.contains('active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mark(items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[i]) useBrunoVar(items[i].varName);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeBrunoVarPick(true);
    } else if (e.key === 'Tab') {
      closeBrunoVarPick(false);
    }
  });
  document.body.appendChild(menu);
  bruVarPick = { menu, field, start: token.start, end: token.end };
  draw();
  // under the click; above it when there is more room there
  const below = window.innerHeight - y - 12;
  const above = y - 30;
  const up = below < 240 && above > below;
  menu.style.maxHeight = `${Math.min(380, up ? above : below)}px`;
  const m = menu.getBoundingClientRect();
  menu.style.left = `${Math.round(Math.max(8, Math.min(x - 24, window.innerWidth - m.width - 8)))}px`;
  menu.style.top = `${Math.round(up ? y - 26 - m.height : y)}px`;
  find.focus();
  document.addEventListener('mousedown', bruVarPickOutside, true);
  window.addEventListener('blur', bruVarPickAway);
  window.addEventListener('resize', bruVarPickAway);
}

function bruVarPickOutside(e) {
  if (bruVarPick && !bruVarPick.menu.contains(e.target)) closeBrunoVarPick(false);
}

function bruVarPickAway() {
  closeBrunoVarPick(false);
}

// back: the caret in the field again, at the end of the variable
function closeBrunoVarPick(back) {
  if (!bruVarPick) return;
  const { menu, field, end } = bruVarPick;
  bruVarPick = null;
  menu.remove();
  document.removeEventListener('mousedown', bruVarPickOutside, true);
  window.removeEventListener('blur', bruVarPickAway);
  window.removeEventListener('resize', bruVarPickAway);
  if (back && field.isConnected) {
    field.focus();
    field.setSelectionRange(end, end);
  }
}

// The variable clicked becomes {{name}}, typed in its place.
function useBrunoVar(name) {
  if (!bruVarPick) return;
  const { field, start, end } = bruVarPick;
  closeBrunoVarPick(false);
  if (!field.isConnected) return;
  field.focus();
  field.setSelectionRange(start, end);
  document.execCommand('insertText', false, `{{${name}}}`);
}

// A click in a field of the request (not its name, not a list's own search) on a {{variable}}.
function setupBrunoVarPick() {
  $('#tab-bruno').addEventListener('click', (e) => {
    const field = e.target.closest('input[type="text"], textarea');
    if (!field || field.id === 'bruReqName' || field.closest('.clip-menu') || !field.closest('.bru-req-head, #bruEditPane, .bru-url-box')) return;
    // the caret where the click put it (a click on selected text takes the selection away only after)
    setTimeout(() => {
      const token = document.activeElement === field && bruVarAt(field);
      if (!token) return;
      const r = field.getBoundingClientRect();
      openBrunoVarPick(field, token, e.clientX, field.tagName === 'TEXTAREA' ? e.clientY + 14 : r.bottom + 4);
    }, 0);
  });
}
