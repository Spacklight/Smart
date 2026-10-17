// One-click handoff from Smartbase to the Email platform. Produces a signed, 60-second, single-use link.
// The Email platform verifies it with the same secret (EMAIL_SSO_SECRET here, SSO_SECRET there).
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json64 = (o) => b64u(enc.encode(JSON.stringify(o)));

export async function signLaunchToken(claims, secret) {
  const data = json64({ alg: 'HS256', typ: 'JWT' }) + '.' + json64(claims);
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return data + '.' + b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export function createEmailLaunch({ authModule, env }) {
  return async function launch(userId, nowMs = Date.now()) {
    const secret = String(env.EMAIL_SSO_SECRET || ''), base = String(env.EMAIL_PLATFORM_URL || '').replace(/\/+$/, '');
    if (secret.length < 32 || !/^https:\/\//.test(base)) throw { code: 'NOT_CONFIGURED', message: 'The Email platform is not connected yet. Ask the administrator to finish the setup.' };
    const user = await authModule.getUserById(userId);
    if (!user) throw { code: 'USER_NOT_FOUND', message: 'Account not found.' };
    const iat = Math.floor(nowMs / 1000);
    const token = await signLaunchToken({
      iss: 'smartbase', aud: 'smartbase-email', sub: String(user.id), jti: authModule.generateId('sso'), iat, exp: iat + 60,
      email: String(user.email || ''), email_verified: user.email_verified === true,
      name: String(user.display_name || user.username || '').slice(0, 100),
    }, secret);
    return { url: `${base}/sso?token=${encodeURIComponent(token)}` };
  };
}
