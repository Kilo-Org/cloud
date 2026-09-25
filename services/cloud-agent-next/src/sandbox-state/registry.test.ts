import { describe, expect, it } from 'vitest';
import {
  ALLOCATION_REGISTRY,
  HEALTH_REGISTRY,
  REGISTRY,
  SESSION_REGISTRY,
  pairDisposition,
  reachableStates,
  stateKinds,
  transitionsFor,
  type MachineName,
  type MachineRegistry,
} from './registry.js';
import { allocationStateKey, decideAllocation } from './allocation/reduce.js';
import { decideHealth } from './health/reduce.js';
import { decideSession, sessionStateKey } from './session/reduce.js';
import { operationId } from './commands.js';
import type { AllocationInputEvent, HealthEvent, RecoveryFence, SessionEvent } from './events.js';
import type {
  AllocationRecord,
  AllocationTarget,
  ProviderCapabilities,
  StopProof,
  StoppingDestroying,
} from './model/allocation.js';
import type { HealthState } from './model/health.js';
import type { SessionAggregate, SessionMessage } from './model/session.js';
import { POLICY, allocationAlarmAt, healthDeadlineAt, sessionAlarmAt } from './schedule.js';
import { storeAllocation, storeSession, type CanonicalStorage } from './persist/store.js';
import { loadAllocation, loadSession } from './persist/load.js';
import { allocationRecordSchema } from './model/allocation.js';

const NOW = 4_000_000;
const FAR = NOW + 10_000_000;
const INC = 'inc-1';
const EPISODE_ID = '11111111-1111-4111-8111-111111111111';
const CF_CAPS: ProviderCapabilities = { persistentWorkspace: false, destroysOnStop: true };
const TARGET: AllocationTarget = {
  provider: 'cloudflare',
  providerRef: 'provider-ref-1',
  capabilities: CF_CAPS,
};
const UNRESOLVED_TARGET: AllocationTarget = { ...TARGET, providerRef: null };
const INTENT = { intentId: 'intent-1', createdAt: NOW - 5_000 };
const HANDLE = { incarnation: INC, wrapper: 'w', epoch: 1 };

/* ---------------------------------------------------------------- allocation */

function allocatedRecord(health: HealthState, idleAt: number | null): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: { kind: 'allocated', target: TARGET, createIntent: INTENT, health, idleAt },
  };
}

function connectingHealth(): HealthState {
  return { kind: 'connecting', incarnation: INC, deadlineAt: NOW + POLICY.connectingDeadlineMs };
}

function healthyHealth(): HealthState {
  return {
    kind: 'healthy',
    incarnation: INC,
    lastHeartbeat: { incarnation: INC, at: NOW, ready: true },
    deadlineAt: NOW + POLICY.heartbeatExpiryMs,
  };
}

function recoveringHealth(attempts = 1): HealthState {
  return {
    kind: 'recovering',
    incarnation: INC,
    step: 'check_sandbox',
    attempts,
    deadlineAt: NOW + POLICY.recoveryDeadlineMs,
    episodeId: EPISODE_ID,
    cause: 'activation_pending',
  };
}

function stoppingDestroying(attempts = 0): StoppingDestroying {
  return {
    kind: 'stopping',
    target: TARGET,
    createIntent: INTENT,
    stopIntent: { reason: 'test', createdAt: NOW - 1_000, incarnation: INC },
    step: 'destroying',
    attempts,
    deadlineAt: NOW + POLICY.stopDeadlineMs,
  };
}

function allocationState(key: string): AllocationRecord {
  switch (key) {
    case 'stopped':
      return { v: 2, resumable: true, state: { kind: 'stopped', summary: null } };
    case 'creating':
      // Unresolved target so CREATE_CONFIRMED can install the reference.
      return {
        v: 2,
        resumable: true,
        state: {
          kind: 'creating',
          requestId: 'req',
          target: UNRESOLVED_TARGET,
          createIntent: INTENT,
          attempt: 1,
          deadlineAt: NOW + POLICY.createDeadlineMs,
        },
      };
    case 'allocated.connecting':
      return allocatedRecord(connectingHealth(), null);
    case 'allocated.healthy':
      return allocatedRecord(healthyHealth(), null);
    case 'allocated.recovering':
      return allocatedRecord(recoveringHealth(), NOW - 1);
    case 'stopping.destroying':
      return { v: 2, resumable: true, state: stoppingDestroying() };
    case 'stopping.check_required':
      return {
        v: 2,
        resumable: true,
        state: {
          kind: 'stopping',
          target: TARGET,
          createIntent: INTENT,
          stopIntent: { reason: 'test', createdAt: NOW - 1_000, incarnation: INC },
          step: 'check_required',
          attempts: 0,
        },
      };
    case 'unknown':
      return {
        v: 2,
        resumable: true,
        state: {
          kind: 'unknown',
          target: TARGET,
          createIntent: INTENT,
          stopIntent: null,
          attempts: 0,
          reason: 'test',
          deadlineAt: NOW,
        },
      };
    default:
      throw new Error(`unknown allocation state ${key}`);
  }
}

function destroyProof(): StopProof {
  return {
    effect: 'destroy',
    at: NOW,
    providerRef: 'provider-ref-1',
    incarnation: INC,
    reason: 'test',
  };
}

function recoveryFence(incarnation: string, episodeId: string, attempt: number): RecoveryFence {
  return {
    incarnation,
    episodeId,
    attempt,
    operationId: operationId('reconcile', incarnation, episodeId, attempt),
  };
}

function allocationRecoveryFence(state: AllocationRecord): RecoveryFence {
  if (state.state.kind === 'allocated' && state.state.health.kind === 'recovering') {
    const health = state.state.health;
    return recoveryFence(health.incarnation, health.episodeId, health.attempts + 1);
  }
  return recoveryFence(INC, EPISODE_ID, 1);
}

function allocationEvent(state: AllocationRecord, event: string): AllocationInputEvent {
  const createOp = operationId('create', INTENT.intentId);
  switch (event) {
    case 'DEMAND':
      return { type: 'DEMAND', requestId: 'req', target: TARGET, createIntent: INTENT };
    case 'ACQUIRE':
      return {
        type: 'ACQUIRE',
        requestId: 'req',
        target: TARGET,
        createIntent: INTENT,
        deliveryDeadlineAt: NOW + 1_000,
      };
    case 'CREATE_CONFIRMED':
      return {
        type: 'CREATE_CONFIRMED',
        fence: { operationId: createOp, providerRef: 'provider-ref-1', incarnation: INC },
        providerRef: 'provider-ref-1',
        incarnation: INC,
        at: NOW,
        resolvedContainment: { kilocode: true, github: true, providerRef: 'provider-ref-1' },
      };
    case 'CREATE_FAILED':
      return {
        type: 'CREATE_FAILED',
        fence: { operationId: createOp, providerRef: 'provider-ref-1', incarnation: null },
        reason: 'no',
        at: NOW,
      };
    case 'CREATE_UNKNOWN':
      return {
        type: 'CREATE_UNKNOWN',
        fence: { operationId: createOp, providerRef: 'provider-ref-1', incarnation: null },
        reason: 'lost',
        at: NOW,
      };
    case 'LAUNCH_FAILED':
      return {
        type: 'LAUNCH_FAILED',
        fence: {
          operationId: operationId('launch', INTENT.intentId),
          providerRef: 'provider-ref-1',
          incarnation: INC,
        },
        reason: 'wrapper_startup_failed',
        at: NOW,
      };
    case 'HEALTH_UNHEALTHY':
      return { type: 'HEALTH_UNHEALTHY', verdict: 'unresponsive' };
    case 'DESTROY_CONFIRMED': {
      const stopOp = operationId(
        'stop',
        NOW - 1_000,
        state.state.kind === 'stopping' ? state.state.attempts : 0
      );
      return {
        type: 'DESTROY_CONFIRMED',
        fence: { operationId: stopOp, providerRef: 'provider-ref-1', incarnation: INC },
        proof: destroyProof(),
      };
    }
    case 'DESTROY_NOT_CONFIRMED': {
      const stopOp = operationId(
        'stop',
        NOW - 1_000,
        state.state.kind === 'stopping' ? state.state.attempts : 0
      );
      return {
        type: 'DESTROY_NOT_CONFIRMED',
        fence: { operationId: stopOp, providerRef: 'provider-ref-1', incarnation: INC },
      };
    }
    case 'BUDGET_EXHAUSTED':
      return { type: 'BUDGET_EXHAUSTED' };
    case 'IDLE':
      return { type: 'IDLE', idleAt: NOW - 1 };
    case 'CHECK':
      return { type: 'CHECK' };
    case 'OBSERVED': {
      const target =
        state.state.kind === 'allocated'
          ? state.state.target
          : state.state.kind === 'unknown'
            ? state.state.target
            : TARGET;
      const observeOp =
        state.state.kind === 'stopping'
          ? operationId('observe', state.state.stopIntent.createdAt)
          : operationId(
              'observe',
              target?.providerRef ??
                (state.state.kind === 'unknown' ? state.state.createIntent?.intentId : undefined) ??
                'unknown'
            );
      return {
        type: 'OBSERVED',
        fence: {
          operationId: observeOp,
          providerRef: target?.providerRef ?? 'provider-ref-1',
          incarnation: state.state.kind === 'stopping' ? INC : null,
        },
        result: 'present',
      };
    }
    case 'CANCEL':
      return { type: 'CANCEL', scope: 'allocation' };
    case 'CANCEL.RECOVERY':
      return { type: 'CANCEL', scope: 'recovery' };
    case 'DEADLINE':
      return { type: 'DEADLINE', episodeId: EPISODE_ID };
    case 'CONNECTED':
      return { type: 'CONNECTED', incarnation: INC, at: NOW, ready: true, episodeId: EPISODE_ID };
    case 'HEARTBEAT':
      return { type: 'HEARTBEAT', incarnation: INC, at: NOW, ready: true, episodeId: EPISODE_ID };
    case 'HEALTH_OBSERVED':
      return {
        type: 'HEALTH_OBSERVED',
        incarnation: INC,
        at: NOW,
        providerState: 'active',
        episodeId: EPISODE_ID,
      };
    case 'RECOVERY_STEP':
      return {
        type: 'RECOVERY_STEP',
        fence: allocationRecoveryFence(state),
        step: 'reconnect_wrapper',
      };
    case 'RECOVERY_ATTEMPT_FAILED':
      return { type: 'RECOVERY_ATTEMPT_FAILED', fence: allocationRecoveryFence(state) };
    case 'RECOVERY_SUCCEEDED':
      return {
        type: 'RECOVERY_SUCCEEDED',
        fence: allocationRecoveryFence(state),
        at: NOW,
        ready: true,
      };
    default:
      throw new Error(`unknown allocation event ${event}`);
  }
}

/* --------------------------------------------------------------------- health */

function healthState(key: string): HealthState {
  switch (key) {
    case 'connecting':
      return connectingHealth();
    case 'healthy':
      return healthyHealth();
    case 'recovering':
      return recoveringHealth();
    case 'unhealthy':
      return { kind: 'unhealthy', incarnation: INC, verdict: 'absent' };
    default:
      throw new Error(`unknown health state ${key}`);
  }
}

function healthRecoveryFence(state: HealthState): RecoveryFence {
  return state.kind === 'recovering'
    ? recoveryFence(state.incarnation, state.episodeId, state.attempts + 1)
    : recoveryFence(INC, EPISODE_ID, 1);
}

function healthEvent(state: HealthState, key: string): HealthEvent {
  switch (key) {
    case 'CONNECTED':
      return { type: 'CONNECTED', incarnation: INC, at: NOW, ready: true, episodeId: EPISODE_ID };
    case 'HEARTBEAT':
      return { type: 'HEARTBEAT', incarnation: INC, at: NOW, ready: true, episodeId: EPISODE_ID };
    case 'HEALTH_OBSERVED':
      return {
        type: 'HEALTH_OBSERVED',
        incarnation: INC,
        at: NOW,
        providerState: 'active',
        episodeId: EPISODE_ID,
      };
    case 'RECOVERY_STEP':
      return {
        type: 'RECOVERY_STEP',
        fence: healthRecoveryFence(state),
        step: 'reconnect_wrapper',
      };
    case 'RECOVERY_ATTEMPT_FAILED':
      return { type: 'RECOVERY_ATTEMPT_FAILED', fence: healthRecoveryFence(state) };
    case 'RECOVERY_SUCCEEDED':
      return {
        type: 'RECOVERY_SUCCEEDED',
        fence: healthRecoveryFence(state),
        at: NOW,
        ready: true,
      };
    case 'HEALTH_UNHEALTHY':
      return { type: 'HEALTH_UNHEALTHY', verdict: 'unresponsive' };
    case 'CANCEL':
      return { type: 'CANCEL', scope: 'recovery' };
    case 'DEADLINE':
      return { type: 'DEADLINE', episodeId: EPISODE_ID };
    default:
      throw new Error(`unknown health event ${key}`);
  }
}

/* -------------------------------------------------------------------- session */

function sessionMessage(kind: string): SessionMessage {
  const intent = {
    turn: { type: 'prompt' as const, messageId: 'm1', prompt: 'hi' },
    agent: { mode: 'code', model: 'm' },
  };
  switch (kind) {
    case 'queued':
      return {
        messageId: 'm1',
        state: {
          kind: 'queued',
          intent,
          deliveryStep: 'waiting',
          deadlineAt: NOW + 60_000,
          attachFailures: 0,
          promptFailures: 0,
        },
      };
    case 'accepted':
      return {
        messageId: 'm1',
        state: {
          kind: 'accepted',
          intent,
          acceptedAt: NOW - 1_000,
          wrapperInstanceId: 'w',
          executionDeadlineAt: NOW + 60_000,
        },
      };
    case 'completed':
      return {
        messageId: 'm1',
        state: { kind: 'completed', intent, at: NOW, source: 'wrapper_outcome' },
      };
    case 'failed':
      return {
        messageId: 'm1',
        state: { kind: 'failed', intent, at: NOW, source: 'wrapper_outcome' },
      };
    case 'cancelled':
      return {
        messageId: 'm1',
        state: { kind: 'cancelled', intent, at: NOW, source: 'coordinator' },
      };
    default:
      throw new Error(`unknown session message ${kind}`);
  }
}

function ambiguousQueued(): SessionMessage {
  const base = sessionMessage('queued');
  if (base.state.kind !== 'queued') throw new Error('expected queued');
  return { ...base, state: { ...base.state, unresolvedDispatch: true } };
}

function sessionState(key: string): SessionAggregate {
  if (key === 'unbound') return { binding: { kind: 'unbound' }, messages: [] };
  if (key === 'unresolved') return { binding: { kind: 'unresolved' }, messages: [] };
  if (key === 'bound') return { binding: { kind: 'bound', handle: HANDLE }, messages: [] };
  return { binding: { kind: 'bound', handle: HANDLE }, messages: [sessionMessage(key)] };
}

function sessionEvent(key: string): SessionEvent {
  switch (key) {
    case 'ENQUEUE':
      return { type: 'ENQUEUE', message: { ...sessionMessage('queued'), messageId: 'm2' } };
    case 'BIND':
      return { type: 'BIND', handle: HANDLE };
    case 'UNBIND':
      return { type: 'UNBIND' };
    case 'DEMAND':
      return { type: 'DEMAND', requestId: 'req', deliveryDeadlineAt: NOW + 1_000 };
    case 'ACCEPT':
      return { type: 'ACCEPT', messageId: 'm1', acceptedAt: NOW };
    case 'DELIVERY_STEP':
      return { type: 'DELIVERY_STEP', messageId: 'm1', step: 'preparing' };
    case 'RECORD_PROOF':
      return {
        type: 'RECORD_PROOF',
        messageId: 'm1',
        proofs: {
          attach: {
            authorization: {
              operation: 'session.attach',
              operationId: 'op',
              messageId: 'm1',
              session: { sessionId: 's', kiloSessionId: 'k', directory: '/d' },
              wrapperInstanceId: 'w',
              dispatchDeadlineAt: NOW,
            },
            dispatched: false,
          },
        },
      };
    case 'RECORD_CANCELLATION':
      return {
        type: 'RECORD_CANCELLATION',
        messageId: 'm1',
        operationId: 'cancel',
        deadlineAt: NOW + 1_000,
      };
    case 'OUTCOME':
      return {
        type: 'OUTCOME',
        messageId: 'm1',
        status: 'completed',
        at: NOW,
        source: 'wrapper_outcome',
      };
    case 'CANCEL':
      return { type: 'CANCEL', scope: 'message', messageId: 'm1', at: NOW };
    case 'STOPPED':
      return {
        type: 'STOPPED',
        proof: {
          effect: 'destroy',
          at: NOW,
          providerRef: 'ref',
          incarnation: INC,
          wrapper: 'w',
          reason: 'loss',
        },
        reason: 'loss',
      };
    case 'DEADLINE':
      return { type: 'DEADLINE' };
    default:
      throw new Error(`unknown session event ${key}`);
  }
}

/* ----------------------------------------------------- scenarios per pair */

export type Scenario = { state: unknown; event: unknown; now: number };

/** Extra state values for a pair; the default is the single representative. */
const STATE_VARIANTS: Record<string, unknown[]> = {
  'allocation:allocated.connecting:DEADLINE': [
    allocatedRecord(connectingHealth(), NOW - 1),
    allocatedRecord(connectingHealth(), null),
  ],
  'allocation:allocated.healthy:DEADLINE': [
    allocatedRecord(healthyHealth(), NOW - 1),
    allocatedRecord(healthyHealth(), null),
  ],
  'allocation:allocated.recovering:RECOVERY_STEP': [
    allocatedRecord(recoveringHealth(1), NOW - 1),
    allocatedRecord(recoveringHealth(POLICY.recoveryMaxAttempts - 1), NOW - 1),
  ],
  'allocation:allocated.recovering:RECOVERY_ATTEMPT_FAILED': [
    allocatedRecord(recoveringHealth(1), NOW - 1),
    allocatedRecord(recoveringHealth(POLICY.recoveryMaxAttempts - 1), NOW - 1),
  ],
  'allocation:unknown:DEADLINE': [
    allocationState('unknown'),
    {
      v: 2,
      resumable: true,
      state: {
        kind: 'unknown',
        target: null,
        createIntent: null,
        stopIntent: null,
        attempts: 0,
        reason: 'test',
        deadlineAt: NOW,
      },
    },
  ],
  'health:recovering:RECOVERY_STEP': [
    recoveringHealth(1),
    recoveringHealth(POLICY.recoveryMaxAttempts - 1),
  ],
  'health:recovering:RECOVERY_ATTEMPT_FAILED': [
    recoveringHealth(1),
    recoveringHealth(POLICY.recoveryMaxAttempts - 1),
  ],
  'session:queued:CANCEL': [
    sessionState('queued'),
    { ...sessionState('queued'), messages: [ambiguousQueued()] },
  ],
};

/** Enabling payload variants for one concrete state value. */
function payloadVariants(machine: MachineName, state: unknown, event: string): Scenario[] {
  if (machine === 'allocation') {
    const record = state as AllocationRecord;
    switch (event) {
      case 'IDLE':
        return [
          { state, event: { type: 'IDLE', idleAt: NOW - 1 }, now: NOW },
          { state, event: { type: 'IDLE', idleAt: NOW + 60_000 }, now: NOW },
        ];
      case 'HEALTH_OBSERVED':
        return (['active', 'unknown', 'terminal'] as const).map(providerState => ({
          state,
          event: {
            type: 'HEALTH_OBSERVED',
            incarnation: INC,
            at: NOW,
            providerState,
            episodeId: EPISODE_ID,
          },
          now: NOW,
        }));
      case 'CONNECTED':
      case 'HEARTBEAT':
        return [true, false].map(ready => ({
          state,
          event: { type: event, incarnation: INC, at: NOW, ready, episodeId: EPISODE_ID },
          now: NOW,
        }));
      case 'HEALTH_UNHEALTHY':
        return (['absent', 'unresponsive'] as const).map(verdict => ({
          state,
          event: { type: 'HEALTH_UNHEALTHY', verdict },
          now: NOW,
        }));
      case 'OBSERVED':
        return (['absent', 'present'] as const).map(result => ({
          state,
          event: { ...(allocationEvent(record, 'OBSERVED') as object), result },
          now: NOW,
        }));
      case 'DEADLINE':
        return [
          { state, event: { type: 'DEADLINE', episodeId: EPISODE_ID }, now: NOW },
          { state, event: { type: 'DEADLINE', episodeId: EPISODE_ID }, now: FAR },
        ];
      default:
        return [{ state, event: allocationEvent(record, event), now: NOW }];
    }
  }
  if (machine === 'health') {
    const health = state as HealthState;
    switch (event) {
      case 'CONNECTED':
      case 'HEARTBEAT':
        return [true, false].map(ready => ({
          state,
          event: { type: event, incarnation: INC, at: NOW, ready, episodeId: EPISODE_ID },
          now: NOW,
        }));
      case 'HEALTH_OBSERVED':
        return (['active', 'unknown', 'terminal'] as const).map(providerState => ({
          state,
          event: {
            type: 'HEALTH_OBSERVED',
            incarnation: INC,
            at: NOW,
            providerState,
            episodeId: EPISODE_ID,
          },
          now: NOW,
        }));
      case 'DEADLINE':
        return [
          { state, event: { type: 'DEADLINE', episodeId: EPISODE_ID }, now: NOW },
          { state, event: { type: 'DEADLINE', episodeId: EPISODE_ID }, now: FAR },
        ];
      default:
        return [{ state, event: healthEvent(health, event), now: NOW }];
    }
  }
  const aggregate = state as SessionAggregate;
  // Reachability feeds states returned by the reducer, whose head message id is not
  // always `m1`; target the actual head so message events stay enabling.
  const headId = aggregate.messages[0]?.messageId;
  const targetHead = (event: SessionEvent): SessionEvent =>
    headId !== undefined && 'messageId' in event ? { ...event, messageId: headId } : event;
  switch (event) {
    case 'OUTCOME':
      return (['completed', 'failed', 'cancelled'] as const).map(status => ({
        state,
        event: targetHead({
          type: 'OUTCOME',
          messageId: 'm1',
          status,
          at: NOW,
          source: 'wrapper_outcome',
        }),
        now: NOW,
      }));
    case 'DEADLINE':
      return [
        { state, event: { type: 'DEADLINE' }, now: NOW },
        { state, event: { type: 'DEADLINE' }, now: FAR },
      ];
    case 'CANCEL':
      return [{ state, event: targetHead(sessionEvent('CANCEL')), now: NOW }];
    default:
      return [{ state, event: targetHead(sessionEvent(event)), now: NOW }];
  }
}

function scenariosFor(machine: MachineName, stateKey: string, event: string): Scenario[] {
  const states = STATE_VARIANTS[`${machine}:${stateKey}:${event}`] ?? [
    representativeValue(machine, stateKey),
  ];
  const scenarios: Scenario[] = [];
  for (const state of states) {
    scenarios.push(...payloadVariants(machine, state, event));
  }
  return scenarios;
}

type RunResult = { key: string; commands: string[]; deadlineAt: number | null };

function runScenario(machine: MachineName, scenario: Scenario): RunResult | undefined {
  if (machine === 'allocation') {
    const decision = decideAllocation(
      scenario.state as AllocationRecord,
      scenario.event as AllocationInputEvent,
      scenario.now
    );
    return decision
      ? {
          key: allocationStateKey(decision.state.state),
          commands: decision.commands.map(command => command.kind),
          deadlineAt: decision.deadlineAt,
        }
      : undefined;
  }
  if (machine === 'health') {
    const decision = decideHealth(
      scenario.state as HealthState,
      scenario.event as HealthEvent,
      scenario.now
    );
    return decision
      ? {
          key: decision.state.kind,
          commands: decision.commands.map(command => command.kind),
          deadlineAt: decision.deadlineAt,
        }
      : undefined;
  }
  const decision = decideSession(
    scenario.state as SessionAggregate,
    scenario.event as SessionEvent,
    scenario.now
  );
  return decision
    ? {
        key: sessionStateKey(decision.state),
        commands: decision.commands.map(command => command.kind),
        deadlineAt: decision.deadlineAt,
      }
    : undefined;
}

/* -------------------------------------------------------------------- helpers */

function reduceAllocation(key: string, event: string) {
  return decideAllocation(allocationState(key), allocationEvent(allocationState(key), event), NOW);
}

function reduceHealth(key: string, event: string) {
  const state = healthState(key);
  return decideHealth(state, healthEvent(state, event), NOW);
}

function reduceSession(key: string, event: string) {
  return decideSession(sessionState(key), sessionEvent(event), NOW);
}

function actualKey(machine: MachineRegistry, key: string, event: string): string | undefined {
  if (machine.name === 'allocation') {
    const decision = reduceAllocation(key, event);
    return decision ? allocationStateKey(decision.state.state) : undefined;
  }
  if (machine.name === 'health') return reduceHealth(key, event)?.state.kind;
  const decision = reduceSession(key, event);
  return decision ? sessionStateKey(decision.state) : undefined;
}

function changedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (before === after) return [];
  if (
    typeof before !== 'object' ||
    before === null ||
    typeof after !== 'object' ||
    after === null ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    return [prefix];
  }
  const paths: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const child = prefix ? `${prefix}.${key}` : key;
    paths.push(
      ...changedPaths(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        child
      )
    );
  }
  return paths;
}

function normalizeMessagePaths(paths: string[]): string[] {
  return paths.map(path => path.replace(/\.\d+(?=\.|$)/g, ''));
}

function normalizeCommandKind(kind: string): string {
  return kind === 'Stop' || kind === 'Destroy' ? 'EFFECT' : kind;
}

function sortedNormalized(kinds: readonly string[]): string[] {
  return [...new Set(kinds.map(normalizeCommandKind))].sort();
}

function memoryStorage(): CanonicalStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string): Promise<T | undefined> => data.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      data.set(key, value);
    },
  };
}

/* ---------------------------------------------------------------------- tests */

describe('registry invariants', () => {
  it('every (state,event) pair is handled or explicitly rejected', () => {
    for (const machine of REGISTRY) {
      for (const state of stateKinds(machine)) {
        for (const event of machine.events) {
          const disposition = pairDisposition(machine, state, event);
          const decision = actualKey(machine, state, event);
          if (disposition === 'handled') {
            expect(decision, `${machine.name}:${state}:${event} should be handled`).toBeDefined();
          } else {
            expect(
              decision,
              `${machine.name}:${state}:${event} should be rejected`
            ).toBeUndefined();
          }
        }
      }
    }
  });

  it('every declared transition is reached and no undeclared destination is', () => {
    for (const machine of REGISTRY) {
      for (const state of stateKinds(machine)) {
        for (const event of machine.events) {
          const entries = transitionsFor(machine, state, event);
          if (entries.length === 0) continue;
          const declared = new Set(entries.map(entry => entry.to));
          const reached = new Set<string>();
          for (const scenario of scenariosFor(machine.name, state, event)) {
            const result = runScenario(machine.name, scenario);
            expect(result, `${machine.name}:${state}:${event}`).toBeDefined();
            reached.add(result!.key);
          }
          expect(
            [...reached].sort(),
            `${machine.name}:${state}:${event} reached vs declared`
          ).toEqual([...declared].sort());
        }
      }
    }
  });

  it('declared commands exactly match the reducer output for every reached target', () => {
    for (const machine of REGISTRY) {
      for (const state of stateKinds(machine)) {
        for (const event of machine.events) {
          const entries = transitionsFor(machine, state, event);
          if (entries.length === 0) continue;
          for (const scenario of scenariosFor(machine.name, state, event)) {
            const result = runScenario(machine.name, scenario);
            expect(result, `${machine.name}:${state}:${event}`).toBeDefined();
            const entry = entries.find(candidate => candidate.to === result!.key);
            expect(entry, `${machine.name}:${state}:${event} -> ${result!.key}`).toBeDefined();
            expect(
              sortedNormalized(result!.commands),
              `${machine.name}:${state}:${event} -> ${result!.key} commands`
            ).toEqual(sortedNormalized(entry!.commands));
          }
        }
      }
    }
  });

  it('every decision reports the aggregate single clock deadline', () => {
    for (const state of stateKinds(ALLOCATION_REGISTRY)) {
      for (const event of ALLOCATION_REGISTRY.events) {
        const decision = reduceAllocation(state, event);
        if (!decision) continue;
        expect(decision.deadlineAt, `allocation:${state}:${event}`).toBe(
          allocationAlarmAt(decision.state)
        );
      }
    }
    for (const state of stateKinds(HEALTH_REGISTRY)) {
      for (const event of HEALTH_REGISTRY.events) {
        const decision = reduceHealth(state, event);
        if (!decision) continue;
        expect(decision.deadlineAt, `health:${state}:${event}`).toBe(
          healthDeadlineAt(decision.state)
        );
      }
    }
    for (const state of stateKinds(SESSION_REGISTRY)) {
      for (const event of SESSION_REGISTRY.events) {
        const decision = reduceSession(state, event);
        if (!decision) continue;
        expect(decision.deadlineAt, `session:${state}:${event}`).toBe(
          sessionAlarmAt(decision.state)
        );
      }
    }
  });

  it('every non-terminal state owns a deadline or a real named exit', () => {
    function alarmOf(machine: MachineName, value: unknown): number | null {
      if (machine === 'allocation') return allocationAlarmAt(value as AllocationRecord);
      if (machine === 'health') return healthDeadlineAt(value as HealthState);
      return sessionAlarmAt(value as SessionAggregate);
    }
    for (const machine of REGISTRY) {
      for (const state of machine.states) {
        if (state.terminal) continue;
        const value = representativeValue(machine.name, state.kind);
        if (state.hasDeadline) {
          expect(
            alarmOf(machine.name, value),
            `${machine.name}:${state.kind} must arm a deadline`
          ).not.toBeNull();
          continue;
        }
        expect(
          state.namedExits.length,
          `${machine.name}:${state.kind} needs a named exit`
        ).toBeGreaterThan(0);
        for (const exit of state.namedExits) {
          expect(
            actualKey(machine, state.kind, exit),
            `${machine.name}:${state.kind} named exit ${exit}`
          ).toBeDefined();
        }
      }
    }
  });

  it('terminal states have no outgoing effects in the reducer', () => {
    for (const machine of REGISTRY) {
      const terminal = new Set(
        machine.states.filter(state => state.terminal).map(state => state.kind)
      );
      for (const state of terminal) {
        for (const event of machine.events) {
          const decision =
            machine.name === 'session' ? reduceSession(state, event) : reduceHealth(state, event);
          if (!decision) continue;
          expect(decision.commands, `${machine.name}:${state}:${event}`).toEqual([]);
        }
      }
    }
  });

  it('every declared state is reachable by feeding returned reducer state', () => {
    for (const machine of REGISTRY) {
      const reachedKeys = new Set<string>(machine.entries);
      const visited = new Set<string>(
        machine.entries.map(entry =>
          identityOf(machine.name, entry, representativeValue(machine.name, entry))
        )
      );
      const queue: Array<{ key: string; value: unknown }> = machine.entries.map(entry => ({
        key: entry,
        value: representativeValue(machine.name, entry),
      }));
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const event of machine.events) {
          for (const scenario of payloadVariants(machine.name, current.value, event)) {
            const next = rawDecision(machine.name, scenario);
            if (next === undefined) continue;
            const key = keyOfState(machine.name, next);
            if (key === undefined) continue;
            // Identity includes the binding so a bound-queued state (which enables
            // ACCEPT) is not conflated with an unbound-queued one.
            const identity = identityOf(machine.name, key, next);
            if (visited.has(identity)) continue;
            visited.add(identity);
            reachedKeys.add(key);
            queue.push({ key, value: next });
          }
        }
      }
      for (const state of machine.states) {
        expect(reachedKeys.has(state.kind), `${machine.name}:${state.kind}`).toBe(true);
      }
      // The declared-edge traversal must not claim reachability the reducer cannot.
      const declared = reachableStates(machine);
      for (const key of reachedKeys) {
        expect(declared.has(key), `${machine.name}:${key}`).toBe(true);
      }
    }
  });

  it('each field is written by exactly one reducer (actual diff over all scenarios)', () => {
    for (const machine of REGISTRY) {
      for (const state of stateKinds(machine)) {
        for (const event of machine.events) {
          for (const scenario of scenariosFor(machine.name, state, event)) {
            const decision = rawDecision(machine.name, scenario);
            if (!decision) continue;
            const paths = normalizeMessagePaths(changedPaths(scenario.state, decision));
            for (const path of paths) {
              expect(
                isOwnedPath(machine.name, path),
                `${machine.name}:${state}:${event} changed ${path}`
              ).toBe(true);
            }
          }
        }
      }
    }
  });

  it('every successful reducer output is canonical and round-trips through store→load', async () => {
    for (const machine of REGISTRY) {
      for (const state of stateKinds(machine)) {
        for (const event of machine.events) {
          for (const scenario of scenariosFor(machine.name, state, event)) {
            const decision = rawDecision(machine.name, scenario);
            if (!decision) continue;
            const storage = memoryStorage();
            if (machine.name === 'allocation') {
              const record = decision as AllocationRecord;
              expect(
                allocationRecordSchema.safeParse(record).success,
                `allocation:${state}:${event}`
              ).toBe(true);
              await storeAllocation(storage, record);
              expect(await loadAllocation(storage)).toEqual({
                ok: true,
                source: 'canonical',
                value: record,
              });
            } else if (machine.name === 'health') {
              const health = decision as HealthState;
              const record = allocatedRecord(health, null);
              expect(
                allocationRecordSchema.safeParse(record).success,
                `health:${state}:${event}`
              ).toBe(true);
            } else {
              const aggregate = decision as SessionAggregate;
              await storeSession(storage, aggregate);
              expect(await loadSession(storage), `session:${state}:${event}`).toEqual({
                ok: true,
                source: 'canonical',
                value: aggregate,
              });
            }
          }
        }
      }
    }
  });

  it('stopping.check_required declares no deadline and CHECK/DEMAND exits', () => {
    const state = ALLOCATION_REGISTRY.states.find(item => item.kind === 'stopping.check_required');
    expect(state?.hasDeadline).toBe(false);
    expect(state?.namedExits).toEqual(['CHECK', 'DEMAND', 'ACQUIRE']);
  });

  it('the health machine has a terminal unhealthy state with no exits', () => {
    const state = HEALTH_REGISTRY.states.find(item => item.kind === 'unhealthy');
    expect(state?.terminal).toBe(true);
    expect(state?.namedExits).toEqual([]);
  });

  it('the session machine starts unbound and message states are separate from binding states', () => {
    expect(SESSION_REGISTRY.initial).toBe('unbound');
    expect(SESSION_REGISTRY.states.some(state => state.kind === 'bound')).toBe(true);
    expect(SESSION_REGISTRY.states.some(state => state.kind === 'accepted')).toBe(true);
  });

  it('session binding coverage is separate from message-lifecycle coverage', () => {
    const bindingEvents = ['BIND', 'UNBIND', 'DEMAND'];
    const messageEvents = [
      'ACCEPT',
      'DELIVERY_STEP',
      'RECORD_PROOF',
      'RECORD_CANCELLATION',
      'OUTCOME',
      'CANCEL',
    ];
    const bindingStates = ['unbound', 'unresolved', 'bound'];
    const messageStates = ['queued', 'accepted', 'completed', 'failed', 'cancelled'];

    for (const state of bindingStates) {
      expect(
        bindingEvents.some(event => pairDisposition(SESSION_REGISTRY, state, event) === 'handled'),
        `binding state ${state} must handle a binding event`
      ).toBe(true);
      for (const event of messageEvents) {
        expect(
          pairDisposition(SESSION_REGISTRY, state, event),
          `binding state ${state} must not handle message event ${event}`
        ).toBe('rejected');
      }
    }
    for (const state of messageStates) {
      expect(
        messageEvents.some(event => pairDisposition(SESSION_REGISTRY, state, event) === 'handled'),
        `message state ${state} must handle a lifecycle event`
      ).toBe(true);
    }
  });
});

/* --------------------------------------------------- ownership helper plumbing */

function representativeValue(machine: MachineName, state: string): unknown {
  if (machine === 'allocation') return allocationState(state);
  if (machine === 'health') return healthState(state);
  return sessionState(state);
}

function rawDecision(machine: MachineName, scenario: Scenario): unknown {
  if (machine === 'allocation') {
    return decideAllocation(
      scenario.state as AllocationRecord,
      scenario.event as AllocationInputEvent,
      scenario.now
    )?.state;
  }
  if (machine === 'health') {
    return decideHealth(scenario.state as HealthState, scenario.event as HealthEvent, scenario.now)
      ?.state;
  }
  return decideSession(
    scenario.state as SessionAggregate,
    scenario.event as SessionEvent,
    scenario.now
  )?.state;
}

function keyOfState(machine: MachineName, value: unknown): string | undefined {
  if (machine === 'allocation') return allocationStateKey((value as AllocationRecord).state);
  if (machine === 'health') return (value as HealthState).kind;
  return sessionStateKey(value as SessionAggregate);
}

function identityOf(machine: MachineName, key: string, value: unknown): string {
  if (machine === 'session') {
    const bindingKind = (value as SessionAggregate).binding.kind;
    return `${key}|${bindingKind}`;
  }
  return key;
}

const HEALTH_FIELDS = HEALTH_REGISTRY.ownedFields.map(field => field.replace(/^health\./, ''));

function ownsPath(fields: readonly string[], path: string): boolean {
  return fields.some(field => path === field || path.startsWith(`${field}.`));
}

function isOwnedPath(machine: MachineName, path: string): boolean {
  if (machine === 'health') return ownsPath(HEALTH_FIELDS, path);
  if (machine === 'session') return ownsPath(SESSION_REGISTRY.ownedFields, path);
  // Health changes are delegated to the health owner, never written directly by
  // the allocation counter.
  if (path === 'state.health') return true;
  if (path.startsWith('state.health.')) {
    return ownsPath(HEALTH_FIELDS, path.slice('state.health.'.length));
  }
  return ownsPath(ALLOCATION_REGISTRY.ownedFields, path);
}
