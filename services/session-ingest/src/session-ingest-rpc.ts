import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  eq,
  and,
  asc,
  desc,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import {
  activeOrganizationJoinCondition,
  organizationMembershipJoinCondition,
  parentOrganizationJoinCondition,
  parentOrganizationMembershipJoinCondition,
  parentOrganizationsTable,
  parentOrganizationMembershipsTable,
  personalOrInheritedOrganizationCondition,
} from '@kilocode/worker-utils';
import { queryAccessibleKiloSession } from '@kilocode/worker-utils/cloud-agent-session-access';
import {
  createSessionForCloudAgentSchema,
  cloudAgentWorktreeIdSchema,
  cloudAgentWorktreeDeletionSchema,
  recordCloudAgentWorktreeCleanupSchema,
  canDestroyCloudAgentWorktreeSandboxSchema,
  retireCloudAgentWorktreeIfSoleMemberSchema,
  type CloudAgentWorktreeDeletionParams,
  type RecordCloudAgentWorktreeCleanupParams,
  type CanDestroyCloudAgentWorktreeSandboxParams,
  type RetireCloudAgentWorktreeIfSoleMemberParams,
  deleteSessionForCloudAgentSchema,
  decodeCloudAgentRootSessionsCursor,
  decodeCloudAgentWorkspacesCursor,
  encodeCloudAgentRootSessionsCursor,
  encodeCloudAgentWorkspacesCursor,
  getCloudAgentWorkspaceSchema,
  getCloudAgentRootSessionMessagesSchema,
  getSessionMessagesSchema,
  kiloSdkSessionSnapshotOutcomeSchema,
  listCloudAgentRootSessionsSchema,
  listCloudAgentWorkspacesSchema,
  persistedKiloSdkMessageHistorySchema,
  resolveCloudAgentRootSessionSchema,
  type CloudAgentRootSessionSnapshot,
  type CloudAgentRootSessionsPage,
  type CloudAgentRootSessionSummary,
  type CloudAgentWorkspaceSummary,
  type CloudAgentWorkspacesPage,
  type CreateSessionForCloudAgentParams,
  type CreateSessionForCloudAgentResult,
  type DeleteSessionForCloudAgentParams,
  type GetCloudAgentRootSessionMessagesParams,
  type GetCloudAgentRootSessionMessagesResult,
  type GetCloudAgentRootSessionSnapshotParams,
  type GetCloudAgentRootSessionSnapshotResult,
  type GetCloudAgentWorkspaceParams,
  type GetCloudAgentWorkspaceResult,
  type GetSessionMessagesParams,
  type GetSessionMessagesResult,
  type ListCloudAgentRootSessionsParams,
  type ListCloudAgentWorkspacesParams,
  type ResolveCloudAgentRootSessionForKiloSessionParams,
  type ResolveCloudAgentRootSessionForKiloSessionResult,
  type SessionIngestRpcMethods,
} from '@kilocode/session-ingest-contracts';

import type { Env } from './env';
import { getSessionIngestDO, type InspectCloneStageResult } from './dos/SessionIngestDO';
import { getSessionAccessCacheDO } from './dos/SessionAccessCacheDO';
import {
  isValidGitUrl,
  normalizeGitUrl,
  sanitizeGitUrl,
  withDORetry,
} from '@kilocode/worker-utils';
import { app } from './app';
import { mapSessionEventRow, notifyUserSessionEvent } from './session-events';
import { cloneSessionIntoDestination } from './clone/session-clone';
import {
  canCreateCliSessionForUser,
  USER_SESSION_ADMISSION_ERROR,
} from './services/user-session-admission';

import {
  beginWorktreeDeletion,
  recordWorktreeCleanup,
  completeWorktreeDeletion,
  canDestroyWorktreeSandbox,
  registerCloudAgentWorktree,
  retireWorktreeIfSoleMember,
  isWorktreeSessionDeleting,
  WORKTREE_DELETING,
} from './services/worktree-deletion';

const MAX_CLOUD_AGENT_ROOT_SESSION_TITLE_CHARACTERS = 512;
const CLOUD_AGENT_ROOT_SESSION_IDENTITY_CONFLICT_ERROR =
  'Cloud Agent root session identity conflict';

type CliSessionsV2Row = typeof cli_sessions_v2.$inferSelect;

function databaseTimestampToMilliseconds(value: string): number {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error('Invalid Cloud Agent root session timestamp');
  }
  return timestamp;
}

function organizationMembershipJoin(kiloUserId: string) {
  return organizationMembershipJoinCondition(kiloUserId, cli_sessions_v2.organization_id);
}

function organizationJoin() {
  return activeOrganizationJoinCondition(cli_sessions_v2.organization_id);
}

function personalOrAccessibleOrganizationCondition() {
  return personalOrInheritedOrganizationCondition(cli_sessions_v2.organization_id);
}

function worktreeOrganizationMembershipJoin(kiloUserId: string) {
  return organizationMembershipJoinCondition(kiloUserId, cloud_agent_worktrees.organization_id);
}

function worktreeOrganizationJoin() {
  return activeOrganizationJoinCondition(cloud_agent_worktrees.organization_id);
}

function worktreePersonalOrAccessibleOrganizationCondition() {
  return personalOrInheritedOrganizationCondition(cloud_agent_worktrees.organization_id);
}

function accessibleRootConditions(kiloUserId: string): SQL[] {
  return [
    eq(cli_sessions_v2.kilo_user_id, kiloUserId),
    isNull(cli_sessions_v2.parent_session_id),
    isNotNull(cli_sessions_v2.cloud_agent_session_id),
    isNotNull(cli_sessions_v2.cloud_agent_worktree_id),
    personalOrAccessibleOrganizationCondition(),
  ];
}

function safeGitUrl(value: string | null): string | null {
  if (value === null || !isValidGitUrl(value)) return null;
  const sanitized = sanitizeGitUrl(value);
  return sanitized.length <= 2048 ? sanitized : null;
}

function safeGitBranch(value: string | null): string | null {
  if (value === null || value.length === 0 || value.length > 512) {
    return null;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return null;
  }
  return value;
}

function repositoryProvider(
  value: string | null
): CloudAgentWorkspaceSummary['repositoryProvider'] {
  const sanitized = safeGitUrl(value);
  if (!sanitized) return null;
  try {
    const hostname = new URL(sanitized).hostname.toLowerCase();
    if (hostname === 'github.com') return 'github';
    if (hostname === 'gitlab.com') return 'gitlab';
    if (hostname === 'bitbucket.org') return 'bitbucket';
    return 'git';
  } catch {
    return null;
  }
}

/**
 * True when an existing destination root row cannot be claimed by this Cloud
 * Agent create. Mirrors the identity check inside the insert transaction so the
 * pre-clone read and the transactional check agree on what "conflict" means.
 */
function destinationIdentityConflicts(
  existing: Pick<
    CliSessionsV2Row,
    | 'parent_session_id'
    | 'cloud_agent_session_id'
    | 'cloud_agent_session_scope_id'
    | 'cloud_agent_worktree_id'
    | 'organization_id'
  >,
  parsed: CreateSessionForCloudAgentParams
): boolean {
  return (
    existing.parent_session_id !== null ||
    existing.cloud_agent_session_id !== parsed.cloudAgentSessionId ||
    (existing.cloud_agent_session_scope_id !== null &&
      existing.cloud_agent_session_scope_id !== parsed.cloudAgentSessionId) ||
    existing.organization_id !== (parsed.organizationId ?? null) ||
    (existing.cloud_agent_worktree_id ?? null) !== (parsed.cloudAgentWorktreeId ?? null)
  );
}

export class SessionIngestRPC extends WorkerEntrypoint<Env> implements SessionIngestRpcMethods {
  async beginCloudAgentWorktreeDeletion(params: CloudAgentWorktreeDeletionParams) {
    return beginWorktreeDeletion(this.env, cloudAgentWorktreeDeletionSchema.parse(params));
  }

  async recordCloudAgentWorktreeCleanup(params: RecordCloudAgentWorktreeCleanupParams) {
    return recordWorktreeCleanup(this.env, recordCloudAgentWorktreeCleanupSchema.parse(params));
  }

  async completeCloudAgentWorktreeDeletion(params: CloudAgentWorktreeDeletionParams) {
    return completeWorktreeDeletion(
      this.env,
      cloudAgentWorktreeDeletionSchema.parse(params),
      this.ctx
    );
  }

  async canDestroyCloudAgentWorktreeSandbox(params: CanDestroyCloudAgentWorktreeSandboxParams) {
    return canDestroyWorktreeSandbox(
      this.env,
      canDestroyCloudAgentWorktreeSandboxSchema.parse(params)
    );
  }

  async retireCloudAgentWorktreeIfSoleMember(params: RetireCloudAgentWorktreeIfSoleMemberParams) {
    return retireWorktreeIfSoleMember(
      this.env,
      retireCloudAgentWorktreeIfSoleMemberSchema.parse(params)
    );
  }

  // Delegate HTTP requests to the Hono app so callers using the service
  // binding can `.fetch()` against this entrypoint (not just call RPC methods).
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  /**
   * RPC method: create a cli_sessions_v2 record for a cloud-agent-next session.
   * Called via service binding from cloud-agent-next during session preparation.
   *
   * Concurrent retries are idempotent, but an existing session cannot be rebound
   * to another Cloud Agent session scope.
   *
   * When `cloneFromKiloSessionId` is absent the legacy empty-storage path runs
   * unchanged and returns a zero-item clone acknowledgement. When present, the
   * source transcript is cloned into the destination Durable Object before the
   * PostgreSQL insert; the clone is finalized before the row is written. With
   * `cloneUpToMessageId`, only the transcript up to and including that message
   * is cloned and the session diff is dropped; an absent cut message rejects
   * with `clone_cut_not_found`.
   */
  async createSessionForCloudAgent(
    params: CreateSessionForCloudAgentParams
  ): Promise<CreateSessionForCloudAgentResult> {
    const parsed = createSessionForCloudAgentSchema.parse(params);
    const inputGitUrl = parsed.gitUrl === undefined ? undefined : normalizeGitUrl(parsed.gitUrl);

    let copiedItemCount = 0;
    if (parsed.cloneFromKiloSessionId !== undefined) {
      // Destination claim pre-check: read the existing destination root row
      // before any clone write. A conflicting identity rejects without touching
      // the destination Durable Object or R2; a matching identity is an
      // idempotent retry that returns ready without re-cloning.
      const existingDestination = await this.findExistingDestinationRootRow(parsed);
      if (existingDestination) {
        if (destinationIdentityConflicts(existingDestination, parsed)) {
          return { status: 'rejected', code: 'destination_conflict' };
        }
        return { status: 'ready', clone: { sessionId: parsed.sessionId, copiedItemCount: 0 } };
      }

      const source = await this.findOwnedAccessibleSession({
        kiloUserId: parsed.kiloUserId,
        kiloSessionId: parsed.cloneFromKiloSessionId,
      });
      if (!source) {
        return { status: 'rejected', code: 'source_access_denied' };
      }

      const outcome = await cloneSessionIntoDestination({
        env: this.env,
        kiloUserId: parsed.kiloUserId,
        sourceSessionId: parsed.cloneFromKiloSessionId,
        destinationSessionId: parsed.sessionId,
        sourceOrganizationId: source.organizationId,
        destinationOrganizationId: parsed.organizationId ?? null,
        destinationTitle: parsed.title,
        upToMessageId: parsed.cloneUpToMessageId,
      });

      if (outcome.status === 'rejected') return { status: 'rejected', code: outcome.code };
      if (outcome.status === 'in_progress') return { status: 'in_progress' };
      copiedItemCount = outcome.copiedItemCount;
    }

    let existingRow: CliSessionsV2Row | undefined;
    let persistedRow: CliSessionsV2Row | undefined;
    try {
      const inserted = await this.insertCloudAgentRootSession(parsed, inputGitUrl);
      existingRow = inserted.existingRow;
      persistedRow = inserted.persistedRow;
    } catch (error) {
      if (parsed.cloneFromKiloSessionId === undefined) throw error;
      if (
        error instanceof Error &&
        error.message === CLOUD_AGENT_ROOT_SESSION_IDENTITY_CONFLICT_ERROR
      ) {
        // The destination session ID is already claimed by another session.
        // Never clear that other session's Durable Object data.
        return { status: 'rejected', code: 'destination_conflict' };
      }
      const committedRootSession = await this.reconcileCommittedRootSession(parsed);
      if (committedRootSession === 'matching') {
        return { status: 'ready', clone: { sessionId: parsed.sessionId, copiedItemCount } };
      }
      if (committedRootSession === 'conflict') {
        return { status: 'rejected', code: 'destination_conflict' };
      }
      // The insert did not commit: reset the unpublished destination clone and
      // its R2 objects, then rethrow so the caller treats it as retryable.
      await withDORetry(
        () =>
          getSessionIngestDO(this.env, {
            kiloUserId: parsed.kiloUserId,
            sessionId: parsed.sessionId,
          }),
        stub => stub.resetCloneStage(),
        'SessionIngestDO.resetCloneStage'
      );
      throw error;
    }

    const hasMeaningfulChange = existingRow
      ? existingRow.cloud_agent_session_scope_id !== parsed.cloudAgentSessionId ||
        (inputGitUrl !== undefined && existingRow.git_url == null)
      : true;

    if (existingRow && hasMeaningfulChange && persistedRow) {
      try {
        await withDORetry(
          () => getSessionAccessCacheDO(this.env, { kiloUserId: parsed.kiloUserId }),
          sessionCache => sessionCache.remove(parsed.sessionId),
          'SessionAccessCacheDO.remove'
        );
      } catch (cacheError) {
        console.error('Failed to invalidate session access after Cloud Agent session write', {
          sessionId: parsed.sessionId,
          kiloUserId: parsed.kiloUserId,
          error: cacheError instanceof Error ? cacheError.message : String(cacheError),
        });
      }
    }

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

    return { status: 'ready', clone: { sessionId: parsed.sessionId, copiedItemCount } };
  }

  /**
   * Read the existing destination root row for `(sessionId, kiloUserId)` without
   * writing. Used by the clone pre-check so a claimed destination is detected
   * before any Durable Object or R2 mutation.
   */
  private async findExistingDestinationRootRow(
    parsed: CreateSessionForCloudAgentParams
  ): Promise<CliSessionsV2Row | undefined> {
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    const rows = await db
      .select()
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, parsed.sessionId),
          eq(cli_sessions_v2.kilo_user_id, parsed.kiloUserId)
        )
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Insert (or idempotently claim) the cli_sessions_v2 root row for a Cloud
   * Agent session. Runs the admission check and the identity-conflict check in
   * one short transaction. No Durable Object or R2 work runs inside it.
   */
  private async insertCloudAgentRootSession(
    parsed: CreateSessionForCloudAgentParams,
    inputGitUrl: string | undefined
  ): Promise<{
    existingRow: CliSessionsV2Row | undefined;
    persistedRow: CliSessionsV2Row | undefined;
  }> {
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

    return db.transaction(async tx => {
      if (!(await canCreateCliSessionForUser(tx, parsed.kiloUserId))) {
        throw new Error(USER_SESSION_ADMISSION_ERROR);
      }
      await registerCloudAgentWorktree(tx, parsed);

      const [created] = await tx
        .insert(cli_sessions_v2)
        .values({
          session_id: parsed.sessionId,
          kilo_user_id: parsed.kiloUserId,
          cloud_agent_session_id: parsed.cloudAgentSessionId,
          cloud_agent_session_scope_id: parsed.cloudAgentSessionId,
          cloud_agent_worktree_id: parsed.cloudAgentWorktreeId ?? null,
          organization_id: parsed.organizationId ?? null,
          profile_id: parsed.profileId ?? null,
          created_on_platform: parsed.createdOnPlatform,
          ...(parsed.title !== undefined ? { title: parsed.title } : {}),
          ...(inputGitUrl !== undefined ? { git_url: inputGitUrl } : {}),
          version: 0,
        })
        .onConflictDoNothing({
          target: [cli_sessions_v2.session_id, cli_sessions_v2.kilo_user_id],
        })
        .returning();
      if (created) return { existingRow: undefined, persistedRow: created };

      const [existing] = await tx
        .select()
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, parsed.sessionId),
            eq(cli_sessions_v2.kilo_user_id, parsed.kiloUserId)
          )
        )
        .limit(1)
        .for('update');
      if (!existing || destinationIdentityConflicts(existing, parsed)) {
        throw new Error(CLOUD_AGENT_ROOT_SESSION_IDENTITY_CONFLICT_ERROR);
      }

      // Compatibility: old Cloud Agent workers omit gitUrl; remove after all deployed workers send it.
      const repositoryHealed = inputGitUrl !== undefined && existing.git_url == null;
      if (
        inputGitUrl !== undefined &&
        existing.git_url != null &&
        existing.git_url !== inputGitUrl
      ) {
        throw new Error(CLOUD_AGENT_ROOT_SESSION_IDENTITY_CONFLICT_ERROR);
      }

      const [updated] = await tx
        .update(cli_sessions_v2)
        .set({
          cloud_agent_session_scope_id: parsed.cloudAgentSessionId,
          ...(repositoryHealed ? { git_url: inputGitUrl } : {}),
        })
        .where(
          and(
            eq(cli_sessions_v2.session_id, parsed.sessionId),
            eq(cli_sessions_v2.kilo_user_id, parsed.kiloUserId)
          )
        )
        .returning();
      return { existingRow: existing, persistedRow: updated };
    });
  }

  /**
   * Confirm whether the destination root row was committed despite a failed
   * insert (e.g. a transient error after the write). Used to keep same-source
   * retries idempotent across clone finalization and row insertion.
   */
  private async reconcileCommittedRootSession(
    parsed: CreateSessionForCloudAgentParams
  ): Promise<'matching' | 'conflict' | 'missing'> {
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    const rows = await db
      .select({
        parent_session_id: cli_sessions_v2.parent_session_id,
        cloud_agent_session_id: cli_sessions_v2.cloud_agent_session_id,
        cloud_agent_session_scope_id: cli_sessions_v2.cloud_agent_session_scope_id,
        cloud_agent_worktree_id: cli_sessions_v2.cloud_agent_worktree_id,
        organization_id: cli_sessions_v2.organization_id,
      })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, parsed.sessionId),
          eq(cli_sessions_v2.kilo_user_id, parsed.kiloUserId)
        )
      )
      .limit(1);
    const existing = rows[0];
    if (!existing) return 'missing';
    return destinationIdentityConflicts(existing, parsed) ? 'conflict' : 'matching';
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

  /**
   * Generic authorized paginated session history usable by `cliSessionsV2` for
   * any Kilo session the user owns (root cloud-agent, child, or remote CLI).
   * Mirrors `getCloudAgentRootSessionMessages` but enforces the same
   * `(owner, current organization membership)` boundary as the web router's
   * `getSessionWithAccessCheck` so the DO reader is only reached for sessions
   * the caller is allowed to read.
   *
   * Returns `null` for any access failure (missing owner row, lost org
   * membership) so the caller can surface `NOT_FOUND` without leaking which
   * side of the check failed.
   */
  async getSessionMessages(params: GetSessionMessagesParams): Promise<GetSessionMessagesResult> {
    const parsed = getSessionMessagesSchema.parse(params);
    const authorized = await this.findOwnedAccessibleSession(parsed);
    if (!authorized) {
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
      history: parsedHistory.success ? parsedHistory.data : { kind: 'invalid_data' },
    };
  }

  async listCloudAgentRootSessions(
    params: ListCloudAgentRootSessionsParams
  ): Promise<CloudAgentRootSessionsPage> {
    const parsed = listCloudAgentRootSessionsSchema.parse(params);
    const cursor = parsed.cursor ? decodeCloudAgentRootSessionsCursor(parsed.cursor) : undefined;
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    const conditions: (SQL | undefined)[] = [
      eq(cli_sessions_v2.kilo_user_id, parsed.kiloUserId),
      isNull(cli_sessions_v2.parent_session_id),
      isNotNull(cli_sessions_v2.cloud_agent_session_id),
      personalOrAccessibleOrganizationCondition(),
    ];
    if (parsed.workspaceId !== undefined) {
      conditions.push(eq(cli_sessions_v2.cloud_agent_worktree_id, parsed.workspaceId));
    }
    if (parsed.start !== undefined) {
      conditions.push(gte(cli_sessions_v2.updated_at, new Date(parsed.start).toISOString()));
    }
    if (cursor !== undefined) {
      conditions.push(
        or(
          lt(cli_sessions_v2.updated_at, cursor.updatedAt),
          and(
            eq(cli_sessions_v2.updated_at, cursor.updatedAt),
            lt(cli_sessions_v2.session_id, cursor.sessionId)
          )
        )
      );
    }

    const rows = await db
      .select({
        kiloSessionId: cli_sessions_v2.session_id,
        cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
        workspaceId: cli_sessions_v2.cloud_agent_worktree_id,
        userId: cli_sessions_v2.kilo_user_id,
        organizationId: cli_sessions_v2.organization_id,
        title: sql<
          string | null
        >`left(${cli_sessions_v2.title}, ${MAX_CLOUD_AGENT_ROOT_SESSION_TITLE_CHARACTERS})`,
        gitUrl: cli_sessions_v2.git_url,
        gitBranch: cli_sessions_v2.git_branch,
        profileId: cli_sessions_v2.profile_id,
        createdOnPlatform: cli_sessions_v2.created_on_platform,
        createdAt: cli_sessions_v2.created_at,
        updatedAt: cli_sessions_v2.updated_at,
      })
      .from(cli_sessions_v2)
      .leftJoin(organization_memberships, organizationMembershipJoin(parsed.kiloUserId))
      .leftJoin(organizations, organizationJoin())
      .leftJoin(parentOrganizationsTable, parentOrganizationJoinCondition())
      .leftJoin(
        parentOrganizationMembershipsTable,
        parentOrganizationMembershipJoinCondition(parsed.kiloUserId)
      )
      .where(and(...conditions))
      .orderBy(desc(cli_sessions_v2.updated_at), desc(cli_sessions_v2.session_id))
      .limit(parsed.limit + 1);

    const hasNextPage = rows.length > parsed.limit;
    const sessions: CloudAgentRootSessionSummary[] = [];
    for (const row of rows.slice(0, parsed.limit)) {
      if (!row.cloudAgentSessionId) continue;
      const workspaceId = row.workspaceId
        ? cloudAgentWorktreeIdSchema.parse(row.workspaceId)
        : null;
      const title: string | null = row.title;
      sessions.push({
        kiloSessionId: row.kiloSessionId,
        cloudAgentSessionId: row.cloudAgentSessionId,
        workspaceId,
        userId: row.userId,
        organizationId: row.organizationId,
        title: title?.slice(0, MAX_CLOUD_AGENT_ROOT_SESSION_TITLE_CHARACTERS) ?? null,
        gitUrl: safeGitUrl(row.gitUrl),
        gitBranch: safeGitBranch(row.gitBranch),
        profileId: row.profileId,
        createdOnPlatform: row.createdOnPlatform,
        created: databaseTimestampToMilliseconds(row.createdAt),
        updated: databaseTimestampToMilliseconds(row.updatedAt),
      });
    }
    const lastRow = rows[Math.min(rows.length, parsed.limit) - 1];
    return {
      items: sessions,
      nextCursor:
        hasNextPage && lastRow
          ? encodeCloudAgentRootSessionsCursor({
              updatedAt: lastRow.updatedAt,
              sessionId: lastRow.kiloSessionId,
            })
          : null,
    };
  }

  async listCloudAgentWorkspaces(
    params: ListCloudAgentWorkspacesParams
  ): Promise<CloudAgentWorkspacesPage> {
    const parsed = listCloudAgentWorkspacesSchema.parse(params);
    const cursor = parsed.cursor ? decodeCloudAgentWorkspacesCursor(parsed.cursor) : undefined;
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    const workspaceUpdatedAt = sql<string>`greatest(
      max(${cli_sessions_v2.updated_at}),
      coalesce(${cloud_agent_worktrees.updated_at}, '-infinity'::timestamptz)
    )`;
    const canonicalGitUrl = sql<
      string | null
    >`(array_agg(${cli_sessions_v2.git_url} order by ${cli_sessions_v2.created_at}, ${cli_sessions_v2.session_id}) filter (where ${cli_sessions_v2.git_url} is not null))[1]`;
    const conditions: (SQL | undefined)[] = [
      ...accessibleRootConditions(parsed.kiloUserId),
      or(
        isNull(cloud_agent_worktrees.worktree_id),
        isNull(cloud_agent_worktrees.deletion_completed_at)
      ),
      parsed.workspaceId === undefined
        ? undefined
        : eq(cli_sessions_v2.cloud_agent_worktree_id, parsed.workspaceId),
    ];
    const having = and(
      cursor
        ? or(
            lt(workspaceUpdatedAt, cursor.updatedAt),
            and(
              eq(workspaceUpdatedAt, cursor.updatedAt),
              lt(cli_sessions_v2.cloud_agent_worktree_id, cursor.workspaceId)
            )
          )
        : undefined,
      parsed.repositoryUrl === undefined
        ? undefined
        : eq(canonicalGitUrl, normalizeGitUrl(parsed.repositoryUrl))
    );

    const rows = await db
      .select({
        workspaceId: cli_sessions_v2.cloud_agent_worktree_id,
        userId: cli_sessions_v2.kilo_user_id,
        organizationId: cli_sessions_v2.organization_id,
        name: cloud_agent_worktrees.name,
        gitUrl: canonicalGitUrl,
        gitBranch: sql<
          string | null
        >`(array_agg(${cli_sessions_v2.git_branch} order by ${cli_sessions_v2.created_at}, ${cli_sessions_v2.session_id}) filter (where ${cli_sessions_v2.git_branch} is not null))[1]`,
        profileId: sql<
          string | null
        >`(array_agg(${cli_sessions_v2.profile_id} order by ${cli_sessions_v2.created_at}, ${cli_sessions_v2.session_id}) filter (where ${cli_sessions_v2.profile_id} is not null))[1]`,
        deletionStartedAt: cloud_agent_worktrees.deletion_started_at,
        createdAt: sql<string>`coalesce(
          ${cloud_agent_worktrees.created_at},
          min(${cli_sessions_v2.created_at})
        )`,
        updatedAt: workspaceUpdatedAt,
        lastActivityAt: sql<string>`max(coalesce(
          ${cli_sessions_v2.last_activity_at},
          ${cli_sessions_v2.updated_at}
        ))`,
      })
      .from(cli_sessions_v2)
      .leftJoin(organization_memberships, organizationMembershipJoin(parsed.kiloUserId))
      .leftJoin(organizations, organizationJoin())
      .leftJoin(parentOrganizationsTable, parentOrganizationJoinCondition())
      .leftJoin(
        parentOrganizationMembershipsTable,
        parentOrganizationMembershipJoinCondition(parsed.kiloUserId)
      )
      .leftJoin(
        cloud_agent_worktrees,
        and(
          eq(cloud_agent_worktrees.worktree_id, cli_sessions_v2.cloud_agent_worktree_id),
          eq(cloud_agent_worktrees.kilo_user_id, cli_sessions_v2.kilo_user_id),
          sql`${cloud_agent_worktrees.organization_id} is not distinct from ${cli_sessions_v2.organization_id}`
        )
      )
      .where(and(...conditions))
      .groupBy(
        cli_sessions_v2.cloud_agent_worktree_id,
        cli_sessions_v2.kilo_user_id,
        cli_sessions_v2.organization_id,
        cloud_agent_worktrees.name,
        cloud_agent_worktrees.created_at,
        cloud_agent_worktrees.updated_at,
        cloud_agent_worktrees.deletion_started_at
      )
      .having(having)
      .orderBy(desc(workspaceUpdatedAt), desc(cli_sessions_v2.cloud_agent_worktree_id))
      .limit(parsed.limit + 1);

    const visibleRows = rows
      .slice(0, parsed.limit)
      .filter(
        (row): row is typeof row & { workspaceId: NonNullable<typeof row.workspaceId> } =>
          row.workspaceId !== null
      );
    const parsedRows = visibleRows.map(row => ({
      ...row,
      workspaceId: cloudAgentWorktreeIdSchema.parse(row.workspaceId),
    }));
    const sessionsByWorkspace = await this.listWorkspaceRootSessions({
      kiloUserId: parsed.kiloUserId,
      workspaceIds: parsedRows.map(row => row.workspaceId),
      limit: parsed.sessionLimit,
    });
    const items: CloudAgentWorkspaceSummary[] = parsedRows.map(row => {
      const sessionPage = sessionsByWorkspace.get(row.workspaceId);
      if (!sessionPage) throw new Error('Missing Cloud Agent workspace session page');
      return {
        workspaceId: row.workspaceId,
        userId: row.userId,
        organizationId: row.organizationId,
        name: row.name,
        repositoryProvider: repositoryProvider(row.gitUrl),
        gitUrl: safeGitUrl(row.gitUrl),
        gitBranch: safeGitBranch(row.gitBranch),
        profileId: row.profileId,
        deletionState: row.deletionStartedAt === null ? 'active' : 'deleting',
        created: databaseTimestampToMilliseconds(row.createdAt),
        updated: databaseTimestampToMilliseconds(row.updatedAt),
        lastActivity: databaseTimestampToMilliseconds(row.lastActivityAt),
        ...sessionPage,
      };
    });
    const lastRow = rows[Math.min(rows.length, parsed.limit) - 1];

    return {
      items,
      nextCursor:
        rows.length > parsed.limit && lastRow?.workspaceId
          ? encodeCloudAgentWorkspacesCursor({
              updatedAt: lastRow.updatedAt,
              workspaceId: cloudAgentWorktreeIdSchema.parse(lastRow.workspaceId),
            })
          : null,
    };
  }

  async getCloudAgentWorkspace(
    params: GetCloudAgentWorkspaceParams
  ): Promise<GetCloudAgentWorkspaceResult> {
    const parsed = getCloudAgentWorkspaceSchema.parse(params);
    const page = await this.listCloudAgentWorkspaces({
      kiloUserId: parsed.kiloUserId,
      workspaceId: parsed.workspaceId,
      limit: 1,
      sessionLimit: parsed.sessionCursor ? 1 : parsed.sessionLimit,
    });
    const workspace = page.items.find(item => item.workspaceId === parsed.workspaceId);
    if (!workspace)
      return this.getDeletedCloudAgentWorkspace(parsed.kiloUserId, parsed.workspaceId);
    if (!parsed.sessionCursor) return workspace;

    const sessions = await this.listCloudAgentRootSessions({
      kiloUserId: parsed.kiloUserId,
      workspaceId: parsed.workspaceId,
      limit: parsed.sessionLimit,
      cursor: parsed.sessionCursor,
    });
    return { ...workspace, sessions: sessions.items, nextSessionCursor: sessions.nextCursor };
  }

  private async getDeletedCloudAgentWorkspace(
    kiloUserId: string,
    workspaceId: GetCloudAgentWorkspaceParams['workspaceId']
  ): Promise<GetCloudAgentWorkspaceResult> {
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    const [row] = await db
      .select({
        workspaceId: cloud_agent_worktrees.worktree_id,
        userId: cloud_agent_worktrees.kilo_user_id,
        organizationId: cloud_agent_worktrees.organization_id,
        createdAt: cloud_agent_worktrees.created_at,
        updatedAt: cloud_agent_worktrees.updated_at,
      })
      .from(cloud_agent_worktrees)
      .leftJoin(organization_memberships, worktreeOrganizationMembershipJoin(kiloUserId))
      .leftJoin(organizations, worktreeOrganizationJoin())
      .leftJoin(parentOrganizationsTable, parentOrganizationJoinCondition())
      .leftJoin(
        parentOrganizationMembershipsTable,
        parentOrganizationMembershipJoinCondition(kiloUserId)
      )
      .where(
        and(
          eq(cloud_agent_worktrees.worktree_id, workspaceId),
          eq(cloud_agent_worktrees.kilo_user_id, kiloUserId),
          isNotNull(cloud_agent_worktrees.deletion_completed_at),
          worktreePersonalOrAccessibleOrganizationCondition()
        )
      )
      .limit(1);
    if (!row) return null;

    return {
      workspaceId: cloudAgentWorktreeIdSchema.parse(row.workspaceId),
      userId: row.userId,
      organizationId: row.organizationId,
      name: null,
      repositoryProvider: null,
      gitUrl: null,
      gitBranch: null,
      profileId: null,
      deletionState: 'deleted',
      created: databaseTimestampToMilliseconds(row.createdAt),
      updated: databaseTimestampToMilliseconds(row.updatedAt),
      lastActivity: databaseTimestampToMilliseconds(row.updatedAt),
      sessions: [],
      nextSessionCursor: null,
    };
  }

  private async listWorkspaceRootSessions(params: {
    kiloUserId: string;
    workspaceIds: string[];
    limit: number;
  }): Promise<Map<string, Pick<CloudAgentWorkspaceSummary, 'sessions' | 'nextSessionCursor'>>> {
    const output = new Map<
      string,
      Pick<CloudAgentWorkspaceSummary, 'sessions' | 'nextSessionCursor'>
    >();
    if (params.workspaceIds.length === 0) return output;

    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    const rankedRoots = db
      .select({
        kiloSessionId: cli_sessions_v2.session_id,
        cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
        workspaceId: cli_sessions_v2.cloud_agent_worktree_id,
        userId: cli_sessions_v2.kilo_user_id,
        organizationId: cli_sessions_v2.organization_id,
        title: sql<
          string | null
        >`left(${cli_sessions_v2.title}, ${MAX_CLOUD_AGENT_ROOT_SESSION_TITLE_CHARACTERS})`.as(
          'title'
        ),
        gitUrl: cli_sessions_v2.git_url,
        gitBranch: cli_sessions_v2.git_branch,
        profileId: cli_sessions_v2.profile_id,
        createdOnPlatform: cli_sessions_v2.created_on_platform,
        createdAt: cli_sessions_v2.created_at,
        updatedAt: cli_sessions_v2.updated_at,
        rank: sql<number>`row_number() over (
          partition by ${cli_sessions_v2.cloud_agent_worktree_id}
          order by ${cli_sessions_v2.updated_at} desc, ${cli_sessions_v2.session_id} desc
        )`.as('rank'),
      })
      .from(cli_sessions_v2)
      .leftJoin(organization_memberships, organizationMembershipJoin(params.kiloUserId))
      .leftJoin(organizations, organizationJoin())
      .leftJoin(parentOrganizationsTable, parentOrganizationJoinCondition())
      .leftJoin(
        parentOrganizationMembershipsTable,
        parentOrganizationMembershipJoinCondition(params.kiloUserId)
      )
      .where(
        and(
          ...accessibleRootConditions(params.kiloUserId),
          inArray(cli_sessions_v2.cloud_agent_worktree_id, params.workspaceIds)
        )
      )
      .as('ranked_cloud_agent_workspace_roots');
    const rows = await db
      .select()
      .from(rankedRoots)
      .where(lte(rankedRoots.rank, params.limit + 1))
      .orderBy(asc(rankedRoots.workspaceId), asc(rankedRoots.rank));

    for (const workspaceId of params.workspaceIds) {
      const workspaceRows = rows.filter(row => row.workspaceId === workspaceId);
      const visibleRows = workspaceRows.slice(0, params.limit);
      const sessions: CloudAgentRootSessionSummary[] = [];
      for (const row of visibleRows) {
        if (!row.cloudAgentSessionId || !row.workspaceId) continue;
        const parsedWorkspaceId = cloudAgentWorktreeIdSchema.parse(row.workspaceId);
        sessions.push({
          kiloSessionId: row.kiloSessionId,
          cloudAgentSessionId: row.cloudAgentSessionId,
          workspaceId: parsedWorkspaceId,
          userId: row.userId,
          organizationId: row.organizationId,
          title: row.title?.slice(0, MAX_CLOUD_AGENT_ROOT_SESSION_TITLE_CHARACTERS) ?? null,
          gitUrl: safeGitUrl(row.gitUrl),
          gitBranch: safeGitBranch(row.gitBranch),
          profileId: row.profileId,
          createdOnPlatform: row.createdOnPlatform,
          created: databaseTimestampToMilliseconds(row.createdAt),
          updated: databaseTimestampToMilliseconds(row.updatedAt),
        });
      }
      const lastRow = visibleRows.at(-1);
      output.set(workspaceId, {
        sessions,
        nextSessionCursor:
          workspaceRows.length > params.limit && lastRow
            ? encodeCloudAgentRootSessionsCursor({
                updatedAt: lastRow.updatedAt,
                sessionId: lastRow.kiloSessionId,
              })
            : null,
      });
    }
    return output;
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
      .leftJoin(organization_memberships, organizationMembershipJoin(params.kiloUserId))
      .leftJoin(organizations, organizationJoin())
      .leftJoin(parentOrganizationsTable, parentOrganizationJoinCondition())
      .leftJoin(
        parentOrganizationMembershipsTable,
        parentOrganizationMembershipJoinCondition(params.kiloUserId)
      )
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
   * Confirms the user owns the session and still has access to its
   * organization. Unlike `findOwnedRootCloudAgentMapping`, this does not
   * require a Cloud Agent mapping — it accepts any Kilo session kind so
   * remote CLI sessions and child sessions are also readable.
   */
  private async findOwnedAccessibleSession(params: {
    kiloUserId: string;
    kiloSessionId: string;
  }): Promise<{ kiloSessionId: string; organizationId: string | null } | null> {
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    return queryAccessibleKiloSession(db, params);
  }

  /**
   * RPC method: delete a cli_sessions_v2 record for a cloud-agent-next session.
   * Called via service binding from cloud-agent-next for rollback when DO prepare() fails.
   *
   * Scoped to the user (composite PK: session_id + kilo_user_id).
   *
   * When `cloneSourceSessionId` is present this is a clone rollback: the row,
   * clone DO stage, and its R2 bodies are cleared only when the destination
   * clone matches that source. A session that belongs to another source is
   * never cleared.
   */
  async deleteSessionForCloudAgent(params: DeleteSessionForCloudAgentParams): Promise<void> {
    const parsed = deleteSessionForCloudAgentSchema.parse(params);
    if (
      await isWorktreeSessionDeleting(
        getWorkerDb(this.env.HYPERDRIVE.connectionString),
        parsed.kiloUserId,
        parsed.sessionId
      )
    ) {
      throw new Error(WORKTREE_DELETING);
    }

    if (parsed.cloneSourceSessionId !== undefined) {
      const cloneSourceSessionId = parsed.cloneSourceSessionId;
      const inspected = await withDORetry<
        ReturnType<typeof getSessionIngestDO>,
        InspectCloneStageResult
      >(
        () =>
          getSessionIngestDO(this.env, {
            kiloUserId: parsed.kiloUserId,
            sessionId: parsed.sessionId,
          }),
        stub =>
          stub.inspectCloneStage({
            sourceSessionId: cloneSourceSessionId,
            destinationSessionId: parsed.sessionId,
          }),
        'SessionIngestDO.inspectCloneStage'
      );

      // Rollback owns the destination by source and destination only. A stage
      // built with a message cut reports `mismatch` for a cut-less inspect, yet
      // it is still this source's clone and must be rolled back.
      const matches =
        inspected.status === 'complete' ||
        inspected.status === 'in_progress' ||
        (inspected.status === 'mismatch' &&
          inspected.storedSourceSessionId === cloneSourceSessionId &&
          inspected.storedDestinationSessionId === parsed.sessionId);
      if (!matches) return;

      await this.deleteRootSessionRow(parsed);

      const errors: string[] = [];
      try {
        await withDORetry(
          () =>
            getSessionIngestDO(this.env, {
              kiloUserId: parsed.kiloUserId,
              sessionId: parsed.sessionId,
            }),
          stub => stub.resetCloneStage(),
          'SessionIngestDO.resetCloneStage'
        );
      } catch (error) {
        errors.push(
          `SessionIngestDO.resetCloneStage: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      try {
        await withDORetry(
          () => getSessionAccessCacheDO(this.env, { kiloUserId: parsed.kiloUserId }),
          sessionCache => sessionCache.remove(parsed.sessionId),
          'SessionAccessCacheDO.remove'
        );
      } catch (error) {
        errors.push(
          `SessionAccessCacheDO.remove: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (errors.length > 0) {
        console.error('Failed to clear caches after clone rollback (non-fatal)', {
          sessionId: parsed.sessionId,
          kiloUserId: parsed.kiloUserId,
          errors,
        });
      }
      return;
    }

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

    await this.deleteRootSessionRow(parsed);

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

  /**
   * Delete the cli_sessions_v2 root row scoped to the user and emit the
   * session.deleted event when a row existed.
   */
  private async deleteRootSessionRow(parsed: DeleteSessionForCloudAgentParams): Promise<void> {
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
  }
}
