import { z } from 'zod';
import type { Env } from '../../types.js';
import type {
  ControlPlaneCredentialSource,
  ControlPlaneRouteSpec,
} from '../../shared/control-plane-protocol.js';
import { logControlDiagnostic } from '../../sandbox-control/diagnostics.js';
import type { ProviderAdapter } from '../../sandbox-control/provider.js';
import type { ControlDiagnosticFields } from '../../sandbox-control/diagnostics.js';
import type { AllocationState } from './allocation.js';
import type { RouteRecord } from './routes.js';

export const SESSION_SNAPSHOT_IDLE_MS = 2 * 60_000;
export const SESSION_SNAPSHOT_KEY = 'session_disk_snapshot:v1';
export const SESSION_SNAPSHOT_ALLOCATION_KEY = 'session_disk_allocation:v1';
const identitySchema = z.object({
  sandboxId: z.string().min(1),
  sessionId: z.string().min(1),
  kiloSessionId: z.string().min(1),
  userId: z.string().min(1),
  orgId: z.string().optional(),
});
const descriptorSchema = identitySchema.extend({
  sourceAllocationId: z.string().min(1),
  snapshotId: z.string().min(1),
  baseImage: z.string().min(1),
  runtimeIdentity: z.string().min(1),
  capturedAt: z.number().nonnegative(),
});
const allocationSchema = z.object({
  allocationId: z.string().min(1),
  runtimeIdentity: z.string().min(1),
  owner: identitySchema,
  contaminated: z.boolean(),
  invalidationGeneration: z.number().int().nonnegative().default(0),
  idleConnectionId: z.string().optional(),
  attemptedIdleAt: z.number().optional(),
  restore: z.object({ sourceAllocationId: z.string().min(1), confirmed: z.boolean() }).optional(),
});
const runtimeIdentitySchema = z.object({
  mode: z.enum(['preinstalled', 'downloaded']),
  image: z.enum(['all-in-one', 'runtime-free']),
});
type Storage = DurableObjectStorage['kv'];
type Identity = z.infer<typeof identitySchema>;

export function sessionSnapshotIdentity(
  sandboxId: string,
  sessionId: string,
  kiloSessionId: string,
  source: Pick<ControlPlaneCredentialSource, 'userId' | 'orgId'>
): Identity {
  return { sandboxId, sessionId, kiloSessionId, userId: source.userId, orgId: source.orgId };
}

export function sameSessionSnapshotIdentity(left: Identity, right: Identity): boolean {
  return (['sandboxId', 'sessionId', 'kiloSessionId', 'userId', 'orgId'] as const).every(
    key => left[key] === right[key]
  );
}

export function sessionSnapshotsEnabled(
  env: Pick<Env, 'SESSION_SNAPSHOT_USER_IDS' | 'SESSION_SNAPSHOT_ORG_IDS'>,
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
    includes(env.SESSION_SNAPSHOT_USER_IDS, source.userId) ||
    includes(env.SESSION_SNAPSHOT_ORG_IDS, source.orgId)
  );
}

export function readSessionSnapshotAllocation(storage: Storage) {
  const parsed = allocationSchema.safeParse(storage.get(SESSION_SNAPSHOT_ALLOCATION_KEY));
  return parsed.success ? parsed.data : undefined;
}

function parseRuntimeIdentity(raw: string): { mode: string; image: string } | null {
  try {
    const parsed = runtimeIdentitySchema.parse(JSON.parse(raw));
    return { mode: parsed.mode, image: parsed.image };
  } catch {
    return null;
  }
}

function compatibleRuntimeIdentity(captured: string, selected: string): boolean {
  const left = parseRuntimeIdentity(captured);
  const right = parseRuntimeIdentity(selected);
  return left !== null && right !== null && left.mode === right.mode && left.image === right.image;
}

export function selectSessionSnapshot(
  storage: Storage,
  identity: Identity,
  runtimeIdentity: string,
  diagnose = false
) {
  const log = (fields: ControlDiagnosticFields) => {
    if (diagnose) logControlDiagnostic('session_snapshot_lookup', fields);
  };
  const stored = storage.get(SESSION_SNAPSHOT_KEY);
  const parsed = descriptorSchema.safeParse(stored);
  if (!parsed.success) {
    log({
      reason: stored === undefined ? 'no_snapshot' : 'invalid_descriptor',
      sandboxId: identity.sandboxId,
      sessionId: identity.sessionId,
    });
    return null;
  }
  const identityMatch = sameSessionSnapshotIdentity(parsed.data, identity);
  const runtimeMatch = identityMatch
    ? compatibleRuntimeIdentity(parsed.data.runtimeIdentity, runtimeIdentity)
    : undefined;
  const reason = !identityMatch
    ? 'identity_mismatch'
    : runtimeMatch === false
      ? 'runtime_mismatch'
      : 'selected';
  if (diagnose) {
    const expectedRuntime = parseRuntimeIdentity(runtimeIdentity);
    const capturedRuntime = parseRuntimeIdentity(parsed.data.runtimeIdentity);
    log({
      reason,
      sandboxId: identity.sandboxId,
      sessionId: identity.sessionId,
      capturedSandboxId: parsed.data.sandboxId,
      capturedSessionId: parsed.data.sessionId,
      sourceAllocationId: parsed.data.sourceAllocationId,
      identityMatch,
      runtimeMatch,
      expectedMode: expectedRuntime?.mode,
      expectedImage: expectedRuntime?.image,
      capturedMode: capturedRuntime?.mode,
      capturedImage: capturedRuntime?.image,
    });
  }
  return identityMatch && runtimeMatch === true ? parsed.data : null;
}

export function snapshotRestorePending(storage: Storage, allocationId: string | null): boolean {
  const disk = readSessionSnapshotAllocation(storage);
  return disk?.allocationId === allocationId && disk.restore?.confirmed === false;
}

export function sessionSnapshotFrame(
  storage: Storage,
  route: RouteRecord,
  attachment: { allocationId?: string; sessionSnapshots?: true } | null
): Pick<ControlPlaneRouteSpec, 'sessionSnapshot'> {
  const disk = readSessionSnapshotAllocation(storage);
  if (disk?.allocationId !== attachment?.allocationId || disk?.restore === undefined) return {};
  if (
    !disk.restore.confirmed ||
    attachment?.sessionSnapshots !== true ||
    route.credentialSource === null ||
    !sameSessionSnapshotIdentity(
      disk.owner,
      sessionSnapshotIdentity(
        disk.owner.sandboxId,
        route.sessionId,
        route.spec.kiloSessionId,
        route.credentialSource
      )
    )
  )
    throw new Error('Session snapshot provenance mismatch');
  return { sessionSnapshot: { sourceAllocationId: disk.restore.sourceAllocationId } };
}

type CaptureContext = { state: AllocationState; routes: RouteRecord[]; capable: boolean };
type SnapshotAllocation = NonNullable<ReturnType<typeof readSessionSnapshotAllocation>>;
type CaptureAttempt =
  | {
      ok: true;
      state: AllocationState;
      disk: SnapshotAllocation;
      route: RouteRecord;
      providerRef: string;
    }
  | {
      ok: false;
      reason: string;
      state: AllocationState;
      disk: SnapshotAllocation | undefined;
      route: RouteRecord | undefined;
    };

export async function captureIdleSessionSnapshot(input: {
  storage: Storage;
  sandboxId: string;
  provider: NonNullable<ProviderAdapter['sessionSnapshots']>;
  idleMs: number;
  read(): Promise<CaptureContext>;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  eligible(route: RouteRecord): boolean;
}): Promise<void> {
  const logCapture = (
    phase: 'skipped' | 'started' | 'provider_result' | 'discarded' | 'stored',
    fields: Record<string, string | number | boolean | null | undefined>,
    coalesceIdentity?: string
  ) =>
    logControlDiagnostic(
      'session_snapshot_capture',
      { sandboxId: input.sandboxId, phase, ...fields },
      'info',
      coalesceIdentity === undefined ? undefined : { coalesceIdentity }
    );
  const candidate = async (attempt = false): Promise<CaptureAttempt> => {
    const { state, routes, capable } = await input.read();
    const disk = readSessionSnapshotAllocation(input.storage);
    const route = routes[0];
    const reject = (reason: string): CaptureAttempt => {
      if (attempt)
        logCapture(
          'skipped',
          {
            reason,
            allocationId: state.allocationId,
            connectionId: state.connectionId,
            sessionId: route?.sessionId ?? disk?.owner.sessionId,
          },
          `session_snapshot_skip:${input.sandboxId}`
        );
      return { ok: false, reason, state, disk, route };
    };
    if (state.kind !== 'connected') return reject('not_connected');
    if (state.providerRef === null) return reject('no_provider_ref');
    if (state.connectionId === null) return reject('no_connection');
    if (state.lastActivityAt === null) return reject('no_activity');
    if (disk === undefined) return reject('untracked');
    if (disk.allocationId !== state.allocationId) return reject('allocation_mismatch');
    if (disk.idleConnectionId !== state.connectionId) return reject('idle_connection_mismatch');
    if (attempt) {
      if (disk.attemptedIdleAt === state.lastActivityAt) return reject('already_attempted');
      if (Date.now() < state.lastActivityAt + input.idleMs) return reject('not_idle');
    }
    if (disk.contaminated) return reject('contaminated');
    if (!capable) return reject('not_capable');
    if (routes.length !== 1) return reject('route_count');
    if (route === undefined || route.state !== 'ready') return reject('route_not_ready');
    if (!input.eligible(route)) return reject('route_ineligible');
    if (route.credentialSource === null) return reject('no_credentials');
    if (
      !sameSessionSnapshotIdentity(
        disk.owner,
        sessionSnapshotIdentity(
          disk.owner.sandboxId,
          route.sessionId,
          route.spec.kiloSessionId,
          route.credentialSource
        )
      )
    )
      return reject('identity_mismatch');
    if (attempt)
      input.storage.put(SESSION_SNAPSHOT_ALLOCATION_KEY, {
        ...disk,
        attemptedIdleAt: state.lastActivityAt,
      });
    return { ok: true, state, disk, route, providerRef: state.providerRef };
  };
  const fence = await input.enqueue(() => candidate(true));
  if (!fence.ok) return;
  logCapture('started', {
    allocationId: fence.state.allocationId,
    connectionId: fence.state.connectionId,
    sessionId: fence.route.sessionId,
    attemptId: fence.route.attemptId,
  });
  const result = await input.provider.capture(fence.providerRef, crypto.randomUUID());
  logCapture('provider_result', {
    status: result.status,
    reason: result.status === 'failed' ? result.reason : undefined,
    allocationId: fence.state.allocationId,
    sessionId: fence.route.sessionId,
  });
  if (result.status !== 'stored') return;
  await input.enqueue(async () => {
    const current = await candidate();
    if (!current.ok) {
      logCapture('discarded', {
        sessionId: fence.route.sessionId,
        reason: current.reason,
        expectedAllocationId: fence.state.allocationId,
        currentAllocationId: current.state.allocationId,
        expectedConnectionId: fence.state.connectionId,
        currentConnectionId: current.state.connectionId,
        expectedActivityAt: fence.state.lastActivityAt,
        currentActivityAt: current.state.lastActivityAt,
        expectedGeneration: fence.disk.invalidationGeneration,
        currentGeneration: current.disk?.invalidationGeneration,
        expectedAttemptId: fence.route.attemptId,
        currentAttemptId: current.route?.attemptId,
      });
      return;
    }
    const comparison = {
      sessionId: fence.route.sessionId,
      expectedAllocationId: fence.state.allocationId,
      currentAllocationId: current.state.allocationId,
      expectedConnectionId: fence.state.connectionId,
      currentConnectionId: current.state.connectionId,
      expectedActivityAt: fence.state.lastActivityAt,
      currentActivityAt: current.state.lastActivityAt,
      expectedGeneration: fence.disk.invalidationGeneration,
      currentGeneration: current.disk.invalidationGeneration,
      expectedAttemptId: fence.route.attemptId,
      currentAttemptId: current.route.attemptId,
    };
    if (current.state.allocationId !== fence.state.allocationId) {
      logCapture('discarded', { reason: 'allocation_changed', ...comparison });
      return;
    }
    if (current.state.connectionId !== fence.state.connectionId) {
      logCapture('discarded', { reason: 'connection_changed', ...comparison });
      return;
    }
    if (current.state.lastActivityAt !== fence.state.lastActivityAt) {
      logCapture('discarded', { reason: 'activity_changed', ...comparison });
      return;
    }
    if (current.disk.invalidationGeneration !== fence.disk.invalidationGeneration) {
      logCapture('discarded', { reason: 'generation_changed', ...comparison });
      return;
    }
    if (current.route.attemptId !== fence.route.attemptId) {
      logCapture('discarded', { reason: 'route_attempt_changed', ...comparison });
      return;
    }
    input.storage.put(
      SESSION_SNAPSHOT_KEY,
      descriptorSchema.parse({
        ...fence.disk.owner,
        sourceAllocationId: fence.state.allocationId,
        runtimeIdentity: fence.disk.runtimeIdentity,
        snapshotId: result.snapshotId,
        baseImage: result.baseImage,
        capturedAt: result.capturedAt,
      })
    );
    logCapture('stored', {
      allocationId: fence.state.allocationId,
      connectionId: fence.state.connectionId,
      sessionId: fence.route.sessionId,
      attemptId: fence.route.attemptId,
    });
  });
}
