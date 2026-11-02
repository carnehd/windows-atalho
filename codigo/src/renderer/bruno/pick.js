// -- A field of the response picked (a click on its key or value), to keep its value as a variable: its place in the
// body as a script reads it (res.body.items[0].id), a name for it, and the post-response script gets the line
// bru.setVar("id", res.body.items[0].id); (not saved yet: Send saves it and runs it, then {{id}} has the value). --
let bruPicked = null; // the box open: { menu, span }

// The path as a script writes it: .key, ["a key"] when it is not a plain name, [0] for a place in a list.
const bruPathExpr = (path) => `res.body${path.map((k) => (typeof k === 'number' ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join('')}`;

// A name for it: its key (the list's, with the place, for a value in a list), as Bruno allows names (letters, digits, _ - .).
function bruPathName(path) {
  const key = [...path].reverse().find((k) => typeof k === 'string');
  const last = path[path.length - 1];
  const name = typeof last === 'number' ? `${key || 'item'}${last}` : key || 'value';
  return name.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// What is there now, from the last answer (for the box to show it).
function bruPathValue(path) {
  const result = bru.detail && bruState().results.get(bru.detail.path);
  let v = result && result.response ? result.response.data : undefined;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  for (const k of path) v = v === null || v === undefined ? undefined : v[k];
  return v;
}

function openBrunoPick(span) {
  closeBrunoPick();
  const path = span.bruPath;
  const expr = bruPathExpr(path);
  const value = bruPathValue(path);
  const menu = bruEl('div', 'clip-menu bru-pick');
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Keep as a variable');
  menu.appendChild(bruEl('code', 'bru-pick-path', expr));
  if (value !== undefined) {
    const shown = JSON.stringify(value);
    menu.appendChild(bruEl('div', 'bru-pick-value', shown.length > 120 ? `${shown.slice(0, 120)}…` : shown));
  }
  const row = bruEl('label', 'bru-pick-row');
  const name = bruInput(bruPathName(path), 'name', '', 'bru-pick-name');
  name.maxLength = 80;
  row.append(bruEl('span', '', 'Variable'), name);
  const error = bruEl('div', 'bru-pick-error');
  const actions = bruEl('div', 'bru-pick-actions');
  const copy = bruEl('button', 'btn btn-sm', 'Copy path');
  copy.type = 'button';
  copy.title = `Copy ${expr}, to use it in a script or a check`;
  copy.addEventListener('click', () => {
    closeBrunoPick();
    copyText(expr, 'Path');
  });
  const add = bruEl('button', 'btn btn-sm btn-primary', 'Add to post-response');
  add.type = 'button';
  add.title = 'Add bru.setVar to the post-response script: after the next Send, {{name}} has this value';
  const go = () => {
    const n = name.value.trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(n)) {
      error.textContent = 'A name of letters, digits, _ - or . (no spaces)';
      name.focus();
      return;
    }
    closeBrunoPick();
    bruAddSetVar(n, expr);
  };
  add.addEventListener('click', go);
  name.addEventListener('input', () => {
    error.textContent = '';
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === name) {
      e.preventDefault();
      go();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeBrunoPick();
    }
  });
  actions.append(copy, add);
  menu.append(row, error, actions);
  document.body.appendChild(menu);
  span.classList.add('picked');
  bruPicked = { menu, span };
  // under the field, or over it when there is no room under it
  const r = span.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const up = r.bottom + 6 + m.height > window.innerHeight - 8 && r.top - 6 - m.height > 8;
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - m.width - 8)))}px`;
  menu.style.top = `${Math.round(up ? r.top - 6 - m.height : r.bottom + 6)}px`;
  name.focus();
  name.select();
  document.addEventListener('mousedown', bruPickOutside, true);
  window.addEventListener('resize', closeBrunoPick);
  window.addEventListener('blur', closeBrunoPick);
}

function bruPickOutside(e) {
  if (bruPicked && !bruPicked.menu.contains(e.target)) closeBrunoPick();
}

function closeBrunoPick() {
  if (!bruPicked) return;
  bruPicked.menu.remove();
  bruPicked.span.classList.remove('picked');
  bruPicked = null;
  document.removeEventListener('mousedown', bruPickOutside, true);
  window.removeEventListener('resize', closeBrunoPick);
  window.removeEventListener('blur', closeBrunoPick);
}

// The line at the end of the post-response script (once), shown: the Script tab open, the line selected.
function bruAddSetVar(name, expr) {
  const draft = bruDraftOf();
  if (!draft) return toast('This request cannot be changed here', 'error');
  const line = `bru.setVar(${JSON.stringify(name)}, ${expr});`;
  const script = draft.edit.script.res || '';
  const there = script.split('\n').some((l) => l.trim() === line);
  if (!there) draft.edit.script.res = script.trim() ? `${script.replace(/\s+$/, '')}\n${line}` : line;
  bruState().editTab = 'script';
  bru.editShown = null;
  renderBrunoRequest();
  const area = $$('#bruEditPane .bru-code-edit')[1];
  if (area) {
    const at = area.value.lastIndexOf(line);
    area.focus({ preventScroll: true });
    area.setSelectionRange(at, at + line.length);
    // the post-response box in sight in its pane (its title too), the panes around it left as they are
    const pane = $('#bruEditPane');
    const field = area.closest('.bru-field') || area;
    pane.scrollTop += field.getBoundingClientRect().top - pane.getBoundingClientRect().top - 8;
  }
  if (there) toast('That line is already in the post-response script', 'info');
  else toast(`Added to the post-response script: Send to keep ${name}`, 'success');
}

function setupBrunoPick() {
  const pane = $('#bruPane');
  pane.addEventListener('click', (e) => {
    const span = e.target.closest('.pick');
    // text being selected in the answer is not a pick (a selection left in a script box does not count)
    const sel = window.getSelection();
    if (!span || !span.bruPath || (sel && !sel.isCollapsed && pane.contains(sel.anchorNode))) return;
    openBrunoPick(span);
  });
  pane.addEventListener('scroll', closeBrunoPick);
}
