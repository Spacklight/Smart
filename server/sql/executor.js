import { getStorageAdapter, createStorageAdapter } from '../storage/adapter.js';
import { generateId as generateIdOld } from '../auth/auth.js';
import { sqlParser } from './parser.js';

let storageInstance = null;
let storageConfigKey = null;

function getStorage() {
  try {
    const token = typeof process !== 'undefined' && process.env ? process.env.HF_TOKEN : '';
    const dataset = typeof process !== 'undefined' && process.env ? process.env.HF_DATASET : '';
    const isProduction = typeof process !== 'undefined' && process.env ? process.env.NODE_ENV === 'production' : false;
    const key = `${token}|${dataset}|${isProduction}`;
    if (!storageInstance || storageConfigKey !== key) {
      if (token && dataset) storageInstance = createStorageAdapter({ token, dataset, isProduction });
      else storageInstance = getStorageAdapter();
      storageConfigKey = key;
    }
  } catch { storageInstance = getStorageAdapter(); }
  return storageInstance;
}

export function setStorageForTesting(storage) { storageInstance = storage; }
function getGenerateId() { return generateIdOld; }

function validateType(value, type) {
  if (value === null || value === undefined) return true;
  switch (type) {
    case 'INTEGER': return Number.isInteger(Number(value)) || (typeof value === 'string' && /^\d+$/.test(value));
    case 'FLOAT': return !isNaN(Number(value));
    case 'TEXT': return typeof value === 'string' || typeof value === 'number';
    case 'BOOLEAN': return typeof value === 'boolean' || value === 'true' || value === 'false' || value === 1 || value === 0;
    case 'DATE': return !isNaN(Date.parse(value));
    case 'DATETIME': return !isNaN(Date.parse(value));
    case 'JSON': try { if (typeof value === 'object') return true; JSON.parse(value); return true; } catch { return false; }
    default: return true;
  }
}
function coerceValue(value, type) {
  if (value === null) return null;
  switch (type) {
    case 'INTEGER': return parseInt(value);
    case 'FLOAT': return parseFloat(value);
    case 'BOOLEAN': return value === true || value === 'true' || value === 1;
    default: return value;
  }
}

export async function executeSQL(userId, databaseId, sql, options = {}) {
  const storage = options.storage || getStorage();
  const start = Date.now();
  try {
    const command = sqlParser.parse(sql, { database_id: databaseId });
    if (databaseId) {
      const db = await storage.getDatabase(userId, databaseId);
      if (!db) throw { code: 'DATABASE_NOT_FOUND', message: 'Database not found or access denied' };
      if (db.owner_id && db.owner_id !== userId) throw { code: 'DATABASE_NOT_FOUND', message: 'Database not found' };
    }
    let result;
    switch (command.operation) {
      case 'CREATE_DATABASE': result = await execCreateDatabase(userId, command, storage); break;
      case 'SHOW_DATABASES': result = await execShowDatabases(userId, storage); break;
      case 'DROP_DATABASE': result = await execDropDatabase(userId, command, storage); break;
      case 'CREATE_TABLE': result = await execCreateTable(userId, databaseId, command, storage); break;
      case 'SHOW_TABLES': result = await execShowTables(userId, databaseId, storage); break;
      case 'DROP_TABLE': result = await execDropTable(userId, databaseId, command, storage); break;
      case 'INSERT': result = await execInsert(userId, databaseId, command, storage); break;
      case 'SELECT': result = await execSelect(userId, databaseId, command, storage); break;
      case 'UPDATE': result = await execUpdate(userId, databaseId, command, storage); break;
      case 'DELETE': result = await execDelete(userId, databaseId, command, storage); break;
      default: throw { code: 'UNSUPPORTED_SQL', message: `Operation ${command.operation} not supported` };
    }
    const duration = Date.now() - start;
    await storage.addAudit(userId, { operation: command.operation, database_id: databaseId, sql: sql.substring(0, 200), success: true, duration });
    return { success: true, ...result, execution_time: duration };
  } catch (e) { if (e.code) throw e; throw { code: 'SQL_EXECUTION_ERROR', message: e.message || 'SQL execution failed' }; }
}

async function execCreateDatabase(userId, command, storage) {
  const databases = await storage.getUserDatabases(userId);
  if (databases.length >= 20) throw { code: 'DATABASE_LIMIT_REACHED', message: 'Free accounts can create a maximum of 20 databases.' };
  const exists = databases.find(d => d.name === command.name);
  if (exists) throw { code: 'DUPLICATE_DATABASE', message: `Database '${command.name}' already exists` };
  const dbData = { id: getGenerateId()('sb_db'), name: command.name, description: command.description || '', owner_id: userId, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'active' };
  await storage.createDatabase(userId, dbData);
  return { message: `Database '${command.name}' created`, database: dbData };
}
async function execShowDatabases(userId, storage) { const databases = await storage.getUserDatabases(userId); return { rows: databases, count: databases.length }; }
async function execDropDatabase(userId, command, storage) {
  const databases = await storage.getUserDatabases(userId);
  const db = databases.find(d => d.name === command.name);
  if (!db) throw { code: 'DATABASE_NOT_FOUND', message: `Database '${command.name}' not found` };
  await storage.deleteDatabase(userId, db.id);
  return { message: `Database '${command.name}' deleted` };
}
async function execCreateTable(userId, databaseId, command, storage) {
  if (!databaseId) throw { code: 'DATABASE_NOT_FOUND', message: 'Database ID required' };
  const tables = await storage.getDatabaseTables(userId, databaseId);
  if (tables.length >= 50) throw { code: 'TABLE_LIMIT_REACHED', message: 'Free accounts can create a maximum of 50 tables per database.' };
  const allDatabases = await storage.getUserDatabases(userId);
  let totalTables = 0;
  for (const db of allDatabases) totalTables += (await storage.getDatabaseTables(userId, db.id)).length;
  if (totalTables >= 500) throw { code: 'TOTAL_TABLE_LIMIT_REACHED', message: 'Free accounts can create a maximum of 500 tables in total.' };
  const exists = tables.find(t => t.name === command.table.name);
  if (exists) throw { code: 'DUPLICATE_TABLE', message: `Table '${command.table.name}' already exists` };
  const tableData = { id: getGenerateId()('sb_tbl'), database_id: databaseId, name: command.table.name, columns: command.table.columns, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  await storage.createTable(userId, databaseId, tableData);
  return { message: `Table '${command.table.name}' created`, table: tableData };
}
async function execShowTables(userId, databaseId, storage) { const tables = await storage.getDatabaseTables(userId, databaseId); return { rows: tables, count: tables.length }; }
async function execDropTable(userId, databaseId, command, storage) {
  const tables = await storage.getDatabaseTables(userId, databaseId);
  const table = tables.find(t => t.name === command.name);
  if (!table) throw { code: 'TABLE_NOT_FOUND', message: `Table '${command.name}' not found` };
  await storage.deleteTable(userId, databaseId, table.id);
  return { message: `Table '${command.name}' deleted` };
}
async function execInsert(userId, databaseId, command, storage) {
  const tables = await storage.getDatabaseTables(userId, databaseId);
  const table = tables.find(t => t.name === command.table);
  if (!table) throw { code: 'TABLE_NOT_FOUND', message: `Table '${command.table}' not found` };
  const tableMeta = await storage.getTable(userId, databaseId, table.id);
  if (!tableMeta) throw { code: 'TABLE_NOT_FOUND' };
  const records = [];
  for (const valueSet of command.values) {
    const record = {};
    if (command.columns) {
      if (command.columns.length !== valueSet.length) throw { code: 'INVALID_SQL', message: `Column count doesn't match value count` };
      for (let i = 0; i < command.columns.length; i++) {
        const colName = command.columns[i];
        const colDef = tableMeta.columns.find(c => c.name === colName);
        if (!colDef) throw { code: 'INVALID_COLUMN', message: `Column '${colName}' not found` };
        const val = valueSet[i];
        if (!colDef.nullable && (val === null || val === undefined)) throw { code: 'INVALID_COLUMN_TYPE', message: `Column '${colName}' cannot be null` };
        if (val !== null && !validateType(val, colDef.type)) throw { code: 'INVALID_COLUMN_TYPE', message: `Invalid type for column '${colName}': expected ${colDef.type}` };
        record[colName] = coerceValue(val, colDef.type);
      }
    } else {
      if (valueSet.length !== tableMeta.columns.length) throw { code: 'INVALID_SQL', message: `Value count doesn't match column count` };
      for (let i = 0; i < tableMeta.columns.length; i++) {
        const colDef = tableMeta.columns[i];
        const val = valueSet[i];
        if (!colDef.nullable && (val === null || val === undefined)) throw { code: 'INVALID_COLUMN_TYPE', message: `Column '${colDef.name}' cannot be null` };
        if (val !== null && !validateType(val, colDef.type)) throw { code: 'INVALID_COLUMN_TYPE', message: `Invalid type for column '${colDef.name}': expected ${colDef.type}` };
        record[colDef.name] = coerceValue(val, colDef.type);
      }
    }
    record.id = record.id || getGenerateId()('sb_rec');
    record._created_at = new Date().toISOString();
    records.push(record);
  }
  await storage.insertRecords(userId, databaseId, table.id, records);
  return { message: `${records.length} record(s) inserted`, records, count: records.length };
}
async function execSelect(userId, databaseId, command, storage) {
  const tables = await storage.getDatabaseTables(userId, databaseId);
  const table = tables.find(t => t.name === command.table);
  if (!table) throw { code: 'TABLE_NOT_FOUND', message: `Table '${command.table}' not found` };
  let records = await storage.getRecords(userId, databaseId, table.id) || [];
  if (command.where) records = records.filter(r => evaluateWhere(r, command.where));
  if (command.orderBy) {
    const { column, direction } = command.orderBy;
    records.sort((a, b) => { const av = a[column]; const bv = b[column]; if (av === bv) return 0; const cmp = av < bv ? -1 : 1; return direction === 'DESC' ? -cmp : cmp; });
  }
  const total = records.length;
  if (command.limit) { const offset = command.offset || 0; records = records.slice(offset, offset + command.limit); }
  let resultRows = records;
  if (command.columns && command.columns.length > 0 && command.columns[0] !== '*') {
    resultRows = records.map(r => { const obj = {}; command.columns.forEach(c => { obj[c] = r[c]; }); return obj; });
  }
  return { rows: resultRows, count: resultRows.length, total };
}
function evaluateWhere(record, where) {
  if (!where) return true;
  const { column, operator, value } = where;
  const recVal = record[column];
  switch (operator) {
    case '=': return String(recVal) === String(value);
    case '!=': return String(recVal) !== String(value);
    case '>': return recVal > value;
    case '<': return recVal < value;
    case '>=': return recVal >= value;
    case '<=': return recVal <= value;
    case 'LIKE': { const pattern = String(value).replace(/%/g, '.*').replace(/_/g, '.'); const regex = new RegExp(`^${pattern}$`, 'i'); return regex.test(String(recVal)); }
    default: return true;
  }
}
async function execUpdate(userId, databaseId, command, storage) {
  const tables = await storage.getDatabaseTables(userId, databaseId);
  const table = tables.find(t => t.name === command.table);
  if (!table) throw { code: 'TABLE_NOT_FOUND', message: `Table '${command.table}' not found` };
  let count = 0;
  await storage.updateRecords(userId, databaseId, table.id, (r) => {
    if (!command.where || evaluateWhere(r, command.where)) { count++; const updated = { ...r }; for (const [k, v] of Object.entries(command.set)) { updated[k] = v; } updated._updated_at = new Date().toISOString(); return updated; }
    return r;
  });
  return { message: `${count} record(s) updated`, count };
}
async function execDelete(userId, databaseId, command, storage) {
  const tables = await storage.getDatabaseTables(userId, databaseId);
  const table = tables.find(t => t.name === command.table);
  if (!table) throw { code: 'TABLE_NOT_FOUND', message: `Table '${command.table}' not found` };
  let result;
  if (command.where) result = await storage.deleteRecords(userId, databaseId, table.id, r => evaluateWhere(r, command.where));
  else result = await storage.deleteRecords(userId, databaseId, table.id, () => true);
  return { message: `${result.count} record(s) deleted`, count: result.count };
}
