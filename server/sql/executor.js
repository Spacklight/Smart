// Bridge between the Smartbase storage layout (Hugging Face: tables.json / metadata.json / records.json)
// and the tastdone SQL engine. Same export as before: executeSQL(userId, databaseId, sql, { storage, authModule }).
import { run, classifyStatements, identifiersIn } from './engine.js';

const DB_LIMIT = 20, TABLE_LIMIT = 50, TOTAL_TABLE_LIMIT = 500, MAX_ROWS = 5000;
const SHOW_DB = /^\s*SHOW\s+DATABASES\s*;?\s*$/i;
const CREATE_DB = /^\s*CREATE\s+DATABASE\s+(IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/i;
const DROP_DB = /^\s*DROP\s+DATABASE\s+(IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/i;
const NAME_OK = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** 'read' | 'write' - used by the API-key middleware (read keys may only read). */
export function classifySQLPermission(sql) {
  if (SHOW_DB.test(sql)) return 'read';
  if (/^\s*(CREATE|DROP|ALTER)\s+(DATABASE|SCHEMA)\b/i.test(sql)) return 'write';
  try { return classifyStatements(sql); } catch { return 'read'; } // syntax errors are rejected by the query route itself
}

function mapType(t) {
  t = String(t || '').toUpperCase();
  if (/INT/.test(t)) return 'INTEGER';
  if (/REAL|FLOA|DOUB|DEC|NUM/.test(t)) return 'FLOAT';
  if (/BOOL/.test(t)) return 'BOOLEAN';
  if (/TIMESTAMP|DATETIME/.test(t)) return 'DATETIME';
  if (/^DATE/.test(t)) return 'DATE';
  if (/JSON/.test(t)) return 'JSON';
  return 'TEXT';
}
const legacyCols = (t) => t.cols.map((c) => ({ name: c.key, type: mapType(c.type), nullable: !c.notnull, sql_type: c.type || undefined }));
const engineDef = (t) => ({ cols: t.cols, pk: t.pk, uniques: t.uniques, checks: t.checks || [], ai: t.ai || 0 });
const colFromLegacy = (m) => ({ name: m.name, key: m.name, type: m.sql_type || m.type, notnull: m.nullable === false });

function toEngineTable(meta, rows, loaded) {
  const e = meta.engine, legacy = meta.columns || [];
  let cols;
  if (e && Array.isArray(e.cols)) {
    cols = e.cols.filter((c) => legacy.some((m) => m.name === c.key)).map((c) => ({ ...c }));
    for (const m of legacy) if (!cols.some((c) => c.key === m.name)) cols.push(colFromLegacy(m));
  } else cols = legacy.map(colFromLegacy);
  const keys = new Set(cols.map((c) => c.key));
  return { name: meta.name, cols, pk: ((e && e.pk) || []).filter((k) => keys.has(k)), uniques: ((e && e.uniques) || []).filter((u) => u.keys.every((k) => keys.has(k))), checks: (e && e.checks) || [], ai: (e && e.ai) || 0, rows, _meta: meta, _loaded: loaded };
}

async function loadState(storage, userId, dbId, dbMeta, sql) {
  const list = (await storage.hf.readFile(storage.databaseTablesPath(userId, dbId))) || [];
  const eng = dbMeta.engine || {};
  const views = JSON.parse(JSON.stringify(eng.views || {})), indexes = JSON.parse(JSON.stringify(eng.indexes || {}));
  const wanted = new Set(identifiersIn(sql));
  for (let grew = true; grew;) { grew = false; for (const [name, v] of Object.entries(views)) if (wanted.has(name)) for (const id of identifiersIn(v.sql)) if (!wanted.has(id)) { wanted.add(id); grew = true; } }
  const db = { tables: {}, views, indexes }, originals = [];
  for (const entry of list) {
    const meta = await storage.getTable(userId, dbId, entry.id); if (!meta) continue;
    const need = wanted.has(meta.name.toLowerCase());
    const rows = need ? (await storage.getRecords(userId, dbId, meta.id)).map((r) => ({ ...r })) : [];
    const t = toEngineTable(meta, rows, need);
    db.tables[meta.name.toLowerCase()] = t; originals.push(t);
  }
  const snaps = {}; for (const t of originals) snaps[t._meta.id] = { rows: t._loaded ? JSON.stringify(t.rows) : null, def: JSON.stringify(engineDef(t)), name: t._meta.name };
  return { db, originals, snaps, viewState: JSON.stringify([views, indexes]) };
}

async function persist(storage, authModule, userId, dbId, st) {
  const { db, originals, snaps } = st, now = new Date().toISOString(), tables = Object.values(db.tables);
  for (const t of tables) { // keep records addressable by id for the REST endpoints
    if (t._meta && !t._loaded) continue;
    if (t.cols.some((c) => c.key === 'id')) continue;
    for (const r of t.rows) if (r.id == null) { r.id = authModule.generateId('sb_rec'); r._created_at = now; }
  }
  const fresh = tables.filter((t) => !t._meta);
  for (const t of fresh) if (!NAME_OK.test(t.name) || t.name.length > 64) throw { code: 'INVALID_SQL', message: 'Table name must start with a letter/underscore, use letters, numbers and underscores only (max 64).' };
  if (fresh.length) {
    if (tables.length > TABLE_LIMIT) throw { code: 'TABLE_LIMIT_REACHED', message: `Free accounts can create a maximum of ${TABLE_LIMIT} tables per database.` };
    let total = 0; for (const d of await storage.getUserDatabases(userId)) total += d.id === dbId ? tables.length : ((await storage.hf.readFile(storage.databaseTablesPath(userId, d.id))) || []).length;
    if (total > TOTAL_TABLE_LIMIT) throw { code: 'TOTAL_TABLE_LIMIT_REACHED', message: `Free accounts can create a maximum of ${TOTAL_TABLE_LIMIT} tables in total.` };
  }
  const kept = new Set(tables.filter((t) => t._meta).map((t) => t._meta.id));
  for (const o of originals) if (!kept.has(o._meta.id)) await storage.deleteTable(userId, dbId, o._meta.id);
  for (const t of fresh) {
    const meta = { id: authModule.generateId('sb_tbl'), database_id: dbId, name: t.name.toLowerCase(), columns: legacyCols(t), engine: engineDef(t), created_at: now, updated_at: now };
    await storage.createTable(userId, dbId, meta);
    if (t.rows.length) await storage.setRecords(userId, dbId, meta.id, t.rows);
  }
  for (const t of tables.filter((x) => x._meta)) {
    const s = snaps[t._meta.id], def = JSON.stringify(engineDef(t));
    if (def !== s.def || t.name !== s.name) {
      await storage.updateTable(userId, dbId, t._meta.id, { name: t.name.toLowerCase(), columns: legacyCols(t), engine: engineDef(t) });
      if (t.name !== s.name) await storage.renameTableInList(userId, dbId, t._meta.id, t.name.toLowerCase());
    }
    if (t._loaded && JSON.stringify(t.rows) !== s.rows) await storage.setRecords(userId, dbId, t._meta.id, t.rows);
  }
  if (JSON.stringify([db.views, db.indexes]) !== st.viewState) await storage.setDatabaseEngineState(userId, dbId, { views: db.views, indexes: db.indexes });
}

function shape(r) {
  const results = r.results.map((x) => {
    if (x.type !== 'rows') return { type: 'ok', message: x.message, affected_rows: x.affected ?? 0, ...(x.insertId != null ? { insert_id: x.insertId } : {}) };
    const rows = x.rows.slice(0, MAX_ROWS).map((row) => Object.fromEntries(x.columns.map((c, i) => [c, row[i]])));
    return { type: 'rows', columns: x.columns, rows, count: x.rows.length, ...(x.rows.length > MAX_ROWS ? { truncated: true } : {}) };
  });
  const last = results[results.length - 1];
  if (!last) return { message: 'No statements to run', results };
  return last.type === 'rows' ? { rows: last.rows, columns: last.columns, count: last.count, total: last.count, results } : { message: last.message, affected_rows: last.affected_rows, ...(last.insert_id != null ? { insert_id: last.insert_id } : {}), results };
}
function sqlError(msg) {
  if (/Syntax error|Unsupported/.test(msg)) return { code: 'INVALID_SQL', message: msg };
  if (/Table '.*' doesn't exist/.test(msg)) return { code: 'TABLE_NOT_FOUND', message: msg };
  return { code: 'SQL_ERROR', message: msg };
}

export async function executeSQL(userId, databaseId, sql, { storage, authModule } = {}) {
  const start = Date.now(), op = (String(sql).trim().split(/\s+/)[0] || 'SQL').toUpperCase();
  const finish = async (payload) => { const duration = Date.now() - start; await storage.addAudit(userId, { operation: op, database_id: databaseId, sql: String(sql).substring(0, 200), success: true, duration }); return { success: true, ...payload, execution_time: duration }; };
  let m;
  if (SHOW_DB.test(sql)) { const databases = await storage.getUserDatabases(userId); return finish({ rows: databases, count: databases.length }); }
  if ((m = CREATE_DB.exec(sql))) {
    const name = m[2].toLowerCase(), databases = await storage.getUserDatabases(userId);
    if (databases.find((d) => d.name.toLowerCase() === name)) { if (m[1]) return finish({ message: `Database '${name}' already exists` }); throw { code: 'DUPLICATE_DATABASE', message: `Database '${name}' already exists` }; }
    if (databases.length >= DB_LIMIT) throw { code: 'DATABASE_LIMIT_REACHED', message: `Free accounts can create a maximum of ${DB_LIMIT} databases.` };
    const dbData = { id: authModule.generateId('sb_db'), name, description: '', owner_id: userId, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'active' };
    await storage.createDatabase(userId, dbData); return finish({ message: `Database '${name}' created`, database: dbData });
  }
  if ((m = DROP_DB.exec(sql))) {
    const name = m[2].toLowerCase(), db = (await storage.getUserDatabases(userId)).find((d) => d.name.toLowerCase() === name);
    if (!db) { if (m[1]) return finish({ message: `Database '${name}' not found` }); throw { code: 'DATABASE_NOT_FOUND', message: `Database '${name}' not found` }; }
    await storage.deleteDatabase(userId, db.id); return finish({ message: `Database '${name}' deleted` });
  }
  if (!databaseId) throw { code: 'DATABASE_NOT_FOUND', message: 'Database ID required' };
  const dbMeta = await storage.getDatabase(userId, databaseId);
  if (!dbMeta || (dbMeta.owner_id && dbMeta.owner_id !== userId)) throw { code: 'DATABASE_NOT_FOUND', message: 'Database not found or access denied' };
  const st = await loadState(storage, userId, databaseId, dbMeta, String(sql));
  const r = run(st.db, String(sql));
  if (r.error) throw sqlError(r.error); // nothing is saved when any statement fails
  if (r.changed) await persist(storage, authModule, userId, databaseId, st);
  return finish(shape(r));
}
