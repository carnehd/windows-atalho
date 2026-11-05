// New database (Database page): a database for a microservice in a local PostgreSQL, with its schema and two users,
// one that makes the tables (DDL: migrations) and one for the application (DML: rows only), as teams do it by hand
// with a script. The PostgreSQL is a container that runs on this computer (docker or podman exec) or a pod of a
// local Kubernetes cluster (kubectl or oc exec). The SQL is written here from the values of the form and given to
// psql inside the container through its input, so nothing of it goes to a file or to the command line; the admin
// password, when PostgreSQL asks for one, goes the same way and is never kept. What is there already is kept as it
// is (a user, the database), so it can run again. The same SQL as a PowerShell or Bash script to run by hand, and
// the lines the microservice needs to connect, come from here too.
const { spawn } = require('child_process');
const { ipcMain } = require('electron');
const shell = require('./shell');
const { engineCall, runningContainers } = require('./containers');

const NAME = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const PERMS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const TOOLS = ['kubectl', 'oc'];
const MIGRATIONS = ['flyway', 'liquibase', 'none'];
const POSTGRES_IMAGE = /(^|[/_-])(postgres|postgresql|postgis|timescaledb|pgvector)([:@/_-]|$)/i;
const K8S_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,252}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_./=,!()\s-]{0,300}$/;
// A context that is a cluster on this computer; any other asks first, and one that reads as production is refused
const LOCAL_CONTEXT = /^(minikube|docker-desktop|docker-for-desktop|rancher-desktop|orbstack|microk8s|colima(-.+)?|kind(-.+)?|k3d-.+|crc(-.+)?|podman-desktop.*)$/i;
const PRODUCTION = /(^|[^a-z])(prd|prod|production)([^a-z]|$)/i;
const RUN_TIMEOUT_MS = 120000;
const FIND_TIMEOUT_MS = 20000;
// Reads the admin password from the first line of its input (empty for none), then psql reads the SQL from the
// rest; -w: it never asks for a password itself (with no terminal it would take a line of the SQL for one)
const RUNNER = 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -X -At -w -v ON_ERROR_STOP=1 -U "$0" -d postgres';

// Marks around a value (where it goes shows in the page) and around a password (hidden there until asked for)
const V = (text) => `\u0001${text}\u0002`;
const P = (text) => `\u0003${text}\u0004`;
const plain = (text) => String(text).replace(/[\u0001-\u0004]/g, '');

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const lit = (text) => `'${String(text).replace(/'/g, "''")}'`;
// the schema of a database's name: what is not a letter, a digit or _ becomes _
const schemaOf = (database) => String(database || '').trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').slice(0, 63);

// The values of the form, as they are used, and what is wrong with them (nothing: it can run).
function readValues(input = {}) {
  const str = (v) => String(v ?? '').trim();
  const v = {
    database: str(input.database),
    schema: str(input.schema),
    ddlUser: str(input.ddlUser),
    ddlPassword: String(input.ddlPassword ?? ''),
    dmlUser: str(input.dmlUser),
    dmlPassword: String(input.dmlPassword ?? ''),
    perms: PERMS.filter((p) => Array.isArray(input.perms) && input.perms.includes(p)),
    host: str(input.host) || 'localhost',
    port: Number(input.port) || 5432,
    migrations: MIGRATIONS.includes(input.migrations) ? input.migrations : 'flyway',
    format: input.format === 'env' ? 'env' : 'props',
  };
  const problems = [];
  const name = (value, what) => {
    if (!value) problems.push(`${what}: its name`);
    else if (!NAME.test(value)) problems.push(`${what}: letters, digits, _ and - (it starts with a letter or _), up to 63`);
  };
  name(v.database, 'The database');
  name(v.schema, 'The schema');
  name(v.ddlUser, 'The DDL user');
  name(v.dmlUser, 'The DML user');
  if (v.ddlUser && v.ddlUser === v.dmlUser) problems.push('The DDL user and the DML user are two users: one makes the tables, the other only uses them');
  for (const [pw, what] of [[v.ddlPassword, 'DDL'], [v.dmlPassword, 'DML']]) {
    if (!pw) problems.push(`The password of the ${what} user`);
    else if (/[\u0000-\u001f]/.test(pw) || pw.length > 200) problems.push(`The password of the ${what} user: one line, up to 200 characters`);
  }
  if (!v.perms.length) problems.push('The DML user may do one thing at least (SELECT)');
  if (!/^[A-Za-z0-9._:-]{1,255}$/.test(v.host)) problems.push('The address for the microservice: a name or an address, as localhost');
  if (!Number.isInteger(v.port) || v.port < 1 || v.port > 65535) problems.push('The port for the microservice: a number from 1 to 65535');
  return { v, problems };
}

// The SQL, for psql as the admin user: the two users and the database when they are not there (what is there is
// kept as it is, and said), then the schema and who may do what in it. Marked: see V and P.
function sqlFor(v) {
  const db = ident(v.database);
  const schema = ident(v.schema);
  const ddl = ident(v.ddlUser);
  const dml = ident(v.dmlUser);
  const perms = v.perms.join(', ');
  const user = (name, password, what) => [
    `SELECT ${lit(`${what} user ${name}: there already, kept as it is (its password too)`)} WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(name)});`,
    `SELECT format('CREATE USER %I WITH PASSWORD %L', ${V(lit(name))}, ${P(lit(password))}) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(name)}) \\gexec`,
  ];
  return [
    `-- A database for a microservice: its schema, a user that makes the tables (${v.ddlUser}) and one for the application (${v.dmlUser}).`,
    '-- Written by Git Quick. What is there already is kept as it is, so it can run again.',
    '\\set ON_ERROR_STOP on',
    '',
    '\\echo Users',
    ...user(v.ddlUser, v.ddlPassword, 'DDL'),
    ...user(v.dmlUser, v.dmlPassword, 'DML'),
    '',
    '\\echo Database',
    `SELECT ${lit(`database ${v.database}: there already, kept as it is`)} WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = ${lit(v.database)});`,
    `SELECT format('CREATE DATABASE %I OWNER %I', ${V(lit(v.database))}, ${V(lit(v.ddlUser))}) WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${lit(v.database)}) \\gexec`,
    `REVOKE ALL ON DATABASE ${V(db)} FROM PUBLIC;`,
    `\\connect ${V(db)}`,
    '',
    '\\echo Schema and permissions',
    `CREATE SCHEMA IF NOT EXISTS ${V(schema)};`,
    `REVOKE ALL ON SCHEMA ${V(schema)} FROM PUBLIC;`,
    `GRANT ALL PRIVILEGES ON SCHEMA ${V(schema)} TO ${V(ddl)};`,
    `GRANT ALL PRIVILEGES ON DATABASE ${V(db)} TO ${V(ddl)};`,
    `GRANT CONNECT ON DATABASE ${V(db)} TO ${V(dml)};`,
    `GRANT USAGE ON SCHEMA ${V(schema)} TO ${V(dml)};`,
    '-- the DML user: the rows of the tables only',
    `GRANT ${V(perms)} ON ALL TABLES IN SCHEMA ${V(schema)} TO ${V(dml)};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${V(schema)} TO ${V(dml)};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${V(ddl)} IN SCHEMA ${V(schema)} GRANT ${V(perms)} ON TABLES TO ${V(dml)};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${V(ddl)} IN SCHEMA ${V(schema)} GRANT USAGE, SELECT ON SEQUENCES TO ${V(dml)};`,
    '',
    '\\echo Done',
  ].join('\n');
}

// Where PostgreSQL is, checked: a container of this computer, or a pod of a cluster.
function readTarget(input = {}) {
  const admin = String(input.admin ?? '').trim() || 'postgres';
  if (!NAME.test(admin)) throw new Error('The admin user: its name, as postgres');
  if (input.kind === 'kube') {
    const tool = TOOLS.includes(input.tool) ? input.tool : 'kubectl';
    const context = String(input.context ?? '').trim();
    const namespace = String(input.namespace ?? '').trim() || 'postgres';
    const label = String(input.label ?? '').trim() || 'app.kubernetes.io/name=postgresql';
    if (!K8S_NAME.test(context)) throw new Error('Choose the cluster (the context) it runs in');
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)) throw new Error('The namespace: lowercase letters, digits and -');
    if (!LABEL.test(label)) throw new Error('The label of the pod, as app.kubernetes.io/name=postgresql');
    return { kind: 'kube', tool, context, namespace, label, admin, local: LOCAL_CONTEXT.test(context), production: PRODUCTION.test(context) };
  }
  const container = String(input.container ?? '').trim();
  const engine = input.engine === 'podman' ? 'podman' : 'docker';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) throw new Error('Choose the PostgreSQL container');
  return { kind: 'container', engine, container, admin, local: true, production: false };
}

// The command that runs psql in it, as a list (no shell on this computer): the tool, then its arguments.
function execArgs(target, pod = '') {
  if (target.kind === 'kube') return ['--context', target.context, 'exec', '-i', pod, '-n', target.namespace, '--', 'sh', '-c', RUNNER, target.admin];
  return ['exec', '-i', target.container, 'sh', '-c', RUNNER, target.admin];
}

const findPodArgs = (target) => ['--context', target.context, 'get', 'pods', '-n', target.namespace, '-l', target.label, '--field-selector', 'status.phase=Running', '-o', 'jsonpath={.items[0].metadata.name}'];

// The same SQL to run by hand: in PowerShell and in Bash. It goes to the container as Base64, as the scripts of the
// teams do, so its quotes arrive whole; psql asks for the admin password there when it needs one.
function scriptsFor(target, sql) {
  const psql = `psql -X -U ${target.admin} -d postgres`;
  let find = { powershell: [], bash: [] };
  let exec;
  if (target.kind === 'kube') {
    const base = `${V(target.tool)} --context ${V(target.context)}`;
    const get = `get pods -n ${V(target.namespace)} -l ${V(target.label)} --field-selector status.phase=Running -o jsonpath="{.items[0].metadata.name}"`;
    find = { powershell: ['# The pod of PostgreSQL', `$pod = ${base} ${get}`], bash: ['# The pod of PostgreSQL', `pod=$(${base} ${get})`] };
    exec = (pod) => `${base} exec -it ${pod} -n ${V(target.namespace)} --`;
  } else exec = () => `${V(target.engine)} exec -it ${V(target.container)}`;
  const powershell = [
    '# A database for a microservice (written by Git Quick): run it all, in the same PowerShell',
    "$sql = @'",
    sql,
    "'@",
    '$encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($sql))',
    '',
    ...find.powershell,
    `${exec('$pod')} sh -c "echo '$encoded' | base64 -d | ${psql}"`,
  ].join('\n');
  const bash = [
    '# A database for a microservice (written by Git Quick): run it all, in the same shell',
    "encoded=$(base64 <<'SQL' | tr -d '\\n'",
    sql,
    'SQL',
    ')',
    '',
    ...find.bash,
    `${exec('"$pod"')} sh -c "echo '$encoded' | base64 -d | ${psql}"`,
  ].join('\n');
  return { powershell, bash };
}

// What the microservice needs to connect: the application as the DML user; its migrations as the DDL user. As lines
// of its application properties, or (format 'env') as environment variables to give it when it starts, for a
// service that takes them from the environment (a Secret, at work): Spring's own names, which take the place of
// what its file says whatever names that uses.
function propsFor(v) {
  const env = v.format === 'env';
  const name = (key) => (env ? key.toUpperCase().replace(/[.-]/g, '_') : key);
  const lines = [
    `${name('spring.datasource.url')}=jdbc:postgresql://${V(v.host)}:${V(v.port)}/${V(v.database)}?currentSchema=${V(v.schema)}`,
    `${name('spring.datasource.username')}=${V(v.dmlUser)}`,
    `${name('spring.datasource.password')}=${P(v.dmlPassword)}`,
  ];
  if (v.migrations !== 'none') {
    const key = `spring.${v.migrations}`;
    lines.push(`# the migrations, as the user that makes the tables`, `${name(`${key}.user`)}=${V(v.ddlUser)}`, `${name(`${key}.password`)}=${P(v.ddlPassword)}`, `${name(`${key}.default-schema`)}=${V(v.schema)}`);
  }
  return lines.join('\n');
}

// What PostgreSQL said, in a line a person reads, when it did not go well.
function explain(text, target) {
  const t = String(text || '');
  if (/no password supplied|password authentication failed/i.test(t)) return /no password supplied/i.test(t) ? `PostgreSQL asks for the password of ${target.admin}: type it in Admin password and run again` : `PostgreSQL did not accept the password of ${target.admin}`;
  if (/role "[^"]*" does not exist/i.test(t) && new RegExp(`role "${target.admin}" does not exist`, 'i').test(t)) return `There is no user ${target.admin} in this PostgreSQL: put its admin user in Admin user`;
  if (/psql: (command )?not found|executable file not found|no such file or directory.*psql/i.test(t)) return 'There is no psql in that container: is it a PostgreSQL?';
  if (/Unable to connect to the server|couldn't get current server API group list|connection refused|i\/o timeout|Bad Request/i.test(t) && target.kind === 'kube') return `${target.tool} cannot reach the cluster ${target.context}: is it running? (a proxy in the way: add its address to NO_PROXY)`;
  if (/No such container|no container with name or ID|is not running/i.test(t)) return 'That container is not running any more: choose it again';
  const error = t.split('\n').map((l) => l.trim()).filter((l) => /^(psql:.*)?(ERROR|FATAL|error):/i.test(l) || /^Error/.test(l)).pop();
  return error ? error.replace(/^psql:(<stdin>:\d+: )?\s*/, '') : (t.trim().split('\n').pop() || 'It did not run');
}

// Runs a tool and collects what it prints; one not installed resolves to { missing: true }.
function call(exe, args, env, { timeout = FIND_TIMEOUT_MS, input = null, onData = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { env, windowsHide: true });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: e.message, missing: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (c) => { stdout += c; if (onData) onData(String(c), false); });
    child.stderr.on('data', (c) => { stderr += c; if (onData) onData(String(c), true); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: e.message, missing: e.code === 'ENOENT' });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, killed: Boolean(signal) });
    });
    child.stdin.on('error', () => {}); // a tool that ended before reading it all
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
    if (onData) onData.child = child;
  });
}

function registerNewDatabase({ getWindow, copySecret }) {
  let running = null; // { id, child }
  const guard = (fn) => async (_, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { error: e.message };
    }
  };
  const send = (data) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('newdb-output', data);
  };

  // Where a PostgreSQL may be: the containers that run one, and the clusters kubectl or oc know.
  ipcMain.handle('newdb-targets', guard(async () => {
    const env = await shell.loginShellEnv();
    const [found, ...kube] = await Promise.all([
      runningContainers().catch((e) => ({ engine: null, running: false, error: e.message, list: [] })),
      ...TOOLS.map(async (tool) => {
        const [list, current] = await Promise.all([call(tool, ['config', 'get-contexts', '-o', 'name'], env, { timeout: 8000 }), call(tool, ['config', 'current-context'], env, { timeout: 8000 })]);
        if (list.missing || list.code !== 0) return null;
        const contexts = list.stdout.split('\n').map((l) => l.trim()).filter((l) => K8S_NAME.test(l));
        return contexts.length ? { tool, contexts: contexts.map((name) => ({ name, local: LOCAL_CONTEXT.test(name), production: PRODUCTION.test(name) })), current: current.code === 0 ? current.stdout.trim() : '' } : null;
      }),
    ]);
    const containers = found.list
      .filter((c) => POSTGRES_IMAGE.test(c.image || '') || c.ports.some((p) => p.container === 5432) || c.env.POSTGRES_USER || c.env.POSTGRES_PASSWORD || c.env.POSTGRESQL_PASSWORD)
      .map((c) => ({
        id: c.id, name: c.name, image: c.image, project: c.project, engine: found.engine,
        admin: c.env.POSTGRES_USER || c.env.POSTGRESQL_USERNAME || 'postgres',
        port: (c.ports.find((p) => p.container === 5432 && p.host) || {}).host || null,
      }));
    return { engine: found.engine ? { name: found.engine, label: found.label, running: found.running } : null, engineError: found.running ? '' : found.error || '', containers, kube: kube.filter(Boolean) };
  }));

  // What it will run and what the microservice needs, from the form as it is: marked for the page, passwords apart.
  ipcMain.handle('newdb-preview', guard(async (values, where) => {
    const { v, problems } = readValues(values);
    let target = null;
    try {
      target = readTarget(where);
    } catch (e) {
      problems.push(e.message);
    }
    const named = [v.database, v.schema, v.ddlUser, v.dmlUser].every((n) => NAME.test(n)) && v.perms.length;
    const sql = named ? sqlFor(v) : '';
    const scripts = sql && target ? scriptsFor(target, sql) : { powershell: '', bash: '' };
    return {
      problems, sql, ...scripts, props: named ? propsFor(v) : '',
      target: target && { local: target.local, production: target.production },
      suggested: { schema: schemaOf(v.database) },
    };
  }));

  // The script or the lines of the microservice to the clipboard, with their passwords: as a secret (out of the
  // clipboard history, cleared after a while), and never through the page.
  ipcMain.handle('newdb-copy', guard(async (values, where, what) => {
    const { v, problems } = readValues(values);
    if (problems.length) throw new Error(problems[0]);
    if (what === 'props') copySecret(plain(propsFor(v)));
    else {
      const sql = sqlFor(v);
      copySecret(plain(what === 'sql' ? sql : scriptsFor(readTarget(where), sql)[what === 'bash' ? 'bash' : 'powershell']));
    }
    return { success: true };
  }));

  // The pod of PostgreSQL in the cluster (the first one running with the label).
  const findPod = async (target, env) => {
    const r = await call(target.tool, findPodArgs(target), env);
    if (r.missing) throw new Error(`${target.tool} was not found on this computer`);
    const pod = r.stdout.trim();
    if (r.code !== 0) throw new Error(explain(r.stderr, target));
    if (!pod || !K8S_NAME.test(pod)) throw new Error(`No pod runs with the label ${target.label} in the namespace ${target.namespace} of ${target.context}`);
    return pod;
  };
  ipcMain.handle('newdb-pod', guard(async (where) => {
    const target = readTarget({ ...where, kind: 'kube' });
    return { pod: await findPod(target, await shell.loginShellEnv()) };
  }));

  // Runs it. confirmed: the page asked first, for a cluster that is not one of this computer. The output goes to
  // the page as it comes (the passwords in it, if any, hidden).
  ipcMain.handle('newdb-run', guard(async (id, values, where, adminPassword, confirmed) => {
    if (running) throw new Error('It is running already');
    const { v, problems } = readValues(values);
    if (problems.length) throw new Error(problems[0]);
    const target = readTarget(where);
    if (target.production) throw new Error(`${target.context} reads as production: a database is not made there from here`);
    if (!target.local && !confirmed) throw new Error(`${target.context} is not a cluster of this computer: confirm it first`);
    const password = String(adminPassword ?? '');
    if (/[\r\n\u0000]/.test(password)) throw new Error('The admin password: one line');
    let exe;
    let env;
    let args;
    if (target.kind === 'kube') {
      env = await shell.loginShellEnv();
      exe = target.tool;
      send({ id, text: `Looking for the pod of PostgreSQL in ${target.context}...\n` });
      args = execArgs(target, await findPod(target, env));
    } else {
      const engine = await engineCall();
      exe = engine.exe;
      env = engine.env;
      args = execArgs({ ...target, engine: engine.name });
    }
    const secrets = [v.ddlPassword, v.dmlPassword, password].filter((x) => x.length >= 3);
    const hide = (text) => secrets.reduce((t, x) => t.split(x).join('••••'), text);
    const onData = (text, err) => send({ id, text: hide(text), err });
    running = { id, onData };
    let r;
    try {
      r = await call(exe, args, env, { timeout: RUN_TIMEOUT_MS, input: `${password}\n${plain(sqlFor(v))}\n`, onData });
    } finally {
      running = null;
    }
    if (r.missing) throw new Error(`${exe} was not found on this computer`);
    if (r.killed) return { ok: false, stopped: true, error: 'Stopped' };
    if (r.code !== 0) {
      const why = explain(hide(`${r.stdout}\n${r.stderr}`), target);
      return { ok: false, error: why, needsPassword: /asks for the password|did not accept the password/.test(why) };
    }
    const kept = r.stdout.split('\n').filter((l) => /there already, kept as it is/.test(l)).map((l) => l.trim());
    return { ok: true, kept, database: v.database, schema: v.schema };
  }));

  ipcMain.handle('newdb-stop', guard(async () => {
    if (running && running.onData.child) running.onData.child.kill();
    return { success: true };
  }));
}

module.exports = { registerNewDatabase, readValues, readTarget, sqlFor, scriptsFor, propsFor, execArgs, findPodArgs, explain, schemaOf, plain, ident, lit, RUNNER, LOCAL_CONTEXT, PRODUCTION, POSTGRES_IMAGE };
