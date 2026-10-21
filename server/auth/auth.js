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
    await storage.hf.assignNewUser?.(id, Object.keys(users).length);
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
  // Sign in / register from a verified Google profile (the Google OAuth flow validates the profile first).
  async function loginWithGoogleProfile({ sub, email, emailVerified, name = '', picture = '' }, { termsAccepted = false, termsVersion = '2026-09-29' } = {}) {
    if (!sub || !email || emailVerified !== true) throw { code: 'GOOGLE_EMAIL_NOT_VERIFIED', message: 'A verified Google email address is required.' };
    const mail = String(email).trim().toLowerCase(), gsub = String(sub);
    const users = await loadUsers();
    let found = Object.values(users).find(u => String(u.google_sub || '') === gsub) || Object.values(users).find(u => String(u.email || '').toLowerCase() === mail);
    // an email address that is already tied to a different Google account must never be taken over
    if (found && found.google_sub && String(found.google_sub) !== gsub) throw { code: 'ACCOUNT_MISMATCH', message: 'This email address belongs to a different Google account.' };
    if (!found) {
      if (termsAccepted !== true) throw { code: 'TERMS_REQUIRED', message: 'You must agree to the Smartbase Terms & Conditions before creating an account.' };
      const baseName = String(name || mail.split('@')[0] || 'user').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'user';
      let username = baseName, suffix = 1;
      while (Object.values(users).some(u => String(u.username || '').toLowerCase() === username.toLowerCase())) username = `${baseName}_${suffix++}`.slice(0, 32);
      const id = generateId('sb_usr'), now = new Date().toISOString();
      found = { id, username, email: mail, plan: 'free', created_at: now, databases: [], auth_provider: 'google.com', google_sub: gsub, email_verified: true,
        terms_accepted: true, terms_version: termsVersion, terms_accepted_at: now, display_name: name || '', photo_url: picture || '' };
      users[id] = found;
      await storage.hf.assignNewUser?.(id, Object.keys(users).length);
    } else {
      found.email = mail; found.google_sub = gsub; found.auth_provider = 'google.com'; found.email_verified = true;
      if (name) found.display_name = name;
      if (picture) found.photo_url = picture;
      users[found.id] = found;
    }
    await saveUsers(users);
    const token = jwt.sign({ id: found.id, username: found.username, plan: found.plan }, effectiveSecret, { expiresIn: '7d' });
    const { password: _, ...safe } = found;
    return { user: safe, token };
  }
  // Short-lived signed values (for example the Google sign-in state); never accepted as a login session.
  const signShort = (payload, audience, expiresIn) => jwt.sign(payload, effectiveSecret, { expiresIn, audience });
  const verifyShort = (token, audience) => { try { return jwt.verify(token, effectiveSecret, { audience }); } catch { return null; } };
  function verifyToken(token) { try { return jwt.verify(token, effectiveSecret); } catch { return null; } }
  return { generateId, registerUser, loginUser, loginWithGoogleProfile, signShort, verifyShort, getUserById, verifyToken, loadUsers, saveUsers, deleteUserRecord };
}
export function generateId(prefix) { const random = Math.random().toString(36).substring(2, 8) + Math.random().toString(36).substring(2, 8); return `${prefix}_${random}`; }
