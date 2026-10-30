// Groups of the repository list: named, in the user's order, each one folded or open. A repository belongs to one
// group at most; the others show under "Other". Saved in the settings as repoGroups and repoGroupOf (path key -> id).
const crypto = require('crypto');

const LIMITS = { name: 40, count: 50 };

class RepoGroups {
  constructor(store) {
    this.store = store;
  }

  list() {
    const raw = this.store.get('repoGroups', []);
    const seen = new Set();
    return (Array.isArray(raw) ? raw : [])
      .filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string' && g.name.trim() && !seen.has(g.id) && seen.add(g.id))
      .map((g) => ({ id: g.id, name: g.name.trim().slice(0, LIMITS.name), collapsed: g.collapsed === true }));
  }

  // path key -> group id, only for groups that still exist
  members() {
    const ids = new Set(this.list().map((g) => g.id));
    const raw = this.store.get('repoGroupOf', {});
    return Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {}).filter(([, id]) => ids.has(id)));
  }

  cleanName(name, exceptId = null) {
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('Type a name for the group');
    if (clean.length > LIMITS.name) throw new Error(`The name is too long (${LIMITS.name} characters at most)`);
    if (this.list().some((g) => g.id !== exceptId && g.name.toLowerCase() === clean.toLowerCase())) throw new Error(`There is already a group called "${clean}"`);
    return clean;
  }

  find(list, id) {
    const i = list.findIndex((g) => g.id === id);
    if (i === -1) throw new Error('That group is no longer there');
    return i;
  }

  create(name) {
    const list = this.list();
    if (list.length >= LIMITS.count) throw new Error(`You already have ${LIMITS.count} groups`);
    const group = { id: crypto.randomUUID(), name: this.cleanName(name), collapsed: false };
    this.store.set('repoGroups', [...list, group]);
    return group;
  }

  rename(id, name) {
    const list = this.list();
    const i = this.find(list, id);
    list[i] = { ...list[i], name: this.cleanName(name, id) };
    this.store.set('repoGroups', list);
    return list[i];
  }

  // The repositories of a deleted group go back to "Other"; they stay in the list.
  delete(id) {
    const list = this.list();
    this.find(list, id);
    this.store.set('repoGroups', list.filter((g) => g.id !== id));
    this.store.set('repoGroupOf', Object.fromEntries(Object.entries(this.members()).filter(([, g]) => g !== id)));
    return true;
  }

  move(id, delta) {
    const list = this.list();
    const i = this.find(list, id);
    const j = Math.max(0, Math.min(list.length - 1, i + (delta < 0 ? -1 : 1)));
    if (i !== j) {
      [list[i], list[j]] = [list[j], list[i]];
      this.store.set('repoGroups', list);
    }
    return true;
  }

  setCollapsed(id, collapsed) {
    const list = this.list();
    const i = this.find(list, id);
    list[i] = { ...list[i], collapsed: collapsed === true };
    this.store.set('repoGroups', list);
    return true;
  }

  // id null or '' takes the repository out of its group.
  assign(key, id) {
    const members = this.members();
    if (id) {
      this.find(this.list(), id);
      members[key] = id;
    } else {
      delete members[key];
    }
    this.store.set('repoGroupOf', members);
    return true;
  }

  forget(key) {
    const members = this.members();
    if (!(key in members)) return;
    delete members[key];
    this.store.set('repoGroupOf', members);
  }
}

module.exports = { RepoGroups, LIMITS };
