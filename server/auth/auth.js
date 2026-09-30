import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export function createAuthModule({ storage, env = {}, jwtSecret } = {}) {
  const SECRET = jwtSecret || env.JWT_SECRET || env.SESSION_SECRET || '';
  if (!SECRET) console.warn('[Auth] JWT_SECRET not set - insecure default for dev only');
  const effectiveSecret = SECRET || 'dev-only-insecure-secret-change-in-production';
  const USERS_PATH = 'auth/users.json';
  if (!storage) throw new Error('Storage adapter required');

  async function loadUsers() {
    try {
      const data = await storage.hf.readFile(USERS_PATH);
      if (!data) return {};
      if (Array.isArray(data)) { const obj = {}; data.forEach(u => { if (u.id) obj[u.id] = u; }); return obj; }
      return data;
    } catch (e) {
      // A real storage failure must never be treated as "no users yet" -
      // that would make login/registration silently misbehave (e.g. letting
      // a duplicate username through, or reporting "user not found" for an
      // existing account) whenever Hugging Face is unreachable.
      throw { code: 'STORAGE_READ_FAILED', message: `Failed to load users: ${e.message}` };
    }
  }
  async function saveUsers(users) {
    try {
      const result = await storage.hf.writeFile(USERS_PATH, users);
      if (!result.success) throw { code: 'STORAGE_WRITE_FAILED', message: 'Failed to persist users' };
      return result;
    } catch (e) { if (e.code) throw e; throw { code: 'STORAGE_WRITE_FAILED', message: e.message }; }
  }
  function generateId(prefix) {
    const random = Math.random().toString(36).substring(2, 8) + Math.random().toString(36).substring(2, 8) + Date.now().toString(36).slice(-4);
    return `${prefix}_${random}`;
  }
  async function registerUser({ username, email, password }) {
    const users = await loadUsers();
    for (const u of Object.values(users)) {
      if (u.username.toLowerCase() === username.toLowerCase()) throw { code: 'DUPLICATE_USER', message: 'Username already taken' };
      if (u.email.toLowerCase() === email.toLowerCase()) throw { code: 'DUPLICATE_EMAIL', message: 'Email already registered' };
    }
    const id = generateId('sb_usr');
    const hashed = await bcrypt.hash(password, 12);
    const user = { id, username, email, password: hashed, plan: 'free', created_at: new Date().toISOString(), databases: [] };
    users[id] = user;
    await saveUsers(users);
    const { password: _, ...safe } = user;
    return safe;
  }
  async function loginUser({ username, password }) {
    const users = await loadUsers();
    let found = null;
    const search = username.toLowerCase();
    for (const u of Object.values(users)) { if (u.username.toLowerCase() === search || u.email.toLowerCase() === search) { found = u; break; } }
    if (!found) throw { code: 'USER_NOT_FOUND', message: 'Invalid credentials' };
    const valid = await bcrypt.compare(password, found.password);
    if (!valid) throw { code: 'UNAUTHORIZED', message: 'Invalid credentials' };
    const token = jwt.sign({ id: found.id, username: found.username, plan: found.plan }, effectiveSecret, { expiresIn: '7d' });
    const { password: _, ...safe } = found;
    return { user: safe, token };
  }
  async function getUserById(id) {
    const users = await loadUsers();
    const user = users[id];
    if (!user) return null;
    const { password: _, ...safe } = user;
    return safe;
  }

  async function deleteUserRecord(id) {
    const users = await loadUsers();
    if (!users[id]) return false;
    delete users[id];
    await saveUsers(users);
    return true;
  }
  async function loginWithFirebase({ idToken, firebaseApiKey, firebaseProjectId, termsAccepted = false, termsVersion = '2026-09-29' }) {
    if (!idToken) throw { code: 'FIREBASE_TOKEN_REQUIRED', message: 'Google authentication token is required.' };
    if (!firebaseApiKey || !firebaseProjectId) throw { code: 'FIREBASE_NOT_CONFIGURED', message: 'Google authentication is not configured on the server.' };
    const lookupUrl = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`;
    let response;
    try {
      response = await fetch(lookupUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      });
    } catch (e) {
      throw { code: 'FIREBASE_VERIFY_FAILED', message: `Could not verify Google account: ${e.message}` };
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload.users) || !payload.users.length) {
      throw { code: 'FIREBASE_VERIFY_FAILED', message: 'Google authentication could not be verified.' };
    }
    const verified = payload.users[0];
    const providerOk = Array.isArray(verified.providerUserInfo) && verified.providerUserInfo.some(p => p.providerId === 'google.com');
    if (!providerOk || verified.emailVerified !== true || !verified.email) {
      throw { code: 'GOOGLE_EMAIL_NOT_VERIFIED', message: 'A verified Google email address is required.' };
    }
    const email = String(verified.email).trim().toLowerCase();
    const users = await loadUsers();
    let found = Object.values(users).find(u => String(u.firebase_uid || '') === String(verified.localId || '')) || Object.values(users).find(u => String(u.email || '').toLowerCase() === email);
    if (!found) {
      if (termsAccepted !== true) throw { code: 'TERMS_REQUIRED', message: 'You must agree to the Smartbase Terms & Conditions before creating an account.' };
      const baseName = String(verified.displayName || email.split('@')[0] || 'user')
        .toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'user';
      let username = baseName;
      let suffix = 1;
      while (Object.values(users).some(u => String(u.username || '').toLowerCase() === username.toLowerCase())) {
        username = `${baseName}_${suffix++}`.slice(0, 32);
      }
      const id = generateId('sb_usr');
      found = {
        id, username, email, plan: 'free', created_at: new Date().toISOString(), databases: [],
        auth_provider: 'google.com', firebase_uid: String(verified.localId || ''), email_verified: true,
        terms_accepted: true, terms_version: termsVersion, terms_accepted_at: new Date().toISOString(),
        display_name: verified.displayName || '', photo_url: verified.photoUrl || ''
      };
      users[id] = found;
    } else {
      found.email = email;
      found.firebase_uid = String(verified.localId || found.firebase_uid || '');
      found.auth_provider = 'google.com';
      found.email_verified = true;
      if (verified.displayName) found.display_name = verified.displayName;
      if (verified.photoUrl) found.photo_url = verified.photoUrl;
      users[found.id] = found;
    }
    await saveUsers(users);
    const token = jwt.sign({ id: found.id, username: found.username, plan: found.plan }, effectiveSecret, { expiresIn: '7d' });
    const { password: _, ...safe } = found;
    return { user: safe, token };
  }
  function verifyToken(token) { try { return jwt.verify(token, effectiveSecret); } catch { return null; } }
  return { generateId, registerUser, loginUser, loginWithFirebase, getUserById, verifyToken, loadUsers, saveUsers, deleteUserRecord };
}
export function generateId(prefix) { const random = Math.random().toString(36).substring(2, 8) + Math.random().toString(36).substring(2, 8); return `${prefix}_${random}`; }
