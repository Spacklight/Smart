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

  async function listDatasets() {
    return (await storage.hf.readFile(DATASETS_PATH)) || { version: 1, datasets: [] };
  }

  async function saveDatasets(data) {
    const result = await storage.hf.writeFile(DATASETS_PATH, data);
    if (!result.success) throw new Error('Failed to persist dataset catalog');
    return data;
  }

  async function addDataset(datasetId, label = '') {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(datasetId)) {
      throw Object.assign(new Error('Dataset must use the owner/name format.'), { code: 'INVALID_DATASET' });
    }
    const data = await listDatasets();
    if (data.datasets.some(d => d.id.toLowerCase() === datasetId.toLowerCase())) return data;
    data.datasets.push({ id: datasetId, label: label || datasetId, added_at: new Date().toISOString() });
    return saveDatasets(data);
  }

  async function removeDataset(datasetId) {
    const data = await listDatasets();
    data.datasets = data.datasets.filter(d => d.id.toLowerCase() !== String(datasetId).toLowerCase());
    return saveDatasets(data);
  }

  return { isAdmin, recordUsage, recordSession, listDatasets, addDataset, removeDataset, readUsage };
}
