let fsPromises = null;
let pathMod = null;
let fsAvailable = false;
try {
  const fs = await import('fs/promises');
  const p = await import('path');
  fsPromises = fs;
  pathMod = p;
  fsAvailable = true;
} catch { fsAvailable = false; }

// Public-facing storage errors are deliberately generic: the storage provider,
// dataset name and upstream status details must never reach API clients.
// The real detail is written to the server log only.
const PUBLIC_STORAGE_MESSAGES = {
  STORAGE_READ_FAILED: 'Storage read failed. Please try again.',
  STORAGE_WRITE_FAILED: 'Storage write failed. Please try again.',
  STORAGE_DELETE_FAILED: 'Storage delete failed. Please try again.',
  STORAGE_NOT_CONFIGURED: 'Storage is not available.'
};
function storageError(code, detail) {
  console.error(`[storage] ${code}: ${detail}`);
  const err = new Error(PUBLIC_STORAGE_MESSAGES[code] || 'Storage error');
  err.code = code;
  return err;
}

export class HuggingFaceClient {
  constructor(config = {}) {
    this.token = config.token || '';
    this.dataset = config.dataset || '';
    this.isProduction = !!config.isProduction;
    this.allowMock = config.allowMock !== undefined ? config.allowMock : !this.isProduction;
    this.localPath = config.localPath || './data/hf-mock';
    this.useMock = !this.token || !this.dataset;
    this.cache = new Map();
    this.cacheTTL = 30000;
    this.mode = this.useMock ? 'local-mock' : 'huggingface';
  }
  getMode() { return this.mode; }
  async ensureLocalDir(filePath) {
    if (!fsAvailable || !pathMod) return;
    try { const dir = pathMod.dirname(filePath); await fsPromises.mkdir(dir, { recursive: true }); } catch {}
  }
  getLocalPath(hfPath) {
    if (!pathMod) return `./data/hf-mock/${hfPath}`;
    return pathMod.join(this.localPath, hfPath);
  }
  async writeFile(hfPath, data) {
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    if (this.useMock) {
      if (this.isProduction && !this.allowMock) {
        throw storageError('STORAGE_NOT_CONFIGURED', `not configured - cannot write ${hfPath} in production`);
      }
      if (!fsAvailable) {
        this.cache.set(hfPath, { data: typeof data === 'string' ? JSON.parse(data) : data, ts: Date.now() });
        return { success: true, path: hfPath, mode: 'memory-mock' };
      }
      try {
        const localPath = this.getLocalPath(hfPath);
        await this.ensureLocalDir(localPath);
        await fsPromises.writeFile(localPath, jsonStr, 'utf-8');
        this.cache.delete(hfPath);
        return { success: true, path: hfPath, mode: 'mock' };
      } catch (e) { throw storageError('STORAGE_WRITE_FAILED', e.message); }
    }
    try {
      await this.commitHF(hfPath, jsonStr, 'create');
      this.cache.set(hfPath, { data: typeof data === 'string' ? JSON.parse(data) : data, ts: Date.now() });
      return { success: true, path: hfPath, mode: 'live' };
    } catch (e) {
      if (this.isProduction) {
        throw storageError('STORAGE_WRITE_FAILED', e.message);
      }
      if (fsAvailable) {
        try {
          const localPath = this.getLocalPath(hfPath);
          await this.ensureLocalDir(localPath);
          await fsPromises.writeFile(localPath, jsonStr, 'utf-8');
          return { success: true, path: hfPath, mode: 'mock-fallback-dev' };
        } catch {}
      }
      throw storageError('STORAGE_WRITE_FAILED', e.message);
    }
  }
  async commitHF(hfPath, content, action) {
    // Hugging Face Hub's commit API takes application/x-ndjson: a "header"
    // line describing the commit, followed by one operation line per file -
    // "file" (base64-encoded content) for create/update, "deletedFile" for
    // delete. A plain JSON body with a commitTitle/actions shape is not the
    // API this endpoint accepts.
    const url = `https://huggingface.co/api/datasets/${this.dataset}/commit/main`;
    const failCode = action === 'delete' ? 'STORAGE_DELETE_FAILED' : 'STORAGE_WRITE_FAILED';
    const lines = [
      JSON.stringify({
        key: 'header',
        value: { summary: `${action} ${hfPath}`, description: `Smartbase ${action} ${hfPath}` }
      })
    ];
    if (action === 'delete') {
      lines.push(JSON.stringify({ key: 'deletedFile', value: { path: hfPath } }));
    } else {
      const base64Content = typeof Buffer !== 'undefined'
        ? Buffer.from(content, 'utf-8').toString('base64')
        : btoa(unescape(encodeURIComponent(content)));
      lines.push(JSON.stringify({ key: 'file', value: { path: hfPath, content: base64Content, encoding: 'base64' } }));
    }
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/x-ndjson' },
        body: lines.join('\n') + '\n'
      });
    } catch (e) {
      throw storageError(failCode, `commit network error: ${e.message}`);
    }
    if (!response.ok) {
      // A genuine 404 while deleting means the file is already gone - that's
      // a success. Every other status (401/403/429/500+) is a real failure.
      if (action === 'delete' && response.status === 404) return { success: true };
      const text = await response.text().catch(() => '');
      throw storageError(failCode, `commit ${response.status}: ${text.substring(0, 300)}`);
    }
    return { success: true };
  }
  async readFile(hfPath) {
    const cached = this.cache.get(hfPath);
    if (cached && Date.now() - cached.ts < this.cacheTTL) return cached.data;
    if (this.useMock) {
      if (this.isProduction && !this.allowMock) return null;
      if (!fsAvailable) return cached ? cached.data : null;
      try {
        const localPath = this.getLocalPath(hfPath);
        const content = await fsPromises.readFile(localPath, 'utf-8');
        const data = JSON.parse(content);
        this.cache.set(hfPath, { data, ts: Date.now() });
        return data;
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw storageError('STORAGE_READ_FAILED', `local read failed for ${hfPath}: ${e.message}`);
      }
    }
    // Live Hugging Face read. Only a genuine 404 means "the file does not
    // exist" - every other failure mode (auth errors, server errors, network
    // failures, bad JSON) must propagate so a broken database never looks empty.
    // Two mirror URLs are tried; a 404 from one must never mask a real error
    // (401/403/429/500+/network) already seen from the other.
    const urls = [
      `https://huggingface.co/datasets/${this.dataset}/resolve/main/${hfPath}`,
      `https://huggingface.co/datasets/${this.dataset}/raw/main/${hfPath}`
    ];
    let lastError = null;
    for (const url of urls) {
      let response;
      try {
        response = await fetch(url, { headers: { 'Authorization': `Bearer ${this.token}` } });
      } catch (e) {
        lastError = e;
        continue;
      }
      if (response.status === 404) continue;
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        lastError = new Error(`HF read ${response.status}: ${text.substring(0, 300)}`);
        continue;
      }
      const text = await response.text();
      try {
        const data = JSON.parse(text);
        this.cache.set(hfPath, { data, ts: Date.now() });
        return data;
      } catch (e) {
        throw storageError('STORAGE_READ_FAILED', `invalid JSON for ${hfPath}: ${e.message}`);
      }
    }
    if (lastError) {
      throw storageError('STORAGE_READ_FAILED', `read failed for ${hfPath}: ${lastError.message}`);
    }
    // Every mirror we tried came back with a confirmed 404 - the file really doesn't exist.
    return null;
  }
  async deleteFile(hfPath) {
    this.cache.delete(hfPath);
    if (this.useMock) {
      if (this.isProduction && !this.allowMock) {
        throw storageError('STORAGE_NOT_CONFIGURED', `not configured - cannot delete ${hfPath}`);
      }
      if (!fsAvailable) return { success: true, mode: 'memory-mock' };
      try {
        const localPath = this.getLocalPath(hfPath);
        await fsPromises.unlink(localPath);
        return { success: true, mode: 'mock' };
      } catch (e) { if (e.code === 'ENOENT') return { success: true, mode: 'mock-not-found' }; throw storageError('STORAGE_DELETE_FAILED', e.message); }
    }
    try {
      await this.commitHF(hfPath, null, 'delete');
      return { success: true, mode: 'live' };
    } catch (e) {
      if (this.isProduction) throw storageError('STORAGE_DELETE_FAILED', e.message);
      return { success: true, mode: 'mock-fallback-dev' };
    }
  }
  clearCache() { this.cache.clear(); }
}
export function createHFClient(config = {}) { return new HuggingFaceClient(config); }
let clientInstance = null;
let clientConfigKey = null;
export function getHFClient(config = {}) {
  const key = `${config.token || ''}|${config.dataset || ''}|${config.isProduction}`;
  if (!clientInstance || clientConfigKey !== key) { clientInstance = new HuggingFaceClient(config); clientConfigKey = key; }
  return clientInstance;
}
export function resetHFClient() { clientInstance = null; clientConfigKey = null; }
