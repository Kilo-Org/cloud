import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import type { Env } from '../../types.js';
import type {
  ControlPlaneCredentialSource,
  ControlPlaneRouteSpec,
} from '../../shared/control-plane-protocol.js';
import type { ProviderAdapter } from '../../sandbox-control/provider.js';
import { logControlDiagnostic } from '../../sandbox-control/diagnostics.js';
import { SandboxWorkspaceSnapshotSchema } from '../../shared/sandbox-status.js';
import type { AllocationState } from './allocation.js';
import type { RouteDatabase, RouteRecord } from './routes.js';
import { workspaceDiskAllocation, workspaceDiskSnapshots } from './sqlite-schema.js';

export const WORKSPACE_SNAPSHOT_IDLE_MS = 60_000;
/** A captured workspace is restorable for 30 days. After that the descriptor is kept but unusable. */
export const WORKSPACE_SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const workspaceSnapshotIdentitySchema = z.object({
  sandboxId: z.string().min(1),
  workspaceId: cloudAgentWorktreeIdSchema,
  directory: z.string().min(1),
  userId: z.string().min(1),
  orgId: z.string().optional(),
});
const descriptorSchema = workspaceSnapshotIdentitySchema.extend({
  sourceAllocationId: z.string().min(1),
  snapshotId: z.string().min(1),
  baseImage: z.string().min(1),
  runtimeIdentity: z.string().min(1),
  capturedAt: SandboxWorkspaceSnapshotSchema.shape.capturedAt,
});
const allocationSchema = z.object({
  allocationId: z.string().min(1),
  runtimeIdentity: z.string().min(1),
  owner: workspaceSnapshotIdentitySchema,
  invalidationGeneration: z.number().int().nonnegative().default(0),
  idleConnectionId: z.string().optional(),
  attemptedIdleAt: z.number().optional(),
  lastMutationAt: z.number().nonnegative().default(0),
  restore: z.object({ sourceAllocationId: z.string().min(1), confirmed: z.boolean() }).optional(),
  /**
   * The most recent tail startup this allocation failed, so the recovery query
   * can offer "Start fresh" only on that failure. A new preparation allocates a
   * fresh record and clears it.
   */
  recovery: z
    .object({
      allocationId: z.string().min(1),
      reason: z.string().min(1),
      failedAt: z.number().nonnegative(),
    })
    .optional(),
});
const runtimeIdentitySchema = z.object({
  mode: z.enum(['preinstalled', 'downloaded']),
  image: z.enum(['all-in-one', 'runtime-free']),
});
export type WorkspaceSnapshotDescriptor = z.infer<typeof descriptorSchema>;
export type WorkspaceSnapshotIdentity = z.infer<typeof workspaceSnapshotIdentitySchema>;
export type WorkspaceSnapshotAllocation = z.infer<typeof allocationSchema>;
export type WorkspaceSnapshotSelectionReason =
  | 'missing'
  | 'invalid_descriptor'
  | 'ownership_mismatch'
  | 'runtime_mismatch'
  | 'expired'
  | 'image_unavailable'
  | 'image_mismatch'
  | 'selected';
export type WorkspaceSnapshotSelection =
  | { kind: 'selected'; descriptor: WorkspaceSnapshotDescriptor }
  | { kind: 'missing' }
  | {
      kind: 'unusable';
      reason: Exclude<WorkspaceSnapshotSelectionReason, 'missing' | 'selected'>;
    };

export function workspaceSnapshotIdentity(
  sandboxId: string,
  directory: string,
  source: Pick<ControlPlaneCredentialSource, 'userId' | 'orgId' | 'workspaceId' | 'scopeId'>
): WorkspaceSnapshotIdentity | null {
  if (source.workspaceId === undefined || source.scopeId !== source.workspaceId) return null;
  return {
    sandboxId,
    directory,
    workspaceId: source.workspaceId,
    userId: source.userId,
    orgId: source.orgId,
  };
}

export function sameWorkspaceSnapshotIdentity(
  left: WorkspaceSnapshotIdentity,
  right: WorkspaceSnapshotIdentity | null
): boolean {
  return (
    right !== null &&
    (['sandboxId', 'workspaceId', 'directory', 'userId', 'orgId'] as const).every(
      key => left[key] === right[key]
    )
  );
}

export function workspaceSnapshotsEnabled(
  env: Pick<Env, 'WORKSPACE_SNAPSHOT_USER_IDS' | 'WORKSPACE_SNAPSHOT_ORG_IDS'>,
  source: Pick<ControlPlaneCredentialSource, 'userId' | 'orgId'>
): boolean {
  const includes = (raw: string | undefined, id: string | undefined) =>
    id !== undefined &&
    id !== '*' &&
    (raw ?? '')
      .split(',')
      .map(value => value.trim())
      .includes(id);
  return (
    includes(env.WORKSPACE_SNAPSHOT_USER_IDS, source.userId) ||
    includes(env.WORKSPACE_SNAPSHOT_ORG_IDS, source.orgId)
  );
}

export function readWorkspaceSnapshotAllocation(
  db: RouteDatabase
): WorkspaceSnapshotAllocation | undefined {
  const parsed = allocationSchema.safeParse(db.select().from(workspaceDiskAllocation).get()?.data);
  return parsed.success ? parsed.data : undefined;
}

export function writeWorkspaceSnapshotAllocation(db: RouteDatabase, value: unknown): void {
  const data = allocationSchema.parse(value);
  db.insert(workspaceDiskAllocation)
    .values({ id: 'current', data })
    .onConflictDoUpdate({ target: workspaceDiskAllocation.id, set: { data } })
    .run();
}

export function clearWorkspaceSnapshotAllocation(db: RouteDatabase): void {
  db.delete(workspaceDiskAllocation).where(eq(workspaceDiskAllocation.id, 'current')).run();
}

export function readWorkspaceSnapshot(db: RouteDatabase, workspaceId: string) {
  const parsed = descriptorSchema.safeParse(
    db
      .select()
      .from(workspaceDiskSnapshots)
      .where(eq(workspaceDiskSnapshots.workspace_id, workspaceId))
      .get()?.data
  );
  return parsed.success ? parsed.data : null;
}

/**
 * The stored descriptor payload without validation, so a malformed descriptor is
 * still distinguishable from an absent one. A malformed descriptor is retained
 * and fails selection; it never silently falls through to another startup source.
 */
export function readWorkspaceSnapshotRaw(db: RouteDatabase, workspaceId: string): unknown {
  return db
    .select()
    .from(workspaceDiskSnapshots)
    .where(eq(workspaceDiskSnapshots.workspace_id, workspaceId))
    .get()?.data;
}

export function workspaceSnapshotStatus(
  db: RouteDatabase,
  identity: WorkspaceSnapshotIdentity | null
): { workspaceSnapshot?: { capturedAt: number } } {
  if (identity === null) return {};
  const descriptor = readWorkspaceSnapshot(db, identity.workspaceId);
  return descriptor !== null && sameWorkspaceSnapshotIdentity(descriptor, identity)
    ? { workspaceSnapshot: { capturedAt: descriptor.capturedAt } }
    : {};
}

export function deleteWorkspaceSnapshot(
  db: RouteDatabase,
  workspaceId?: string,
  reason = 'invalidated',
  sessionId?: string
): boolean {
  const disk = readWorkspaceSnapshotAllocation(db);
  const currentWorkspaceId = workspaceId ?? disk?.owner.workspaceId;
  if (currentWorkspaceId === undefined) return false;
  const descriptor = readWorkspaceSnapshot(db, currentWorkspaceId);
  db.delete(workspaceDiskSnapshots)
    .where(eq(workspaceDiskSnapshots.workspace_id, currentWorkspaceId))
    .run();
  if (descriptor !== null)
    logControlDiagnostic('workspace_snapshot_descriptor_removed', {
      sandboxId: descriptor.sandboxId,
      workspaceId: currentWorkspaceId,
      sessionId,
      allocationId: disk?.allocationId,
      sourceAllocationId: descriptor.sourceAllocationId,
      reason,
    });
  return descriptor !== null;
}

function runtimeIdentitySummary(raw: string) {
  try {
    return runtimeIdentitySchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function compatibleRuntimeIdentity(captured: string, selected: string): boolean {
  const left = runtimeIdentitySummary(captured);
  const right = runtimeIdentitySummary(selected);
  return left !== null && right !== null && left.mode === right.mode && left.image === right.image;
}

/**
 * Select the owner's workspace tail. A descriptor that exists but cannot be used
 * is reported as `unusable` with its reason; the caller must fail the start and
 * keep the descriptor instead of falling through to another startup source.
 */
export function selectWorkspaceSnapshotResult(
  db: RouteDatabase,
  identity: WorkspaceSnapshotIdentity,
  runtimeIdentity: string,
  baseImage: string | null,
  sessionId?: string
): WorkspaceSnapshotSelection {
  const raw = readWorkspaceSnapshotRaw(db, identity.workspaceId);
  const parsed = descriptorSchema.safeParse(raw);
  const descriptor = parsed.success ? parsed.data : null;
  const expectedRuntime = runtimeIdentitySummary(runtimeIdentity);
  const capturedRuntime =
    descriptor === null ? null : runtimeIdentitySummary(descriptor.runtimeIdentity);
  const reason: WorkspaceSnapshotSelectionReason =
    descriptor === null
      ? raw === undefined
        ? 'missing'
        : 'invalid_descriptor'
      : !sameWorkspaceSnapshotIdentity(descriptor, identity)
        ? 'ownership_mismatch'
        : !compatibleRuntimeIdentity(descriptor.runtimeIdentity, runtimeIdentity)
          ? 'runtime_mismatch'
          : descriptor.capturedAt < Date.now() - WORKSPACE_SNAPSHOT_TTL_MS
            ? 'expired'
            : baseImage === null
              ? 'image_unavailable'
              : descriptor.baseImage !== baseImage
                ? 'image_mismatch'
                : 'selected';
  logControlDiagnostic('workspace_snapshot_selection', {
    sandboxId: identity.sandboxId,
    workspaceId: identity.workspaceId,
    capturedWorkspaceId: descriptor?.workspaceId,
    capturedSandboxId: descriptor?.sandboxId,
    sessionId,
    allocationId: descriptor?.sourceAllocationId,
    sourceAllocationId: descriptor?.sourceAllocationId,
    capturedAt: descriptor?.capturedAt,
    source: reason === 'selected' ? 'workspace_tail' : 'fallback',
    identityMatch:
      descriptor === null ? undefined : sameWorkspaceSnapshotIdentity(descriptor, identity),
    runtimeMatch:
      descriptor === null
        ? undefined
        : compatibleRuntimeIdentity(descriptor.runtimeIdentity, runtimeIdentity),
    expectedMode: expectedRuntime?.mode,
    expectedImage: expectedRuntime?.image,
    capturedMode: capturedRuntime?.mode,
    capturedImage: capturedRuntime?.image,
    reason,
  });
  if (reason === 'selected') {
    return descriptor === null ? { kind: 'missing' } : { kind: 'selected', descriptor };
  }
  if (reason === 'missing') return { kind: 'missing' };
  return { kind: 'unusable', reason };
}

export function selectWorkspaceSnapshot(
  db: RouteDatabase,
  identity: WorkspaceSnapshotIdentity,
  runtimeIdentity: string,
  baseImage: string | null,
  sessionId?: string
): WorkspaceSnapshotDescriptor | null {
  const selection = selectWorkspaceSnapshotResult(
    db,
    identity,
    runtimeIdentity,
    baseImage,
    sessionId
  );
  return selection.kind === 'selected' ? selection.descriptor : null;
}

export function snapshotRestorePending(db: RouteDatabase, allocationId: string | null): boolean {
  const disk = readWorkspaceSnapshotAllocation(db);
  return disk?.allocationId === allocationId && disk.restore?.confirmed === false;
}

export function workspaceSnapshotFrame(
  db: RouteDatabase,
  route: RouteRecord,
  attachment: { allocationId?: string; workspaceSnapshots?: true } | null
): Pick<ControlPlaneRouteSpec, 'workspaceSnapshot'> {
  const disk = readWorkspaceSnapshotAllocation(db);
  if (disk?.allocationId !== attachment?.allocationId || disk?.restore === undefined) return {};
  if (
    !disk.restore.confirmed ||
    attachment?.workspaceSnapshots !== true ||
    route.credentialSource === null ||
    !sameWorkspaceSnapshotIdentity(
      disk.owner,
      workspaceSnapshotIdentity(disk.owner.sandboxId, route.spec.directory, route.credentialSource)
    )
  )
    throw new Error('Workspace snapshot provenance mismatch');
  return {
    workspaceSnapshot: {
      workspaceId: disk.owner.workspaceId,
      directory: disk.owner.directory,
      sourceAllocationId: disk.restore.sourceAllocationId,
    },
  };
}

/**
 * Fence an outstanding capture attempt without removing the descriptor. Admitted
 * work only prevents a capture that overlapped it from being published; it never
 * discards the last consistent snapshot. The descriptor is removed only by
 * workspace deletion, an explicit user "Start fresh", or a newer capture.
 */
export function fenceWorkspaceSnapshot(
  db: RouteDatabase,
  reason = 'mutation',
  sessionId?: string
): void {
  const disk = readWorkspaceSnapshotAllocation(db);
  if (!disk) return;
  const generation = disk.invalidationGeneration + 1;
  writeWorkspaceSnapshotAllocation(db, {
    ...disk,
    invalidationGeneration: generation,
    idleConnectionId: undefined,
    attemptedIdleAt: undefined,
    lastMutationAt: Date.now(),
  });
  logControlDiagnostic('workspace_snapshot_fenced', {
    sandboxId: disk.owner.sandboxId,
    workspaceId: disk.owner.workspaceId,
    sessionId,
    allocationId: disk.allocationId,
    reason,
    previousGeneration: disk.invalidationGeneration,
    generation,
  });
}

/**
 * Routes that still serve this sandbox. A `failed` route row persists until its
 * session releases, but the session cannot use the disk, so it must not block
 * capture or restore for the sessions that can.
 */
export function liveWorkspaceRoutes(routes: RouteRecord[]): RouteRecord[] {
  return routes.filter(route => route.state !== 'failed');
}

/** Whether every live route may use the workspace tail. One owner for every gate. */
export function workspaceSnapshotRoutesEligible(
  routes: RouteRecord[],
  eligible: (route: RouteRecord) => boolean
): boolean {
  return liveWorkspaceRoutes(routes).every(route => eligible(route));
}

/** The workspace a launch for these routes restores: the first live route's identity. */
export function workspaceSnapshotOwner(
  sandboxId: string,
  routes: RouteRecord[]
): WorkspaceSnapshotIdentity | null {
  const route = liveWorkspaceRoutes(routes).find(candidate => candidate.credentialSource !== null);
  if (route === undefined || route.credentialSource === null) return null;
  return workspaceSnapshotIdentity(sandboxId, route.spec.directory, route.credentialSource);
}

/**
 * Why a launch for these routes cannot restore the owner's tail, or undefined
 * when it can. The launch deadline and the restore selection share this rule.
 */
export function workspaceSnapshotRestoreSkip(
  db: RouteDatabase,
  owner: WorkspaceSnapshotIdentity,
  routes: RouteRecord[],
  eligible: (route: RouteRecord) => boolean
): string | undefined {
  const live = liveWorkspaceRoutes(routes);
  if (live.length === 0) return 'no_routes';
  if (!workspaceSnapshotRoutesEligible(routes, eligible)) return 'route_ineligible';
  if (!live.some(route => route.state === 'preparing')) return 'route_not_preparing';
  if (readWorkspaceSnapshot(db, owner.workspaceId) === null) return 'missing_descriptor';
  return undefined;
}

export function workspaceSnapshotIdleAt(
  state: AllocationState,
  disk: WorkspaceSnapshotAllocation
): number {
  return Math.max(state.lastActivityAt ?? 0, disk.lastMutationAt);
}

type CaptureContext = { state: AllocationState; routes: RouteRecord[]; capable: boolean };
export async function captureIdleWorkspaceSnapshot(input: {
  db: RouteDatabase;
  sandboxId: string;
  provider: NonNullable<ProviderAdapter['workspaceSnapshots']>;
  idleMs: number;
  read(): Promise<CaptureContext>;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  eligible(route: RouteRecord): boolean;
  stored(): Promise<void>;
}): Promise<void> {
  const logCapture = (
    phase: string,
    fields: Record<string, string | number | boolean | null | undefined>
  ) =>
    logControlDiagnostic(
      'workspace_snapshot_capture',
      {
        sandboxId: input.sandboxId,
        phase,
        ...fields,
      },
      'info',
      phase === 'skipped'
        ? { coalesceIdentity: `workspace_snapshot_capture_skip:${input.sandboxId}` }
        : undefined
    );
  const candidate = async () => {
    const { state, routes, capable } = await input.read();
    const live = liveWorkspaceRoutes(routes);
    const disk = readWorkspaceSnapshotAllocation(input.db);
    const reject = (reason: string) => ({
      ok: false as const,
      reason,
      state,
      disk,
      routes,
      live,
    });
    if (state.kind !== 'connected') return reject('not_connected');
    if (state.providerRef === null) return reject('no_provider_ref');
    if (state.connectionId === null) return reject('no_connection');
    if (state.lastActivityAt === null) return reject('no_activity');
    if (disk === undefined) return reject('untracked');
    if (disk.allocationId !== state.allocationId) return reject('allocation_mismatch');
    if (disk.idleConnectionId !== state.connectionId) return reject('idle_connection_mismatch');
    if (Date.now() < workspaceSnapshotIdleAt(state, disk) + input.idleMs) return reject('not_idle');
    if (!capable) return reject('not_capable');
    if (live.length === 0) return reject('no_routes');
    if (live.some(route => route.state !== 'ready')) return reject('route_not_ready');
    if (!workspaceSnapshotRoutesEligible(routes, route => input.eligible(route)))
      return reject('route_ineligible');
    return { ok: true as const, state, disk, routes, live, providerRef: state.providerRef };
  };
  const fence = await input.enqueue(async () => {
    const current = await candidate();
    const reason = !current.ok
      ? current.reason
      : current.disk.attemptedIdleAt === workspaceSnapshotIdleAt(current.state, current.disk)
        ? 'already_attempted'
        : undefined;
    if (!current.ok || reason !== undefined) {
      logCapture('skipped', {
        allocationId: current.state.allocationId,
        workspaceId: current.disk?.owner.workspaceId,
        reason,
      });
      return null;
    }
    writeWorkspaceSnapshotAllocation(input.db, {
      ...current.disk,
      attemptedIdleAt: workspaceSnapshotIdleAt(current.state, current.disk),
    });
    return current;
  });
  if (fence === null) return;
  logCapture('started', {
    allocationId: fence.state.allocationId,
    connectionId: fence.state.connectionId,
    workspaceId: fence.disk.owner.workspaceId,
    sessionId: fence.live[0]?.sessionId,
  });
  const result = await input.provider.capture(fence.providerRef, crypto.randomUUID());
  logCapture('provider_result', {
    status: result.status,
    reason: result.status === 'failed' ? result.reason : undefined,
    allocationId: fence.state.allocationId,
    workspaceId: fence.disk.owner.workspaceId,
  });
  if (result.status !== 'stored') return;
  await input.enqueue(async () => {
    const current = await candidate();
    const reason = !current.ok
      ? current.reason
      : current.state.allocationId !== fence.state.allocationId
        ? 'allocation_changed'
        : current.state.connectionId !== fence.state.connectionId
          ? 'connection_changed'
          : current.state.lastActivityAt !== fence.state.lastActivityAt
            ? 'activity_changed'
            : current.disk.invalidationGeneration !== fence.disk.invalidationGeneration
              ? 'workspace_mutated'
              : current.routes.length !== fence.routes.length ||
                  current.routes.some(
                    route =>
                      !fence.routes.some(
                        previous =>
                          previous.sessionId === route.sessionId &&
                          previous.attemptId === route.attemptId
                      )
                  )
                ? 'preparation_or_membership_changed'
                : undefined;
    if (reason !== undefined) {
      logControlDiagnostic('workspace_snapshot_capture_skipped', {
        sandboxId: input.sandboxId,
        workspaceId: fence.disk.owner.workspaceId,
        allocationId: fence.state.allocationId,
        reason,
        expectedAllocationId: fence.state.allocationId,
        currentAllocationId: current.state.allocationId,
        expectedConnectionId: fence.state.connectionId,
        currentConnectionId: current.state.connectionId,
        expectedActivityAt: fence.state.lastActivityAt,
        currentActivityAt: current.state.lastActivityAt,
        expectedGeneration: fence.disk.invalidationGeneration,
        currentGeneration: current.disk?.invalidationGeneration,
      });
      return;
    }
    const data = descriptorSchema.parse({
      ...fence.disk.owner,
      sourceAllocationId: fence.state.allocationId,
      runtimeIdentity: fence.disk.runtimeIdentity,
      snapshotId: result.snapshotId,
      baseImage: result.baseImage,
      capturedAt: result.capturedAt,
    });
    input.db
      .insert(workspaceDiskSnapshots)
      .values({ workspace_id: data.workspaceId, data })
      .onConflictDoUpdate({ target: workspaceDiskSnapshots.workspace_id, set: { data } })
      .run();
    // A recovery offer names the descriptor that failed; a newer one replaces it,
    // so a pending "Start fresh" can never discard this capture.
    if (current.disk?.recovery !== undefined)
      writeWorkspaceSnapshotAllocation(input.db, { ...current.disk, recovery: undefined });
    await input.stored();
    logControlDiagnostic('workspace_snapshot_captured', {
      sandboxId: input.sandboxId,
      workspaceId: data.workspaceId,
      allocationId: data.sourceAllocationId,
      capturedAt: data.capturedAt,
      sessionId: fence.live[0]?.sessionId,
    });
  });
}
