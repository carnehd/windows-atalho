// -- A request's menu (right click on it, or the menu key): Duplicate, Move to a folder (or a new one), Rename, Save in
// QuickDeck (a copy in the app's own folder of saved requests, and that folder), Delete. Each changes its file
// (bruno/files.js); then the list is read again, and its results and the request chosen go where it went. --
function openBrunoReqMenu(req, x, y) {
  const busy = bru.run ? 'A run is going: wait for it, or stop it' : '';
  const dirty = bruDirty(bruState().drafts.get(req.path)) ? 'It has changes not saved: save or revert them first' : '';
  const off = busy || dirty;
  openActionMenu({
    x, y,
    title: `${req.method} ${req.name}`,
    items: [
      { icon: 'copy', label: 'Duplicate...', disabled: Boolean(off), hint: off, run: () => bruReqNameForm(req, x, y, 'duplicate') },
      { icon: 'folder', label: 'Move to...', disabled: Boolean(off), hint: off, run: () => openBrunoMoveMenu(req, x, y) },
      { icon: 'rename', label: 'Rename...', disabled: Boolean(off), hint: off || 'Its name and its file', run: () => bruReqNameForm(req, x, y, 'rename') },
      { icon: 'pull', label: 'Save in QuickDeck', disabled: Boolean(dirty), hint: dirty || "A copy in QuickDeck's own folder of saved requests (data/saved-requests), with the others saved there", run: () => keepBrunoRequest(req) },
      { icon: 'stash', label: 'Saved requests folder', hint: 'Open the folder of the requests saved in QuickDeck', run: () => openBrunoSavedFolder() },
      { icon: 'delete', label: 'Delete...', danger: true, disabled: Boolean(busy), hint: busy || 'Its file goes to the Trash', run: () => deleteBrunoRequest(req) },
    ],
  });
}

// The folders of the collection, the top first, each with its whole path (Products / Images).
function bruFolders(items = bru.tree, names = []) {
  const out = names.length ? [] : [{ path: '', label: 'Top of the collection' }];
  for (const it of items) {
    if (it.type !== 'folder') continue;
    out.push({ path: it.path, label: [...names, it.name].join(' / ') });
    out.push(...bruFolders(it.items, [...names, it.name]));
  }
  return out;
}

const bruFolderOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

function openBrunoMoveMenu(req, x, y) {
  const here = bruFolderOf(req.path);
  openActionMenu({
    x, y,
    title: `Move ${req.name} to`,
    items: bruFolders().map((f) => ({
      icon: 'folder',
      label: f.label,
      disabled: f.path === here,
      hint: f.path === here ? 'It is there now' : `Last in ${f.label}`,
      run: () => bruReqOp('move', req, f.path),
    })).concat({ icon: 'plus', label: 'New folder...', hint: 'Make a folder and move it there', run: () => bruNewFolderForm(req, x, y) }),
  });
}

// A new folder, at the top or inside another (Products/Orders); the request goes in it.
function bruNewFolderForm(req, x, y) {
  openActionMenu({ x, y, items: [] });
  showMenuForm($('#actionMenu'), {
    title: `Move ${req.name} to a new folder`,
    placeholder: 'Orders',
    aria: 'The new folder',
    button: 'Create and move',
    extra: () => bruEl('div', 'action-menu-note', 'A / for one inside another: Products/Orders'),
    submit: async (name, fail) => {
      if (!name.replace(/\//g, '').trim()) return fail('A folder needs a name');
      const r = await bruReqOp('move-new', req, name);
      if (r.error) fail(r.error);
      else closeActionMenu();
    },
  });
}

// Duplicate and Rename ask for a name, in the menu.
function bruReqNameForm(req, x, y, kind) {
  const rename = kind === 'rename';
  openActionMenu({ x, y, items: [] });
  showMenuForm($('#actionMenu'), {
    title: rename ? `Rename ${req.name}` : `Duplicate ${req.name}`,
    value: rename ? req.name : `${req.name} copy`,
    aria: rename ? 'The new name' : 'The name of the copy',
    button: rename ? 'Rename' : 'Duplicate',
    submit: async (name, fail) => {
      if (!name) return fail('A request needs a name');
      if (rename && name === req.name) return closeActionMenu();
      const r = await bruReqOp(kind, req, name);
      if (r.error) fail(r.error);
      else closeActionMenu();
    },
  });
}

// A copy in the app's folder of saved requests; the request here stays as it is.
async function keepBrunoRequest(req) {
  const r = await window.bruno.requestOp(bru.repo, bru.dir, 'keep', req.path);
  if (r.error) return toast(r.error, 'error', { plain: true });
  const where = `saved-requests/${r.kept.split(/[\\/]/).pop()}`;
  toast(r.already ? `${req.name} is saved in QuickDeck already: ${where}` : `${req.name} saved in QuickDeck: ${where}`, 'success', { plain: true });
}

async function openBrunoSavedFolder() {
  const r = await window.bruno.savedFolder();
  if (r.error) toast(r.error, 'error', { plain: true });
}

async function deleteBrunoRequest(req) {
  const dirty = bruDirty(bruState().drafts.get(req.path));
  if (!(await askConfirm(`Delete the request "${req.name}"?\nIts file goes to the Trash.${dirty ? ' Its changes not saved go with it.' : ''}`, { confirm: 'Delete' }))) return;
  await bruReqOp('delete', req);
}

async function bruReqOp(kind, req, arg) {
  const st = bruState();
  const list = bruRequests();
  const at = list.findIndex((r) => r.path === req.path);
  const r = await window.bruno.requestOp(bru.repo, bru.dir, kind, req.path, arg);
  if (r.error) {
    if (kind === 'move' || kind === 'delete') toast(r.error, 'error', { plain: true });
    return r;
  }
  const to = r.path;
  if (kind === 'delete') {
    st.results.delete(req.path);
    st.drafts.delete(req.path);
    // the next one in the list is chosen in its place
    if (st.selected === req.path) st.selected = (list[at + 1] || list[at - 1] || {}).path || null;
  } else if (kind === 'duplicate') st.selected = to;
  else {
    if (st.results.has(req.path)) st.results.set(to, st.results.get(req.path));
    st.results.delete(req.path);
    st.drafts.delete(req.path);
    if (st.selected === req.path) st.selected = to;
  }
  // where it went is open
  if (to) for (let f = bruFolderOf(to); f; f = bruFolderOf(f)) st.closed.delete(f);
  await reloadBrunoTree();
  if (kind === 'delete') toast(`${req.name} is in the Trash`, 'success', { plain: true });
  else if (kind === 'move') toast(`${req.name} moved to ${(bruFolders().find((f) => f.path === arg) || {}).label || 'the top'}`, 'success', { plain: true });
  else if (kind === 'move-new') toast(`${req.name} moved to the new folder ${arg.split('/').map((p) => p.trim()).filter(Boolean).join(' / ')}`, 'success', { plain: true });
  else toast(kind === 'rename' ? `Renamed to ${arg}` : `${arg}: a copy of ${req.name}`, 'success', { plain: true });
  const row = [...$$('#bruTree .bru-req')].find((el) => el.dataset.path === st.selected);
  if (row) {
    row.scrollIntoView({ block: 'nearest' });
    row.focus();
  }
  return r;
}
