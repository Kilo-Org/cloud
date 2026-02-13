import { Hono } from 'hono';
import type { AppEnv } from '../types';

/**
 * API routes
 * - /api/admin/* - Admin API routes (user-facing, JWT auth, operations via DO RPC)
 */
const api = new Hono<AppEnv>();

/**
 * Resolve the user's KiloClawInstance DO stub from the authenticated userId.
 */
function resolveStub(c: { get: (key: 'userId') => string; env: AppEnv['Bindings'] }) {
  const userId = c.get('userId');
  return c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(userId));
}

/**
 * Admin API routes -- all operations go through the KiloClawInstance DO.
 */
const adminApi = new Hono<AppEnv>();

// GET /api/admin/storage - Removed (R2 replaced by Fly Volumes)
adminApi.get('/storage', async c => {
  return c.json(
    { error: 'Storage sync has been removed. Data now persists via Fly Volumes.' },
    410
  );
});

// POST /api/admin/storage/sync - Removed (R2 replaced by Fly Volumes)
adminApi.post('/storage/sync', async c => {
  return c.json(
    { error: 'Storage sync has been removed. Data now persists via Fly Volumes.' },
    410
  );
});

// POST /api/admin/gateway/restart - Restart the Fly Machine via the DO
adminApi.post('/gateway/restart', async c => {
  const stub = resolveStub(c);

  const result = await stub.restartGateway();

  if (result.success) {
    return c.json({
      success: true,
      message: 'Machine restarting with updated configuration...',
    });
  } else {
    return c.json({ success: false, error: result.error }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
