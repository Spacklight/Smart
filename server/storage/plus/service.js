import crypto from "node:crypto";

import {
  encryptSecret,
  decryptSecret
} from "./encryption.js";

import {
  getPlusStorageManager
} from "./manager.js";

const ALLOWED_PROVIDERS = new Set(["backblaze-b2"]);

function createConnectionId() {
  return `sto_${crypto.randomUUID().replaceAll("-", "")}`;
}

function sanitizeConnection(connection) {
  return {
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
    endpoint: connection.endpoint,
    region: connection.region,
    bucket: connection.bucket,
    created_at: connection.created_at,
    updated_at: connection.updated_at
  };
}

export class PlusStorageService {
  constructor(storageAdapter, env = {}) {
    if (!storageAdapter) {
      throw new Error("Storage adapter is required");
    }

    this.storage = storageAdapter;
    this.env = env;
    this.encryptionSecret =
      env.SMARTBASE_STORAGE_ENCRYPTION_KEY ||
      env.JWT_SECRET ||
      "";

    if (!this.encryptionSecret) {
      throw new Error(
        "SMARTBASE_STORAGE_ENCRYPTION_KEY or JWT_SECRET is required"
      );
    }

    this.manager = getPlusStorageManager();
  }

  async getConnections(userId) {
    if (!userId) {
      throw new Error("User ID is required");
    }

    const connections =
      await this.storage.getStorageIntegrations(userId);

    return connections.map(sanitizeConnection);
  }

  async addConnection(userId, input) {
    if (!userId) {
      throw new Error("User ID is required");
    }

    if (!input || typeof input !== "object") {
      throw new Error("Storage configuration is required");
    }

    const provider = String(input.provider || "")
      .trim()
      .toLowerCase();

    if (!ALLOWED_PROVIDERS.has(provider)) {
      const error = new Error(
        `Unsupported storage provider: ${input.provider}`
      );
      error.code = "INVALID_PROVIDER";
      throw error;
    }

    const required = [
      "name",
      "endpoint",
      "bucket",
      "accessKeyId",
      "secretAccessKey"
    ];

    for (const field of required) {
      if (!input[field]) {
        const error = new Error(`${field} is required`);
        error.code = "INVALID_CONNECTION";
        throw error;
      }
    }

    const existing =
      await this.storage.getStorageIntegrations(userId);

    const duplicate = existing.find(
      connection =>
        String(connection.name).toLowerCase() ===
        String(input.name).trim().toLowerCase()
    );

    if (duplicate) {
      const error = new Error(
        "A storage connection with this name already exists"
      );
      error.code = "CONNECTION_NAME_EXISTS";
      throw error;
    }

    const connection = {
      id: createConnectionId(),
      name: String(input.name).trim(),
      provider,
      endpoint: String(input.endpoint).trim(),
      region: input.region
        ? String(input.region).trim()
        : undefined,
      bucket: String(input.bucket).trim(),
      forcePathStyle: input.forcePathStyle !== false,

      // Both credential values are encrypted before persistence.
      accessKeyId: encryptSecret(
        String(input.accessKeyId),
        this.encryptionSecret
      ),

      secretAccessKey: encryptSecret(
        String(input.secretAccessKey),
        this.encryptionSecret
      ),

      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const updated = [
      ...existing,
      connection
    ];

    await this.storage.saveStorageIntegrations(
      userId,
      updated
    );

    return sanitizeConnection(connection);
  }

  async getDatabaseBinding(userId, dbId) {
    const database = await this.storage.getDatabase(userId, dbId);

    if (!database) {
      throw {
        code: 'DATABASE_NOT_FOUND',
        message: 'Database not found'
      };
    }

    const binding = await this.storage.getDatabaseStorageBinding(userId, dbId);

    if (!binding) {
      return null;
    }

    const connections = await this.storage.getStorageIntegrations(userId);
    const connection = connections.find(c => c.id === binding.connectionId);

    if (!connection) {
      return {
        ...binding,
        connection: null,
        status: 'connection_missing'
      };
    }

    return {
      ...binding,
      connection: {
        id: connection.id,
        name: connection.name,
        provider: connection.provider,
        bucket: connection.bucket
      },
      status: 'connected'
    };
  }

  async bindDatabase(userId, dbId, input = {}) {
    const database = await this.storage.getDatabase(userId, dbId);

    if (!database) {
      throw {
        code: 'DATABASE_NOT_FOUND',
        message: 'Database not found'
      };
    }

    const connectionId = String(input.connectionId || '').trim();

    if (!connectionId) {
      throw {
        code: 'INVALID_BINDING',
        message: 'connectionId is required'
      };
    }

    const connections = await this.storage.getStorageIntegrations(userId);
    const connection = connections.find(c => c.id === connectionId);

    if (!connection) {
      throw {
        code: 'CONNECTION_NOT_FOUND',
        message: 'Storage connection not found'
      };
    }

    const prefix = String(
      input.prefix || `databases/${dbId}/`
    ).trim();

    if (!prefix) {
      throw {
        code: 'INVALID_BINDING',
        message: 'Storage prefix cannot be empty'
      };
    }

    if (prefix.startsWith('/') || prefix.includes('..')) {
      throw {
        code: 'INVALID_BINDING',
        message: 'Invalid storage prefix'
      };
    }

    const existing = await this.storage.getDatabaseStorageBinding(userId, dbId);

    const binding = {
      connectionId,
      prefix: prefix.endsWith('/') ? prefix : `${prefix}/`,
      enabled: true,
      created_at: existing?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await this.storage.saveDatabaseStorageBinding(
      userId,
      dbId,
      binding
    );

    return {
      ...binding,
      connection: {
        id: connection.id,
        name: connection.name,
        provider: connection.provider,
        bucket: connection.bucket
      },
      status: 'connected'
    };
  }

  async unbindDatabase(userId, dbId) {
    const database = await this.storage.getDatabase(userId, dbId);

    if (!database) {
      throw {
        code: 'DATABASE_NOT_FOUND',
        message: 'Database not found'
      };
    }

    const binding = await this.storage.getDatabaseStorageBinding(
      userId,
      dbId
    );

    if (!binding) {
      return {
        success: true,
        message: 'Database has no storage binding'
      };
    }

    await this.storage.deleteDatabaseStorageBinding(userId, dbId);

    return {
      success: true,
      message: 'Database storage binding removed'
    };
  }

  async removeConnection(userId, connectionId) {
    if (!userId) {
      throw new Error("User ID is required");
    }

    const existing =
      await this.storage.getStorageIntegrations(userId);

    const remaining = existing.filter(
      connection => connection.id !== connectionId
    );

    if (remaining.length === existing.length) {
      const error = new Error(
        "Storage connection not found"
      );
      error.code = "CONNECTION_NOT_FOUND";
      throw error;
    }

    await this.storage.saveStorageIntegrations(
      userId,
      remaining
    );

    return {
      id: connectionId,
      removed: true
    };
  }

  async getInternalConnection(userId, connectionId) {
    const connections =
      await this.storage.getStorageIntegrations(userId);

    const connection = connections.find(
      item => item.id === connectionId
    );

    if (!connection) {
      const error = new Error(
        "Storage connection not found"
      );
      error.code = "CONNECTION_NOT_FOUND";
      throw error;
    }

    return {
      ...connection,

      accessKeyId: decryptSecret(
        connection.accessKeyId,
        this.encryptionSecret
      ),

      secretAccessKey: decryptSecret(
        connection.secretAccessKey,
        this.encryptionSecret
      )
    };
  }

  async createAdapter(userId, connectionId) {
    const connection =
      await this.getInternalConnection(
        userId,
        connectionId
      );

    return this.manager.createAdapter({
      provider: connection.provider,
      endpoint: connection.endpoint,
      region: connection.region,
      bucket: connection.bucket,
      forcePathStyle: connection.forcePathStyle !== false,
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey
    });
  }

  async testConnection(userId, connectionId) {
    const adapter =
      await this.createAdapter(
        userId,
        connectionId
      );

    const result = await adapter.list("", 1);

    return {
      connected: true,
      objectCountReturned: result.objects.length
    };
  }

  async createUploadUrl(
    userId,
    connectionId,
    key,
    {
      expiresIn = 900,
      contentType
    } = {}
  ) {
    const adapter =
      await this.createAdapter(
        userId,
        connectionId
      );

    return await adapter.createUploadUrl(
      key,
      expiresIn,
      contentType
    );
  }

  // ---- Actions that prove a database really is bound to the bucket ----
  async _boundAdapter(userId, dbId) {
    const database = await this.storage.getDatabase(userId, dbId);
    if (!database) throw { code: 'DATABASE_NOT_FOUND', message: 'Database not found' };
    const binding = await this.storage.getDatabaseStorageBinding(userId, dbId);
    if (!binding) throw { code: 'NOT_BOUND', message: 'This database is not bound to external storage yet.' };
    let adapter;
    try { adapter = await this.createAdapter(userId, binding.connectionId); }
    catch (e) { throw { code: 'CONNECTION_NOT_FOUND', message: 'The storage connection for this database no longer exists.' }; }
    return { database, binding, adapter };
  }
  _extErr(e) { return e && e.code ? e : { code: 'EXTERNAL_FAILED', message: `Your storage provider did not accept the request (${(e && (e.name || e.Code)) || 'error'}). Check the bucket and keys.` }; }

  /** Writes, finds and deletes a test object in the bucket, and records when it last worked. */
  async verifyDatabaseBinding(userId, dbId) {
    const { binding, adapter } = await this._boundAdapter(userId, dbId), t0 = Date.now();
    const key = `${binding.prefix}.smartbase-check/${crypto.randomUUID()}.txt`;
    try {
      await adapter.upload(key, 'smartbase check ' + new Date().toISOString(), 'text/plain');
      const found = (await adapter.list(key, 1)).objects.find((o) => o.key === key);
      await adapter.delete(key);
      if (!found) throw { code: 'EXTERNAL_FAILED', message: 'The test file was written but not found in your bucket.' };
      const result = { ok: true, ms: Date.now() - t0, wrote_bytes: found.size, steps: ['wrote a test file', 'found it in the bucket', 'deleted it'], verified_at: new Date().toISOString() };
      await this.storage.saveDatabaseStorageBinding(userId, dbId, { ...binding, last_verified_at: result.verified_at, last_verified_ms: result.ms });
      return result;
    } catch (e) { throw this._extErr(e); }
  }

  /** Saves a full copy of the database (every table and record) into the bound bucket. */
  async backupDatabase(userId, dbId) {
    const { database, binding, adapter } = await this._boundAdapter(userId, dbId);
    const list = (await this.storage.hf.readFile(this.storage.databaseTablesPath(userId, dbId))) || [], tables = [];
    for (const entry of list) {
      const meta = await this.storage.getTable(userId, dbId, entry.id); if (!meta) continue;
      tables.push({ name: meta.name, columns: meta.columns, engine: meta.engine || null, records: await this.storage.getRecords(userId, dbId, meta.id) });
    }
    const created = new Date().toISOString();
    const body = JSON.stringify({ format: 'smartbase-backup-v1', created_at: created, database: { id: dbId, name: database.name }, tables });
    if (body.length > 40 * 1024 * 1024) throw { code: 'BACKUP_TOO_LARGE', message: 'This database is too large to back up in one file.' };
    const key = `${binding.prefix}backups/${created.replace(/[:.]/g, '-')}.json`;
    try { await adapter.upload(key, body, 'application/json'); } catch (e) { throw this._extErr(e); }
    const result = { key, bytes: Buffer.byteLength(body), tables: tables.length, records: tables.reduce((a, t) => a + t.records.length, 0), created_at: created };
    await this.storage.saveDatabaseStorageBinding(userId, dbId, { ...binding, last_backup_at: created, last_backup_key: key, last_backup_bytes: result.bytes });
    return result;
  }
  async listDatabaseBackups(userId, dbId) {
    const { binding, adapter } = await this._boundAdapter(userId, dbId);
    try {
      const r = await adapter.list(`${binding.prefix}backups/`, 100);
      return { backups: r.objects.map((o) => ({ key: o.key, bytes: o.size, created_at: o.lastModified })).sort((a, b) => (a.key < b.key ? 1 : -1)), truncated: r.truncated };
    } catch (e) { throw this._extErr(e); }
  }
  async backupDownloadUrl(userId, dbId, key) {
    const { binding, adapter } = await this._boundAdapter(userId, dbId);
    if (!String(key).startsWith(`${binding.prefix}backups/`) || String(key).includes('..')) throw { code: 'INVALID_BINDING', message: 'Invalid backup key.' };
    try { return { url: (await adapter.createDownloadUrl(String(key), 600, String(key).split('/').pop())).url }; } catch (e) { throw this._extErr(e); }
  }

  async createDownloadUrl(
    userId,
    connectionId,
    key,
    {
      expiresIn = 900
    } = {}
  ) {
    const adapter =
      await this.createAdapter(
        userId,
        connectionId
      );

    return await adapter.createDownloadUrl(
      key,
      expiresIn
    );
  }
}
