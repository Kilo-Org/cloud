import { z } from 'zod';
import type {
  WrapperInstanceLease,
  WrapperStopReason,
  WrapperStopTarget,
} from '../agent-sandbox/protocol.js';

const WRAPPER_RUNTIME_STATE_KEY = 'wrapper_runtime_state';
const WRAPPER_LEASE_KEY = 'wrapper_lease';

const wrapperInstanceLeaseSchema = z.object({
  instanceId: z.string().min(1),
  instanceGeneration: z.number().int().nonnegative(),
});

const wrapperStopTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('instance'), instance: wrapperInstanceLeaseSchema }),
  z.object({ kind: z.literal('session') }),
]);

const wrapperStopReasonSchema = z.enum([
  'readiness-failed',
  'startup-failed',
  'unhealthy-wrapper',
  'terminal-failed',
  'terminal-interrupted',
  'idle-timeout',
  'keep-warm-expired',
  'user-interrupt',
  'session-delete',
  'unexpected-wrapper',
  'observation-failed',
]);

const wrapperLeaseSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none'), nextInstanceGeneration: z.number().int().positive() }),
  z.object({
    state: z.literal('owns_wrapper'),
    nextInstanceGeneration: z.number().int().positive(),
    instance: wrapperInstanceLeaseSchema,
    startupDeadlineAt: z.number().int().nonnegative().optional(),
    keepWarmUntil: z.number().int().nonnegative().optional(),
  }),
  z.object({
    state: z.literal('stop_needed'),
    nextInstanceGeneration: z.number().int().positive(),
    target: wrapperStopTargetSchema,
    reason: wrapperStopReasonSchema,
    requestedAt: z.number().int().nonnegative(),
    nextAttemptAt: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().optional(),
  }),
  z.object({
    state: z.literal('stopping'),
    nextInstanceGeneration: z.number().int().positive(),
    target: wrapperStopTargetSchema,
    reason: wrapperStopReasonSchema,
    requestedAt: z.number().int().nonnegative(),
    attemptId: z.string().min(1),
    attemptStartedAt: z.number().int().nonnegative(),
    attemptDeadlineAt: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
  }),
]);

export type WrapperLease = z.infer<typeof wrapperLeaseSchema>;

export type WrapperLeaseEvent =
  | { type: 'allocate'; instance: WrapperInstanceLease; startupDeadlineAt: number }
  | { type: 'startup_verified'; instanceId: string; readyDeadlineAt: number }
  | { type: 'delivery_accepted'; instanceId: string }
  | { type: 'retain_warm'; instanceId: string; keepWarmUntil: number }
  | { type: 'reuse'; instanceId: string; startupDeadlineAt: number }
  | { type: 'owned_absent'; instanceId: string }
  | { type: 'request_stop'; target: WrapperStopTarget; reason: WrapperStopReason; now: number }
  | { type: 'begin_stop_attempt'; attemptId: string; now: number; attemptDeadlineAt: number }
  | { type: 'stop_absent'; attemptId: string }
  | { type: 'stop_not_confirmed'; attemptId: string; retryAt: number; error: string }
  | { type: 'stop_attempt_expired'; attemptId: string; retryAt: number };

export const emptyWrapperLease = (): WrapperLease => ({
  state: 'none',
  nextInstanceGeneration: 1,
});

export async function getWrapperLease(storage: DurableObjectStorage): Promise<WrapperLease> {
  const parsed = wrapperLeaseSchema.safeParse(await storage.get(WRAPPER_LEASE_KEY));
  return parsed.success ? parsed.data : emptyWrapperLease();
}

export async function putWrapperLease(
  storage: DurableObjectStorage,
  lease: WrapperLease
): Promise<void> {
  await storage.put(WRAPPER_LEASE_KEY, wrapperLeaseSchema.parse(lease));
}

export function reduceWrapperLease(state: WrapperLease, event: WrapperLeaseEvent): WrapperLease {
  switch (event.type) {
    case 'allocate':
      if (state.state !== 'none') return state;
      return {
        state: 'owns_wrapper',
        nextInstanceGeneration: Math.max(
          state.nextInstanceGeneration,
          event.instance.instanceGeneration + 1
        ),
        instance: event.instance,
        startupDeadlineAt: event.startupDeadlineAt,
      };
    case 'startup_verified':
      if (state.state !== 'owns_wrapper' || state.instance.instanceId !== event.instanceId)
        return state;
      return { ...state, startupDeadlineAt: event.readyDeadlineAt, keepWarmUntil: undefined };
    case 'delivery_accepted':
      if (state.state !== 'owns_wrapper' || state.instance.instanceId !== event.instanceId)
        return state;
      return { ...state, startupDeadlineAt: undefined, keepWarmUntil: undefined };
    case 'retain_warm':
      if (state.state !== 'owns_wrapper' || state.instance.instanceId !== event.instanceId)
        return state;
      return { ...state, startupDeadlineAt: undefined, keepWarmUntil: event.keepWarmUntil };
    case 'reuse':
      if (state.state !== 'owns_wrapper' || state.instance.instanceId !== event.instanceId)
        return state;
      return { ...state, startupDeadlineAt: event.startupDeadlineAt };
    case 'owned_absent':
      if (state.state !== 'owns_wrapper' || state.instance.instanceId !== event.instanceId)
        return state;
      return { state: 'none', nextInstanceGeneration: state.nextInstanceGeneration };
    case 'request_stop':
      if (state.state === 'stopping' || state.state === 'stop_needed') return state;
      return {
        state: 'stop_needed',
        nextInstanceGeneration: state.nextInstanceGeneration,
        target: event.target,
        reason: event.reason,
        requestedAt: event.now,
        nextAttemptAt: event.now,
        attempts: 0,
      };
    case 'begin_stop_attempt':
      if (state.state !== 'stop_needed' || event.now < state.nextAttemptAt) return state;
      return {
        state: 'stopping',
        nextInstanceGeneration: state.nextInstanceGeneration,
        target: state.target,
        reason: state.reason,
        requestedAt: state.requestedAt,
        attemptId: event.attemptId,
        attemptStartedAt: event.now,
        attemptDeadlineAt: event.attemptDeadlineAt,
        attempts: state.attempts + 1,
      };
    case 'stop_absent':
      if (state.state !== 'stopping' || state.attemptId !== event.attemptId) return state;
      return { state: 'none', nextInstanceGeneration: state.nextInstanceGeneration };
    case 'stop_not_confirmed':
      if (state.state !== 'stopping' || state.attemptId !== event.attemptId) return state;
      return {
        state: 'stop_needed',
        nextInstanceGeneration: state.nextInstanceGeneration,
        target: state.target,
        reason: state.reason,
        requestedAt: state.requestedAt,
        nextAttemptAt: event.retryAt,
        attempts: state.attempts,
        lastError: event.error,
      };
    case 'stop_attempt_expired':
      if (state.state !== 'stopping' || state.attemptId !== event.attemptId) return state;
      return {
        state: 'stop_needed',
        nextInstanceGeneration: state.nextInstanceGeneration,
        target: state.target,
        reason: state.reason,
        requestedAt: state.requestedAt,
        nextAttemptAt: event.retryAt,
        attempts: state.attempts,
        lastError: 'Stop attempt deadline expired',
      };
  }
}

export function nextWrapperCleanupDeadline(lease: WrapperLease): number | undefined {
  if (lease.state === 'stop_needed') return lease.nextAttemptAt;
  if (lease.state === 'stopping') return lease.attemptDeadlineAt;
  return undefined;
}

export function nextWrapperLeaseDeadline(lease: WrapperLease): number | undefined {
  const cleanupDeadline = nextWrapperCleanupDeadline(lease);
  if (cleanupDeadline !== undefined) return cleanupDeadline;
  if (lease.state !== 'owns_wrapper') return undefined;
  return lease.startupDeadlineAt ?? lease.keepWarmUntil;
}

export const IDLE_RECONCILIATION_GRACE_MS = 15_000;
export const IDLE_KEEP_WARM_MS = 5 * 60 * 1000;
export const READY_ONLY_IDLE_MS = 60_000;

const wrapperRuntimeStateSchema = z.object({
  wrapperGeneration: z.number().int().nonnegative(),
  wrapperConnectionId: z.string().optional(),
  wrapperRunId: z.string().optional(),
  lastWrapperConnectedAt: z.number().int().nonnegative().optional(),
  lastWrapperMessageAt: z.number().int().nonnegative().optional(),
  lastWrapperPongAt: z.number().int().nonnegative().optional(),
  lastWrapperIdleAt: z.number().int().nonnegative().optional(),
  idleReconcileAfter: z.number().int().nonnegative().optional(),
  wrapperIdleDeadlineAt: z.number().int().nonnegative().optional(),
  pingDeadlineAt: z.number().int().nonnegative().optional(),
  nextPingAt: z.number().int().nonnegative().optional(),
  noOutputDeadlineAt: z.number().int().nonnegative().optional(),
});

export type WrapperRuntimeState = z.infer<typeof wrapperRuntimeStateSchema>;

export type ActiveWrapperRuntimeState = WrapperRuntimeState & {
  wrapperRunId: string;
  wrapperConnectionId: string;
};

export function isActiveWrapperRuntimeState(
  state: WrapperRuntimeState
): state is ActiveWrapperRuntimeState {
  return Boolean(state.wrapperConnectionId && state.wrapperRunId);
}

export function hasCompleteWrapperIdentity(state: WrapperRuntimeState): boolean {
  const hasIdentityField = Boolean(state.wrapperConnectionId || state.wrapperRunId);
  return !hasIdentityField || Boolean(state.wrapperConnectionId && state.wrapperRunId);
}

export const emptyWrapperRuntimeState = (): WrapperRuntimeState => ({
  wrapperGeneration: 0,
});

export async function getWrapperRuntimeState(
  storage: DurableObjectStorage
): Promise<WrapperRuntimeState> {
  const stored = await storage.get(WRAPPER_RUNTIME_STATE_KEY);
  const parsed = wrapperRuntimeStateSchema.safeParse(stored);
  if (!parsed.success) return emptyWrapperRuntimeState();
  if (!hasCompleteWrapperIdentity(parsed.data)) {
    return { wrapperGeneration: parsed.data.wrapperGeneration };
  }
  return parsed.data;
}

export type AllocatedWrapperRuntimeState = {
  state: ActiveWrapperRuntimeState;
  allocatedNewIdentity: boolean;
};

export async function allocateWrapperRuntimeState(
  storage: DurableObjectStorage,
  now = Date.now()
): Promise<AllocatedWrapperRuntimeState> {
  const current = await getWrapperRuntimeState(storage);
  if (isActiveWrapperRuntimeState(current)) {
    const next = {
      ...current,
      lastWrapperConnectedAt: now,
    } satisfies ActiveWrapperRuntimeState;
    await storage.put(WRAPPER_RUNTIME_STATE_KEY, next);
    return { state: next, allocatedNewIdentity: false };
  }

  try {
    await storage.delete('disconnect_grace');
  } catch {
    // Obsolete grace cleanup is best-effort; fresh fenced work must proceed.
  }
  const next = {
    wrapperGeneration: current.wrapperGeneration + 1,
    wrapperConnectionId: crypto.randomUUID(),
    wrapperRunId: `wr_${crypto.randomUUID().replace(/-/g, '')}`,
    lastWrapperConnectedAt: now,
  } satisfies ActiveWrapperRuntimeState;
  await storage.put(WRAPPER_RUNTIME_STATE_KEY, next);
  return { state: next, allocatedNewIdentity: true };
}

export type WrapperConnectionFence = {
  wrapperGeneration?: number;
  wrapperConnectionId?: string;
};

export async function clearWrapperRuntimeIdentity(
  storage: DurableObjectStorage,
  fence: WrapperConnectionFence = {},
  opts: { incrementGeneration?: boolean } = {}
): Promise<WrapperRuntimeState | null> {
  const current = await getWrapperRuntimeState(storage);
  if (
    fence.wrapperGeneration !== undefined &&
    current.wrapperGeneration !== fence.wrapperGeneration
  ) {
    return null;
  }
  if (
    fence.wrapperConnectionId !== undefined &&
    current.wrapperConnectionId !== fence.wrapperConnectionId
  ) {
    return null;
  }

  const next = {
    wrapperGeneration: opts.incrementGeneration
      ? current.wrapperGeneration + 1
      : current.wrapperGeneration,
  } satisfies WrapperRuntimeState;
  await storage.put(WRAPPER_RUNTIME_STATE_KEY, next);
  return next;
}

export async function clearAllocatedWrapperRuntimeState(
  storage: DurableObjectStorage,
  allocated: WrapperRuntimeState
): Promise<void> {
  if (!allocated.wrapperConnectionId) return;

  await clearWrapperRuntimeIdentity(
    storage,
    {
      wrapperGeneration: allocated.wrapperGeneration,
      wrapperConnectionId: allocated.wrapperConnectionId,
    },
    { incrementGeneration: true }
  );
}

export async function isCurrentWrapperConnection(
  storage: DurableObjectStorage,
  wrapperGeneration: number,
  wrapperConnectionId: string
): Promise<boolean> {
  const current = await getWrapperRuntimeState(storage);
  return (
    current.wrapperGeneration === wrapperGeneration &&
    current.wrapperConnectionId === wrapperConnectionId
  );
}

/**
 * Conditionally update the wrapper runtime state if the current generation
 * and connection ID match the expected values.
 *
 * Safety: The read-then-write pattern is safe because Durable Objects
 * guarantee single-threaded execution per instance — no concurrent request
 * or alarm can interleave between the get() and put().
 */
async function updateIfCurrent(
  storage: DurableObjectStorage,
  wrapperGeneration: number,
  wrapperConnectionId: string,
  update: (current: WrapperRuntimeState) => WrapperRuntimeState
): Promise<WrapperRuntimeState | null> {
  const current = await getWrapperRuntimeState(storage);
  if (
    current.wrapperGeneration !== wrapperGeneration ||
    current.wrapperConnectionId !== wrapperConnectionId
  ) {
    return null;
  }

  const next = update(current);
  await storage.put(WRAPPER_RUNTIME_STATE_KEY, next);
  return next;
}

export async function recordWrapperAcceptedMessage(
  storage: DurableObjectStorage,
  allocated: ActiveWrapperRuntimeState,
  noOutputDeadlineAt: number,
  nextPingAt: number
): Promise<void> {
  if (!allocated.wrapperConnectionId) return;

  await updateIfCurrent(
    storage,
    allocated.wrapperGeneration,
    allocated.wrapperConnectionId,
    current => ({
      ...current,
      noOutputDeadlineAt,
      nextPingAt:
        current.pingDeadlineAt === undefined ? (current.nextPingAt ?? nextPingAt) : undefined,
      lastWrapperIdleAt: undefined,
      idleReconcileAfter: undefined,
      wrapperIdleDeadlineAt: undefined,
    })
  );
}

export async function recordWrapperReadyLease(
  storage: DurableObjectStorage,
  allocated: ActiveWrapperRuntimeState,
  now = Date.now(),
  wrapperIdleDeadlineAt = now + READY_ONLY_IDLE_MS
): Promise<void> {
  if (!allocated.wrapperConnectionId) return;

  await updateIfCurrent(
    storage,
    allocated.wrapperGeneration,
    allocated.wrapperConnectionId,
    current => ({
      ...current,
      wrapperIdleDeadlineAt,
    })
  );
}

export async function recordWrapperPong(
  storage: DurableObjectStorage,
  wrapperGeneration: number,
  wrapperConnectionId: string,
  now = Date.now(),
  nextPingAt = now + 60_000
): Promise<WrapperRuntimeState | null> {
  return updateIfCurrent(storage, wrapperGeneration, wrapperConnectionId, current => ({
    ...current,
    lastWrapperPongAt: now,
    pingDeadlineAt: undefined,
    nextPingAt,
  }));
}

/**
 * Record that the wrapper received a root session.idle event.
 * Stores the idle timestamp, the reconciliation deadline, and the
 * keep-warm cleanup deadline.
 */
export async function recordRootSessionIdle(
  storage: DurableObjectStorage,
  wrapperGeneration: number,
  wrapperConnectionId: string,
  now = Date.now(),
  idleReconcileAfter = now + IDLE_RECONCILIATION_GRACE_MS,
  wrapperIdleDeadlineAt = now + IDLE_KEEP_WARM_MS
): Promise<WrapperRuntimeState | null> {
  return updateIfCurrent(storage, wrapperGeneration, wrapperConnectionId, current => ({
    ...current,
    lastWrapperIdleAt: now,
    idleReconcileAfter,
    wrapperIdleDeadlineAt,
  }));
}

/**
 * Record a meaningful output event from the wrapper.
 *
 * Refreshes `noOutputDeadlineAt` so mid-execution stalls are caught: without
 * this, the deadline would be cleared forever after the first event, and a
 * wrapper whose kilo-server SSE subscription silently stalls would remain
 * live without failing its accepted messages.
 *
 * This intentionally does NOT clear the idle-reconciliation fields
 * (`lastWrapperIdleAt`/`idleReconcileAfter`/`wrapperIdleDeadlineAt`). Those are
 * only ever armed by `recordRootSessionIdle` once the root session goes idle,
 * so any wrapper output observed afterwards is post-completion infrastructure
 * work (autocommit, condense, log upload) — not a new agent turn. Clearing the
 * idle deadline here would disarm the reconciler that finalizes the in-flight
 * message, stranding it non-terminal and hanging the callback. A genuinely new
 * turn clears idle via `recordWrapperAcceptedMessage` instead.
 */
export async function recordMeaningfulWrapperOutput(
  storage: DurableObjectStorage,
  wrapperGeneration: number,
  wrapperConnectionId: string,
  now = Date.now(),
  nextPingAt = now + 60_000,
  noOutputDeadlineAt = now + 5 * 60_000
): Promise<WrapperRuntimeState | null> {
  return updateIfCurrent(storage, wrapperGeneration, wrapperConnectionId, current => ({
    ...current,
    lastWrapperMessageAt: now,
    noOutputDeadlineAt,
    nextPingAt: current.pingDeadlineAt === undefined ? nextPingAt : undefined,
  }));
}

export async function markWrapperPingSent(
  storage: DurableObjectStorage,
  wrapperGeneration: number,
  wrapperConnectionId: string,
  pingDeadlineAt: number
): Promise<WrapperRuntimeState | null> {
  return updateIfCurrent(storage, wrapperGeneration, wrapperConnectionId, current => ({
    ...current,
    pingDeadlineAt,
    nextPingAt: undefined,
  }));
}

export async function clearCurrentWrapperRuntimeLivenessState(
  storage: DurableObjectStorage,
  wrapperGeneration: number,
  wrapperConnectionId: string
): Promise<WrapperRuntimeState | null> {
  return updateIfCurrent(storage, wrapperGeneration, wrapperConnectionId, current => ({
    wrapperGeneration: current.wrapperGeneration,
    wrapperConnectionId: current.wrapperConnectionId,
    wrapperRunId: current.wrapperRunId,
    lastWrapperConnectedAt: current.lastWrapperConnectedAt,
    lastWrapperMessageAt: current.lastWrapperMessageAt,
    lastWrapperPongAt: current.lastWrapperPongAt,
    lastWrapperIdleAt: current.lastWrapperIdleAt,
    idleReconcileAfter: current.idleReconcileAfter,
    wrapperIdleDeadlineAt: current.wrapperIdleDeadlineAt,
  }));
}

export async function clearWrapperIdleState(
  storage: DurableObjectStorage,
  wrapperGeneration: number,
  wrapperConnectionId: string
): Promise<WrapperRuntimeState | null> {
  return updateIfCurrent(storage, wrapperGeneration, wrapperConnectionId, current => ({
    ...current,
    lastWrapperIdleAt: undefined,
    idleReconcileAfter: undefined,
    wrapperIdleDeadlineAt: undefined,
  }));
}

export async function clearCurrentWrapperRuntimeFailureState(
  storage: DurableObjectStorage,
  wrapperGeneration: number,
  wrapperConnectionId: string
): Promise<WrapperRuntimeState | null> {
  return updateIfCurrent(storage, wrapperGeneration, wrapperConnectionId, current => ({
    wrapperGeneration: current.wrapperGeneration + 1,
  }));
}
