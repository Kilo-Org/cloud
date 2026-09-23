import { describe, expect, it } from 'vitest';
import {
  ALLOCATION_KEY,
  eraseAllocation,
  storeAllocation,
  storeSession,
  type ErasableStorage,
} from './store.js';
import {
  isAllocationRecordKey,
  readSessionValueFrom,
  writeAllocationRecord,
  writeSessionValue,
} from './access.js';
import { loadAllocation, loadSession } from './load.js';
import { initialAllocationRecord } from '../model/allocation.js';
import type { SessionAggregate } from '../model/session.js';

function memoryStorage(): ErasableStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string): Promise<T | undefined> => data.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      data.set(key, value);
    },
    delete: async (keys: readonly string[]) => {
      let deleted = 0;
      for (const key of keys) if (data.delete(key)) deleted += 1;
      return deleted;
    },
  };
}

const SESSION: SessionAggregate = {
  binding: { kind: 'bound', handle: { incarnation: 'inc-1', wrapper: 'w-1', epoch: 3 } },
  messages: [
    {
      messageId: 'm1',
      state: {
        kind: 'queued',
        intent: {
          turn: { type: 'prompt', messageId: 'm1', prompt: 'hello' },
          agent: { mode: 'code', model: 'm' },
        },
        queuedAt: 90,
        deliveryStep: 'preparing',
        deadlineAt: 123,
        attachFailures: 1,
        promptFailures: 0,
      },
      cancellation: { operationId: 'cancel-1', deadlineAt: 130 },
      proofs: {
        attach: {
          authorization: {
            operation: 'session.attach',
            operationId: 'op-1',
            messageId: 'm1',
            session: { sessionId: 's', kiloSessionId: 'k', directory: '/d' },
            wrapperInstanceId: 'w-1',
            dispatchDeadlineAt: 100,
          },
          dispatched: true,
          attachmentEpoch: 1,
        },
      },
    },
  ],
};

describe('canonical store', () => {
  it('stores the allocation record as-is under the canonical key', async () => {
    const storage = memoryStorage();
    const record = initialAllocationRecord(true);
    await storeAllocation(storage, record);
    expect(storage.data.get(ALLOCATION_KEY)).toEqual(record);
  });

  it('stores the session aggregate as a {v:2} envelope', async () => {
    const storage = memoryStorage();
    await storeSession(storage, SESSION);
    expect(readSessionValueFrom(storage.data)).toEqual({ v: 2, ...SESSION });
  });

  it('allocation store→load round-trip is identity', async () => {
    const storage = memoryStorage();
    const record = initialAllocationRecord(false);
    await storeAllocation(storage, record);
    const loaded = await loadAllocation(storage);
    expect(loaded).toEqual({ ok: true, source: 'canonical', value: record });
  });

  it('session store→load round-trip is identity', async () => {
    const storage = memoryStorage();
    await storeSession(storage, SESSION);
    const loaded = await loadSession(storage);
    expect(loaded).toEqual({ ok: true, source: 'canonical', value: SESSION });
  });

  it('session store→load preserves a terminal acceptedAt and retained identity', async () => {
    const terminal: SessionAggregate = {
      binding: { kind: 'unbound' },
      messages: [
        {
          messageId: 'm1',
          state: {
            kind: 'completed',
            intent: null,
            legacyInvalidIntent: true,
            acceptedAt: 50,
            at: 60,
            source: 'wrapper_outcome',
            wrapperInstanceId: 'w-1',
            preparationAttemptId: 'attempt-1',
            gateResult: 'pass',
          },
        },
      ],
    };
    const storage = memoryStorage();
    await storeSession(storage, terminal);
    const loaded = await loadSession(storage);
    expect(loaded).toEqual({ ok: true, source: 'canonical', value: terminal });
  });

  it('session store→load round-trips a failed state carrying bounded assistant facts', async () => {
    const terminal: SessionAggregate = {
      binding: { kind: 'unbound' },
      messages: [
        {
          messageId: 'm1',
          state: {
            kind: 'failed',
            intent: null,
            legacyInvalidIntent: true,
            acceptedAt: 50,
            at: 60,
            source: 'wrapper_outcome',
            reason: 'rate limited',
            assistantReason: 'rate_limited',
            providerOwnership: 'unknown',
          },
        },
      ],
    };
    const storage = memoryStorage();
    await storeSession(storage, terminal);
    const loaded = await loadSession(storage);
    expect(loaded).toEqual({ ok: true, source: 'canonical', value: terminal });
  });

  it('eraseAllocation deletes both allocation keys and leaves the session alone', async () => {
    const storage = memoryStorage();
    await storage.put(ALLOCATION_KEY, initialAllocationRecord(true));
    await writeAllocationRecord(storage, { state: 'running', providerRef: 'ref' });
    await writeSessionValue(storage, { v: 2, binding: { kind: 'unbound' }, messages: [] });
    await eraseAllocation(storage);
    expect(storage.data.has(ALLOCATION_KEY)).toBe(false);
    expect([...storage.data.keys()].some(isAllocationRecordKey)).toBe(false);
    expect(readSessionValueFrom(storage.data)).toBeDefined();
  });

  it('erasing both allocation keys blocks legacy fallback: a later load is first boot', async () => {
    const storage: ErasableStorage & { data: Map<string, unknown> } = memoryStorage();
    await writeAllocationRecord(storage, {
      state: 'running',
      providerRef: 'ref',
      createIntent: { intentId: 'i', createdAt: 1 },
      stopTombstone: null,
      resumable: true,
    });
    await eraseAllocation(storage);
    const loaded = await loadAllocation(storage, true);
    expect(loaded).toEqual({
      ok: true,
      source: 'initial',
      value: { v: 2, resumable: true, state: { kind: 'stopped', summary: null } },
    });
  });
});
