// -- The tree: folders (open or closed, ▶ sends what is in them) and requests (method, name, how it went; a right click:
// req-menu.js) --
function bruResultMark(result, queued) {
  if (queued) return { cls: 'queued', text: '\u2026', title: 'Waiting for its turn in this run' };
  if (!result) return null;
  const code = result.response && typeof result.response.status === 'number' ? result.response.status : null;
  if (result.status === 'skipped') return { cls: 'skipped', text: 'skipped', title: 'Skipped by a script' };
  if (result.status === 'pass') return { cls: 'pass', text: code ? String(code) : '\u2713', title: 'Passed: every check came true' };
  return { cls: 'fail', text: code || 'error', title: result.error || 'Failed: a check did not come true' };
}

function renderBrunoTree() {
  const box = $('#bruTree');
  const had = box.contains(document.activeElement) ? document.activeElement.dataset.path : null;
  box.innerHTML = '';
  const st = bruState();
  const queued = bru.run && bru.run.dir === bru.dir ? bru.run.queued : new Set();
  if (!bru.tree.length) box.appendChild(bruEl('div', 'list-note', 'No requests in this collection.'));
  const draw = (items, depth) => {
    for (const it of items) {
      if (it.type === 'folder') {
        const open = !st.closed.has(it.path);
        const reqs = bruRequests(it.items);
        const done = reqs.map((r) => st.results.get(r.path)).filter(Boolean);
        const failed = done.filter((r) => r.status !== 'pass' && r.status !== 'skipped').length;
        const row = bruEl('div', `bru-row bru-folder${open ? ' open' : ''}`);
        row.dataset.path = it.path;
        row.dataset.kind = 'folder';
        row.tabIndex = 0;
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-expanded', String(open));
        row.style.setProperty('--depth', String(depth));
        row.innerHTML = '<svg class="dir-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
        row.append(bruEl('span', 'bru-name', it.name));
        if (done.length) {
          const tally = bruEl('span', `bru-tally${failed ? ' fail' : ' pass'}`, failed ? `${failed} failed` : `${done.length}/${reqs.length}`);
          tally.title = failed ? `${failed} of the ${done.length} sent failed` : `${done.length} of ${reqs.length} sent, all passed`;
          row.appendChild(tally);
        }
        // runs the folder; while it runs, stops it
        const mine = Boolean(bru.run && bru.run.dir === bru.dir && bru.run.target === it.path);
        const play = bruEl('button', `bru-play-folder${mine ? ' stop' : ''}`);
        play.type = 'button';
        play.title = mine ? `Stop the run of ${it.name}` : `Send the ${reqs.length} request${reqs.length !== 1 ? 's' : ''} of ${it.name}, in order`;
        play.setAttribute('aria-label', `${mine ? 'Stop' : 'Run'} ${it.name}`);
        play.innerHTML = mine ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13 -8z"/></svg>';
        play.disabled = (Boolean(bru.run) && !mine) || (bru.cli && !bru.cli.ok);
        play.addEventListener('click', (e) => {
          e.stopPropagation();
          if (mine) bruStop();
          else bruRun(it.path, it.name);
        });
        row.appendChild(play);
        row.addEventListener('click', () => bruToggle(it.path));
        box.appendChild(row);
        if (open) draw(it.items, depth + 1);
      } else {
        const result = st.results.get(it.path);
        const row = bruEl('div', `bru-row bru-req${st.selected === it.path ? ' selected' : ''}`);
        row.dataset.path = it.path;
        row.dataset.kind = 'request';
        row.tabIndex = 0;
        row.setAttribute('role', 'treeitem');
        row.style.setProperty('--depth', String(depth));
        row.title = `${it.method} ${it.url}`;
        row.append(bruEl('span', `bru-method m-${it.method.toLowerCase()}`, it.method === 'DELETE' ? 'DEL' : it.method), bruEl('span', 'bru-name', it.name));
        // changed here, not saved: a dot
        if (bruDirty(st.drafts.get(it.path))) row.classList.add('dirty');
        row.appendChild(bruEl('span', 'bru-dot', '\u2022')).title = 'Changed, not saved';
        const mark = bruResultMark(result, queued.has(it.path));
        if (mark) {
          const m = bruEl('span', `bru-mark ${mark.cls}`, mark.text);
          m.title = mark.title;
          row.appendChild(m);
        }
        row.addEventListener('click', () => bruSelect(it.path));
        row.addEventListener('dblclick', () => bruSend());
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openBrunoReqMenu(it, e.clientX, e.clientY);
        });
        box.appendChild(row);
      }
    }
  };
  draw(bru.tree, 0);
  if (had) {
    const back = [...box.querySelectorAll('.bru-row')].find((r) => r.dataset.path === had);
    if (back) back.focus();
  }
}

function bruToggle(path) {
  const st = bruState();
  if (st.closed.has(path)) st.closed.delete(path);
  else st.closed.add(path);
  renderBrunoTree();
}

function bruSelect(rel) {
  const st = bruState();
  if (st.selected === rel) return;
  st.selected = rel;
  $$('#bruTree .bru-req').forEach((r) => r.classList.toggle('selected', r.dataset.path === rel));
  loadBrunoDetail();
}

// Up and down through the rows; Left and Right close and open a folder (Left on a request: to its folder); Enter on a
// request sends it, on a folder opens or closes it; the menu key (or Shift+F10) on a request opens its menu.
function onBrunoTreeKey(e) {
  const row = e.target.closest('.bru-row');
  if (!row || e.target !== row) return;
  const rows = [...$$('#bruTree .bru-row')];
  const at = rows.indexOf(row);
  const folder = row.dataset.kind === 'folder';
  const go = (r) => {
    if (!r) return;
    r.focus();
    if (r.dataset.kind === 'request') bruSelect(r.dataset.path);
  };
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    go(rows[at + (e.key === 'ArrowDown' ? 1 : -1)]);
  } else if (e.key === 'ArrowRight' && folder) {
    e.preventDefault();
    if (bruState().closed.has(row.dataset.path)) bruToggle(row.dataset.path);
    else go(rows[at + 1]);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (folder && !bruState().closed.has(row.dataset.path)) bruToggle(row.dataset.path);
    else {
      const depth = Number(row.style.getPropertyValue('--depth'));
      const up = rows.slice(0, at).reverse().find((r) => r.dataset.kind === 'folder' && Number(r.style.getPropertyValue('--depth')) < depth);
      if (up) up.focus();
    }
  } else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && !folder) {
    e.preventDefault();
    const req = bruFind(row.dataset.path);
    const r = row.getBoundingClientRect();
    if (req) openBrunoReqMenu(req, r.left + 24, r.bottom);
  } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (folder) bruToggle(row.dataset.path);
    else {
      bruSelect(row.dataset.path);
      bruSend();
    }
  }
}
