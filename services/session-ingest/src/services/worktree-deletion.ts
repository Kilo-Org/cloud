import { and, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  type CloudAgentWorktree,
} from '@kilocode/db/schema';
import {
  cloudAgentWorktreeDeletionManifestSchema,
  cloudAgentWorktreeLocationSchema,
  cloudAgentWorktreeIdSchema,
  containedKiloSessionIdSchema,
  kiloSdkSessionSnapshotOutcomeSchema,
  WORKTREE_RUNTIME_HISTORY_UNAVAILABLE,
  type CanDestroyCloudAgentWorktreeSandboxResult,
  type UnresolvedCloudAgentSandboxOwner,
  type CloudAgentWorktreeDeletionParams,
  type CloudAgentWorktreeDeletionState,
  type CloudAgentWorktreeLocation,
  type CreateSessionForCloudAgentParams,
  type RecordCloudAgentWorktreeCleanupParams,
  type CanDestroyCloudAgentWorktreeSandboxParams,
} from '@kilocode/session-ingest-contracts';
import { hasOrganizationAccess, withDORetry } from '@kilocode/worker-utils';
import type { Env } from '../env';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { getUserConnectionDO } from '../dos/UserConnectionDO';
import { notifyUserSessionEvent } from '../session-events';
import {
  allocationLocation,
  firstWorktreeSessionId,
  readSessionAllocations,
} from './worktree-allocation';

type WorktreeDb = Pick<WorkerDb, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export const WORKTREE_ACCESS_DENIED = 'worktree_access_denied';
export const WORKTREE_DELETING = 'worktree_deleting';

function locations(row: CloudAgentWorktree): CloudAgentWorktreeLocation[] {
  return z.array(cloudAgentWorktreeLocationSchema).parse(row.runtime_locations);
}

function deletionState(row: CloudAgentWorktree): CloudAgentWorktreeDeletionState {
  if (row.deletion_completed_at !== null) {
    return {
      completed: true,
      manifest: {
        version: 1,
        sessions: row.deleted_session_ids.map(sessionId => ({
          sessionId,
          cloudAgentSessionId: null,
        })),
      },
      runtimeLocations: [],
    };
  }
  return {
    completed: false,
    manifest: cloudAgentWorktreeDeletionManifestSchema.parse(row.deletion_manifest),
    runtimeLocations: locations(row),
  };
}

async function authorize(
  db: WorktreeDb,
  row: CloudAgentWorktree | undefined,
  params: CloudAgentWorktreeDeletionParams
): Promise<CloudAgentWorktree> {
  if (
    !row ||
    row.kilo_user_id !== params.kiloUserId ||
    row.organization_id !== (params.organizationId ?? null) ||
    (row.organization_id !== null &&
      !(await hasOrganizationAccess(db, {
        kiloUserId: params.kiloUserId,
        organizationId: row.organization_id,
      })))
  ) {
    throw new Error(WORKTREE_ACCESS_DENIED);
  }
  return row;
}

async function lockWorktree(db: WorktreeDb, params: CloudAgentWorktreeDeletionParams) {
  const [row] = await db
    .select()
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, params.worktreeId))
    .for('update');
  return authorize(db, row, params);
}

export async function registerCloudAgentWorktree(
  db: WorktreeDb,
  params: CreateSessionForCloudAgentParams
): Promise<void> {
  if (!params.cloudAgentWorktreeId) return;
  await db
    .insert(cloud_agent_worktrees)
    .values({
      worktree_id: params.cloudAgentWorktreeId,
      kilo_user_id: params.kiloUserId,
      organization_id: params.organizationId ?? null,
    })
    .onConflictDoNothing({ target: cloud_agent_worktrees.worktree_id });
  const row = await lockWorktree(db, {
    worktreeId: params.cloudAgentWorktreeId,
    kiloUserId: params.kiloUserId,
    organizationId: params.organizationId,
  });
  if (row.deletion_started_at !== null) throw new Error(WORKTREE_DELETING);
  if (params.cloudAgentWorktreeLocation) {
    const current = locations(row);
    const incoming = params.cloudAgentWorktreeLocation;
    if (
      !current.some(
        item => item.sandboxId === incoming.sandboxId && item.provider === incoming.provider
      )
    ) {
      await db
        .update(cloud_agent_worktrees)
        .set({ runtime_locations: [...current, incoming] })
        .where(eq(cloud_agent_worktrees.worktree_id, params.cloudAgentWorktreeId));
    }
  }
}

export async function isWorktreeDeleting(
  db: Pick<WorkerDb, 'select'>,
  worktreeId: string
): Promise<boolean> {
  const [row] = await db
    .select({ started: cloud_agent_worktrees.deletion_started_at })
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, worktreeId));
  return row?.started != null;
}

export async function isWorktreeSessionDeleting(
  db: Pick<WorkerDb, 'select'>,
  kiloUserId: string,
  sessionId: string
): Promise<boolean> {
  const [session] = await db
    .select({
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      scopeId: cli_sessions_v2.cloud_agent_session_scope_id,
    })
    .from(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.kilo_user_id, kiloUserId), eq(cli_sessions_v2.session_id, sessionId))
    );
  if (!session) return false;
  if (session.worktreeId) return isWorktreeDeleting(db, session.worktreeId);
  if (!session.scopeId) return false;
  const [root] = await db
    .select({ worktreeId: cli_sessions_v2.cloud_agent_worktree_id })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, kiloUserId),
        eq(cli_sessions_v2.cloud_agent_session_id, session.scopeId)
      )
    );
  return root?.worktreeId ? isWorktreeDeleting(db, root.worktreeId) : false;
}

const memberSchema = cloudAgentWorktreeDeletionManifestSchema.shape.sessions.element.extend({
  organizationId: z.uuid().nullable(),
  worktreeId: cloudAgentWorktreeIdSchema.nullable(),
  cloudAgentSessionScopeId: z.string().nullable(),
});

async function discoverMembers(db: WorktreeDb, params: CloudAgentWorktreeDeletionParams) {
  const result = await db.execute(sql`
    WITH RECURSIVE members AS (
      SELECT session_id, cloud_agent_session_id, organization_id,
        cloud_agent_worktree_id, cloud_agent_session_scope_id
      FROM ${cli_sessions_v2}
      WHERE cloud_agent_worktree_id = ${params.worktreeId} AND kilo_user_id = ${params.kiloUserId}
      UNION
      SELECT child.session_id, child.cloud_agent_session_id, child.organization_id,
        child.cloud_agent_worktree_id, child.cloud_agent_session_scope_id
      FROM ${cli_sessions_v2} child
      INNER JOIN members parent ON child.parent_session_id = parent.session_id
        OR child.cloud_agent_session_scope_id = parent.cloud_agent_session_id
      WHERE child.kilo_user_id = ${params.kiloUserId}
    )
    SELECT session_id AS "sessionId", cloud_agent_session_id AS "cloudAgentSessionId",
      organization_id AS "organizationId", cloud_agent_worktree_id AS "worktreeId",
      cloud_agent_session_scope_id AS "cloudAgentSessionScopeId"
    FROM members ORDER BY session_id
  `);
  const rows = z.array(memberSchema).parse(result.rows);
  const rootScopes = new Set<string>(
    rows.flatMap(row =>
      row.worktreeId === params.worktreeId && row.cloudAgentSessionId
        ? [row.cloudAgentSessionId]
        : []
    )
  );
  if (
    rows.some(
      row =>
        row.organizationId !== (params.organizationId ?? null) ||
        (row.worktreeId !== null && row.worktreeId !== params.worktreeId) ||
        (row.cloudAgentSessionScopeId !== null && !rootScopes.has(row.cloudAgentSessionScopeId)) ||
        (row.cloudAgentSessionId !== null && !rootScopes.has(row.cloudAgentSessionId))
    )
  ) {
    throw new Error(WORKTREE_ACCESS_DENIED);
  }
  return rows.map(({ sessionId, cloudAgentSessionId }) => ({ sessionId, cloudAgentSessionId }));
}

async function lockRoots(db: WorktreeDb, params: CloudAgentWorktreeDeletionParams): Promise<void> {
  await db
    .select({ sessionId: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
        eq(cli_sessions_v2.cloud_agent_worktree_id, params.worktreeId),
        isNull(cli_sessions_v2.parent_session_id)
      )
    )
    .orderBy(cli_sessions_v2.session_id)
    .for('update');
}

export async function beginWorktreeDeletion(env: Env, params: CloudAgentWorktreeDeletionParams) {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  return db.transaction(async tx => {
    const owners = await tx
      .select({
        userId: cli_sessions_v2.kilo_user_id,
        organizationId: cli_sessions_v2.organization_id,
        createdAt: cli_sessions_v2.created_at,
      })
      .from(cli_sessions_v2)
      .where(eq(cli_sessions_v2.cloud_agent_worktree_id, params.worktreeId))
      .orderBy(cli_sessions_v2.created_at);
    if (
      owners.some(
        row =>
          row.userId !== params.kiloUserId || row.organizationId !== (params.organizationId ?? null)
      )
    ) {
      throw new Error(WORKTREE_ACCESS_DENIED);
    }
    const firstOwner = owners[0];
    if (firstOwner) {
      await tx
        .insert(cloud_agent_worktrees)
        .values({
          worktree_id: params.worktreeId,
          kilo_user_id: params.kiloUserId,
          organization_id: params.organizationId ?? null,
          created_at: firstOwner.createdAt,
        })
        .onConflictDoNothing({ target: cloud_agent_worktrees.worktree_id });
    }
    const row = await lockWorktree(tx, params);
    if (row.deletion_completed_at !== null) return deletionState(row);
    let manifest: CloudAgentWorktreeDeletionState['manifest'];
    if (row.deletion_started_at !== null) {
      manifest = cloudAgentWorktreeDeletionManifestSchema.parse(row.deletion_manifest);
    } else {
      await lockRoots(tx, params);
      manifest = cloudAgentWorktreeDeletionManifestSchema.parse({
        version: 1,
        sessions: await discoverMembers(tx, params),
      });
    }
    const runtimeLocations = locations(row);
    if (runtimeLocations.length === 0) {
      const cloudAgentSessionId = firstWorktreeSessionId(params.worktreeId);
      const allocations = await readSessionAllocations(tx, params.kiloUserId, [
        cloudAgentSessionId,
      ]);
      const source = manifest.sessions.find(
        session => session.cloudAgentSessionId === cloudAgentSessionId
      );
      const recovered = allocationLocation(allocations, {
        cloudAgentSessionId,
        sessionId: source?.sessionId ?? null,
        organizationId: params.organizationId ?? null,
      });
      if (recovered) runtimeLocations.push(recovered);
    }
    const [updated] = await tx
      .update(cloud_agent_worktrees)
      .set({
        deletion_started_at: row.deletion_started_at ?? new Date().toISOString(),
        deletion_manifest: manifest,
        runtime_locations: runtimeLocations,
      })
      .where(eq(cloud_agent_worktrees.worktree_id, params.worktreeId))
      .returning();
    if (!updated) throw new Error(WORKTREE_DELETING);
    return deletionState(updated);
  });
}

const childSnapshotSchema = z.object({
  id: containedKiloSessionIdSchema,
  parentID: containedKiloSessionIdSchema,
  directory: z.string(),
});

async function inferChildSessionLineage(
  env: Env,
  db: WorktreeDb,
  params: RecordCloudAgentWorktreeCleanupParams
): Promise<NonNullable<RecordCloudAgentWorktreeCleanupParams['childSessions']>> {
  if (!params.directory) return [];
  const [row] = await db
    .select()
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, params.worktreeId));
  const worktree = await authorize(db, row, params);
  if (worktree.deletion_started_at === null) throw new Error('worktree_deletion_not_started');
  const state = deletionState(worktree);
  if (state.completed) return [];
  const parents = new Map<string, `workspace_${string}`>(
    state.manifest.sessions.flatMap(session =>
      session.cloudAgentSessionId ? [[session.sessionId, session.cloudAgentSessionId] as const] : []
    )
  );
  const rootScopes = new Set<string>(parents.values());
  if (state.manifest.sessions.length > 0) {
    const owned = await db
      .select({
        sessionId: cli_sessions_v2.session_id,
        cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
        organizationId: cli_sessions_v2.organization_id,
        worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
          inArray(
            cli_sessions_v2.session_id,
            state.manifest.sessions.map(session => session.sessionId)
          )
        )
      );
    for (const session of owned) {
      if (
        session.organizationId === (params.organizationId ?? null) &&
        session.cloudAgentSessionScopeId &&
        rootScopes.has(session.cloudAgentSessionScopeId) &&
        (session.worktreeId === null || session.worktreeId === params.worktreeId)
      ) {
        const root = state.manifest.sessions.find(
          item => item.cloudAgentSessionId === session.cloudAgentSessionScopeId
        );
        if (root?.cloudAgentSessionId) parents.set(session.sessionId, root.cloudAgentSessionId);
      }
    }
  }
  let seeded = true;
  while (seeded) {
    seeded = false;
    for (const child of params.childSessions ?? []) {
      if (
        !parents.has(child.sessionId) &&
        parents.get(child.parentSessionId) === child.cloudAgentSessionId
      ) {
        parents.set(child.sessionId, child.cloudAgentSessionId);
        seeded = true;
      }
    }
  }
  const candidates = new Map<string, z.infer<typeof childSnapshotSchema>>();
  let cursor: string | undefined;
  while (true) {
    const page = await db
      .select({ sessionId: cli_sessions_v2.session_id })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
          params.organizationId
            ? eq(cli_sessions_v2.organization_id, params.organizationId)
            : isNull(cli_sessions_v2.organization_id),
          isNull(cli_sessions_v2.cloud_agent_session_id),
          isNull(cli_sessions_v2.cloud_agent_session_scope_id),
          isNull(cli_sessions_v2.cloud_agent_worktree_id),
          isNull(cli_sessions_v2.parent_session_id),
          gte(cli_sessions_v2.created_at, worktree.created_at),
          cursor ? gt(cli_sessions_v2.session_id, cursor) : undefined
        )
      )
      .orderBy(cli_sessions_v2.session_id)
      .limit(100);
    if (page.length === 0) break;
    for (const candidate of page) {
      const rawSnapshot = await withDORetry<ReturnType<typeof getSessionIngestDO>, unknown>(
        () =>
          getSessionIngestDO(env, {
            kiloUserId: params.kiloUserId,
            sessionId: candidate.sessionId,
          }),
        stub => stub.readKiloSdkSessionSnapshot(),
        'SessionIngestDO.readKiloSdkSessionSnapshot'
      );
      const outcome = kiloSdkSessionSnapshotOutcomeSchema.safeParse(rawSnapshot);
      if (!outcome.success) continue;
      const snapshot = outcome.data;
      if (snapshot.kind === 'retryable_failure')
        throw new Error('worktree_child_snapshot_unavailable');
      if (snapshot.kind !== 'value') continue;
      const parsed = childSnapshotSchema.safeParse(snapshot.info);
      if (
        parsed.success &&
        parsed.data.id === candidate.sessionId &&
        parsed.data.directory === params.directory &&
        parsed.data.parentID !== candidate.sessionId
      )
        candidates.set(candidate.sessionId, parsed.data);
    }
    cursor = page.at(-1)?.sessionId;
    if (page.length < 100) break;
  }
  const recovered: NonNullable<RecordCloudAgentWorktreeCleanupParams['childSessions']> = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const [id, candidate] of candidates) {
      const cloudAgentSessionId = parents.get(candidate.parentID);
      if (!cloudAgentSessionId) continue;
      recovered.push({ sessionId: id, parentSessionId: candidate.parentID, cloudAgentSessionId });
      parents.set(id, cloudAgentSessionId);
      candidates.delete(id);
      progress = true;
    }
  }
  return recovered;
}

async function recoverChildSessionLineage(
  db: WorktreeDb,
  params: RecordCloudAgentWorktreeCleanupParams,
  sessions: Map<string, CloudAgentWorktreeDeletionState['manifest']['sessions'][number]>,
  inferredSessionIds: ReadonlySet<string>
): Promise<void> {
  if (!params.childSessions?.length) return;
  const roots = new Map(
    [...sessions.values()].flatMap(session =>
      session.cloudAgentSessionId ? [[session.sessionId, session.cloudAgentSessionId] as const] : []
    )
  );
  const rootScopes = new Set<string>(roots.values());
  const pending = new Map<string, (typeof params.childSessions)[number]>();
  for (const child of params.childSessions) {
    const previous = pending.get(child.sessionId);
    if (
      roots.has(child.sessionId) ||
      child.sessionId === child.parentSessionId ||
      !rootScopes.has(child.cloudAgentSessionId) ||
      (previous &&
        (previous.parentSessionId !== child.parentSessionId ||
          previous.cloudAgentSessionId !== child.cloudAgentSessionId))
    )
      throw new Error('worktree_child_lineage_conflict');
    pending.set(child.sessionId, child);
  }
  const rows = await db
    .select({
      sessionId: cli_sessions_v2.session_id,
      cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
      cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
      organizationId: cli_sessions_v2.organization_id,
      parentSessionId: cli_sessions_v2.parent_session_id,
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
        inArray(cli_sessions_v2.session_id, [
          ...new Set([
            ...sessions.keys(),
            ...pending.keys(),
            ...params.childSessions.map(child => child.parentSessionId),
          ]),
        ])
      )
    )
    .orderBy(cli_sessions_v2.session_id)
    .for('update');
  const owned = new Map(rows.map(row => [row.sessionId, row]));
  const parents = new Map<string, string>(roots);
  for (const row of rows) {
    if (
      sessions.has(row.sessionId) &&
      row.organizationId === (params.organizationId ?? null) &&
      row.cloudAgentSessionScopeId &&
      rootScopes.has(row.cloudAgentSessionScopeId) &&
      (row.worktreeId === null || row.worktreeId === params.worktreeId)
    )
      parents.set(row.sessionId, row.cloudAgentSessionScopeId);
  }
  while (pending.size > 0) {
    let progress = false;
    for (const child of pending.values()) {
      const parentScope = parents.get(child.parentSessionId);
      if (!parentScope) continue;
      const row = owned.get(child.sessionId);
      if (
        parentScope !== child.cloudAgentSessionId ||
        (row &&
          (row.cloudAgentSessionId !== null ||
            (inferredSessionIds.has(child.sessionId) &&
              row.organizationId !== (params.organizationId ?? null)) ||
            (row.organizationId !== null &&
              row.organizationId !== (params.organizationId ?? null)) ||
            (row.cloudAgentSessionScopeId != null &&
              row.cloudAgentSessionScopeId !== parentScope) ||
            (row.worktreeId !== null && row.worktreeId !== params.worktreeId) ||
            (row.parentSessionId !== null &&
              row.parentSessionId !== child.parentSessionId &&
              row.cloudAgentSessionScopeId !== parentScope)))
      )
        throw new Error('worktree_child_lineage_conflict');
      if (row) {
        await db
          .update(cli_sessions_v2)
          .set({
            parent_session_id: row.parentSessionId ?? child.parentSessionId,
            cloud_agent_session_scope_id: parentScope,
            cloud_agent_worktree_id: params.worktreeId,
            organization_id: params.organizationId ?? null,
          })
          .where(
            and(
              eq(cli_sessions_v2.session_id, child.sessionId),
              eq(cli_sessions_v2.kilo_user_id, params.kiloUserId)
            )
          );
      }
      sessions.set(child.sessionId, { sessionId: child.sessionId, cloudAgentSessionId: null });
      parents.set(child.sessionId, parentScope);
      pending.delete(child.sessionId);
      progress = true;
    }
    if (!progress) throw new Error('worktree_child_lineage_conflict');
  }
}

export async function recordWorktreeCleanup(
  env: Env,
  params: RecordCloudAgentWorktreeCleanupParams
) {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const inferred = await inferChildSessionLineage(env, db, params);
  const childSessions = [...(params.childSessions ?? []), ...inferred];
  return db.transaction(async tx => {
    const row = await lockWorktree(tx, params);
    if (row.deletion_started_at === null) throw new Error('worktree_deletion_not_started');
    const state = deletionState(row);
    if (state.completed) return state;
    await lockRoots(tx, params);
    const sessions = new Map(state.manifest.sessions.map(session => [session.sessionId, session]));
    await recoverChildSessionLineage(
      tx,
      { ...params, childSessions },
      sessions,
      new Set(inferred.map(child => child.sessionId))
    );
    const discovered = await discoverMembers(tx, params);
    if (discovered.length > 0) {
      const ids = discovered.map(session => session.sessionId);
      const rootScopes = new Set<string>(
        [...sessions.values()].flatMap(session =>
          session.cloudAgentSessionId ? [session.cloudAgentSessionId] : []
        )
      );
      await tx
        .update(cli_sessions_v2)
        .set({ cloud_agent_worktree_id: params.worktreeId })
        .where(
          and(
            eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
            inArray(cli_sessions_v2.session_id, ids),
            isNull(cli_sessions_v2.cloud_agent_worktree_id),
            params.organizationId
              ? eq(cli_sessions_v2.organization_id, params.organizationId)
              : isNull(cli_sessions_v2.organization_id),
            or(
              isNull(cli_sessions_v2.cloud_agent_session_scope_id),
              inArray(cli_sessions_v2.cloud_agent_session_scope_id, [...rootScopes])
            )
          )
        );
      const fenced = await tx
        .select({
          organizationId: cli_sessions_v2.organization_id,
          worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
          cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
        })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
            inArray(cli_sessions_v2.session_id, ids)
          )
        )
        .orderBy(cli_sessions_v2.session_id)
        .for('update');
      if (
        fenced.some(
          session =>
            session.organizationId !== (params.organizationId ?? null) ||
            session.worktreeId !== params.worktreeId ||
            (session.cloudAgentSessionScopeId != null &&
              !rootScopes.has(session.cloudAgentSessionScopeId))
        )
      )
        throw new Error('worktree_child_lineage_conflict');
      for (const session of discovered) sessions.set(session.sessionId, session);
    }
    const extraIds = [...new Set(params.sessionIds ?? [])].filter(id => !sessions.has(id));
    if (extraIds.length > 0) {
      const existing = await tx
        .select({ sessionId: cli_sessions_v2.session_id })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
            inArray(cli_sessions_v2.session_id, extraIds)
          )
        );
      if (existing.length > 0) throw new Error('worktree_cleanup_session_conflict');
      for (const sessionId of extraIds)
        sessions.set(sessionId, { sessionId, cloudAgentSessionId: null });
    }
    const runtimeLocations = state.runtimeLocations;
    for (const location of params.runtimeLocations ?? []) {
      if (
        !runtimeLocations.some(
          item => item.sandboxId === location.sandboxId && item.provider === location.provider
        )
      ) {
        runtimeLocations.push(location);
      }
    }
    const manifest = {
      version: 1,
      sessions: [...sessions.values()],
    } satisfies typeof state.manifest;
    await tx
      .update(cloud_agent_worktrees)
      .set({ runtime_locations: runtimeLocations, deletion_manifest: manifest })
      .where(eq(cloud_agent_worktrees.worktree_id, params.worktreeId));
    return { completed: false, manifest, runtimeLocations };
  });
}

export async function canDestroyWorktreeSandbox(
  env: Env,
  params: CanDestroyCloudAgentWorktreeSandboxParams
): Promise<CanDestroyCloudAgentWorktreeSandboxResult> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const [row] = await db
    .select()
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, params.worktreeId));
  const worktree = await authorize(db, row, params);
  if (worktree.deletion_started_at === null) throw new Error('worktree_deletion_not_started');
  const targetIds = new Set(
    deletionState(worktree).manifest.sessions.map(session => session.sessionId)
  );
  const worktrees = await db
    .select()
    .from(cloud_agent_worktrees)
    .where(
      and(
        eq(cloud_agent_worktrees.kilo_user_id, params.kiloUserId),
        isNull(cloud_agent_worktrees.deletion_completed_at)
      )
    );
  const released = new Set(
    worktrees
      .filter(
        item =>
          item.deletion_started_at !== null &&
          params.releasedWorktreeIds?.includes(cloudAgentWorktreeIdSchema.parse(item.worktree_id))
      )
      .map(item => item.worktree_id)
  );
  const roots = await db
    .select({
      sessionId: cli_sessions_v2.session_id,
      cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      organizationId: cli_sessions_v2.organization_id,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
        isNull(cli_sessions_v2.parent_session_id),
        isNotNull(cli_sessions_v2.cloud_agent_session_id)
      )
    );
  const owners = new Map<
    string,
    { owner: UnresolvedCloudAgentSandboxOwner; locations: CloudAgentWorktreeLocation[] }
  >();
  for (const item of worktrees) {
    if (item.worktree_id === params.worktreeId || released.has(item.worktree_id)) continue;
    owners.set(item.worktree_id, {
      owner: {
        worktreeId: cloudAgentWorktreeIdSchema.parse(item.worktree_id),
        organizationId: item.organization_id,
        sessions: [],
      },
      locations: locations(item),
    });
  }
  for (const root of roots) {
    if (targetIds.has(root.sessionId) || (root.worktreeId && released.has(root.worktreeId)))
      continue;
    if (!root.cloudAgentSessionId) throw new Error(WORKTREE_RUNTIME_HISTORY_UNAVAILABLE);
    const key = root.worktreeId ?? root.cloudAgentSessionId;
    const existing = owners.get(key);
    if (existing && existing.owner.organizationId !== root.organizationId)
      throw new Error(WORKTREE_RUNTIME_HISTORY_UNAVAILABLE);
    const candidate = existing ?? {
      owner: {
        worktreeId: root.worktreeId ? cloudAgentWorktreeIdSchema.parse(root.worktreeId) : null,
        organizationId: root.organizationId,
        sessions: [],
      } satisfies UnresolvedCloudAgentSandboxOwner,
      locations: [],
    };
    candidate.owner.sessions.push({
      sessionId: root.sessionId,
      cloudAgentSessionId: root.cloudAgentSessionId,
    });
    owners.set(key, candidate);
  }
  const matches = (location: CloudAgentWorktreeLocation) =>
    location.sandboxId === params.location.sandboxId &&
    location.provider === params.location.provider;
  if ([...owners.values()].some(candidate => candidate.locations.some(matches)))
    return { kind: 'shared' };
  const unknown = [...owners.values()]
    .filter(candidate => candidate.locations.length === 0)
    .map(candidate => candidate.owner);
  const allocations = await readSessionAllocations(
    db,
    params.kiloUserId,
    unknown.flatMap(owner =>
      owner.worktreeId
        ? [firstWorktreeSessionId(owner.worktreeId)]
        : owner.sessions.map(session => session.cloudAgentSessionId)
    )
  );
  const unresolved: UnresolvedCloudAgentSandboxOwner[] = [];
  for (const owner of unknown) {
    const sourceId = owner.worktreeId
      ? firstWorktreeSessionId(owner.worktreeId)
      : owner.sessions[0]?.cloudAgentSessionId;
    if (!sourceId) throw new Error(WORKTREE_RUNTIME_HISTORY_UNAVAILABLE);
    const source = owner.sessions.find(session => session.cloudAgentSessionId === sourceId);
    const location = allocationLocation(allocations, {
      cloudAgentSessionId: sourceId,
      sessionId: source?.sessionId ?? null,
      organizationId: owner.organizationId,
    });
    if (location && owner.worktreeId !== null) {
      if (matches(location)) return { kind: 'shared' };
      continue;
    }
    if (location) owner.allocationLocation = location;
    if (owner.sessions.length === 0)
      owner.sessions.push({ sessionId: null, cloudAgentSessionId: sourceId });
    unresolved.push(owner);
  }
  return unresolved.length > 0 ? { kind: 'unresolved', owners: unresolved } : { kind: 'exclusive' };
}

export async function completeWorktreeDeletion(
  env: Env,
  params: CloudAgentWorktreeDeletionParams,
  executionContext?: ExecutionContext
): Promise<{ success: true; deletedSessionIds: string[] }> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const [row] = await db
    .select()
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, params.worktreeId));
  const worktree = await authorize(db, row, params);
  if (worktree.deletion_started_at === null) throw new Error('worktree_deletion_not_started');
  const state = deletionState(worktree);
  const sessionIds = state.manifest.sessions.map(session => session.sessionId);
  if (state.completed) return { success: true, deletedSessionIds: sessionIds };
  for (const sessionId of sessionIds) {
    await withDORetry(
      () => getSessionIngestDO(env, { kiloUserId: params.kiloUserId, sessionId }),
      stub => stub.clearForWorktree(params.kiloUserId, sessionId),
      'SessionIngestDO.clearForWorktree'
    );
    await withDORetry(
      () => getSessionAccessCacheDO(env, { kiloUserId: params.kiloUserId }),
      stub => stub.deleteSession(sessionId),
      'SessionAccessCacheDO.deleteSession'
    );
    await withDORetry(
      () => getUserConnectionDO(env, { kiloUserId: params.kiloUserId }),
      stub => stub.clearSession(sessionId),
      'UserConnectionDO.clearSession'
    );
  }
  const { deletedSessionIds, deletedSessions } = await db.transaction(async tx => {
    const current = await lockWorktree(tx, params);
    if (current.deletion_completed_at !== null)
      return { deletedSessionIds: current.deleted_session_ids, deletedSessions: [] };
    const currentIds = deletionState(current).manifest.sessions.map(session => session.sessionId);
    const cleaned = new Set(sessionIds);
    if (currentIds.some(id => !cleaned.has(id)))
      throw new Error('worktree_cleanup_manifest_changed');
    await lockRoots(tx, params);
    if ((await discoverMembers(tx, params)).some(session => !cleaned.has(session.sessionId))) {
      throw new Error('worktree_cleanup_manifest_changed');
    }
    const deletedSessions =
      sessionIds.length > 0
        ? await tx
            .delete(cli_sessions_v2)
            .where(
              and(
                eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
                inArray(cli_sessions_v2.session_id, sessionIds)
              )
            )
            .returning({
              sessionId: cli_sessions_v2.session_id,
              parentSessionId: cli_sessions_v2.parent_session_id,
              organizationId: cli_sessions_v2.organization_id,
              gitUrl: cli_sessions_v2.git_url,
              gitBranch: cli_sessions_v2.git_branch,
              createdOnPlatform: cli_sessions_v2.created_on_platform,
            })
        : [];
    await tx
      .update(cloud_agent_worktrees)
      .set({
        name: null,
        runtime_locations: [],
        deletion_manifest: null,
        deletion_completed_at: new Date().toISOString(),
        deleted_session_ids: sessionIds,
      })
      .where(eq(cloud_agent_worktrees.worktree_id, params.worktreeId));
    return { deletedSessionIds: sessionIds, deletedSessions };
  });
  const deletedAt = new Date().toISOString();
  for (const session of deletedSessions) {
    notifyUserSessionEvent(
      env,
      params.kiloUserId,
      { type: 'session.deleted', data: { source: 'v2', ...session, deletedAt } },
      executionContext
    );
  }
  return { success: true, deletedSessionIds };
}
