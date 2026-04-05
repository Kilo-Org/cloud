import { Hono } from 'hono';
import type { Env } from './env';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';

import { kiloJwtAuthMiddleware } from './middleware/kilo-jwt-auth';
import { api } from './routes/api';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { getSessionExport } from './services/session-export';
import { withDORetry } from '@kilocode/worker-utils';

const sessionIdSchema = z.string().startsWith('ses_').length(30);

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

// Internal route for service-binding HTTP fetch (secret-protected)
app.get('/internal/session/:sessionId/export', async c => {
  const secret = c.req.header('X-Internal-Secret');
  const expected = await c.env.INTERNAL_API_SECRET_PROD.get();

  if (!secret || !expected) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const encoder = new TextEncoder();
  const a = encoder.encode(secret);
  const b = encoder.encode(expected);

  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) {
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
