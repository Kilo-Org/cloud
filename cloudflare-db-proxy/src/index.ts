import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { runtime } from './routes/runtime';
import { admin } from './routes/admin';
import { logger, withLogTags, formatError } from './logger';

// Re-export DO for wrangler
export { AppDbDO } from './app-db-do';
// Export RPC entrypoint
export { AdminRPCEntrypoint } from './admin-rpc-entrypoint';

const app = new Hono<{ Bindings: Env }>();

// Request logging middleware with context propagation
app.use('*', async (c, next) => {
  return withLogTags({ source: 'worker' }, async () => {
    // Extract appId from path if present (e.g., /api/:appId/query or /admin/apps/:appId/...)
    const path = new URL(c.req.url).pathname;
    const apiMatch = path.match(/^\/api\/([^/]+)/);
    const adminMatch = path.match(/^\/admin\/apps\/([^/]+)/);
    const appId = apiMatch?.[1] ?? adminMatch?.[1];

    if (appId) {
      logger.setTags({ appId });
    }

    const start = Date.now();
    await next();
    const duration = Date.now() - start;

    logger.info('Request completed', {
      method: c.req.method,
      path,
      status: c.res.status,
      durationMs: duration,
    });
  });
});

// Enable CORS for runtime endpoints (apps may call from browsers)
app.use('/api/*', cors());

// Health check
app.get('/health', c => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount routes
app.route('/api', runtime);
app.route('/admin', admin);

// 404 handler
app.notFound(c => {
  return c.json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }, 404);
});

// Error handler
app.onError((err, c) => {
  logger.error('Unhandled error', formatError(err));
  return c.json({ error: { code: 'SQL_ERROR', message: 'Internal server error' } }, 500);
});

export default app;
