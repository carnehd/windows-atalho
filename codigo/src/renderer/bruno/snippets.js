// -- The commands a script can use, from a button over each script box: a list to look through (typing finds one),
// and a click (or Enter) puts it where the cursor was. A statement goes on a line of its own; a value (res.getBody())
// goes where the cursor is, inside what is being written; the part to change ("name") comes selected. Only what the
// Bruno CLI has (@usebruno/js): req, res, bru. --

// [group, code, what it does, the part to select, a statement (own line)]; where: 'req' before it is sent, 'res' after
const BRU_SNIPPETS = [
  ['Request', 'req.setHeader("name", "value");', 'Sets a header', 'name', true],
  ['Request', 'req.deleteHeader("name");', 'Takes a header out', 'name', true],
  ['Request', 'req.getHeader("name")', 'A header’s value', 'name'],
  ['Request', 'req.getHeaders()', 'All the headers'],
  ['Request', 'req.setBody({ key: "value" });', 'Replaces the body (an object for JSON, or text)', 'key: "value"', true],
  ['Request', 'req.getBody()', 'The body'],
  ['Request', 'req.setUrl("{{baseUrl}}/api/...");', 'Changes the address', '/api/...', true],
  ['Request', 'req.getUrl()', 'The address'],
  ['Request', 'req.setMethod("POST");', 'Changes the method', 'POST', true],
  ['Request', 'req.getMethod()', 'The method'],
  ['Request', 'req.setTimeout(5000);', 'How long to wait for the answer, in ms', '5000', true],
  ['Request', 'req.setMaxRedirects(0);', 'How many redirects to follow', '0', true],
  ['Request', 'req.getName()', 'The name of this request'],
  ['Response', 'res.getStatus()', 'The status code (200...)', null, false, 'res'],
  ['Response', 'res.getStatusText()', 'The words with it (OK...)', null, false, 'res'],
  ['Response', 'res.getBody()', 'The body (JSON read into an object)', null, false, 'res'],
  ['Response', 'res.getHeader("content-type")', 'A header’s value', 'content-type', false, 'res'],
  ['Response', 'res.getHeaders()', 'All the headers', null, false, 'res'],
  ['Response', 'res.getResponseTime()', 'How long it took, in ms', null, false, 'res'],
  ['Response', 'res.getSize().total', 'Its size, in bytes', null, false, 'res'],
  ['Response', 'res.setBody(data);', 'Replaces the body the checks see', 'data', true, 'res'],
  ['Variables', 'bru.setVar("name", value);', 'Keeps a value for the next requests, as {{name}}', 'name', true],
  ['Variables', 'bru.getVar("name")', 'A value kept by a script', 'name'],
  ['Variables', 'bru.hasVar("name")', 'Whether a script kept one', 'name'],
  ['Variables', 'bru.deleteVar("name");', 'Forgets a value kept', 'name', true],
  ['Variables', 'bru.getEnvVar("name")', 'A variable of the environment', 'name'],
  ['Variables', 'bru.setEnvVar("name", "value");', 'Changes a variable of the environment, for this run', 'name', true],
  ['Variables', 'bru.getEnvName()', 'The name of the environment'],
  ['Variables', 'bru.getProcessEnv("NAME")', 'A variable of the system (process.env)', 'NAME'],
  ['Variables', 'bru.interpolate("{{baseUrl}}")', 'A text with its {{variables}} filled in', '{{baseUrl}}'],
  ['Run', 'bru.setNextRequest("Request name");', 'The request to run next (Run all)', 'Request name', true],
  ['Run', 'bru.runner.skipRequest();', 'Does not send this request', null, true, 'req'],
  ['Run', 'bru.runner.stopExecution();', 'Stops the run here', null, true],
  ['Run', 'await bru.sleep(1000);', 'Waits, in ms', '1000', true],
  ['Run', 'await bru.runRequest("Folder/Request");', 'Sends another request of the collection first', 'Folder/Request', true],
  ['Run', 'const answer = await bru.sendRequest({ method: "GET", url: "{{baseUrl}}/api/..." });', 'Sends a request of its own', '/api/...', true],
  ['Other', 'console.log(value);', 'Writes in the Log tab', 'value', true],
].map(([group, code, what, select = null, statement = false, where = null]) => ({ group, code, what, select, statement, where }));

let bruSnip = null; // the list open: { menu, area, at: [start, end], button }

// A script box with its title and the button over it.
function bruScriptField(title, area, where, hint) {
  const field = bruEl('div', 'bru-field');
  const head = bruEl('div', 'bru-field-head');
  const label = bruEl('span', 'bru-field-label', title);
  label.id = `bruScriptLabel-${where}`;
  area.setAttribute('aria-labelledby', label.id);
  const button = bruEl('button', 'btn btn-sm btn-icon bru-snip-btn');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.title = 'The commands a script can use: one is put where the cursor is';
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4a2 2 0 0 0 -2 2v3a2 3 0 0 1 -2 3a2 3 0 0 1 2 3v3a2 2 0 0 0 2 2"/><path d="M17 4a2 2 0 0 1 2 2v3a2 3 0 0 0 2 3a2 3 0 0 0 -2 3v3a2 2 0 0 1 -2 2"/></svg>Commands';
  // the cursor as it was in the box, before the button took the focus
  let at = null;
  button.addEventListener('mousedown', () => {
    at = document.activeElement === area ? [area.selectionStart, area.selectionEnd] : null;
  });
  button.addEventListener('click', () => {
    if (bruSnip && bruSnip.button === button) return closeBrunoSnippets(false);
    openBrunoSnippets(button, area, where, at || [area.value.length, area.value.length]);
    at = null;
  });
  head.append(label, button);
  field.append(head, area);
  if (hint) field.appendChild(bruEl('span', 'bru-field-hint', hint));
  return field;
}

function openBrunoSnippets(button, area, where, at) {
  closeBrunoSnippets(false);
  const menu = bruEl('div', 'clip-menu bru-snip-menu');
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Script commands');
  const find = bruInput('', 'Find a command', '', 'bru-snip-find');
  find.setAttribute('aria-label', 'Find a command');
  find.setAttribute('aria-controls', 'bruSnipList');
  const list = bruEl('div', 'bru-snip-list');
  list.id = 'bruSnipList';
  list.setAttribute('role', 'listbox');
  menu.append(find, list);
  const all = BRU_SNIPPETS.filter((s) => !s.where || s.where === where);
  const draw = () => {
    const q = find.value.trim().toLowerCase();
    list.innerHTML = '';
    let group = null;
    for (const s of all) {
      if (q && !`${s.code} ${s.what}`.toLowerCase().includes(q)) continue;
      if (s.group !== group) {
        group = s.group;
        list.appendChild(bruEl('div', 'sel-group', group));
      }
      const item = bruEl('button', 'clip-menu-item bru-snip-item');
      item.type = 'button';
      item.tabIndex = -1;
      item.setAttribute('role', 'option');
      item.append(bruEl('code', 'bru-snip-code', s.code), bruEl('span', 'bru-snip-what', s.what));
      item.snippet = s;
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => insertBrunoSnippet(s));
      list.appendChild(item);
    }
    if (!list.children.length) list.appendChild(bruEl('div', 'bru-dim bru-snip-none', 'None has that.'));
    mark(list.querySelector('.bru-snip-item'));
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
      if (items[i]) insertBrunoSnippet(items[i].snippet);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeBrunoSnippets(true);
    } else if (e.key === 'Tab') {
      closeBrunoSnippets(false);
    }
  });
  document.body.appendChild(menu);
  bruSnip = { menu, area, at, button };
  button.setAttribute('aria-expanded', 'true');
  draw();
  // under the button, its right edges lined up; above it when there is more room there
  const b = button.getBoundingClientRect();
  const below = window.innerHeight - b.bottom - 12;
  const above = b.top - 12;
  const up = below < 260 && above > below;
  menu.style.maxHeight = `${Math.min(420, up ? above : below)}px`;
  const m = menu.getBoundingClientRect();
  menu.style.left = `${Math.round(Math.max(8, Math.min(b.right - m.width, window.innerWidth - m.width - 8)))}px`;
  menu.style.top = `${Math.round(up ? b.top - 4 - m.height : b.bottom + 4)}px`;
  find.focus();
  document.addEventListener('mousedown', bruSnipOutside, true);
  window.addEventListener('blur', bruSnipAway);
  window.addEventListener('resize', bruSnipAway);
}

function bruSnipOutside(e) {
  if (bruSnip && !bruSnip.menu.contains(e.target) && !bruSnip.button.contains(e.target)) closeBrunoSnippets(false);
}

function bruSnipAway() {
  closeBrunoSnippets(false);
}

// back: the focus in the script box (Esc, or a command put in) or on the button
function closeBrunoSnippets(back) {
  if (!bruSnip) return;
  const { menu, area, at, button } = bruSnip;
  bruSnip = null;
  menu.remove();
  button.setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', bruSnipOutside, true);
  window.removeEventListener('blur', bruSnipAway);
  window.removeEventListener('resize', bruSnipAway);
  if (back && area.isConnected) {
    area.focus();
    area.setSelectionRange(at[0], at[1]);
  }
}

// Put a command where the cursor was: a statement on a line of its own, a value as it is. Typed in (execCommand), so
// Cmd+Z takes it out and the draft follows as when typing.
function insertBrunoSnippet(s) {
  if (!bruSnip) return;
  const { area, at } = bruSnip;
  closeBrunoSnippets(true);
  const before = area.value.slice(0, at[0]);
  const after = area.value.slice(at[1]);
  let text = s.code;
  if (s.statement) {
    const indent = (before.slice(before.lastIndexOf('\n') + 1).match(/^\s*/) || [''])[0];
    if (before.trim() && !/\n\s*$/.test(before)) text = `\n${indent}${text}`;
    if (after && !after.startsWith('\n')) text = `${text}\n${indent}`;
  }
  document.execCommand('insertText', false, text);
  if (s.select) {
    const start = at[0] + text.indexOf(s.select);
    area.setSelectionRange(start, start + s.select.length);
  }
}
