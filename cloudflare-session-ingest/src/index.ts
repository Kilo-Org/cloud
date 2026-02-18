import { Hono } from 'hono';
import type { Env } from './env';
import { z } from 'zod';
import { kiloJwtAuthMiddleware } from './middleware/kilo-jwt-auth';
import { api } from './routes/api';
import { getDb } from './db/kysely';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { withDORetry } from './util/do-retry';
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

  const db = getDb(c.env.HYPERDRIVE);
  const row = await db
    .selectFrom('cli_sessions_v2')
    .select(['session_id', 'kilo_user_id'])
    .where('public_id', '=', parsedSessionId.data)
    .executeTakeFirst();

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
