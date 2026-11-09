// -- PostgreSQL, to read only: each call opens its own connection, in a READ ONLY transaction that is rolled back,
// and closes it. The connection itself starts read only (default_transaction_read_only) with a time limit, and the
// SQL typed in is one statement that reads (SELECT, WITH, SHOW, EXPLAIN, VALUES, TABLE): a change is refused twice,
// here and by the database. Values come as PostgreSQL writes them (dates, numeric, json, arrays), as text. --
const { AsyncLocalStorage } = require('async_hooks');
const { Client } = require('pg');

const TIMEOUT_MS = 30000;
const PAGE = 100; // rows of a table at a time
const MAX_ROWS = 1000; // of a query typed in
const MAX_CELL = 2000; // characters of a value
const READ_WORDS = new Set(['select', 'with', 'show', 'explain', 'values', 'table']);
// every value as the text PostgreSQL sends: nothing turned into a JS date or a rounded number
const AS_TEXT = { getTypeParser: () => (value) => value };

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

// -- What is asked of the database, told as it happens: the page shows it (Calls), so a refusal can be read and compared with
// another client (DBeaver). The label says what the user did (Open orders.customer); the group ties the calls of one action. --
const context = new AsyncLocalStorage();
let listener = null;
let seq = 0;
const onCall = (fn) => { listener = fn; };
const inCall = (label, fn) => context.run({ label: String(label || ''), group: ++seq }, fn);
// the transaction control of every call: shown too, but out of the way
const QUIET = /^(begin|rollback|savepoint|release savepoint|rollback to savepoint|set local)\b/i;

const errorOf = (e) => ({
  code: String((e && e.code) || ''),
  message: String((e && e.message) || e),
  detail: String((e && e.detail) || ''),
  hint: String((e && e.hint) || ''),
  position: (e && e.position) || null,
  where: String((e && e.where) || ''),
});

function note(entry) {
  if (!listener) return;
  const ctx = context.getStore() || {};
  try {
    listener({ id: ++seq, at: Date.now(), label: ctx.label || '', group: ctx.group || 0, ...entry });
  } catch {
    // a page that is gone
  }
}

const paramsText = (params) => (Array.isArray(params) ? params.map((v) => (Array.isArray(v) ? `{${v.slice(0, 6).join(',')}${v.length > 6 ? ',…' : ''}}` : String(v))).join(', ').slice(0, 300) : '');

// the client, with each statement it runs told (the password never is: only the statements and what they answered)
function logged(client) {
  const raw = client.query.bind(client);
  client.query = async (q, params) => {
    const t0 = Date.now();
    const sql = String(typeof q === 'string' ? q : (q && q.text) || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    try {
      const r = await raw(q, params);
      note({ kind: 'sql', sql, params: paramsText(params), ms: Date.now() - t0, rows: r && Array.isArray(r.rows) ? r.rows.length : null, quiet: QUIET.test(sql) });
      return r;
    } catch (e) {
      note({ kind: 'sql', sql, params: paramsText(params), ms: Date.now() - t0, quiet: QUIET.test(sql), error: errorOf(e) });
      throw e;
    }
  };
}

async function withClient(conn, fn) {
  const client = new Client({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password: conn.password || undefined,
    ssl: conn.ssl === 'require' ? true : conn.ssl === 'no-verify' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
    application_name: 'QuickDeck (read only)',
    options: `-c default_transaction_read_only=on -c statement_timeout=${TIMEOUT_MS}`,
    types: AS_TEXT,
  });
  client.on('error', () => {}); // a connection dropped after the answer: nothing to do
  const t0 = Date.now();
  const where = `${conn.host}:${conn.port}/${conn.database} as ${conn.user}${conn.ssl === 'require' ? ' (TLS)' : conn.ssl === 'no-verify' ? ' (TLS, not verified)' : ''}`;
  try {
    await client.connect();
    note({ kind: 'connect', text: `Connected to ${where}`, ms: Date.now() - t0 });
  } catch (e) {
    note({ kind: 'connect', text: `Could not connect to ${where}`, ms: Date.now() - t0, error: errorOf(e) });
    throw e;
  }
  logged(client);
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

const cell = (v) => (v === null || v === undefined ? null : v.length > MAX_CELL ? `${v.slice(0, MAX_CELL)}…` : v);

// The names of the types of the columns of an answer (their oids, as pg gives them).
async function typeNames(client, fields) {
  const oids = [...new Set(fields.map((f) => f.dataTypeID))];
  if (!oids.length) return {};
  const r = await client.query('select oid::text, format_type(oid, null) as name from pg_type where oid = any($1::oid[])', [oids]);
  return Object.fromEntries(r.rows.map((x) => [x.oid, x.name]));
}

async function answer(client, result, extra = {}) {
  const types = await typeNames(client, result.fields || []);
  return {
    fields: (result.fields || []).map((f) => ({ name: f.name, type: types[String(f.dataTypeID)] || '' })),
    rows: (result.rows || []).map((r) => r.map(cell)),
    ...extra,
  };
}

async function test(conn) {
  return withClient(conn, async (c) => {
    const r = await c.query("select current_setting('server_version') as version, current_database() as database, current_user as \"user\"");
    return r.rows[0];
  });
}

// The schemas the user can use (not PostgreSQL's own), with how many tables and views each has.
async function schemas(conn) {
  return withClient(conn, async (c) => {
    const r = await c.query(`
      select n.nspname as name, count(cl.oid) filter (where cl.relkind in ('r','p','v','m','f'))::text as tables
      from pg_namespace n left join pg_class cl on cl.relnamespace = n.oid
      where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
        and has_schema_privilege(n.oid, 'USAGE')
      group by n.nspname order by n.nspname`);
    return { schemas: r.rows.map((x) => ({ name: x.name, tables: Number(x.tables) })) };
  });
}

const KINDS = { r: 'table', p: 'table', v: 'view', m: 'materialized view', f: 'foreign table' };

async function tables(conn, schema) {
  return withClient(conn, async (c) => {
    const r = await c.query(`
      select cl.relname as name, cl.relkind as kind, greatest(cl.reltuples, 0)::bigint::text as estimate, has_table_privilege(cl.oid, 'SELECT') as readable
      from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
      where n.nspname = $1 and cl.relkind in ('r','p','v','m','f') order by cl.relname`, [schema]);
    return { tables: r.rows.map((x) => ({ name: x.name, kind: KINDS[x.kind] || x.kind, estimate: Number(x.estimate), readable: x.readable === 't' || x.readable === true })) };
  });
}

async function columnsOf(c, schema, table) {
  const r = await c.query(`
    select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
      pg_get_expr(d.adbin, d.adrelid) as "default",
      exists (select 1 from pg_index i where i.indrelid = cl.oid and i.indisprimary and a.attnum = any(i.indkey)) as pk
    from pg_attribute a join pg_class cl on cl.oid = a.attrelid join pg_namespace n on n.oid = cl.relnamespace
      left join pg_attrdef d on d.adrelid = cl.oid and d.adnum = a.attnum
    where n.nspname = $1 and cl.relname = $2 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [schema, table]);
  const yes = (v) => v === true || v === 't';
  return r.rows.map((x) => ({ name: x.name, type: x.type, nullable: yes(x.nullable), default: x.default, pk: yes(x.pk) }));
}

async function columns(conn, schema, table) {
  return withClient(conn, async (c) => ({ columns: await columnsOf(c, schema, table) }));
}

// A page of a table: sorted by one of its columns, else by its primary key (so the pages follow on), else as it comes;
// with how many rows it has (counted when that takes under 2 s, else PostgreSQL's estimate).
async function rows(conn, schema, table, { offset = 0, sort = null, desc = false } = {}) {
  return withClient(conn, async (c) => {
    const cols = await columnsOf(c, schema, table);
    if (!cols.length) throw new Error(`No table ${schema}.${table}`);
    const sorted = sort && cols.some((x) => x.name === sort) ? sort : null;
    const pk = cols.filter((x) => x.pk).map((x) => ident(x.name));
    const by = sorted ? ` order by ${ident(sorted)} ${desc ? 'desc' : 'asc'} nulls last` : pk.length ? ` order by ${pk.join(', ')}` : '';
    const from = Math.max(0, Math.floor(Number(offset) || 0));
    const result = await c.query({ text: `select * from ${ident(schema)}.${ident(table)}${by} limit ${PAGE + 1} offset ${from}`, rowMode: 'array' });
    const more = result.rows.length > PAGE;
    if (more) result.rows.length = PAGE;
    let total = null;
    let exact = false;
    await c.query('savepoint counting');
    try {
      await c.query("set local statement_timeout = '2s'");
      total = Number((await c.query(`select count(*) from ${ident(schema)}.${ident(table)}`)).rows[0].count);
      exact = true;
      await c.query('release savepoint counting');
    } catch {
      await c.query('rollback to savepoint counting');
      note({ kind: 'info', text: 'The count did not work: PostgreSQL\'s estimate of the rows is used instead (this does not stop the rows being shown)' });
      const est = await c.query('select greatest(cl.reltuples, 0)::bigint::text as n from pg_class cl join pg_namespace n on n.oid = cl.relnamespace where n.nspname = $1 and cl.relname = $2', [schema, table]);
      total = est.rows.length ? Number(est.rows[0].n) : null;
    }
    return answer(c, result, { offset: from, more, total, exact, page: PAGE, columns: cols, sort: sorted, desc: Boolean(sorted && desc) });
  });
}

// SQL typed in: one statement that reads. Its comments and quoted text set aside, a ; may only end it.
function readOnlySql(sql) {
  const text = String(sql || '').trim().replace(/;\s*$/, '');
  if (!text) throw new Error('Write a query: SELECT, WITH, SHOW, EXPLAIN, VALUES or TABLE');
  const bare = text.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ').trim();
  if (bare.includes(';')) throw new Error('One query at a time');
  const first = ((bare.match(/^\(*\s*([A-Za-z]+)/) || [])[1] || '').toLowerCase();
  if (!READ_WORDS.has(first)) throw new Error(`This page only reads: SELECT, WITH, SHOW, EXPLAIN, VALUES or TABLE${first ? ` (not ${first.toUpperCase()})` : ''}`);
  return { text, first };
}

async function query(conn, sql) {
  const { text, first } = readOnlySql(sql);
  return withClient(conn, async (c) => {
    const started = Date.now();
    // a query that gives rows: at most MAX_ROWS of them come back
    const wrap = ['select', 'with', 'values', 'table'].includes(first);
    const result = await c.query({ text: wrap ? `select * from (${text}\n) as q limit ${MAX_ROWS + 1}` : text, rowMode: 'array' });
    const ms = Date.now() - started;
    const truncated = (result.rows || []).length > MAX_ROWS;
    if (truncated) result.rows.length = MAX_ROWS;
    return answer(c, result, { ms, truncated, max: MAX_ROWS });
  });
}

const MAX_CATALOG = 50000; // columns, for the SQL tab to offer and check names
const jsonList = (v) => {
  try {
    const list = JSON.parse(v || '[]');
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
};

// Every table and view the user can see, with its columns, the foreign keys between them and the schemas of the
// search path: what the SQL tab offers as it is typed and checks a name against. Read once per connection.
async function catalog(conn) {
  return withClient(conn, async (c) => {
    const cols = await c.query({
      text: `
        select n.nspname, cl.relname, cl.relkind, a.attname, format_type(a.atttypid, a.atttypmod)
        from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
          left join pg_attribute a on a.attrelid = cl.oid and a.attnum > 0 and not a.attisdropped
        where cl.relkind in ('r','p','v','m','f') and n.nspname not in ('pg_catalog', 'information_schema')
          and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%' and has_schema_privilege(n.oid, 'USAGE')
        order by n.nspname, cl.relname, a.attnum
        limit ${MAX_CATALOG + 1}`,
      rowMode: 'array',
    });
    const truncated = cols.rows.length > MAX_CATALOG;
    if (truncated) cols.rows.length = MAX_CATALOG;
    const schemas = new Map();
    for (const [schema, table, kind, column, type] of cols.rows) {
      if (!schemas.has(schema)) schemas.set(schema, new Map());
      const tablesOf = schemas.get(schema);
      if (!tablesOf.has(table)) tablesOf.set(table, { name: table, kind: KINDS[kind] || kind, columns: [] });
      if (column !== null) tablesOf.get(table).columns.push({ name: column, type: type || '' });
    }
    const fks = await c.query({
      text: `
        select n.nspname, cl.relname, rn.nspname, rc.relname,
          array_to_json(array(select a.attname from unnest(co.conkey) with ordinality k(num, i) join pg_attribute a on a.attrelid = co.conrelid and a.attnum = k.num order by k.i))::text,
          array_to_json(array(select a.attname from unnest(co.confkey) with ordinality k(num, i) join pg_attribute a on a.attrelid = co.confrelid and a.attnum = k.num order by k.i))::text
        from pg_constraint co join pg_class cl on cl.oid = co.conrelid join pg_namespace n on n.oid = cl.relnamespace
          join pg_class rc on rc.oid = co.confrelid join pg_namespace rn on rn.oid = rc.relnamespace
        where co.contype = 'f' and has_schema_privilege(n.oid, 'USAGE')
        limit 5000`,
      rowMode: 'array',
    });
    const searchPath = await c.query('select array_to_json(current_schemas(false))::text as path');
    return {
      schemas: [...schemas].map(([name, tablesOf]) => ({ name, tables: [...tablesOf.values()] })),
      fks: fks.rows.map(([schema, table, refSchema, refTable, columnsOf, refColumns]) => ({ schema, table, refSchema, refTable, columns: jsonList(columnsOf), refColumns: jsonList(refColumns) })),
      path: jsonList(searchPath.rows[0] && searchPath.rows[0].path),
      truncated,
    };
  });
}

// SQL typed in, checked by PostgreSQL without running it: EXPLAIN (which plans a query, so it reads its names, and does
// not run it), in the read-only transaction. { ok } when PostgreSQL takes it; { problem: { message, hint, position } }
// when not, position counted in the text as typed (1 is its first character), null when PostgreSQL gives none.
// SHOW and EXPLAIN typed in are not checked (skipped): they cannot go under an EXPLAIN.
async function check(conn, sql) {
  const raw = String(sql || '');
  let read;
  try {
    read = readOnlySql(raw);
  } catch (e) {
    return { problem: { message: e.message, hint: '', position: null } };
  }
  if (!['select', 'with', 'values', 'table'].includes(read.first)) return { ok: true, skipped: true };
  const lead = raw.length - raw.trimStart().length;
  const head = 'explain (costs off) ';
  return withClient(conn, async (c) => {
    await c.query("set local statement_timeout = '5s'");
    try {
      await c.query(head + read.text);
      return { ok: true };
    } catch (e) {
      // the connection's own trouble is not the query's: said as an error, not a problem of the text
      if (!e.code || /^(08|28|3D|57P)/.test(e.code)) throw e;
      if (e.code === '57014') return { ok: true, slow: true };
      const at = Number(e.position) || 0;
      return { problem: { message: e.message, hint: e.hint || '', position: at > head.length ? at - head.length + lead : null, code: e.code } };
    }
  });
}

// What went wrong, in a sentence: the connection first, then what PostgreSQL said.
function explain(e, conn) {
  const where = conn ? `${conn.host}:${conn.port}` : 'the server';
  if (e.code === 'ECONNREFUSED') return `Nothing answers at ${where}: is the database running?`;
  if (e.code === 'ENOTFOUND') return `No server called ${conn ? conn.host : 'that'}`;
  if (e.code === 'ETIMEDOUT' || /timeout expired/i.test(e.message)) return `${where} did not answer in time`;
  if (e.code === '28P01' || e.code === '28000') return `PostgreSQL refused ${conn ? conn.user : 'the user'}: ${e.message}`;
  if (e.code === '3D000') return `No database ${conn ? conn.database : ''} on ${where}`;
  if (e.code === '25006') return `Read only: this page does not change data (PostgreSQL: ${e.message})`;
  if (e.code === '57014') return `Stopped: it took more than ${TIMEOUT_MS / 1000} s`;
  if (e.code === '42501') return `No permission: ${e.message}`;
  return e.position ? `${e.message} (at character ${e.position})` : e.message;
}

// What this user may do with a table, to read and compare with another client that does read it (DBeaver): who connects, the
// roles it belongs to and whether it uses their rights, the rights on the schema, the table and its columns, row level
// security. Each is one statement of its own, told like the others; one that fails is said, and the next goes on.
async function whoami(conn, schema, table) {
  return withClient(conn, async (c) => {
    const items = [];
    let n = 0;
    const ask = async (label, sql, params) => {
      const sp = `check${++n}`;
      await c.query(`savepoint ${sp}`);
      try {
        const r = await c.query(sql, params);
        await c.query(`release savepoint ${sp}`);
        items.push({ label, rows: r.rows });
        return r.rows;
      } catch (e) {
        await c.query(`rollback to savepoint ${sp}`);
        items.push({ label, error: e.message });
        return [];
      }
    };
    const me = (await ask('Who connects', `select current_user as "user", session_user as "session", current_database() as "database", current_setting('search_path') as search_path, current_setting('default_transaction_read_only') as read_only`))[0] || {};
    const roles = await ask('Roles of this user', `select r.rolname as role, r.rolinherit as inherits, r.rolsuper as superuser, pg_has_role(current_user, r.oid, 'usage') as uses_its_rights from pg_roles r where r.rolname = current_user or (pg_has_role(current_user, r.oid, 'member') and r.rolname !~ '^pg_') order by 1`);
    const priv = (await ask(`Rights on ${schema}.${table}`, `select has_schema_privilege(current_user, $1, 'USAGE') as schema_usage, has_table_privilege(current_user, format('%I.%I', $1::text, $2::text), 'SELECT') as table_select`, [schema, table]))[0] || {};
    const cols = (await ask('Columns it can read', `select count(*)::int as total, count(*) filter (where has_column_privilege(current_user, cl.oid, a.attnum, 'SELECT'))::int as readable from pg_attribute a join pg_class cl on cl.oid = a.attrelid join pg_namespace n on n.oid = cl.relnamespace where n.nspname = $1 and cl.relname = $2 and a.attnum > 0 and not a.attisdropped`, [schema, table]))[0] || {};
    const rls = (await ask('Row level security', `select cl.relrowsecurity as enabled, cl.relforcerowsecurity as forced, pg_get_userbyid(cl.relowner) as owner from pg_class cl join pg_namespace n on n.oid = cl.relnamespace where n.nspname = $1 and cl.relname = $2`, [schema, table]))[0] || {};
    return { items, reading: reading({ me, roles, priv, cols, rls }) };
  });
}

// the sentences that say what the answers mean
function reading({ me, roles, priv, cols, rls }) {
  const yes = (v) => v === true || v === 't';
  const out = [];
  if (priv.schema_usage !== undefined && !yes(priv.schema_usage)) {
    out.push('This user has no USAGE on the schema, so nothing in it can be read. It needs GRANT USAGE ON SCHEMA, or the connection has to be the user that DBeaver uses.');
  } else if (priv.table_select !== undefined && !yes(priv.table_select)) {
    const idle = roles.filter((r) => r.role !== me.user && !yes(r.uses_its_rights)).map((r) => r.role);
    out.push(idle.length
      ? `This user belongs to ${idle.join(', ')} but does not use what they may do (NOINHERIT): DBeaver may be set to take that role (SET ROLE), or to connect as another user.`
      : 'This user has no SELECT on the table: DBeaver must be connecting as another user, or as one that has it.');
  }
  if (cols.total !== undefined && Number(cols.readable) < Number(cols.total)) out.push(`It may read only ${cols.readable} of ${cols.total} columns, so select * is refused. DBeaver may be asking only for the columns it can read.`);
  if (yes(rls.enabled)) out.push(`Row level security is on for the table (owner ${rls.owner || '?'}): the rows this user sees depend on the policies.`);
  if (!out.length) out.push('Nothing here explains a refusal: this user can read the table. Compare the statement that failed, in the list, with what DBeaver runs.');
  return out;
}

module.exports = { test, schemas, tables, columns, rows, query, catalog, check, whoami, onCall, inCall, readOnlySql, explain, PAGE, MAX_ROWS, MAX_CATALOG };
