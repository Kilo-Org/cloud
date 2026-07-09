import { z } from 'zod';
import {
  WRAPPER_DISCOVERY_LIST_PROCESSES_TIMEOUT_REASON,
  type WrapperInspectionFailureReason,
  type WrapperInstanceLease,
  type WrapperStopReason,
  type WrapperStopTarget,
} from '../agent-sandbox/protocol.js';
import { isGeneratedSharedSandboxId } from '../sandbox-id.js';
import type { SandboxId } from '../types.js';

const WRAPPER_RUNTIME_STATE_KEY = 'wrapper_runtime_state';
const WRAPPER_RUN_MESSAGE_INDEX_VERSION = 1;
const WRAPPER_LEASE_KEY = 'wrapper_lease';
const SANDBOX_RECOVERY_STATE_KEY = 'sandbox_recovery_state';
const CLEANUP_EXHAUSTED_ROLLBACK_FENCE_MS = 100 * 365 * 24 * 60 * 60 * 1_000;
export const WRAPPER_STOP_MAX_ATTEMPTS = 5;

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
  'terminal-completed',
  'terminal-ended',
  'terminal-interrupted',
  'idle-timeout',
  'keep-warm-expired',
  'user-interrupt',
  'session-delete',
  'unexpected-wrapper',
  'observation-failed',
]);

const SharedSandboxRouteKeySchema = z.custom<SandboxId>(
  value => typeof value === 'string' && isGeneratedSharedSandboxId(value)
);
const sharedSandboxFailoverPublicationSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('pending'),
    routeKey: SharedSandboxRouteKeySchema,
    failedAttempts: z.number().int().nonnegative(),
    nextAttemptAt: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('recorded'),
    routeKey: SharedSandboxRouteKeySchema,
  }),
  z.object({
    status: z.literal('not-applicable'),
  }),
  z.object({
    status: z.literal('exhausted'),
    routeKey: SharedSandboxRouteKeySchema,
    failedAttempts: z.number().int().positive(),
  }),
]);
const sandboxRecoveryStateSchema = z
  .object({
    listProcessesTimeouts: z.number().int().positive(),
    failoverPublication: sharedSandboxFailoverPublicationSchema.optional(),
  })
  .superRefine((state, context) => {
    if (state.failoverPublication && state.listProcessesTimeouts < 2) {
      context.addIssue({
        code: 'custom',
        message: 'Shared sandbox failover publication requires two inspection timeouts',
        path: ['listProcessesTimeouts'],
      });
    }
  });

const wrapperLeaseSchema = z
  .discriminatedUnion('state', [
    z.object({
      state: z.literal('none'),
      nextInstanceGeneration: z.number().int().positive(),
    }),
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
      exhaustedAt: z.number().int().nonnegative().optional(),
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
  ])
  .superRefine((lease, context) => {
    if (
      lease.state === 'stop_needed' &&
      lease.exhaustedAt !== undefined &&
      (lease.attempts < WRAPPER_STOP_MAX_ATTEMPTS ||
        lease.nextAttemptAt < lease.exhaustedAt + CLEANUP_EXHAUSTED_ROLLBACK_FENCE_MS)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Exhausted cleanup requires its full attempt budget and rollback fence',
        path: ['exhaustedAt'],
      });
    }
  });

export type WrapperLease = z.infer<typeof wrapperLeaseSchema>;
export type SandboxRecoveryState = z.infer<typeof sandboxRecoveryStateSchema>;

export type SandboxRecoveryEvent =
  | {
      type: 'inspection_failed';
      reason?: WrapperInspectionFailureReason;
      startsRecovery?: boolean;
    }
  | { type: 'prepare_failover'; routeKey: SandboxId; now: number }
  | {
      type: 'record_failover_retry';
      routeKey: SandboxId;
      expectedFailedAttempts: number;
      nextAttemptAt: number;
    }
  | { type: 'settle_failover'; outcome: 'not-applicable' }
  | {
      type: 'settle_failover';
      outcome: 'recorded' | 'exhausted';
      routeKey: SandboxId;
      expectedFailedAttempts: number;
    };

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
  | { type: 'stop_attempt_expired'; attemptId: string; retryAt: number }
  | { type: 'cleanup_exhausted'; attemptId?: string; now: number; error: string };

export const emptyWrapperLease = (): WrapperLease => ({
  state: 'none',
  nextInstanceGeneration: 1,
});

const persistedLeaseGenerationSchema = z.object({
  nextInstanceGeneration: z.number().int().positive(),
});

async function quarantineInvalidWrapperLease(
  storage: DurableObjectStorage,
  stored: unknown
): Promise<WrapperLease> {
  const generation = persistedLeaseGenerationSchema.safeParse(stored);
  const now = Date.now();
  const quarantined: WrapperLease = {
    state: 'stop_needed',
    nextInstanceGeneration: generation.success ? generation.data.nextInstanceGeneration : 1,
    target: { kind: 'session' },
    reason: 'observation-failed',
    requestedAt: now,
    nextAttemptAt: now + CLEANUP_EXHAUSTED_ROLLBACK_FENCE_MS,
    attempts: WRAPPER_STOP_MAX_ATTEMPTS,
    lastError: 'Invalid persisted wrapper lease',
    exhaustedAt: now,
  };
  await storage.put(WRAPPER_LEASE_KEY, wrapperLeaseSchema.parse(quarantined));
  return quarantined;
}

export async function getWrapperLease(storage: DurableObjectStorage): Promise<WrapperLease> {
  const stored = await storage.get(WRAPPER_LEASE_KEY);
  if (stored === undefined) return emptyWrapperLease();
  const parsed = wrapperLeaseSchema.safeParse(stored);
  return parsed.success ? parsed.data : quarantineInvalidWrapperLease(storage, stored);
}

export async function putWrapperLease(
  storage: DurableObjectStorage,
  lease: WrapperLease
): Promise<void> {
  await storage.put(WRAPPER_LEASE_KEY, wrapperLeaseSchema.parse(lease));
}

export async function getSandboxRecoveryState(
  storage: DurableObjectStorage
): Promise<SandboxRecoveryState | undefined> {
  const stored = await storage.get(SANDBOX_RECOVERY_STATE_KEY);
  if (stored === undefined) return undefined;
  const parsed = sandboxRecoveryStateSchema.safeParse(stored);
  if (!parsed.success) throw new Error('Invalid persisted sandbox recovery state');
  return parsed.data;
}

export async function putSandboxRecoveryState(
  storage: DurableObjectStorage,
  state: SandboxRecoveryState
): Promise<void> {
  await storage.put(SANDBOX_RECOVERY_STATE_KEY, sandboxRecoveryStateSchema.parse(state));
}

export async function recordSandboxInspectionFailure(
  storage: DurableObjectStorage,
  reason: WrapperInspectionFailureReason | undefined,
  options?: { startsRecovery?: boolean }
): Promise<SandboxRecoveryState | undefined> {
  const current = await getSandboxRecoveryState(storage);
  const updated = reduceSandboxRecoveryState(current, {
    type: 'inspection_failed',
    reason,
    ...options,
  });
  if (updated !== current && updated !== undefined) {
    await putSandboxRecoveryState(storage, updated);
  }
  return updated;
}

export async function clearSettledSandboxRecovery(storage: DurableObjectStorage): Promise<void> {
  const state = await getSandboxRecoveryState(storage);
  if (
    state?.failoverPublication?.status === 'pending' ||
    (state && state.listProcessesTimeouts >= 2 && !state.failoverPublication)
  ) {
    return;
  }
  await storage.delete(SANDBOX_RECOVERY_STATE_KEY);
}

export function reduceSandboxRecoveryState(
  state: SandboxRecoveryState | undefined,
  event: SandboxRecoveryEvent
): SandboxRecoveryState | undefined {
  switch (event.type) {
    case 'inspection_failed':
      if (event.reason !== WRAPPER_DISCOVERY_LIST_PROCESSES_TIMEOUT_REASON) return state;
      if (event.startsRecovery && state?.failoverPublication?.status !== 'pending') {
        return { listProcessesTimeouts: 1 };
      }
      return {
        ...state,
        listProcessesTimeouts: (state?.listProcessesTimeouts ?? 0) + 1,
      };
    case 'prepare_failover':
      if (!state || state.listProcessesTimeouts < 2 || state.failoverPublication) return state;
      return {
        ...state,
        failoverPublication: {
          status: 'pending',
          routeKey: event.routeKey,
          failedAttempts: 0,
          nextAttemptAt: event.now,
        },
      };
    case 'record_failover_retry': {
      const publication = state?.failoverPublication;
      if (
        !state ||
        publication?.status !== 'pending' ||
        publication.routeKey !== event.routeKey ||
        publication.failedAttempts !== event.expectedFailedAttempts
      ) {
        return state;
      }
      return {
        ...state,
        failoverPublication: {
          ...publication,
          failedAttempts: publication.failedAttempts + 1,
          nextAttemptAt: event.nextAttemptAt,
        },
      };
    }
    case 'settle_failover': {
      if (!state || state.listProcessesTimeouts < 2) return state;
      const publication = state.failoverPublication;
      if (event.outcome === 'not-applicable') {
        if (publication !== undefined) return state;
        return { ...state, failoverPublication: { status: 'not-applicable' } };
      }
      if (
        publication?.status !== 'pending' ||
        publication.routeKey !== event.routeKey ||
        publication.failedAttempts !== event.expectedFailedAttempts
      ) {
        return state;
      }
      return {
        ...state,
        failoverPublication:
          event.outcome === 'recorded'
            ? { status: 'recorded', routeKey: event.routeKey }
            : {
                status: 'exhausted',
                routeKey: event.routeKey,
                failedAttempts: publication.failedAttempts + 1,
              },
      };
    }
  }
}

export function nextSandboxRecoveryDeadline(
  state: SandboxRecoveryState | undefined
): number | undefined {
  return state?.failoverPublication?.status === 'pending'
    ? state.failoverPublication.nextAttemptAt
    : undefined;
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
      if (state.state !== 'none' && state.state !== 'owns_wrapper') return state;
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
    case 'cleanup_exhausted':
      if (
        (state.state !== 'stop_needed' && state.state !== 'stopping') ||
        state.attempts < WRAPPER_STOP_MAX_ATTEMPTS
      ) {
        return state;
      }
      if (state.state === 'stopping' && state.attemptId !== event.attemptId) return state;
      return {
        state: 'stop_needed',
        nextInstanceGeneration: state.nextInstanceGeneration,
        target: state.target,
        reason: state.reason,
        requestedAt: state.requestedAt,
        nextAttemptAt: event.now + CLEANUP_EXHAUSTED_ROLLBACK_FENCE_MS,
        attempts: state.attempts,
        lastError: event.error,
        exhaustedAt: event.now,
      };
  }
}

export function isWrapperCleanupExhausted(
  lease: WrapperLease
): lease is Extract<WrapperLease, { state: 'stop_needed' }> & { exhaustedAt: number } {
  return lease.state === 'stop_needed' && lease.exhaustedAt !== undefined;
}

export function nextWrapperCleanupDeadline(lease: WrapperLease): number | undefined {
  if (isWrapperCleanupExhausted(lease)) return undefined;
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

export const IDLE_KEEP_WARM_MS = 5 * 60 * 1000;
export const READY_ONLY_IDLE_MS = 60_000;

const wrapperRuntimeStateSchema = z.object({
  wrapperGeneration: z.number().int().nonnegative(),
  wrapperConnectionId: z.string().optional(),
  wrapperRunId: z.string().optional(),
  messageIndexVersion: z.number().int().nonnegative().optional(),
  dispatchingMessageId: z.string().optional(),
  lastWrapperConnectedAt: z.number().int().nonnegative().optional(),
  lastWrapperMessageAt: z.number().int().nonnegative().optional(),
  lastWrapperPongAt: z.number().int().nonnegative().optional(),
  finalizingWrapperRunId: z.string().optional(),
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

export function hasCompleteWrapperRunMessageIndex(
  state: WrapperRuntimeState,
  wrapperRunId: string
): boolean {
  return (
    state.wrapperRunId === wrapperRunId &&
    state.messageIndexVersion === WRAPPER_RUN_MESSAGE_INDEX_VERSION
  );
}

export function hasCompleteWrapperIdentity(state: WrapperRuntimeState): boolean {
  const hasIdentityField = Boolean(state.wrapperConnectionId || state.wrapperRunId);
  return !hasIdentityField || Boolean(state.wrapperConnectionId && state.wrapperRunId);
}

export const emptyWrapperRuntimeState = (): WrapperRuntimeState => ({
  wrapperGeneration: 0,
});

type WrapperRuntimeStateReader = {
  get<T = unknown>(key: string): Promise<T | undefined>;
};

export async function getWrapperRuntimeState(
  storage: WrapperRuntimeStateReader
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
    messageIndexVersion: WRAPPER_RUN_MESSAGE_INDEX_VERSION,
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

export async function recordWrapperDispatchingMessage(
  storage: DurableObjectStorage,
  allocated: ActiveWrapperRuntimeState,
  messageId: string
): Promise<void> {
  await updateIfCurrent(
    storage,
    allocated.wrapperGeneration,
    allocated.wrapperConnectionId,
    current => ({ ...current, dispatchingMessageId: messageId })
  );
}

export async function clearWrapperDispatchingMessage(
  storage: DurableObjectStorage,
  allocated: ActiveWrapperRuntimeState,
  messageId: string
): Promise<void> {
  await updateIfCurrent(
    storage,
    allocated.wrapperGeneration,
    allocated.wrapperConnectionId,
    current => {
      if (current.dispatchingMessageId !== messageId) return current;
      const next = { ...current };
      delete next.dispatchingMessageId;
      return next;
    }
  );
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
 * Reset liveness deadlines that went stale with the previous socket after an
 * accepted reconnect. A ping (or its pong) lost with the old socket can never
 * be satisfied, so a fresh ping is scheduled instead of letting the stale
 * deadline expire into a wrapper_ping_timeout. The no-output deadline kept
 * ticking while delivery was impossible, so it is extended to a fresh window
 * rather than firing wrapper_no_output before buffered output can drain.
 */
export async function resetWrapperLivenessAfterReconnect(
  storage: DurableObjectStorage,
  wrapperGeneration: number,
  wrapperConnectionId: string,
  nextPingAt: number,
  noOutputDeadlineAt: number
): Promise<WrapperRuntimeState | null> {
  return updateIfCurrent(storage, wrapperGeneration, wrapperConnectionId, current => {
    const next = { ...current };
    if (next.pingDeadlineAt !== undefined) {
      next.pingDeadlineAt = undefined;
      next.nextPingAt = nextPingAt;
    }
    if (next.noOutputDeadlineAt !== undefined) {
      next.noOutputDeadlineAt = Math.max(next.noOutputDeadlineAt, noOutputDeadlineAt);
    }
    return next;
  });
}

export async function markWrapperFinalizing(
  storage: DurableObjectStorage,
  wrapperRunId: string
): Promise<WrapperRuntimeState | null> {
  const current = await getWrapperRuntimeState(storage);
  if (current.wrapperRunId !== wrapperRunId) return null;
  if (current.finalizingWrapperRunId === wrapperRunId) return current;

  const next = { ...current, finalizingWrapperRunId: wrapperRunId } satisfies WrapperRuntimeState;
  await storage.put(WRAPPER_RUNTIME_STATE_KEY, next);
  return next;
}

export function isWrapperRunFinalizing(state: WrapperRuntimeState): boolean {
  return Boolean(state.wrapperRunId && state.finalizingWrapperRunId === state.wrapperRunId);
}

export function isWrapperDeliveryHeld(state: WrapperRuntimeState, lease: WrapperLease): boolean {
  return (
    isWrapperRunFinalizing(state) || lease.state === 'stop_needed' || lease.state === 'stopping'
  );
}

/** Record meaningful output while accepted work remains supervised. */
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
    messageIndexVersion: current.messageIndexVersion,
    dispatchingMessageId: current.dispatchingMessageId,
    lastWrapperConnectedAt: current.lastWrapperConnectedAt,
    lastWrapperMessageAt: current.lastWrapperMessageAt,
    lastWrapperPongAt: current.lastWrapperPongAt,
    finalizingWrapperRunId: current.finalizingWrapperRunId,
    wrapperIdleDeadlineAt: current.wrapperIdleDeadlineAt,
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
