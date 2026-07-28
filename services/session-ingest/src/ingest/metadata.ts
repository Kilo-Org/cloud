import { and, eq, inArray, sql } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { hasOrganizationAccess, normalizeGitUrl, withDORetry } from '@kilocode/worker-utils';

import type { Env } from '../env';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { isNeedsInputStatus } from '../dos/session-ingest-attention';
import { mapSessionEventRow, notifyUserSessionEvent } from '../session-events';
import { SessionStatusSchema } from '../types/user-connection-protocol';

/** Stored status written when a CLI disconnects while the session is waiting on input. */
export const CLI_DISCONNECT_ATTENTION_RESET_STATUS = 'retry' as const;

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
  /** True only when an organization_id write was actually applied (authorized claim or explicit null clear). */
  let organizationIdWriteApplied = false;

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

    // Membership check only for non-null org claims; run on the same tx as the UPDATE.
    // Residual: SessionIngestDO.writeIngestMetaIfChanged records the claimed orgId in DO
    // SQLite and emits a change only when the value differs; after a refused write the DO
    // believes the org is set while Postgres does not, so re-sending the same orgId later
    // will not re-emit it. Desirable in the attack case; in the benign case (user genuinely
    // joins the org afterwards) the session stays personal until the CLI sends a different
    // value. Follow-up tracked in the PR body.
    if (mergedChanges.has('orgId')) {
      const organizationId = mergedChanges.get('orgId') ?? null;
      if (organizationId !== null) {
        const authorized = await hasOrganizationAccess(tx, {
          kiloUserId,
          organizationId,
        });
        if (!authorized) {
          console.warn('Refusing unauthorized organization_id metadata write', {
            kiloUserId,
            sessionId,
            organizationId,
          });
          delete updates.organization_id;
        } else {
          organizationIdWriteApplied = true;
        }
      } else {
        organizationIdWriteApplied = true;
      }
    }

    // Gate only the orgId contribution: a refused-only orgId must not count as a
    // non-status change (no phantom session.updated). Keep parentSessionId and every
    // other non-org key exactly as before — do not derive this from `updates` alone.
    const changedNonStatus =
      mergedChanges.has('title') ||
      mergedChanges.has('platform') ||
      organizationIdWriteApplied ||
      mergedChanges.has('gitUrl') ||
      mergedChanges.has('gitBranch') ||
      parentSessionId !== undefined;

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

  if (organizationIdWriteApplied) {
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

/**
 * Clear a stored attention status when the owning CLI disconnects.
 *
 * Only rows currently in `question`/`permission` are updated (to `retry`). Uses a
 * conditional write so concurrent non-attention updates are not overwritten. Emits
 * `session.status.updated` via the metadata path only — never enters the ingest
 * completion pipeline, so no "Task completed" push can fire.
 */
export async function resetAttentionStatusOnCliDisconnect(
  env: Env,
  kiloUserId: string,
  sessionId: string,
  ctx?: { waitUntil(promise: Promise<unknown>): void }
): Promise<void> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const statusUpdatedAt = new Date().toISOString();

  const notification = await db.transaction(async tx => {
    const [statusRow] = await tx
      .select({ status: cli_sessions_v2.status })
      .from(cli_sessions_v2)
      .where(
        and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
      )
      .limit(1)
      .for('update');

    if (!statusRow) return null;

    const previousStatus = SessionStatusSchema.nullable().parse(statusRow.status);
    if (!isNeedsInputStatus(previousStatus)) return null;

    await tx
      .update(cli_sessions_v2)
      .set({
        status: CLI_DISCONNECT_ATTENTION_RESET_STATUS,
        status_updated_at: statusUpdatedAt,
      })
      .where(
        and(
          eq(cli_sessions_v2.session_id, sessionId),
          eq(cli_sessions_v2.kilo_user_id, kiloUserId),
          // Re-check in WHERE so a concurrent non-attention write wins.
          inArray(cli_sessions_v2.status, ['question', 'permission'])
        )
      );

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
    if (persistedRow.status !== CLI_DISCONNECT_ATTENTION_RESET_STATUS) return null;

    return {
      previousStatus,
      session: mapSessionEventRow(persistedRow),
    };
  });

  if (!notification) return;

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
