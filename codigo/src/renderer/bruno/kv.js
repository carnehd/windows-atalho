// -- The parts the request and environment editors are made of: a table of name / value rows, a code box, a field with
// its label. Each changes the object it was given in place and says so with onChange; every input has a focus key, so
// a part drawn again (after Save) puts the cursor back where it was. --

function bruInput(value, placeholder, focusKey, cls = '') {
  const input = bruEl('input', `input bru-input${cls ? ` ${cls}` : ''}`);
  input.type = 'text';
  input.value = value || '';
  input.placeholder = placeholder || '';
  input.spellcheck = false;
  input.autocomplete = 'off';
  if (focusKey) input.dataset.focusKey = focusKey;
  return input;
}

// Rows of { name, value, enabled }: the box switches one off (it stays, with a ~ in the file), × takes it out, and
// typing in the empty row at the end adds one. fixed: the names come from elsewhere (path params): no add or remove.
// extra(row, changed): one more control at the end of a row (Text or File in a multipart body).
// locked(row): a text for a row whose value cannot be set here (a secret variable).
function bruKvEditor(rows, { onChange, namePh = 'Name', valuePh = 'Value', fixed = false, focusKey = 'kv', extra = null, locked = null, nameKey = 'name', fresh = {} }) {
  const box = bruEl('div', `bru-kv-edit${extra ? ' has-extra' : ''}`);
  const changed = (structural) => onChange && onChange(structural);
  const line = (row, i) => {
    let current = row; // the empty row at the end has none until something is typed in it
    const el = bruEl('div', `bru-kv-row${row ? '' : ' new'}${row && row.enabled === false ? ' off' : ''}`);
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.className = 'file-check';
    on.checked = row ? row.enabled !== false : true;
    on.disabled = !row;
    on.title = 'Untick to switch it off: it stays, but is not used';
    on.addEventListener('change', () => {
      current.enabled = on.checked;
      el.classList.toggle('off', !on.checked);
      changed(false);
    });
    const name = bruInput(row ? row[nameKey] : '', namePh, `${focusKey}.${i}.name`, 'bru-kv-name');
    name.readOnly = fixed;
    const value = bruInput(row ? row.value : '', valuePh, `${focusKey}.${i}.value`, 'bru-kv-value');
    const lockedText = row && locked ? locked(row) : null;
    if (lockedText) {
      value.disabled = true;
      value.value = '';
      value.placeholder = lockedText;
    }
    const del = bruEl('button', 'bru-kv-del', '\u00d7');
    del.type = 'button';
    del.title = 'Remove it';
    del.setAttribute('aria-label', 'Remove');
    del.disabled = !row || fixed;
    del.addEventListener('click', () => {
      const at = rows.indexOf(current);
      if (at >= 0) rows.splice(at, 1);
      changed(true);
      draw();
    });
    const typed = (key, input) => () => {
      if (!current) {
        // the empty row becomes one where it is (the field typed in stays as it is), and a new empty row comes under it
        current = { [nameKey]: '', value: '', enabled: true, ...fresh };
        rows.push(current);
        el.classList.remove('new');
        on.disabled = false;
        del.disabled = fixed;
        if (extra) el.replaceChild(extra(current, () => changed(false)) || bruEl('span', 'bru-kv-extra'), el.children[3]);
        box.appendChild(line(null, rows.length));
        current[key] = input.value;
        changed(true);
        return;
      }
      current[key] = input.value;
      changed(false);
    };
    name.addEventListener('input', typed(nameKey, name));
    value.addEventListener('input', typed('value', value));
    el.append(on, name, value);
    if (extra) el.appendChild((row && extra(row, () => changed(false))) || bruEl('span', 'bru-kv-extra'));
    el.appendChild(del);
    return el;
  };
  const draw = (focus) => {
    box.innerHTML = '';
    rows.forEach((row, i) => box.appendChild(line(row, i)));
    if (!fixed) box.appendChild(line(null, rows.length));
    if (focus) bruRefocus(box, focus);
  };
  draw();
  return box;
}

// A box for code (a body, a script, tests): Tab puts in two spaces, Shift+Tab takes them out of the line.
function bruCodeArea(value, set, { placeholder = '', focusKey = '', rows = 8 } = {}) {
  const area = bruEl('textarea', 'bru-code-edit');
  area.value = value || '';
  area.placeholder = placeholder;
  area.rows = rows;
  area.spellcheck = false;
  if (focusKey) area.dataset.focusKey = focusKey;
  area.addEventListener('input', () => set(area.value));
  area.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (!e.shiftKey) {
      document.execCommand('insertText', false, '  ');
      return;
    }
    const start = area.value.lastIndexOf('\n', area.selectionStart - 1) + 1;
    const spaces = area.value.slice(start, start + 2).match(/^ {0,2}/)[0].length;
    if (!spaces) return;
    const caret = area.selectionStart;
    area.setSelectionRange(start, start + spaces);
    document.execCommand('delete');
    area.setSelectionRange(Math.max(start, caret - spaces), Math.max(start, caret - spaces));
  });
  return area;
}

function bruLabeled(label, control, hint) {
  const field = bruEl('label', 'bru-field');
  field.append(bruEl('span', 'bru-field-label', label), control);
  if (hint) field.appendChild(bruEl('span', 'bru-field-hint', hint));
  return field;
}

// The element with the focus inside `box`, to put it back after the box is drawn again.
function bruFocusOf(box) {
  const el = document.activeElement;
  if (!el || !box.contains(el) || !el.dataset.focusKey) return null;
  return { key: el.dataset.focusKey, pos: typeof el.selectionStart === 'number' ? el.selectionStart : null };
}

function bruRefocus(box, focus) {
  if (!focus) return;
  const el = [...box.querySelectorAll('[data-focus-key]')].find((x) => x.dataset.focusKey === focus.key);
  if (!el) return;
  el.focus();
  if (focus.pos !== null && typeof el.setSelectionRange === 'function') {
    try {
      el.setSelectionRange(focus.pos, focus.pos);
    } catch {
      // not a text field
    }
  }
}
