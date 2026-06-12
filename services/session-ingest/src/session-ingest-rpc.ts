import { WorkerEntrypoint } from 'cloudflare:workers';
import { eq, and, desc, gte, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2, organization_memberships } from '@kilocode/db/schema';
import {
  createSessionForCloudAgentSchema,
  deleteSessionForCloudAgentSchema,
  getCloudAgentRootSessionMessagesSchema,
  kiloSdkSessionSnapshotOutcomeSchema,
  listCloudAgentRootSessionsSchema,
  persistedKiloSdkMessageHistorySchema,
  resolveCloudAgentRootSessionSchema,
  type CloudAgentRootSessionSnapshot,
  type CloudAgentRootSessionSummary,
  type CreateSessionForCloudAgentParams,
  type DeleteSessionForCloudAgentParams,
  type GetCloudAgentRootSessionMessagesParams,
  type GetCloudAgentRootSessionMessagesResult,
  type GetCloudAgentRootSessionSnapshotParams,
  type GetCloudAgentRootSessionSnapshotResult,
  type ListCloudAgentRootSessionsParams,
  type ResolveCloudAgentRootSessionForKiloSessionParams,
  type ResolveCloudAgentRootSessionForKiloSessionResult,
  type SessionIngestRpcMethods,
} from '@kilocode/session-ingest-contracts';

import type { Env } from './env';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { getSessionAccessCacheDO } from './dos/SessionAccessCacheDO';
import { withDORetry } from '@kilocode/worker-utils';
import { app } from './app';
import { mapSessionEventRow, notifyUserSessionEvent } from './session-events';

const MAX_CLOUD_AGENT_ROOT_SESSION_TITLE_CHARACTERS = 512;

function databaseTimestampToMilliseconds(value: string): number {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error('Invalid Cloud Agent root session timestamp');
  }
  return timestamp;
}

function organizationMembershipJoinCondition(kiloUserId: string) {
  return and(
    eq(organization_memberships.organization_id, cli_sessions_v2.organization_id),
    eq(organization_memberships.kilo_user_id, kiloUserId)
  );
}

function personalOrAccessibleOrganizationCondition() {
  return or(isNull(cli_sessions_v2.organization_id), isNotNull(organization_memberships.id));
}

export class SessionIngestRPC extends WorkerEntrypoint<Env> implements SessionIngestRpcMethods {
  // Delegate HTTP requests to the Hono app so callers using the service
  // binding can `.fetch()` against this entrypoint (not just call RPC methods).
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  /**
   * RPC method: create a cli_sessions_v2 record for a cloud-agent-next session.
   * Called via service binding from cloud-agent-next during session preparation.
   *
   * Uses ON CONFLICT DO UPDATE to set cloud_agent_session_id (and organization_id
   * if provided), matching the behavior previously in the backend routers.
   */
  async createSessionForCloudAgent(params: CreateSessionForCloudAgentParams): Promise<void> {
    const parsed = createSessionForCloudAgentSchema.parse(params);

    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

    const existingRows = await db
      .select()
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, parsed.sessionId),
          eq(cli_sessions_v2.kilo_user_id, parsed.kiloUserId)
        )
      )
      .limit(1);
    const existingRow = existingRows[0];

    const hasMeaningfulChange = existingRow
      ? existingRow.cloud_agent_session_id !== parsed.cloudAgentSessionId ||
        (parsed.organizationId !== undefined &&
          existingRow.organization_id !== parsed.organizationId)
      : true;

    const [persistedRow] = await db
      .insert(cli_sessions_v2)
      .values({
        session_id: parsed.sessionId,
        kilo_user_id: parsed.kiloUserId,
        cloud_agent_session_id: parsed.cloudAgentSessionId,
        organization_id: parsed.organizationId ?? null,
        created_on_platform: parsed.createdOnPlatform,
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
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
      })
      .returning();

    if (hasMeaningfulChange && persistedRow) {
      const session = mapSessionEventRow(persistedRow);
      notifyUserSessionEvent(
        this.env,
        parsed.kiloUserId,
        {
          type: existingRow ? 'session.updated' : 'session.created',
          data: { source: 'v2', session, changedAt: session.updatedAt },
        },
        this.ctx
      );
    }

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

  async resolveCloudAgentRootSessionForKiloSession(
    params: ResolveCloudAgentRootSessionForKiloSessionParams
  ): Promise<ResolveCloudAgentRootSessionForKiloSessionResult> {
    const parsed = resolveCloudAgentRootSessionSchema.parse(params);
    const mapping = await this.findOwnedRootCloudAgentMapping(parsed);
    return mapping ? { cloudAgentSessionId: mapping.cloudAgentSessionId } : null;
  }

  async getCloudAgentRootSessionSnapshot(
    params: GetCloudAgentRootSessionSnapshotParams
  ): Promise<GetCloudAgentRootSessionSnapshotResult> {
    const parsed = resolveCloudAgentRootSessionSchema.parse(params);
    const mapping = await this.findOwnedRootCloudAgentMapping(parsed);
    if (!mapping) {
      return null;
    }

    return this.hydrateCloudAgentRootSessionSnapshot({
      kiloUserId: parsed.kiloUserId,
      kiloSessionId: parsed.kiloSessionId,
      cloudAgentSessionId: mapping.cloudAgentSessionId,
    });
  }

  async getCloudAgentRootSessionMessages(
    params: GetCloudAgentRootSessionMessagesParams
  ): Promise<GetCloudAgentRootSessionMessagesResult> {
    const parsed = getCloudAgentRootSessionMessagesSchema.parse(params);
    const mapping = await this.findOwnedRootCloudAgentMapping(parsed);
    if (!mapping) {
      return null;
    }

    const rawHistory = await withDORetry<ReturnType<typeof getSessionIngestDO>, unknown>(
      () =>
        getSessionIngestDO(this.env, {
          kiloUserId: parsed.kiloUserId,
          sessionId: parsed.kiloSessionId,
        }),
      stub => stub.readKiloSdkMessages({ limit: parsed.limit, before: parsed.before }),
      'SessionIngestDO.readKiloSdkMessages'
    );
    const parsedHistory = persistedKiloSdkMessageHistorySchema.nullable().safeParse(rawHistory);

    return {
      kiloSessionId: parsed.kiloSessionId,
      cloudAgentSessionId: mapping.cloudAgentSessionId,
      history: parsedHistory.success ? parsedHistory.data : { kind: 'invalid_data' },
    };
  }

  async listCloudAgentRootSessions(
    params: ListCloudAgentRootSessionsParams
  ): Promise<CloudAgentRootSessionSummary[]> {
    const parsed = listCloudAgentRootSessionsSchema.parse(params);
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    const conditions = [
      eq(cli_sessions_v2.kilo_user_id, parsed.kiloUserId),
      isNull(cli_sessions_v2.parent_session_id),
      isNotNull(cli_sessions_v2.cloud_agent_session_id),
      personalOrAccessibleOrganizationCondition(),
    ];
    if (parsed.start !== undefined) {
      conditions.push(gte(cli_sessions_v2.updated_at, new Date(parsed.start).toISOString()));
    }

    const rows = await db
      .select({
        kiloSessionId: cli_sessions_v2.session_id,
        cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
        title: sql<
          string | null
        >`left(${cli_sessions_v2.title}, ${MAX_CLOUD_AGENT_ROOT_SESSION_TITLE_CHARACTERS})`,
        createdAt: cli_sessions_v2.created_at,
        updatedAt: cli_sessions_v2.updated_at,
      })
      .from(cli_sessions_v2)
      .leftJoin(organization_memberships, organizationMembershipJoinCondition(parsed.kiloUserId))
      .where(and(...conditions))
      .orderBy(desc(cli_sessions_v2.updated_at), desc(cli_sessions_v2.session_id))
      .limit(parsed.limit);

    const sessions: CloudAgentRootSessionSummary[] = [];
    for (const row of rows) {
      if (!row.cloudAgentSessionId) continue;
      sessions.push({
        kiloSessionId: row.kiloSessionId,
        cloudAgentSessionId: row.cloudAgentSessionId,
        title: row.title?.slice(0, MAX_CLOUD_AGENT_ROOT_SESSION_TITLE_CHARACTERS) ?? null,
        created: databaseTimestampToMilliseconds(row.createdAt),
        updated: databaseTimestampToMilliseconds(row.updatedAt),
      });
    }
    return sessions;
  }

  private async hydrateCloudAgentRootSessionSnapshot(params: {
    kiloUserId: string;
    kiloSessionId: string;
    cloudAgentSessionId: string;
  }): Promise<CloudAgentRootSessionSnapshot> {
    const rawSnapshot = await withDORetry<ReturnType<typeof getSessionIngestDO>, unknown>(
      () =>
        getSessionIngestDO(this.env, {
          kiloUserId: params.kiloUserId,
          sessionId: params.kiloSessionId,
        }),
      stub => stub.readKiloSdkSessionSnapshot(),
      'SessionIngestDO.readKiloSdkSessionSnapshot'
    );
    const snapshot = kiloSdkSessionSnapshotOutcomeSchema.safeParse(rawSnapshot);

    return {
      kiloSessionId: params.kiloSessionId,
      cloudAgentSessionId: params.cloudAgentSessionId,
      snapshot: snapshot.success ? snapshot.data : { kind: 'invalid_data' },
    };
  }

  private async findOwnedRootCloudAgentMapping(params: {
    kiloUserId: string;
    kiloSessionId: string;
  }): Promise<{ cloudAgentSessionId: string } | null> {
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    const rows = await db
      .select({ cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id })
      .from(cli_sessions_v2)
      .leftJoin(organization_memberships, organizationMembershipJoinCondition(params.kiloUserId))
      .where(
        and(
          eq(cli_sessions_v2.session_id, params.kiloSessionId),
          eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
          isNull(cli_sessions_v2.parent_session_id),
          isNotNull(cli_sessions_v2.cloud_agent_session_id),
          personalOrAccessibleOrganizationCondition()
        )
      )
      .limit(1);

    const cloudAgentSessionId = rows[0]?.cloudAgentSessionId;
    return cloudAgentSessionId ? { cloudAgentSessionId } : null;
  }

  /**
   * RPC method: delete a cli_sessions_v2 record for a cloud-agent-next session.
   * Called via service binding from cloud-agent-next for rollback when DO prepare() fails.
   *
   * Scoped to the user (composite PK: session_id + kilo_user_id).
   */
  async deleteSessionForCloudAgent(params: DeleteSessionForCloudAgentParams): Promise<void> {
    const parsed = deleteSessionForCloudAgentSchema.parse(params);

    // When onlyIfEmpty is set, atomically check emptiness and clear within a
    // single DO request to prevent a TOCTOU race where ingest data arrives
    // between an isEmpty() check and a subsequent clear() call.
    if (parsed.onlyIfEmpty) {
      const cleared = await withDORetry(
        () =>
          getSessionIngestDO(this.env, {
            kiloUserId: parsed.kiloUserId,
            sessionId: parsed.sessionId,
          }),
        stub => stub.clearIfEmpty(),
        'SessionIngestDO.clearIfEmpty'
      );
      if (!cleared) {
        return;
      }
    }

    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

    const deletedRows = await db
      .select()
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, parsed.sessionId),
          eq(cli_sessions_v2.kilo_user_id, parsed.kiloUserId)
        )
      )
      .limit(1);
    const deletedRow = deletedRows[0];

    await db
      .delete(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, parsed.sessionId),
          eq(cli_sessions_v2.kilo_user_id, parsed.kiloUserId)
        )
      );

    if (deletedRow) {
      notifyUserSessionEvent(
        this.env,
        parsed.kiloUserId,
        {
          type: 'session.deleted',
          data: {
            source: 'v2',
            sessionId: deletedRow.session_id,
            parentSessionId: deletedRow.parent_session_id,
            organizationId: deletedRow.organization_id,
            gitUrl: deletedRow.git_url,
            gitBranch: deletedRow.git_branch,
            createdOnPlatform: deletedRow.created_on_platform,
            deletedAt: new Date().toISOString(),
          },
        },
        this.ctx
      );
    }

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

    // When onlyIfEmpty was set, the DO was already cleared atomically above.
    if (!parsed.onlyIfEmpty) {
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
