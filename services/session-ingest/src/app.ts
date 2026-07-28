import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Env } from './env';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';

import { kiloJwtAuthMiddleware } from './middleware/kilo-jwt-auth';
import { api } from './routes/api';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { getSessionAccessCacheDO } from './dos/SessionAccessCacheDO';
import { getSessionExport } from './services/session-export';
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

export const app = new Hono<{
  Bindings: Env;
  Variables: {
    user_id: string;
  };
}>();

// Protect all /api routes with Kilo user API JWT auth.
app.use('/api/*', kiloJwtAuthMiddleware);
app.route('/api', api);

// Public session endpoint: look up a session by public_id and return all ingested DO events.
app.get('/session/:sessionId', async c => {
  const sessionId = c.req.param('sessionId');
  const parsedSessionId = z.uuid().safeParse(sessionId);
  if (!parsedSessionId.success) {
    return c.json(
      { success: false, error: 'Invalid sessionId', issues: parsedSessionId.error.issues },
      400
    );
  }

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const rows = await db
    .select({
      session_id: cli_sessions_v2.session_id,
      kilo_user_id: cli_sessions_v2.kilo_user_id,
    })
    .from(cli_sessions_v2)
    .where(eq(cli_sessions_v2.public_id, parsedSessionId.data))
    .limit(1);

  const row = rows[0];

  if (!row) {
    return c.json({ success: false, error: 'session_not_found' }, 404);
  }

  const stream = await withDORetry(
    () =>
      getSessionIngestDO(c.env, {
        kiloUserId: row.kilo_user_id,
        sessionId: row.session_id,
      }),
    s => s.getAllStream(),
    'SessionIngestDO.getAllStream'
  );

  return c.body(stream, 200, {
    'content-type': 'application/json; charset=utf-8',
  });
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
