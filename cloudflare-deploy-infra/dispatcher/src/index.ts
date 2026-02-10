import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from './types';
import { getPasswordRecord } from './auth/password-store';
import { validateAuthCookie } from './auth/jwt';
import { api } from './routes/api';
import { auth } from './routes/auth';

const app = new Hono<{ Bindings: Env }>();

// Request logging middleware
/*
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const { method } = c.req;
  const url = c.req.url;
  console.log(`${method} ${url} - ${c.res.status} (${duration}ms)`);
});
*/

// Redirect .d.kiloapps.ai to .d.kiloapps.io
app.use('*', async (c, next) => {
  const hostname = new URL(c.req.url).hostname;
  if (hostname.endsWith('.d.kiloapps.ai')) {
    const newHostname = hostname.slice(0, -'.d.kiloapps.ai'.length) + '.d.kiloapps.io';
    const redirectUrl = new URL(c.req.url);
    redirectUrl.hostname = newHostname;
    return c.redirect(redirectUrl.toString(), 301);
  }
  await next();
});

function validateWorkerName(name: string): boolean {
  return /^[a-zA-Z0-9-_]{1,64}$/.test(name);
}

// Create separate apps for apex and subdomain routing
const apexApp = new Hono<{ Bindings: Env }>();
apexApp.route('/api', api);
apexApp.all('*', c => c.text('Not Found', 404));

// Variables stored in context:
// - publicSlug: The slug from the URL (used for password protection, cookies)
// - workerName: The actual Cloudflare worker name (may differ from publicSlug if renamed)
const subdomainApp = new Hono<{
  Bindings: Env;
  Variables: { publicSlug: string; workerName: string };
}>();

// Middleware to extract slug from hostname and resolve worker name via KV
subdomainApp.use('*', async (c, next) => {
  const hostname = new URL(c.req.url).hostname;
  const slug = hostname.slice(0, -c.env.HOSTNAME_SUFFIX.length);

  // Store the public-facing slug (for password protection lookup, auth cookies)
  c.set('publicSlug', slug);

  // Check KV for slug mapping (custom slug -> internal worker name)
  const mappedWorkerName = await c.env.DEPLOY_KV.get(`slug2worker:${slug}`);

  if (mappedWorkerName !== null && !validateWorkerName(mappedWorkerName)) {
    return c.text('Not Found', 404);
  }

  // Use mapped name if exists, otherwise use slug directly (backwards compat)
  c.set('workerName', mappedWorkerName ?? slug);

  await next();
});

// Mount auth routes at /__auth
subdomainApp.route('/__auth', auth);

// Handle all other paths on subdomain - check password protection and forward to worker
subdomainApp.all('*', async c => {
  const workerName = c.get('workerName');
  const url = new URL(c.req.url);

  // Check password protection (keyed by internal worker name so it applies
  // regardless of which subdomain/slug is used to reach the worker)
  const passwordRecord = await getPasswordRecord(c.env.DEPLOY_KV, workerName);

  if (passwordRecord) {
    const authCookie = getCookie(c, 'kilo_auth');
    const isAuthenticated = validateAuthCookie(
      authCookie,
      c.env.JWT_SECRET,
      workerName,
      passwordRecord
    );

    if (!isAuthenticated) {
      const returnPath = url.pathname + url.search;
      const authUrl = `/__auth?return=${encodeURIComponent(returnPath)}`;
      return c.redirect(authUrl, 302);
    }
  }

  // Get the worker from dispatch namespace using the internal worker name
  const worker = c.env.DISPATCH.get(workerName);

  // Forward request
  try {
    return (await worker.fetch(c.req.raw)) as unknown as Response;
  } catch {
    return c.text('Error forwarding request', 500);
  }
});

// Main routing based on hostname
app.all('*', async c => {
  const url = new URL(c.req.url);
  const hostname = url.hostname;

  // Get the apex hostname by removing the leading dot from the suffix
  const apexHostname = c.env.HOSTNAME_SUFFIX.slice(1);

  // Management API: apex domain (no subdomain)
  if (hostname === apexHostname) {
    return apexApp.fetch(c.req.raw, c.env, c.executionCtx);
  }

  // Subdomain-based routing: <worker-name>.<suffix>
  if (hostname.endsWith(c.env.HOSTNAME_SUFFIX)) {
    const workerName = hostname.slice(0, -c.env.HOSTNAME_SUFFIX.length);

    if (!workerName || !validateWorkerName(workerName)) {
      return c.text('Worker name required', 404);
    }

    return subdomainApp.fetch(c.req.raw, c.env, c.executionCtx);
  }

  return c.text('Not Found', 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.text('Internal Server Error', 500);
});

export default app;
