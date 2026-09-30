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
