import { z } from 'zod';
import { controlStopRequestSchema } from '../shared/control-plane-session.js';
import {
  SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS,
  SANDBOX_CONTROL_RECOVERY_ATTEMPT_TIMEOUT_MS,
  SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS,
  sessionOperationAuthorizationSchema,
  type SandboxRecovery,
} from '../shared/sandbox-control-protocol.js';
import { armDeadline, cancelDeadline, DEADLINE_MS, type DeadlineTable } from './deadlines.js';
import type { SandboxControlConnectionIdentity } from './socket.js';

export const ACTIVE_WRAPPER_RUNTIME_KEY = 'active_wrapper_runtime';
export const WRAPPER_READY_AT_KEY = 'wrapper_ready_at';
export const RECOVERY_ACTIVATION_ACK_TIMEOUT_MS = 90_000;

const recoveryAuthorityScopeSchema = z
  .object({
    sessionId: z.string().min(1),
    kiloSessionId: z.string().min(1),
    directory: z.string().min(1),
    messageId: z.string().min(1),
    wrapperInstanceId: z.string().uuid().optional(),
    nativeRuntimeId: z.string().uuid().optional(),
    executionDeadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    authorization: sessionOperationAuthorizationSchema.optional(),
  })
  .strict();

const recoveryStopSchema = z
  .object({
    sessionId: z.string().min(1),
    ownerId: z.string().min(1),
    request: controlStopRequestSchema,
  })
  .strict();

const recoveryRootSchema = z.object({
  sessionId: z.string().min(1),
  ownerId: z.string().min(1),
  kiloSessionId: z.string().min(1),
  directory: z.string().min(1),
  nativeRuntimeId: z.string().uuid().optional(),
  observation: z.enum(['known', 'idle', 'stale', 'unknown']),
  observedAt: z.number().int().nonnegative().optional(),
  decision: z.enum(['ready', 'stop_pending', 'operation_unknown', 'execution_expired']).optional(),
});

export type RecoveryRoot = z.infer<typeof recoveryRootSchema>;
export type RecoveryScopeResult = Pick<RecoveryRoot, 'sessionId' | 'decision'>;

export const recoveryAuthoritySchema = z
  .object({
    source: z.literal('session_control_state'),
    observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    allocation: z.object({
      providerRef: z.string().min(1),
      createIntentId: z.string().min(1).optional(),
    }),
    roots: z.array(recoveryRootSchema).optional(),
    scopes: z.array(recoveryAuthorityScopeSchema),
    stops: z.array(recoveryStopSchema),
    wholeAllocation: z.boolean(),
  })
  .strict();

export type RecoveryAuthority = z.infer<typeof recoveryAuthoritySchema>;

export const sandboxRecoveryDecisionSchema = z
  .object({
    episodeId: z.string().uuid(),
    cause: z.enum(['activation_pending', 'control_disconnected', 'heartbeat_expired']),
    startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deadlineAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    attempt: z.number().int().nonnegative().max(SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS),
    connectionId: z.string().uuid(),
    providerInstanceId: z.string().min(1),
    wrapperInstanceId: z.string().uuid(),
    nextAttemptAt: z.number().int().nonnegative().optional(),
    exhaustedAt: z.number().int().nonnegative().optional(),
    cleanupDeadlineAt: z.number().int().nonnegative().optional(),
    cleanupState: z
      .enum(['pending', 'targeted', 'physical_fallback', 'completed', 'unconfirmed'])
      .optional(),
    authority: recoveryAuthoritySchema.optional(),
    activationCommittedAt: z.number().int().nonnegative().optional(),
    activationCommitDeadlineAt: z.number().int().nonnegative().optional(),
    activationCommitAttempts: z.number().int().nonnegative().optional(),
    activationCommitAttempt: z.number().int().nonnegative().optional(),
    activationCommitNextAttemptAt: z.number().int().nonnegative().optional(),
    activationAcknowledgedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type SandboxRecoveryDecision = z.infer<typeof sandboxRecoveryDecisionSchema>;

export type RecoveryAttempt = Readonly<{
  recovery: SandboxRecoveryDecision;
  deadlineAt: number;
}>;

export function activationCommitted(recovery: SandboxRecoveryDecision): boolean {
  return recovery.activationCommittedAt !== undefined;
}

export function activationRepairPending(recovery: SandboxRecoveryDecision): boolean {
  return activationCommitted(recovery) && recovery.activationAcknowledgedAt === undefined;
}

export function canRepairActivation(recovery: SandboxRecoveryDecision, now: number): boolean {
  if (
    !activationRepairPending(recovery) ||
    (recovery.activationCommitDeadlineAt ?? 0) <= now ||
    (recovery.activationCommitAttempts ?? 0) >= SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS
  )
    return false;
  return recovery.exhaustedAt === undefined || hasReadyActivationScope(recovery, now);
}

export function hasReadyActivationScope(recovery: SandboxRecoveryDecision, now: number): boolean {
  return (
    recovery.activationCommitAttempt !== undefined &&
    (recovery.authority?.roots?.some(
      root =>
        root.decision === 'ready' &&
        (root.observation === 'known' || root.observation === 'idle') &&
        recovery.authority?.scopes.some(
          scope =>
            scope.sessionId === root.sessionId &&
            scope.kiloSessionId === root.kiloSessionId &&
            scope.directory === root.directory &&
            scope.nativeRuntimeId === root.nativeRuntimeId &&
            scope.wrapperInstanceId === recovery.wrapperInstanceId &&
            scope.authorization !== undefined &&
            scope.executionDeadlineAt !== undefined &&
            scope.executionDeadlineAt > now
        )
    ) ??
      false)
  );
}

export function commitRecoveryActivation(
  recovery: SandboxRecoveryDecision,
  now: number
): SandboxRecoveryDecision {
  return {
    ...recovery,
    activationCommittedAt: recovery.activationCommittedAt ?? now,
    activationCommitDeadlineAt:
      recovery.activationCommitDeadlineAt ?? now + RECOVERY_ACTIVATION_ACK_TIMEOUT_MS,
    activationCommitAttempts: recovery.activationCommitAttempts ?? 0,
    activationCommitAttempt: recovery.activationCommitAttempt ?? recovery.attempt,
    activationCommitNextAttemptAt: now,
  };
}

export function replaceRecoveryAuthority(
  recovery: SandboxRecoveryDecision,
  authority: RecoveryAuthority
): SandboxRecoveryDecision {
  const previous = recovery.authority;
  if (!previous) return { ...recovery, authority };
  if (
    previous.allocation.providerRef !== authority.allocation.providerRef ||
    previous.allocation.createIntentId !== authority.allocation.createIntentId
  )
    return recovery;
  const roots = authority.roots?.map(root => {
    const old = previous.roots?.find(item => item.sessionId === root.sessionId);
    if (!old) return root;
    if (root.observation === 'unknown' && old.observation !== 'unknown')
      return { ...old, observation: 'stale' as const, decision: 'operation_unknown' as const };
    if (
      old.kiloSessionId !== root.kiloSessionId ||
      old.directory !== root.directory ||
      old.nativeRuntimeId !== root.nativeRuntimeId ||
      old.ownerId !== root.ownerId
    )
      return { ...old, observation: 'stale' as const, decision: 'operation_unknown' as const };
    return root;
  });
  for (const old of previous.roots ?? []) {
    if (!roots?.some(root => root.sessionId === old.sessionId))
      roots?.push({ ...old, observation: 'stale', decision: 'operation_unknown' });
  }
  const uncertain = (sessionId: string) => {
    const root = roots?.find(item => item.sessionId === sessionId);
    return (
      root?.observation === 'stale' ||
      root?.observation === 'unknown' ||
      (!root && !authority.wholeAllocation)
    );
  };
  const scopes = authority.scopes
    .filter(scope => !uncertain(scope.sessionId))
    .map(scope => {
      const old = previous.scopes.find(
        item =>
          item.sessionId === scope.sessionId &&
          item.messageId === scope.messageId &&
          item.kiloSessionId === scope.kiloSessionId &&
          item.directory === scope.directory &&
          item.wrapperInstanceId === scope.wrapperInstanceId &&
          item.nativeRuntimeId === scope.nativeRuntimeId
      );
      return old
        ? {
            ...scope,
            authorization: old.authorization ?? scope.authorization,
            executionDeadlineAt: old.executionDeadlineAt ?? scope.executionDeadlineAt,
          }
        : scope;
    });
  return {
    ...recovery,
    authority: {
      ...authority,
      allocation: previous.allocation,
      ...(roots ? { roots } : {}),
      scopes: [...scopes, ...previous.scopes.filter(scope => uncertain(scope.sessionId))],
      stops: [
        ...authority.stops.filter(stop => !uncertain(stop.sessionId)),
        ...previous.stops.filter(stop => uncertain(stop.sessionId)),
      ],
      wholeAllocation:
        authority.wholeAllocation && !(roots?.some(root => uncertain(root.sessionId)) ?? false),
    },
  };
}

export function hasUnresolvedRoots(authority: RecoveryAuthority | undefined): boolean {
  return (
    !authority ||
    !authority.wholeAllocation ||
    (authority.roots?.some(root => root.decision !== 'ready') ?? false)
  );
}

export function admitsRecoveryRequest(
  decisions: readonly SandboxRecoveryDecision[],
  identity: SandboxControlConnectionIdentity,
  session: { sessionId: string; kiloSessionId: string; directory: string }
): boolean {
  return decisions
    .filter(item => sameRuntime(item, identity))
    .every(item => {
      const root = item.authority?.roots?.find(root => root.sessionId === session.sessionId);
      return (
        root?.decision === 'ready' &&
        (root.observation === 'known' || root.observation === 'idle') &&
        root.kiloSessionId === session.kiloSessionId &&
        root.directory === session.directory
      );
    });
}

export function sameConnection(
  left: SandboxControlConnectionIdentity,
  right: SandboxControlConnectionIdentity
): boolean {
  return (
    left.connectionId === right.connectionId &&
    left.providerInstanceId === right.providerInstanceId &&
    left.wrapperInstanceId === right.wrapperInstanceId
  );
}

export function sameRuntime(
  left: SandboxControlConnectionIdentity,
  right: SandboxControlConnectionIdentity
): boolean {
  return (
    left.providerInstanceId === right.providerInstanceId &&
    left.wrapperInstanceId !== undefined &&
    left.wrapperInstanceId === right.wrapperInstanceId
  );
}

export function recoveryDeadlines(
  deadlines: DeadlineTable,
  recovery: readonly SandboxRecoveryDecision[],
  now = Date.now()
): DeadlineTable {
  const active = recovery.filter(item =>
    item.exhaustedAt === undefined
      ? activationRepairPending(item)
        ? (item.activationCommitDeadlineAt ?? 0) > now
        : item.deadlineAt > now
      : canRepairActivation(item, now)
  );
  let next = cancelDeadline(cancelDeadline(deadlines, 'recoveryExpiry'), 'recoveryRetry');
  if (active.length > 0)
    next = armDeadline(
      next,
      'recoveryExpiry',
      Math.min(
        ...active.map(item =>
          activationRepairPending(item)
            ? (item.activationCommitDeadlineAt ?? item.deadlineAt)
            : item.deadlineAt
        )
      )
    );
  const retries = recovery.flatMap(item => {
    const nextAttemptAt = activationRepairPending(item)
      ? canRepairActivation(item, now)
        ? (item.activationCommitNextAttemptAt ??
          (item.activationCommitAttempt === undefined ? item.nextAttemptAt : undefined))
        : undefined
      : item.exhaustedAt === undefined
        ? item.nextAttemptAt
        : undefined;
    return nextAttemptAt === undefined ? [] : [Math.max(now, nextAttemptAt)];
  });
  const cleanups = recovery
    .filter(
      item =>
        item.exhaustedAt !== undefined &&
        item.cleanupState !== 'completed' &&
        item.cleanupState !== 'unconfirmed'
    )
    .map(item => Math.max(now, item.nextAttemptAt ?? item.cleanupDeadlineAt ?? now));
  const scheduled = [...retries, ...cleanups];
  return scheduled.length === 0 ? next : armDeadline(next, 'recoveryRetry', Math.min(...scheduled));
}

export function exhaustRecovery(
  recovery: SandboxRecoveryDecision,
  now: number
): SandboxRecoveryDecision {
  if (recovery.exhaustedAt !== undefined) return recovery;
  return {
    ...recovery,
    exhaustedAt: now,
    cleanupDeadlineAt: recovery.cleanupDeadlineAt ?? now + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS,
    cleanupState: recovery.cleanupState ?? 'pending',
    nextAttemptAt: now,
  };
}

export function updateRecoveryCleanup(
  recovery: SandboxRecoveryDecision,
  state: NonNullable<SandboxRecoveryDecision['cleanupState']>,
  nextAttemptAt?: number
): SandboxRecoveryDecision {
  if (recovery.exhaustedAt === undefined) return recovery;
  return {
    ...recovery,
    cleanupState: state,
    ...(nextAttemptAt === undefined ? { nextAttemptAt: undefined } : { nextAttemptAt }),
  };
}

export function beginRecovery(
  previous: SandboxRecoveryDecision | undefined,
  identity: SandboxControlConnectionIdentity & { wrapperInstanceId: string },
  cause: SandboxRecoveryDecision['cause'],
  now: number
): SandboxRecoveryDecision {
  const deadlineAt = Math.min(previous?.deadlineAt ?? Infinity, now + DEADLINE_MS.heartbeatExpiry);
  if (previous) {
    return {
      ...previous,
      connectionId: identity.connectionId,
      providerInstanceId: identity.providerInstanceId,
      wrapperInstanceId: identity.wrapperInstanceId,
      deadlineAt,
      ...(previous.connectionId !== identity.connectionId
        ? {
            activationAcknowledgedAt: undefined,
            activationCommitNextAttemptAt: previous.activationCommitNextAttemptAt ?? now,
          }
        : {}),
    };
  }
  return {
    episodeId: crypto.randomUUID(),
    cause,
    startedAt: now,
    deadlineAt,
    attempt: 0,
    connectionId: identity.connectionId,
    providerInstanceId: identity.providerInstanceId,
    wrapperInstanceId: identity.wrapperInstanceId,
  };
}

export function claimAttempt(
  recovery: SandboxRecoveryDecision | undefined,
  identity: SandboxControlConnectionIdentity,
  now: number
): RecoveryAttempt | undefined {
  if (!recovery || !sameConnection(recovery, identity)) return undefined;
  if (activationRepairPending(recovery)) {
    const activationCommitDeadlineAt = recovery.activationCommitDeadlineAt;
    const nextAttemptAt =
      recovery.activationCommitNextAttemptAt ??
      (recovery.activationCommitAttempt === undefined ? recovery.nextAttemptAt : undefined);
    if (
      activationCommitDeadlineAt === undefined ||
      !canRepairActivation(recovery, now) ||
      (nextAttemptAt !== undefined && now < nextAttemptAt)
    )
      return undefined;
    return {
      recovery: {
        ...recovery,
        activationCommitAttempts: (recovery.activationCommitAttempts ?? 0) + 1,
        activationCommitNextAttemptAt: undefined,
      },
      deadlineAt: Math.min(
        activationCommitDeadlineAt,
        now + SANDBOX_CONTROL_RECOVERY_ATTEMPT_TIMEOUT_MS
      ),
    };
  }
  if (
    recovery.exhaustedAt !== undefined ||
    (recovery.nextAttemptAt !== undefined && now < recovery.nextAttemptAt) ||
    recovery.attempt >= SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS ||
    now >= recovery.deadlineAt
  )
    return undefined;
  const claimed = { ...recovery, attempt: recovery.attempt + 1, nextAttemptAt: undefined };
  return {
    recovery: claimed,
    deadlineAt: Math.min(claimed.deadlineAt, now + SANDBOX_CONTROL_RECOVERY_ATTEMPT_TIMEOUT_MS),
  };
}

export function failAttempt(
  recovery: SandboxRecoveryDecision,
  now: number
): SandboxRecoveryDecision {
  if (activationRepairPending(recovery)) {
    if (
      recovery.activationCommitDeadlineAt === undefined ||
      now >= recovery.activationCommitDeadlineAt ||
      (recovery.activationCommitAttempts ?? SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS) >=
        SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS
    )
      return exhaustRecovery(recovery, now);
    return {
      ...recovery,
      activationCommitNextAttemptAt: Math.min(recovery.activationCommitDeadlineAt, now + 1_000),
    };
  }
  if (
    recovery.exhaustedAt !== undefined ||
    now >= recovery.deadlineAt ||
    recovery.attempt >= SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS
  )
    return exhaustRecovery(recovery, now);
  return {
    ...recovery,
    nextAttemptAt: Math.min(recovery.deadlineAt, now + 1_000 * 2 ** (recovery.attempt - 1)),
  };
}

export function wireRecovery(recovery: SandboxRecoveryDecision): SandboxRecovery {
  return {
    episodeId: recovery.episodeId,
    cause: recovery.cause,
    startedAt: recovery.startedAt,
    deadlineAt: recovery.deadlineAt,
    attempt: activationRepairPending(recovery)
      ? (recovery.activationCommitAttempt ?? recovery.attempt)
      : recovery.attempt,
  };
}
