import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecordCloudAgentSessionHarnessParams } from '@kilocode/session-ingest-contracts';
import {
  createRuntimeHarnessRecorder,
  RUNTIME_HARNESS_MAX_ATTEMPTS,
  RUNTIME_HARNESS_RETRY_MS,
} from './runtime-harness-record.js';

vi.mock('../../logger.js', () => ({
  logger: { warn: vi.fn(), withFields: () => ({ warn: vi.fn() }) },
}));

const update = {
  sessionId: `ses_${'a'.repeat(26)}`,
  kiloUserId: 'oauth/harness-test',
  cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  runtimeHarness: 'kilo2',
} satisfies RecordCloudAgentSessionHarnessParams;

function fixture() {
  const values = new Map<string, unknown>();
  const storage = {
    kv: {
      get: (key: string) => values.get(key),
      put: (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
      delete: (key: string) => values.delete(key),
    },
  } as Pick<DurableObjectStorage, 'kv'>;
  const record = vi.fn(async (_update: RecordCloudAgentSessionHarnessParams) => true);
  return { values, storage, record, recorder: createRuntimeHarnessRecorder({ storage, record }) };
}

afterEach(() => vi.useRealTimers());

describe('runtime harness recorder', () => {
  it('skips an invalid session identity without failing delivery or storing a record', async () => {
    const { values, record, recorder } = fixture();
    expect(() =>
      recorder.record({ ...update, sessionId: 'legacy-session-id' }, 1000)
    ).not.toThrow();
    expect(values.size).toBe(0);
    await recorder.repair(1000);
    expect(record).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'unmatched'] as const)(
    'retains an %s record across eviction and acknowledges only a matching write',
    async failure => {
      const { storage, record, recorder } = fixture();
      if (failure === 'unavailable') record.mockRejectedValueOnce(new Error('unavailable'));
      else record.mockResolvedValueOnce(false);
      recorder.record(update, 1000);
      await recorder.repair(1000);
      const rehydrated = createRuntimeHarnessRecorder({ storage, record });
      expect(rehydrated.nextDueAt()).toBe(1000 + RUNTIME_HARNESS_RETRY_MS);
      await rehydrated.repair(1001);
      expect(record).toHaveBeenCalledTimes(1);
      await rehydrated.repair(1000 + RUNTIME_HARNESS_RETRY_MS);
      expect(record).toHaveBeenCalledTimes(2);
      expect(rehydrated.nextDueAt()).toBeNull();
      const acknowledged = createRuntimeHarnessRecorder({ storage, record });
      acknowledged.record(update, 1000 + 2 * RUNTIME_HARNESS_RETRY_MS);
      await acknowledged.repair(1000 + 2 * RUNTIME_HARNESS_RETRY_MS);
      expect(record).toHaveBeenCalledTimes(2);
    }
  );

  it('reserves a retry before external I/O and preserves a newer runtime', async () => {
    const { record, recorder } = fixture();
    const result = Promise.withResolvers<boolean>();
    record.mockReturnValueOnce(result.promise);
    recorder.record(update, 1000);
    const pending = recorder.repair(1000);
    expect(recorder.repair(1000)).toBe(pending);
    expect(recorder.nextDueAt()).toBe(1000 + RUNTIME_HARNESS_RETRY_MS);
    recorder.record({ ...update, runtimeHarness: 'kilo' }, 1001);
    result.resolve(true);
    await pending;
    expect(recorder.nextDueAt()).toBe(1001);
    await recorder.repair(1001);
    expect(record.mock.calls[1]?.[0]).toEqual({ ...update, runtimeHarness: 'kilo' });
    expect(recorder.nextDueAt()).toBeNull();
  });

  it('bounds a hung RPC and retains its retry', async () => {
    vi.useFakeTimers();
    const { record, recorder } = fixture();
    record.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    recorder.record(update, 1000);
    const pending = recorder.repair(1000);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(recorder.nextDueAt()).toBe(1000 + RUNTIME_HARNESS_RETRY_MS);
  });

  it('stops after the retry limit and allows a later delivery to retry', async () => {
    const { values, record, recorder } = fixture();
    record.mockResolvedValue(false);
    recorder.record(update, 1000);
    for (let attempt = 0; attempt <= RUNTIME_HARNESS_MAX_ATTEMPTS; attempt++) {
      await recorder.repair(1000 + attempt * RUNTIME_HARNESS_RETRY_MS);
    }
    expect(record).toHaveBeenCalledTimes(RUNTIME_HARNESS_MAX_ATTEMPTS);
    expect(recorder.nextDueAt()).toBeNull();
    expect(values.size).toBe(0);
    const now = 1000 + (RUNTIME_HARNESS_MAX_ATTEMPTS + 1) * RUNTIME_HARNESS_RETRY_MS;
    recorder.record(update, now);
    record.mockResolvedValue(true);
    await recorder.repair(now);
    expect(record).toHaveBeenCalledTimes(RUNTIME_HARNESS_MAX_ATTEMPTS + 1);
  });

  it('starts a fresh batch when delivery arrives in the final retry window', async () => {
    const { record, recorder } = fixture();
    record.mockResolvedValue(false);
    recorder.record(update, 1000);
    for (let attempt = 0; attempt < RUNTIME_HARNESS_MAX_ATTEMPTS; attempt++) {
      await recorder.repair(1000 + attempt * RUNTIME_HARNESS_RETRY_MS);
    }
    const now = 1001 + (RUNTIME_HARNESS_MAX_ATTEMPTS - 1) * RUNTIME_HARNESS_RETRY_MS;
    expect(recorder.nextDueAt()).toBeGreaterThan(now);
    recorder.record(update, now);
    record.mockResolvedValue(true);
    await recorder.repair(now);
    expect(record).toHaveBeenCalledTimes(RUNTIME_HARNESS_MAX_ATTEMPTS + 1);
    expect(recorder.nextDueAt()).toBeNull();
  });

  it('does not recreate storage after deletion during publication', async () => {
    const { values, record, recorder } = fixture();
    const result = Promise.withResolvers<boolean>();
    record.mockReturnValueOnce(result.promise);
    recorder.record(update, 1000);
    const pending = recorder.repair(1000);
    values.clear();
    result.resolve(true);
    await pending;
    expect(values.size).toBe(0);
  });

  it.each([null, { update }, { update, attempts: -1, dueAt: 0 }])(
    'discards invalid stored state (%j)',
    raw => {
      const { values, recorder } = fixture();
      values.set('session_runtime_harness', raw);
      expect(recorder.nextDueAt()).toBeNull();
      expect(values.size).toBe(0);
    }
  );
});
