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

// GET /api/admin/storage - Get R2 storage status from the DO
adminApi.get('/storage', async c => {
  const stub = resolveStub(c);
  const status = await stub.getStatus();

  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID &&
    c.env.R2_SECRET_ACCESS_KEY &&
    c.env.CF_ACCOUNT_ID
  );

  return c.json({
    configured: hasCredentials,
    lastSync: status.lastSyncAt ? new Date(status.lastSyncAt).toISOString() : null,
    syncInProgress: status.syncInProgress,
    message: hasCredentials
      ? 'R2 storage is configured. Your data will persist across container restarts.'
      : 'R2 storage is not configured. Data will be lost when the container restarts.',
  });
});

// POST /api/admin/storage/sync - Trigger a manual sync to R2 via the DO
adminApi.post('/storage/sync', async c => {
  const stub = resolveStub(c);
  const result = await stub.triggerSync();

  if (result.success) {
    return c.json({
      success: true,
      message: 'Sync completed successfully',
      lastSync: result.lastSync,
    });
  } else {
    const httpStatus = result.error?.includes('not configured') ? 400 : 500;
    return c.json(
      {
        success: false,
        error: result.error,
        details: result.details,
      },
      httpStatus
    );
  }
});

// POST /api/admin/gateway/restart - Restart the gateway process via the DO
adminApi.post('/gateway/restart', async c => {
  const stub = resolveStub(c);

  const result = await stub.restartGateway();

  if (result.success) {
    return c.json({
      success: true,
      message: result.previousProcessId
        ? 'Gateway process killed, new instance starting...'
        : 'No existing process found, starting new instance...',
      previousProcessId: result.previousProcessId,
    });
  } else {
    return c.json({ success: false, error: result.error }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
