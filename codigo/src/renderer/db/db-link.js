// -- A connection given as a link, read into the fields of the form: postgresql://user:password@host:5432/database,
// the same with jdbc: in front (as Spring has it), or as libpq and .NET write it (host=… port=… dbname=… user=…).
// And the fields written back as a link, never with the password in it. --

// sslmode as libpq means it: require encrypts and does not check the certificate; verify-ca and verify-full check it
const DB_SSLMODE = { disable: 'disable', allow: 'disable', prefer: 'disable', require: 'no-verify', verifyca: 'require', verifyfull: 'require' };
const DB_LINK_SSL = { require: 'verify-full', 'no-verify': 'require' };
// the names a field goes by (lower case, no spaces, dashes or underscores)
const DB_LINK_KEYS = {
  host: 'host', server: 'host', hostaddr: 'host',
  port: 'port',
  dbname: 'database', database: 'database', initialcatalog: 'database',
  user: 'user', username: 'user', userid: 'user', uid: 'user',
  password: 'password', pwd: 'password',
  sslmode: 'sslmode', ssl: 'ssl',
};

const dbDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// { host, port, database, user, password (null: not in the link), ssl, kind, unused: [names not used] }; or throws
// saying what is wrong with it.
function parseDbLink(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('Paste a link: postgresql://user:password@host:5432/database');
  const url = s.match(/^(jdbc:)?postgres(?:ql)?:\/\/(.*)$/is);
  const got = url ? dbFromUrl(url[2]) : /^[\w ]+=/.test(s) ? dbFromPairs(s) : null;
  if (!got) throw new Error('Not a PostgreSQL link: it starts with postgresql:// (or jdbc:postgresql://)');
  const c = { host: 'localhost', port: 5432, database: '', user: '', password: null, ssl: 'disable', kind: url ? (url[1] ? 'jdbc' : 'url') : 'pairs', unused: [] };
  let sslmode = null;
  let ssl = null;
  for (const [key, value] of got) {
    const field = DB_LINK_KEYS[key.toLowerCase().replace(/[\s_-]/g, '')];
    if (field === 'sslmode') sslmode = value.toLowerCase().replace(/[\s_-]/g, '');
    else if (field === 'ssl') ssl = value.toLowerCase();
    else if (field === 'port') c.port = Number(value);
    else if (field === 'password') c.password = value;
    else if (field) c[field] = value;
    else if (key) c.unused.push(key);
  }
  if (sslmode) {
    if (!(sslmode in DB_SSLMODE)) throw new Error(`sslmode ${sslmode}: it is disable, prefer, require, verify-ca or verify-full`);
    c.ssl = DB_SSLMODE[sslmode];
  } else if (ssl) c.ssl = ['true', '1', 'yes', 'on'].includes(ssl) ? 'require' : 'disable'; // JDBC's ssl=true checks the certificate
  if (c.host.includes(',')) throw new Error('One host only: the link has several');
  if (c.host.startsWith('/')) throw new Error('A socket folder is not a host here: give a name or an address');
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new Error('The port in the link: a number from 1 to 65535');
  return c;
}

// [key, value] in the order the link has them: those of the address, then those after ?.
function dbFromUrl(rest) {
  const end = rest.search(/[?#]/);
  const head = end < 0 ? rest : rest.slice(0, end);
  const query = end < 0 || rest[end] === '#' ? '' : rest.slice(end + 1).split('#')[0];
  const at = head.lastIndexOf('@'); // a password with an @ not written as %40 still reads
  const who = at < 0 ? '' : head.slice(0, at);
  const where = at < 0 ? head : head.slice(at + 1);
  const slash = where.indexOf('/');
  const hostPort = slash < 0 ? where : where.slice(0, slash);
  const path = slash < 0 ? '' : where.slice(slash + 1).replace(/\/$/, '');
  if (path.includes('/')) throw new Error('After the host, the link has the database only: host:5432/database');
  const pairs = [];
  if (who) {
    const colon = who.indexOf(':');
    pairs.push(['user', dbDecode(colon < 0 ? who : who.slice(0, colon))]);
    if (colon >= 0) pairs.push(['password', dbDecode(who.slice(colon + 1))]);
  }
  const v6 = hostPort.match(/^\[([^\]]*)\](?::(.*))?$/);
  const colon = hostPort.lastIndexOf(':');
  const host = v6 ? v6[1] : colon < 0 || hostPort.includes(',') ? hostPort : hostPort.slice(0, colon);
  const port = v6 ? v6[2] : colon < 0 || hostPort.includes(',') ? '' : hostPort.slice(colon + 1);
  if (host) pairs.push(['host', dbDecode(host)]);
  if (port) pairs.push(['port', port]);
  if (path) pairs.push(['dbname', dbDecode(path)]);
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    pairs.push([dbDecode(eq < 0 ? part : part.slice(0, eq)), dbDecode(eq < 0 ? '' : part.slice(eq + 1))]);
  }
  return pairs;
}

// host=db port=5432 dbname=shop user=me password='it''s' (libpq), or Host=db;Port=5432;Database=shop;Username=me (.NET).
function dbFromPairs(text) {
  const pairs = [];
  if (text.includes(';')) {
    for (const part of text.split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) pairs.push([part.slice(0, eq).trim(), part.slice(eq + 1).trim()]);
    }
    return pairs;
  }
  const re = /(\w+)\s*=\s*(?:'((?:\\.|[^'\\])*)'|(\S*))/g;
  let m;
  while ((m = re.exec(text))) pairs.push([m[1], m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]]);
  return pairs;
}

// The fields as a link: postgresql://user@host:port/database?sslmode=… (the password stays out).
function dbLinkOf({ host, port, database, user, ssl }) {
  const h = String(host || 'localhost');
  const mode = DB_LINK_SSL[ssl];
  return `postgresql://${user ? `${encodeURIComponent(user)}@` : ''}${h.includes(':') ? `[${h}]` : h}:${port || 5432}/${encodeURIComponent(database || '')}${mode ? `?sslmode=${mode}` : ''}`;
}
