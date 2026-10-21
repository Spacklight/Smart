// Spreads user data over several Hugging Face datasets.
//   - Everything outside users/<id>/ (accounts, registry, admin data) always stays in the primary dataset.
//   - A user's own data (users/<id>/...) lives in the dataset the administrator assigned that user to when they signed up.
//   - Users without an assignment are on the primary dataset, exactly like before.
import path from 'path';
import { createHFClient } from './client.js';
import { encryptSecret, decryptSecret } from '../plus/encryption.js';

export const DATASETS_PATH = 'admin/datasets.json';
export const ASSIGN_PATH = 'admin/dataset-assignments.json';
const USER_PATH = /^users\/([^/]+)\//;

export class DatasetRouter {
  constructor(primary, config = {}) {
    this.primary = primary; this.config = config; this.clients = new Map(); this.assign = null; this.assignAt = 0;
  }
  getMode() { return this.primary.getMode(); }
  clearCache() { this.primary.clearCache?.(); this.clients.forEach((c) => c.client.clearCache?.()); this.assign = null; }

  // ---- secrets for datasets that use their own Hugging Face token ----
  encryptToken(token) { if (!this.config.secret) throw Object.assign(new Error('An encryption secret (JWT_SECRET) is required to store a dataset token.'), { code: 'SECRET_MISSING' }); return encryptSecret(token, this.config.secret); }
  tokenFor(entry) { return entry && entry.token_enc ? decryptSecret(entry.token_enc, this.config.secret) : this.config.token || ''; }

  _build(entry) {
    const safe = String(entry.id).replace(/[^A-Za-z0-9_.-]+/g, '__');
    return createHFClient({ ...this.config, token: this.tokenFor(entry), dataset: entry.id, localPath: path.join(this.config.localPath || './data/hf-mock', 'datasets', safe) });
  }
  async registry() { return (await this.primary.readFile(DATASETS_PATH)) || { datasets: [] }; }
  async clientFor(datasetId) {
    const reg = await this.registry(), entry = (reg.datasets || []).find((d) => d.id === datasetId);
    if (!entry) throw Object.assign(new Error(`Dataset ${datasetId} is not registered.`), { code: 'DATASET_NOT_FOUND' });
    const key = datasetId + '|' + (entry.token_enc || ''), hit = this.clients.get(datasetId);
    if (hit && hit.key === key) return hit.client;
    const client = this._build(entry); this.clients.set(datasetId, { key, client }); return client;
  }

  async assignments() {
    if (this.assign && Date.now() - this.assignAt < 15000) return this.assign;
    const d = (await this.primary.readFile(ASSIGN_PATH)) || { version: 1, users: {} };
    d.users ||= {}; this.assign = d; this.assignAt = Date.now(); return d;
  }
  async datasetOf(userId) { return (await this.assignments()).users[userId] || null; }
  async _route(p) {
    const m = USER_PATH.exec(String(p)); if (!m) return this.primary;
    const id = await this.datasetOf(m[1]); return id ? this.clientFor(id) : this.primary;
  }

  /** Called when an account is created: picks the accepting dataset with the fewest users. */
  async assignNewUser(userId, totalUsers = 0) {
    try {
      const reg = await this.registry(), extra = (reg.datasets || []).filter((d) => d.accepting);
      if (!extra.length) return 'primary';
      const primaryAccepting = !reg.primary || reg.primary.accepting !== false;
      const a = await this.assignments(), counts = {}; Object.values(a.users).forEach((id) => { counts[id] = (counts[id] || 0) + 1; });
      const cands = [...(primaryAccepting ? [{ id: null, count: Math.max(totalUsers - Object.keys(a.users).length, 0) }] : []), ...extra.map((d) => ({ id: d.id, count: counts[d.id] || 0 }))];
      if (!cands.length) return 'primary';
      cands.sort((x, y) => x.count - y.count);
      const pick = cands[0];
      if (!pick.id) return 'primary';
      a.users[userId] = pick.id;
      const r = await this.primary.writeFile(ASSIGN_PATH, a); if (!r.success) return 'primary';
      this.assign = a; this.assignAt = Date.now(); return pick.id;
    } catch (e) { return 'primary'; } // never block a sign-up
  }
  /** Forget which dataset a deleted account used (so an empty dataset can be removed again). */
  async unassign(userId) {
    try {
      const a = await this.assignments(); if (!a.users[userId]) return;
      delete a.users[userId]; await this.primary.writeFile(ASSIGN_PATH, a); this.assign = a; this.assignAt = Date.now();
    } catch (e) { /* not critical */ }
  }
  /** Can this dataset be read and written? (used before it is added, and by the "Test" button) */
  async probe(entry) {
    const t0 = Date.now();
    try {
      const c = this._build(entry), p = 'smartbase/healthcheck.json';
      const w = await c.writeFile(p, { ok: true, at: new Date().toISOString() }, { cache: false });
      if (!w.success) throw new Error('write failed');
      const r = await c.readFile(p, { cache: false });
      if (!r || r.ok !== true) throw new Error('could not read back what was written');
      return { ok: true, ms: Date.now() - t0 };
    } catch (e) { return { ok: false, ms: Date.now() - t0, error: String((e && (e.message || e.code)) || e).slice(0, 220) }; }
  }

  async readFile(p, o) { return (await this._route(p)).readFile(p, o); }
  async writeFile(p, d, o) { return (await this._route(p)).writeFile(p, d, o); }
  async deleteFile(p) { return (await this._route(p)).deleteFile(p); }
  async deleteMany(paths) { return paths.length ? (await this._route(paths[0])).deleteMany(paths) : { success: true }; }
}
