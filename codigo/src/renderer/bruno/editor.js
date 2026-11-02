// -- The request chosen, to change: method and address, then its parts in tabs (Params, Body, Headers, Auth, Script,
// Tests). Changes are a draft until Save (Cmd+S) writes its .bru file; Send saves first, as the CLI sends the file.
// Drafts stay per request while the app is open, so another one can be looked at in between (a dot in the list).
// The address and Params are one thing, as in Bruno: the query in the address is the Query table, and :name in its
// path is a Path row. --
const BRU_EDIT_TABS = [['params', 'Params'], ['body', 'Body'], ['headers', 'Headers'], ['auth', 'Auth'], ['script', 'Script'], ['tests', 'Tests']];
const BRU_EDIT_SHOWN = 3; // Params, Body, Headers in sight; the others from the button at the end
const BRU_BODY_MODES = [['none', 'None'], ['json', 'JSON'], ['text', 'Text'], ['xml', 'XML'], ['formUrlEncoded', 'Form'], ['multipartForm', 'Multipart']];
const BRU_AUTH_MODES = [['inherit', 'Inherit from the collection'], ['none', 'No auth'], ['bearer', 'Bearer token'], ['basic', 'Basic auth'], ['apikey', 'API key']];

// The draft of a request: the request as the page edits it (the query and the path params apart), what it was when
// read or saved (`base`, to know it changed) and when its file was read (`stamp`, so a file changed on disk is not
// written over).
function bruToDraft(edit) {
  const params = edit.params || [];
  const draft = { ...edit, query: params.filter((p) => p.type !== 'path'), path: params.filter((p) => p.type === 'path') };
  delete draft.params;
  return draft;
}

function bruFromDraft(draft) {
  const edit = { ...draft, params: [...draft.query.map((p) => ({ ...p, type: 'query' })), ...draft.path.map((p) => ({ ...p, type: 'path' }))] };
  delete edit.query;
  delete edit.path;
  return edit;
}

const bruDraftOf = (rel = bruState().selected) => (rel ? bruState().drafts.get(rel) || null : null);
const bruDirty = (draft) => Boolean(draft && draft.edit && JSON.stringify(draft.edit) !== draft.base);

function bruKeepDraft(rel, edit, stamp) {
  const draft = bruToDraft(edit);
  bruState().drafts.set(rel, { edit: draft, base: JSON.stringify(draft), stamp });
}

// -- The address and the params, kept as one --
function bruSplitUrl(url) {
  const i = url.indexOf('?');
  return i < 0 ? [url, ''] : [url.slice(0, i), url.slice(i + 1)];
}

function bruParamsFromUrl(edit) {
  const [base, query] = bruSplitUrl(edit.url);
  const typed = query
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf('=');
      return { name: i < 0 ? part : part.slice(0, i), value: i < 0 ? '' : part.slice(i + 1), enabled: true };
    });
  edit.query = [...typed, ...edit.query.filter((p) => p.enabled === false)];
  const before = new Map(edit.path.map((p) => [p.name, p]));
  edit.path = [...base.matchAll(/\/:([A-Za-z_][\w-]*)/g)].map((m) => before.get(m[1]) || { name: m[1], value: '', enabled: true });
}

function bruUrlFromParams(edit) {
  const [base] = bruSplitUrl(edit.url);
  const on = edit.query.filter((p) => p.enabled !== false && p.name);
  edit.url = on.length ? `${base}?${on.map((p) => `${p.name}=${p.value}`).join('&')}` : base;
}

// -- Drawing: the head (name, not saved, Save / Revert), the address line, the tabs and the one open --
function renderBrunoRequest() {
  const d = bru.detail;
  const draft = bruDraftOf();
  const edit = draft && draft.edit;
  const name = $('#bruReqName');
  name.disabled = !edit;
  if (document.activeElement !== name) name.value = edit ? edit.name : d ? d.name : '';
  bruFitName();
  const method = $('#bruMethodSel');
  const url = $('#bruUrlInput');
  method.disabled = !edit;
  url.disabled = !edit;
  url.readOnly = !edit;
  if (edit) {
    if (![...method.options].some((o) => o.value === edit.method)) method.appendChild(bruEl('option', '', edit.method)).value = edit.method;
    method.value = edit.method;
    if (document.activeElement !== url) url.value = edit.url;
  } else {
    method.value = d ? d.method : 'GET';
    url.value = d ? d.url : '';
  }
  method.className = `bru-method-select m-${method.value.toLowerCase()}`;
  url.placeholder = d ? '{{baseUrl}}/api/...' : 'Choose a request on the left.';
  paintBrunoUrl();
  renderBrunoSaveState();
  // the open tab is drawn again only for another request or tab: typing in it keeps its place
  const shown = `${bru.dir}|${d ? d.path : ''}|${bruState().editTab}|${draft ? draft.base : ''}`;
  renderBrunoEditTabs();
  if (bru.editShown !== shown) {
    bru.editShown = shown;
    renderBrunoEditPane();
  }
}

// The name field as wide as its name (a little more while it has the focus, to type on).
function bruFitName() {
  const name = $('#bruReqName');
  name.style.width = `${Math.max(6, name.value.length + 2)}ch`;
}

function renderBrunoSaveState() {
  const draft = bruDraftOf();
  const dirty = bruDirty(draft);
  const stale = Boolean(draft && draft.diskStamp && draft.diskStamp !== draft.stamp);
  const note = $('#bruDirty');
  note.classList.toggle('hidden', !dirty && !stale);
  note.classList.toggle('stale', stale);
  note.textContent = stale ? 'Changed on disk too' : 'Not saved';
  note.title = stale ? 'Its file changed on disk after you changed it here: Revert loads it as it is now' : 'Changed here, not yet in its .bru file: Save (Cmd+S) writes it; Send saves it first';
  $('#bruSaveBtn').classList.toggle('hidden', !dirty);
  $('#bruRevertBtn').classList.toggle('hidden', !dirty && !stale);
  const row = [...$$('#bruTree .bru-req')].find((r) => r.dataset.path === bruState().selected);
  if (row) row.classList.toggle('dirty', dirty);
}

// The address with its {{variables}} in colour: a layer under the field, moved with it as it scrolls.
function paintBrunoUrl() {
  const input = $('#bruUrlInput');
  const shade = $('#bruUrlShade');
  shade.replaceChildren(...bruUrlNodes(input.value));
  shade.style.transform = `translateX(${-input.scrollLeft}px)`;
  const used = [...input.value.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => {
    const known = bruVarValue(m[1]);
    if (!known && m[1].startsWith('process.env.')) return bruProcessNote(m[1].slice(12));
    return `${m[1]} = ${known ? (typeof known.value === 'string' ? known.value : JSON.stringify(known.value)) : '(no value yet)'}${known && known.note ? ` (${known.note})` : ''}`;
  });
  input.title = used.length ? [...new Set(used)].join('\n') : '';
}

function bruEditCount(key, edit) {
  if (!edit) return '';
  const on = (list) => list.filter((r) => r.enabled !== false && r.name).length;
  if (key === 'params') return on(edit.query) + edit.path.length || '';
  if (key === 'headers') return on(edit.headers) || '';
  if (key === 'body') return edit.bodyMode === 'none' ? '' : (BRU_BODY_MODES.find(([m]) => m === edit.bodyMode) || [0, edit.bodyMode])[1];
  if (key === 'auth') return { none: '', inherit: 'inherit', bearer: 'bearer', basic: 'basic', apikey: 'key' }[edit.authMode] ?? edit.authMode;
  if (key === 'script') return [edit.script.req, edit.script.res].filter((s) => s.trim()).length || '';
  if (key === 'tests') return on(edit.assertions) + (edit.tests.trim() ? 1 : 0) || '';
  return '';
}

function renderBrunoEditTabs() {
  const st = bruState();
  const edit = bruDraftOf() && bruDraftOf().edit;
  const tabs = $('#bruEditTabs');
  tabs.innerHTML = '';
  const open = (key) => {
    st.editTab = key;
    renderBrunoRequest();
  };
  for (const [key, label] of BRU_EDIT_TABS.slice(0, BRU_EDIT_SHOWN)) {
    const b = bruEl('button', `bru-tab${st.editTab === key ? ' active' : ''}`, label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(st.editTab === key));
    b.disabled = !edit;
    const count = bruEditCount(key, edit);
    if (count !== '') b.appendChild(bruEl('span', 'bru-tab-count', String(count)));
    b.addEventListener('click', () => open(key));
    tabs.appendChild(b);
  }
  const more = BRU_EDIT_TABS.slice(BRU_EDIT_SHOWN).map(([key, label]) => [key, label, String(bruEditCount(key, edit))]);
  bruMoreTab(tabs, more, st.editTab, open, { disabled: !edit });
}

// Something in the draft changed: the marks follow (Not saved, the dot, the counts), not the fields being typed in.
function bruEdited() {
  renderBrunoSaveState();
  renderBrunoEditTabs();
}

function renderBrunoEditPane() {
  const pane = $('#bruEditPane');
  const focus = bruFocusOf(pane);
  pane.innerHTML = '';
  const d = bru.detail;
  const draft = bruDraftOf();
  if (!d) return;
  if (!draft) {
    pane.appendChild(bruEl('div', 'bru-dim bru-empty', d.editError || 'Reading it...'));
    return;
  }
  const edit = draft.edit;
  const tab = bruState().editTab;
  if (tab === 'params') {
    pane.appendChild(bruSection('Query', bruKvEditor(edit.query, {
      focusKey: 'query',
      namePh: 'name',
      valuePh: 'value',
      onChange: () => {
        bruUrlFromParams(edit);
        $('#bruUrlInput').value = edit.url;
        paintBrunoUrl();
        bruEdited();
      },
    })));
    const path = edit.path.length
      ? bruKvEditor(edit.path, { focusKey: 'path', fixed: true, valuePh: 'value', onChange: bruEdited })
      : bruEl('div', 'bru-dim bru-hint', 'None: write :name in the address (/api/products/:id) and set its value here.');
    pane.appendChild(bruSection('Path', path));
  } else if (tab === 'headers') {
    pane.appendChild(bruKvEditor(edit.headers, { focusKey: 'headers', namePh: 'Header', valuePh: 'value, {{variable}}', onChange: bruEdited }));
    pane.appendChild(bruEl('div', 'bru-dim bru-hint', 'Content-Type comes from the body when it is not here.'));
  } else if (tab === 'body') {
    renderBrunoBody(pane, edit);
  } else if (tab === 'auth') {
    renderBrunoAuth(pane, edit);
  } else if (tab === 'script') {
    // each with the button of the commands a script can use (bruno/snippets.js)
    pane.appendChild(bruScriptField('Pre-request: before it is sent', bruCodeArea(edit.script.req, (v) => {
      edit.script.req = v;
      bruEdited();
    }, { focusKey: 'script.req', rows: 7, placeholder: 'req.setHeader("X-Trace", Date.now());' }), 'req'));
    pane.appendChild(bruScriptField('Post-response: after the answer', bruCodeArea(edit.script.res, (v) => {
      edit.script.res = v;
      bruEdited();
    }, { focusKey: 'script.res', rows: 7, placeholder: 'bru.setVar("productId", res.body.id);' }), 'res', 'bru.setVar(name, value) keeps a value for the next requests, as {{name}}.'));
  } else if (tab === 'tests') {
    pane.appendChild(bruSection('Assertions', bruKvEditor(edit.assertions, { focusKey: 'asserts', namePh: 'res.status', valuePh: 'eq 200', onChange: bruEdited })));
    pane.appendChild(bruLabeled('Tests', bruCodeArea(edit.tests, (v) => {
      edit.tests = v;
      bruEdited();
    }, { focusKey: 'tests', rows: 7, placeholder: 'test("is 200", () => {\n  expect(res.status).to.equal(200);\n});' })));
  }
  bruRefocus(pane, focus);
}

function renderBrunoBody(pane, edit) {
  const modes = bruEl('div', 'bru-seg');
  modes.setAttribute('role', 'radiogroup');
  modes.setAttribute('aria-label', 'Body');
  for (const [mode, label] of BRU_BODY_MODES) {
    const b = bruEl('button', `bru-seg-btn${edit.bodyMode === mode ? ' on' : ''}`, label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(edit.bodyMode === mode));
    b.addEventListener('click', () => {
      edit.bodyMode = mode;
      bruEdited();
      renderBrunoEditPane();
    });
    modes.appendChild(b);
  }
  // the modes, and (JSON) whether it reads as JSON and Format, on one line
  const head = bruEl('div', 'bru-body-head');
  head.appendChild(modes);
  pane.appendChild(head);
  const mode = edit.bodyMode;
  if (mode === 'none') {
    pane.appendChild(bruEl('div', 'bru-dim bru-hint', 'It sends no body.'));
  } else if (mode === 'json' || mode === 'text' || mode === 'xml') {
    const hint = bruEl('span', 'bru-json-hint');
    const area = bruCodeArea(edit.body[mode], (v) => {
      edit.body[mode] = v;
      checkJson();
      bruEdited();
    }, { focusKey: `body.${mode}`, rows: 12, placeholder: mode === 'json' ? '{\n  "name": "{{name}}"\n}' : '' });
    area.classList.add('bru-body-edit');
    // JSON: whether it reads as JSON ({{variables}} outside quotes are fine for Bruno, not for this check)
    const checkJson = () => {
      if (mode !== 'json') return;
      const text = edit.body.json.trim();
      let ok = true;
      try {
        if (text) JSON.parse(text.replace(/\{\{[^}]+\}\}/g, '0'));
      } catch {
        ok = false;
      }
      hint.textContent = !text ? '' : ok ? 'JSON' : 'Not valid JSON';
      hint.className = `bru-json-hint${ok ? '' : ' bad'}`;
    };
    if (mode === 'json') {
      const tools = bruEl('div', 'bru-body-tools');
      const format = bruEl('button', 'btn btn-sm', 'Format');
      format.type = 'button';
      format.title = 'Lay the JSON out, two spaces a level';
      format.addEventListener('click', () => {
        try {
          // {{variables}} outside quotes kept as they are
          const marks = [];
          const plain = edit.body.json.replace(/\{\{[^}]+\}\}/g, (m) => `"__gq${marks.push(m) - 1}__"`);
          let text = JSON.stringify(JSON.parse(plain), null, 2);
          text = text.replace(/"__gq(\d+)__"/g, (_, i) => marks[Number(i)]);
          area.focus();
          area.select();
          document.execCommand('insertText', false, text);
        } catch {
          toast('It is not valid JSON yet, so it cannot be laid out', 'error');
        }
      });
      tools.append(hint, format);
      head.appendChild(tools);
      checkJson();
    }
    pane.appendChild(area);
  } else if (mode === 'formUrlEncoded') {
    pane.appendChild(bruKvEditor(edit.body.formUrlEncoded, { focusKey: 'form', namePh: 'field', valuePh: 'value', onChange: bruEdited }));
  } else if (mode === 'multipartForm') {
    pane.appendChild(bruKvEditor(edit.body.multipartForm, {
      focusKey: 'multipart',
      namePh: 'part',
      valuePh: 'text, or a file in the collection',
      fresh: { type: 'text' },
      onChange: bruEdited,
      extra: (row, changed) => {
        const kind = bruEl('select', 'input bru-kv-kind');
        kind.setAttribute('aria-label', 'Text or file');
        for (const [v, label] of [['text', 'Text'], ['file', 'File']]) kind.appendChild(bruEl('option', '', label)).value = v;
        kind.value = row.type === 'file' ? 'file' : 'text';
        kind.addEventListener('change', () => {
          row.type = kind.value;
          changed();
        });
        return kind;
      },
    }));
    pane.appendChild(bruEl('div', 'bru-dim bru-hint', 'A file: its path from the collection folder (assets/cover.png).'));
  }
}

function renderBrunoAuth(pane, edit) {
  const select = bruEl('select', 'input bru-auth-mode');
  select.setAttribute('aria-label', 'Auth');
  const known = BRU_AUTH_MODES.some(([m]) => m === edit.authMode);
  for (const [mode, label] of BRU_AUTH_MODES) select.appendChild(bruEl('option', '', label)).value = mode;
  if (!known) {
    const other = select.appendChild(bruEl('option', '', `${edit.authMode} (kept as it is)`));
    other.value = edit.authMode;
  }
  select.value = edit.authMode;
  select.addEventListener('change', () => {
    edit.authMode = select.value;
    bruEdited();
    renderBrunoEditPane();
  });
  pane.appendChild(bruLabeled('Auth', select));
  const field = (label, get, set, key, hint, secret) => {
    const input = bruInput(get(), '', `auth.${key}`, 'bru-auth-input');
    if (secret) input.type = 'password';
    input.addEventListener('input', () => {
      set(input.value);
      bruEdited();
    });
    return bruLabeled(label, input, hint);
  };
  const a = edit.auth;
  if (edit.authMode === 'inherit') pane.appendChild(bruEl('div', 'bru-dim bru-hint', 'It uses the auth set for the whole collection (collection.bru), or the folder.'));
  else if (edit.authMode === 'none') pane.appendChild(bruEl('div', 'bru-dim bru-hint', 'It is sent without auth.'));
  else if (edit.authMode === 'bearer') pane.appendChild(field('Token', () => a.bearer.token, (v) => (a.bearer.token = v), 'bearer', 'Sent as Authorization: Bearer <token>. A {{variable}} keeps it out of the file.'));
  else if (edit.authMode === 'basic') {
    pane.appendChild(field('Username', () => a.basic.username, (v) => (a.basic.username = v), 'user'));
    pane.appendChild(field('Password', () => a.basic.password, (v) => (a.basic.password = v), 'password', 'Written in the .bru file as typed: a {{variable}} keeps it out of Git.', true));
  } else if (edit.authMode === 'apikey') {
    pane.appendChild(field('Key', () => a.apikey.key, (v) => (a.apikey.key = v), 'key', 'The header or query name, X-Api-Key...'));
    pane.appendChild(field('Value', () => a.apikey.value, (v) => (a.apikey.value = v), 'value'));
    const where = bruEl('select', 'input bru-auth-mode');
    for (const [v, label] of [['header', 'Header'], ['queryparams', 'Query params']]) where.appendChild(bruEl('option', '', label)).value = v;
    where.value = a.apikey.placement === 'queryparams' ? 'queryparams' : 'header';
    where.addEventListener('change', () => {
      a.apikey.placement = where.value;
      bruEdited();
    });
    pane.appendChild(bruLabeled('Add to', where));
  } else pane.appendChild(bruEl('div', 'bru-dim bru-hint', `This request uses ${edit.authMode}: it stays as it is. Change it in the Bruno app.`));
}

// -- Save, Revert --
async function bruSaveRequest({ quiet = false, rel = bruState().selected } = {}) {
  const st = bruState();
  const draft = st.drafts.get(rel);
  if (!draft || !bruDirty(draft)) return true;
  draft.edit.name = draft.edit.name.trim();
  if (!draft.edit.name) {
    toast('A request needs a name', 'error');
    if (rel === st.selected) $('#bruReqName').focus();
    return false;
  }
  const r = await window.bruno.saveRequest(bru.repo, bru.dir, rel, bruFromDraft(draft.edit), draft.stamp);
  if (r.error) {
    toast(r.error, 'error');
    return false;
  }
  bruKeepDraft(rel, r.edit, r.stamp);
  if (rel === st.selected) {
    bru.detail = { ...r.request, path: rel };
    bru.editShown = null;
    // the name as written (spaces in a row made one), even with the cursor in it
    const field = $('#bruReqName');
    if (field.value !== r.edit.name) field.value = r.edit.name;
  }
  if (!quiet) toast(`${r.request.name} saved`, 'success');
  await reloadBrunoTree();
  renderBrunoDetail();
  return true;
}

// Every request changed here and not saved, before a run that sends them from their files.
async function bruSaveAll() {
  const dirty = [...bruState().drafts.entries()].filter(([, d]) => bruDirty(d)).map(([rel]) => rel);
  for (const rel of dirty) if (!(await bruSaveRequest({ quiet: true, rel }))) return false;
  return true;
}

async function bruRevertRequest() {
  const rel = bruState().selected;
  if (!rel) return;
  bruState().drafts.delete(rel);
  bru.editShown = null;
  await loadBrunoDetail();
  renderBrunoTree();
}

function setupBrunoEditor() {
  // the name: a change like any other (Save writes it in its file; the file keeps its own name). Esc: the name saved.
  const name = $('#bruReqName');
  name.addEventListener('input', () => {
    const draft = bruDraftOf();
    if (!draft) return;
    draft.edit.name = name.value;
    bruFitName();
    bruEdited();
  });
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      name.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (bru.detail) name.value = bru.detail.name;
      name.dispatchEvent(new Event('input'));
      name.blur();
    }
  });
  const url = $('#bruUrlInput');
  url.addEventListener('input', () => {
    const draft = bruDraftOf();
    if (!draft) return;
    draft.edit.url = url.value;
    bruParamsFromUrl(draft.edit);
    paintBrunoUrl();
    bruEdited();
    // the Params tab shows what the address now has
    if (bruState().editTab === 'params') renderBrunoEditPane();
  });
  for (const ev of ['scroll', 'keyup', 'click', 'select']) url.addEventListener(ev, () => ($('#bruUrlShade').style.transform = `translateX(${-url.scrollLeft}px)`));
  url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      bruSend();
    }
  });
  $('#bruMethodSel').addEventListener('change', (e) => {
    const draft = bruDraftOf();
    if (!draft) return;
    draft.edit.method = e.target.value;
    e.target.className = `bru-method-select m-${e.target.value.toLowerCase()}`;
    bruEdited();
  });
  $('#bruSaveBtn').addEventListener('click', () => bruSaveRequest());
  $('#bruRevertBtn').addEventListener('click', bruRevertRequest);
}
