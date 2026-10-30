const fs = require('fs');
const crypto = require('crypto');

// 'endpoint' is no longer offered in the UI but existing items are still read and saved.
const TYPES = ['credential', 'link', 'db', 'endpoint', 'note'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const DB_ENGINES = ['postgresql', 'mysql', 'mariadb', 'oracle', 'sqlserver', 'mongodb', 'redis', 'other'];
const LIMITS = { name: 60, baseUrl: 300, title: 120, username: 200, password: 500, url: 1000, notes: 5000, host: 255, database: 200, attrName: 60, attrValue: 1000, attrs: 100, importRows: 5000 };

const clip = (v, max) => String(v ?? '').trim().slice(0, max);
// Items with no environment (a link for every environment, say) are kept in an environment of their own, which the
// window does not list as one.
const NO_ENV = 'no-environment';
function noEnv(d) {
  let env = d.environments.find((e) => e.generic);
  if (!env) {
    env = { id: NO_ENV, name: '', baseUrl: '', items: [], generic: true };
    d.environments.push(env);
  }
  return env;
}
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function webUrl(value, label) {
  let u = clip(value, LIMITS.url);
  if (!u) return '';
  if (!HAS_SCHEME.test(u)) u = `https://${u}`;
  if (!/^https?:\/\//i.test(u)) throw new Error(`${label} must start with http:// or https://`);
  return u;
}

class Vault {
  constructor(file, codec) {
    this.file = file;
    this.codec = codec;
    this.data = { environments: [] };
    this.loadError = null;
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(this.codec.decrypt(fs.readFileSync(this.file)));
      if (!parsed || !Array.isArray(parsed.environments)) throw new Error('Unexpected vault format');
      this.data = parsed;
    } catch (e) {
      this.loadError = e.message;
    }
  }

  status() {
    return { encryption: this.codec.available(), loadError: this.loadError };
  }

  save() {
    if (this.loadError) {
      throw new Error(`The existing vault could not be read, so saving is disabled to protect it (${this.loadError}).`);
    }
    if (!this.codec.available()) throw new Error('Encryption is not available on this system, so nothing was saved.');
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, this.codec.encrypt(JSON.stringify(this.data, null, 2)));
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    fs.renameSync(tmp, this.file);
  }

  mutate(fn) {
    const before = this.data;
    const draft = JSON.parse(JSON.stringify(before));
    const result = fn(draft);
    this.data = draft;
    try {
      this.save();
    } catch (e) {
      this.data = before;
      throw e;
    }
    return result;
  }

  view() {
    return {
      environments: this.data.environments.map((env) => ({
        id: env.id,
        name: env.name,
        baseUrl: env.baseUrl,
        ...(env.generic && { generic: true }),
        items: env.items.map(({ password, ...rest }) => ({ ...rest, hasPassword: Boolean(password) })),
      })),
      ...this.status(),
    };
  }

  saveEnv({ id, name, baseUrl }) {
    return this.mutate((d) => {
      const n = clip(name, LIMITS.name);
      if (!n) throw new Error('Environment name is required');
      if (d.environments.some((e) => !e.generic && e.id !== id && e.name.toLowerCase() === n.toLowerCase())) {
        throw new Error('An environment with this name already exists');
      }
      const base = baseUrl ? webUrl(baseUrl, 'Base URL').slice(0, LIMITS.baseUrl) : '';
      if (id) {
        const env = d.environments.find((e) => e.id === id && !e.generic);
        if (!env) throw new Error('Environment not found');
        env.name = n;
        env.baseUrl = base;
        return { id };
      }
      const env = { id: crypto.randomUUID(), name: n, baseUrl: base, items: [] };
      d.environments.push(env);
      return { id: env.id };
    });
  }

  deleteEnv(id) {
    return this.mutate((d) => {
      const before = d.environments.length;
      d.environments = d.environments.filter((e) => e.id !== id || e.generic);
      if (d.environments.length === before) throw new Error('Environment not found');
      return { success: true };
    });
  }

  saveItem(p) {
    return this.mutate((d) => {
      const env = !p.envId || p.envId === NO_ENV ? noEnv(d) : d.environments.find((e) => e.id === p.envId);
      if (!env) throw new Error('Environment not found');
      if (!TYPES.includes(p.type)) throw new Error('Unknown item type');

      const item = { type: p.type, title: clip(p.title, LIMITS.title), notes: clip(p.notes, LIMITS.notes) };
      if (p.type === 'credential') {
        item.username = clip(p.username, LIMITS.username);
        item.password = String(p.password ?? '').slice(0, LIMITS.password);
        item.url = webUrl(p.url, 'URL');
        if (!item.username && !item.password) throw new Error('Enter a username or a password');
      } else {
        if (!item.title) throw new Error('Title is required');
        if (p.type === 'link') {
          item.url = webUrl(p.url, 'URL');
          if (!item.url) throw new Error('URL is required');
          item.username = clip(p.username, LIMITS.username);
          item.password = String(p.password ?? '').slice(0, LIMITS.password);
        } else if (p.type === 'db') {
          item.engine = DB_ENGINES.includes(p.engine) ? p.engine : 'other';
          item.host = clip(p.host, LIMITS.host);
          const port = clip(p.port, 5);
          if (port && !/^\d+$/.test(port)) throw new Error('Port must be a number');
          if (port && (Number(port) < 1 || Number(port) > 65535)) throw new Error('Port must be between 1 and 65535');
          item.port = port ? Number(port) : null;
          item.database = clip(p.database, LIMITS.database);
          item.username = clip(p.username, LIMITS.username);
          item.password = String(p.password ?? '').slice(0, LIMITS.password);
          item.url = clip(p.url, LIMITS.url);
          if (!item.host && !item.url) throw new Error('Enter a host or a connection URL');
        } else if (p.type === 'endpoint') {
          item.method = METHODS.includes(p.method) ? p.method : 'GET';
          let u = clip(p.url, LIMITS.url);
          if (!u) throw new Error('Path or URL is required');
          if (HAS_SCHEME.test(u)) u = webUrl(u, 'URL');
          else if (!u.startsWith('/')) u = `/${u}`;
          item.url = u;
        } else if (!item.notes) {
          throw new Error('Write the note text');
        }
      }

      if (p.id) {
        const index = env.items.findIndex((i) => i.id === p.id);
        if (index === -1) throw new Error('Item not found');
        // An edit keeps the star and the attributes of an import: the item dialog sends neither.
        const old = env.items[index];
        env.items[index] = { ...item, id: p.id, ...(old.favorite && { favorite: true }), ...(old.attributes && { attributes: old.attributes }) };
        return { id: p.id };
      }
      item.id = crypto.randomUUID();
      env.items.push(item);
      return { id: item.id };
    });
  }

  // Users from a sheet (Import), into one environment: one with the same name there (its label, else its username)
  // gets the new username, password and attributes; the others are added. A row with no username and no password is
  // skipped. Attributes are the other columns of the sheet: [{ name, value }], shown when the user is opened.
  importUsers(envId, users) {
    const list = (Array.isArray(users) ? users : []).slice(0, LIMITS.importRows);
    return this.mutate((d) => {
      const env = !envId || envId === NO_ENV ? noEnv(d) : d.environments.find((e) => e.id === envId);
      if (!env) throw new Error('Environment not found');
      const nameOf = (i) => (i.title || i.username || '').toLowerCase();
      let added = 0;
      let updated = 0;
      let skipped = 0;
      for (const u of list) {
        const title = clip(u && u.title, LIMITS.title);
        const username = clip(u && u.username, LIMITS.username);
        const password = String((u && u.password) ?? '').slice(0, LIMITS.password);
        if (!username && !password) {
          skipped++;
          continue;
        }
        const attributes = (Array.isArray(u.attributes) ? u.attributes : [])
          .map((a) => ({ name: clip(a && a.name, LIMITS.attrName), value: clip(a && a.value, LIMITS.attrValue) }))
          .filter((a) => a.name && a.value)
          .slice(0, LIMITS.attrs);
        const name = (title || username).toLowerCase();
        const same = env.items.find((i) => i.type === 'credential' && nameOf(i) === name);
        if (same) {
          Object.assign(same, { title, username, password });
          if (attributes.length) same.attributes = attributes;
          else delete same.attributes;
          updated++;
        } else {
          env.items.push({ type: 'credential', title, notes: '', username, password, url: '', ...(attributes.length && { attributes }), id: crypto.randomUUID() });
          added++;
        }
      }
      return { added, updated, skipped };
    });
  }

  setFavorite(id, on) {
    return this.mutate((d) => {
      for (const env of d.environments) {
        const item = env.items.find((i) => i.id === id);
        if (item) {
          if (on) item.favorite = true;
          else delete item.favorite;
          return { success: true };
        }
      }
      throw new Error('Item not found');
    });
  }

  deleteItem(id) {
    return this.mutate((d) => {
      for (const env of d.environments) {
        const index = env.items.findIndex((i) => i.id === id);
        if (index !== -1) {
          env.items.splice(index, 1);
          return { success: true };
        }
      }
      throw new Error('Item not found');
    });
  }

  // Several items at once (Delete all of a section), in one save; the ones not found are counted, not an error.
  deleteItems(ids) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
    if (!wanted.size) throw new Error('Nothing to delete');
    return this.mutate((d) => {
      let deleted = 0;
      for (const env of d.environments) {
        const before = env.items.length;
        env.items = env.items.filter((i) => !wanted.has(i.id));
        deleted += before - env.items.length;
      }
      return { success: true, deleted };
    });
  }

  // What "Open and sign in" needs: the web address and the login of a link or credential.
  signInFor(id) {
    for (const env of this.data.environments) {
      const item = env.items.find((i) => i.id === id);
      if (!item) continue;
      if (!['link', 'credential'].includes(item.type) || !/^https?:\/\//i.test(item.url || '')) throw new Error('This item has no web address to sign in to');
      if (!item.username && !item.password) throw new Error('This item has no username or password to fill in');
      return { title: item.title || '', url: item.url, username: item.username || '', password: item.password || '' };
    }
    throw new Error('Item not found');
  }

  getSecret(id) {
    for (const env of this.data.environments) {
      const item = env.items.find((i) => i.id === id);
      if (item) return item.password || '';
    }
    throw new Error('Item not found');
  }
}

// The users of a sheet: the first three columns are the name, the username and the password, the others attributes,
// named by the first row when it is a header ("Name", "Username", "Password"...; else "Column D", "Column E"...).
const HEADER_WORDS = new Set(['name', 'nome', 'user', 'username', 'user name', 'utilizador', 'login', 'password', 'pass', 'pwd', 'senha', 'palavra-passe', 'palavra passe']);
const columnName = (i) => (i < 26 ? '' : String.fromCharCode(64 + Math.floor(i / 26))) + String.fromCharCode(65 + (i % 26));

function usersFromRows(rows) {
  const head = rows[0] || [];
  const header = head.slice(0, 3).some((c) => HEADER_WORDS.has(String(c).trim().toLowerCase()));
  const body = header ? rows.slice(1) : rows;
  const width = Math.max(0, ...rows.map((r) => r.length));
  const attributes = [];
  for (let i = 3; i < width; i++) attributes.push((header && head[i]) || `Column ${columnName(i)}`);
  const all = body.map((r) => ({
    title: r[0] || '',
    username: r[1] || '',
    password: r[2] || '',
    attributes: attributes.map((name, i) => ({ name, value: r[i + 3] || '' })).filter((a) => a.value),
  }));
  const users = all.filter((u) => u.username || u.password);
  return { header, attributes, users, skipped: all.length - users.length };
}

module.exports = { Vault, TYPES, METHODS, DB_ENGINES, NO_ENV, usersFromRows };
