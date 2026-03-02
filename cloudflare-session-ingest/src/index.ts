import { Hono } from 'hono';
import type { Env } from './env';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';

import { kiloJwtAuthMiddleware } from './middleware/kilo-jwt-auth';
import { api } from './routes/api';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { withDORetry } from '@kilocode/worker-utils';
export { SessionIngestDO } from './dos/SessionIngestDO';
export { SessionAccessCacheDO } from './dos/SessionAccessCacheDO';
export { SessionIngestRPC } from './session-ingest-rpc';

const app = new Hono<{
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

  const json = await withDORetry(
    () =>
      getSessionIngestDO(c.env, {
        kiloUserId: row.kilo_user_id,
        sessionId: row.session_id,
      }),
    s => s.getAll(),
    'SessionIngestDO.getAll'
  );

  return c.body(json, 200, {
    'content-type': 'application/json; charset=utf-8',
  });
});

export default app;
