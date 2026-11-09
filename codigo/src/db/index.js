// -- The Database page's side in the main process: the connections (connections.js) and the reading (pg.js). Every
// answer is { error } when something went wrong, said so a person reads it. --
const path = require('path');
const { ipcMain, safeStorage } = require('electron');
const { DbConnections } = require('./connections');
const pg = require('./pg');

function registerDb({ dataDir }) {
  const store = new DbConnections(path.join(dataDir, 'db-connections.json'), safeStorage);
  // conn: the connection the call is about, for the message (where it tried, as whom)
  const guard = (fn) => async (_, ...args) => {
    let conn = null;
    try {
      return await fn((c) => (conn = c), ...args);
    } catch (e) {
      return { error: pg.explain(e, conn) };
    }
  };

  ipcMain.handle('db-connections', guard(async () => ({ connections: store.list() })));
  ipcMain.handle('db-save', guard(async (_, input) => ({ connection: store.save(input), connections: store.list() })));
  ipcMain.handle('db-delete', guard(async (_, id) => {
    store.remove(id);
    return { connections: store.list() };
  }));
  ipcMain.handle('db-test', guard(async (use, input) => pg.test(use(store.resolve(input)))));
  ipcMain.handle('db-schemas', guard(async (use, id) => pg.schemas(use(store.get(id)))));
  ipcMain.handle('db-tables', guard(async (use, id, schema) => pg.tables(use(store.get(id)), String(schema))));
  ipcMain.handle('db-columns', guard(async (use, id, schema, table) => pg.columns(use(store.get(id)), String(schema), String(table))));
  ipcMain.handle('db-rows', guard(async (use, id, schema, table, opts) => pg.rows(use(store.get(id)), String(schema), String(table), opts || {})));
  ipcMain.handle('db-query', guard(async (use, id, sql) => pg.query(use(store.get(id)), String(sql || '').slice(0, 100000))));
  // for the SQL tab: the names to offer and check, and the query checked by PostgreSQL without running it
  ipcMain.handle('db-catalog', guard(async (use, id) => pg.catalog(use(store.get(id)))));
  ipcMain.handle('db-check', guard(async (use, id, sql) => pg.check(use(store.get(id)), String(sql || '').slice(0, 100000))));
}

module.exports = { registerDb };
