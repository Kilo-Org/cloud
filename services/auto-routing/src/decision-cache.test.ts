import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassifierOutput } from '@kilocode/auto-routing-contracts/classifier';
import {
  AutoRoutingDecisionCacheDO,
  clearClassificationHotCache,
  putCachedClassification,
  putStickyDecision,
  readConversationState,
} from './decision-cache';
import { MirrorPayloadSchema } from '@kilocode/auto-routing-contracts';
import { buildClassifierUsage } from './classifier-usage';

const fetchMock = vi.fn<typeof fetch>();
const writerEnv = {
  KILO_WEB_API_BASE_URL: 'https://web.example.test',
  INTERNAL_API_SECRET_PROD: { get: async () => 'test-secret' },
};

async function classifierUsage() {
  return buildClassifierUsage(
    MirrorPayloadSchema.parse({
      userId: 'user-1',
      organizationId: null,
      sessionId: 'session-1',
      machineId: null,
      clientRequestId: null,
      mode: null,
      userAgent: null,
      bodyBytes: 10,
      input: {
        apiKind: 'chat_completions',
        requestedModel: 'kilo-auto/efficient',
        systemPromptPrefix: null,
        userPromptPrefix: 'Test request',
        latestUserPromptPrefix: null,
        messageCount: 1,
        hasTools: false,
        stream: false,
        providerHints: { provider: null, providerOptions: null },
      },
    }),
    {
      conversationKey: 'conversation-1',
      classifierModel: 'test/classifier',
      contentHash: 'hash',
      kind: 'sync',
      requestStart: 'request-start',
    },
    0.000013,
    new Date().toISOString()
  );
}

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
    writerEnv as Env
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
  const readRpc = vi.fn((key: string) => invoke(() => cacheDO.readConversationState(key)));
  const stub = {
    readConversationState: readRpc,
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
  const readState = () => readConversationState(env, 'conversation-1', 'hash', 'model');
  return { env, cacheDO, storage, readRpc, readState };
}

beforeEach(() => {
  clearClassificationHotCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-11T12:00:00Z'));
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AutoRoutingDecisionCacheDO', () => {
  it('reads classification and sticky in one storage batch', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.putEntry('model:hash', classification);
    await cacheDO.putEntry('sticky', { model: 'mid/chat', variant: null, routeKey: null });
    storage.get.mockClear();
    storage.put.mockClear();
    storage.delete.mockClear();

    const state = await cacheDO.readConversationState('model:hash');

    expect(state.classification?.value).toEqual(classification);
    expect(state.sticky).toEqual({ model: 'mid/chat', variant: null, routeKey: null });
    expect(storage.get).toHaveBeenCalledExactlyOnceWith(['model:hash', 'sticky']);
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('expires cached decisions after the cache TTL', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.putEntry('model:hash', classification);
    await cacheDO.putEntry('sticky', { model: 'mid/chat', variant: null, routeKey: null });

    vi.advanceTimersByTime(31 * 60 * 1000);

    await expect(cacheDO.readConversationState('model:hash')).resolves.toEqual({
      classification: null,
      sticky: null,
    });
    expect([...storage.entries.keys()]).toEqual(['model:hash', 'sticky']);
  });

  it('ignores expired entries without writing or dropping fresh sticky state', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.putEntry('model:hash', classification);
    vi.advanceTimersByTime(29 * 60 * 1000);
    await cacheDO.putEntry('sticky', { model: 'mid/chat', variant: null, routeKey: null });
    vi.advanceTimersByTime(2 * 60 * 1000);

    await expect(cacheDO.readConversationState('model:hash')).resolves.toEqual({
      classification: null,
      sticky: { model: 'mid/chat', variant: null, routeKey: null },
    });
    expect([...storage.entries.keys()]).toEqual(['model:hash', 'sticky']);
  });

  it('schedules a sweep alarm only when none is pending', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.putEntry('model:old', classification);
    const firstAlarm = await storage.getAlarm();
    expect(firstAlarm).not.toBeNull();

    vi.advanceTimersByTime(60 * 1000);
    await cacheDO.putEntry('model:hash', classification);
    await expect(storage.getAlarm()).resolves.toBe(firstAlarm);
  });

  it('sweeps expired entries and reschedules while live entries remain', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.putEntry('model:old', classification);
    vi.advanceTimersByTime(31 * 60 * 1000);
    await cacheDO.putEntry('model:fresh', classification);

    storage.clearAlarmForTest();
    await cacheDO.alarm();

    expect([...storage.entries.keys()]).toEqual(['model:fresh']);
    await expect(storage.getAlarm()).resolves.not.toBeNull();
  });

  it('stops rescheduling once the sweep leaves no entries', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.putEntry('model:old', classification);
    vi.advanceTimersByTime(31 * 60 * 1000);

    storage.clearAlarmForTest();
    await cacheDO.alarm();

    expect(storage.entries.size).toBe(0);
    await expect(storage.getAlarm()).resolves.toBeNull();
  });
});

describe('classifier usage retries', () => {
  it('persists before delivery and retries failures with the same event until recorded', async () => {
    const { cacheDO, storage } = createCacheDO();
    const usage = await classifierUsage();
    const key = `usage:${usage.core.id}`;
    fetchMock.mockImplementationOnce(async () => {
      expect(storage.entries.has(key)).toBe(true);
      throw new Error('connection lost');
    });
    await cacheDO.recordClassifierUsage(usage);
    expect(storage.entries.get(key)).toMatchObject({ usage, attempts: 1 });
    await expect(storage.getAlarm()).resolves.toBe(Date.now() + 1000);

    fetchMock.mockResolvedValueOnce(Response.json({ status: 'not_recorded', result: null }));
    vi.advanceTimersByTime(1000);
    storage.clearAlarmForTest();
    await cacheDO.alarm();
    expect(storage.entries.get(key)).toMatchObject({ attempts: 2 });
    await expect(storage.getAlarm()).resolves.toBe(Date.now() + 2000);

    fetchMock.mockResolvedValueOnce(
      Response.json({
        status: 'recorded',
        result: {
          usageId: usage.core.id,
          createdAt: usage.core.created_at,
          newMicrodollarsUsed: usage.core.cost,
        },
      })
    );
    vi.advanceTimersByTime(2000);
    storage.clearAlarmForTest();
    await cacheDO.alarm();
    expect(storage.entries.has(key)).toBe(false);
    await expect(storage.getAlarm()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String(init?.body))).toEqual(usage);
    }
  });

  it('accepts duplicate acknowledgement after a lost recorded response and stops retries', async () => {
    const { cacheDO, storage } = createCacheDO();
    const usage = await classifierUsage();
    fetchMock.mockRejectedValueOnce(new Error('response lost after commit'));
    await cacheDO.recordClassifierUsage(usage);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        status: 'duplicate',
        result: {
          usageId: usage.core.id,
          createdAt: usage.core.created_at,
          newMicrodollarsUsed: null,
        },
      })
    );
    vi.advanceTimersByTime(1000);
    storage.clearAlarmForTest();
    await cacheDO.alarm();
    expect(storage.entries.has(`usage:${usage.core.id}`)).toBe(false);
    vi.advanceTimersByTime(60 * 60 * 1000);
    storage.clearAlarmForTest();
    await cacheDO.alarm();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(storage.getAlarm()).resolves.toBeNull();
  });

  it('multiplexes retries and TTL sweeps without expiring usage events', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.putEntry('model:hash', classification);
    const sweepAt = Date.now() + 30 * 60 * 1000;
    const usage = await classifierUsage();
    fetchMock.mockResolvedValue(Response.json({ status: 'not_recorded', result: null }));
    await cacheDO.recordClassifierUsage(usage);
    await expect(storage.getAlarm()).resolves.toBe(Date.now() + 1000);

    const key = `usage:${usage.core.id}`;
    const retryAt = Date.now() + 40 * 60 * 1000;
    storage.entries.set(key, {
      usage,
      attempts: 1,
      firstAttemptAt: Date.now(),
      nextAttemptAt: retryAt,
    });
    storage.clearAlarmForTest();
    vi.setSystemTime(sweepAt);
    await cacheDO.alarm();
    expect(storage.entries.has('model:hash')).toBe(false);
    expect(storage.entries.has(key)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(storage.getAlarm()).resolves.toBe(retryAt);

    vi.setSystemTime(retryAt);
    storage.clearAlarmForTest();
    await cacheDO.alarm();
    expect(storage.entries.get(key)).toMatchObject({ attempts: 2, usage });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(storage.getAlarm()).resolves.toBe(retryAt + 2000);
  });

  it('logs and removes writes still unavailable at the retry horizon', async () => {
    const { cacheDO, storage } = createCacheDO();
    const usage = await classifierUsage();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(Response.json({ status: 'not_recorded', result: null }));
    await cacheDO.recordClassifierUsage(usage);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    storage.clearAlarmForTest();
    await cacheDO.alarm();
    expect(storage.entries.has(`usage:${usage.core.id}`)).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('\"event\":\"auto_routing_classifier_usage_dropped\"')
    );
    await expect(storage.getAlarm()).resolves.toBeNull();
  });
});

describe('conversation state', () => {
  it('rejects older sticky writes without dropping their classification', async () => {
    const { env, readState } = createCacheEnv();
    const older = Date.now();
    vi.advanceTimersByTime(1);
    const newer = Date.now();
    await putStickyDecision(env, 'conversation-1', 'new/chat', null, 'new/route', newer);
    await putStickyDecision(env, 'conversation-1', 'old/chat', null, 'old/route', older);
    await putCachedClassification(env, 'conversation-1', 'hash', 'model', classification);
    const state = await readState();
    expect(state.sticky?.model).toBe('new/chat');
    expect(state.classification).toEqual(classification);
  });

  it('accepts the last sticky write when request start times are equal', async () => {
    const { env, readState } = createCacheEnv();
    const generation = Date.now();
    await putStickyDecision(env, 'conversation-1', 'first/chat', null, 'first/route', generation);
    await putStickyDecision(env, 'conversation-1', 'last/chat', null, 'last/route', generation);
    expect((await readState()).sticky?.model).toBe('last/chat');
  });

  it('does not write when reading a conversation', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.readConversationState('model:hash');
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('makes exactly one RPC on each cold and hot read', async () => {
    const { cacheDO, readRpc, readState } = createCacheEnv();
    await cacheDO.putEntry('model:hash', classification);

    expect((await readState()).classification).toEqual(classification);
    expect(readRpc).toHaveBeenCalledTimes(1);
    expect((await readState()).classification).toEqual(classification);
    expect(readRpc).toHaveBeenCalledTimes(2);
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

    const state = await readConversationState(second.env, 'conversation-2', 'hash', 'model');

    expect(state).toEqual({ classification, sticky: null });
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
      (await readConversationState(env, 'conversation-1', 'hash', 'other-model')).classification
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

    expect(await readState()).toEqual({
      classification: null,
      sticky: { model: 'mid/chat', variant: null, routeKey: 'implementation/code_generation' },
    });
  });

  it('returns null for invalid sticky shapes while keeping valid classification', async () => {
    const { env, storage, readState } = createCacheEnv();
    await putCachedClassification(env, 'conversation-1', 'hash', 'model', classification);
    storage.entries.set('sticky', { value: { nope: true }, storedAt: Date.now() });

    expect(await readState()).toEqual({
      classification,
      sticky: null,
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

    await expect(readState()).resolves.toEqual({
      classification: null,
      sticky: null,
    });
  });
});
