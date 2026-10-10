// Per-account file storage on the Hugging Face dataset.
// Hugging Face rejects raw binary files in plain commits, so each file is stored as a JSON document that
// holds the file bytes as base64 text: users/<userId>/files/<name>.json  (+ index users/<userId>/files.json)
const NAME_OK = /^[A-Za-z0-9_][A-Za-z0-9_.\- ()\[\]]{0,99}$/;
export const MAX_FILE_BYTES = 7 * 1024 * 1024; // ~9.3 MB once base64-encoded (Hugging Face plain-commit limit is 10 MB)

export function createFileService({ storage, env = {} }) {
  const quota = Number(env.FILE_QUOTA_BYTES) || 500 * 1024 * 1024; // free plan: 500 MB per account
  const indexPath = (u) => `users/${u}/files.json`;
  const blobPath = (u, n) => `users/${u}/files/${n}.json`;
  const readIndex = async (u) => (await storage.hf.readFile(indexPath(u))) || [];
  const writeIndex = async (u, list) => { const r = await storage.hf.writeFile(indexPath(u), list); if (!r.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to update file index' }; };
  const summary = (list) => { const used = list.reduce((a, f) => a + f.size, 0); return { used, quota, remaining: Math.max(quota - used, 0), count: list.length, max_file_bytes: MAX_FILE_BYTES }; };

  return {
    async list(userId) { const files = await readIndex(userId); return { files, usage: summary(files) }; },
    async usage(userId) { return summary(await readIndex(userId)); },
    async put(userId, name, bytes, contentType) {
      name = String(name || '');
      if (!NAME_OK.test(name)) throw { code: 'INVALID_FILE_NAME', message: 'File name: 1-100 characters, letters, numbers, space and . _ - ( ) [ ] (must not start with a symbol).' };
      if (!bytes || !bytes.length) throw { code: 'INVALID_FILE', message: 'File is empty.' };
      if (bytes.length > MAX_FILE_BYTES) throw { code: 'FILE_TOO_LARGE', message: `File too large (max ${MAX_FILE_BYTES / 1048576} MB per file).` };
      const list = await readIndex(userId), old = list.find((f) => f.name === name);
      const used = list.reduce((a, f) => a + f.size, 0) - (old ? old.size : 0);
      if (used + bytes.length > quota) throw { code: 'STORAGE_QUOTA_EXCEEDED', message: `Not enough file storage left (${Math.max(quota - used, 0)} bytes available).` };
      const meta = { name, size: bytes.length, content_type: String(contentType || 'application/octet-stream').slice(0, 100), created_at: new Date().toISOString() };
      const w = await storage.hf.writeFile(blobPath(userId, name), { ...meta, data: Buffer.from(bytes).toString('base64') });
      if (!w.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to store file' };
      const next = [...list.filter((f) => f.name !== name), meta];
      try { await writeIndex(userId, next); } catch (e) { if (!old) await storage.hf.deleteFile(blobPath(userId, name)).catch(() => {}); throw e; }
      return { file: meta, usage: summary(next) };
    },
    async get(userId, name) {
      const meta = (await readIndex(userId)).find((f) => f.name === String(name));
      if (!meta) throw { code: 'FILE_NOT_FOUND', message: 'File not found' };
      const blob = await storage.hf.readFile(blobPath(userId, meta.name));
      if (!blob || typeof blob.data !== 'string') throw { code: 'FILE_NOT_FOUND', message: 'File not found' };
      return { bytes: Buffer.from(blob.data, 'base64'), meta };
    },
    async remove(userId, name) {
      const list = await readIndex(userId);
      if (!list.find((f) => f.name === String(name))) throw { code: 'FILE_NOT_FOUND', message: 'File not found' };
      const d = await storage.hf.deleteFile(blobPath(userId, String(name)));
      if (d && d.success === false) throw { code: 'STORAGE_DELETE_FAILED', message: 'Failed to delete file' };
      const next = list.filter((f) => f.name !== String(name)); await writeIndex(userId, next);
      return { usage: summary(next) };
    },
  };
}
