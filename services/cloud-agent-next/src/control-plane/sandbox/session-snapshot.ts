import { z } from 'zod';
import type { Env } from '../../types.js';
import type {
  ControlPlaneCredentialSource,
  ControlPlaneRouteSpec,
} from '../../shared/control-plane-protocol.js';
import type { ProviderAdapter } from '../../sandbox-control/provider.js';
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
  idleConnectionId: z.string().optional(),
  attemptedIdleAt: z.number().optional(),
  restore: z.object({ sourceAllocationId: z.string().min(1), confirmed: z.boolean() }).optional(),
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

export function selectSessionSnapshot(
  storage: Storage,
  identity: Identity,
  runtimeIdentity: string
) {
  const parsed = descriptorSchema.safeParse(storage.get(SESSION_SNAPSHOT_KEY));
  return parsed.success &&
    sameSessionSnapshotIdentity(parsed.data, identity) &&
    parsed.data.runtimeIdentity === runtimeIdentity
    ? parsed.data
    : null;
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
export async function captureIdleSessionSnapshot(input: {
  storage: Storage;
  provider: NonNullable<ProviderAdapter['sessionSnapshots']>;
  idleMs: number;
  read(): Promise<CaptureContext>;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  eligible(route: RouteRecord): boolean;
}): Promise<void> {
  const candidate = async (attempt = false) => {
    const { state, routes, capable } = await input.read();
    const disk = readSessionSnapshotAllocation(input.storage);
    const route = routes[0];
    if (
      state.kind !== 'connected' ||
      state.providerRef === null ||
      state.connectionId === null ||
      state.lastActivityAt === null ||
      disk?.allocationId !== state.allocationId ||
      disk.idleConnectionId !== state.connectionId
    )
      return null;
    if (attempt) {
      if (
        disk.attemptedIdleAt === state.lastActivityAt ||
        Date.now() < state.lastActivityAt + input.idleMs
      )
        return null;
      input.storage.put(SESSION_SNAPSHOT_ALLOCATION_KEY, {
        ...disk,
        attemptedIdleAt: state.lastActivityAt,
      });
    }
    if (
      disk.contaminated ||
      !capable ||
      routes.length !== 1 ||
      route?.state !== 'ready' ||
      !input.eligible(route) ||
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
      return null;
    return { state, disk, route, providerRef: state.providerRef };
  };
  const fence = await input.enqueue(() => candidate(true));
  if (fence === null) return;
  const result = await input.provider.capture(fence.providerRef, crypto.randomUUID());
  if (result.status !== 'stored') return;
  await input.enqueue(async () => {
    const current = await candidate();
    if (
      current === null ||
      current.state.allocationId !== fence.state.allocationId ||
      current.state.connectionId !== fence.state.connectionId ||
      current.state.lastActivityAt !== fence.state.lastActivityAt ||
      current.route.attemptId !== fence.route.attemptId
    )
      return;
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
  });
}
