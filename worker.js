import { httpServerHandler } from "cloudflare:node";
import { createApp } from "./server/app.js";

let cachedEnvKey = null;
let cachedHandler = null;
let cachedServer = null;

async function getHandler(env) {
  const envKey = `${env.HF_TOKEN || ''}|${env.HF_DATASET || ''}|${env.JWT_SECRET || ''}`;
  if (cachedHandler && cachedEnvKey === envKey) {
    return cachedHandler;
  }
  if (cachedServer) {
    try { cachedServer.close(); } catch {}
  }
  const app = await createApp({
    HF_TOKEN: env.HF_TOKEN || '',
    HF_DATASET: env.HF_DATASET || 'chiwoko',
    JWT_SECRET: env.JWT_SECRET || env.SESSION_SECRET || '',
    SESSION_SECRET: env.SESSION_SECRET || env.JWT_SECRET || '',
    NODE_ENV: 'production',
    CLOUDFLARE: '1',
    ...env
  });
  const server = app.listen(3000);
  cachedServer = server;
  cachedHandler = httpServerHandler({ port: 3000 });
  cachedEnvKey = envKey;
  return cachedHandler;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // /api/* = dashboard API, /apiv1/* = public API-key API
    if (url.pathname.startsWith('/api/') || url.pathname === '/apiv1' || url.pathname.startsWith('/apiv1/')) {
      const handler = await getHandler(env);
      const h = new Headers(request.headers);
      const cf = request.cf || {};
      if (cf.city) h.set('X-CF-City', String(cf.city));
      if (cf.region) h.set('X-CF-Region', String(cf.region));
      if (cf.country) h.set('X-CF-Country', String(cf.country));
      const trackedRequest = new Request(request, { headers: h });
      return handler.fetch(trackedRequest, env, ctx);
    }
    // Everything else (/, /index.html, /css/*, /js/*, images, etc.) is served
    // directly from Cloudflare's static assets - not through Express, and not
    // via any manual Request/Response emulation.
    return env.ASSETS.fetch(request);
  }
};
