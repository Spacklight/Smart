const USAGE_PATH = 'admin/usage.json';
const DATASETS_PATH = 'admin/datasets.json';

const usageWriteCache = new Map();

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function createAdminModule({ storage, authModule, env = {} } = {}) {
  if (!storage || !authModule) throw new Error('storage and authModule are required');
  const adminEmail = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminUserId = String(env.ADMIN_USER_ID || '').trim();

  function isAdmin(user) {
    if (!user) return false;
    if (adminUserId && user.id === adminUserId) return true;
    return !!adminEmail && String(user.email || '').toLowerCase() === adminEmail;
  }

  async function readUsage() {
    return (await storage.hf.readFile(USAGE_PATH)) || { version: 1, totals: { requests: 0, sessions: 0 }, users: {}, days: {} };
  }

  async function recordUsage(user, req, location = {}) {
    if (!user?.id) return;
    const endpoint = String(req.path || req.originalUrl || '/').split('?')[0];
    const now = Date.now();
    const key = `${user.id}:${endpoint}`;
    const last = usageWriteCache.get(key) || 0;
    // Avoid writing to durable storage on every browser/API request.
    if (now - last < 60000) return;
    usageWriteCache.set(key, now);

    try {
      const usage = await readUsage();
      usage.totals ||= { requests: 0, sessions: 0 };
      usage.users ||= {};
      usage.days ||= {};
      const u = usage.users[user.id] ||= {
        username: user.username,
        email: user.email,
        first_seen: new Date().toISOString(),
        last_seen: null,
        requests: 0,
        sessions: 0,
        endpoints: {},
        locations: {}
      };
      u.username = user.username;
      u.email = user.email;
      u.last_seen = new Date().toISOString();
      u.requests += 1;
      u.endpoints[endpoint] = (u.endpoints[endpoint] || 0) + 1;
      usage.totals.requests += 1;

      const day = dayKey();
      usage.days[day] ||= { requests: 0, active_users: [] };
      usage.days[day].requests += 1;
      if (!usage.days[day].active_users.includes(user.id)) usage.days[day].active_users.push(user.id);

      const locKey = [location.city, location.region, location.country].filter(Boolean).join(', ');
      if (locKey) {
        u.locations[locKey] = (u.locations[locKey] || 0) + 1;
        u.last_location = { city: location.city || null, region: location.region || null, country: location.country || null, recorded_at: new Date().toISOString() };
      }
      const result = await storage.hf.writeFile(USAGE_PATH, usage);
      if (!result.success) throw new Error('Failed to persist usage data');
    } catch (e) {
      usageWriteCache.delete(key);
      console.error('[admin] usage tracking failed:', e.message);
    }
  }

  async function recordSession(user, location = {}) {
    if (!user?.id) return;
    try {
      const usage = await readUsage();
      usage.totals ||= { requests: 0, sessions: 0 };
      usage.users ||= {};
      usage.days ||= {};
      const u = usage.users[user.id] ||= { username: user.username, email: user.email, first_seen: new Date().toISOString(), requests: 0, sessions: 0, endpoints: {}, locations: {} };
      u.username = user.username;
      u.email = user.email;
      u.sessions = (u.sessions || 0) + 1;
      u.last_seen = new Date().toISOString();
      usage.totals.sessions += 1;
      const day = dayKey();
      usage.days[day] ||= { requests: 0, active_users: [] };
      if (!usage.days[day].active_users.includes(user.id)) usage.days[day].active_users.push(user.id);
      const locKey = [location.city, location.region, location.country].filter(Boolean).join(', ');
      if (locKey) {
        u.locations[locKey] = (u.locations[locKey] || 0) + 1;
        u.last_location = { city: location.city || null, region: location.region || null, country: location.country || null, recorded_at: new Date().toISOString() };
      }
      const result = await storage.hf.writeFile(USAGE_PATH, usage);
      if (!result.success) throw new Error('Failed to persist session data');
    } catch (e) {
      console.error('[admin] session tracking failed:', e.message);
    }
  }

  // ---- Hugging Face datasets (the router sends each new account to an "accepting" dataset) ----
  const reg = (d) => ({ version: 2, primary: { label: 'Primary dataset', accepting: true, capacity_gb: 100, ...((d && d.primary) || {}) }, datasets: ((d && d.datasets) || []).map((x) => ({ accepting: false, capacity_gb: 100, ...x })) });
  const pub = (d) => { const { token_enc, ...rest } = d; return { ...rest, has_token: !!token_enc }; };
  const primaryId = () => String(env.HF_DATASET || '').trim() || '(local test storage)';

  async function loadRegistryFile() { return reg(await storage.hf.readFile(DATASETS_PATH)); }
  async function saveRegistryFile(r) {
    const result = await storage.hf.writeFile(DATASETS_PATH, r);
    if (!result.success) throw new Error('Failed to persist dataset catalog');
    storage.hf.clearCache?.();
    return r;
  }
  async function listDatasets() {
    const r = await loadRegistryFile(), a = await storage.hf.assignments(), users = await authModule.loadUsers();
    const counts = {}; Object.values(a.users).forEach((id) => { counts[id] = (counts[id] || 0) + 1; });
    const total = Object.keys(users).length, assigned = Object.values(counts).reduce((x, y) => x + y, 0);
    return {
      success: true, version: 2, total_users: total,
      primary: { id: primaryId(), ...r.primary, users: Math.max(total - assigned, 0) },
      datasets: r.datasets.map((d) => ({ ...pub(d), users: counts[d.id] || 0 })),
    };
  }
  const invalid = (message, code = 'INVALID_DATASET') => Object.assign(new Error(message), { code });
  function cleanFields(input, { forAdd = false } = {}) {
    const out = {};
    if (input.label !== undefined) out.label = String(input.label).trim().slice(0, 60) || undefined;
    if (input.accepting !== undefined) out.accepting = input.accepting === true;
    if (input.capacity_gb !== undefined) { const c = Number(input.capacity_gb); if (!(c >= 1 && c <= 100000)) throw invalid('Soft limit must be between 1 and 100000 GB.'); out.capacity_gb = c; }
    if (input.token !== undefined && String(input.token).trim()) { const t = String(input.token).trim(); if (!/^[\x21-\x7e]{10,300}$/.test(t)) throw invalid('That does not look like a Hugging Face token.'); out.token = t; }
    return out;
  }
  async function addDataset(input = {}) {
    const id = String(input.dataset_id || '').trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id)) throw invalid('Dataset must use the owner/name format.');
    if (id.toLowerCase() === primaryId().toLowerCase()) throw invalid('That is already the primary dataset.');
    const r = await loadRegistryFile();
    if (r.datasets.some((d) => d.id.toLowerCase() === id.toLowerCase())) throw invalid('That dataset is already added.', 'DATASET_EXISTS');
    const f = cleanFields(input, { forAdd: true });
    const entry = { id, label: f.label || id, added_at: new Date().toISOString(), accepting: f.accepting === true, capacity_gb: f.capacity_gb || 100 };
    if (f.token) entry.token_enc = storage.hf.encryptToken(f.token);
    const probe = await storage.hf.probe(entry);
    if (!probe.ok) throw invalid(`Smartbase could not write to ${id}: ${probe.error}`, 'DATASET_UNREACHABLE');
    r.datasets.push(entry); await saveRegistryFile(r);
    return { ...(await listDatasets()), probe };
  }
  async function updateDataset(datasetId, input = {}) {
    const r = await loadRegistryFile(), f = cleanFields(input);
    if (datasetId === '_primary') {
      if (f.label !== undefined) r.primary.label = f.label; if (f.accepting !== undefined) r.primary.accepting = f.accepting; if (f.capacity_gb !== undefined) r.primary.capacity_gb = f.capacity_gb;
    } else {
      const d = r.datasets.find((x) => x.id.toLowerCase() === String(datasetId).toLowerCase());
      if (!d) throw invalid('Dataset not found.', 'DATASET_NOT_FOUND');
      if (f.label !== undefined) d.label = f.label; if (f.accepting !== undefined) d.accepting = f.accepting; if (f.capacity_gb !== undefined) d.capacity_gb = f.capacity_gb;
      if (f.token) { const next = { ...d, token_enc: storage.hf.encryptToken(f.token) }; const probe = await storage.hf.probe(next); if (!probe.ok) throw invalid(`The new token cannot write to ${d.id}: ${probe.error}`, 'DATASET_UNREACHABLE'); d.token_enc = next.token_enc; }
    }
    await saveRegistryFile(r); return listDatasets();
  }
  async function removeDataset(datasetId) {
    const r = await loadRegistryFile(), d = r.datasets.find((x) => x.id.toLowerCase() === String(datasetId).toLowerCase());
    if (!d) return listDatasets();
    const a = await storage.hf.assignments();
    if (Object.values(a.users).some((id) => id === d.id)) throw invalid('Some accounts still store their data in this dataset. Stop it accepting new users, but it cannot be removed while accounts use it.', 'DATASET_IN_USE');
    r.datasets = r.datasets.filter((x) => x !== d); await saveRegistryFile(r); return listDatasets();
  }
  /** Connection test plus (when Hugging Face reports it) how much storage the dataset uses. */
  async function probeDataset(datasetId) {
    const r = await loadRegistryFile();
    const entry = datasetId === '_primary' ? { id: String(env.HF_DATASET || ''), token_enc: '' } : r.datasets.find((x) => x.id.toLowerCase() === String(datasetId).toLowerCase());
    if (!entry) throw invalid('Dataset not found.', 'DATASET_NOT_FOUND');
    const probe = await storage.hf.probe(entry);
    let used_bytes = null, hf_error = null;
    try {
      const token = storage.hf.tokenFor(entry);
      if (token && entry.id) {
        const res = await fetch(`https://huggingface.co/api/datasets/${entry.id}?expand[]=usedStorage`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
        if (res.ok) { const j = await res.json(); used_bytes = typeof j.usedStorage === 'number' ? j.usedStorage : null; } else hf_error = `Hugging Face answered ${res.status}`;
      }
    } catch (e) { hf_error = e.message; }
    return { ...probe, used_bytes, hf_error };
  }

  /** Counts for ONE user (the admin asks for it on demand; the overview never scans everyone's data). */
  async function userStats(userId, budget = 40) {
    const out = { databases: 0, tables: 0, records: 0, files: 0, file_bytes: 0, partial: false };
    const dbs = await storage.getUserDatabases(userId); out.databases = dbs.length;
    for (const db of dbs) {
      const list = (await storage.hf.readFile(storage.databaseTablesPath(userId, db.id))) || [];
      out.tables += list.length;
      for (const t of list) { if (budget <= 0) { out.partial = true; break; } budget--; out.records += ((await storage.getRecords(userId, db.id, t.id)) || []).length; }
    }
    const files = (await storage.hf.readFile(`users/${userId}/files.json`)) || [];
    out.files = files.length; out.file_bytes = files.filter((f) => f.storage !== 'b2').reduce((a, f) => a + (f.size || 0), 0);
    out.dataset = (await storage.hf.datasetOf(userId)) || 'primary';
    return out;
  }

  return { isAdmin, recordUsage, recordSession, listDatasets, addDataset, updateDataset, removeDataset, probeDataset, userStats, readUsage };
}
