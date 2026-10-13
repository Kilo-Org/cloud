import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassifierOutput } from '@kilocode/auto-routing-contracts/classifier';
import {
  AutoRoutingDecisionCacheDO,
  addPendingClassifierCost,
  clearClassificationHotCache,
  putCachedClassification,
  putStickyDecision,
  readConversationState,
} from './decision-cache';

const classification = {
  taskType: 'implementation',
  subtaskType: 'feature_development',
  contextComplexity: 'medium',
  reasoningComplexity: 'medium',
  riskLevel: 'low',
  executionMode: 'code_change',
  requiresTools: true,
  confidence: 0.82,
} satisfies ClassifierOutput;

function createFakeStorage() {
  const entries = new Map<string, unknown>();
  let alarm: number | null = null;

  return {
    entries,
    getAlarm: async () => alarm,
    setAlarm: async (time: number) => {
      alarm = time;
    },
    clearAlarmForTest: () => {
      alarm = null;
    },
    get: vi.fn(async (key: string | string[]) => {
      if (Array.isArray(key)) {
        return new Map(key.filter(k => entries.has(k)).map(k => [k, entries.get(k)]));
      }
      return entries.get(key);
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      entries.set(key, value);
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        entries.delete(key);
      }
    }),
    list: async () => new Map(entries),
  };
}

function createCacheDO() {
  const storage = createFakeStorage();
  const cacheDO = new AutoRoutingDecisionCacheDO(
    { storage } as unknown as DurableObjectState,
    {} as Env
  );
  return { cacheDO, storage };
}

function createCacheEnv() {
  const { cacheDO, storage } = createCacheDO();
  let inputGate = Promise.resolve();
  // Node's DurableObject stub has no input gates; serialize storage-only RPCs as the runtime does.
  function invoke<T>(call: () => Promise<T>): Promise<T> {
    const result = inputGate.then(call);
    inputGate = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
  const readRpc = vi.fn((key: string, consumePendingCost: boolean) =>
    invoke(() => cacheDO.readConversationState(key, consumePendingCost))
  );
  const stub = {
    readConversationState: readRpc,
    addPendingClassifierCost: (usd: number) => invoke(() => cacheDO.addPendingClassifierCost(usd)),
    putStickyDecision: (
      value: Parameters<AutoRoutingDecisionCacheDO['putStickyDecision']>[0],
      generation: number
    ) => invoke(() => cacheDO.putStickyDecision(value, generation)),
    putEntry: (key: string, value: Parameters<AutoRoutingDecisionCacheDO['putEntry']>[1]) =>
      invoke(() => cacheDO.putEntry(key, value)),
  };
  const env = {
    AUTO_ROUTING_DECISION_CACHE: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
  } as unknown as Pick<Env, 'AUTO_ROUTING_DECISION_CACHE'>;
  const readState = (consumePendingCost = false) =>
    readConversationState(env, 'conversation-1', 'hash', 'model', { consumePendingCost });
  return { env, cacheDO, storage, readRpc, readState };
}

beforeEach(() => {
  clearClassificationHotCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-11T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AutoRoutingDecisionCacheDO', () => {
  it('reads classification, sticky, and pending cost in one storage batch', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.putEntry('model:hash', classification);
    await cacheDO.putEntry('sticky', { model: 'mid/chat', variant: null, routeKey: null });
    await cacheDO.addPendingClassifierCost(0.03);
    storage.get.mockClear();
    storage.put.mockClear();
    storage.delete.mockClear();

    const state = await cacheDO.readConversationState('model:hash', false);

    expect(state.classification?.value).toEqual(classification);
    expect(state.sticky).toEqual({ model: 'mid/chat', variant: null, routeKey: null });
    expect(state.pendingCostUsd).toBe(0.03);
    expect(storage.get).toHaveBeenCalledExactlyOnceWith(['model:hash', 'sticky', 'pending-cost']);
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('expires cached decisions while retaining pending cost beyond the cache TTL', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.putEntry('model:hash', classification);
    await cacheDO.putEntry('sticky', { model: 'mid/chat', variant: null, routeKey: null });
    await cacheDO.addPendingClassifierCost(0.03);

    vi.advanceTimersByTime(31 * 60 * 1000);

    await expect(cacheDO.readConversationState('model:hash', false)).resolves.toEqual({
      classification: null,
      sticky: null,
      pendingCostUsd: 0.03,
    });
    expect([...storage.entries.keys()]).toEqual(['model:hash', 'sticky', 'pending-cost']);
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
    expect((await cacheDO.readConversationState('model:hash', true)).pendingCostUsd).toBeNull();
  });

  it('ignores expired entries on read without writing or dropping fresh sticky state or cost', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.putEntry('model:hash', classification);
    vi.advanceTimersByTime(29 * 60 * 1000);
    await cacheDO.putEntry('sticky', { model: 'mid/chat', variant: null, routeKey: null });
    await cacheDO.addPendingClassifierCost(0.03);
    vi.advanceTimersByTime(2 * 60 * 1000);

    await expect(cacheDO.readConversationState('model:hash', false)).resolves.toEqual({
      classification: null,
      sticky: { model: 'mid/chat', variant: null, routeKey: null },
      pendingCostUsd: 0.03,
    });
    expect([...storage.entries.keys()]).toEqual(['model:hash', 'sticky', 'pending-cost']);
  });

  it('schedules a sweep alarm only when none is pending', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.addPendingClassifierCost(0.03);
    const firstAlarm = await storage.getAlarm();
    expect(firstAlarm).not.toBeNull();

    vi.advanceTimersByTime(60 * 1000);
    await cacheDO.putEntry('model:hash', classification);
    await expect(storage.getAlarm()).resolves.toBe(firstAlarm);
  });

  it('retains unpaid cost during cache sweeps and reschedules while live entries remain', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.putEntry('model:old', classification);
    await cacheDO.addPendingClassifierCost(0.03);
    vi.advanceTimersByTime(31 * 60 * 1000);
    await cacheDO.putEntry('model:fresh', classification);

    storage.clearAlarmForTest();
    await cacheDO.alarm();

    expect([...storage.entries.keys()]).toEqual(['pending-cost', 'model:fresh']);
    await expect(storage.getAlarm()).resolves.not.toBeNull();
  });

  it('stops rescheduling once the sweep leaves no entries', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.addPendingClassifierCost(0.03);
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1);

    storage.clearAlarmForTest();
    await cacheDO.alarm();

    expect(storage.entries.size).toBe(0);
    await expect(storage.getAlarm()).resolves.toBeNull();
  });
});

describe('conversation state', () => {
  it('rejects older sticky writes without dropping their classification or pending cost', async () => {
    const { env, readState } = createCacheEnv();
    const older = Date.now();
    vi.advanceTimersByTime(1);
    const newer = Date.now();
    await putStickyDecision(env, 'conversation-1', 'new/chat', null, 'new/route', newer);
    await putStickyDecision(env, 'conversation-1', 'old/chat', null, 'old/route', older);
    await putCachedClassification(env, 'conversation-1', 'hash', 'model', classification);
    await addPendingClassifierCost(env, 'conversation-1', 0.03);
    const state = await readState(true);
    expect(state.sticky?.model).toBe('new/chat');
    expect(state.classification).toEqual(classification);
    expect(state.pendingCostUsd).toBe(0.03);
  });

  it('accepts the last sticky write when request start times are equal', async () => {
    const { env, readState } = createCacheEnv();
    const generation = Date.now();
    await putStickyDecision(env, 'conversation-1', 'first/chat', null, 'first/route', generation);
    await putStickyDecision(env, 'conversation-1', 'last/chat', null, 'last/route', generation);
    expect((await readState()).sticky?.model).toBe('last/chat');
  });

  it('does not write when reading a conversation without pending cost', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.readConversationState('model:hash', true);
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('keeps unpaid cost across the cache TTL when adding another increment', async () => {
    const { env, cacheDO, readState } = createCacheEnv();
    await addPendingClassifierCost(env, 'conversation-1', 0.03);
    vi.advanceTimersByTime(31 * 60 * 1000);
    await cacheDO.alarm();
    await addPendingClassifierCost(env, 'conversation-1', 0.02);
    expect((await readState(true)).pendingCostUsd).toBe(0.05);
  });

  it('makes exactly one RPC on each cold and hot read', async () => {
    const { cacheDO, readRpc, readState } = createCacheEnv();
    await cacheDO.putEntry('model:hash', classification);

    expect((await readState()).classification).toEqual(classification);
    expect(readRpc).toHaveBeenCalledTimes(1);
    expect((await readState()).classification).toEqual(classification);
    expect(readRpc).toHaveBeenCalledTimes(2);
  });

  it('consumes pending cost exactly once under concurrent reads', async () => {
    const { env, readState, storage } = createCacheEnv();
    await addPendingClassifierCost(env, 'conversation-1', 0.03);

    const states = await Promise.all([readState(true), readState(true)]);

    expect(states.map(state => state.pendingCostUsd).sort()).toEqual([0, 0.03]);
    expect(storage.entries.has('pending-cost')).toBe(false);
    expect((await readState(true)).pendingCostUsd).toBe(0);
  });

  it('adds concurrent increments and preserves cost until a consumer claims it', async () => {
    const { env, readState } = createCacheEnv();
    await Promise.all([
      addPendingClassifierCost(env, 'conversation-1', 0.02),
      addPendingClassifierCost(env, 'conversation-1', 0.03),
      addPendingClassifierCost(env, 'conversation-1', 0.04),
    ]);

    expect((await readState()).pendingCostUsd).toBeCloseTo(0.09);
    expect((await readState(true)).pendingCostUsd).toBeCloseTo(0.09);
    expect((await readState(true)).pendingCostUsd).toBe(0);
  });

  it('does not carry expired pending cost into a new increment', async () => {
    const { env, readState } = createCacheEnv();
    await addPendingClassifierCost(env, 'conversation-1', 0.03);
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1);
    await addPendingClassifierCost(env, 'conversation-1', 0.02);

    expect((await readState(true)).pendingCostUsd).toBe(0.02);
  });

  it('serves a hot classification while reading the latest sticky from storage', async () => {
    const { env, storage, readState } = createCacheEnv();
    await putCachedClassification(env, 'conversation-1', 'hash', 'model', classification);
    await putStickyDecision(
      env,
      'conversation-1',
      'mid/chat',
      'thinking',
      'implementation/code_generation',
      1
    );
    storage.entries.delete('model:hash');

    expect(await readState()).toEqual({
      classification,
      sticky: {
        model: 'mid/chat',
        variant: 'thinking',
        routeKey: 'implementation/code_generation',
      },
      pendingCostUsd: 0,
    });

    await putStickyDecision(
      env,
      'conversation-1',
      'other/chat',
      null,
      'implementation/code_generation',
      2
    );
    expect((await readState()).sticky?.model).toBe('other/chat');
  });

  it('reuses content-addressed classifications across conversations but not sticky state', async () => {
    const first = createCacheEnv();
    const second = createCacheEnv();
    await putCachedClassification(first.env, 'conversation-1', 'hash', 'model', classification);
    await putStickyDecision(
      first.env,
      'conversation-1',
      'mid/chat',
      null,
      'implementation/code_generation',
      1
    );

    const state = await readConversationState(second.env, 'conversation-2', 'hash', 'model', {
      consumePendingCost: false,
    });

    expect(state).toEqual({ classification, sticky: null, pendingCostUsd: 0 });
    expect(second.readRpc).toHaveBeenCalledTimes(1);
  });

  it('populates the hot cache on a DO hit without extending the stored TTL', async () => {
    const { cacheDO, storage, readState } = createCacheEnv();
    await cacheDO.putEntry('model:hash', classification);
    vi.advanceTimersByTime(29 * 60 * 1000);
    expect((await readState()).classification).toEqual(classification);
    storage.entries.delete('model:hash');
    expect((await readState()).classification).toEqual(classification);

    vi.advanceTimersByTime(2 * 60 * 1000);
    expect((await readState()).classification).toBeNull();
  });

  it('expires classifications cached by a write and separates classifier models', async () => {
    const { env, storage, readState } = createCacheEnv();
    await putCachedClassification(env, 'conversation-1', 'hash', 'model', classification);
    storage.entries.delete('model:hash');
    expect((await readState()).classification).toEqual(classification);
    expect(
      (
        await readConversationState(env, 'conversation-1', 'hash', 'other-model', {
          consumePendingCost: false,
        })
      ).classification
    ).toBeNull();

    vi.advanceTimersByTime(31 * 60 * 1000);
    expect((await readState()).classification).toBeNull();
  });

  it('validates each stored value independently for rolling deploys', async () => {
    const { env, storage, readState } = createCacheEnv();
    await putStickyDecision(
      env,
      'conversation-1',
      'mid/chat',
      null,
      'implementation/code_generation',
      1
    );
    storage.entries.set('model:hash', { value: { nope: true }, storedAt: Date.now() });
    storage.entries.set('pending-cost', { value: 'invalid', storedAt: Date.now() });

    expect(await readState(true)).toEqual({
      classification: null,
      sticky: { model: 'mid/chat', variant: null, routeKey: 'implementation/code_generation' },
      pendingCostUsd: 0,
    });
    expect(storage.entries.has('pending-cost')).toBe(false);
  });

  it('returns null for invalid sticky shapes while keeping valid classification and cost', async () => {
    const { env, storage, readState } = createCacheEnv();
    await putCachedClassification(env, 'conversation-1', 'hash', 'model', classification);
    await addPendingClassifierCost(env, 'conversation-1', 0.03);
    storage.entries.set('sticky', { value: { nope: true }, storedAt: Date.now() });

    expect(await readState(true)).toEqual({
      classification,
      sticky: null,
      pendingCostUsd: 0.03,
    });
  });

  it('serves sticky entries written before routeKey and variant existed', async () => {
    const { storage, readState } = createCacheEnv();
    storage.entries.set('sticky', { value: { model: 'mid/chat' }, storedAt: Date.now() });

    expect((await readState()).sticky).toEqual({
      model: 'mid/chat',
      routeKey: null,
      variant: null,
    });
  });

  it('returns empty state on RPC errors even when a classification is hot', async () => {
    const { env, readRpc, readState } = createCacheEnv();
    await putCachedClassification(env, 'conversation-1', 'hash', 'model', classification);
    readRpc.mockRejectedValueOnce(new Error('DO unavailable'));

    await expect(readState(true)).resolves.toEqual({
      classification: null,
      sticky: null,
      pendingCostUsd: 0,
    });
  });
});
