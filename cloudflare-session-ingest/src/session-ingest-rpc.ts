import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';

import type { Env } from './env';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { getSessionAccessCacheDO } from './dos/SessionAccessCacheDO';
import { withDORetry } from '@kilocode/worker-utils';
import { getSessionExport } from './services/session-export';

const sessionIdSchema = z.string().startsWith('ses_').length(30);

export class SessionIngestRPC extends WorkerEntrypoint<Env> {
  /**
   * RPC method: export session data from the SessionIngestDO.
   * Called via service binding from cloud-agent-next during session restore.
   *
   * Returns the raw JSON string from the DO, or null if the session
   * does not exist or does not belong to the given user.
   */
  async exportSession(params: { sessionId: string; kiloUserId: string }): Promise<string | null> {
    const parsed = z
      .object({
        sessionId: sessionIdSchema,
        kiloUserId: z.string().min(1),
      })
      .parse(params);

    return getSessionExport(this.env, parsed.sessionId, parsed.kiloUserId);
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
    createdOnPlatform: string;
  }): Promise<void> {
    const parsed = z
      .object({
        sessionId: sessionIdSchema,
        kiloUserId: z.string().min(1),
        cloudAgentSessionId: z.string().min(1),
        organizationId: z.string().optional(),
        createdOnPlatform: z.string().min(1),
      })
      .parse(params);

    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

    await db
      .insert(cli_sessions_v2)
      .values({
        session_id: parsed.sessionId,
        kilo_user_id: parsed.kiloUserId,
        cloud_agent_session_id: parsed.cloudAgentSessionId,
        organization_id: parsed.organizationId ?? null,
        created_on_platform: parsed.createdOnPlatform,
        version: 0,
      })
      .onConflictDoUpdate({
        target: [cli_sessions_v2.session_id, cli_sessions_v2.kilo_user_id],
        set: {
          cloud_agent_session_id: parsed.cloudAgentSessionId,
          ...(parsed.organizationId !== undefined
            ? { organization_id: parsed.organizationId }
            : {}),
        },
      });

    // Warm the session cache so subsequent ingests can skip Postgres.
    // Best-effort: cache miss is acceptable; don't fail the create if the DO is unavailable.
    try {
      await withDORetry(
        () => getSessionAccessCacheDO(this.env, { kiloUserId: parsed.kiloUserId }),
        sessionCache => sessionCache.add(parsed.sessionId),
        'SessionAccessCacheDO.add'
      );
    } catch (cacheError) {
      console.error('Failed to warm session cache after create (non-fatal)', {
        sessionId: parsed.sessionId,
        kiloUserId: parsed.kiloUserId,
        error: cacheError instanceof Error ? cacheError.message : String(cacheError),
      });
    }
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

    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

    await db
      .delete(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, parsed.sessionId),
          eq(cli_sessions_v2.kilo_user_id, parsed.kiloUserId)
        )
      );

    // Clear caches — best-effort; don't fail the delete if DOs are unavailable.
    const cacheErrors: string[] = [];
    try {
      await withDORetry(
        () => getSessionAccessCacheDO(this.env, { kiloUserId: parsed.kiloUserId }),
        sessionCache => sessionCache.remove(parsed.sessionId),
        'SessionAccessCacheDO.remove'
      );
    } catch (error) {
      cacheErrors.push(
        `SessionAccessCacheDO.remove: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      await withDORetry(
        () =>
          getSessionIngestDO(this.env, {
            kiloUserId: parsed.kiloUserId,
            sessionId: parsed.sessionId,
          }),
        stub => stub.clear(),
        'SessionIngestDO.clear'
      );
    } catch (error) {
      cacheErrors.push(
        `SessionIngestDO.clear: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (cacheErrors.length > 0) {
      console.error('Failed to clear caches after delete (non-fatal)', {
        sessionId: parsed.sessionId,
        kiloUserId: parsed.kiloUserId,
        errors: cacheErrors,
      });
    }
  }
}
