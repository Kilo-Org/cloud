import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassifierOutput } from '@kilocode/auto-routing-contracts/classifier';
import { AutoRoutingDecisionCacheDO, getStickyDecision, putStickyDecision } from './decision-cache';

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
    get: async (key: string) => entries.get(key),
    put: async (key: string, value: unknown) => {
      entries.set(key, value);
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        entries.delete(key);
      }
    },
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

describe('AutoRoutingDecisionCacheDO', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves stored entries until they expire', async () => {
    const { cacheDO } = createCacheDO();
    await cacheDO.putEntry('model:hash', classification);

    await expect(cacheDO.getEntry('model:hash')).resolves.toEqual(classification);

    vi.advanceTimersByTime(31 * 60 * 1000);
    await expect(cacheDO.getEntry('model:hash')).resolves.toBeNull();
  });

  it('schedules a sweep alarm only when none is pending', async () => {
    const { cacheDO, storage } = createCacheDO();
    await cacheDO.putEntry('model:hash-1', classification);
    const firstAlarm = await storage.getAlarm();
    expect(firstAlarm).not.toBeNull();

    vi.advanceTimersByTime(60 * 1000);
    await cacheDO.putEntry('model:hash-2', classification);
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

describe('sticky decision storage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createStickyEnv() {
    const { cacheDO, storage } = createCacheDO();
    const env = {
      AUTO_ROUTING_DECISION_CACHE: {
        idFromName: (name: string) => name,
        get: () => cacheDO,
      },
    } as unknown as Pick<Env, 'AUTO_ROUTING_DECISION_CACHE'>;
    return { env, cacheDO, storage };
  }

  it('round-trips the sticky model for a conversation', async () => {
    const { env } = createStickyEnv();
    await expect(getStickyDecision(env, 'conversation-1')).resolves.toBeNull();

    await putStickyDecision(env, 'conversation-1', 'mid/chat');
    await expect(getStickyDecision(env, 'conversation-1')).resolves.toBe('mid/chat');
  });

  it('expires sticky entries after the TTL', async () => {
    const { env } = createStickyEnv();
    await putStickyDecision(env, 'conversation-1', 'mid/chat');

    vi.advanceTimersByTime(31 * 60 * 1000);
    await expect(getStickyDecision(env, 'conversation-1')).resolves.toBeNull();
  });

  it('returns null for invalid stored shapes', async () => {
    const { env, cacheDO } = createStickyEnv();
    await cacheDO.putEntry('sticky', { nope: true } as unknown as ClassifierOutput);

    await expect(getStickyDecision(env, 'conversation-1')).resolves.toBeNull();
  });
});
