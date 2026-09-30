import { createHFClient } from './huggingface/client.js';
export class StorageAdapter {
  constructor(config = {}) {
    this.hf = createHFClient(config);
    this.config = config;
  }
  getMode() { return this.hf.getMode(); }
  async loadRegistry() {
    try {
      const data = await this.hf.readFile('registry/registry.json');
      if (!data) return { version: 1, users: {} };
      return data;
    } catch (e) {
      // A genuine "not found" already returned above via readFile -> null.
      // Anything that reaches this catch is a real storage failure and must
      // never be swallowed into an empty registry.
      throw { code: 'STORAGE_READ_FAILED', message: `Registry read failed: ${e.message}` };
    }
  }
  async saveRegistry(registry) {
    try {
      const result = await this.hf.writeFile('registry/registry.json', registry);
      if (!result.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to persist registry' };
      return result;
    } catch (e) { if (e.code) throw e; throw { code: 'STORAGE_WRITE_FAILED', message: e.message }; }
  }
  userPath(userId) { return `users/${userId}`; }
  userDatabasesPath(userId) { return `${this.userPath(userId)}/databases.json`; }
  databaseMetaPath(userId, dbId) { return `${this.userPath(userId)}/databases/${dbId}/metadata.json`; }
  databaseStoragePath(userId, dbId) { return `${this.userPath(userId)}/databases/${dbId}/storage.json`; }
  databaseTablesPath(userId, dbId) { return `${this.userPath(userId)}/databases/${dbId}/tables.json`; }
  tableMetaPath(userId, dbId, tableId) { return `${this.userPath(userId)}/databases/${dbId}/tables/${tableId}/metadata.json`; }
  tableRecordsPath(userId, dbId, tableId) { return `${this.userPath(userId)}/databases/${dbId}/tables/${tableId}/records.json`; }
  auditPath(userId) { return `${this.userPath(userId)}/audit.json`; }
  apiKeysPath(userId) { return `${this.userPath(userId)}/api_keys.json`; }
  storageIntegrationsPath(userId) { return `${this.userPath(userId)}/storage_integrations.json`; }
  experiencesPath() { return 'community/experiences.json'; }

  async createDatabase(userId, dbData) {
    const metaPath = this.databaseMetaPath(userId, dbData.id);
    const metaResult = await this.hf.writeFile(metaPath, dbData);
    if (!metaResult.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to persist database metadata' };
    let databases;
    try {
      databases = await this.hf.readFile(this.userDatabasesPath(userId)) || [];
    } catch (e) {
      await this.hf.deleteFile(metaPath).catch(() => {});
      throw e.code ? e : { code: 'STORAGE_READ_FAILED', message: e.message };
    }
    databases.push({ id: dbData.id, name: dbData.name, created_at: dbData.created_at });
    try {
      const listResult = await this.hf.writeFile(this.userDatabasesPath(userId), databases);
      if (!listResult.success) { await this.hf.deleteFile(metaPath).catch(() => {}); throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to persist database list' }; }
    } catch (e) { await this.hf.deleteFile(metaPath).catch(() => {}); throw e.code ? e : { code: 'STORAGE_WRITE_FAILED', message: e.message }; }
    try {
      const registry = await this.loadRegistry();
      if (!registry.users) registry.users = {};
      if (!registry.users[userId]) registry.users[userId] = { databases: [] };
      registry.users[userId].databases.push({ id: dbData.id, name: dbData.name });
      await this.saveRegistry(registry);
    } catch (e) {
      await this.hf.deleteFile(metaPath).catch(() => {});
      const current = await this.hf.readFile(this.userDatabasesPath(userId)).catch(() => []) || [];
      const filtered = current.filter(d => d.id !== dbData.id);
      await this.hf.writeFile(this.userDatabasesPath(userId), filtered).catch(() => {});
      throw { code: 'STORAGE_WRITE_FAILED', message: `Registry update failed: ${e.message}. Rolled back.` };
    }
    return dbData;
  }
  async getDatabaseStorageBinding(userId, dbId) {
    return await this.hf.readFile(
      this.databaseStoragePath(userId, dbId)
    );
  }

  async saveDatabaseStorageBinding(userId, dbId, binding) {
    const result = await this.hf.writeFile(
      this.databaseStoragePath(userId, dbId),
      binding
    );

    if (!result.success) {
      throw {
        code: 'STORAGE_WRITE_FAILED',
        message: 'Failed to persist database storage binding'
      };
    }

    return binding;
  }

  async deleteDatabaseStorageBinding(userId, dbId) {
    const result = await this.hf.deleteFile(
      this.databaseStoragePath(userId, dbId)
    );

    if (!result.success) {
      throw {
        code: 'STORAGE_DELETE_FAILED',
        message: 'Failed to delete database storage binding'
      };
    }

    return { success: true };
  }

  async getDatabase(userId, dbId) { return await this.hf.readFile(this.databaseMetaPath(userId, dbId)); }
  async getUserDatabases(userId) {
    const meta = await this.hf.readFile(this.userDatabasesPath(userId));
    if (!meta) return [];
    const full = [];
    // A read failure here is a real storage problem, not a missing database -
    // let it propagate instead of silently shrinking the user's database list.
    for (const db of meta) { const fullMeta = await this.getDatabase(userId, db.id); if (fullMeta) full.push(fullMeta); }
    return full;
  }
  async updateDatabase(userId, dbId, updates) {
    const existing = await this.getDatabase(userId, dbId);
    if (!existing) return null;
    const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
    const result = await this.hf.writeFile(this.databaseMetaPath(userId, dbId), updated);
    if (!result.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to update database' };
    let databases = await this.hf.readFile(this.userDatabasesPath(userId)) || [];
    databases = databases.map(d => d.id === dbId ? { ...d, name: updates.name || d.name } : d);
    const listResult = await this.hf.writeFile(this.userDatabasesPath(userId), databases);
    if (!listResult.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to update database list' };
    try {
      const registry = await this.loadRegistry();
      if (registry.users && registry.users[userId]) {
        registry.users[userId].databases = registry.users[userId].databases.map(d => d.id === dbId ? { ...d, name: updates.name || d.name } : d);
        await this.saveRegistry(registry);
      }
    } catch (e) {
      throw { code: 'STORAGE_WRITE_FAILED', message: `Database updated but registry sync failed: ${e.message}` };
    }
    return updated;
  }
  async deleteDatabase(userId, dbId) {
    const tables = await this.hf.readFile(this.databaseTablesPath(userId, dbId)) || [];
    for (const table of tables) {
      const metaDel = await this.hf.deleteFile(this.tableMetaPath(userId, dbId, table.id));
      if (!metaDel.success) throw { code: 'STORAGE_DELETE_FAILED', message: `Failed to delete table ${table.id} metadata` };
      const recDel = await this.hf.deleteFile(this.tableRecordsPath(userId, dbId, table.id));
      if (!recDel.success) throw { code: 'STORAGE_DELETE_FAILED', message: `Failed to delete table ${table.id} records` };
    }
    const metaDel = await this.hf.deleteFile(this.databaseMetaPath(userId, dbId));
    if (!metaDel.success) throw { code: 'STORAGE_DELETE_FAILED', message: 'Failed to delete database metadata' };
    const tablesDel = await this.hf.deleteFile(this.databaseTablesPath(userId, dbId));
    if (!tablesDel.success) throw { code: 'STORAGE_DELETE_FAILED', message: 'Failed to delete tables list' };

    const storageBinding = await this.hf.readFile(
      this.databaseStoragePath(userId, dbId)
    );

    if (storageBinding) {
      const storageBindingDel = await this.hf.deleteFile(
        this.databaseStoragePath(userId, dbId)
      );

      if (!storageBindingDel.success) {
        throw {
          code: 'STORAGE_DELETE_FAILED',
          message: 'Failed to delete database storage binding'
        };
      }
    }
    let databases = await this.hf.readFile(this.userDatabasesPath(userId)) || [];
    databases = databases.filter(d => d.id !== dbId);
    const listResult = await this.hf.writeFile(this.userDatabasesPath(userId), databases);
    if (!listResult.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to update databases list after delete' };
    try {
      const registry = await this.loadRegistry();
      if (registry.users && registry.users[userId]) {
        registry.users[userId].databases = registry.users[userId].databases.filter(d => d.id !== dbId);
        await this.saveRegistry(registry);
      }
    } catch (e) {
      throw { code: 'STORAGE_WRITE_FAILED', message: `Database deleted but registry sync failed: ${e.message}` };
    }
    return { success: true };
  }
  async createTable(userId, dbId, tableData) {
    const metaPath = this.tableMetaPath(userId, dbId, tableData.id);
    const result = await this.hf.writeFile(metaPath, tableData);
    if (!result.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to persist table metadata' };
    const recordsResult = await this.hf.writeFile(this.tableRecordsPath(userId, dbId, tableData.id), []);
    if (!recordsResult.success) { await this.hf.deleteFile(metaPath).catch(() => {}); throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to create records file' }; }
    let tables;
    try {
      tables = await this.hf.readFile(this.databaseTablesPath(userId, dbId)) || [];
    } catch (e) {
      await this.hf.deleteFile(metaPath).catch(() => {});
      await this.hf.deleteFile(this.tableRecordsPath(userId, dbId, tableData.id)).catch(() => {});
      throw e.code ? e : { code: 'STORAGE_READ_FAILED', message: e.message };
    }
    tables.push({ id: tableData.id, name: tableData.name, created_at: tableData.created_at });
    try {
      const listResult = await this.hf.writeFile(this.databaseTablesPath(userId, dbId), tables);
      if (!listResult.success) { await this.hf.deleteFile(metaPath).catch(() => {}); await this.hf.deleteFile(this.tableRecordsPath(userId, dbId, tableData.id)).catch(() => {}); throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to update tables list' }; }
    } catch (e) { await this.hf.deleteFile(metaPath).catch(() => {}); await this.hf.deleteFile(this.tableRecordsPath(userId, dbId, tableData.id)).catch(() => {}); throw e.code ? e : { code: 'STORAGE_WRITE_FAILED', message: e.message }; }
    return tableData;
  }
  async getTable(userId, dbId, tableId) { return await this.hf.readFile(this.tableMetaPath(userId, dbId, tableId)); }
  async getDatabaseTables(userId, dbId) {
    const meta = await this.hf.readFile(this.databaseTablesPath(userId, dbId));
    if (!meta) return [];
    const full = [];
    // As above: propagate real storage failures instead of quietly dropping tables.
    for (const t of meta) {
      const fullMeta = await this.getTable(userId, dbId, t.id);
      if (fullMeta) {
        const records = await this.getRecords(userId, dbId, t.id);
        full.push({ ...fullMeta, record_count: records ? records.length : 0 });
      }
    }
    return full;
  }
  async updateTable(userId, dbId, tableId, updates) {
    const existing = await this.getTable(userId, dbId, tableId);
    if (!existing) return null;
    const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
    const result = await this.hf.writeFile(this.tableMetaPath(userId, dbId, tableId), updated);
    if (!result.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to update table' };
    return updated;
  }
  async deleteTable(userId, dbId, tableId) {
    const metaDel = await this.hf.deleteFile(this.tableMetaPath(userId, dbId, tableId));
    if (!metaDel.success) throw { code: 'STORAGE_DELETE_FAILED', message: 'Failed to delete table metadata' };
    const recDel = await this.hf.deleteFile(this.tableRecordsPath(userId, dbId, tableId));
    if (!recDel.success) throw { code: 'STORAGE_DELETE_FAILED', message: 'Failed to delete table records' };
    let tables = await this.hf.readFile(this.databaseTablesPath(userId, dbId)) || [];
    tables = tables.filter(t => t.id !== tableId);
    const listResult = await this.hf.writeFile(this.databaseTablesPath(userId, dbId), tables);
    if (!listResult.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to update tables list after delete' };
    return { success: true };
  }
  async getRecords(userId, dbId, tableId) { return await this.hf.readFile(this.tableRecordsPath(userId, dbId, tableId)) || []; }
  async insertRecords(userId, dbId, tableId, records) {
    const existing = await this.getRecords(userId, dbId, tableId) || [];
    const newRecords = [...existing, ...records];
    const result = await this.hf.writeFile(this.tableRecordsPath(userId, dbId, tableId), newRecords);
    if (!result.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to persist records' };
    return newRecords;
  }
  async updateRecords(userId, dbId, tableId, updater) {
    const existing = await this.getRecords(userId, dbId, tableId) || [];
    const updated = existing.map(updater);
    const result = await this.hf.writeFile(this.tableRecordsPath(userId, dbId, tableId), updated);
    if (!result.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to update records' };
    return updated;
  }

  async deleteUser(userId) {
    const databases = await this.getUserDatabases(userId);
    for (const db of databases) {
      await this.deleteDatabase(userId, db.id);
    }
    const paths = [
      this.userDatabasesPath(userId),
      this.auditPath(userId),
      this.apiKeysPath(userId),
      this.storageIntegrationsPath(userId)
    ];
    for (const filePath of paths) {
      const result = await this.hf.deleteFile(filePath);
      if (!result.success) throw { code: 'STORAGE_DELETE_FAILED', message: `Failed to delete ${filePath}` };
    }
    try {
      const registry = await this.loadRegistry();
      if (registry.users) delete registry.users[userId];
      await this.saveRegistry(registry);
    } catch (e) {
      throw { code: 'STORAGE_WRITE_FAILED', message: `Registry cleanup failed: ${e.message}` };
    }
    return { success: true };
  }

  async deleteRecords(userId, dbId, tableId, predicate) {
    const existing = await this.getRecords(userId, dbId, tableId) || [];
    const remaining = existing.filter(r => !predicate(r));
    const deleted = existing.filter(r => predicate(r));
    const result = await this.hf.writeFile(this.tableRecordsPath(userId, dbId, tableId), remaining);
    if (!result.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to delete records' };
    return { remaining, deleted, count: deleted.length };
  }
  async addAudit(userId, entry) {
    // Audit logging is intentionally best-effort and must never block or fail
    // a core database/table/record operation. A failure here is logged, not
    // rethrown - but it must not be mistaken for a successful write either.
    try {
      const audit = await this.hf.readFile(this.auditPath(userId)) || [];
      audit.push({ ...entry, timestamp: new Date().toISOString() });
      const trimmed = audit.slice(-100);
      const result = await this.hf.writeFile(this.auditPath(userId), trimmed);
      if (!result.success) console.error(`[Audit] best-effort write failed for user ${userId}`);
    } catch (e) {
      console.error(`[Audit] best-effort logging failed for user ${userId}: ${e.message || e}`);
    }
  }
  async getAudit(userId) { return await this.hf.readFile(this.auditPath(userId)) || []; }
  // API keys (hashed). Failures propagate: a key list must never silently look empty.
  async getApiKeys(userId) { return await this.hf.readFile(this.apiKeysPath(userId)) || []; }
  async getExperiences() {
    return await this.hf.readFile(this.experiencesPath()) || [];
  }
  async saveExperiences(experiences) {
    const result = await this.hf.writeFile(this.experiencesPath(), experiences);
    if (!result.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to save community experiences' };
    return experiences;
  }
  async upsertExperience(userId, experience) {
    const existing = await this.getExperiences();
    const withoutUser = existing.filter(x => x.user_id !== userId);
    const saved = [...withoutUser, experience].sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
    await this.saveExperiences(saved);
    return experience;
  }
  async deleteExperience(userId) {
    const existing = await this.getExperiences();
    const remaining = existing.filter(x => x.user_id !== userId);
    if (remaining.length === existing.length) return false;
    await this.saveExperiences(remaining);
    return true;
  }

  async saveApiKeys(userId, keys) {
    const result = await this.hf.writeFile(this.apiKeysPath(userId), keys);
    if (!result.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Storage write failed. Please try again.' };
    return keys;
  }

  async getStorageIntegrations(userId) {
    return await this.hf.readFile(
      this.storageIntegrationsPath(userId)
    ) || [];
  }

  async saveStorageIntegrations(userId, integrations) {
    const result = await this.hf.writeFile(
      this.storageIntegrationsPath(userId),
      integrations
    );

    if (!result.success) {
      throw {
        code: 'STORAGE_WRITE_FAILED',
        message: 'Failed to save storage integrations'
      };
    }

    return integrations;
  }
}
export function createStorageAdapter(config = {}) { return new StorageAdapter(config); }
let singleton = null;
let singletonKey = null;
export function getStorageAdapter(config = {}) {
  const token = config.token || ''; const dataset = config.dataset || ''; const isProduction = !!config.isProduction; const key = `${token}|${dataset}|${isProduction}`;
  if (config.token || config.dataset || config.isProduction !== undefined) return new StorageAdapter(config);
  if (!singleton || singletonKey !== key) { singleton = new StorageAdapter(config); singletonKey = key; }
  return singleton;
}
export function resetStorageAdapter() { singleton = null; singletonKey = null; }
