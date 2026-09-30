import { sqlParser } from '../sql/parser.js';

const READ_OPERATIONS = new Set(['SELECT', 'SHOW_DATABASES', 'SHOW_TABLES']);
const MAX_REQUESTS_PER_MINUTE = 20;
const MAX_REQUESTS_PER_DAY = 2000;
const usage = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const day = new Date(now).toISOString().slice(0, 10);
  let entry = usage.get(userId);
  if (!entry || entry.day !== day) entry = { day, dayCount: 0, minute, minuteCount: 0 };
  if (entry.minute !== minute) { entry.minute = minute; entry.minuteCount = 0; }
  if (entry.minuteCount >= MAX_REQUESTS_PER_MINUTE) return { ok: false, retryAfter: 60 - Math.floor((now % 60000) / 1000), reason: 'minute' };
  if (entry.dayCount >= MAX_REQUESTS_PER_DAY) return { ok: false, retryAfter: 86400 - Math.floor((now / 1000) % 86400), reason: 'day' };
  entry.minuteCount += 1; entry.dayCount += 1;
  usage.set(userId, entry);
  if (usage.size > 10000) { for (const [id, item] of usage) if (item.day !== day) usage.delete(id); }
  return { ok: true };
}

// Authenticates requests to /apiv1 with an API key and enforces the key's
// permission: read keys may only read, write keys may only write.
// Key management (/api-keys) is never available through an API key.
export function createApiKeyMiddleware({ apiKeys }) {
  function extractKey(req) {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) return h.substring(7).trim();
    const x = req.headers['x-api-key'];
    return typeof x === 'string' ? x.trim() : null;
  }

  // 'read' | 'write' for the request being made
  function requiredPermission(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return 'read';
    if (req.method === 'POST' && req.path === '/query') {
      const { database_id, sql } = req.body || {};
      if (typeof sql === 'string') {
        try {
          const op = sqlParser.parse(sql, { database_id }).operation;
          return READ_OPERATIONS.has(op) ? 'read' : 'write';
        } catch {
          // Unparseable SQL is rejected by the query route itself.
          return 'read';
        }
      }
      return 'read';
    }
    return 'write';
  }

  return async function apiKeyMiddleware(req, res, next) {
    try {
      if (req.path.startsWith('/api-keys')) {
        return res.status(403).json({ success: false, error: 'KEY_PERMISSION_DENIED', message: 'API keys cannot manage API keys.' });
      }
      const raw = extractKey(req);
      if (!raw) return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'API key required (Authorization: Bearer <key> or X-API-Key header).' });
      const auth = await apiKeys.authenticate(raw);
      if (!auth) return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid API key.' });
      const rate = checkRateLimit(auth.userId);
      if (!rate.ok) {
        res.set('Retry-After', String(Math.max(1, rate.retryAfter)));
        return res.status(429).json({ success: false, error: 'RATE_LIMIT_EXCEEDED', message: rate.reason === 'day' ? 'Daily API request limit reached (2,000 requests). Please try again tomorrow.' : 'API rate limit reached (20 requests per minute). Please slow down and try again shortly.' });
      }
      const needed = requiredPermission(req);
      if (auth.type !== needed) {
        const message = needed === 'write'
          ? 'This action needs a write key. Read keys are read-only.'
          : 'This action needs a read key. Write keys can only create, update and delete.';
        return res.status(403).json({ success: false, error: 'KEY_PERMISSION_DENIED', message });
      }
      req.userId = auth.userId;
      req.apiKeyType = auth.type;
      next();
    } catch (e) {
      if (e && e.code === 'STORAGE_READ_FAILED') {
        return res.status(503).json({ success: false, error: 'STORAGE_READ_FAILED', message: e.message });
      }
      return res.status(500).json({ success: false, error: 'AUTH_FAILED', message: 'Could not verify API key.' });
    }
  };
}
