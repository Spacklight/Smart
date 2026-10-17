import express from 'express';
import { createFileService } from '../files/files.js';
import { createEmailLaunch } from '../integrations/email-sso.js';

const DATABASE_LIMIT = 20;
const TABLE_LIMIT = 50;
const TOTAL_TABLE_LIMIT = 500;
const VALID_TYPES = ['INTEGER','FLOAT','TEXT','BOOLEAN','DATE','DATETIME','JSON'];

function validateDatabaseName(name) {
  if (!name || typeof name !== 'string') return 'Database name required';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return 'Database name must start with letter/underscore and contain only alphanumeric and underscore';
  if (name.length > 64) return 'Database name too long (max 64)';
  return null;
}
function validateTableName(name) {
  if (!name || typeof name !== 'string') return 'Table name required';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return 'Table name must start with letter/underscore and contain only alphanumeric and underscore';
  if (name.length > 64) return 'Table name too long (max 64)';
  return null;
}
function validateColumns(columns) {
  if (!columns || !Array.isArray(columns) || columns.length === 0) return 'Table must have at least one column';
  if (columns.length > 100) return 'Too many columns (max 100)';
  const names = new Set();
  for (const col of columns) {
    if (!col.name || typeof col.name !== 'string') return `Invalid column name: ${col.name}`;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col.name)) return `Invalid column name: ${col.name}`;
    const lower = col.name.toLowerCase();
    if (names.has(lower)) return `Duplicate column name: ${col.name}`;
    names.add(lower);
    if (!col.type || !VALID_TYPES.includes(col.type.toUpperCase())) return `Invalid type for ${col.name}: ${col.type}. Valid: ${VALID_TYPES.join(', ')}`;
  }
  return null;
}
function validateRecord(table, record) {
  for (const col of table.columns) {
    const val = record[col.name];
    if (!col.nullable && (val === null || val === undefined)) return `Column ${col.name} cannot be null`;
  }
  return null;
}

export function createApiRouter({ storage, authModule, authMiddleware, apiKeys, plusStorage, env = {} } = {}) {
  if (!storage) throw new Error('storage required');
  if (!authMiddleware) throw new Error('authMiddleware required');
  if (!authModule) throw new Error('authModule required');
  const router = express.Router();

  router.get('/databases', authMiddleware, async (req, res) => {
    try {
      const databases = await storage.getUserDatabases(req.userId);
      return res.json({ success: true, databases, count: databases.length, limit: DATABASE_LIMIT });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'STORAGE_READ_FAILED', message: e.message });
    }
  });

  router.post('/databases', authMiddleware, async (req, res) => {
    try {
      const { name, description } = req.body;
      const nameError = validateDatabaseName(name);
      if (nameError) return res.status(400).json({ success: false, error: 'INVALID_DATABASE_NAME', message: nameError });
      const databases = await storage.getUserDatabases(req.userId);
      if (databases.length >= DATABASE_LIMIT) {
        return res.status(403).json({ success: false, error: 'DATABASE_LIMIT_REACHED', message: `Free accounts can create a maximum of ${DATABASE_LIMIT} databases.` });
      }
      if (databases.find(d => d.name.toLowerCase() === name.toLowerCase())) {
        return res.status(409).json({ success: false, error: 'DUPLICATE_DATABASE', message: `Database '${name}' already exists` });
      }
      const dbData = {
        id: authModule.generateId('sb_db'),
        name: name.toLowerCase(),
        description: description || '',
        owner_id: req.userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'active'
      };
      await storage.createDatabase(req.userId, dbData);
      await storage.addAudit(req.userId, { operation: 'CREATE_DATABASE', database_id: dbData.id, database_name: dbData.name });
      return res.status(201).json({ success: true, database: dbData });
    } catch (e) {
      if (e.code === 'STORAGE_WRITE_FAILED' || e.code === 'STORAGE_NOT_CONFIGURED') {
        return res.status(500).json({ success: false, error: e.code, message: e.message });
      }
      return res.status(500).json({ success: false, error: 'DATABASE_CREATE_FAILED', message: e.message });
    }
  });

  router.get('/databases/:databaseId', authMiddleware, async (req, res) => {
    try {
      const db = await storage.getDatabase(req.userId, req.params.databaseId);
      if (!db) return res.status(404).json({ success: false, error: 'DATABASE_NOT_FOUND' });
      if (db.owner_id && db.owner_id !== req.userId) return res.status(404).json({ success: false, error: 'DATABASE_NOT_FOUND' });
      const tables = await storage.getDatabaseTables(req.userId, req.params.databaseId);
      return res.json({ success: true, database: { ...db, tables, table_count: tables.length } });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'STORAGE_READ_FAILED' });
    }
  });

  router.put('/databases/:databaseId', authMiddleware, async (req, res) => {
    try {
      const { name, description } = req.body;
      const existing = await storage.getDatabase(req.userId, req.params.databaseId);
      if (!existing) return res.status(404).json({ success: false, error: 'DATABASE_NOT_FOUND' });
      if (existing.owner_id && existing.owner_id !== req.userId) return res.status(404).json({ success: false, error: 'DATABASE_NOT_FOUND' });
      const updates = {};
      if (name) {
        const err = validateDatabaseName(name);
        if (err) return res.status(400).json({ success: false, error: 'INVALID_DATABASE_NAME', message: err });
        updates.name = name.toLowerCase();
      }
      if (description !== undefined) updates.description = description;
      const updated = await storage.updateDatabase(req.userId, req.params.databaseId, updates);
      return res.json({ success: true, database: updated });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'DATABASE_UPDATE_FAILED' });
    }
  });

  router.delete('/databases/:databaseId', authMiddleware, async (req, res) => {
    try {
      const db = await storage.getDatabase(req.userId, req.params.databaseId);
      if (!db) return res.status(404).json({ success: false, error: 'DATABASE_NOT_FOUND' });
      if (db.owner_id && db.owner_id !== req.userId) return res.status(404).json({ success: false, error: 'DATABASE_NOT_FOUND' });
      await storage.deleteDatabase(req.userId, req.params.databaseId);
      return res.json({ success: true, message: `Database '${db.name}' deleted` });
    } catch (e) {
      if (e.code === 'STORAGE_DELETE_FAILED') return res.status(500).json({ success: false, error: e.code, message: e.message });
      return res.status(500).json({ success: false, error: 'DATABASE_DELETE_FAILED' });
    }
  });

  router.get('/databases/:databaseId/tables', authMiddleware, async (req, res) => {
    try {
      const db = await storage.getDatabase(req.userId, req.params.databaseId);
      if (!db) return res.status(404).json({ success: false, error: 'DATABASE_NOT_FOUND' });
      if (db.owner_id && db.owner_id !== req.userId) return res.status(404).json({ success: false, error: 'DATABASE_NOT_FOUND' });
      const tables = await storage.getDatabaseTables(req.userId, req.params.databaseId);
      return res.json({ success: true, tables, count: tables.length, limit: TABLE_LIMIT });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'STORAGE_READ_FAILED' });
    }
  });

  router.post('/databases/:databaseId/tables', authMiddleware, async (req, res) => {
    try {
      const { name, columns } = req.body;
      const nameErr = validateTableName(name);
      if (nameErr) return res.status(400).json({ success: false, error: 'INVALID_TABLE_NAME', message: nameErr });
      const colErr = validateColumns(columns);
      if (colErr) return res.status(400).json({ success: false, error: 'INVALID_COLUMNS', message: colErr });
      const db = await storage.getDatabase(req.userId, req.params.databaseId);
      if (!db) return res.status(404).json({ success: false, error: 'DATABASE_NOT_FOUND' });
      if (db.owner_id && db.owner_id !== req.userId) return res.status(404).json({ success: false, error: 'DATABASE_NOT_FOUND' });
      const tables = await storage.getDatabaseTables(req.userId, req.params.databaseId);
      if (tables.length >= TABLE_LIMIT) {
        return res.status(403).json({ success: false, error: 'TABLE_LIMIT_REACHED', message: `Free accounts can create a maximum of ${TABLE_LIMIT} tables per database.` });
      }
      const userDatabases = await storage.getUserDatabases(req.userId);
      let totalTables = 0;
      for (const userDb of userDatabases) {
        totalTables += (await storage.getDatabaseTables(req.userId, userDb.id)).length;
      }
      if (totalTables >= TOTAL_TABLE_LIMIT) {
        return res.status(403).json({ success: false, error: 'TOTAL_TABLE_LIMIT_REACHED', message: `Free accounts can create a maximum of ${TOTAL_TABLE_LIMIT} tables in total.` });
      }
      if (tables.find(t => t.name.toLowerCase() === name.toLowerCase())) {
        return res.status(409).json({ success: false, error: 'DUPLICATE_TABLE', message: `Table '${name}' already exists` });
      }
      const tableData = {
        id: authModule.generateId('sb_tbl'),
        database_id: req.params.databaseId,
        name: name.toLowerCase(),
        columns: columns.map(c => ({ name: c.name.toLowerCase(), type: c.type.toUpperCase(), nullable: c.nullable !== false })),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      await storage.createTable(req.userId, req.params.databaseId, tableData);
      return res.status(201).json({ success: true, table: tableData });
    } catch (e) {
      if (e.code === 'STORAGE_WRITE_FAILED') return res.status(500).json({ success: false, error: e.code, message: e.message });
      return res.status(500).json({ success: false, error: 'TABLE_CREATE_FAILED' });
    }
  });

  router.get('/databases/:databaseId/tables/:tableId', authMiddleware, async (req, res) => {
    try {
      const table = await storage.getTable(req.userId, req.params.databaseId, req.params.tableId);
      if (!table) return res.status(404).json({ success: false, error: 'TABLE_NOT_FOUND' });
      const records = await storage.getRecords(req.userId, req.params.databaseId, req.params.tableId);
      return res.json({ success: true, table: { ...table, record_count: records.length } });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'STORAGE_READ_FAILED' });
    }
  });

  router.put('/databases/:databaseId/tables/:tableId', authMiddleware, async (req, res) => {
    try {
      const { name, columns } = req.body;
      const existing = await storage.getTable(req.userId, req.params.databaseId, req.params.tableId);
      if (!existing) return res.status(404).json({ success: false, error: 'TABLE_NOT_FOUND' });
      const updates = {};
      if (name) {
        const err = validateTableName(name);
        if (err) return res.status(400).json({ success: false, error: 'INVALID_TABLE_NAME', message: err });
        updates.name = name.toLowerCase();
      }
      if (columns) {
        const err = validateColumns(columns);
        if (err) return res.status(400).json({ success: false, error: 'INVALID_COLUMNS', message: err });
        updates.columns = columns.map(c => ({ name: c.name.toLowerCase(), type: c.type.toUpperCase(), nullable: c.nullable !== false }));
      }
      const updated = await storage.updateTable(req.userId, req.params.databaseId, req.params.tableId, updates);
      return res.json({ success: true, table: updated });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'TABLE_UPDATE_FAILED' });
    }
  });

  router.delete('/databases/:databaseId/tables/:tableId', authMiddleware, async (req, res) => {
    try {
      const table = await storage.getTable(req.userId, req.params.databaseId, req.params.tableId);
      if (!table) return res.status(404).json({ success: false, error: 'TABLE_NOT_FOUND' });
      await storage.deleteTable(req.userId, req.params.databaseId, req.params.tableId);
      return res.json({ success: true, message: `Table '${table.name}' deleted` });
    } catch (e) {
      if (e.code === 'STORAGE_DELETE_FAILED') return res.status(500).json({ success: false, error: e.code, message: e.message });
      return res.status(500).json({ success: false, error: 'TABLE_DELETE_FAILED' });
    }
  });

  router.get('/databases/:databaseId/tables/:tableId/records', authMiddleware, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      const offset = (page - 1) * limit;
      const table = await storage.getTable(req.userId, req.params.databaseId, req.params.tableId);
      if (!table) return res.status(404).json({ success: false, error: 'TABLE_NOT_FOUND' });
      let records = await storage.getRecords(req.userId, req.params.databaseId, req.params.tableId) || [];
      const total = records.length;
      records = records.slice(offset, offset + limit);
      return res.json({ success: true, records, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'RECORDS_FETCH_FAILED' });
    }
  });

  router.post('/databases/:databaseId/tables/:tableId/records', authMiddleware, async (req, res) => {
    try {
      const { records } = req.body;
      if (!records || !Array.isArray(records) || records.length === 0) return res.status(400).json({ success: false, error: 'INVALID_RECORDS' });
      if (records.length > 100) return res.status(400).json({ success: false, error: 'INVALID_RECORDS', message: 'Max 100 records at once' });
      const table = await storage.getTable(req.userId, req.params.databaseId, req.params.tableId);
      if (!table) return res.status(404).json({ success: false, error: 'TABLE_NOT_FOUND' });
      for (const rec of records) {
        const err = validateRecord(table, rec);
        if (err) return res.status(400).json({ success: false, error: 'INVALID_RECORD', message: err });
      }
      const toInsert = records.map(r => ({ ...r, id: r.id || authModule.generateId('sb_rec'), _created_at: new Date().toISOString() }));
      const all = await storage.insertRecords(req.userId, req.params.databaseId, req.params.tableId, toInsert);
      return res.status(201).json({ success: true, records: all.slice(-records.length), count: records.length });
    } catch (e) {
      if (e.code === 'STORAGE_WRITE_FAILED') return res.status(500).json({ success: false, error: e.code, message: e.message });
      return res.status(500).json({ success: false, error: 'INSERT_FAILED' });
    }
  });

  router.put('/databases/:databaseId/tables/:tableId/records/:recordId', authMiddleware, async (req, res) => {
    try {
      let updatedCount = 0;
      await storage.updateRecords(req.userId, req.params.databaseId, req.params.tableId, (r) => {
        if (String(r.id) === String(req.params.recordId)) { updatedCount++; return { ...r, ...req.body, _updated_at: new Date().toISOString() }; }
        return r;
      });
      if (updatedCount === 0) return res.status(404).json({ success: false, error: 'RECORD_NOT_FOUND' });
      return res.json({ success: true, message: 'Record updated' });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'UPDATE_FAILED' });
    }
  });

  router.delete('/databases/:databaseId/tables/:tableId/records/:recordId', authMiddleware, async (req, res) => {
    try {
      const result = await storage.deleteRecords(req.userId, req.params.databaseId, req.params.tableId, r => String(r.id) === String(req.params.recordId));
      if (result.count === 0) return res.status(404).json({ success: false, error: 'RECORD_NOT_FOUND' });
      return res.json({ success: true, message: 'Record deleted' });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'DELETE_FAILED' });
    }
  });

  router.post('/query', authMiddleware, async (req, res) => {
    try {
      const { database_id, sql } = req.body;
      if (!sql || typeof sql !== 'string') return res.status(400).json({ success: false, error: 'INVALID_SQL' });
      const { executeSQL } = await import('../sql/executor.js');
      const result = await executeSQL(req.userId, database_id, sql, { storage, authModule });
      return res.json(result);
    } catch (e) {
      const status = e.code === 'DATABASE_NOT_FOUND' || e.code === 'TABLE_NOT_FOUND' ? 404 : e.code === 'DATABASE_LIMIT_REACHED' || e.code === 'TABLE_LIMIT_REACHED' || e.code === 'TOTAL_TABLE_LIMIT_REACHED' ? 403 : (e.code === 'INVALID_SQL' || e.code === 'SQL_ERROR') ? 400 : 500;
      return res.status(status).json({ success: false, error: e.code || 'QUERY_FAILED', message: e.message });
    }
  });

  router.get('/audit', authMiddleware, async (req, res) => {
    try {
      const logs = await storage.getAudit(req.userId);
      return res.json({ success: true, logs });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'AUDIT_FETCH_FAILED' });
    }
  });

  router.get('/api-keys', authMiddleware, async (req, res) => {
    try {
      if (!apiKeys) return res.status(501).json({ success: false, error: 'NOT_IMPLEMENTED' });
      const keys = await apiKeys.listKeys(req.userId);
      return res.json({ success: true, keys, limit: apiKeys.MAX_KEYS_PER_USER });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.code || 'API_KEYS_FETCH_FAILED', message: e.message });
    }
  });

  // body: { type: 'read' | 'write' | 'collective', name?: string }
  // 'collective' issues one read key and one write key together.
  router.post('/api-keys', authMiddleware, async (req, res) => {
    try {
      if (!apiKeys) return res.status(501).json({ success: false, error: 'NOT_IMPLEMENTED' });
      const { type, name } = req.body || {};
      const keys = await apiKeys.createKeys(req.userId, type, name);
      await storage.addAudit(req.userId, { operation: 'CREATE_API_KEY', key_type: type });
      return res.status(201).json({ success: true, type, keys });
    } catch (e) {
      const status = e.code === 'INVALID_KEY_TYPE' ? 400 : e.code === 'API_KEY_LIMIT_REACHED' ? 403 : 500;
      return res.status(status).json({ success: false, error: e.code || 'API_KEY_CREATE_FAILED', message: e.message });
    }
  });

  router.delete('/api-keys/:keyId', authMiddleware, async (req, res) => {
    try {
      if (!apiKeys) return res.status(501).json({ success: false, error: 'NOT_IMPLEMENTED' });
      const removed = await apiKeys.revokeKey(req.userId, req.params.keyId);
      if (!removed) return res.status(404).json({ success: false, error: 'API_KEY_NOT_FOUND' });
      await storage.addAudit(req.userId, { operation: 'REVOKE_API_KEY', key_id: req.params.keyId });
      return res.json({ success: true, message: 'API key revoked' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.code || 'API_KEY_REVOKE_FAILED', message: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Plus Storage Integration
  // Browser-session only. This block is intentionally unavailable to /apiv1.
  // ---------------------------------------------------------------------------

  if (plusStorage) {
    router.get('/storage/databases/:dbId', authMiddleware, async (req, res) => {
      try {
        const binding = await plusStorage.getDatabaseBinding(
          req.userId,
          req.params.dbId
        );

        return res.json({
          success: true,
          binding
        });
      } catch (e) {
        const status = e.code === 'DATABASE_NOT_FOUND' ? 404 : 500;

        return res.status(status).json({
          success: false,
          error: e.code || 'STORAGE_BINDING_READ_FAILED',
          message: e.message || 'Could not load database storage binding.'
        });
      }
    });

    router.post('/storage/databases/:dbId/bind', authMiddleware, async (req, res) => {
      try {
        const binding = await plusStorage.bindDatabase(
          req.userId,
          req.params.dbId,
          req.body || {}
        );

        return res.status(201).json({
          success: true,
          binding
        });
      } catch (e) {
        const status =
          e.code === 'DATABASE_NOT_FOUND' ||
          e.code === 'CONNECTION_NOT_FOUND'
            ? 404
            : 400;

        return res.status(status).json({
          success: false,
          error: e.code || 'STORAGE_BINDING_FAILED',
          message: e.message || 'Could not bind database storage.'
        });
      }
    });

    router.delete('/storage/databases/:dbId/bind', authMiddleware, async (req, res) => {
      try {
        const result = await plusStorage.unbindDatabase(
          req.userId,
          req.params.dbId
        );

        return res.json(result);
      } catch (e) {
        const status = e.code === 'DATABASE_NOT_FOUND' ? 404 : 400;

        return res.status(status).json({
          success: false,
          error: e.code || 'STORAGE_UNBIND_FAILED',
          message: e.message || 'Could not remove database storage binding.'
        });
      }
    });

    router.get('/storage/connections', authMiddleware, async (req, res) => {
      try {
        const connections = await plusStorage.getConnections(req.userId);

        return res.json({
          success: true,
          connections
        });
      } catch (e) {
        return res.status(500).json({
          success: false,
          error: e.code || 'STORAGE_CONNECTIONS_READ_FAILED',
          message: e.message || 'Could not load storage connections.'
        });
      }
    });

    router.post('/storage/connections', authMiddleware, async (req, res) => {
      try {
        const connection = await plusStorage.addConnection(
          req.userId,
          req.body || {}
        );

        return res.status(201).json({
          success: true,
          connection
        });
      } catch (e) {
        const status =
          e.code === 'INVALID_PROVIDER' ||
          e.code === 'INVALID_CONNECTION' ||
          e.code === 'CONNECTION_NAME_EXISTS'
            ? 400
            : 500;

        return res.status(status).json({
          success: false,
          error: e.code || 'STORAGE_CONNECTION_CREATE_FAILED',
          message: e.message || 'Could not create storage connection.'
        });
      }
    });

    router.delete('/storage/connections/:connectionId', authMiddleware, async (req, res) => {
      try {
        const result = await plusStorage.removeConnection(
          req.userId,
          req.params.connectionId
        );

        return res.json({
          success: true,
          ...result
        });
      } catch (e) {
        const status = e.code === 'CONNECTION_NOT_FOUND' ? 404 : 500;

        return res.status(status).json({
          success: false,
          error: e.code || 'STORAGE_CONNECTION_DELETE_FAILED',
          message: e.message || 'Could not remove storage connection.'
        });
      }
    });

    router.post('/storage/connections/:connectionId/test', authMiddleware, async (req, res) => {
      try {
        const result = await plusStorage.testConnection(
          req.userId,
          req.params.connectionId
        );

        return res.json({
          success: true,
          ...result
        });
      } catch (e) {
        const status = e.code === 'CONNECTION_NOT_FOUND' ? 404 : 400;

        return res.status(status).json({
          success: false,
          error: e.code || 'STORAGE_CONNECTION_TEST_FAILED',
          message: e.message || 'Storage connection test failed.'
        });
      }
    });

    router.post('/storage/connections/:connectionId/upload-url', authMiddleware, async (req, res) => {
      try {
        const key = String(req.body?.key || '').trim();
        const contentType = String(req.body?.contentType || 'application/octet-stream').trim();

        if (!key) {
          return res.status(400).json({
            success: false,
            error: 'STORAGE_OBJECT_KEY_REQUIRED',
            message: 'Object key is required.'
          });
        }

        const result = await plusStorage.createUploadUrl(
          req.userId,
          req.params.connectionId,
          key,
          {
            expiresIn: req.body?.expiresIn,
            contentType
          }
        );

        return res.json({
          success: true,
          ...result
        });
      } catch (e) {
        const status = e.code === 'CONNECTION_NOT_FOUND' ? 404 : 400;

        return res.status(status).json({
          success: false,
          error: e.code || 'STORAGE_UPLOAD_URL_FAILED',
          message: e.message || 'Could not create upload URL.'
        });
      }
    });

    router.post('/storage/connections/:connectionId/download-url', authMiddleware, async (req, res) => {
      try {
        const key = String(req.body?.key || '').trim();

        if (!key) {
          return res.status(400).json({
            success: false,
            error: 'STORAGE_OBJECT_KEY_REQUIRED',
            message: 'Object key is required.'
          });
        }

        const result = await plusStorage.createDownloadUrl(
          req.userId,
          req.params.connectionId,
          key,
          {
            expiresIn: req.body?.expiresIn
          }
        );

        return res.json({
          success: true,
          ...result
        });
      } catch (e) {
        const status = e.code === 'CONNECTION_NOT_FOUND' ? 404 : 400;

        return res.status(status).json({
          success: false,
          error: e.code || 'STORAGE_DOWNLOAD_URL_FAILED',
          message: e.message || 'Could not create download URL.'
        });
      }
    });
  }

  
  // ---- File storage (works with a browser session AND with an API key at /apiv1) ----
  const fileService = createFileService({ storage, env });
  const fileErr = (res, e) => {
    const status = { INVALID_FILE_NAME: 400, INVALID_FILE: 400, FILE_NOT_FOUND: 404, FILE_TOO_LARGE: 413, STORAGE_QUOTA_EXCEEDED: 413 }[e.code] || 500;
    return res.status(status).json({ success: false, error: e.code || 'FILE_ERROR', message: status === 500 ? (e.message || 'File operation failed') : e.message });
  };
  router.get('/files', authMiddleware, async (req, res) => {
    try { return res.json({ success: true, ...(await fileService.list(req.userId)) }); } catch (e) { return fileErr(res, e); }
  });
  router.get('/usage', authMiddleware, async (req, res) => {
    try { return res.json({ success: true, files: await fileService.usage(req.userId) }); } catch (e) { return fileErr(res, e); }
  });
  // JSON upload: { "name": "report.pdf", "data": "<base64>", "content_type": "application/pdf" }
  router.post('/files', authMiddleware, async (req, res) => {
    try {
      const { name, data, content_type } = req.body || {};
      if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw { code: 'INVALID_FILE', message: 'data must be a base64 string.' };
      return res.status(201).json({ success: true, ...(await fileService.put(req.userId, name, Buffer.from(data, 'base64'), content_type)) });
    } catch (e) { return fileErr(res, e); }
  });
  // Raw upload: PUT /files/<name> with the file bytes as the request body (no base64 needed)
  router.put('/files/:name', authMiddleware, express.raw({ type: () => true, limit: '8mb' }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) throw { code: 'INVALID_FILE', message: 'Send the file bytes as the request body.' };
      return res.status(201).json({ success: true, ...(await fileService.put(req.userId, req.params.name, req.body, req.headers['content-type'])) });
    } catch (e) { return fileErr(res, e); }
  });
  router.get('/files/:name', authMiddleware, async (req, res) => {
    try {
      const { bytes, meta } = await fileService.get(req.userId, req.params.name);
      res.set({ 'Content-Type': meta.content_type || 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + meta.name.replace(/"/g, '') + '"', 'Content-Length': String(bytes.length) });
      return res.send(bytes);
    } catch (e) { return fileErr(res, e); }
  });
  router.delete('/files/:name', authMiddleware, async (req, res) => {
    try { return res.json({ success: true, ...(await fileService.remove(req.userId, req.params.name)) }); } catch (e) { return fileErr(res, e); }
  });

  // ---- Open the Email platform without a second login (browser session only, never an API key) ----
  const emailLaunch = createEmailLaunch({ authModule, env });
  router.post('/integrations/email/launch', authMiddleware, async (req, res) => {
    if (req.apiKeyType) return res.status(403).json({ success: false, error: 'KEY_PERMISSION_DENIED', message: 'API keys cannot open the Email platform.' });
    try { return res.json({ success: true, ...(await emailLaunch(req.userId)) }); }
    catch (e) { return res.status(e.code === 'NOT_CONFIGURED' ? 503 : e.code === 'USER_NOT_FOUND' ? 404 : 500).json({ success: false, error: e.code || 'LAUNCH_FAILED', message: e.message || 'Could not open the Email platform.' }); }
  });

  return router;
}
