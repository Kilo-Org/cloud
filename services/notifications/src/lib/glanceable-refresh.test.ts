import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExpoPushMessage } from './expo-push';
import type { ActiveAgentsGlanceable, GlanceableDeliveryDeps } from './glanceable-delivery';
import {
  flushDueGlanceableRefreshes,
  GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
  refreshGlanceableSnapshot,
} from './glanceable-refresh';

/**
 * In-memory `DurableObjectStorage` for the pure refresh unit tests. The DO-level
 * case below runs against the real storage through `runInDurableObject`.
 */
class FakeStorage {
  private readonly entries = new Map<string, unknown>();
  private alarmTime: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.entries.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(key: string | string[]): Promise<boolean> {
    if (Array.isArray(key)) {
      let deleted = false;
      for (const entry of key) deleted = this.entries.delete(entry) || deleted;
      return deleted;
    }
    return this.entries.delete(key);
  }

  async list<T>(options: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.entries) {
      if (options.prefix !== undefined && !key.startsWith(options.prefix)) continue;
      out.set(key, value as T);
      if (options.limit !== undefined && out.size >= options.limit) break;
    }
    return out;
  }

  async transaction<T>(closure: (txn: FakeStorage) => Promise<T>): Promise<T> {
    return closure(this);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmTime;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmTime = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
  }
}

function pendingKey(userId: string, organizationId: string | null): string {
  return `glanceable-pending:${JSON.stringify([userId, organizationId])}`;
}

function deliveryKey(userId: string, organizationId: string | null): string {
  return `glanceable:${JSON.stringify([userId, organizationId])}:delivery`;
}

function snapshot(overrides: Partial<ActiveAgentsGlanceable> = {}): ActiveAgentsGlanceable {
  return {
    type: 'active_agents_glanceable',
    schemaVersion: 1,
    revision: 1,
    scopeKey: 'scope-key',
    organizationBound: false,
    status: 'happy',
    running: 2,
    needsInput: 1,
    needsApproval: 0,
    idle: 0,
    updatedAt: '2026-09-18T00:00:00.000Z',
    expiresAt: '2026-09-18T08:00:00.000Z',
    needsInputSince: null,
    ...overrides,
  };
}

type Harness = {
  storage: FakeStorage;
  deps: GlanceableDeliveryDeps;
  builds: number;
  expoSends: ExpoPushMessage[][];
  iosSends: { token: string; event: string }[][];
  setNext: (next: ActiveAgentsGlanceable | null) => void;
  failNextBuild: (error: Error) => void;
  /** Make the next Expo send throw (a failed transport attempt). */
  failNextExpoPush: (error: Error) => void;
  /** Stall the next Expo send so a second refresh can supersede it mid-flight. */
  blockNextExpoPush: () => { started: Promise<void>; release: () => void };
};

function makeHarness(): Harness {
  const storage = new FakeStorage();
  let next: ActiveAgentsGlanceable | null = snapshot();
  let buildError: Error | null = null;
  let expoError: Error | null = null;
  let expoGate: { gate: Promise<void>; started: () => void } | null = null;

  const harness: Harness = {
    storage,
    builds: 0,
    expoSends: [],
    iosSends: [],
    setNext: value => {
      next = value;
    },
    failNextBuild: error => {
      buildError = error;
    },
    failNextExpoPush: error => {
      expoError = error;
    },
    blockNextExpoPush: () => {
      let release: () => void = () => undefined;
      let started: () => void = () => undefined;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const startedPromise = new Promise<void>(resolve => {
        started = resolve;
      });
      expoGate = { gate, started };
      return { started: startedPromise, release };
    },
    deps: {
      buildSnapshot: async () => {
        harness.builds += 1;
        if (buildError !== null) {
          const error = buildError;
          buildError = null;
          throw error;
        }
        return next;
      },
      listIosActivityTokens: async () => [],
      sendIosLiveActivity: async tokens => {
        harness.iosSends.push(tokens.map(token => ({ ...token })));
      },
      listIosExpoTokens: async () => [],
      listAndroidExpoTokens: async () => [{ token: 'android-token', locale: null }],
      hasAndroidOngoingToken: async () => true,
      sendExpoPush: async messages => {
        harness.expoSends.push(messages);
        if (expoError !== null) {
          const error = expoError;
          expoError = null;
          throw error;
        }
        const gate = expoGate;
        if (gate !== null) {
          expoGate = null;
          gate.started();
          await gate.gate;
        }
      },
    },
  };

  return harness;
}

const asStorage = (storage: FakeStorage) => storage as unknown as DurableObjectStorage;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('refreshGlanceableSnapshot delivery window', () => {
  it('coalesces a change inside the window and delivers it from the trailing flush', async () => {
    const h = makeHarness();
    const base = Date.parse('2026-09-18T00:00:00.000Z');
    let now = base;
    const scope = { userId: 'user-1', organizationId: null };

    h.setNext(snapshot({ running: 1, needsInput: 0 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(h.builds).toBe(1);
    expect(h.expoSends).toHaveLength(1);

    // A change 2s later is inside the 10s window: deferred, not delivered.
    now = base + 2_000;
    h.setNext(snapshot({ running: 2, needsInput: 1 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(h.builds).toBe(1);
    expect(h.expoSends).toHaveLength(1);
    expect(await h.storage.get(pendingKey('user-1', null))).toEqual({
      userId: 'user-1',
      organizationId: null,
      dueAt: base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
    });
    expect(await h.storage.getAlarm()).toBe(base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS);

    // The trailing flush at the deadline delivers the newer counts.
    now = base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS;
    await expect(
      flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now)
    ).resolves.toBeNull();
    expect(h.expoSends).toHaveLength(2);
    expect(h.expoSends[1][0].data).toMatchObject({ running: 2, needsInput: 1, idle: 0 });
    expect(await h.storage.get(pendingKey('user-1', null))).toBeUndefined();
  });

  it('re-arms a stale past alarm so the trailing delivery is not stranded', async () => {
    const h = makeHarness();
    const base = 60_000_000;
    let now = base;
    const scope = { userId: 'user-stale-alarm', organizationId: null };

    // A first delivery opens the window.
    h.setNext(snapshot({ running: 1 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);

    // A leftover alarm from an earlier schedule sits in the past. A past alarm
    // is not a usable schedule: keeping it would strand the deferred change and
    // the trailing flush would never deliver the final counts.
    await h.storage.setAlarm(base - 60_000);

    now = base + 2_000;
    h.setNext(snapshot({ running: 2, needsInput: 1 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(await h.storage.getAlarm()).toBe(base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS);

    now = base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS;
    await flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now);
    expect(h.expoSends).toHaveLength(2);
    expect(h.expoSends[1][0].data).toMatchObject({ running: 2, needsInput: 1 });
  });

  it('spends the window on a failed delivery so the next change defers', async () => {
    const h = makeHarness();
    const base = 30_000_000;
    let now = base;
    const scope = { userId: 'user-failed-send', organizationId: null };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // The first attempt builds and sends, and the transport rejects.
    h.setNext(snapshot({ running: 1 }));
    h.failNextExpoPush(new Error('The bearer token is invalid.'));
    await expect(
      refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now)
    ).rejects.toThrow('The bearer token is invalid.');
    expect(h.builds).toBe(1);
    expect(h.expoSends).toHaveLength(1);
    // The failed attempt still opens the window: without it every later change
    // would retry the whole build+send at once.
    expect(await h.storage.get(deliveryKey('user-failed-send', null))).toEqual({
      deliveredAt: base,
    });

    // A change inside the window is deferred, not retried immediately.
    now = base + 2_000;
    h.setNext(snapshot({ running: 2, needsInput: 1 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(h.builds).toBe(1);
    expect(h.expoSends).toHaveLength(1);
    expect(await h.storage.get(pendingKey('user-failed-send', null))).toEqual({
      userId: 'user-failed-send',
      organizationId: null,
      dueAt: base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
    });
    expect(await h.storage.getAlarm()).toBe(base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS);

    // The trailing flush at the deadline rebuilds and re-attempts: its build
    // carries the final counts even though the transport still fails, and the
    // window re-opens at the trailing attempt instead of unlocking a storm.
    now = base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS;
    h.failNextExpoPush(new Error('The bearer token is invalid.'));
    await expect(
      flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now)
    ).resolves.toBeNull();
    expect(h.builds).toBe(2);
    expect(h.expoSends).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledWith(
      'Glanceable trailing refresh failed',
      expect.objectContaining({ error: 'The bearer token is invalid.' })
    );
    expect(await h.storage.get(deliveryKey('user-failed-send', null))).toEqual({
      deliveredAt: base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
    });
    expect(await h.storage.get(pendingKey('user-failed-send', null))).toBeUndefined();
  });

  it('keeps a pending trailing refresh when a failed attempt opens the window', async () => {
    const h = makeHarness();
    const now = 40_000_000;
    const dueAt = now + 5_000;
    const scope = { userId: 'user-failed-keep', organizationId: null };
    await h.storage.put(pendingKey('user-failed-keep', null), {
      userId: 'user-failed-keep',
      organizationId: null,
      dueAt,
    });

    h.failNextExpoPush(new Error('transport down'));
    await expect(
      refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now)
    ).rejects.toThrow('transport down');
    // The failed attempt opens the window but must not cancel the trailing
    // refresh a deferred change is waiting on.
    expect(await h.storage.get(deliveryKey('user-failed-keep', null))).toEqual({
      deliveredAt: now,
    });
    expect(await h.storage.get(pendingKey('user-failed-keep', null))).toMatchObject({ dueAt });
  });

  it('does not let a superseded in-flight delivery cancel a trailing refresh', async () => {
    const h = makeHarness();
    const base = 20_000_000;
    let now = base;
    const scope = { userId: 'user-superseded', organizationId: null };

    // A first delivery opens the window.
    h.setNext(snapshot({ running: 1 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(await h.storage.get(deliveryKey('user-superseded', null))).toEqual({
      deliveredAt: base,
    });

    // A refresh at the window edge starts delivering but stalls in transport.
    now = base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS;
    h.setNext(snapshot({ running: 2 }));
    const gate = h.blockNextExpoPush();
    const stalled = refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    await gate.started;

    // A newer change supersedes it and delivers, opening a fresh window.
    now = base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS + 500;
    h.setNext(snapshot({ running: 3 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);

    // A change inside that new window is deferred to the trailing alarm.
    now = base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS + 1_000;
    h.setNext(snapshot({ running: 4 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    const dueAt = base + 2 * GLANCEABLE_DELIVERY_MIN_INTERVAL_MS + 500;
    expect(await h.storage.get(pendingKey('user-superseded', null))).toEqual({
      userId: 'user-superseded',
      organizationId: null,
      dueAt,
    });

    // The stalled, superseded delivery must neither drop the trailing refresh
    // the newer change recorded while it was in flight nor open a window.
    gate.release();
    await stalled;
    expect(await h.storage.get(pendingKey('user-superseded', null))).toEqual({
      userId: 'user-superseded',
      organizationId: null,
      dueAt,
    });
    expect(await h.storage.get(deliveryKey('user-superseded', null))).toEqual({
      deliveredAt: base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS + 500,
    });
  });

  it('leaves a pending record that is not due and returns its deadline', async () => {
    const h = makeHarness();
    const now = 1_000_000;
    const dueAt = now + 5_000;
    await h.storage.put(pendingKey('user-later', null), {
      userId: 'user-later',
      organizationId: null,
      dueAt,
    });

    await expect(
      flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now)
    ).resolves.toBe(dueAt);
    expect(await h.storage.get(pendingKey('user-later', null))).toBeDefined();
    expect(h.builds).toBe(0);
  });

  it('rate-limits each scope independently', async () => {
    const h = makeHarness();
    const base = 5_000_000;
    let now = base;

    h.setNext(snapshot({ running: 1 }));
    await refreshGlanceableSnapshot(
      { userId: 'user-1', organizationId: 'org-1' },
      asStorage(h.storage),
      h.deps,
      () => now
    );

    // A different scope is outside the first scope's window and delivers at once.
    now = base + 2_000;
    h.setNext(snapshot({ running: 2 }));
    await refreshGlanceableSnapshot(
      { userId: 'user-1', organizationId: 'org-2' },
      asStorage(h.storage),
      h.deps,
      () => now
    );

    expect(h.expoSends).toHaveLength(2);
    expect(await h.storage.get(pendingKey('user-1', 'org-2'))).toBeUndefined();
  });

  it('logs one build and one delivery per window, the trailing flush carrying the final counts', async () => {
    const h = makeHarness();
    const base = 15_000_000;
    let now = base;
    const scope = { userId: 'user-log', organizationId: null };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // The first change builds and delivers immediately (trailing: false).
    h.setNext(snapshot({ running: 1, needsInput: 0, idle: 0 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(logSpy).toHaveBeenCalledWith({
      event: 'glanceable_snapshot_build',
      scope: ['user-log', null],
      revision: 1,
      trailing: false,
      status: 'happy',
      running: 1,
      needsInput: 0,
      idle: 0,
      needsApproval: 0,
    });
    expect(logSpy).toHaveBeenCalledWith({
      event: 'glanceable_delivery',
      scope: ['user-log', null],
      revision: 1,
      trailing: false,
      status: 'happy',
      running: 1,
      needsInput: 0,
      idle: 0,
      needsApproval: 0,
    });

    // A change inside the window leaves no further evidence: it defers.
    logSpy.mockClear();
    now = base + 2_000;
    h.setNext(snapshot({ running: 2, needsInput: 1, idle: 3 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(logSpy).not.toHaveBeenCalled();

    // The trailing flush logs its build and delivery with the final counts.
    now = base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS;
    await flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now);
    expect(logSpy).toHaveBeenCalledWith({
      event: 'glanceable_snapshot_build',
      scope: ['user-log', null],
      revision: 2,
      trailing: true,
      status: 'happy',
      running: 2,
      needsInput: 1,
      idle: 3,
      needsApproval: 0,
    });
    expect(logSpy).toHaveBeenCalledWith({
      event: 'glanceable_delivery',
      scope: ['user-log', null],
      revision: 2,
      trailing: true,
      status: 'happy',
      running: 2,
      needsInput: 1,
      idle: 3,
      needsApproval: 0,
    });
  });

  it('does not log a delivery when the attempt is superseded mid-flight', async () => {
    const h = makeHarness();
    const base = 25_000_000;
    let now = base;
    const scope = { userId: 'user-log-superseded', organizationId: null };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // A first delivery opens the window.
    h.setNext(snapshot({ running: 1 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    logSpy.mockClear();

    // A refresh at the window edge stalls in transport; a newer change
    // supersedes it. The superseded attempt logs its committed build (the POST
    // happened) but must not log a delivery.
    now = base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS;
    h.setNext(snapshot({ running: 2 }));
    const gate = h.blockNextExpoPush();
    const stalled = refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    await gate.started;
    now = base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS + 500;
    h.setNext(snapshot({ running: 3 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    const delivered = logSpy.mock.calls
      .map(call => call[0] as { event?: string })
      .filter(call => call?.event !== undefined);
    expect(delivered).toEqual([
      expect.objectContaining({ event: 'glanceable_snapshot_build', revision: 2 }),
      expect.objectContaining({ event: 'glanceable_snapshot_build', revision: 3 }),
      expect.objectContaining({ event: 'glanceable_delivery', revision: 3 }),
    ]);

    gate.release();
    await stalled;
    logSpy.mockClear();
    const afterStall = logSpy.mock.calls
      .map(call => call[0] as { event?: string })
      .filter(call => call?.event !== undefined);
    expect(afterStall).toEqual([]);
  });

  it('does not consume the window when the snapshot build fails', async () => {
    const h = makeHarness();
    const base = 9_000_000;
    let now = base;
    const scope = { userId: 'user-fail', organizationId: null };

    h.setNext(null);
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(h.expoSends).toHaveLength(0);
    expect(await h.storage.get(pendingKey('user-fail', null))).toBeUndefined();

    // The next change retries immediately because no delivery was recorded.
    now = base + 2_000;
    h.setNext(snapshot({ running: 3 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(h.expoSends).toHaveLength(1);
    expect(await h.storage.get(deliveryKey('user-fail', null))).toEqual({ deliveredAt: now });
    expect(await h.storage.get(pendingKey('user-fail', null))).toBeUndefined();
  });

  it('catches a throwing build during the flush and clears the pending record', async () => {
    const h = makeHarness();
    const now = 12_000_000;
    const key = pendingKey('user-throw', null);
    await h.storage.put(key, { userId: 'user-throw', organizationId: null, dueAt: now - 1 });
    h.failNextBuild(new Error('route down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now)
    ).resolves.toBeNull();
    expect(await h.storage.get(key)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Glanceable trailing refresh failed',
      expect.objectContaining({ error: 'route down' })
    );
  });
});

describe('NotificationChannelDO alarm glanceable flush', () => {
  it('consumes a due pending record and keeps the later deadline scheduled', async () => {
    const id = env.NOTIFICATION_CHANNEL_DO.idFromName('user-glanceable-alarm');
    const stub = env.NOTIFICATION_CHANNEL_DO.get(id);
    const now = Date.now();
    const dueAt = now - 1_000;
    const laterDueAt = now + 30_000;

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('glanceable-pending:["user-glanceable-alarm",null]', {
        userId: 'user-glanceable-alarm',
        organizationId: null,
        dueAt,
      });
      await state.storage.put('glanceable-pending:["user-glanceable-alarm","org-1"]', {
        userId: 'user-glanceable-alarm',
        organizationId: 'org-1',
        dueAt: laterDueAt,
      });
    });

    await runInDurableObject(stub, async instance => {
      await (instance as unknown as { alarm: () => Promise<void> }).alarm();
    });

    const result = await runInDurableObject(stub, async (_instance, state) => ({
      due: await state.storage.get('glanceable-pending:["user-glanceable-alarm",null]'),
      later: await state.storage.get<{ dueAt: number }>(
        'glanceable-pending:["user-glanceable-alarm","org-1"]'
      ),
      alarm: await state.storage.getAlarm(),
    }));

    expect(result.due).toBeUndefined();
    expect(result.later).toMatchObject({ dueAt: laterDueAt });
    expect(result.alarm).toBe(laterDueAt);
  });
});
