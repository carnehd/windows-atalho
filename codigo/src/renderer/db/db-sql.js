// -- The SQL tab of the Database page, in two ways (Write / Build), both to read only.
// Write: the SQL typed, its words in colour, the connection's names offered as they are typed (Tab or Enter takes one,
// Ctrl+Space shows the list), and what is wrong underlined and said under it: what QuickDeck sees at once (a quote or a
// bracket not closed, an SQL word misspelt, a table or a column that is not there) and what PostgreSQL says a moment
// after the typing stops (EXPLAIN: it reads the query, its names too, and does not run it).
// Build: a query put together from blocks (the table, its columns, conditions, joins, group by, order, limit), shown
// as SQL under them; Edit as SQL takes it to Write.
// The names come from the connection's catalog, read once (db/pg.js catalog). --
const DB_SQL_MODE_KEY = 'dbSqlMode';
const DB_BUILD_KEY = 'dbBuild';
const DQ_KW = new Set(('select from where and or not in is null like ilike between join inner left right full outer cross on using group by order '
  + 'having limit offset distinct as case when then else end union all intersect except with recursive values table show explain asc desc '
  + 'nulls first last exists any some true false cast interval over partition window filter lateral natural fetch next rows row only default '
  + 'current_date current_time current_timestamp current_user localtime localtimestamp similar escape collate array materialized within '
  + 'to at for both leading trailing isnull notnull symmetric ties ordinality').split(' '));
const DQ_FUNCS = ('count sum avg min max coalesce nullif greatest least lower upper initcap length trim ltrim rtrim substring substr replace '
  + 'concat concat_ws position split_part lpad rpad now date_trunc date_part extract age to_char to_date to_timestamp to_number round floor ceil '
  + 'abs mod random string_agg array_agg json_agg jsonb_agg json_build_object jsonb_build_object jsonb_extract_path_text row_number rank '
  + 'dense_rank lag lead first_value last_value generate_series unnest regexp_replace md5 format').split(' ');
const DQ_FUNC = new Set(DQ_FUNCS);
const DQ_TYPES = new Set(('text varchar char character varying integer int int2 int4 int8 bigint smallint numeric decimal real double precision '
  + 'float float4 float8 boolean bool date time timestamp timestamptz interval uuid json jsonb bytea money inet cidr oid regclass serial '
  + 'bigserial without zone').split(' '));
const DQ_PARTS = new Set('year month day hour minute second epoch dow doy week quarter century decade millennium milliseconds microseconds timezone isodow isoyear julian'.split(' '));
// the words a statement is built of: one of them misspelt is said
const DQ_CLAUSE = ['select', 'from', 'where', 'group', 'order', 'having', 'limit', 'offset', 'join', 'inner', 'left', 'right', 'outer', 'union',
  'distinct', 'between', 'ilike', 'exists', 'values', 'with', 'when', 'then', 'else', 'null', 'true', 'false', 'desc', 'like', 'case'];
// offered as they are typed, after a table or a column, and at the start
const DQ_OFFER_AFTER_TABLE = ['where', 'join', 'left join', 'inner join', 'on', 'as', 'group by', 'order by', 'limit', 'union', 'union all'];
const DQ_OFFER = ['select', 'from', 'where', 'and', 'or', 'not', 'in', 'is null', 'is not null', 'like', 'ilike', 'between', 'join', 'left join',
  'inner join', 'on', 'as', 'group by', 'order by', 'having', 'limit', 'offset', 'distinct', 'case', 'when', 'then', 'else', 'end', 'asc', 'desc',
  'nulls last', 'exists', 'union', 'union all', 'with', 'true', 'false', 'null', 'count(*)', 'current_date', 'now()'];
const DQ_STARTS = ['select', 'with', 'table', 'values', 'explain', 'show'];
const DB_BUILD_OPS = ['=', '!=', '>', '>=', '<', '<=', 'like', 'ilike', 'in', 'not in', 'is null', 'is not null'];

const dbCat = { token: -1, data: null, error: null, loading: null }; // the catalog of the connection open (db.token)
let dbSqlCheck = { key: '', running: false, result: null }; // PostgreSQL's answer for the text checked
let dbSqlTimer = 0;
let dbSqlTyping = 0; // when the text was last typed in
let dbSqlPaintTimer = 0;
let dbAc = null; // the list of names open: { from, to, items, at }

// -- Words --
// The pieces of SQL text, with where each starts and ends: blanks, comments, quoted text ('...', E'...', $$...$$),
// quoted names ("..."), numbers, words, operators. open: a quote or a comment not closed.
const DQ_TOKEN = /(\s+)|(--[^\n]*)|(\/\*[\s\S]*?(?:\*\/|$))|([eE]'(?:[^'\\]|''|\\[\s\S])*(?:'|$)|'(?:[^']|'')*(?:'|$))|(\$([A-Za-z_]\w*)?\$[\s\S]*?(?:\$\6\$|$))|("(?:[^"]|"")*(?:"|$))|((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([A-Za-z_À-￿][\w$À-￿]*)|(::|<>|!=|<=|>=|\|\||->>|->|#>>|#>)|([\s\S])/y;
const DQ_GROUP_TYPE = { 1: 'ws', 2: 'comment', 3: 'comment', 4: 'string', 5: 'string', 7: 'qident', 8: 'number', 9: 'word', 10: 'op', 11: 'punct' };

function sqlTokens(s) {
  const out = [];
  DQ_TOKEN.lastIndex = 0;
  while (DQ_TOKEN.lastIndex < s.length) {
    const m = DQ_TOKEN.exec(s);
    if (!m) break;
    const g = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11].find((n) => m[n] !== undefined);
    const t = { type: DQ_GROUP_TYPE[g], text: m[0], start: m.index, end: m.index + m[0].length };
    if (g === 3 && !(m[0].length >= 4 && m[0].endsWith('*/'))) t.open = 'comment';
    if (g === 4 && !(/^[eE]'/.test(m[0]) ? /^[eE]'(?:[^'\\]|''|\\[\s\S])*'$/ : /^'(?:[^']|'')*'$/).test(m[0])) t.open = 'quote';
    if (g === 5) {
      const tag = `$${m[6] || ''}$`;
      if (!(m[0].length >= tag.length * 2 && m[0].endsWith(tag))) t.open = 'dollar';
    }
    if (g === 7 && !/^"(?:[^"]|"")*"$/.test(m[0])) t.open = 'name';
    if (t.type === 'word') t.low = m[0].toLowerCase();
    out.push(t);
  }
  return out;
}

const sqlSig = (tokens) => tokens.filter((t) => t.type !== 'ws' && t.type !== 'comment');
const sqlIsName = (t) => Boolean(t) && (t.type === 'qident' || (t.type === 'word' && !DQ_KW.has(t.low)));
// a name as PostgreSQL reads it: unquoted in lower case, quoted as written
const sqlName = (t) => (!t ? null : t.type === 'word' ? t.low : t.type === 'qident' ? t.text.replace(/^"|"$/g, '').replace(/""/g, '"') : null);
const sqlIs = (t, text) => Boolean(t) && (t.type === 'punct' || t.type === 'op' ? t.text === text : t.low === text);

// Steps from one word to the other (a letter put in, taken out, changed, or two swapped).
function sqlDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// The name nearest to word, if near enough to be the one meant.
function sqlNearest(word, names) {
  const w = word.toLowerCase();
  const most = w.length >= 7 ? 2 : 1;
  let best = null;
  let bestD = most + 1;
  for (const n of names) {
    const d = sqlDistance(w, String(n).toLowerCase());
    if (d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

// -- The catalog: the tables and views, their columns, the foreign keys, the schemas of the search path --
function dbCatalogIndex(data) {
  const schemas = new Map();
  const names = new Set();
  for (const s of data.schemas || []) {
    const tablesOf = new Map();
    names.add(s.name.toLowerCase());
    for (const t of s.tables) {
      tablesOf.set(t.name, { ...t, schema: s.name, colSet: new Set(t.columns.map((c) => c.name)) });
      names.add(t.name.toLowerCase());
      for (const c of t.columns) names.add(c.name.toLowerCase());
    }
    schemas.set(s.name, tablesOf);
  }
  return { schemas, names, path: data.path || [], fks: data.fks || [], truncated: Boolean(data.truncated) };
}

// Read once for the connection open; what waits on it is drawn again when it comes.
function dbCatalog() {
  if (!db.id) return null;
  if (dbCat.token === db.token) return dbCat.data;
  const token = db.token;
  const id = db.id;
  Object.assign(dbCat, { token, data: null, error: null });
  dbCat.loading = window.database.catalog(id).then((r) => {
    if (db.token !== token) return;
    if (r.error) dbCat.error = r.error;
    else dbCat.data = dbCatalogIndex(r);
    if (db.tab === 'sql') {
      if (dbSqlMode() === 'build') renderDbBuild();
      else paintDbSql();
    }
  });
  return null;
}

// A table by its name as written: schema.table, or a table of the search path.
function dbFindTable(cat, schema, table) {
  if (!cat) return null;
  if (schema) return (cat.schemas.get(schema) || new Map()).get(table) || null;
  for (const s of cat.path) {
    const t = (cat.schemas.get(s) || new Map()).get(table);
    if (t) return t;
  }
  return null;
}

const dbTableKey = (t) => `${t.schema}.${t.name}`;

// -- What a statement reads --
// The tables after FROM and JOIN (and FROM's commas), each with its alias and where it is written; the names WITH
// gives; the aliases of the select list; how many SELECTs. used: the pieces the table names took.
function sqlShape(sig) {
  const refs = [];
  const ctes = new Set();
  const aliases = new Set();
  const used = new Set();
  let selects = 0;
  const parens = []; // the word before each ( still open
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (sqlIs(t, '(')) parens.push(sig[i - 1] && sig[i - 1].type === 'word' ? sig[i - 1].low : '');
    else if (sqlIs(t, ')')) parens.pop();
    if (t.type !== 'word') continue;
    if (t.low === 'select') selects += 1;
    if (t.low === 'as' && sqlIsName(sig[i + 1])) aliases.add(sqlName(sig[i + 1]));
    if (t.low === 'with') {
      // WITH a AS (...), b AS (...)
      let j = i + 1;
      if (sqlIs(sig[j], 'recursive')) j += 1;
      while (sqlIsName(sig[j])) {
        ctes.add(sqlName(sig[j]));
        j += 1;
        if (sqlIs(sig[j], '(')) j = sqlSkipParens(sig, j);
        if (!sqlIs(sig[j], 'as')) break;
        j += 1;
        if (sqlIs(sig[j], 'not')) j += 1;
        if (sqlIs(sig[j], 'materialized')) j += 1;
        if (!sqlIs(sig[j], '(')) break;
        j = sqlSkipParens(sig, j);
        if (!sqlIs(sig[j], ',')) break;
        j += 1;
      }
    }
    // extract(year from x), substring(a from 2), trim(both from x): not a table
    const inside = parens[parens.length - 1];
    if ((t.low === 'from' && !['extract', 'substring', 'trim', 'overlay', 'position'].includes(inside)) || t.low === 'join') {
      let j = i + 1;
      for (;;) {
        if (sqlIs(sig[j], 'only') || sqlIs(sig[j], 'lateral')) j += 1;
        if (!sqlIsName(sig[j]) || sqlIs(sig[j + 1], '(')) break;
        const ref = { schema: null, table: sqlName(sig[j]), alias: null, at: sig[j], atTable: sig[j] };
        used.add(sig[j]);
        if (sqlIs(sig[j + 1], '.') && sqlIsName(sig[j + 2])) {
          ref.schema = ref.table;
          ref.table = sqlName(sig[j + 2]);
          ref.atTable = sig[j + 2];
          used.add(sig[j + 2]);
          j += 2;
        }
        j += 1;
        const as = sqlIs(sig[j], 'as');
        if (as) j += 1;
        // from customer whre status = 1: whre is where misspelt, not an alias
        if (sqlIsName(sig[j]) && !sqlIs(sig[j + 1], '.') && (as || !sqlMisspelt(sig[j], sig[j + 1]))) {
          ref.alias = sqlName(sig[j]);
          used.add(sig[j]);
          j += 1;
        }
        refs.push(ref);
        if (t.low === 'join' || !sqlIs(sig[j], ',')) break;
        j += 1;
      }
    }
  }
  // the select list's own names: select count(*) total, name n from ...
  for (let i = 1; i < sig.length; i++) {
    const t = sig[i];
    const before = sig[i - 1];
    if (!sqlIsName(t) || used.has(t)) continue;
    const ends = before.type === 'qident' || before.type === 'number' || before.type === 'string' || sqlIs(before, ')') || (before.type === 'word' && !DQ_KW.has(before.low) && !DQ_FUNC.has(before.low));
    const next = sig[i + 1];
    if (ends && (!next || sqlIs(next, ',') || sqlIs(next, 'from'))) aliases.add(sqlName(t));
  }
  return { refs, ctes, aliases, used, selects };
}

// A word near an SQL word (whre, form, gruop), with more after it: the SQL word misspelt
const sqlMisspelt = (t, next) => t.type === 'word' && t.low.length >= 4 && Boolean(sqlNearest(t.low, DQ_CLAUSE))
  && Boolean(next) && (sqlIsName(next) || next.type === 'number' || next.type === 'string' || sqlIs(next, '*') || sqlIs(next, 'by'));

function sqlSkipParens(sig, j) {
  let depth = 0;
  for (; j < sig.length; j++) {
    if (sqlIs(sig[j], '(')) depth += 1;
    else if (sqlIs(sig[j], ')') && --depth === 0) return j + 1;
  }
  return j;
}

// The table an alias or a table name stands for in the statement.
function sqlTableOf(shape, cat, name) {
  const ref = shape.refs.find((r) => r.alias === name) || shape.refs.find((r) => !r.alias && r.table === name) || shape.refs.find((r) => r.table === name);
  return ref ? dbFindTable(cat, ref.schema, ref.table) : null;
}

// -- What is wrong, seen here: { start, end, message } --
function sqlLocalProblems(tokens, cat) {
  const out = [];
  for (const t of tokens) {
    if (t.open === 'comment') out.push({ start: t.start, end: t.end, message: 'This comment is not closed: */ is missing', level: 'error' });
    else if (t.open === 'dollar') out.push({ start: t.start, end: t.end, message: 'This $$ text is not closed', level: 'error' });
    else if (t.open === 'name') out.push({ start: t.start, end: t.end, message: 'This name is not closed: " is missing', level: 'error' });
    else if (t.open) out.push({ start: t.start, end: t.end, message: "This text is not closed: ' is missing", level: 'error' });
  }
  const sig = sqlSig(tokens);
  const stack = [];
  for (const t of sig) {
    if (sqlIs(t, '(')) stack.push(t);
    else if (sqlIs(t, ')') && !stack.pop()) out.push({ start: t.start, end: t.end, message: 'This ) closes no (', level: 'error' });
  }
  for (const t of stack) out.push({ start: t.start, end: t.end, message: 'This ( is not closed', level: 'error' });
  if (!cat || out.length) return out.sort((a, b) => a.start - b.start);
  const shape = sqlShape(sig);
  const marked = new Set();
  const mark = (t, message) => {
    marked.add(t);
    out.push({ start: t.start, end: t.end, message });
  };
  // the tables: there, or where they are
  for (const r of shape.refs) {
    if (!r.schema && shape.ctes.has(r.table)) continue;
    if (dbFindTable(cat, r.schema, r.table)) continue;
    if (cat.truncated) continue;
    if (r.schema && !cat.schemas.has(r.schema)) {
      const near = sqlNearest(r.schema, [...cat.schemas.keys()]);
      mark(r.at, `No schema ${r.schema} this user can read${near ? `. Did you mean ${near}?` : ''}`);
      continue;
    }
    const elsewhere = r.schema ? [] : [...cat.schemas].filter(([, tablesOf]) => tablesOf.has(r.table)).map(([s]) => s);
    if (elsewhere.length) {
      mark(r.atTable, `${r.table} is in ${elsewhere.join(', ')}, not in the search path: write ${elsewhere[0]}.${r.table}`);
      continue;
    }
    const pool = r.schema ? [...cat.schemas.get(r.schema).keys()] : cat.path.flatMap((s) => [...(cat.schemas.get(s) || new Map()).keys()]);
    const near = sqlNearest(r.table, pool);
    mark(r.atTable, `No table ${r.table}${r.schema ? ` in ${r.schema}` : ''}${near ? `. Did you mean ${near}?` : ''}`);
  }
  const known = new Set([...shape.aliases, ...shape.ctes, ...shape.refs.map((r) => r.alias).filter(Boolean)]);
  // alias.column: a column of that table
  for (let i = 0; i + 2 < sig.length; i++) {
    const [a, dot, b] = [sig[i], sig[i + 1], sig[i + 2]];
    if (!sqlIsName(a) || !sqlIs(dot, '.') || !sqlIsName(b) || shape.used.has(b) || sqlIs(sig[i + 3], '.') || sqlIs(sig[i + 3], '(')) continue;
    if (sqlIs(sig[i - 1], '.')) continue;
    const table = sqlTableOf(shape, cat, sqlName(a));
    const col = sqlName(b);
    if (!table || table.colSet.has(col)) continue;
    const near = sqlNearest(col, table.columns.map((c) => c.name));
    mark(b, `${table.name} has no column ${col}${near ? `. Did you mean ${near}?` : ''}`);
  }
  // a word that is no name here, near an SQL word: whre, form, slect...
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.type !== 'word' || marked.has(t) || shape.used.has(t) || DQ_KW.has(t.low) || DQ_FUNC.has(t.low) || DQ_TYPES.has(t.low) || DQ_PARTS.has(t.low)) continue;
    if (t.low.length < 4 || cat.names.has(t.low) || known.has(t.low) || sqlIs(sig[i + 1], '(') || sqlIs(sig[i + 1], '.') || sqlIs(sig[i - 1], '.') || sqlIs(sig[i - 1], '::')) continue;
    const near = sqlNearest(t.low, DQ_CLAUSE);
    if (near) mark(t, `${t.text} is not an SQL word here. Did you mean ${near}?`);
  }
  // a column by itself, in a plain query of one table: one of that table
  const plain = shape.refs.length === 1 && !shape.ctes.size && shape.selects <= 1 && !sig.some((t) => ['over', 'window', 'lateral', 'filter', 'within', 'values', 'using'].includes(t.low));
  const only = plain ? dbFindTable(cat, shape.refs[0].schema, shape.refs[0].table) : null;
  if (only) {
    for (let i = 0; i < sig.length; i++) {
      const t = sig[i];
      if (!sqlIsName(t) || marked.has(t) || shape.used.has(t)) continue;
      if (t.type === 'word' && (DQ_FUNC.has(t.low) || DQ_TYPES.has(t.low) || DQ_PARTS.has(t.low))) continue;
      const name = sqlName(t);
      if (known.has(name) || only.colSet.has(name) || sqlIs(sig[i + 1], '(') || sqlIs(sig[i + 1], '.') || sqlIs(sig[i - 1], '.') || sqlIs(sig[i - 1], '::') || sqlIs(sig[i - 1], 'as') || sqlIs(sig[i - 1], 'collate')) continue;
      const near = sqlNearest(name, only.columns.map((c) => c.name));
      mark(t, `${only.name} has no column ${name}${near ? `. Did you mean ${near}?` : ''}`);
    }
  }
  // in the order of the text
  return out.sort((a, b) => a.start - b.start);
}

// -- Colour --
// The text as HTML: keywords, functions, quoted text, numbers and comments in their colours; what is wrong underlined.
function sqlHighlight(text, problems = []) {
  const tokens = sqlTokens(text);
  const sig = sqlSig(tokens);
  const fn = new Set();
  sig.forEach((t, i) => {
    if (t.type === 'word' && sqlIs(sig[i + 1], '(') && !DQ_KW.has(t.low)) fn.add(t);
  });
  let html = '';
  for (const t of tokens) {
    const cls = t.type === 'word' ? (DQ_KW.has(t.low) ? 'k' : fn.has(t) ? 'f' : '') : { comment: 'c', string: 's', number: 'n' }[t.type] || '';
    const bad = t.type !== 'ws' && problems.some((p) => p.start < t.end && p.end > t.start);
    const classes = [cls, bad ? 'bad' : ''].filter(Boolean).join(' ');
    html += classes ? `<span class="${classes}">${escapeHtml(t.text)}</span>` : escapeHtml(t.text);
  }
  // a last empty line has its height too
  return `${html}\n`;
}

// -- The tab --
function setDbSql(text) {
  const area = $('#dbSqlText');
  if (area) {
    area.value = text;
    paintDbSql();
  }
  saveDbSql(text);
}

function saveDbSql(text) {
  try {
    const all = JSON.parse(dbLoad(DB_SQL_KEY) || '{}');
    all[db.id] = text;
    dbStore(DB_SQL_KEY, JSON.stringify(all));
  } catch {
    // only for now
  }
}

function savedDbSql() {
  try {
    return JSON.parse(dbLoad(DB_SQL_KEY) || '{}')[db.id] || '';
  } catch {
    return '';
  }
}

const dbSqlMode = () => (dbLoad(DB_SQL_MODE_KEY) === 'build' ? 'build' : 'write');

function renderDbSql(pane) {
  closeDbAc();
  pane.innerHTML = '';
  dbCatalog();
  const mode = dbSqlMode();
  const top = dbEl('div', 'db-sql-top');
  top.appendChild(dbEl('span', 'db-dim', mode === 'build' ? 'Choose a table and what to see: the SQL is written under the blocks.' : `Tab or Enter takes a name offered · Ctrl+Space shows them · ${window.git.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Enter runs`));
  const seg = dbEl('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'How to make the query');
  for (const [key, label, title] of [['write', 'Write', 'Write the SQL, with the names offered and the mistakes said'], ['build', 'Build', 'Put the query together from blocks, without writing it']]) {
    const b = dbEl('button', 'seg-btn', label);
    b.type = 'button';
    b.id = key === 'write' ? 'dbSqlWrite' : 'dbSqlBuild';
    b.title = title;
    b.setAttribute('aria-pressed', String(mode === key));
    b.addEventListener('click', () => setDbSqlMode(key));
    seg.appendChild(b);
  }
  top.appendChild(seg);
  pane.appendChild(top);
  const box = dbEl('div', 'db-sql');
  box.id = 'dbSqlBox';
  pane.appendChild(box);
  if (mode === 'build') renderDbBuild();
  else renderDbWrite(box);
  const out = dbEl('div', 'db-sql-out');
  out.id = 'dbSqlOut';
  pane.appendChild(out);
  renderDbSqlResult();
}

function setDbSqlMode(mode, focus = true) {
  dbStore(DB_SQL_MODE_KEY, mode);
  dbSqlCheck = { key: '', running: false, result: null };
  renderDbPane();
  const target = mode === 'build' ? $('#dbSqlBuild') : $('#dbSqlText');
  if (focus && target) target.focus();
}

function renderDbWrite(box) {
  const edit = dbEl('div', 'db-sql-edit');
  const hl = dbEl('pre', 'db-sql-hl');
  hl.id = 'dbSqlHl';
  hl.setAttribute('aria-hidden', 'true');
  const area = dbEl('textarea', 'db-sql-text');
  area.id = 'dbSqlText';
  area.spellcheck = false;
  area.rows = 6;
  area.placeholder = db.sel ? `select * from ${dbIdent(db.sel.schema)}.${dbIdent(db.sel.table)} limit 50` : 'select * from my_schema.my_table limit 50';
  area.value = savedDbSql();
  area.setAttribute('aria-label', 'SQL');
  area.setAttribute('aria-autocomplete', 'list');
  area.setAttribute('aria-describedby', 'dbSqlCheck');
  area.setAttribute('autocomplete', 'off');
  area.addEventListener('input', (e) => {
    saveDbSql(area.value);
    // the name being typed is said wrong only once the typing stops
    dbSqlTyping = Date.now();
    clearTimeout(dbSqlPaintTimer);
    dbSqlPaintTimer = setTimeout(paintDbSql, 850);
    paintDbSql();
    const typed = e.inputType === 'insertText' && /^[\w.$"]$/.test(e.data || '');
    if (typed || (dbAc && /^delete/.test(e.inputType || ''))) openDbAc(false);
    else closeDbAc();
  });
  area.addEventListener('scroll', () => {
    hl.scrollTop = area.scrollTop;
    hl.scrollLeft = area.scrollLeft;
    closeDbAc();
  });
  area.addEventListener('keydown', dbSqlKey);
  area.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== area) closeDbAc();
  }, 120));
  area.addEventListener('mousedown', () => closeDbAc());
  edit.append(hl, area);
  if (window.ResizeObserver) new ResizeObserver(() => fitDbSqlHl()).observe(area);
  const check = dbEl('div', 'db-sql-check');
  check.id = 'dbSqlCheck';
  check.setAttribute('aria-live', 'polite');
  const bar = dbEl('div', 'db-sql-bar');
  const run = dbEl('button', 'btn btn-primary btn-sm', 'Run');
  run.id = 'dbRunBtn';
  run.type = 'button';
  run.title = 'Run it (Cmd+Enter)';
  run.disabled = !db.id;
  run.addEventListener('click', () => runDbSql());
  bar.append(run, dbEl('span', 'db-dim', 'Read only: one SELECT, WITH, SHOW, EXPLAIN, VALUES or TABLE · up to 1000 rows · 30 s at most'));
  box.append(edit, check, bar);
  paintDbSql();
}

// The coloured copy under the text: as wide as the text's own box (its scroll bar left out), at the same scroll.
function fitDbSqlHl() {
  const area = $('#dbSqlText');
  const hl = $('#dbSqlHl');
  if (!area || !hl) return;
  hl.style.width = `${area.clientWidth + 2}px`;
  hl.style.height = `${area.clientHeight + 2}px`;
  hl.scrollTop = area.scrollTop;
}

// The colours, what is wrong (seen here at once, PostgreSQL's a moment later), and the check sent when the typing stops.
function paintDbSql() {
  const area = $('#dbSqlText');
  const hl = $('#dbSqlHl');
  if (!area || !hl) return;
  const text = area.value;
  const cat = dbCat.token === db.token ? dbCat.data : null;
  // while a name is typed (the cursor at its end), it is not said wrong yet: orders.cu is on its way to orders.customer
  const caret = Date.now() - dbSqlTyping < 800 && document.activeElement === area && area.selectionStart === area.selectionEnd ? area.selectionStart : -1;
  const local = text.trim() ? sqlLocalProblems(sqlTokens(text), cat).filter((p) => p.level || p.end !== caret) : [];
  const key = `${db.id}\n${text}`;
  const answer = dbSqlCheck.key === key ? dbSqlCheck.result : null;
  // PostgreSQL is asked when nothing is seen wrong here: its problem, if any, is the only one
  const problems = local.length ? local : answer && answer.problem ? [dbProblemAt(text, answer.problem)] : [];
  hl.innerHTML = sqlHighlight(text, problems.filter((p) => p.start !== null));
  fitDbSqlHl();
  renderDbSqlCheck($('#dbSqlCheck'), text, problems, local, answer);
  scheduleDbSqlCheck(() => ($('#dbSqlText') ? $('#dbSqlText').value : null), local);
}

// PostgreSQL's problem at its place in the text: the piece it points at, else none (said, not underlined).
function dbProblemAt(text, p) {
  const message = `${p.message.charAt(0).toUpperCase()}${p.message.slice(1)}${p.hint ? `. ${p.hint}` : ''}`;
  if (!p.position) return { start: null, end: null, message, fromDb: true };
  const at = Math.min(Math.max(0, p.position - 1), Math.max(0, text.length - 1));
  const t = sqlTokens(text).find((x) => x.start <= at && at < x.end && x.type !== 'ws');
  return { start: t ? t.start : at, end: t ? t.end : at + 1, message, fromDb: true };
}

const dbLineOf = (text, at) => text.slice(0, at).split('\n').length;

// Under the text: each problem (a click puts the cursor there), or what PostgreSQL said of it.
function renderDbSqlCheck(box, text, problems, local, answer) {
  if (!box) return;
  box.innerHTML = '';
  box.className = 'db-sql-check';
  if (!text.trim()) return;
  if (problems.length) {
    for (const p of problems.slice(0, 5)) {
      const b = dbEl('button', 'db-sql-problem', `${p.start === null ? '' : `Line ${dbLineOf(text, p.start)}: `}${p.message}`);
      b.type = 'button';
      if (p.start !== null) {
        b.title = 'Go there';
        b.addEventListener('click', () => {
          const area = $('#dbSqlText');
          if (!area) return;
          area.focus();
          area.setSelectionRange(p.start, p.end);
        });
      } else b.disabled = true;
      box.appendChild(b);
    }
    if (problems.length > 5) box.appendChild(dbEl('span', 'db-dim', `and ${problems.length - 5} more`));
    return;
  }
  const key = `${db.id}\n${text}`;
  if (dbSqlCheck.key === key && dbSqlCheck.running) box.appendChild(dbEl('span', 'db-dim', 'PostgreSQL is reading it…'));
  else if (!answer) box.appendChild(dbEl('span', 'db-dim', ' '));
  else if (answer.error) box.appendChild(dbEl('span', 'db-dim', `Not checked: ${answer.error}`));
  else if (answer.skipped) box.appendChild(dbEl('span', 'db-dim', 'SHOW and EXPLAIN are not checked before they run'));
  else if (answer.ok) box.appendChild(dbEl('span', 'db-sql-good', answer.slow ? 'PostgreSQL took too long to read it: not checked' : 'PostgreSQL reads it: names and syntax are right'));
}

// PostgreSQL reads the text a moment after the typing stops (EXPLAIN: it does not run it). Not sent while something is
// seen wrong here, nor again for the text it last read.
function scheduleDbSqlCheck(textOf, local) {
  clearTimeout(dbSqlTimer);
  const text = textOf();
  if (text === null || !db.id || !text.trim() || local.length) return;
  const key = `${db.id}\n${text}`;
  if (dbSqlCheck.key === key) return;
  dbSqlTimer = setTimeout(async () => {
    if (textOf() !== text) return;
    dbSqlCheck = { key, running: true, result: null };
    repaintDbSqlCheck();
    const r = await window.database.check(db.id, text);
    if (dbSqlCheck.key !== key) return;
    dbSqlCheck = { key, running: false, result: r };
    repaintDbSqlCheck();
  }, 900);
}

function repaintDbSqlCheck() {
  if (db.tab !== 'sql') return;
  if (dbSqlMode() === 'build') paintDbBuildSql();
  else paintDbSql();
}

async function runDbSql(given) {
  const area = $('#dbSqlText');
  if (!db.id) return;
  const sql = given !== undefined ? given : area ? area.value.trim() || area.placeholder : '';
  if (!sql) return;
  closeDbAc();
  const id = db.id;
  db.sql = { running: true };
  renderDbSqlResult();
  const r = await window.database.query(id, sql);
  if (db.id !== id) return;
  db.sql = r;
  renderDbSqlResult();
}

function renderDbSqlResult() {
  const out = $('#dbSqlOut');
  if (!out) return;
  out.innerHTML = '';
  const r = db.sql;
  if (!r) return;
  if (r.running) {
    out.append(dbEl('span', 'db-spin'), dbEl('span', 'db-dim', ' Running…'));
    return;
  }
  if (r.error) {
    out.appendChild(dbEl('div', 'db-error', r.error));
    return;
  }
  out.appendChild(dbEl('div', 'db-dim db-sql-status', `${dbNumber(r.rows.length)} row${r.rows.length === 1 ? '' : 's'}${r.truncated ? ` (the first ${dbNumber(r.max)}: there are more)` : ''} · ${r.ms} ms`));
  if (r.fields.length) out.appendChild(dbGrid(r.fields, r.rows));
}

// -- The names offered as the SQL is typed --
function dbSqlKey(e) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    runDbSql();
    return;
  }
  if (e.ctrlKey && (e.code === 'Space' || e.key === ' ')) {
    e.preventDefault();
    openDbAc(true);
    return;
  }
  if (!dbAc) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = dbAc.items.length;
    dbAc.at = (dbAc.at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    drawDbAc();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    takeDbAc(dbAc.at);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeDbAc();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') closeDbAc();
}

// What fits where the cursor is: { from, to (the piece of a name typed, replaced when one is taken), items }.
function sqlOffer(text, pos, cat, forced) {
  const tokens = sqlTokens(text);
  const here = tokens.find((t) => t.start < pos && pos <= t.end);
  if (here && here.type === 'comment' && (here.text.startsWith('--') || pos < here.end || here.open)) return null;
  if (here && here.type === 'string' && (pos < here.end || here.open)) return null;
  let from = pos;
  let to = pos;
  let typed = '';
  if (here && (here.type === 'word' || here.type === 'qident') && (pos === here.end || pos > here.start)) {
    from = here.start;
    to = here.end;
    typed = text.slice(here.start, pos).replace(/^"/, '');
  }
  const before = sqlSig(tokens.filter((t) => t.end <= from));
  const shape = sqlShape(sqlSig(tokens.filter((t) => t !== here)));
  const last = before[before.length - 1];
  let items = [];
  if (sqlIs(last, '.') && sqlIsName(before[before.length - 2])) {
    // after alias. or table.: its columns; after schema.: its tables
    const q = sqlName(before[before.length - 2]);
    const table = sqlTableOf(shape, cat, q) || dbFindTable(cat, null, q);
    if (table) items = table.columns.map((c) => ({ kind: 'column', label: c.name, insert: dbIdent(c.name), detail: `${c.type} · ${table.name}` }));
    else if (cat && cat.schemas.has(q) && !sqlIs(before[before.length - 3], '.')) items = [...cat.schemas.get(q).values()].map((t) => dbTableItem(t, cat, true));
  } else {
    // the SQL word the cursor is after (inside brackets: a column, a value)
    let word = null;
    let depth = 0;
    for (let i = before.length - 1; i >= 0; i--) {
      const t = before[i];
      if (sqlIs(t, ')')) depth += 1;
      else if (sqlIs(t, '(')) {
        if (depth === 0) {
          word = '(';
          break;
        }
        depth -= 1;
      } else if (depth === 0 && t.type === 'word' && DQ_KW.has(t.low)) {
        word = t.low;
        break;
      }
    }
    const afterItem = last && (last.type === 'qident' || last.type === 'number' || last.type === 'string' || sqlIs(last, ')') || (last.type === 'word' && !DQ_KW.has(last.low)));
    if (!word) items = DQ_STARTS.map(dbWordItem);
    else if (['from', 'join', 'table', 'only', 'lateral'].includes(word)) {
      if (afterItem) items = DQ_OFFER_AFTER_TABLE.map(dbWordItem);
      else if (cat) items = [...[...cat.schemas.values()].flatMap((m) => [...m.values()]).map((t) => dbTableItem(t, cat, false)), ...[...cat.schemas.keys()].map((s) => ({ kind: 'schema', label: s, insert: `${dbIdent(s)}.`, detail: 'schema', again: true }))];
    } else if (afterItem && ['select', 'by', 'distinct'].includes(word)) items = ['from', 'as', 'asc', 'desc', 'where', 'group by', 'order by', 'limit'].map(dbWordItem);
    else {
      const tables = shape.refs.map((r) => ({ r, t: dbFindTable(cat, r.schema, r.table) })).filter((x) => x.t);
      if (!tables.length && db.sel) {
        const t = dbFindTable(cat, db.sel.schema, db.sel.table);
        if (t) tables.push({ r: { alias: null, table: t.name }, t });
      }
      const count = new Map();
      for (const { t } of tables) for (const c of t.columns) count.set(c.name, (count.get(c.name) || 0) + 1);
      const cols = tables.flatMap(({ r, t }) => t.columns.map((c) => ({
        kind: 'column',
        label: c.name,
        insert: count.get(c.name) > 1 ? `${dbIdent(r.alias || t.name)}.${dbIdent(c.name)}` : dbIdent(c.name),
        detail: `${c.type} · ${r.alias || t.name}`,
      })));
      items = [...cols, ...(typed ? DQ_FUNCS.map((f) => ({ kind: 'function', label: `${f}()`, insert: `${f}(`, detail: 'function' })) : []), ...(typed || forced ? DQ_OFFER.map(dbWordItem) : [])];
    }
  }
  const low = typed.toLowerCase();
  if (!typed && !forced && !sqlIs(last, '.')) return null;
  const starts = items.filter((x) => x.label.toLowerCase().startsWith(low));
  const inside = low.length >= 2 ? items.filter((x) => !x.label.toLowerCase().startsWith(low) && x.label.toLowerCase().includes(low)) : [];
  let list = [...starts, ...inside];
  // no list for a name typed in full
  if (list.length === 1 && list[0].label.toLowerCase() === low) list = [];
  // a word typed in capitals: SQL words in capitals
  const upper = typed && typed === typed.toUpperCase() && /[A-Z]/.test(typed);
  list = list.slice(0, 60).map((x) => (x.kind === 'keyword' && upper ? { ...x, insert: x.insert.toUpperCase(), label: x.label.toUpperCase() } : x));
  return list.length ? { from, to, items: list } : null;
}

const dbWordItem = (w) => ({ kind: 'keyword', label: w, insert: /\)$/.test(w) ? w : `${w} `, detail: '' });

function dbTableItem(t, cat, afterSchema) {
  // a table of the search path by its name, any other with its schema
  const bare = afterSchema || (cat.path.includes(t.schema) && dbFindTable(cat, null, t.name) === t);
  return { kind: t.kind === 'table' ? 'table' : 'view', label: t.name, insert: bare ? dbIdent(t.name) : `${dbIdent(t.schema)}.${dbIdent(t.name)}`, detail: `${t.schema} · ${t.kind} · ${t.columns.length} columns` };
}

function openDbAc(forced) {
  const area = $('#dbSqlText');
  if (!area || area.selectionStart !== area.selectionEnd) return closeDbAc();
  const cat = dbCatalog();
  const offer = sqlOffer(area.value, area.selectionStart, cat, forced);
  if (!offer) return closeDbAc();
  dbAc = { ...offer, at: 0 };
  drawDbAc();
}

function closeDbAc() {
  dbAc = null;
  const list = $('#dbAc');
  if (list) list.remove();
  const area = $('#dbSqlText');
  if (area) {
    area.removeAttribute('aria-activedescendant');
    area.setAttribute('aria-expanded', 'false');
  }
}

const DB_AC_MARK = { table: 'T', view: 'V', schema: 'S', column: 'C', function: 'F', keyword: 'K' };

function drawDbAc() {
  const area = $('#dbSqlText');
  if (!area || !dbAc) return;
  let list = $('#dbAc');
  if (!list) {
    list = dbEl('div', 'db-ac');
    list.id = 'dbAc';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Names that fit here');
    // a click takes one, the text keeps the cursor
    list.addEventListener('mousedown', (e) => e.preventDefault());
    area.parentElement.appendChild(list);
    area.setAttribute('aria-controls', 'dbAc');
  }
  list.innerHTML = '';
  dbAc.items.forEach((x, i) => {
    const row = dbEl('div', 'db-ac-item');
    row.id = `dbAc${i}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === dbAc.at));
    const mark = dbEl('span', `db-ac-kind db-ac-${x.kind}`, DB_AC_MARK[x.kind]);
    mark.title = x.kind;
    row.append(mark, dbEl('span', 'db-ac-name', x.label));
    if (x.detail) row.appendChild(dbEl('span', 'db-ac-detail', x.detail));
    row.addEventListener('click', () => takeDbAc(i));
    list.appendChild(row);
  });
  area.setAttribute('aria-expanded', 'true');
  area.setAttribute('aria-activedescendant', `dbAc${dbAc.at}`);
  const chosen = $(`#dbAc${dbAc.at}`);
  if (chosen) chosen.scrollIntoView({ block: 'nearest' });
  // under the start of the name typed
  const xy = dbCaretXY(area, dbAc.from);
  const width = area.parentElement.clientWidth;
  list.style.left = `${Math.max(0, Math.min(xy.x, width - list.offsetWidth - 4))}px`;
  list.style.top = `${xy.y + xy.line + 2}px`;
}

function takeDbAc(i) {
  const area = $('#dbSqlText');
  const x = dbAc && dbAc.items[i];
  if (!area || !x) return;
  const { from, to } = dbAc;
  closeDbAc();
  area.focus();
  area.setSelectionRange(from, to);
  // as typed: Undo takes it back
  if (!document.execCommand('insertText', false, x.insert)) {
    area.setRangeText(x.insert, from, to, 'end');
    area.dispatchEvent(new Event('input'));
  }
  if (x.again) openDbAc(true);
}

// Where a place of the text is in its box (from its top left, the scroll taken off), and the height of a line.
function dbCaretXY(area, at) {
  const mirror = dbEl('div');
  const cs = getComputedStyle(area);
  for (const p of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize']) mirror.style[p] = cs[p];
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '0' });
  mirror.style.width = `${area.clientWidth + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)}px`;
  mirror.textContent = area.value.slice(0, at);
  const mark = dbEl('span', '', '​');
  mirror.appendChild(mark);
  area.parentElement.appendChild(mirror);
  const xy = { x: parseFloat(cs.borderLeftWidth) + mark.offsetLeft - area.scrollLeft, y: parseFloat(cs.borderTopWidth) + mark.offsetTop - area.scrollTop, line: parseFloat(cs.lineHeight) || 18 };
  mirror.remove();
  return xy;
}

// -- Build: the query from blocks --
const dbBuilds = () => {
  try {
    return JSON.parse(dbLoad(DB_BUILD_KEY) || '{}');
  } catch {
    return {};
  }
};
let dbBuildState = null; // { id, b }

function dbBuild() {
  if (!dbBuildState || dbBuildState.id !== db.id) dbBuildState = { id: db.id, b: dbBuilds()[db.id] || null };
  return dbBuildState.b;
}

function saveDbBuild(b) {
  dbBuildState = { id: db.id, b };
  const all = dbBuilds();
  all[db.id] = b;
  dbStore(DB_BUILD_KEY, JSON.stringify(all));
}

// customer → c, purchase_item → pi: short, and not one already taken
function dbAlias(table, taken) {
  const base = (table.match(/[a-z]/gi) ? table.split(/[_\W]+/).filter(Boolean).map((p) => p[0]).join('') : 't').toLowerCase() || 't';
  let alias = DQ_KW.has(base) ? `${base}1` : base;
  for (let n = 2; taken.includes(alias); n++) alias = `${base}${n}`;
  return alias;
}

function newDbBuild(t) {
  return { base: { schema: t.schema, table: t.name, alias: dbAlias(t.name, []) }, joins: [], cols: [], distinct: false, count: false, where: [], group: null, having: null, order: [], limit: 50 };
}

// The tables of the query, by alias: the first, then each join.
function dbBuildTables(b, cat) {
  return [b.base, ...b.joins].map((x) => ({ ...x, t: dbFindTable(cat, x.schema, x.table) })).filter((x) => x.t);
}

// The columns to choose from: alias.column, its type.
function dbBuildColumns(b, cat) {
  return dbBuildTables(b, cat).flatMap((x) => x.t.columns.map((c) => ({ key: `${x.alias}.${c.name}`, label: b.joins.length ? `${x.alias}.${c.name}` : c.name, type: c.type })));
}

// How a joined table meets the others: a foreign key between them, else a column called after the other (customer_id),
// else the first columns.
function dbJoinOn(b, cat, join) {
  const right = dbFindTable(cat, join.schema, join.table);
  for (const left of dbBuildTables(b, cat).filter((x) => x.alias !== join.alias)) {
    for (const fk of cat.fks) {
      if (fk.schema === join.schema && fk.table === join.table && fk.refSchema === left.schema && fk.refTable === left.table) return [`${join.alias}.${fk.columns[0]}`, `${left.alias}.${fk.refColumns[0]}`];
      if (fk.schema === left.schema && fk.table === left.table && fk.refSchema === join.schema && fk.refTable === join.table) return [`${join.alias}.${fk.refColumns[0]}`, `${left.alias}.${fk.columns[0]}`];
    }
    if (right && right.colSet.has(`${left.table}_id`) && left.t.colSet.has('id')) return [`${join.alias}.${left.table}_id`, `${left.alias}.id`];
    if (right && left.t.colSet.has(`${join.table}_id`) && right.colSet.has('id')) return [`${join.alias}.id`, `${left.alias}.${join.table}_id`];
  }
  const first = right && right.columns[0] ? right.columns[0].name : 'id';
  const base = dbFindTable(cat, b.base.schema, b.base.table);
  return [`${join.alias}.${first}`, `${b.base.alias}.${base && base.columns[0] ? base.columns[0].name : 'id'}`];
}

// A value as the column takes it: a number or true/false as it is, anything else quoted.
function dbSqlValue(v, type) {
  const s = String(v).trim();
  if (/^(smallint|integer|bigint|numeric|decimal|real|double precision|money)/.test(type || '') && /^-?\d+(\.\d+)?$/.test(s)) return s;
  if (type === 'boolean' && /^(true|false)$/i.test(s)) return s.toLowerCase();
  return `'${String(v).replace(/'/g, "''")}'`;
}

// The SQL the blocks make.
function dbBuildSql(b, cat) {
  if (!b || !cat) return '';
  const cols = dbBuildColumns(b, cat);
  const typeOf = new Map(cols.map((c) => [c.key, c.type]));
  const multi = b.joins.length > 0;
  const ref = (key) => {
    const at = key.indexOf('.');
    return multi ? `${key.slice(0, at)}.${dbIdent(key.slice(at + 1))}` : dbIdent(key.slice(at + 1));
  };
  const ok = (key) => typeOf.has(key);
  const picked = [...b.cols.filter(ok).map(ref), ...(b.count ? ['count(*)'] : [])];
  const lines = [`select ${b.distinct ? 'distinct ' : ''}${picked.length ? picked.join(', ') : '*'}`];
  lines.push(`from ${dbIdent(b.base.schema)}.${dbIdent(b.base.table)}${multi ? ` ${b.base.alias}` : ''}`);
  for (const j of b.joins) if (ok(j.on[0]) && ok(j.on[1])) lines.push(`  ${j.type} ${dbIdent(j.schema)}.${dbIdent(j.table)} ${j.alias} on ${ref(j.on[0])} = ${ref(j.on[1])}`);
  const conds = b.where.filter((w) => ok(w.col) && (/null$/.test(w.op) || String(w.value).trim() !== '')).map((w) => {
    if (/null$/.test(w.op)) return `${ref(w.col)} ${w.op}`;
    if (/in$/.test(w.op)) return `${ref(w.col)} ${w.op} (${String(w.value).split(',').map((x) => x.trim()).filter(Boolean).map((x) => dbSqlValue(x, typeOf.get(w.col))).join(', ')})`;
    return `${ref(w.col)} ${w.op} ${dbSqlValue(w.value, typeOf.get(w.col))}`;
  });
  conds.forEach((c, i) => lines.push(`${i ? '  and' : 'where'} ${c}`));
  if (b.group && b.group.filter(ok).length) lines.push(`group by ${b.group.filter(ok).map(ref).join(', ')}`);
  if (b.group && b.having && /^-?\d+$/.test(String(b.having.value).trim())) lines.push(`having count(*) ${b.having.op} ${String(b.having.value).trim()}`);
  const order = b.order.filter((o) => o.col === 'count(*)' ? b.count : ok(o.col)).map((o) => `${o.col === 'count(*)' ? 'count(*)' : ref(o.col)} ${o.dir}`);
  if (order.length) lines.push(`order by ${order.join(', ')}`);
  lines.push(`limit ${Math.max(1, Math.min(1000, Math.round(Number(b.limit)) || 50))}`);
  return lines.join('\n');
}

// From the table chosen on the left: a new query of it, unless the one built has more than its table.
function dbBuildFromTable(schema, table) {
  const cat = dbCat.token === db.token ? dbCat.data : null;
  const t = dbFindTable(cat, schema, table);
  const b = dbBuild();
  if (!t || (b && (b.joins.length || b.where.length || b.group))) return;
  saveDbBuild(newDbBuild(t));
}

function dbSelect(options, value, label, onChange, key) {
  const s = dbEl('select', 'input db-build-select');
  s.setAttribute('aria-label', label);
  s.dataset.key = key;
  for (const o of options) {
    if (o.group) {
      const g = document.createElement('optgroup');
      g.label = o.group;
      for (const x of o.options) g.appendChild(new Option(x.label, x.value));
      s.appendChild(g);
    } else s.appendChild(new Option(o.label, o.value));
  }
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function dbChip(label, on, onClick, key, title = '') {
  const c = dbEl('button', 'db-chip', label);
  c.type = 'button';
  c.dataset.key = key;
  if (on !== null) c.setAttribute('aria-pressed', String(on));
  if (title) c.title = title;
  c.addEventListener('click', onClick);
  return c;
}

function dbBuildRow(key, ...content) {
  const row = dbEl('div', 'db-build-row');
  row.appendChild(dbEl('span', 'db-build-key', key));
  const line = dbEl('div', 'db-build-line');
  line.append(...content);
  row.appendChild(line);
  return row;
}

function dbRemoveBtn(label, onClick, key) {
  const x = dbEl('button', 'db-build-x', '×');
  x.type = 'button';
  x.title = label;
  x.setAttribute('aria-label', label);
  x.dataset.key = key;
  x.addEventListener('click', onClick);
  return x;
}

// The blocks: drawn again after each change, the focus kept on the control changed.
function renderDbBuild(focusKey = null) {
  const box = $('#dbSqlBox');
  if (!box) return;
  const keep = focusKey || (document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.key : null);
  box.innerHTML = '';
  const cat = dbCatalog();
  if (!cat) {
    box.appendChild(dbEl(dbCat.error && dbCat.token === db.token ? 'div' : 'span', dbCat.error && dbCat.token === db.token ? 'db-error' : 'db-dim', dbCat.error && dbCat.token === db.token ? dbCat.error : db.id ? 'Reading the tables of the connection…' : ''));
    return;
  }
  let b = dbBuild();
  const all = [...cat.schemas.values()].flatMap((m) => [...m.values()]);
  if (!all.length) {
    box.appendChild(dbEl('div', 'db-note', 'No table this user can read.'));
    return;
  }
  if (!b || !dbFindTable(cat, b.base.schema, b.base.table)) {
    const start = (db.sel && dbFindTable(cat, db.sel.schema, db.sel.table)) || all.find((t) => cat.path.includes(t.schema)) || all[0];
    b = newDbBuild(start);
    saveDbBuild(b);
  }
  const change = (fn, key) => {
    const next = JSON.parse(JSON.stringify(b));
    fn(next);
    saveDbBuild(next);
    renderDbBuild(key);
  };
  const tableOptions = [...cat.schemas].filter(([, m]) => m.size).map(([s, m]) => ({ group: s, options: [...m.values()].map((t) => ({ label: `${dbTableKey(t)}${t.kind === 'table' ? '' : ` (${t.kind})`}`, value: dbTableKey(t) })) }));
  const cols = dbBuildColumns(b, cat);
  const colOptions = cols.map((c) => ({ label: c.label, value: c.key }));
  const panel = dbEl('div', 'db-build');
  panel.id = 'dbBuildPanel';
  // FROM
  panel.appendChild(dbBuildRow('FROM', dbSelect(tableOptions, `${b.base.schema}.${b.base.table}`, 'The table', (v) => change((n) => {
    const t = all.find((x) => dbTableKey(x) === v);
    Object.assign(n, newDbBuild(t));
  }, 'from'), 'from')));
  // JOIN
  b.joins.forEach((j, i) => {
    const joinOptions = colOptions;
    panel.appendChild(dbBuildRow(
      'JOIN',
      dbSelect([{ label: 'join', value: 'join' }, { label: 'left join', value: 'left join' }], j.type, 'The kind of join', (v) => change((n) => (n.joins[i].type = v), `jt${i}`), `jt${i}`),
      dbSelect(tableOptions, `${j.schema}.${j.table}`, 'The table joined', (v) => change((n) => {
        const t = all.find((x) => dbTableKey(x) === v);
        const taken = [n.base.alias, ...n.joins.filter((_, k) => k !== i).map((x) => x.alias)];
        n.joins[i] = { ...n.joins[i], schema: t.schema, table: t.name, alias: dbAlias(t.name, taken) };
        n.joins[i].on = dbJoinOn(n, cat, n.joins[i]);
      }, `jn${i}`), `jn${i}`),
      dbEl('span', 'db-dim', 'on'),
      dbSelect(joinOptions, j.on[0], 'Its column', (v) => change((n) => (n.joins[i].on[0] = v), `jl${i}`), `jl${i}`),
      dbEl('span', 'db-dim', '='),
      dbSelect(joinOptions, j.on[1], 'The column it meets', (v) => change((n) => (n.joins[i].on[1] = v), `jr${i}`), `jr${i}`),
      dbRemoveBtn('Take this join out', () => change((n) => {
        const gone = n.joins[i].alias;
        n.joins.splice(i, 1);
        const left = (k) => !k.startsWith(`${gone}.`);
        n.cols = n.cols.filter(left);
        n.where = n.where.filter((w) => left(w.col));
        n.order = n.order.filter((o) => o.col === 'count(*)' || left(o.col));
        if (n.group) n.group = n.group.filter(left);
      }, 'addJoin'), `jx${i}`)
    ));
  });
  // SELECT
  const picks = cols.map((c) => dbChip(c.label, b.cols.includes(c.key), () => change((n) => {
    n.cols = n.cols.includes(c.key) ? n.cols.filter((k) => k !== c.key) : [...n.cols, c.key];
  }, `c:${c.key}`), `c:${c.key}`, c.type));
  picks.push(dbChip('count(*)', b.count, () => change((n) => {
    n.count = !n.count;
    if (!n.count) n.order = n.order.filter((o) => o.col !== 'count(*)');
  }, 'count'), 'count', 'How many rows (with GROUP BY: in each group)'));
  if (!b.cols.length && !b.count) picks.push(dbEl('span', 'db-dim', 'none chosen: all of them (*)'));
  panel.appendChild(dbBuildRow('SELECT', ...picks));
  // WHERE
  const whereLine = [];
  b.where.forEach((w, i) => {
    const cond = dbEl('span', 'db-build-cond');
    cond.append(
      dbSelect(colOptions, w.col, 'The column', (v) => change((n) => (n.where[i].col = v), `wc${i}`), `wc${i}`),
      dbSelect(DB_BUILD_OPS.map((o) => ({ label: o, value: o })), w.op, 'How it compares', (v) => change((n) => (n.where[i].op = v), `wo${i}`), `wo${i}`)
    );
    if (!/null$/.test(w.op)) {
      const value = dbEl('input', 'input db-build-value');
      value.value = w.value;
      value.dataset.key = `wv${i}`;
      value.spellcheck = false;
      value.placeholder = /in$/.test(w.op) ? 'a, b, c' : /like$/.test(w.op) ? '%part%' : 'value';
      value.setAttribute('aria-label', 'The value');
      value.addEventListener('input', () => {
        b.where[i].value = value.value;
        saveDbBuild(b);
        paintDbBuildSql();
      });
      cond.appendChild(value);
    }
    cond.appendChild(dbRemoveBtn('Take this condition out', () => change((n) => n.where.splice(i, 1), 'addWhere'), `wx${i}`));
    whereLine.push(cond);
  });
  whereLine.push(dbChip(b.where.length ? '+ and' : '+ condition', null, () => change((n) => n.where.push({ col: cols[0].key, op: '=', value: '' }), `wv${b.where.length}`), 'addWhere'));
  panel.appendChild(dbBuildRow('WHERE', ...whereLine));
  // GROUP BY, HAVING
  if (b.group) {
    const groupChips = cols.map((c) => dbChip(c.label, b.group.includes(c.key), () => change((n) => {
      n.group = n.group.includes(c.key) ? n.group.filter((k) => k !== c.key) : [...n.group, c.key];
    }, `g:${c.key}`), `g:${c.key}`));
    groupChips.push(dbRemoveBtn('Take GROUP BY out', () => change((n) => {
      n.group = null;
      n.having = null;
    }, 'addGroup'), 'gx'));
    panel.appendChild(dbBuildRow('GROUP BY', ...groupChips));
    if (b.having) {
      const value = dbEl('input', 'input db-build-value db-build-num');
      value.value = b.having.value;
      value.dataset.key = 'hv';
      value.inputMode = 'numeric';
      value.placeholder = '1';
      value.setAttribute('aria-label', 'How many');
      value.addEventListener('input', () => {
        b.having.value = value.value;
        saveDbBuild(b);
        paintDbBuildSql();
      });
      panel.appendChild(dbBuildRow(
        'HAVING',
        dbEl('span', 'db-build-fixed', 'count(*)'),
        dbSelect(['=', '!=', '>', '>=', '<', '<='].map((o) => ({ label: o, value: o })), b.having.op, 'How it compares', (v) => change((n) => (n.having.op = v), 'ho'), 'ho'),
        value,
        dbRemoveBtn('Take HAVING out', () => change((n) => (n.having = null), 'addHaving'), 'hx')
      ));
    }
  }
  // ORDER BY
  const orderOptions = [{ label: '(none)', value: '' }, ...colOptions, ...(b.count ? [{ label: 'count(*)', value: 'count(*)' }] : [])];
  const orders = b.order.length ? b.order : [{ col: '', dir: 'asc' }];
  const orderLine = [];
  orders.forEach((o, i) => {
    const one = dbEl('span', 'db-build-cond');
    one.append(
      dbSelect(orderOptions, o.col, 'Sorted by', (v) => change((n) => {
        if (!n.order.length) n.order = [{ col: '', dir: 'asc' }];
        n.order[i].col = v;
        n.order = n.order.filter((x, k) => x.col || k === 0);
        if (!n.order[0].col && n.order.length === 1) n.order = [];
      }, `oc${i}`), `oc${i}`),
      dbSelect([{ label: 'asc', value: 'asc' }, { label: 'desc', value: 'desc' }], o.dir, 'Which way', (v) => change((n) => {
        if (!n.order.length) n.order = [{ col: '', dir: 'asc' }];
        n.order[i].dir = v;
      }, `od${i}`), `od${i}`)
    );
    if (i > 0) one.appendChild(dbRemoveBtn('Take this out', () => change((n) => n.order.splice(i, 1), `oc${i - 1}`), `ox${i}`));
    orderLine.push(one);
  });
  if (b.order.length && b.order[b.order.length - 1].col) orderLine.push(dbChip('+ then by', null, () => change((n) => n.order.push({ col: '', dir: 'asc' }), `oc${b.order.length}`), 'addOrder'));
  panel.appendChild(dbBuildRow('ORDER BY', ...orderLine));
  // LIMIT
  const limit = dbEl('input', 'input db-build-value db-build-num');
  limit.type = 'number';
  limit.min = '1';
  limit.max = '1000';
  limit.step = '1';
  limit.value = b.limit;
  limit.dataset.key = 'limit';
  limit.setAttribute('aria-label', 'At most this many rows');
  limit.addEventListener('input', () => {
    b.limit = limit.value;
    saveDbBuild(b);
    paintDbBuildSql();
  });
  panel.appendChild(dbBuildRow('LIMIT', limit, dbEl('span', 'db-dim', 'rows, up to 1000')));
  box.appendChild(panel);
  // more blocks
  const more = dbEl('div', 'db-build-more');
  more.appendChild(dbChip('+ JOIN', null, () => change((n) => {
    const linked = cat.fks.filter((f) => (f.refSchema === n.base.schema && f.refTable === n.base.table) || (f.schema === n.base.schema && f.table === n.base.table));
    const pick = linked.length ? (linked[0].refTable === n.base.table && linked[0].refSchema === n.base.schema ? { schema: linked[0].schema, table: linked[0].table } : { schema: linked[0].refSchema, table: linked[0].refTable }) : all.find((t) => dbTableKey(t) !== `${n.base.schema}.${n.base.table}`) || all[0];
    const name = pick.table || pick.name;
    const join = { type: 'join', schema: pick.schema, table: name, alias: dbAlias(name, [n.base.alias, ...n.joins.map((x) => x.alias)]) };
    join.on = dbJoinOn(n, cat, join);
    n.joins.push(join);
  }, `jn${b.joins.length}`), 'addJoin', 'Another table, met by a column (a foreign key when there is one)'));
  if (!b.group) more.appendChild(dbChip('+ GROUP BY', null, () => change((n) => {
    n.group = n.cols.length ? [...n.cols] : [cols[0].key];
    if (!n.cols.length) n.cols = [...n.group];
    n.count = true;
  }, 'addHaving'), 'addGroup', 'Rows in groups of the same values, with how many in each'));
  if (b.group && !b.having) more.appendChild(dbChip('+ HAVING', null, () => change((n) => (n.having = { op: '>', value: '1' }), 'hv'), 'addHaving', 'Only the groups with more (or fewer) rows than this'));
  more.appendChild(dbChip('DISTINCT', b.distinct, () => change((n) => (n.distinct = !n.distinct), 'distinct'), 'distinct', 'Each row once'));
  box.appendChild(more);
  const sql = dbEl('pre', 'db-build-sql');
  sql.id = 'dbBuildSql';
  sql.setAttribute('aria-label', 'The SQL of the blocks');
  box.appendChild(sql);
  const check = dbEl('div', 'db-sql-check');
  check.id = 'dbSqlCheck';
  check.setAttribute('aria-live', 'polite');
  box.appendChild(check);
  const bar = dbEl('div', 'db-sql-bar');
  const run = dbEl('button', 'btn btn-primary btn-sm', 'Run');
  run.id = 'dbRunBtn';
  run.type = 'button';
  run.title = 'Run it (Cmd+Enter)';
  run.addEventListener('click', () => runDbSql(dbBuildSql(dbBuild(), cat)));
  const edit = dbEl('button', 'btn btn-sm', 'Edit as SQL');
  edit.type = 'button';
  edit.id = 'dbBuildEdit';
  edit.title = 'Take this SQL to Write, to change it by hand (it takes the place of what is there)';
  edit.addEventListener('click', () => {
    saveDbSql(dbBuildSql(dbBuild(), cat));
    setDbSqlMode('write');
    const area = $('#dbSqlText');
    if (area) area.setSelectionRange(area.value.length, area.value.length);
  });
  bar.append(run, edit, dbEl('span', 'db-dim', 'Only what fits is offered: the tables and columns of the connection'));
  box.appendChild(bar);
  box.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runDbSql(dbBuildSql(dbBuild(), cat));
    }
  };
  paintDbBuildSql();
  const again = keep && box.querySelector(`[data-key="${CSS.escape(keep)}"]`);
  if (again) again.focus();
}

// The SQL under the blocks, in colour, and what PostgreSQL says of it.
function paintDbBuildSql() {
  const pre = $('#dbBuildSql');
  if (!pre) return;
  const cat = dbCat.token === db.token ? dbCat.data : null;
  const text = dbBuildSql(dbBuild(), cat);
  const key = `${db.id}\n${text}`;
  const answer = dbSqlCheck.key === key ? dbSqlCheck.result : null;
  const problem = answer && answer.problem ? dbProblemAt(text, answer.problem) : null;
  pre.innerHTML = sqlHighlight(text, problem && problem.start !== null ? [problem] : []);
  const box = $('#dbSqlCheck');
  if (box) {
    box.innerHTML = '';
    box.className = 'db-sql-check';
    if (problem) box.appendChild(dbEl('span', 'db-sql-problem', problem.message));
    else if (dbSqlCheck.key === key && dbSqlCheck.running) box.appendChild(dbEl('span', 'db-dim', 'PostgreSQL is reading it…'));
    else if (answer && answer.error) box.appendChild(dbEl('span', 'db-dim', `Not checked: ${answer.error}`));
    else if (answer && answer.ok) box.appendChild(dbEl('span', 'db-sql-good', 'PostgreSQL reads it: names and syntax are right'));
  }
  scheduleDbSqlCheck(() => ($('#dbBuildSql') ? dbBuildSql(dbBuild(), dbCat.token === db.token ? dbCat.data : null) : null), []);
}
