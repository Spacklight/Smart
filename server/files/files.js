// Per-account file storage.
//  * Smartbase storage (free 1 GB): files live in the platform's Hugging Face dataset. Hugging Face only accepts small
//    files in a normal commit, so files up to 5 MB are one document and larger files (up to 50 MB) are stored in 5 MB parts.
//  * External storage: when the account is bound to a Backblaze B2 connection, files go straight to that bucket.
const NAME_OK = /^[A-Za-z0-9_][A-Za-z0-9_.\- ()\[\]]{0,99}$/;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const CHUNK_BYTES = 5 * 1024 * 1024;
const NC = { cache: false }; // never keep file data in the in-memory cache
const err = (code, message) => ({ code, message });

export function createFileService({ storage, env = {}, plusStorage = null }) {
  const quota = Number(env.FILE_QUOTA_BYTES) || 1024 * 1024 * 1024; // free plan: 1 GB per account (Smartbase storage only)
  const hf = storage.hf;
  const P = {
    index: (u) => `users/${u}/files.json`,
    bind: (u) => `users/${u}/files-binding.json`,
    blob: (u, n) => `users/${u}/files/${n}.json`,
    part: (u, n, i) => `users/${u}/files/${n}/part-${String(i).padStart(4, '0')}.json`,
  };
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  const readIndex = async (u) => (await hf.readFile(P.index(u))) || [];
  const writeIndex = async (u, list) => { const r = await hf.writeFile(P.index(u), list); if (!r.success) throw err('STORAGE_WRITE_FAILED', 'Failed to update the file list'); };
  const used = (list) => list.filter((f) => f.storage !== 'b2').reduce((a, f) => a + f.size, 0);
  const summary = (list) => ({ used: used(list), quota, remaining: Math.max(quota - used(list), 0), count: list.length, external_count: list.filter((f) => f.storage === 'b2').length, max_file_bytes: MAX_FILE_BYTES, chunk_bytes: CHUNK_BYTES });
  const checkName = (n) => { if (!NAME_OK.test(String(n || ''))) throw err('INVALID_FILE_NAME', 'File name: 1-100 characters, letters, numbers, space and . _ - ( ) [ ] (must not start with a symbol).'); return String(n); };
  const checkQuota = (list, name, size) => { const old = list.find((f) => f.name === name); if (used(list) - (old && old.storage !== 'b2' ? old.size : 0) + size > quota) throw err('STORAGE_QUOTA_EXCEEDED', 'Not enough free storage left for this file.'); };
  const getBinding = async (u) => { const b = await hf.readFile(P.bind(u)); return b && b.mode === 'b2' && b.connectionId ? b : { mode: 'smartbase' }; };
  const extKey = (u, name) => `smartbase/files/${u}/${name}`;

  async function adapterFor(u) {
    const b = await getBinding(u);
    if (b.mode !== 'b2' || !plusStorage) throw err('NOT_BOUND', 'File storage is not bound to an external bucket.');
    try { return { binding: b, adapter: await plusStorage.createAdapter(u, b.connectionId) }; }
    catch (e) { throw err('CONNECTION_NOT_FOUND', 'The storage connection for your files was not found. Choose a storage location again.'); }
  }
  const ext = async (fn) => { try { return await fn(); } catch (e) { if (e && e.code) throw e; throw err('EXTERNAL_FAILED', `Your storage provider did not accept the request (${(e && (e.name || e.Code)) || 'error'}). Check the bucket, keys and CORS settings.`); } };

  async function dropStored(u, f, keepParts = 0) {
    if (f.storage === 'b2') { try { const { adapter } = await adapterFor(u); await adapter.delete(f.key); } catch (e) { /* the object may already be gone */ } return; }
    if (f.parts) { const paths = []; for (let i = keepParts; i < f.parts; i++) paths.push(P.part(u, f.name, i)); if (paths.length) await hf.deleteMany(paths); }
    else await hf.deleteFile(P.blob(u, f.name));
  }
  async function setEntry(u, list, entry) { const next = [...list.filter((f) => f.name !== entry.name), entry]; await writeIndex(u, next); return next; }

  return {
    async list(userId) { const files = await readIndex(userId); return { files, usage: summary(files), binding: await getBinding(userId) }; },
    async usage(userId) { return summary(await readIndex(userId)); },

    /** One request, up to 5 MB. */
    async put(userId, name, bytes, contentType) {
      name = checkName(name);
      if (!bytes || !bytes.length) throw err('INVALID_FILE', 'File is empty.');
      if (bytes.length > CHUNK_BYTES) throw err('USE_PARTS', `Files over ${CHUNK_BYTES / 1048576} MB are uploaded in parts: PUT /files/NAME/parts/INDEX, then POST /files/NAME/complete.`);
      const ct = String(contentType || 'application/octet-stream').slice(0, 100), list = await readIndex(userId), old = list.find((f) => f.name === name);
      const meta = { name, size: bytes.length, content_type: ct, created_at: new Date().toISOString() };
      const b = await getBinding(userId);
      if (b.mode === 'b2') {
        const { adapter } = await adapterFor(userId); const key = extKey(userId, name);
        await ext(() => adapter.upload(key, Buffer.from(bytes), ct));
        const next = await setEntry(userId, list, { ...meta, storage: 'b2', key, connectionId: b.connectionId });
        if (old && old.storage !== 'b2') await dropStored(userId, old);
        return { file: meta, usage: summary(next) };
      }
      checkQuota(list, name, bytes.length);
      const w = await hf.writeFile(P.blob(userId, name), { ...meta, data: b64(bytes) }, NC);
      if (!w.success) throw err('STORAGE_WRITE_FAILED', 'Failed to store file');
      const next = await setEntry(userId, list, { ...meta, storage: 'smartbase' });
      if (old && (old.storage === 'b2' || old.parts)) await dropStored(userId, old);
      return { file: meta, usage: summary(next) };
    },

    /** Large files: one 5 MB part per request. */
    async putPart(userId, name, index, total, size, bytes) {
      name = checkName(name);
      if ((await getBinding(userId)).mode === 'b2') throw err('USE_PRESIGN', 'Your files are stored in your own bucket. Request an upload link with POST /files-storage/presign.');
      if (![index, total, size].every(Number.isInteger) || size <= CHUNK_BYTES || size > MAX_FILE_BYTES || total !== Math.ceil(size / CHUNK_BYTES) || index < 0 || index >= total) throw err('INVALID_PART', 'Invalid part: send total=ceil(size/5MB), size (6 bytes to 50 MB) and a part index inside the range.');
      const expect = index < total - 1 ? CHUNK_BYTES : size - CHUNK_BYTES * (total - 1);
      if (!bytes || bytes.length !== expect) throw err('INVALID_PART', `Part ${index} must be exactly ${expect} bytes.`);
      checkQuota(await readIndex(userId), name, size);
      const w = await hf.writeFile(P.part(userId, name, index), { data: b64(bytes) }, NC);
      if (!w.success) throw err('STORAGE_WRITE_FAILED', 'Failed to store file part');
      return { received: index };
    },
    async complete(userId, name, { total, size, content_type }) {
      name = checkName(name);
      if ((await getBinding(userId)).mode === 'b2') throw err('USE_PRESIGN', 'Your files are stored in your own bucket.');
      if (![total, size].every(Number.isInteger) || size <= CHUNK_BYTES || size > MAX_FILE_BYTES || total !== Math.ceil(size / CHUNK_BYTES)) throw err('INVALID_PART', 'Invalid total or size.');
      const list = await readIndex(userId), old = list.find((f) => f.name === name);
      checkQuota(list, name, size);
      const meta = { name, size, content_type: String(content_type || 'application/octet-stream').slice(0, 100), created_at: new Date().toISOString(), parts: total, storage: 'smartbase' };
      const next = await setEntry(userId, list, meta);
      if (old) { if (old.parts) await dropStored(userId, old, total); else await dropStored(userId, old); } // remove what the new version no longer uses
      return { file: meta, usage: summary(next) };
    },

    async get(userId, name) {
      const meta = (await readIndex(userId)).find((f) => f.name === String(name));
      if (!meta) throw err('FILE_NOT_FOUND', 'File not found');
      if (meta.storage === 'b2') {
        const { adapter } = await adapterFor(userId);
        const link = await ext(() => adapter.createDownloadUrl(meta.key, 600, meta.name));
        return { kind: 'redirect', url: link.url, meta };
      }
      const read = async (p) => { const d = await hf.readFile(p, NC); if (!d || typeof d.data !== 'string') throw err('FILE_NOT_FOUND', 'File is incomplete or missing'); return Buffer.from(d.data, 'base64'); };
      if (meta.parts) return { kind: 'stream', meta, count: meta.parts, readPart: (i) => read(P.part(userId, meta.name, i)) };
      return { kind: 'bytes', meta, bytes: await read(P.blob(userId, meta.name)) };
    },
    async remove(userId, name) {
      const list = await readIndex(userId), f = list.find((x) => x.name === String(name));
      if (!f) throw err('FILE_NOT_FOUND', 'File not found');
      await dropStored(userId, f);
      const next = list.filter((x) => x.name !== f.name); await writeIndex(userId, next);
      return { usage: summary(next) };
    },

    /* ---- storage location (Smartbase 1 GB, or your own Backblaze B2 bucket) ---- */
    async storageInfo(userId) {
      const connections = plusStorage ? (await plusStorage.getConnections(userId)).map((c) => ({ id: c.id, name: c.name, bucket: c.bucket, provider: c.provider })) : [];
      return { binding: await getBinding(userId), connections };
    },
    async setBinding(userId, { mode, connectionId }) {
      if (mode === 'smartbase') { await hf.writeFile(P.bind(userId), { mode: 'smartbase', updated_at: new Date().toISOString() }); return this.storageInfo(userId); }
      if (mode !== 'b2' || !plusStorage) throw err('INVALID_FILE', 'Choose Smartbase storage or a Backblaze B2 connection.');
      const c = (await plusStorage.getConnections(userId)).find((x) => x.id === String(connectionId));
      if (!c) throw err('CONNECTION_NOT_FOUND', 'Storage connection not found.');
      await hf.writeFile(P.bind(userId), { mode: 'b2', connectionId: c.id, updated_at: new Date().toISOString() });
      return this.storageInfo(userId);
    },
    /** Link for the browser to upload directly to the bucket (large files, with a progress bar). */
    async presign(userId, { name, size, content_type }) {
      name = checkName(name);
      if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_BYTES) throw err('FILE_TOO_LARGE', `Files can be up to ${MAX_FILE_BYTES / 1048576} MB.`);
      const { adapter } = await adapterFor(userId), ct = String(content_type || 'application/octet-stream').slice(0, 100), key = extKey(userId, name);
      const link = await ext(() => adapter.createUploadUrl(key, 900, ct));
      return { url: link.url, key, method: 'PUT', headers: { 'Content-Type': ct } };
    },
    async completeExternal(userId, { name, size, content_type }) {
      name = checkName(name);
      const { adapter, binding } = await adapterFor(userId), key = extKey(userId, name);
      const found = (await ext(() => adapter.list(key, 5))).objects.find((o) => o.key === key);
      if (!found || found.size !== size) throw err('UPLOAD_NOT_FOUND', 'We could not find the uploaded file in your bucket (or its size differs). Try uploading again.');
      const list = await readIndex(userId), old = list.find((f) => f.name === name);
      const meta = { name, size, content_type: String(content_type || 'application/octet-stream').slice(0, 100), created_at: new Date().toISOString(), storage: 'b2', key, connectionId: binding.connectionId };
      const next = await setEntry(userId, list, meta);
      if (old && old.storage !== 'b2') await dropStored(userId, old);
      return { file: meta, usage: summary(next) };
    },
    /** Proves the binding works: writes, finds and deletes a test object, and gives the browser a link to test direct upload (CORS). */
    async testExternal(userId) {
      const { adapter, binding } = await adapterFor(userId), t0 = Date.now(), key = `smartbase/.checks/${userId}/${crypto.randomUUID()}.txt`;
      await ext(() => adapter.upload(key, Buffer.from('smartbase check ' + new Date().toISOString()), 'text/plain'));
      const listed = (await ext(() => adapter.list(key, 1))).objects.find((o) => o.key === key);
      await ext(() => adapter.delete(key));
      const bkey = `smartbase/.checks/${userId}/browser-${crypto.randomUUID()}.txt`;
      const link = await ext(() => adapter.createUploadUrl(bkey, 300, 'text/plain'));
      return { server: { ok: !!listed, wrote_bytes: listed ? listed.size : 0, ms: Date.now() - t0, connectionId: binding.connectionId }, browser: { url: link.url, key: bkey, headers: { 'Content-Type': 'text/plain' } } };
    },
    async cleanupTest(userId, key) {
      if (!String(key).startsWith(`smartbase/.checks/${userId}/`) || String(key).includes('..')) throw err('INVALID_FILE', 'Invalid key.');
      const { adapter } = await adapterFor(userId); await ext(() => adapter.delete(String(key))); return { deleted: true };
    },
  };
}
