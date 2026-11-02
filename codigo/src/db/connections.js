// -- The PostgreSQL connections of the Database page, in data/db-connections.json. A password is kept encrypted by the
// system (safeStorage: the macOS Keychain, Windows DPAPI) and never goes to the page: it only knows there is one. --
const fs = require('fs');
const crypto = require('crypto');

const SSL = new Set(['disable', 'require', 'no-verify']);
const NAME = /^[^\u0000-\u001f]{1,60}$/;
const HOST = /^[A-Za-z0-9._:-]{1,255}$/;
const PG_NAME = /^[^\u0000-\u001f]{1,63}$/;

class DbConnections {
  constructor(file, safeStorage) {
    this.file = file;
    this.safe = safeStorage;
  }

  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data.connections) ? data.connections : [];
    } catch {
      return [];
    }
  }

  write(list) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ connections: list }, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  // What the page sees of each: no password, only whether there is one.
  list() {
    return this.read().map(({ passwordEnc, ...c }) => ({ ...c, hasPassword: Boolean(passwordEnc) }));
  }

  // One, with its password, for the main process to connect with.
  get(id) {
    const c = this.read().find((x) => x.id === String(id));
    if (!c) throw new Error('That connection is not there any more');
    const { passwordEnc, ...rest } = c;
    return { ...rest, password: passwordEnc ? this.safe.decryptString(Buffer.from(passwordEnc, 'base64')) : '' };
  }

  // The fields of the form, checked; a password typed replaces the one kept, an empty one keeps it, clearPassword
  // drops it. Returns the connection as the page sees it.
  save(input = {}) {
    const fields = clean(input);
    const list = this.read();
    const at = input.id ? list.findIndex((x) => x.id === String(input.id)) : -1;
    if (input.id && at < 0) throw new Error('That connection is not there any more');
    if (list.some((x, i) => i !== at && x.name.toLowerCase() === fields.name.toLowerCase())) throw new Error(`There is a connection called ${fields.name} already`);
    const old = at >= 0 ? list[at] : null;
    let passwordEnc = old ? old.passwordEnc || null : null;
    if (input.clearPassword) passwordEnc = null;
    if (typeof input.password === 'string' && input.password) passwordEnc = this.encrypt(input.password);
    const item = { id: old ? old.id : crypto.randomUUID(), ...fields, ...(passwordEnc ? { passwordEnc } : {}) };
    if (at >= 0) list[at] = item;
    else list.push(item);
    this.write(list);
    const { passwordEnc: _, ...shown } = item;
    return { ...shown, hasPassword: Boolean(passwordEnc) };
  }

  remove(id) {
    const list = this.read();
    if (!list.some((x) => x.id === String(id))) throw new Error('That connection is not there any more');
    this.write(list.filter((x) => x.id !== String(id)));
  }

  // The form before it is saved, to test: its password, else the one kept for it.
  resolve(input = {}) {
    const fields = clean(input);
    let password = typeof input.password === 'string' ? input.password : '';
    if (!password && input.id && !input.clearPassword) {
      try {
        password = this.get(input.id).password;
      } catch {
        password = '';
      }
    }
    return { ...fields, password };
  }

  encrypt(text) {
    if (!this.safe || !this.safe.isEncryptionAvailable()) throw new Error('This computer cannot keep a password safely: leave it empty');
    return this.safe.encryptString(text).toString('base64');
  }
}

function clean(input) {
  const name = String(input.name || '').trim();
  const host = String(input.host || '').trim();
  const port = Number(input.port || 5432);
  const database = String(input.database || '').trim();
  const user = String(input.user || '').trim();
  const ssl = SSL.has(input.ssl) ? input.ssl : 'disable';
  if (!NAME.test(name)) throw new Error('Give the connection a name (up to 60 characters)');
  if (!HOST.test(host)) throw new Error('The host: a name or an address, as localhost or db.example.com');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The port: a number from 1 to 65535 (PostgreSQL: 5432)');
  if (!PG_NAME.test(database)) throw new Error('The database: its name');
  if (!PG_NAME.test(user)) throw new Error('The user: the name to connect as');
  return { name, host, port, database, user, ssl };
}

module.exports = { DbConnections };
