// Tasks view: a plain list with a round checkbox, the title, a description below it and a star.
// Relies on helpers from app.js and vault.js ($, toast, noteEl, vEl, vIconBtn, setIcon, ICONS).
Object.assign(ICONS, {
  check: '<path d="M3.5 8.4l3 3L12.5 5"/>',
  star: '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
});

let todoTasks = [];
// Kept for the saved window state from older versions; the simple view has no lists.
let todoList = null;
let todoEditId = null;

const isDone = (t) => t.status === 'done';

async function refreshTodos() {
  let data;
  try {
    data = await window.todos.get();
  } catch (e) {
    data = { error: e.message };
  }
  if (data.error) {
    toast(data.error, 'error');
    return;
  }
  todoTasks = data.tasks;
  renderTodo();
}

// Open tasks first (starred on top, newest first), then the finished ones, most recently finished first.
function sortedTasks() {
  const open = todoTasks
    .filter((t) => !isDone(t))
    .sort((a, b) => Number(Boolean(b.starred)) - Number(Boolean(a.starred)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const done = todoTasks.filter(isDone).sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
  return { open, done };
}

function renderTodo() {
  const box = $('#taskList');
  const top = box.scrollTop;
  box.textContent = '';
  const { open, done } = sortedTasks();
  if (todoTasks.length === 0) box.appendChild(noteEl('No tasks yet. Type one above and press Enter.'));
  else if (open.length === 0) box.appendChild(noteEl('Everything is done.'));
  open.forEach((t) => box.appendChild(createTaskRow(t)));
  if (done.length > 0) {
    box.appendChild(vEl('div', 'task-section', `Done (${done.length})`));
    done.forEach((t) => box.appendChild(createTaskRow(t)));
  }
  box.scrollTop = top;
  updateCrumb();
}

async function saveTaskFields(id, fields) {
  const r = await window.todos.save({ id, ...fields });
  if (r.error) toast(r.error, 'error');
  await refreshTodos();
}

async function setTaskDone(t, done) {
  const r = await window.todos.move(t.id, done ? 'done' : 'backlog');
  if (r.error) toast(r.error, 'error');
  await refreshTodos();
}

async function deleteTask(t) {
  if (!(await window.git.confirm(`Delete "${t.title}"?`))) return false;
  const r = await window.todos.remove(t.id);
  if (r.error) toast(r.error, 'error');
  await refreshTodos();
  return !r.error;
}

function createTaskRow(t) {
  const done = isDone(t);
  const row = vEl('div', `task-row${done ? ' done' : ''}`);
  row.title = 'Click to edit';

  const check = vEl('button', 'task-check');
  check.type = 'button';
  check.title = done ? 'Mark as not done' : 'Mark as done';
  check.setAttribute('aria-label', check.title);
  check.setAttribute('aria-pressed', String(done));
  setIcon(check, 'check');
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    setTaskDone(t, !done);
  });

  const body = vEl('div', 'task-body');
  body.appendChild(vEl('div', 'task-title', t.title));
  if (t.description) body.appendChild(vEl('div', 'task-desc', t.description));

  const remove = vIconBtn('trash', 'Delete', (e) => {
    e.stopPropagation();
    deleteTask(t);
  }, 'danger task-delete');
  const star = vIconBtn('star', t.starred ? 'Remove the star' : 'Star it to keep it at the top', (e) => {
    e.stopPropagation();
    saveTaskFields(t.id, { starred: !t.starred });
  }, `task-star${t.starred ? ' starred' : ''}`);
  star.setAttribute('aria-pressed', String(Boolean(t.starred)));

  row.append(check, body, remove, star);
  row.addEventListener('click', () => openTodoDialog(t));
  return row;
}

// -- Quick add at the top --
async function addTask() {
  const title = $('#taskTitle');
  const desc = $('#taskDesc');
  if (!title.value.trim()) {
    title.focus();
    return;
  }
  const r = await window.todos.save({ title: title.value, description: desc.value });
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  title.value = '';
  desc.value = '';
  await refreshTodos();
  title.focus();
}

// -- Edit dialog --
function openTodoDialog(t) {
  todoEditId = t.id;
  $('#todoEditTitle').value = t.title;
  $('#todoEditDesc').value = t.description || '';
  $('#todoModal').classList.remove('hidden');
  $('#todoEditTitle').focus();
}

function closeTodoDialog() {
  $('#todoModal').classList.add('hidden');
  todoEditId = null;
}

async function saveTodoDialog() {
  if (!todoEditId) return;
  const r = await window.todos.save({ id: todoEditId, title: $('#todoEditTitle').value, description: $('#todoEditDesc').value });
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  closeTodoDialog();
  await refreshTodos();
}

function setupTodo() {
  if (CARD_ID) return;
  $('#taskAddBtn').addEventListener('click', addTask);
  ['#taskTitle', '#taskDesc'].forEach((sel) =>
    $(sel).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTask();
      }
    })
  );
  $('#todoCancelBtn').addEventListener('click', closeTodoDialog);
  $('#todoSaveBtn').addEventListener('click', saveTodoDialog);
  $('#todoDeleteBtn').addEventListener('click', async () => {
    const t = todoTasks.find((x) => x.id === todoEditId);
    if (t && (await deleteTask(t))) closeTodoDialog();
  });
  $('#todoModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTodoDialog();
    // Enter saves from the title; in the description it adds a new line, and Ctrl/Cmd+Enter saves.
    else if (e.key === 'Enter' && (e.target.id === 'todoEditTitle' || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveTodoDialog();
    }
  });
}

setupTodo();
