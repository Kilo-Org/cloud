import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { Env } from './env';
import { z } from 'zod';
import { kiloJwtAuthMiddleware } from './middleware/kilo-jwt-auth';
import { api } from './routes/api';
import { getDb } from './db/kysely';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { getSessionAccessCacheDO } from './dos/SessionAccessCacheDO';
import { withDORetry } from './util/do-retry';
export { SessionIngestDO } from './dos/SessionIngestDO';
export { SessionAccessCacheDO } from './dos/SessionAccessCacheDO';

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

const sessionIdSchema = z.string().startsWith('ses_').length(30);

export default class SessionIngestWorker extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  /**
   * RPC method: create a cli_sessions_v2 record for a cloud-agent-next session.
   * Called via service binding from cloud-agent-next during session preparation.
   *
   * Uses ON CONFLICT DO UPDATE to set cloud_agent_session_id (and organization_id
   * if provided), matching the behavior previously in the backend routers.
   */
  async createSessionForCloudAgent(params: {
    sessionId: string;
    kiloUserId: string;
    cloudAgentSessionId: string;
    organizationId?: string;
    createdOnPlatform?: string;
  }): Promise<void> {
    const parsed = z
      .object({
        sessionId: sessionIdSchema,
        kiloUserId: z.string().min(1),
        cloudAgentSessionId: z.string().min(1),
        organizationId: z.string().optional(),
        createdOnPlatform: z.string().optional(),
      })
      .parse(params);

    const db = getDb(this.env.HYPERDRIVE);

    await db
      .insertInto('cli_sessions_v2')
      .values({
        session_id: parsed.sessionId,
        kilo_user_id: parsed.kiloUserId,
        cloud_agent_session_id: parsed.cloudAgentSessionId,
        organization_id: parsed.organizationId ?? null,
        created_on_platform: parsed.createdOnPlatform ?? 'cloud-agent',
        version: 0,
      })
      .onConflict(oc =>
        oc.columns(['session_id', 'kilo_user_id']).doUpdateSet({
          cloud_agent_session_id: parsed.cloudAgentSessionId,
          ...(parsed.organizationId !== undefined
            ? { organization_id: parsed.organizationId }
            : {}),
        })
      )
      .execute();

    // Warm the session cache so subsequent ingests can skip Postgres.
    await withDORetry(
      () => getSessionAccessCacheDO(this.env, { kiloUserId: parsed.kiloUserId }),
      sessionCache => sessionCache.add(parsed.sessionId),
      'SessionAccessCacheDO.add'
    );
  }

  /**
   * RPC method: delete a cli_sessions_v2 record for a cloud-agent-next session.
   * Called via service binding from cloud-agent-next for rollback when DO prepare() fails.
   *
   * Scoped to the user (composite PK: session_id + kilo_user_id).
   */
  async deleteSessionForCloudAgent(params: {
    sessionId: string;
    kiloUserId: string;
  }): Promise<void> {
    const parsed = z
      .object({
        sessionId: sessionIdSchema,
        kiloUserId: z.string().min(1),
      })
      .parse(params);

    const db = getDb(this.env.HYPERDRIVE);

    await db
      .deleteFrom('cli_sessions_v2')
      .where('session_id', '=', parsed.sessionId)
      .where('kilo_user_id', '=', parsed.kiloUserId)
      .execute();

    // Clear caches
    await withDORetry(
      () => getSessionAccessCacheDO(this.env, { kiloUserId: parsed.kiloUserId }),
      sessionCache => sessionCache.remove(parsed.sessionId),
      'SessionAccessCacheDO.remove'
    );

    await withDORetry(
      () =>
        getSessionIngestDO(this.env, {
          kiloUserId: parsed.kiloUserId,
          sessionId: parsed.sessionId,
        }),
      stub => stub.clear(),
      'SessionIngestDO.clear'
    );
  }
}
