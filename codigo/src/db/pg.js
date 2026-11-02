// -- PostgreSQL, to read only: each call opens its own connection, in a READ ONLY transaction that is rolled back,
// and closes it. The connection itself starts read only (default_transaction_read_only) with a time limit, and the
// SQL typed in is one statement that reads (SELECT, WITH, SHOW, EXPLAIN, VALUES, TABLE): a change is refused twice,
// here and by the database. Values come as PostgreSQL writes them (dates, numeric, json, arrays), as text. --
const { Client } = require('pg');

const TIMEOUT_MS = 30000;
const PAGE = 100; // rows of a table at a time
const MAX_ROWS = 1000; // of a query typed in
const MAX_CELL = 2000; // characters of a value
const READ_WORDS = new Set(['select', 'with', 'show', 'explain', 'values', 'table']);
// every value as the text PostgreSQL sends: nothing turned into a JS date or a rounded number
const AS_TEXT = { getTypeParser: () => (value) => value };

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

async function withClient(conn, fn) {
  const client = new Client({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password: conn.password || undefined,
    ssl: conn.ssl === 'require' ? true : conn.ssl === 'no-verify' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
    application_name: 'Git Quick (read only)',
    options: `-c default_transaction_read_only=on -c statement_timeout=${TIMEOUT_MS}`,
    types: AS_TEXT,
  });
  client.on('error', () => {}); // a connection dropped after the answer: nothing to do
  await client.connect();
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

module.exports = { test, schemas, tables, columns, rows, query, readOnlySql, explain, PAGE, MAX_ROWS };
