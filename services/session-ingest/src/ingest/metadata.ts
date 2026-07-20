import { and, eq, sql } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { normalizeGitUrl, withDORetry } from '@kilocode/worker-utils';

import type { Env } from '../env';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { mapSessionEventRow, notifyUserSessionEvent } from '../session-events';
import { SessionStatusSchema } from '../types/user-connection-protocol';

type SessionMetadataUpdates = Partial<
  Pick<
    typeof cli_sessions_v2.$inferInsert,
    | 'title'
    | 'created_on_platform'
    | 'organization_id'
    | 'git_url'
    | 'git_branch'
    | 'status'
    | 'status_updated_at'
  >
>;

export function computeSessionMetadataUpdates(
  mergedChanges: Map<string, string | null>,
  now: () => string = () => new Date().toISOString()
): SessionMetadataUpdates {
  const updates: SessionMetadataUpdates = {};

  if (mergedChanges.has('title')) updates.title = mergedChanges.get('title') ?? null;
  if (mergedChanges.has('platform')) {
    const platform = mergedChanges.get('platform') ?? null;
    if (platform !== null) updates.created_on_platform = platform;
  }
  if (mergedChanges.has('orgId')) updates.organization_id = mergedChanges.get('orgId') ?? null;
  if (mergedChanges.has('gitUrl')) {
    const gitUrl = mergedChanges.get('gitUrl') ?? null;
    updates.git_url = gitUrl === null ? null : normalizeGitUrl(gitUrl);
  }
  if (mergedChanges.has('gitBranch')) updates.git_branch = mergedChanges.get('gitBranch') ?? null;
  if (mergedChanges.has('status')) {
    updates.status = mergedChanges.get('status') ?? null;
    updates.status_updated_at = now();
  }

  return updates;
}

export async function applyMetadataChanges(
  env: Env,
  kiloUserId: string,
  sessionId: string,
  mergedChanges: Map<string, string | null>,
  ctx?: { waitUntil(promise: Promise<unknown>): void }
): Promise<void> {
  if (mergedChanges.size === 0) return;

  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const status = mergedChanges.has('status') ? (mergedChanges.get('status') ?? null) : undefined;
  const updates = computeSessionMetadataUpdates(mergedChanges);
  const parentSessionId = mergedChanges.has('parentId')
    ? (mergedChanges.get('parentId') ?? null)
    : undefined;
  const changedNonStatus =
    mergedChanges.has('title') ||
    mergedChanges.has('platform') ||
    mergedChanges.has('orgId') ||
    mergedChanges.has('gitUrl') ||
    mergedChanges.has('gitBranch') ||
    parentSessionId !== undefined;

  const notification = await db.transaction(async tx => {
    const statusChange =
      status === undefined
        ? { changed: false, previousStatus: null }
        : await (async () => {
            const [statusRow] = await tx
              .select({ status: cli_sessions_v2.status })
              .from(cli_sessions_v2)
              .where(
                and(
                  eq(cli_sessions_v2.session_id, sessionId),
                  eq(cli_sessions_v2.kilo_user_id, kiloUserId)
                )
              )
              .limit(1)
              .for('update');
            if (!statusRow) return null;
            const previousStatus = SessionStatusSchema.nullable().parse(statusRow.status);
            return { changed: status !== previousStatus, previousStatus };
          })();

    if (!statusChange) return null;

    if (Object.keys(updates).length > 0) {
      await tx
        .update(cli_sessions_v2)
        .set(updates)
        .where(
          and(
            eq(cli_sessions_v2.session_id, sessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId)
          )
        );
    }

    if (parentSessionId !== undefined) {
      if (parentSessionId && parentSessionId !== sessionId) {
        const parentRows = await tx
          .select({ session_id: cli_sessions_v2.session_id })
          .from(cli_sessions_v2)
          .where(
            and(
              eq(cli_sessions_v2.session_id, parentSessionId),
              eq(cli_sessions_v2.kilo_user_id, kiloUserId)
            )
          )
          .limit(1);

        if (parentRows[0]) {
          await tx
            .update(cli_sessions_v2)
            .set({ parent_session_id: parentSessionId })
            .where(
              and(
                eq(cli_sessions_v2.session_id, sessionId),
                eq(cli_sessions_v2.kilo_user_id, kiloUserId),
                sql`${cli_sessions_v2.parent_session_id} IS DISTINCT FROM ${parentSessionId}`
              )
            );
        }
      } else if (parentSessionId === null) {
        await tx
          .update(cli_sessions_v2)
          .set({ parent_session_id: null })
          .where(
            and(
              eq(cli_sessions_v2.session_id, sessionId),
              eq(cli_sessions_v2.kilo_user_id, kiloUserId),
              sql`${cli_sessions_v2.parent_session_id} IS DISTINCT FROM ${parentSessionId}`
            )
          );
      }
    }

    if (!changedNonStatus && !statusChange.changed) return null;

    const [persistedRow] = await tx
      .select({
        session_id: cli_sessions_v2.session_id,
        created_at: cli_sessions_v2.created_at,
        updated_at: cli_sessions_v2.updated_at,
        title: cli_sessions_v2.title,
        created_on_platform: cli_sessions_v2.created_on_platform,
        organization_id: cli_sessions_v2.organization_id,
        git_url: cli_sessions_v2.git_url,
        git_branch: cli_sessions_v2.git_branch,
        parent_session_id: cli_sessions_v2.parent_session_id,
        status: cli_sessions_v2.status,
        status_updated_at: cli_sessions_v2.status_updated_at,
      })
      .from(cli_sessions_v2)
      .where(
        and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
      )
      .limit(1);

    if (!persistedRow) return null;

    return {
      changedNonStatus,
      changedStatus: statusChange.changed,
      previousStatus: statusChange.previousStatus,
      session: mapSessionEventRow(persistedRow),
    };
  });

  if (mergedChanges.has('orgId')) {
    try {
      await withDORetry(
        () => getSessionAccessCacheDO(env, { kiloUserId }),
        sessionCache => sessionCache.remove(sessionId),
        'SessionAccessCacheDO.remove'
      );
    } catch (error) {
      console.error('Failed to invalidate session access after organization scope change', {
        kiloUserId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!notification) return;

  if (notification.changedNonStatus) {
    notifyUserSessionEvent(
      env,
      kiloUserId,
      {
        type: 'session.updated',
        data: {
          source: 'v2',
          session: notification.session,
          changedAt: notification.session.updatedAt,
        },
      },
      ctx
    );
  }
  if (notification.changedStatus) {
    notifyUserSessionEvent(
      env,
      kiloUserId,
      {
        type: 'session.status.updated',
        data: {
          source: 'v2',
          session: notification.session,
          previousStatus: notification.previousStatus,
          status: notification.session.status,
          statusUpdatedAt: notification.session.statusUpdatedAt,
          changedAt: notification.session.updatedAt,
        },
      },
      ctx
    );
  }
}

export async function flushPartialMetadataChanges(
  env: Env,
  params: { r2Key: string; kiloUserId: string; sessionId: string },
  mergedChanges: Map<string, string | null>,
  ctx: { waitUntil(promise: Promise<unknown>): void }
): Promise<void> {
  if (mergedChanges.size === 0) return;
  try {
    await applyMetadataChanges(env, params.kiloUserId, params.sessionId, mergedChanges, ctx);
  } catch (err) {
    console.error('Failed to flush partial metadata changes after ingest error', {
      r2Key: params.r2Key,
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
