// Sign in with Google using Smartbase's own OAuth client (authorization-code flow, no Firebase).
//   /api/v1/auth/google/start     -> sends the browser to Google
//   /api/v1/auth/google/callback  -> Google sends it back here with a one-time code
//   /api/v1/auth/session          -> the signed-in browser collects its session token (cookie + custom header)
const AUD = 'smartbase-oauth-state';
const COOKIE = 'sb_oauth';
const CANONICAL = 'https://smartbase.de5.net';
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const same = (a, b) => { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const b64uJson = (s) => JSON.parse(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

export function createGoogleOAuth({ authModule, adminModule, env, isProduction }) {
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim(), clientSecret = String(env.GOOGLE_CLIENT_SECRET || '').trim();
  const publicUrl = String(env.PUBLIC_URL || CANONICAL).replace(/\/+$/, '');
  const isLocal = (req) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || ''));
  const originFor = (req) => (isLocal(req) ? `http://${req.headers.host}` : publicUrl);
  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: isProduction, path: '/api/v1/auth/google', maxAge: 10 * 60 * 1000 };
  const fail = (res, code) => res.redirect(302, '/?auth_error=' + encodeURIComponent(code));

  async function start(req, res) {
    if (!clientId || !clientSecret) return fail(res, 'not_configured');
    // Always run the flow on the official address, so the state cookie and Google's redirect address match.
    if (!isLocal(req) && String(req.headers.host).toLowerCase() !== new URL(publicUrl).host) {
      return res.redirect(302, publicUrl + req.originalUrl);
    }
    const state = hex(24), nonce = hex(16);
    const terms = req.query.terms === '1' ? 1 : 0;
    res.cookie(COOKIE, authModule.signShort({ s: state, n: nonce, t: terms }, AUD, '10m'), cookieOpts);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: clientId, redirect_uri: originFor(req) + '/api/v1/auth/google/callback', response_type: 'code',
      scope: 'openid email profile', state, nonce, prompt: 'select_account', access_type: 'online',
    }).toString();
    return res.redirect(302, url.toString());
  }

  async function callback(req, res) {
    res.clearCookie(COOKIE, { path: cookieOpts.path });
    try {
      if (!clientId || !clientSecret) return fail(res, 'not_configured');
      if (req.query.error) return fail(res, req.query.error === 'access_denied' ? 'cancelled' : 'google_failed');
      const saved = authModule.verifyShort((req.cookies || {})[COOKIE] || '', AUD);
      if (!saved || !req.query.state || !same(saved.s, req.query.state) || !req.query.code) return fail(res, 'state');

      let tokens;
      try {
        const r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
          body: new URLSearchParams({ code: String(req.query.code), client_id: clientId, client_secret: clientSecret, redirect_uri: originFor(req) + '/api/v1/auth/google/callback', grant_type: 'authorization_code' }),
        });
        tokens = await r.json().catch(() => ({}));
        if (!r.ok || !tokens.id_token) return fail(res, 'google_failed');
      } catch (e) { return fail(res, 'google_failed'); }

      // The ID token came straight from Google over HTTPS; still check who it is for and that it is fresh.
      let c;
      try { c = b64uJson(String(tokens.id_token).split('.')[1]); } catch (e) { return fail(res, 'google_failed'); }
      const now = Math.floor(Date.now() / 1000);
      if (!['https://accounts.google.com', 'accounts.google.com'].includes(c.iss) || c.aud !== clientId || !(c.exp > now) || !same(c.nonce || '', saved.n)) return fail(res, 'google_failed');
      if (c.email_verified !== true || !c.email || !c.sub) return fail(res, 'email_not_verified');

      const { user, token } = await authModule.loginWithGoogleProfile(
        { sub: c.sub, email: c.email, emailVerified: c.email_verified === true, name: c.name || '', picture: c.picture || '' },
        { termsAccepted: saved.t === 1 });
      try { await adminModule?.recordSession(user, { city: req.headers['x-cf-city'] || '', region: req.headers['x-cf-region'] || '', country: req.headers['x-cf-country'] || '' }); } catch (e) { /* never block sign-in */ }
      res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax', secure: isProduction, path: '/' });
      return res.redirect(302, '/?signed_in=1');
    } catch (e) {
      const map = { TERMS_REQUIRED: 'terms_required', GOOGLE_EMAIL_NOT_VERIFIED: 'email_not_verified', ACCOUNT_MISMATCH: 'account_mismatch' };
      return fail(res, map[e && e.code] || 'server_error');
    }
  }

  // The browser keeps its session token in local storage; after Google sign-in it asks for it here.
  async function session(req, res) {
    if (req.headers['x-smartbase-client'] !== 'web') return res.status(400).json({ success: false, error: 'BAD_REQUEST', message: 'Invalid request.' });
    const token = (req.cookies || {}).token, decoded = token && authModule.verifyToken(token);
    const user = decoded && (await authModule.getUserById(decoded.id));
    if (!user) return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Please sign in again.' });
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, user, token });
  }
  return { start, callback, session };
}
