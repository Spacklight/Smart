import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

export async function createApp(env = {}) {
  const isProduction = env.NODE_ENV === 'production' || env.CLOUDFLARE === '1';
  const app = express();

  // Same-origin: frontend and API same Cloudflare origin, no wildcard CORS with credentials
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // /apiv1 is authenticated by API key (never by cookie), so it is safe to let
  // any website call it from a browser. Other routes stay same-origin only.
  app.use('/apiv1', (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  const { createStorageAdapter } = await import('./storage/adapter.js');
  const storage = createStorageAdapter({
    token: env.HF_TOKEN || '',
    dataset: env.HF_DATASET || '',
    isProduction,
    allowMock: !isProduction
  });

  const { createAuthModule } = await import('./auth/auth.js');
  const authModule = createAuthModule({
    storage,
    env,
    jwtSecret: env.JWT_SECRET || env.SESSION_SECRET || ''
  });

  const { createAdminModule } = await import('./admin.js');
  const adminModule = createAdminModule({ storage, authModule, env });
  const { createAuthMiddleware } = await import('./middleware/auth.js');
  const { authMiddleware } = createAuthMiddleware({ authModule, adminModule });

  const { createApiKeyModule } = await import('./auth/apikeys.js');
  const apiKeys = createApiKeyModule({ storage, authModule });
  const { createApiKeyMiddleware } = await import('./middleware/apikey.js');
  const apiKeyMiddleware = createApiKeyMiddleware({ apiKeys });

  // External object storage: this release supports Backblaze B2 only.
  const { PlusStorageService } = await import('./storage/plus/service.js');
  const plusStorage = new PlusStorageService(storage, env);

  const { createApiRouter } = await import('./api/routes.js');
  // Dashboard (browser session / JWT) API
  const apiRouter = createApiRouter({ storage, authModule, authMiddleware, apiKeys, plusStorage, env });
  // Public API-key API - same endpoints, authenticated by API key at /apiv1
  const apiKeyRouter = createApiRouter({ storage, authModule, authMiddleware: apiKeyMiddleware, apiKeys, plusStorage, env });

  app.post('/api/v1/auth/firebase', async (req, res) => {
    try {
      const idToken = String(req.body?.idToken || '').trim();
      if (!idToken) return res.status(400).json({ success: false, error: 'FIREBASE_TOKEN_REQUIRED', message: 'Google authentication token is required.' });
      const { user, token } = await authModule.loginWithFirebase({
        idToken,
        termsAccepted: req.body?.termsAccepted === true,
        termsVersion: String(req.body?.termsVersion || '2026-09-29'),
        firebaseApiKey: env.FIREBASE_API_KEY || env.FIREBASE_WEB_API_KEY || '',
        firebaseProjectId: env.FIREBASE_PROJECT_ID || ''
      });
      await adminModule.recordSession(user, { city: req.headers['x-cf-city'] || '', region: req.headers['x-cf-region'] || '', country: req.headers['x-cf-country'] || '' });
      res.cookie('token', token, { httpOnly: true, maxAge: 7*24*60*60*1000, sameSite: 'lax', secure: isProduction, path: '/' });
      return res.json({ success: true, user, token });
    } catch (e) {
      const status = e.code === 'FIREBASE_TOKEN_REQUIRED' || e.code === 'TERMS_REQUIRED' ? 400 : e.code === 'GOOGLE_EMAIL_NOT_VERIFIED' ? 403 : e.code === 'FIREBASE_NOT_CONFIGURED' ? 500 : 401;
      return res.status(status).json({ success: false, error: e.code || 'GOOGLE_AUTH_FAILED', message: e.message || 'Google authentication failed.' });
    }
  });

  // Public community experiences. Reading is public; publishing requires a
  // verified Smartbase session and is limited to one current experience per user.
  app.get('/api/v1/experiences', async (req, res) => {
    try {
      const experiences = await storage.getExperiences();
      const safe = experiences.map(({ user_id, ...x }) => x);
      return res.json({ success: true, experiences: safe });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'EXPERIENCES_READ_FAILED', message: e.message });
    }
  });

  app.post('/api/v1/experiences', authMiddleware, async (req, res) => {
    try {
      const title = String(req.body?.title || '').trim();
      const message = String(req.body?.message || '').trim();
      const rating = Number(req.body?.rating);
      if (!title || title.length > 80) return res.status(400).json({ success:false, error:'INVALID_EXPERIENCE_TITLE', message:'Title is required and must be 80 characters or fewer.' });
      if (!message || message.length > 1000) return res.status(400).json({ success:false, error:'INVALID_EXPERIENCE_MESSAGE', message:'Experience text is required and must be 1000 characters or fewer.' });
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ success:false, error:'INVALID_EXPERIENCE_RATING', message:'Rating must be between 1 and 5.' });
      const user = await authModule.getUserById(req.userId);
      if (!user) return res.status(401).json({ success:false, error:'UNAUTHORIZED', message:'Your account could not be found.' });
      const experience = {
        id: authModule.generateId('sb_exp'),
        user_id: req.userId,
        display_name: String(user.username || 'Smartbase user').slice(0, 80),
        title,
        message,
        rating,
        created_at: new Date().toISOString()
      };
      await storage.upsertExperience(req.userId, experience);
      return res.status(201).json({ success:true, experience: { ...experience, user_id: undefined } });
    } catch (e) {
      return res.status(500).json({ success:false, error:e.code || 'EXPERIENCE_WRITE_FAILED', message:e.message || 'Could not publish experience.' });
    }
  });

  app.delete('/api/v1/experiences/me', authMiddleware, async (req, res) => {
    try {
      const removed = await storage.deleteExperience(req.userId);
      return res.json({ success:true, removed });
    } catch (e) {
      return res.status(500).json({ success:false, error:e.code || 'EXPERIENCE_DELETE_FAILED', message:e.message });
    }
  });

  app.post('/api/v1/auth/register', async (req, res) => {
    return res.status(410).json({ success: false, error: 'GOOGLE_AUTH_REQUIRED', message: 'Smartbase accounts are created with a verified Google account.' });
  });

  app.post('/api/v1/auth/login', async (req, res) => {
    return res.status(410).json({ success: false, error: 'GOOGLE_AUTH_REQUIRED', message: 'Smartbase sign-in uses Google authentication.' });
  });

  app.post('/api/v1/auth/logout', (req, res) => {
    res.clearCookie('token', { path: '/', httpOnly: true, sameSite: 'lax', secure: isProduction });
    return res.json({ success: true, message: 'Logged out' });
  });

  app.get('/api/v1/auth/me', async (req, res) => {
    try {
      let token = null;
      const h = req.headers.authorization;
      if (h && h.startsWith('Bearer ')) token = h.substring(7);
      if (!token && req.cookies && req.cookies.token) token = req.cookies.token;
      if (!token) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
      const decoded = authModule.verifyToken(token);
      if (!decoded) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
      const user = await authModule.getUserById(decoded.id);
      if (!user) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
      const databases = await storage.getUserDatabases(user.id);
      let totalTables = 0, totalRecords = 0;
      for (const db of databases) {
        const tables = await storage.getDatabaseTables(user.id, db.id);
        totalTables += tables.length;
        for (const t of tables) { const recs = await storage.getRecords(user.id, db.id, t.id); totalRecords += recs ? recs.length : 0; }
      }
      return res.json({ success: true, user: { ...user, stats: { databases: databases.length, tables: totalTables, records: totalRecords, database_limit: 20, table_limit: 50, total_table_limit: 500, storage_limit_mb: 500, max_file_upload_mb: 25, api_requests_per_day: 2000, api_requests_per_minute: 20, api_keys_limit: 5 } } });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'FETCH_FAILED', message: e.message });
    }
  });


  // Private administration API. Access is granted only when the authenticated
  // account matches ADMIN_EMAIL or ADMIN_USER_ID stored as a Cloudflare secret.
  const adminGuard = async (req, res, next) => {
    if (!req.user || !adminModule.isAdmin(req.user)) {
      return res.status(403).json({ success: false, error: 'ADMIN_ONLY' });
    }
    next();
  };

  app.get('/api/v1/admin/overview', authMiddleware, adminGuard, async (req, res) => {
    try {
      const users = await authModule.loadUsers();
      const usage = await adminModule.readUsage();
      const userRows = [];
      for (const user of Object.values(users)) {
        const safe = { id: user.id, username: user.username, email: user.email, plan: user.plan, created_at: user.created_at };
        const databases = await storage.getUserDatabases(user.id);
        let tables = 0, records = 0;
        for (const db of databases) {
          const dbTables = await storage.getDatabaseTables(user.id, db.id);
          tables += dbTables.length;
          for (const table of dbTables) records += (await storage.getRecords(user.id, db.id, table.id)).length;
        }
        const u = usage.users?.[user.id] || {};
        userRows.push({
          ...safe,
          stats: { databases: databases.length, tables, records },
          usage: { requests: u.requests || 0, sessions: u.sessions || 0, first_seen: u.first_seen || user.created_at, last_seen: u.last_seen || null, endpoints: u.endpoints || {} },
          location: u.last_location || null
        });
      }
      userRows.sort((a,b) => String(b.usage.last_seen || b.created_at).localeCompare(String(a.usage.last_seen || a.created_at)));
      return res.json({ success: true, admin: { username: req.user.username, email: req.user.email }, totals: { users: userRows.length, requests: usage.totals?.requests || 0, sessions: usage.totals?.sessions || 0 }, users: userRows, days: usage.days || {} });
    } catch (e) {
      console.error('[admin overview]', e);
      return res.status(500).json({ success: false, error: e.code || 'ADMIN_OVERVIEW_FAILED', message: e.message });
    }
  });

  app.delete('/api/v1/admin/users', authMiddleware, adminGuard, async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.user_ids) ? [...new Set(req.body.user_ids.map(String))] : [];
      const deleteAll = req.body?.all === true;
      const users = await authModule.loadUsers();
      const targets = deleteAll ? Object.keys(users) : ids;
      const removable = targets.filter(id => id !== req.user.id && users[id]);
      if (!removable.length) return res.status(400).json({ success: false, error: 'NO_USERS_SELECTED' });
      let deleted = 0;
      for (const id of removable) {
        await storage.deleteUser(id);
        await authModule.deleteUserRecord(id);
        deleted++;
      }
      return res.json({ success: true, deleted });
    } catch (e) {
      console.error('[admin delete users]', e);
      return res.status(500).json({ success: false, error: e.code || 'ADMIN_DELETE_FAILED', message: e.message });
    }
  });

  app.get('/api/v1/admin/datasets', authMiddleware, adminGuard, async (req, res) => {
    try { return res.json({ success: true, ...await adminModule.listDatasets() }); }
    catch (e) { return res.status(500).json({ success:false, error:'DATASET_LIST_FAILED', message:e.message }); }
  });

  app.post('/api/v1/admin/datasets', authMiddleware, adminGuard, async (req, res) => {
    try {
      const data = await adminModule.addDataset(String(req.body?.dataset_id || '').trim(), String(req.body?.label || '').trim());
      return res.status(201).json({ success:true, ...data });
    } catch (e) {
      return res.status(e.code === 'INVALID_DATASET' ? 400 : 500).json({ success:false, error:e.code || 'DATASET_ADD_FAILED', message:e.message });
    }
  });

  app.delete('/api/v1/admin/datasets/:datasetId', authMiddleware, adminGuard, async (req, res) => {
    try { return res.json({ success:true, ...await adminModule.removeDataset(req.params.datasetId) }); }
    catch (e) { return res.status(500).json({ success:false, error:'DATASET_REMOVE_FAILED', message:e.message }); }
  });

  app.use('/api/v1', apiRouter);
  app.use('/apiv1', apiKeyRouter);

  app.get('/api/health', async (req, res) => {
    // Public and intentionally minimal: no storage provider, dataset name or
    // secret/config presence is disclosed. Detail goes to the server log only.
    const hasToken = !!env.HF_TOKEN;
    const hasDataset = !!env.HF_DATASET;
    const hasJwt = !!(env.JWT_SECRET || env.SESSION_SECRET);
    const healthy = isProduction
      ? (hasToken && hasDataset && hasJwt && storage.getMode() !== 'local-mock')
      : true;
    if (!healthy) console.error(`[health] degraded: token=${hasToken} dataset=${hasDataset} jwt=${hasJwt} mode=${storage.getMode()}`);
    return res.json({ success: true, status: healthy ? 'ok' : 'degraded', version: '1.0.0' });
  });

  // In production on Cloudflare, static files under public/ are served by the
  // Cloudflare Assets binding (see wrangler.jsonc "assets.directory"), not by
  // this Express app - the Worker filesystem has no access to public/, and
  // express.static()/res.sendFile() against it would fail or serve nothing.
  // Cloudflare only invokes this Worker's fetch handler for requests that
  // don't match a static asset, which in practice means /api/* routes; assets
  // config's "single-page-application" fallback already serves index.html for
  // any other unmatched path before the Worker ever runs.
  // Locally (node server/index.js) there is no Assets binding, so Express
  // still serves public/ directly for `npm start` / local dev.
  if (!isProduction) {
    // Computed lazily, only here: import.meta.url has no real file:// path in
    // the Cloudflare Workers runtime, so calling fileURLToPath() at module
    // load time (as this used to) throws "path argument must be of type
    // string... Received undefined" as soon as the Worker's top-level code
    // runs - which crashed the deploy itself. It's safe in local Node dev.
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const publicPath = path.join(__dirname, '../public');
    app.use(express.static(publicPath, { index: false }));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/apiv1')) {
        return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'API endpoint not found' });
      }
      return res.sendFile(path.join(publicPath, 'index.html'));
    });
  } else {
    app.use((req, res) => {
      return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'API endpoint not found' });
    });
  }

  app.use((err, req, res, next) => {
    console.error('[Error]', err);
    if (req.path.startsWith('/api/') || req.path.startsWith('/apiv1')) {
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    }
    return res.status(500).send('Internal Server Error');
  });

  return app;
}
