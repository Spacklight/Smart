export function createAuthMiddleware({ authModule, adminModule } = {}) {
  if (!authModule) throw new Error('authModule required');
  async function authMiddleware(req, res, next) {
    try {
      let token = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.substring(7);
      if (!token && req.cookies && req.cookies.token) token = req.cookies.token;
      if (!token) return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Authentication required' });
      const decoded = authModule.verifyToken(token);
      if (!decoded) return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid or expired token' });
      const user = await authModule.getUserById(decoded.id);
      if (!user) return res.status(401).json({ success: false, error: 'USER_NOT_FOUND' });
      req.user = user;
      req.userId = user.id;
      if (adminModule) {
        const cf = req.headers || {};
        adminModule.recordUsage(user, req, {
          city: cf['x-cf-city'] || '',
          region: cf['x-cf-region'] || '',
          country: cf['x-cf-country'] || ''
        }).catch(() => {});
      }
      next();
    } catch (e) { return res.status(401).json({ success: false, error: 'UNAUTHORIZED' }); }
  }
  return { authMiddleware };
}
