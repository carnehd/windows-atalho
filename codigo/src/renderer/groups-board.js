// Manage groups: a board with a column per group (and one for the microservices in none) to create, rename, order and
// delete groups and drag microservices from one to another. Ctrl+click (Cmd+click) picks several, Shift+click a run of
// them; "Move to" moves the picked ones without dragging. Opened from Add ▾ > Manage groups...
// Relies on helpers from app.js ($, $$, toast, repos, repoGroups, displayName, renderSidebar, deleteGroup, ACTION_ICONS,
// IS_MAC, CARD_ID).
const BOARD_DRAG_TYPE = 'application/x-git-quick-board';
let boardPicked = new Set();
let boardAnchor = null;

const boardGroupOf = (r) => (repoGroups.some((g) => g.id === r.group) ? r.group : '');
const boardColumns = () => [{ id: '', name: 'Not in a group' }, ...repoGroups];
const boardWhat = (list) => (list.length === 1 ? `"${displayName(list[0])}"` : `${list.length} microservices`);

function openGroupsBoard() {
  boardPicked = new Set();
  boardAnchor = null;
  $('#groupsFilter').value = '';
  $('#groupsBoard').classList.remove('hidden');
  renderGroupsBoard();
  $('#groupsFilter').focus();
}

function closeGroupsBoard() {
  $('#groupsBoard').classList.add('hidden');
  boardPicked = new Set();
}

// the microservices of a column as shown (the filter applied), in name order
function boardMembers(groupId) {
  const q = $('#groupsFilter').value.trim().toLowerCase();
  return repos
    .filter((r) => boardGroupOf(r) === groupId)
    .filter((r) => !q || [displayName(r), r.path, r.branch || ''].join(' ').toLowerCase().includes(q))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
}

function boardButton(icon, label, onClick, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `groups-icon-btn ${cls}`.trim();
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS[icon] || ''}</svg>`;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function renderGroupsBoard(focusGroup = null) {
  const cols = $('#groupsCols');
  const scroll = cols.scrollLeft;
  cols.textContent = '';
  const columns = boardColumns();
  columns.forEach((g, i) => {
    const all = repos.filter((r) => boardGroupOf(r) === g.id).length;
    const members = boardMembers(g.id);
    const col = document.createElement('section');
    col.className = `groups-col${g.id ? '' : ' groups-col-none'}`;
    col.dataset.group = g.id;
    col.setAttribute('aria-label', `${g.name}, ${all} microservice${all === 1 ? '' : 's'}`);

    const head = document.createElement('div');
    head.className = 'groups-col-head';
    const name = document.createElement('span');
    name.className = 'groups-col-name';
    name.textContent = g.name;
    const count = document.createElement('span');
    count.className = 'groups-col-count';
    count.textContent = String(all);
    head.append(name, count);
    if (g.id) {
      name.title = 'Double-click to rename';
      name.addEventListener('dblclick', () => startBoardRename(g, name));
      const actions = document.createElement('span');
      actions.className = 'groups-col-actions';
      const left = boardButton('up', 'Move this group left', () => moveBoardGroup(g, -1), 'groups-left');
      const right = boardButton('down', 'Move this group right', () => moveBoardGroup(g, 1), 'groups-right');
      left.disabled = i === 1;
      right.disabled = i === columns.length - 1;
      actions.append(left, right, boardButton('rename', 'Rename', () => startBoardRename(g, name)), boardButton('delete', 'Delete the group (its microservices stay, in no group)', () => deleteBoardGroup(g), 'danger'));
      head.appendChild(actions);
    }

    const body = document.createElement('div');
    body.className = 'groups-col-body';
    for (const r of members) body.appendChild(boardCard(r, members));
    if (!members.length) {
      const empty = document.createElement('div');
      empty.className = 'groups-col-empty';
      empty.textContent = all ? 'None matches the filter' : g.id ? 'Drag microservices here' : 'Every microservice is in a group';
      body.appendChild(empty);
    }
    col.append(head, body);
    boardDropTarget(col, g.id);
    cols.appendChild(col);
  });
  cols.scrollLeft = scroll;
  renderBoardPicked();
  if (focusGroup) {
    const col = cols.querySelector(`.groups-col[data-group="${focusGroup}"]`);
    if (col) col.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
}

function boardCard(r, columnMembers) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'groups-item';
  card.dataset.path = r.path;
  card.draggable = true;
  card.title = r.path;
  const name = document.createElement('span');
  name.className = 'groups-item-name';
  name.textContent = displayName(r);
  const sub = document.createElement('span');
  sub.className = 'groups-item-sub';
  sub.textContent = r.isGit === false ? 'Folder (no Git)' : r.branch || '';
  card.append(name, sub);
  card.addEventListener('click', (e) => {
    const p = r.path;
    if (IS_MAC ? e.metaKey : e.ctrlKey) {
      if (boardPicked.has(p)) boardPicked.delete(p);
      else boardPicked.add(p);
      boardAnchor = p;
    } else if (e.shiftKey && boardAnchor && columnMembers.some((x) => x.path === boardAnchor)) {
      const paths = columnMembers.map((x) => x.path);
      const [a, b] = [paths.indexOf(boardAnchor), paths.indexOf(p)].sort((x, y) => x - y);
      paths.slice(a, b + 1).forEach((x) => boardPicked.add(x));
    } else {
      boardPicked = boardPicked.size === 1 && boardPicked.has(p) ? new Set() : new Set([p]);
      boardAnchor = p;
    }
    renderBoardPicked();
  });
  card.addEventListener('dragstart', (e) => {
    // the picked ones go together when the one dragged is one of them
    if (!boardPicked.has(r.path)) {
      boardPicked = new Set([r.path]);
      renderBoardPicked();
    }
    e.dataTransfer.setData(BOARD_DRAG_TYPE, JSON.stringify([...boardPicked]));
    e.dataTransfer.effectAllowed = 'move';
    $$('#groupsCols .groups-item.picked').forEach((c) => c.classList.add('dragging'));
  });
  card.addEventListener('dragend', () => {
    $$('#groupsCols .dragging').forEach((c) => c.classList.remove('dragging'));
    $$('#groupsCols .drop-over').forEach((c) => c.classList.remove('drop-over'));
  });
  return card;
}

function boardDropTarget(col, groupId) {
  const ours = (e) => e.dataTransfer.types.includes(BOARD_DRAG_TYPE);
  col.addEventListener('dragover', (e) => {
    if (!ours(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    col.classList.add('drop-over');
  });
  col.addEventListener('dragleave', (e) => {
    if (!col.contains(e.relatedTarget)) col.classList.remove('drop-over');
  });
  col.addEventListener('drop', (e) => {
    if (!ours(e)) return;
    e.preventDefault();
    col.classList.remove('drop-over');
    let paths = [];
    try {
      paths = JSON.parse(e.dataTransfer.getData(BOARD_DRAG_TYPE));
    } catch {
      return;
    }
    moveToBoardGroup(Array.isArray(paths) ? paths : [], groupId);
  });
}

// The picked ones: marked on their cards, and counted in the bar with "Move to".
function renderBoardPicked() {
  for (const p of [...boardPicked]) if (!repos.some((r) => r.path === p)) boardPicked.delete(p);
  $$('#groupsCols .groups-item').forEach((c) => {
    const on = boardPicked.has(c.dataset.path);
    c.classList.toggle('picked', on);
    c.setAttribute('aria-pressed', String(on));
  });
  const bar = $('#groupsPicked');
  bar.classList.toggle('hidden', boardPicked.size === 0);
  $('#groupsPickedCount').textContent = `${boardPicked.size} picked`;
  const move = $('#groupsMoveTo');
  move.replaceChildren(new Option('Move to...', ''), ...boardColumns().map((g) => new Option(g.name, g.id || '-')));
  const newLabel = $('#groupsNew');
  newLabel.textContent = boardPicked.size ? `+ New group with ${boardPicked.size}` : '+ New group';
}

async function moveToBoardGroup(paths, groupId) {
  const moving = repos.filter((r) => paths.includes(r.path) && boardGroupOf(r) !== groupId);
  if (!moving.length) return;
  for (const r of moving) {
    const result = await window.git.setRepoGroup(r.path, groupId || null);
    if (result.error) {
      toast(result.error, 'error', { plain: true });
      break;
    }
    r.group = groupId || '';
  }
  const g = repoGroups.find((x) => x.id === groupId);
  // the group opens in the list, so they can be seen in it
  if (g && g.collapsed) {
    g.collapsed = false;
    window.git.collapseRepoGroup(g.id, false);
  }
  boardPicked = new Set();
  renderSidebar();
  renderGroupsBoard(groupId);
  toast(g ? `${boardWhat(moving)} moved to ${g.name}` : `${boardWhat(moving)} out of ${moving.length === 1 ? 'its group' : 'their groups'}`, 'success', { plain: true });
}

async function moveBoardGroup(g, delta) {
  const i = repoGroups.indexOf(g);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= repoGroups.length) return;
  const result = await window.git.moveRepoGroup(g.id, delta);
  if (result.error) return toast(result.error, 'error', { plain: true });
  repoGroups.splice(i, 1);
  repoGroups.splice(j, 0, g);
  renderSidebar();
  renderGroupsBoard(g.id);
  const btn = $(`#groupsCols .groups-col[data-group="${g.id}"] ${delta < 0 ? '.groups-left' : '.groups-right'}`);
  if (btn && !btn.disabled) btn.focus();
}

function startBoardRename(g, nameEl) {
  const input = document.createElement('input');
  input.className = 'input groups-rename';
  input.value = g.name;
  input.maxLength = 40;
  input.setAttribute('aria-label', `New name for ${g.name}`);
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value && value !== g.name) {
      const result = await window.git.renameRepoGroup(g.id, value);
      if (result.error) toast(result.error, 'error', { plain: true });
      else g.name = result.name;
      renderSidebar();
    }
    renderGroupsBoard();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

async function deleteBoardGroup(g) {
  await deleteGroup(g);
  renderGroupsBoard();
}

// "+ New group": a name typed in place of the button; the picked microservices go into it.
function newBoardGroup() {
  const btn = $('#groupsNew');
  const form = document.createElement('span');
  form.className = 'groups-new-form';
  const input = document.createElement('input');
  input.className = 'input groups-new-input';
  input.placeholder = 'Payments, Customers...';
  input.maxLength = 40;
  input.setAttribute('aria-label', 'Name of the new group');
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'btn btn-sm btn-primary';
  ok.textContent = 'Create';
  form.append(input, ok);
  btn.classList.add('hidden');
  btn.after(form);
  input.focus();
  const close = () => {
    form.remove();
    btn.classList.remove('hidden');
  };
  const create = async () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    const result = await window.git.createRepoGroup(name);
    if (result.error) {
      toast(result.error, 'error', { plain: true });
      return;
    }
    close();
    repoGroups.push(result);
    const picked = [...boardPicked];
    if (picked.length) await moveToBoardGroup(picked, result.id);
    else {
      renderSidebar();
      renderGroupsBoard(result.id);
      toast(`Group ${result.name} created: drag microservices into it`, 'success', { plain: true });
    }
  };
  ok.addEventListener('click', create);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      create();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      btn.focus();
    }
  });
}

function setupGroupsBoard() {
  const board = $('#groupsBoard');
  if (IS_MAC) $('#groupsHint').textContent = 'Drag microservices from one group to another. Cmd+click picks several, Shift+click a run of them.';
  $('#groupsClose').addEventListener('click', closeGroupsBoard);
  $('#groupsNew').addEventListener('click', newBoardGroup);
  $('#groupsFilter').addEventListener('input', () => renderGroupsBoard());
  $('#groupsMoveTo').addEventListener('change', (e) => {
    const v = e.target.value;
    e.target.value = '';
    if (v) moveToBoardGroup([...boardPicked], v === '-' ? '' : v);
  });
  $('#groupsPickedClear').addEventListener('click', () => {
    boardPicked = new Set();
    renderBoardPicked();
  });
  // Esc lets go of the picked ones first, then closes
  board.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.target.closest('.groups-rename, .groups-new-input')) return;
    e.preventDefault();
    e.stopPropagation();
    if (boardPicked.size) {
      boardPicked = new Set();
      renderBoardPicked();
    } else closeGroupsBoard();
  });
  board.addEventListener('mousedown', (e) => {
    if (e.target === board) closeGroupsBoard();
  });
}

if (!CARD_ID) setupGroupsBoard();
