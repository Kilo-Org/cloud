import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env } from './env';
import { z } from 'zod';

import { kiloJwtAuthMiddleware } from './middleware/kilo-jwt-auth';
import { api } from './routes/api';
import { cloudAgentSessionScopeApi } from './routes/cloud-agent-session-scope';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { getSessionAccessCacheDO } from './dos/SessionAccessCacheDO';
import { getUserConnectionDO } from './dos/UserConnectionDO';
import { getSessionExport } from './services/session-export';
import { resolveSessionShareToken } from './services/session-share-token';
import { withDORetry } from '@kilocode/worker-utils';

const sessionIdSchema = z.string().startsWith('ses_').length(30);
const invalidateSessionAccessSchema = z.object({
  kiloUserId: z.string().min(1),
  organizationId: z.uuid(),
});

async function hasValidInternalSecret(c: {
  req: { header(name: string): string | undefined };
  env: Env;
}): Promise<boolean> {
  const provided = c.req.header('X-Internal-Secret');
  const expected = await c.env.INTERNAL_API_SECRET_PROD.get();
  if (!provided || !expected) return false;

  const encoder = new TextEncoder();
  const providedBytes = encoder.encode(provided);
  const expectedBytes = encoder.encode(expected);
  if (providedBytes.byteLength !== expectedBytes.byteLength) {
    // timingSafeEqual requires equal lengths; self-compare so a length
    // mismatch is not observably faster to reject than a value mismatch.
    timingSafeEqual(providedBytes, providedBytes);
    return false;
  }

  return timingSafeEqual(providedBytes, expectedBytes);
}

const requireValidInternalSecret = createMiddleware<{
  Bindings: Env;
  Variables: { user_id: string };
}>(async (c, next) => {
  if (!(await hasValidInternalSecret(c))) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }
  return next();
});

export const app = new Hono<{
  Bindings: Env;
  Variables: {
    user_id: string;
  };
}>();

// Protect all /api routes with Kilo user API JWT auth.
app.use('/api/*', kiloJwtAuthMiddleware);
app.route('/api', api);

// Scoped session routes are internet-reachable through this Worker hostname. The
// internal secret authenticates the proxy; the JWT identifies the owning user.
app.use('/internal/cloud-agent/v1/*', kiloJwtAuthMiddleware);
app.use('/internal/cloud-agent/v1/*', requireValidInternalSecret);
app.route('/internal/cloud-agent/v1', cloudAgentSessionScopeApi);

// Public session endpoint: resolve the purpose-bound share token, then return
// all ingested DO events for the current session generation.
app.get('/session/:shareToken', async c => {
  const sharedSession = await resolveSessionShareToken(c.env, c.req.param('shareToken'));
  if (!sharedSession) {
    return c.json({ success: false, error: 'session_not_found' }, 404, {
      'cache-control': 'no-store',
    });
  }

  const stream = await withDORetry(
    () =>
      getSessionIngestDO(c.env, {
        kiloUserId: sharedSession.kiloUserId,
        sessionId: sharedSession.sessionId,
      }),
    s => s.getAllStream(),
    'SessionIngestDO.getAllStream'
  );

  return c.body(stream, 200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
});

app.get('/session/:shareToken/metadata', async c => {
  const sharedSession = await resolveSessionShareToken(c.env, c.req.param('shareToken'));
  if (!sharedSession) {
    return c.json({ success: false, error: 'session_not_found' }, 404, {
      'cache-control': 'no-store',
    });
  }

  return c.json(
    {
      success: true,
      title: sharedSession.title,
      owner_name: sharedSession.ownerName,
    },
    200,
    { 'cache-control': 'no-store' }
  );
});

app.post('/internal/session-access/invalidate', async c => {
  if (!(await hasValidInternalSecret(c))) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const parsed = invalidateSessionAccessSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  await withDORetry(
    () => getSessionAccessCacheDO(c.env, { kiloUserId: parsed.data.kiloUserId }),
    sessionCache => sessionCache.invalidateOrganization(parsed.data.organizationId),
    'SessionAccessCacheDO.invalidateOrganization'
  );

  await getUserConnectionDO(c.env, { kiloUserId: parsed.data.kiloUserId }).closeViewerSockets();

  return c.body(null, 204);
});

// Internal route for service-binding HTTP fetch (secret-protected)
app.get('/internal/session/:sessionId/export', async c => {
  if (!(await hasValidInternalSecret(c))) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const kiloUserId = c.req.header('X-Kilo-User-Id');
  if (!kiloUserId) return c.json({ success: false, error: 'Missing X-Kilo-User-Id' }, 400);

  const parsed = sessionIdSchema.safeParse(c.req.param('sessionId'));
  if (!parsed.success) return c.json({ success: false, error: 'Invalid sessionId' }, 400);

  const stream = await getSessionExport(c.env, parsed.data, kiloUserId);
  if (stream === null) return c.json({ success: false, error: 'Session not found' }, 404);

  return c.body(stream, 200, { 'content-type': 'application/json; charset=utf-8' });
});
