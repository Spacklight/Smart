// API keys for programmatic access via /apiv1.
//
// Key types:
//   read       - list/read data and run SELECT / SHOW queries
//   write      - create / update / delete data and run write SQL
//   collective - not a key type itself: creating one issues a read key AND a
//                write key together (two separate keys, one of each)
//
// Format:  <sbr|sbw>.<userId>.<secret>
// Only a SHA-256 hash of the full key is stored; the plaintext key is shown
// to the user exactly once, at creation.

const MAX_KEYS_PER_USER = 5;
const PREFIX_BY_TYPE = { read: 'sbr', write: 'sbw' };
const TYPE_BY_PREFIX = { sbr: 'read', sbw: 'write' };
const USER_ID_RE = /^sb_usr_[a-z0-9]+$/;

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(str) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function publicView(rec) {
  return {
    id: rec.id,
    name: rec.name,
    type: rec.type,
    group: rec.group || null,
    hint: rec.hint,
    created_at: rec.created_at
  };
}

export function createApiKeyModule({ storage, authModule }) {
  async function mint(userId, type, name, group) {
    const secret = randomHex(24);
    const key = `${PREFIX_BY_TYPE[type]}.${userId}.${secret}`;
    const record = {
      id: authModule.generateId('sb_key'),
      name,
      type,
      group: group || null,
      hint: secret.slice(-4),
      hash: await sha256Hex(key),
      created_at: new Date().toISOString()
    };
    return { key, record };
  }

  // kind: 'read' | 'write' | 'collective'
  async function createKeys(userId, kind, rawName) {
    if (!['read', 'write', 'collective'].includes(kind)) {
      throw { code: 'INVALID_KEY_TYPE', message: 'Key type must be read, write or collective' };
    }
    const name = (typeof rawName === 'string' ? rawName.trim() : '').slice(0, 40);
    const existing = await storage.getApiKeys(userId);
    const adding = kind === 'collective' ? 2 : 1;
    if (existing.length + adding > MAX_KEYS_PER_USER) {
      throw { code: 'API_KEY_LIMIT_REACHED', message: `You can have at most ${MAX_KEYS_PER_USER} API keys. Revoke one first.` };
    }
    const minted = [];
    if (kind === 'collective') {
      const group = authModule.generateId('sb_grp');
      const label = name || 'Collective key';
      minted.push(await mint(userId, 'read', label, group));
      minted.push(await mint(userId, 'write', label, group));
    } else {
      minted.push(await mint(userId, kind, name || (kind === 'read' ? 'Read key' : 'Write key'), null));
    }
    await storage.saveApiKeys(userId, [...existing, ...minted.map(m => m.record)]);
    return minted.map(m => ({ ...publicView(m.record), key: m.key }));
  }

  async function listKeys(userId) {
    return (await storage.getApiKeys(userId)).map(publicView);
  }

  async function revokeKey(userId, keyId) {
    const existing = await storage.getApiKeys(userId);
    const remaining = existing.filter(k => k.id !== keyId);
    if (remaining.length === existing.length) return false;
    await storage.saveApiKeys(userId, remaining);
    return true;
  }

  // Returns { userId, type } for a valid key, otherwise null.
  async function authenticate(rawKey) {
    if (typeof rawKey !== 'string' || rawKey.length > 200) return null;
    const parts = rawKey.split('.');
    if (parts.length !== 3) return null;
    const [prefix, userId, secret] = parts;
    const type = TYPE_BY_PREFIX[prefix];
    if (!type || !USER_ID_RE.test(userId) || !/^[a-f0-9]{48}$/.test(secret)) return null;
    const hash = await sha256Hex(rawKey);
    const keys = await storage.getApiKeys(userId);
    const match = keys.find(k => k.type === type && safeEqual(k.hash, hash));
    if (!match) return null;
    const user = await authModule.getUserById(userId);
    if (!user) return null;
    return { userId, type, keyId: match.id };
  }

  return { createKeys, listKeys, revokeKey, authenticate, MAX_KEYS_PER_USER };
}
