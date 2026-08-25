import { and, eq, inArray, sql } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { hasOrganizationAccess, normalizeGitUrl, withDORetry } from '@kilocode/worker-utils';

import type { Env } from '../env';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { isNeedsInputStatus } from '../dos/session-ingest-attention';
import { mapSessionEventRow, notifyUserSessionEvent } from '../session-events';
import { SessionStatusSchema } from '../types/user-connection-protocol';
import { isDefaultSessionTitle } from './default-session-title';

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
    | 'platform'
    | 'pr_url'
    | 'pr_number'
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
  // PR-link triple. `platform` here is the PR host (not created_on_platform); the
  // change-map string for prNumber is converted back to an integer, or null on clear.
  if (mergedChanges.has('prPlatform')) updates.platform = mergedChanges.get('prPlatform') ?? null;
  if (mergedChanges.has('prUrl')) updates.pr_url = mergedChanges.get('prUrl') ?? null;
  if (mergedChanges.has('prNumber')) {
    const raw = mergedChanges.get('prNumber');
    updates.pr_number = raw === null ? null : Number(raw);
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

  /** True only when an agent-generated title write was actually applied (placeholder was still unset). */
  let titleWriteApplied = false;

  /** True only when a git_url write was actually applied (non-Cloud-Agent write or Cloud Agent null-to-value heal). */
  let gitUrlWriteApplied = false;

  const notification = await db.transaction(async tx => {
    const selectCurrentRow = () =>
      tx
        .select({
          title: cli_sessions_v2.title,
          status: cli_sessions_v2.status,
          parentSessionId: cli_sessions_v2.parent_session_id,
          cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
          cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
          gitUrl: cli_sessions_v2.git_url,
        })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, sessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId)
          )
        )
        .limit(1);

    let sessionScopeRootLocked = false;
    if (parentSessionId !== undefined) {
      // Session scope identity is write-once for children and only heals null -> value
      // for roots. That immutability makes this unlocked read safe for choosing
      // root-before-child lock order; revisit this if session scope IDs become mutable.
      const [initialRow] = await selectCurrentRow();
      if (!initialRow) return null;
      if (initialRow.cloudAgentSessionScopeId != null) {
        const [scopeRoot] = await tx
          .select({ sessionId: cli_sessions_v2.session_id })
          .from(cli_sessions_v2)
          .where(
            and(
              eq(cli_sessions_v2.kilo_user_id, kiloUserId),
              eq(cli_sessions_v2.cloud_agent_session_id, initialRow.cloudAgentSessionScopeId),
              eq(cli_sessions_v2.cloud_agent_session_scope_id, initialRow.cloudAgentSessionScopeId),
              sql`${cli_sessions_v2.parent_session_id} IS NULL`
            )
          )
          .limit(1)
          .for('update');
        sessionScopeRootLocked = scopeRoot !== undefined;
      }
    }

    const [currentRow] = await selectCurrentRow().for('update');
    if (!currentRow) return null;
    const cloudAgentSessionScopeId = currentRow.cloudAgentSessionScopeId;
    const hasCloudAgentSessionScope = cloudAgentSessionScopeId != null;
    const isCloudAgentManagedSession =
      hasCloudAgentSessionScope || currentRow.cloudAgentSessionId != null;

    const statusChange =
      status === undefined
        ? { changed: false, previousStatus: null }
        : (() => {
            const previousStatus = SessionStatusSchema.nullable().parse(currentRow.status);
            return { changed: status !== previousStatus, previousStatus };
          })();

    // Agent-generated titles arrive asynchronously and can race a user rename. A session's
    // title starts out as a creation placeholder — NULL, or the default title stamped at
    // creation (e.g. cloud-agent-next inserts `New session - <ISO timestamp>`); only promote
    // it from that placeholder here. Once the title holds anything else — whether from a user
    // rename or an earlier agent-generated write — leave it alone so a later user rename can
    // never be clobbered by an in-flight ingest.
    if (mergedChanges.has('title')) {
      if (isDefaultSessionTitle(currentRow.title)) {
        titleWriteApplied = true;
      } else {
        console.warn('Skipping agent-generated title write; title is no longer the placeholder', {
          kiloUserId,
          sessionId,
        });
        delete updates.title;
      }
    }

    // Membership check only for non-null org claims; run on the same tx as the UPDATE.
    // Residual: SessionIngestDO.writeIngestMetaIfChanged records the claimed orgId in DO
    // SQLite and emits a change only when the value differs; after a refused write the DO
    // believes the org is set while Postgres does not, so re-sending the same orgId later
    // will not re-emit it. Desirable in the attack case; in the benign case (user genuinely
    // joins the org afterwards) the session stays personal until the CLI sends a different
    // value. Follow-up tracked in the PR body.
    if (mergedChanges.has('orgId')) {
      const organizationId = mergedChanges.get('orgId') ?? null;
      if (isCloudAgentManagedSession) {
        console.warn('Refusing organization_id metadata write for Cloud Agent session', {
          kiloUserId,
          sessionId,
        });
        delete updates.organization_id;
      } else if (organizationId !== null) {
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

    if (mergedChanges.has('gitUrl')) {
      if (isCloudAgentManagedSession) {
        // Compatibility: old Cloud Agent rows can start without git_url; remove this heal only after no old worker or null root row remains.
        const inputGitUrl = updates.git_url;
        if (inputGitUrl != null && currentRow.gitUrl == null) {
          gitUrlWriteApplied = true;
        } else {
          delete updates.git_url;
        }
      } else {
        gitUrlWriteApplied = true;
      }
    }

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

    let parentSessionIdWriteApplied = false;
    if (parentSessionId !== undefined) {
      if (currentRow.cloudAgentSessionId != null) {
        console.warn('Refusing Cloud Agent root parent metadata write', {
          kiloUserId,
          sessionId,
        });
      } else if (hasCloudAgentSessionScope) {
        if (parentSessionId === null) {
          console.warn('Refusing invalid Cloud Agent session scope parent metadata write', {
            kiloUserId,
            sessionId,
          });
        } else if (
          parentSessionId !== sessionId &&
          parentSessionId !== currentRow.parentSessionId
        ) {
          if (sessionScopeRootLocked) {
            const [parent] = await tx
              .select({ sessionId: cli_sessions_v2.session_id })
              .from(cli_sessions_v2)
              .where(
                and(
                  eq(cli_sessions_v2.session_id, parentSessionId),
                  eq(cli_sessions_v2.kilo_user_id, kiloUserId),
                  eq(cli_sessions_v2.cloud_agent_session_scope_id, cloudAgentSessionScopeId)
                )
              )
              .limit(1);
            const cycleResult = parent
              ? await tx.execute<{ creates_cycle: boolean }>(sql`
                  WITH RECURSIVE descendants(session_id) AS (
                    SELECT ${cli_sessions_v2.session_id}
                    FROM ${cli_sessions_v2}
                    WHERE ${cli_sessions_v2.parent_session_id} = ${sessionId}
                      AND ${cli_sessions_v2.kilo_user_id} = ${kiloUserId}
                    UNION
                    SELECT child.session_id
                    FROM ${cli_sessions_v2} child
                    INNER JOIN descendants d ON child.parent_session_id = d.session_id
                    WHERE child.kilo_user_id = ${kiloUserId}
                  )
                  SELECT EXISTS(
                    SELECT 1 FROM descendants WHERE session_id = ${parentSessionId}
                  ) AS creates_cycle
                `)
              : null;
            if (parent && !cycleResult?.rows[0]?.creates_cycle) {
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
              parentSessionIdWriteApplied = true;
            }
          } else {
            console.warn('Refusing Cloud Agent reparent without a session scope root', {
              kiloUserId,
              sessionId,
              cloudAgentSessionScopeId,
            });
          }
        }
      } else if (parentSessionId && parentSessionId !== sessionId) {
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
          parentSessionIdWriteApplied = parentSessionId !== currentRow.parentSessionId;
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
        parentSessionIdWriteApplied = currentRow.parentSessionId !== null;
      }
    }

    // Refused org/parent/title claims must not emit phantom session.updated events.
    const changedNonStatus =
      titleWriteApplied ||
      mergedChanges.has('platform') ||
      organizationIdWriteApplied ||
      gitUrlWriteApplied ||
      mergedChanges.has('gitBranch') ||
      mergedChanges.has('prPlatform') ||
      mergedChanges.has('prUrl') ||
      mergedChanges.has('prNumber') ||
      parentSessionIdWriteApplied;

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
