const crypto = require('crypto');

const STATUSES = ['backlog', 'in_progress', 'in_review', 'done'];
const PRIORITIES = ['high', 'medium', 'low', 'none'];

const clip = (v, max) => String(v ?? '').trim().slice(0, max);

function parseDue(value) {
  const v = clip(value, 10);
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const y = m && Number(m[1]);
  const mo = m && Number(m[2]) - 1;
  const d = m && Number(m[3]);
  const date = m && new Date(y, mo, d);
  if (!m || date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) {
    throw new Error('Invalid due date');
  }
  return v;
}

function parseAssignees(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Set();
  const out = [];
  for (const a of raw) {
    const name = clip(a, 30);
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out.slice(0, 8);
}

// Remembers when a task was finished, so finished tasks can be listed newest first.
function markCompletion(task, previousStatus) {
  if (task.status === 'done' && previousStatus !== 'done') task.completedAt = new Date().toISOString();
  else if (task.status !== 'done') delete task.completedAt;
}

class TodoStore {
  constructor(store) {
    this.store = store;
  }

  tasks() {
    return this.store.get('tasks', []);
  }

  view() {
    return { tasks: this.tasks() };
  }

  nextKey(tasks) {
    let max = 0;
    for (const t of tasks) {
      const m = /^T-(\d+)$/.exec(t.key);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `T-${max + 1}`;
  }

  // Creates a task, or updates only the fields that are sent, so a simple view never wipes fields it does not show.
  saveTask(p) {
    const fields = {};
    if (p.title !== undefined || !p.id) {
      const title = clip(p.title, 200);
      if (!title) throw new Error('Title is required');
      fields.title = title;
    }
    if (p.description !== undefined) fields.description = clip(p.description, 2000);
    if (p.status !== undefined) fields.status = STATUSES.includes(p.status) ? p.status : 'backlog';
    if (p.priority !== undefined) fields.priority = PRIORITIES.includes(p.priority) ? p.priority : 'none';
    if (p.list !== undefined) fields.list = clip(p.list, 40);
    if (p.due !== undefined) fields.due = parseDue(p.due);
    if (p.assignees !== undefined) fields.assignees = parseAssignees(p.assignees);
    if (p.starred !== undefined) fields.starred = Boolean(p.starred);
    const key = p.key === undefined ? undefined : clip(p.key, 30);
    const tasks = JSON.parse(JSON.stringify(this.tasks()));

    if (p.id) {
      const i = tasks.findIndex((t) => t.id === p.id);
      if (i === -1) throw new Error('Task not found');
      const updated = { ...tasks[i], ...fields, key: key || tasks[i].key };
      markCompletion(updated, tasks[i].status);
      tasks[i] = updated;
      this.store.set('tasks', tasks);
      return { id: p.id };
    }

    const task = {
      id: crypto.randomUUID(),
      key: key || this.nextKey(tasks),
      title: fields.title,
      description: '',
      status: 'backlog',
      priority: 'none',
      list: '',
      due: '',
      assignees: [],
      starred: false,
      ...fields,
      createdAt: new Date().toISOString(),
    };
    markCompletion(task, null);
    tasks.push(task);
    this.store.set('tasks', tasks);
    return { id: task.id };
  }

  deleteTask(id) {
    const tasks = this.tasks();
    const next = tasks.filter((t) => t.id !== id);
    if (next.length === tasks.length) throw new Error('Task not found');
    this.store.set('tasks', next);
    return { success: true };
  }

  moveTask(id, status) {
    if (!STATUSES.includes(status)) throw new Error('Unknown status');
    const tasks = JSON.parse(JSON.stringify(this.tasks()));
    const i = tasks.findIndex((t) => t.id === id);
    if (i === -1) throw new Error('Task not found');
    if (tasks[i].status !== status) {
      const before = tasks[i].status;
      tasks[i].status = status;
      markCompletion(tasks[i], before);
      this.store.set('tasks', tasks);
    }
    return { success: true };
  }
}

module.exports = { TodoStore, STATUSES, PRIORITIES };
