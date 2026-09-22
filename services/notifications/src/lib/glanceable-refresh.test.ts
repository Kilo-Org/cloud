import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExpoPushMessage } from './expo-push';
import type { ActiveAgentsGlanceable, GlanceableDeliveryDeps } from './glanceable-delivery';
import {
  foldPendingGlanceableRefreshDeadline,
  flushDueGlanceableRefreshes,
  flushDueGlanceableRefreshesSafely,
  GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
  GLANCEABLE_REFRESH_RETRY_MAX_MS,
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

/** Fails `list` for one prefix, as a transient storage error would. */
class FailingListStorage extends FakeStorage {
  constructor(private readonly failingPrefix: string) {
    super();
  }

  override async list<T>(
    options: { prefix?: string; limit?: number } = {}
  ): Promise<Map<string, T>> {
    if (options.prefix === this.failingPrefix) throw new Error('storage unavailable');
    return super.list<T>(options);
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
    newestResultKind: null,
    newestResultAt: null,
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
      deferredAt: base + 2_000,
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

  it('delivers an approval change inside the window instead of deferring it', async () => {
    const h = makeHarness();
    const base = Date.parse('2026-09-18T01:00:00.000Z');
    let now = base;
    const scope = { userId: 'user-approval', organizationId: null };

    h.setNext(snapshot({ running: 1, needsInput: 0, needsApproval: 0 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(h.expoSends).toHaveLength(1);

    // A question -> permission move keeps needsInput constant but gates the
    // Approve control, which must not wait out the shared window.
    now = base + 2_000;
    h.setNext(snapshot({ running: 1, needsInput: 1, needsApproval: 1 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now, {
      approvalChanged: true,
    });

    expect(h.builds).toBe(2);
    expect(h.expoSends).toHaveLength(2);
    expect(h.expoSends[1][0].data).toMatchObject({ needsInput: 1, needsApproval: 1 });
    expect(await h.storage.get(pendingKey('user-approval', null))).toBeUndefined();
    // The approval delivery still spends the window, so counts-only churn right
    // after it defers instead of waking the device again.
    expect(await h.storage.get(deliveryKey('user-approval', null))).toEqual({
      deliveredAt: now,
      outcome: 'delivered',
    });

    now = base + 3_000;
    h.setNext(snapshot({ running: 2, needsInput: 1, needsApproval: 1 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(h.builds).toBe(2);
    expect(h.expoSends).toHaveLength(2);
    expect(await h.storage.get(pendingKey('user-approval', null))).toMatchObject({
      dueAt: base + 2_000 + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
    });
  });

  it('re-arms a trailing refresh whose build returns no snapshot', async () => {
    const h = makeHarness();
    const now = 70_000_000;
    const key = pendingKey('user-null-build', null);
    await h.storage.put(key, { userId: 'user-null-build', organizationId: null, dueAt: now - 1 });
    // Production buildSnapshot returns null (it never throws) when the route or
    // its credentials fail. Consuming the record here would drop the final
    // counts with no alarm left to retry them.
    h.setNext(null);

    await expect(
      flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now)
    ).resolves.toBe(now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS);
    expect(h.builds).toBe(1);
    expect(h.expoSends).toHaveLength(0);
    expect(await h.storage.get(key)).toEqual({
      userId: 'user-null-build',
      organizationId: null,
      dueAt: now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
      deferredAt: now,
      attempts: 1,
    });
  });

  it('does not re-arm a trailing refresh superseded by a newer delivery', async () => {
    const h = makeHarness();
    const base = 80_000_000;
    let now = base;
    const scope = { userId: 'user-superseded-null', organizationId: null };
    const key = pendingKey('user-superseded-null', null);
    // The flush consumes the due record before it runs.
    await h.storage.put(key, {
      userId: 'user-superseded-null',
      organizationId: null,
      dueAt: now - 1,
    });

    // The trailing build stalls, so a newer refresh can bump the revision and
    // deliver while this fetch is in flight.
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let build = 0;
    h.deps.buildSnapshot = async () => {
      build += 1;
      if (build === 1) {
        started.resolve();
        await release.promise;
        return null;
      }
      return snapshot({ running: 5 });
    };

    const trailing = flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now);
    await started.promise;

    // The newer refresh owns the revision and delivers; its snapshot already
    // covers the deferred change.
    now = base + 1_000;
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(h.expoSends).toHaveLength(1);

    release.resolve();
    // The superseded trailing fetch must not re-arm a redundant device wake.
    await expect(trailing).resolves.toBeNull();
    expect(await h.storage.get(key)).toBeUndefined();
  });

  it('cancels a re-armed trailing refresh when the superseding delivery lands afterwards', async () => {
    const h = makeHarness();
    const base = 82_500_000;
    let now = base;
    const scope = { userId: 'user-rearm-race', organizationId: null };
    const key = pendingKey('user-rearm-race', null);
    // The flush consumes this due record; its write time is what the re-arm
    // must preserve so the later delivery still sees the change as covered.
    await h.storage.put(key, {
      userId: 'user-rearm-race',
      organizationId: null,
      dueAt: now - 1,
      deferredAt: now - 2,
    });

    // The trailing build stalls so a concurrent refresh can bump the revision
    // and reach its transport before the trailing fetch re-arms.
    const started = Promise.withResolvers<void>();
    const releaseBuild = Promise.withResolvers<void>();
    let build = 0;
    h.deps.buildSnapshot = async () => {
      build += 1;
      if (build === 1) {
        started.resolve();
        await releaseBuild.promise;
        return null;
      }
      return snapshot({ running: 5 });
    };

    const trailing = flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now);
    await started.promise;

    // The superseding delivery is in flight — revision bumped, delivery record
    // not yet written — when the trailing fetch re-arms.
    now = base + 1_000;
    const gate = h.blockNextExpoPush();
    const delivery = refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    await gate.started;
    releaseBuild.resolve();
    await trailing;
    expect(await h.storage.get(key)).toMatchObject({ deferredAt: base - 2 });

    // Its snapshot already covers the deferred change, so the re-arm must not
    // survive the delivery as a redundant device wake.
    gate.release();
    await delivery;
    expect(await h.storage.get(key)).toBeUndefined();
  });

  it('re-arms a trailing refresh when a concurrent refresh only moves the revision', async () => {
    const h = makeHarness();
    const base = 85_000_000;
    let now = base;
    const scope = { userId: 'user-superseded-no-delivery', organizationId: null };
    const key = pendingKey('user-superseded-no-delivery', null);
    await h.storage.put(key, {
      userId: 'user-superseded-no-delivery',
      organizationId: null,
      dueAt: now - 1,
    });

    // The trailing build stalls; a concurrent refresh bumps the revision while
    // it is in flight but its own build returns null, so it delivers nothing
    // and re-arms nothing.
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let build = 0;
    h.deps.buildSnapshot = async () => {
      build += 1;
      if (build === 1) {
        started.resolve();
        await release.promise;
      }
      return null;
    };

    const trailing = flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now);
    await started.promise;

    now = base + 1_000;
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(h.expoSends).toHaveLength(0);

    release.resolve();
    // The revision moved but no delivery landed, so the deferred counts must
    // keep a pending record and a deadline instead of being dropped.
    await expect(trailing).resolves.toBe(now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS);
    expect(await h.storage.get(key)).toEqual({
      userId: 'user-superseded-no-delivery',
      organizationId: null,
      dueAt: now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
      deferredAt: now,
      attempts: 1,
    });
  });

  it('re-arms a trailing refresh when the concurrent attempt fails at the transport', async () => {
    const h = makeHarness();
    const base = 90_000_000;
    let now = base;
    const scope = { userId: 'user-superseded-failed', organizationId: null };
    const key = pendingKey('user-superseded-failed', null);
    await h.storage.put(key, {
      userId: 'user-superseded-failed',
      organizationId: null,
      dueAt: now - 1,
    });

    // The trailing build stalls, so a newer refresh attempts its delivery while
    // this fetch is in flight.
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let build = 0;
    h.deps.buildSnapshot = async () => {
      build += 1;
      if (build === 1) {
        started.resolve();
        await release.promise;
        return null;
      }
      return snapshot({ running: 5 });
    };

    const trailing = flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now);
    await started.promise;

    // The concurrent refresh delivers but the transport rejects: the failure
    // branch still writes the delivery record (a spent window) before it
    // rethrows, so the record alone cannot tell a landed delivery from a spent
    // window.
    now = base + 1_000;
    h.failNextExpoPush(new Error('transport down'));
    await expect(
      refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now)
    ).rejects.toThrow('transport down');
    expect(h.expoSends).toHaveLength(1);
    expect(await h.storage.get(deliveryKey('user-superseded-failed', null))).toEqual({
      deliveredAt: now,
      outcome: 'failed',
    });

    release.resolve();
    // No snapshot was delivered, so the deferred counts must keep a pending
    // record and a deadline instead of being dropped with no alarm left.
    await expect(trailing).resolves.toBe(now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS);
    expect(await h.storage.get(key)).toEqual({
      userId: 'user-superseded-failed',
      organizationId: null,
      dueAt: now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
      deferredAt: now,
      attempts: 1,
    });
  });

  it('re-arms a superseded trailing refresh whose own build succeeded', async () => {
    const h = makeHarness();
    const base = 95_000_000;
    let now = base;
    const scope = { userId: 'user-superseded-built', organizationId: null };
    const key = pendingKey('user-superseded-built', null);
    await h.storage.put(key, {
      userId: 'user-superseded-built',
      organizationId: null,
      dueAt: now - 1,
    });

    // The trailing build stalls, so a newer refresh bumps the revision while it
    // is in flight. That refresh's own build returns no snapshot, so it delivers
    // nothing and records nothing: only the trailing refresh can keep the
    // deferred counts alive.
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let build = 0;
    h.deps.buildSnapshot = async () => {
      build += 1;
      if (build === 1) {
        started.resolve();
        await release.promise;
        return snapshot({ running: 5 });
      }
      return null;
    };

    const trailing = flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now);
    await started.promise;

    now = base + 1_000;
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(h.expoSends).toHaveLength(0);

    release.resolve();
    // The newer revision owns the surface, so the trailing fetch must not
    // deliver; the deferred counts still need a pending record and a deadline
    // instead of being dropped with no alarm left to retry them.
    await expect(trailing).resolves.toBe(now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS);
    expect(await h.storage.get(key)).toEqual({
      userId: 'user-superseded-built',
      organizationId: null,
      dueAt: now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
      deferredAt: now,
      attempts: 1,
    });
  });

  it('re-arms a superseded trailing refresh when the concurrent attempt failed at the transport', async () => {
    const h = makeHarness();
    const base = 96_000_000;
    let now = base;
    const scope = { userId: 'user-superseded-built-failed', organizationId: null };
    const key = pendingKey('user-superseded-built-failed', null);
    await h.storage.put(key, {
      userId: 'user-superseded-built-failed',
      organizationId: null,
      dueAt: now - 1,
    });

    // The trailing build stalls, so a newer refresh supersedes it and attempts
    // its delivery. The transport rejects, and that failure still writes the
    // delivery record: the record alone cannot tell a landed delivery from a
    // spent window.
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let build = 0;
    h.deps.buildSnapshot = async () => {
      build += 1;
      if (build === 1) {
        started.resolve();
        await release.promise;
        return snapshot({ running: 5 });
      }
      return snapshot({ running: 6 });
    };

    const trailing = flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now);
    await started.promise;

    now = base + 1_000;
    h.failNextExpoPush(new Error('transport down'));
    await expect(
      refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now)
    ).rejects.toThrow('transport down');
    expect(await h.storage.get(deliveryKey('user-superseded-built-failed', null))).toEqual({
      deliveredAt: now,
      outcome: 'failed',
    });

    release.resolve();
    // No snapshot was delivered, so the deferred counts must keep a pending
    // record and a deadline instead of being dropped with no alarm left.
    await expect(trailing).resolves.toBe(now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS);
    expect(await h.storage.get(key)).toEqual({
      userId: 'user-superseded-built-failed',
      organizationId: null,
      dueAt: now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
      deferredAt: now,
      attempts: 1,
    });
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

  it('spends the window on a failed delivery and re-arms the deferred counts', async () => {
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
      outcome: 'failed',
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
      deferredAt: base + 2_000,
    });
    expect(await h.storage.getAlarm()).toBe(base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS);

    // The trailing flush at the deadline rebuilds and re-attempts: its build
    // carries the final counts even though the transport still fails, and the
    // window re-opens at the trailing attempt instead of unlocking a storm.
    now = base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS;
    h.failNextExpoPush(new Error('The bearer token is invalid.'));
    await expect(
      flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now)
    ).resolves.toBe(now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS);
    expect(h.builds).toBe(2);
    expect(h.expoSends).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledWith(
      'Glanceable trailing refresh failed',
      expect.objectContaining({ error: 'The bearer token is invalid.' })
    );
    expect(await h.storage.get(deliveryKey('user-failed-send', null))).toEqual({
      deliveredAt: base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
      outcome: 'failed',
    });
    // A throwing trailing delivery keeps the deferred counts: re-armed for the
    // next window instead of dropped with no retry left. The re-arm keeps the
    // deferral's original write time so a delivery that lands later still
    // recognises it as covered.
    expect(await h.storage.get(pendingKey('user-failed-send', null))).toEqual({
      userId: 'user-failed-send',
      organizationId: null,
      dueAt: now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
      deferredAt: base + 2_000,
      attempts: 1,
    });
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
      outcome: 'failed',
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
      outcome: 'delivered',
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
    const deferredAt = base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS + 1_000;
    expect(await h.storage.get(pendingKey('user-superseded', null))).toEqual({
      userId: 'user-superseded',
      organizationId: null,
      dueAt,
      deferredAt,
    });

    // The stalled, superseded delivery must neither drop the trailing refresh
    // the newer change recorded while it was in flight nor open a window.
    gate.release();
    await stalled;
    expect(await h.storage.get(pendingKey('user-superseded', null))).toEqual({
      userId: 'user-superseded',
      organizationId: null,
      dueAt,
      deferredAt,
    });
    expect(await h.storage.get(deliveryKey('user-superseded', null))).toEqual({
      deliveredAt: base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS + 500,
      outcome: 'delivered',
    });
  });

  it('keeps a counts-only deferral written while an approval-exempt delivery is in flight', async () => {
    const h = makeHarness();
    const base = 50_000_000;
    let now = base;
    const scope = { userId: 'user-approval-race', organizationId: null };

    // A first delivery opens the window.
    h.setNext(snapshot({ running: 1, needsInput: 0 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);

    // An approval change inside the window starts delivering (exempt) but
    // stalls in transport.
    now = base + 2_000;
    h.setNext(snapshot({ running: 1, needsInput: 1, needsApproval: 1 }));
    const gate = h.blockNextExpoPush();
    const stalled = refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now, {
      approvalChanged: true,
    });
    await gate.started;

    // A counts-only change lands while the exempt delivery is in flight. The
    // window is still open, so it defers to the alarm; the revision is not
    // advanced by a deferral.
    now = base + 2_500;
    h.setNext(snapshot({ running: 2, needsInput: 1, needsApproval: 1 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    const dueAt = base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS;
    expect(await h.storage.get(pendingKey('user-approval-race', null))).toMatchObject({ dueAt });

    // The exempt delivery completing must not discard the deferral that landed
    // while it was in flight.
    gate.release();
    await stalled;
    expect(await h.storage.get(pendingKey('user-approval-race', null))).toMatchObject({ dueAt });
    // The deferral keeps the alarm that will deliver it.
    expect(await h.storage.getAlarm()).toBe(dueAt);

    // The trailing flush still delivers the final counts. The exempt delivery
    // started the next window when it completed, so the deferred refresh waits
    // out that window before it lands.
    now = base + 2_500 + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS;
    await flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now);
    expect(h.expoSends).toHaveLength(3);
    expect(h.expoSends[2][0].data).toMatchObject({
      running: 2,
      needsInput: 1,
      needsApproval: 1,
    });
  });

  it('keeps a newer deferral even when an older one in the same window shares its dueAt', async () => {
    const h = makeHarness();
    const base = 55_000_000;
    let now = base;
    const scope = { userId: 'user-approval-collision', organizationId: null };

    // A first delivery opens the window.
    h.setNext(snapshot({ running: 1, needsInput: 0 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);

    // A counts-only change defers to the window end.
    now = base + 1_000;
    h.setNext(snapshot({ running: 2, needsInput: 0 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    const dueAt = base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS;

    // An approval change inside the window starts delivering (exempt) and
    // stalls; its snapshot already covers the first deferral.
    now = base + 2_000;
    h.setNext(snapshot({ running: 2, needsInput: 1, needsApproval: 1 }));
    const gate = h.blockNextExpoPush();
    const stalled = refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now, {
      approvalChanged: true,
    });
    await gate.started;

    // A second counts-only change defers during the delivery. It carries the
    // same `dueAt` as the first deferral, so only its write time tells them
    // apart: the delivery superseded the first, not this one.
    now = base + 2_500;
    h.setNext(snapshot({ running: 3, needsInput: 1, needsApproval: 1 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);

    gate.release();
    await stalled;
    expect(await h.storage.get(pendingKey('user-approval-collision', null))).toEqual({
      userId: 'user-approval-collision',
      organizationId: null,
      dueAt,
      deferredAt: base + 2_500,
    });

    // The trailing flush still delivers the final counts.
    now = base + 2_500 + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS;
    await flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now);
    expect(h.expoSends).toHaveLength(3);
    expect(h.expoSends[2][0].data).toMatchObject({
      running: 3,
      needsInput: 1,
      needsApproval: 1,
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
    expect(await h.storage.get(deliveryKey('user-fail', null))).toEqual({
      deliveredAt: now,
      outcome: 'delivered',
    });
    expect(await h.storage.get(pendingKey('user-fail', null))).toBeUndefined();
  });

  it('re-arms a throwing build during the flush so the deferred counts retry', async () => {
    const h = makeHarness();
    const now = 12_000_000;
    const key = pendingKey('user-throw', null);
    await h.storage.put(key, { userId: 'user-throw', organizationId: null, dueAt: now - 1 });
    h.failNextBuild(new Error('route down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now)
    ).resolves.toBe(now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS);
    expect(warnSpy).toHaveBeenCalledWith(
      'Glanceable trailing refresh failed',
      expect.objectContaining({ error: 'route down' })
    );
    // The record was consumed before the refresh; the rejected build must put it
    // back with a fresh deadline or the deferred counts are gone for good.
    expect(await h.storage.get(key)).toEqual({
      userId: 'user-throw',
      organizationId: null,
      dueAt: now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
      deferredAt: now,
      attempts: 1,
    });
    expect(h.builds).toBe(1);
  });

  it('does not re-arm when a delivery landed while the throwing refresh ran', async () => {
    const h = makeHarness();
    const now = 12_500_000;
    const key = pendingKey('user-throw-delivered', null);
    await h.storage.put(key, {
      userId: 'user-throw-delivered',
      organizationId: null,
      dueAt: now - 1,
    });
    // A concurrent approval-exempt delivery lands while this refresh is in
    // flight, then the refresh's build throws. The re-arm reads the delivery
    // record and the slot in one transaction, so it must see the landed
    // delivery and skip: a plain get-then-put would leave a record behind that
    // later fires a redundant device wake.
    h.deps.buildSnapshot = async () => {
      await h.storage.put(deliveryKey('user-throw-delivered', null), {
        deliveredAt: now,
        outcome: 'delivered',
      });
      throw new Error('route down');
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now)
    ).resolves.toBeNull();
    expect(await h.storage.get(key)).toBeUndefined();
  });

  it('escalates the trailing re-arm backoff and caps it', async () => {
    const h = makeHarness();
    const now = 14_000_000;
    const key = pendingKey('user-backoff', null);
    // Four consecutive failed attempts: the fifth waits sixteen windows (the
    // doubling from one window), and the twenty-first is clamped to the ceiling
    // so a permanently failing route cannot keep rebuilding every window
    // forever.
    await h.storage.put(key, {
      userId: 'user-backoff',
      organizationId: null,
      dueAt: now - 1,
      deferredAt: now - 500_000,
      attempts: 4,
    });
    h.setNext(null);

    await expect(
      flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now)
    ).resolves.toBe(now + 16 * GLANCEABLE_DELIVERY_MIN_INTERVAL_MS);
    expect(await h.storage.get(key)).toMatchObject({
      deferredAt: now - 500_000,
      attempts: 5,
      dueAt: now + 16 * GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
    });

    await h.storage.put(key, {
      userId: 'user-backoff',
      organizationId: null,
      dueAt: now - 1,
      deferredAt: now - 500_000,
      attempts: 20,
    });
    await expect(
      flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now)
    ).resolves.toBe(now + GLANCEABLE_REFRESH_RETRY_MAX_MS);
    expect(await h.storage.get(key)).toMatchObject({
      attempts: 21,
      dueAt: now + GLANCEABLE_REFRESH_RETRY_MAX_MS,
    });
  });

  it('resets the retry backoff when a newer change defers inside the window', async () => {
    const h = makeHarness();
    const base = 15_000_000;
    let now = base;
    const scope = { userId: 'user-backoff-reset', organizationId: null };
    const key = pendingKey('user-backoff-reset', null);

    // A delivery opens the window and a later heartbeat re-arms a retried
    // record, so the slot carries a backed-off count.
    h.setNext(snapshot({ running: 1 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    await h.storage.put(key, {
      userId: 'user-backoff-reset',
      organizationId: null,
      dueAt: now,
      deferredAt: now - 400_000,
      attempts: 7,
    });

    // A fresh change inside the window is a new deferral, not a retry: it gets
    // the window's normal deadline and drops the failed-attempt count so the
    // next failure backs off from one window again.
    now = base + 2_000;
    h.setNext(snapshot({ running: 2 }));
    await refreshGlanceableSnapshot(scope, asStorage(h.storage), h.deps, () => now);
    expect(await h.storage.get(key)).toEqual({
      userId: 'user-backoff-reset',
      organizationId: null,
      dueAt: base + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
      deferredAt: now,
    });
  });

  it('keeps a deferral written while a throwing trailing refresh ran', async () => {
    const h = makeHarness();
    const now = 13_000_000;
    const key = pendingKey('user-throw-race', null);
    await h.storage.put(key, { userId: 'user-throw-race', organizationId: null, dueAt: now - 1 });
    // The refresh defers a newer change (the key is reclaimed with a later
    // deadline) and only then rejects. The re-arm must not overwrite that
    // newer record with an older deadline.
    h.deps.buildSnapshot = async () => {
      await h.storage.put(key, {
        userId: 'user-throw-race',
        organizationId: null,
        dueAt: now + 3_000,
        deferredAt: now + 1,
      });
      throw new Error('route down');
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      flushDueGlanceableRefreshes(asStorage(h.storage), h.deps, () => now)
    ).resolves.toBe(now + 3_000);
    expect(await h.storage.get(key)).toEqual({
      userId: 'user-throw-race',
      organizationId: null,
      dueAt: now + 3_000,
      deferredAt: now + 1,
    });
  });

  it('contains a failing flush sweep so the caller can still run its own sweep', async () => {
    const h = makeHarness();
    const now = 1_000;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = new FailingListStorage('glanceable-pending:');
    await storage.put(pendingKey('user-sweep', null), {
      userId: 'user-sweep',
      organizationId: null,
      dueAt: now,
    });

    // The sweep's own storage read rejects. The guard must absorb it so the
    // caller's GC pass still runs instead of the alarm aborting here.
    await expect(
      flushDueGlanceableRefreshesSafely(asStorage(storage), h.deps, () => now)
    ).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'Glanceable trailing refresh sweep failed',
      expect.objectContaining({ error: 'storage unavailable' })
    );
    expect(h.builds).toBe(0);
  });
});

describe('NotificationChannelDO alarm glanceable flush', () => {
  it('re-arms a due record whose build returns no snapshot and keeps the later deadline', async () => {
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
      due: await state.storage.get<{ dueAt: number }>(
        'glanceable-pending:["user-glanceable-alarm",null]'
      ),
      later: await state.storage.get<{ dueAt: number }>(
        'glanceable-pending:["user-glanceable-alarm","org-1"]'
      ),
      alarm: await state.storage.getAlarm(),
    }));

    // The test env has no internal secret, so the trailing build returns null
    // and the record re-arms for the next window instead of being dropped.
    const rearmedDueAt = result.due?.dueAt ?? 0;
    expect(result.due).toMatchObject({ userId: 'user-glanceable-alarm', organizationId: null });
    expect(rearmedDueAt).toBeGreaterThan(now);
    expect(rearmedDueAt).toBeLessThan(laterDueAt);
    expect(result.later).toMatchObject({ dueAt: laterDueAt });
    // The alarm takes the earliest remaining deadline.
    expect(result.alarm).toBe(rearmedDueAt);
  });

  it('folds a deferral that lands after the sweep chose its alarm', async () => {
    // The sweep picks the alarm from its idem/rl records, then awaits before it
    // sets it. A pending refresh written in that window owns the earlier
    // deadline and must win, or the trailing delivery is delayed.
    const storage = new FakeStorage();
    await storage.put(pendingKey('user-fold', null), {
      userId: 'user-fold',
      organizationId: null,
      dueAt: 5_000,
    });

    await expect(foldPendingGlanceableRefreshDeadline(asStorage(storage), 9_000)).resolves.toBe(
      5_000
    );
    // An earlier sweep candidate still wins over the pending deadline.
    await expect(foldPendingGlanceableRefreshDeadline(asStorage(storage), 3_000)).resolves.toBe(
      3_000
    );
    // A sweep with no other deadline adopts the pending one.
    await expect(foldPendingGlanceableRefreshDeadline(asStorage(storage), undefined)).resolves.toBe(
      5_000
    );
  });

  it('runs the idem/rate-limit GC even when the glanceable flush fails', async () => {
    const id = env.NOTIFICATION_CHANNEL_DO.idFromName('user-glanceable-gc');
    const stub = env.NOTIFICATION_CHANNEL_DO.get(id);
    const now = Date.now();
    const dueAt = now + 30_000;
    // Proves the flush actually failed rather than quietly succeeding: a
    // successful sweep skips the not-yet-due record and folds the same `dueAt`,
    // so the GC and deadline assertions alone cannot tell the two apart.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('idem:expired', { stage: 'delivered', ts: now - 2 * 60 * 60 * 1000 });
      await state.storage.put('rl:expired', { expiresAt: now - 1_000, timestamps: [] });
      await state.storage.put('glanceable-pending:["user-glanceable-gc",null]', {
        userId: 'user-glanceable-gc',
        organizationId: null,
        dueAt,
      });
    });

    const rejections = await runInDurableObject(stub, async (instance, state) => {
      // The flush's first pending-prefix read rejects; the guard must absorb it
      // so the GC below still runs. Later reads (the fold) succeed.
      const mutable = state.storage as unknown as {
        list: (options?: { prefix?: string }) => Promise<unknown>;
      };
      const originalList = state.storage.list.bind(state.storage);
      let pendingLists = 0;
      let rejected = 0;
      mutable.list = (options?: { prefix?: string }) => {
        if (options?.prefix === 'glanceable-pending:' && ++pendingLists === 1) {
          rejected += 1;
          return Promise.reject(new Error('storage unavailable'));
        }
        return originalList(options);
      };
      try {
        await (instance as unknown as { alarm: () => Promise<void> }).alarm();
      } finally {
        delete (mutable as { list?: unknown }).list;
      }
      return rejected;
    });

    const result = await runInDurableObject(stub, async (_instance, state) => ({
      idem: await state.storage.get('idem:expired'),
      rl: await state.storage.get('rl:expired'),
      pending: await state.storage.get<{ dueAt: number }>(
        'glanceable-pending:["user-glanceable-gc",null]'
      ),
      alarm: await state.storage.getAlarm(),
    }));

    // The sweep's own read was rejected and the guard absorbed it with the
    // content-free warning; without these two the test cannot tell a failed
    // flush from a successful one.
    expect(rejections).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Glanceable trailing refresh sweep failed',
      expect.objectContaining({ error: 'storage unavailable' })
    );
    // A failing flush no longer skips the sweep's storage reclamation.
    expect(result.idem).toBeUndefined();
    expect(result.rl).toBeUndefined();
    // The deferred counts are not dropped: the record and its deadline survive
    // the failed flush, so the trailing delivery is rescheduled.
    expect(result.pending?.dueAt).toBe(dueAt);
    expect(result.alarm).toBe(dueAt);
  });
});
