import { describe, expect, it } from 'vitest';
import {
  emptyWrapperLease,
  getWrapperLease,
  nextWrapperLeaseDeadline,
  putWrapperLease,
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
    expect(nextWrapperLeaseDeadline(retrying)).toBe(5_200);
  });

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
});
