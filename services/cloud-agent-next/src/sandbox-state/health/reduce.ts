/**
 * Runtime-health reducer (design §6). Pure: no I/O, no clock read, no storage.
 * `decideHealth(state, event, now)` returns `undefined` when the event is not
 * accepted for the state (an explicit rejection, not a silent no-op).
 *
 * Recovery is owned here: entering or advancing it emits a `Reconcile` command,
 * and the single attempt budget (`recoveryMaxAttempts`) is enforced against the
 * attempts actually recorded, never against a supplied verdict.
 */
import type { Command, Decision } from '../commands.js';
import { operationId } from '../commands.js';
import type { StateMeta, TransitionMeta } from '../registry.js';
import type { HealthEvent, RecoveryFence } from '../events.js';
import type {
  HealthState,
  HeartbeatEvidence,
  HealthRecoveryStep,
  HealthVerdict,
  HealthyHealth,
  RecoveringHealth,
  RecoveryCause,
  UnhealthyHealth,
  ConnectingHealth,
} from '../model/health.js';
import { connectingHealth } from '../model/health.js';
import { POLICY } from '../schedule.js';

export const HEALTH = 'health';

export const HEALTH_STATES: readonly StateMeta[] = [
  { kind: 'connecting', terminal: false, hasDeadline: true, namedExits: [] },
  { kind: 'healthy', terminal: false, hasDeadline: true, namedExits: [] },
  { kind: 'recovering', terminal: false, hasDeadline: true, namedExits: [] },
  { kind: 'unhealthy', terminal: true, hasDeadline: false, namedExits: [] },
];

export const HEALTH_EVENT_TYPES = [
  'CONNECTED',
  'HEARTBEAT',
  'HEALTH_OBSERVED',
  'RECOVERY_STEP',
  'RECOVERY_ATTEMPT_FAILED',
  'RECOVERY_SUCCEEDED',
  'HEALTH_UNHEALTHY',
  'CANCEL',
  'DEADLINE',
] as const;

export const HEALTH_TRANSITIONS: readonly TransitionMeta[] = [
  { from: 'connecting', event: 'CONNECTED', to: 'healthy', commands: [], deadline: 'heartbeat' },
  {
    from: 'connecting',
    event: 'CONNECTED',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'connecting', event: 'HEARTBEAT', to: 'healthy', commands: [], deadline: 'heartbeat' },
  {
    from: 'connecting',
    event: 'HEARTBEAT',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'connecting', event: 'HEALTH_OBSERVED', to: 'unhealthy', commands: [], deadline: null },
  {
    from: 'connecting',
    event: 'HEALTH_OBSERVED',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  {
    from: 'connecting',
    event: 'HEALTH_OBSERVED',
    to: 'connecting',
    commands: [],
    deadline: 'connect',
  },
  { from: 'connecting', event: 'HEALTH_UNHEALTHY', to: 'unhealthy', commands: [], deadline: null },
  { from: 'connecting', event: 'CANCEL', to: 'unhealthy', commands: [], deadline: null },
  {
    from: 'connecting',
    event: 'DEADLINE',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'connecting', event: 'DEADLINE', to: 'connecting', commands: [], deadline: 'connect' },

  { from: 'healthy', event: 'CONNECTED', to: 'healthy', commands: [], deadline: 'heartbeat' },
  {
    from: 'healthy',
    event: 'CONNECTED',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'healthy', event: 'HEARTBEAT', to: 'healthy', commands: [], deadline: 'heartbeat' },
  {
    from: 'healthy',
    event: 'HEARTBEAT',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'healthy', event: 'HEALTH_OBSERVED', to: 'unhealthy', commands: [], deadline: null },
  {
    from: 'healthy',
    event: 'HEALTH_OBSERVED',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'healthy', event: 'HEALTH_OBSERVED', to: 'healthy', commands: [], deadline: 'heartbeat' },
  { from: 'healthy', event: 'HEALTH_UNHEALTHY', to: 'unhealthy', commands: [], deadline: null },
  {
    from: 'healthy',
    event: 'DEADLINE',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'healthy', event: 'DEADLINE', to: 'healthy', commands: [], deadline: 'heartbeat' },

  {
    from: 'recovering',
    event: 'RECOVERY_STEP',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'recovering', event: 'RECOVERY_STEP', to: 'unhealthy', commands: [], deadline: null },
  {
    from: 'recovering',
    event: 'RECOVERY_ATTEMPT_FAILED',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  {
    from: 'recovering',
    event: 'RECOVERY_ATTEMPT_FAILED',
    to: 'unhealthy',
    commands: [],
    deadline: null,
  },
  { from: 'recovering', event: 'CONNECTED', to: 'healthy', commands: [], deadline: 'heartbeat' },
  { from: 'recovering', event: 'CONNECTED', to: 'recovering', commands: [], deadline: 'recovery' },
  { from: 'recovering', event: 'HEARTBEAT', to: 'healthy', commands: [], deadline: 'heartbeat' },
  {
    from: 'recovering',
    event: 'HEARTBEAT',
    to: 'recovering',
    commands: [],
    deadline: 'recovery',
  },
  {
    from: 'recovering',
    event: 'RECOVERY_SUCCEEDED',
    to: 'healthy',
    commands: [],
    deadline: 'heartbeat',
  },
  { from: 'recovering', event: 'HEALTH_OBSERVED', to: 'unhealthy', commands: [], deadline: null },
  {
    from: 'recovering',
    event: 'HEALTH_OBSERVED',
    to: 'recovering',
    commands: [],
    deadline: 'recovery',
  },
  { from: 'recovering', event: 'HEALTH_UNHEALTHY', to: 'unhealthy', commands: [], deadline: null },
  { from: 'recovering', event: 'CANCEL', to: 'unhealthy', commands: [], deadline: null },
  { from: 'recovering', event: 'DEADLINE', to: 'unhealthy', commands: [], deadline: null },
  { from: 'recovering', event: 'DEADLINE', to: 'recovering', commands: [], deadline: 'recovery' },
];

/** Fields written only by this reducer. */
export const HEALTH_OWNED_FIELDS = [
  'health.kind',
  'health.incarnation',
  'health.lastHeartbeat',
  'health.lastObservation',
  'health.step',
  'health.attempts',
  'health.deadlineAt',
  'health.episodeId',
  'health.cause',
  'health.verdict',
] as const;

const RECOVERY_STEP_ORDER: Record<HealthRecoveryStep, number> = {
  check_sandbox: 0,
  reconnect_wrapper: 1,
};

/** Health-owned constructor: a fresh connecting state with the standard deadline. */
export function connectingAt(incarnation: string, now: number): ConnectingHealth {
  return connectingHealth(incarnation, now + POLICY.connectingDeadlineMs);
}

function matches(state: HealthState, incarnation: string): boolean {
  return state.incarnation === incarnation;
}

function unhealthy(state: HealthState, verdict: HealthVerdict): UnhealthyHealth {
  return { kind: 'unhealthy', incarnation: state.incarnation, verdict };
}

function heartbeatEvidence(incarnation: string, at: number, ready: boolean): HeartbeatEvidence {
  return { incarnation, at, ready };
}

function healthy(state: HealthState, incarnation: string, at: number): HealthyHealth {
  return {
    kind: 'healthy',
    incarnation: state.incarnation,
    lastHeartbeat: heartbeatEvidence(incarnation, at, true),
    deadlineAt: at + POLICY.heartbeatExpiryMs,
  };
}

/**
 * The single builder for a recovery attempt. The descriptor and phase cannot be
 * assembled anywhere else: the episode id is the stored uuid identity (never the
 * deadline, never the create intent, never per-attempt), `startedAt` is derived
 * from the never-extended deadline, and the phase is the reducer's ladder step.
 */
function reconcileCommand(state: RecoveringHealth, expectedWrapperInstanceId?: string): Command {
  const attempt = state.attempts + 1;
  return {
    kind: 'Reconcile',
    operationId: operationId('reconcile', state.incarnation, state.episodeId, attempt),
    incarnation: state.incarnation,
    attempt,
    deadlineAt: state.deadlineAt,
    recovery: {
      episodeId: state.episodeId,
      cause: state.cause,
      startedAt: state.deadlineAt - POLICY.recoveryDeadlineMs,
      deadlineAt: state.deadlineAt,
      attempt,
    },
    phase: state.step === 'check_sandbox' ? 'drain' : 'ready',
    ...(expectedWrapperInstanceId !== undefined ? { expectedWrapperInstanceId } : {}),
  };
}

function beginRecovery(
  state: HealthState,
  at: number,
  episodeId: string,
  cause: RecoveryCause,
  expectedWrapperInstanceId?: string
): { state: RecoveringHealth; commands: Command[] } {
  const recovering: RecoveringHealth = {
    kind: 'recovering',
    incarnation: state.incarnation,
    step: 'check_sandbox',
    attempts: 0,
    deadlineAt: at + POLICY.recoveryDeadlineMs,
    episodeId,
    cause,
    ...(expectedWrapperInstanceId !== undefined ? { expectedWrapperInstanceId } : {}),
  };
  return {
    state: recovering,
    commands: [reconcileCommand(recovering, expectedWrapperInstanceId)],
  };
}

/** A recovery attempt result is valid only for the episode's in-flight attempt. */
function recoveryFenceMatches(state: RecoveringHealth, fence: RecoveryFence): boolean {
  if (fence.incarnation !== state.incarnation) return false;
  if (fence.episodeId !== state.episodeId) return false;
  const inFlight = state.attempts + 1;
  if (fence.attempt !== inFlight) return false;
  return fence.operationId === reconcileCommand(state, state.expectedWrapperInstanceId).operationId;
}

/**
 * Consume one completed attempt. Exhaustion is derived here, from the recorded
 * attempts, and the absolute deadline is never extended.
 */
function consumeAttempt(state: RecoveringHealth, step?: HealthRecoveryStep): Decision<HealthState> {
  const attempts = state.attempts + 1;
  if (attempts >= POLICY.recoveryMaxAttempts) {
    return { state: unhealthy(state, 'unresponsive'), commands: [], deadlineAt: null };
  }
  const next: RecoveringHealth = { ...state, attempts, ...(step !== undefined ? { step } : {}) };
  return {
    state: next,
    commands: [reconcileCommand(next, next.expectedWrapperInstanceId)],
    deadlineAt: next.deadlineAt,
  };
}

/**
 * Enter recovery from the entering event. An event that lacks the minted
 * `episodeId` is rejected, so a neutral value can never stand in for the missing
 * identity; `episodeId` is minted once at the impure dispatch boundary.
 */
function startRecovery(
  state: HealthState,
  at: number,
  episodeId: string | undefined,
  cause: RecoveryCause,
  expectedWrapperInstanceId?: string
): Decision<HealthState> | undefined {
  if (episodeId === undefined) return undefined;
  const beginning = beginRecovery(state, at, episodeId, cause, expectedWrapperInstanceId);
  return {
    state: beginning.state,
    commands: beginning.commands,
    deadlineAt: beginning.state.deadlineAt,
  };
}

function acceptHeartbeat(
  state: HealthState,
  event: {
    incarnation: string;
    at: number;
    ready: boolean;
    episodeId?: string;
    expectedWrapperInstanceId?: string;
  }
): Decision<HealthState> | undefined {
  if (!matches(state, event.incarnation)) return undefined;
  if (event.ready) {
    const next = healthy(state, event.incarnation, event.at);
    return { state: next, commands: [], deadlineAt: next.deadlineAt };
  }
  if (state.kind === 'recovering') {
    // A not-ready heartbeat is not an attempt result, so it neither consumes
    // budget nor re-emits Reconcile while an attempt is in flight.
    return { state, commands: [], deadlineAt: state.deadlineAt };
  }
  return startRecovery(
    state,
    event.at,
    event.episodeId,
    'activation_pending',
    event.expectedWrapperInstanceId
  );
}

export function decideHealth(
  state: HealthState,
  event: HealthEvent,
  now: number
): Decision<HealthState> | undefined {
  if (state.kind === 'unhealthy') return undefined;

  switch (event.type) {
    case 'CONNECTED':
    case 'HEARTBEAT':
      return acceptHeartbeat(state, event);
    case 'RECOVERY_SUCCEEDED': {
      if (state.kind !== 'recovering' || !event.ready) return undefined;
      if (!recoveryFenceMatches(state, event.fence)) return undefined;
      const next = healthy(state, event.fence.incarnation, event.at);
      return { state: next, commands: [], deadlineAt: next.deadlineAt };
    }
    case 'HEALTH_OBSERVED': {
      if (!matches(state, event.incarnation)) return undefined;
      if (event.providerState === 'terminal') {
        const next = unhealthy(state, 'absent');
        return { state: next, commands: [], deadlineAt: null };
      }
      if (state.kind === 'recovering') {
        return { state, commands: [], deadlineAt: state.deadlineAt };
      }
      const observation = {
        incarnation: event.incarnation,
        at: event.at,
        providerState: event.providerState,
      };
      if (event.providerState === 'active') {
        if (state.kind === 'healthy') {
          const next = { ...state, lastObservation: observation };
          return { state: next, commands: [], deadlineAt: next.deadlineAt };
        }
        return startRecovery(
          state,
          event.at,
          event.episodeId,
          'activation_pending',
          event.expectedWrapperInstanceId
        );
      }
      // providerState 'unknown'
      if (state.kind === 'healthy') {
        return startRecovery(
          state,
          event.at,
          event.episodeId,
          'control_disconnected',
          event.expectedWrapperInstanceId
        );
      }
      const next = { ...state, lastObservation: observation };
      return { state: next, commands: [], deadlineAt: next.deadlineAt };
    }
    case 'RECOVERY_STEP': {
      if (state.kind !== 'recovering') return undefined;
      if (RECOVERY_STEP_ORDER[event.step] <= RECOVERY_STEP_ORDER[state.step]) return undefined;
      if (!recoveryFenceMatches(state, event.fence)) return undefined;
      return consumeAttempt(state, event.step);
    }
    case 'RECOVERY_ATTEMPT_FAILED': {
      if (state.kind !== 'recovering') return undefined;
      if (!recoveryFenceMatches(state, event.fence)) return undefined;
      return consumeAttempt(state);
    }
    case 'HEALTH_UNHEALTHY': {
      const next = unhealthy(state, event.verdict);
      return { state: next, commands: [], deadlineAt: null };
    }
    case 'CANCEL': {
      if (state.kind === 'healthy') return undefined;
      const next = unhealthy(state, 'unresponsive');
      return { state: next, commands: [], deadlineAt: null };
    }
    case 'DEADLINE': {
      if (state.kind === 'recovering') {
        if (now < state.deadlineAt) {
          return { state, commands: [], deadlineAt: state.deadlineAt };
        }
        const next = unhealthy(state, 'unresponsive');
        return { state: next, commands: [], deadlineAt: null };
      }
      if (now < state.deadlineAt) {
        return { state, commands: [], deadlineAt: state.deadlineAt };
      }
      return startRecovery(
        state,
        now,
        event.episodeId,
        state.kind === 'healthy' ? 'heartbeat_expired' : 'activation_pending'
      );
    }
  }
}
