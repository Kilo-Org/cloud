import { describe, expect, it } from 'vitest';
import type { SandboxId } from '../types.js';
import {
  allocateWrapperRuntimeState,
  clearCurrentWrapperRuntimeLivenessState,
  emptyWrapperLease,
  emptyWrapperRuntimeState,
  getWrapperLease,
  getWrapperRuntimeState,
  hasCompleteWrapperRunMessageIndex,
  isWrapperDeliveryHeld,
  markWrapperFinalizing,
  nextSandboxRecoveryDeadline,
  nextWrapperCleanupDeadline,
  nextWrapperLeaseDeadline,
  putWrapperLease,
  recordMeaningfulWrapperOutput,
  recordWrapperAcceptedMessage,
  reduceSandboxRecoveryState,
  reduceWrapperLease,
} from './wrapper-runtime-state.js';

type MemoryStorage = Pick<DurableObjectStorage, 'get' | 'put'> & DurableObjectStorage;

function createMemoryStorage(): MemoryStorage {
  const records = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string) {
      return records.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      records.set(key, value);
    },
  } as MemoryStorage;
}

const instance = { instanceId: 'instance_reducer', instanceGeneration: 1 };

describe('WrapperLease', () => {
  it('allocates one authorized wrapper and requests targeted cleanup without losing generation', () => {
    const owned = reduceWrapperLease(emptyWrapperLease(), {
      type: 'allocate',
      instance,
      startupDeadlineAt: 2_000,
    });
    expect(owned).toEqual({
      state: 'owns_wrapper',
      nextInstanceGeneration: 2,
      instance,
      startupDeadlineAt: 2_000,
    });

    expect(
      reduceWrapperLease(owned, {
        type: 'request_stop',
        target: { kind: 'instance', instance },
        reason: 'startup-failed',
        now: 1_000,
      })
    ).toEqual({
      state: 'stop_needed',
      nextInstanceGeneration: 2,
      target: { kind: 'instance', instance },
      reason: 'startup-failed',
      requestedAt: 1_000,
      nextAttemptAt: 1_000,
      attempts: 0,
    });
  });

  it('retains a verified owned instance for bounded warm reuse', () => {
    const owned = reduceWrapperLease(emptyWrapperLease(), {
      type: 'allocate',
      instance,
      startupDeadlineAt: 2_000,
    });
    const verified = reduceWrapperLease(owned, {
      type: 'startup_verified',
      instanceId: instance.instanceId,
      readyDeadlineAt: 3_000,
    });

    const warm = reduceWrapperLease(verified, {
      type: 'retain_warm',
      instanceId: instance.instanceId,
      keepWarmUntil: 20_000,
    });

    expect(warm).toEqual({
      state: 'owns_wrapper',
      nextInstanceGeneration: 2,
      instance,
      startupDeadlineAt: undefined,
      keepWarmUntil: 20_000,
    });
    expect(nextWrapperCleanupDeadline(warm)).toBeUndefined();
    expect(nextWrapperLeaseDeadline(warm)).toBe(20_000);

    const reusing = reduceWrapperLease(warm, {
      type: 'reuse',
      instanceId: instance.instanceId,
      startupDeadlineAt: 30_000,
    });
    expect(reusing).toMatchObject({
      state: 'owns_wrapper',
      keepWarmUntil: 20_000,
      startupDeadlineAt: 30_000,
    });
    expect(nextWrapperLeaseDeadline(reusing)).toBe(30_000);
    expect(
      reduceWrapperLease(reusing, {
        type: 'startup_verified',
        instanceId: instance.instanceId,
        readyDeadlineAt: 31_000,
      })
    ).toMatchObject({
      state: 'owns_wrapper',
      keepWarmUntil: undefined,
      startupDeadlineAt: 31_000,
    });
    expect(
      reduceWrapperLease(
        reduceWrapperLease(reusing, {
          type: 'startup_verified',
          instanceId: instance.instanceId,
          readyDeadlineAt: 31_000,
        }),
        { type: 'delivery_accepted', instanceId: instance.instanceId }
      )
    ).toMatchObject({ state: 'owns_wrapper', startupDeadlineAt: undefined });
  });

  it('returns an owned instance to none only after provider-verified absence', () => {
    const owned = reduceWrapperLease(emptyWrapperLease(), {
      type: 'allocate',
      instance,
      startupDeadlineAt: 2_000,
    });

    expect(
      reduceWrapperLease(owned, { type: 'owned_absent', instanceId: 'stale_instance' })
    ).toEqual(owned);
    expect(
      reduceWrapperLease(owned, { type: 'owned_absent', instanceId: instance.instanceId })
    ).toEqual({
      state: 'none',
      nextInstanceGeneration: 2,
    });
  });

  it('settles cleanup only for a matching confirmed-absent attempt and ignores stale results', () => {
    const requested = reduceWrapperLease(emptyWrapperLease(), {
      type: 'request_stop',
      target: { kind: 'session' },
      reason: 'unexpected-wrapper',
      now: 1_000,
    });
    const stopping = reduceWrapperLease(requested, {
      type: 'begin_stop_attempt',
      attemptId: 'attempt_current',
      now: 1_000,
      attemptDeadlineAt: 46_000,
    });

    expect(
      reduceWrapperLease(stopping, { type: 'stop_absent', attemptId: 'attempt_stale' })
    ).toEqual(stopping);
    expect(
      reduceWrapperLease(stopping, {
        type: 'stop_attempt_expired',
        attemptId: 'attempt_stale',
        retryAt: 50_000,
      })
    ).toEqual(stopping);
    expect(
      reduceWrapperLease(stopping, { type: 'stop_absent', attemptId: 'attempt_current' })
    ).toEqual({ state: 'none', nextInstanceGeneration: 1 });
  });

  it('preserves the stop target and counter across a bounded failed attempt', () => {
    const requested = reduceWrapperLease(emptyWrapperLease(), {
      type: 'request_stop',
      target: { kind: 'session' },
      reason: 'observation-failed',
      now: 100,
    });
    const stopping = reduceWrapperLease(requested, {
      type: 'begin_stop_attempt',
      attemptId: 'attempt_failed',
      now: 100,
      attemptDeadlineAt: 200,
    });
    const retrying = reduceWrapperLease(stopping, {
      type: 'stop_not_confirmed',
      attemptId: 'attempt_failed',
      retryAt: 5_200,
      error: 'inspection failed',
    });

    expect(retrying).toMatchObject({
      state: 'stop_needed',
      target: { kind: 'session' },
      reason: 'observation-failed',
      attempts: 1,
      nextAttemptAt: 5_200,
      lastError: 'inspection failed',
    });
    expect(nextWrapperCleanupDeadline(retrying)).toBe(5_200);
    expect(nextWrapperLeaseDeadline(retrying)).toBe(5_200);
  });

  it('keeps an exhausted cleanup quarantined without another deadline', () => {
    const requested = reduceWrapperLease(emptyWrapperLease(), {
      type: 'request_stop',
      target: { kind: 'session' },
      reason: 'observation-failed',
      now: 100,
    });
    if (requested.state !== 'stop_needed') throw new Error('Expected cleanup request');
    const stopping = reduceWrapperLease(
      { ...requested, attempts: 4 },
      {
        type: 'begin_stop_attempt',
        attemptId: 'attempt_fifth',
        now: 200,
        attemptDeadlineAt: 45_200,
      }
    );
    const exhausted = reduceWrapperLease(stopping, {
      type: 'cleanup_exhausted',
      attemptId: 'attempt_fifth',
      now: 300,
      error: 'inspection failed',
    });

    expect(exhausted).toMatchObject({
      state: 'stop_needed',
      attempts: 5,
      exhaustedAt: 300,
      lastError: 'inspection failed',
    });
    expect(nextWrapperCleanupDeadline(exhausted)).toBeUndefined();
    expect(nextWrapperLeaseDeadline(exhausted)).toBeUndefined();
    expect(isWrapperDeliveryHeld(emptyWrapperRuntimeState(), exhausted)).toBe(true);
    expect(
      reduceWrapperLease(exhausted, {
        type: 'request_stop',
        target: { kind: 'session' },
        reason: 'user-interrupt',
        now: 400,
      })
    ).toEqual(exhausted);
  });

  it('counts only fresh list-processes timeouts and persists publication deadlines', () => {
    const routeKey = `usr-${'d'.repeat(48)}` as SandboxId;
    expect(
      reduceSandboxRecoveryState(undefined, {
        type: 'inspection_failed',
      })
    ).toBeUndefined();

    const firstTimeout = reduceSandboxRecoveryState(undefined, {
      type: 'inspection_failed',
      reason: 'wrapper_discovery_list_processes_timeout',
    });
    const secondTimeout = reduceSandboxRecoveryState(firstTimeout, {
      type: 'inspection_failed',
      reason: 'wrapper_discovery_list_processes_timeout',
    });
    const publication = reduceSandboxRecoveryState(secondTimeout, {
      type: 'prepare_failover',
      routeKey,
      now: 1_000,
    });
    const retrying = reduceSandboxRecoveryState(publication, {
      type: 'record_failover_retry',
      routeKey,
      expectedFailedAttempts: 0,
      nextAttemptAt: 3_000,
    });

    expect(retrying).toMatchObject({
      listProcessesTimeouts: 2,
      failoverPublication: {
        status: 'pending',
        failedAttempts: 1,
        nextAttemptAt: 3_000,
      },
    });
    expect(nextSandboxRecoveryDeadline(retrying)).toBe(3_000);
  });

  it('marks a newly allocated wrapper run as maintaining its message index', async () => {
    const storage = createMemoryStorage();

    const { state } = await allocateWrapperRuntimeState(storage, 1_000);

    expect(state.messageIndexVersion).toBe(1);
    await recordWrapperAcceptedMessage(storage, state, 5_000, 4_000);
    await expect(getWrapperRuntimeState(storage)).resolves.toMatchObject({
      messageIndexVersion: 1,
    });
  });

  it('preserves the message index version while clearing current liveness deadlines', async () => {
    const storage = createMemoryStorage();
    const { state } = await allocateWrapperRuntimeState(storage, 1_000);
    await storage.put('wrapper_runtime_state', {
      ...state,
      nextPingAt: 2_000,
      noOutputDeadlineAt: 3_000,
    });

    await clearCurrentWrapperRuntimeLivenessState(
      storage,
      state.wrapperGeneration,
      state.wrapperConnectionId
    );

    await expect(getWrapperRuntimeState(storage)).resolves.toMatchObject({
      wrapperRunId: state.wrapperRunId,
      messageIndexVersion: 1,
    });
  });

  it('preserves runtime identity while treating a future message index version as untrusted', async () => {
    const storage = createMemoryStorage();
    await storage.put('wrapper_runtime_state', {
      wrapperGeneration: 2,
      wrapperConnectionId: 'conn_future_index',
      wrapperRunId: 'wr_future_index',
      messageIndexVersion: 2,
    });

    const state = await getWrapperRuntimeState(storage);

    expect(state).toMatchObject({
      wrapperGeneration: 2,
      wrapperConnectionId: 'conn_future_index',
      wrapperRunId: 'wr_future_index',
      messageIndexVersion: 2,
    });
    expect(hasCompleteWrapperRunMessageIndex(state, 'wr_future_index')).toBe(false);
  });

  it('persists finalizing only for the matching current wrapper run', async () => {
    const storage = createMemoryStorage();
    await storage.put('wrapper_runtime_state', {
      wrapperGeneration: 2,
      wrapperConnectionId: 'conn_finalizing',
      wrapperRunId: 'wr_finalizing',
    });

    await expect(markWrapperFinalizing(storage, 'wr_stale')).resolves.toBeNull();
    await expect(markWrapperFinalizing(storage, 'wr_finalizing')).resolves.toMatchObject({
      finalizingWrapperRunId: 'wr_finalizing',
    });
  });

  it('preserves run-level finalizing while refreshing liveness output', async () => {
    const storage = createMemoryStorage();
    await storage.put('wrapper_runtime_state', {
      wrapperGeneration: 2,
      wrapperConnectionId: 'conn_housekeeping',
      wrapperRunId: 'wr_housekeeping',
      finalizingWrapperRunId: 'wr_housekeeping',
      wrapperIdleDeadlineAt: 3_000,
    });

    await recordMeaningfulWrapperOutput(storage, 2, 'conn_housekeeping', 1_500, 4_000, 5_000);

    await expect(getWrapperRuntimeState(storage)).resolves.toMatchObject({
      finalizingWrapperRunId: 'wr_housekeeping',
      lastWrapperMessageAt: 1_500,
      noOutputDeadlineAt: 5_000,
      nextPingAt: 4_000,
      wrapperIdleDeadlineAt: 3_000,
    });
  });

  it('does not clear finalizing when an acceptance write races after complete', async () => {
    const storage = createMemoryStorage();
    const allocated = {
      wrapperGeneration: 2,
      wrapperConnectionId: 'conn_new_work',
      wrapperRunId: 'wr_new_work',
      finalizingWrapperRunId: 'wr_new_work',
      wrapperIdleDeadlineAt: 3_000,
    };
    await storage.put('wrapper_runtime_state', allocated);

    await recordWrapperAcceptedMessage(storage, allocated, 5_000, 4_000);

    await expect(getWrapperRuntimeState(storage)).resolves.toMatchObject({
      finalizingWrapperRunId: 'wr_new_work',
      noOutputDeadlineAt: 5_000,
      nextPingAt: 4_000,
    });
  });

  it.each(['stop_needed', 'stopping'] as const)(
    'holds delivery while physical cleanup is %s',
    state => {
      const runtime = { wrapperGeneration: 2 };
      const lease =
        state === 'stop_needed'
          ? reduceWrapperLease(emptyWrapperLease(), {
              type: 'request_stop',
              target: { kind: 'session' },
              reason: 'terminal-failed',
              now: 1_000,
            })
          : reduceWrapperLease(
              reduceWrapperLease(emptyWrapperLease(), {
                type: 'request_stop',
                target: { kind: 'session' },
                reason: 'terminal-failed',
                now: 1_000,
              }),
              {
                type: 'begin_stop_attempt',
                attemptId: 'attempt',
                now: 1_000,
                attemptDeadlineAt: 2_000,
              }
            );

      expect(isWrapperDeliveryHeld(runtime, lease)).toBe(true);
      expect(isWrapperDeliveryHeld(runtime, emptyWrapperLease())).toBe(false);
    }
  );

  it('validates the separately persisted physical ownership record', async () => {
    const storage = createMemoryStorage();
    await expect(getWrapperLease(storage)).resolves.toEqual(emptyWrapperLease());

    const owned = reduceWrapperLease(emptyWrapperLease(), {
      type: 'allocate',
      instance,
      startupDeadlineAt: 2_000,
    });
    await putWrapperLease(storage, owned);
    await expect(getWrapperLease(storage)).resolves.toEqual(owned);
  });

  it('repairs an invalid persisted lease into a durable cleanup quarantine', async () => {
    const storage = createMemoryStorage();
    await storage.put('wrapper_lease', {
      state: 'owns_wrapper',
      nextInstanceGeneration: 2,
    });

    const repaired = await getWrapperLease(storage);

    expect(repaired).toMatchObject({
      state: 'stop_needed',
      nextInstanceGeneration: 2,
      target: { kind: 'session' },
      reason: 'observation-failed',
      attempts: 5,
      lastError: 'Invalid persisted wrapper lease',
      exhaustedAt: expect.any(Number),
    });
    expect(isWrapperDeliveryHeld(emptyWrapperRuntimeState(), repaired)).toBe(true);
    expect(nextWrapperCleanupDeadline(repaired)).toBeUndefined();
    await expect(getWrapperLease(storage)).resolves.toEqual(repaired);
  });
});
