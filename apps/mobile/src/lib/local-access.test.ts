/* eslint-disable max-lines -- the complete protected-state matrix shares one isolated process owner */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AppStateStatus } from 'react-native';

import {
  assertLocalAccessLease,
  assertLocalAccessOwner,
  captureLocalAccessLease,
  getLocalAccessSnapshot,
  initializeLocalAccess,
  LocalAccessDeniedError,
  lockLocalAccess,
  reloadLocalAccessPreference,
  requestLocalAccess,
  setLocalAccessContextReady,
  setLocalAccessOwner,
  subscribeLocalAccess,
} from './local-access';
import { type LocalAccessReadResult, type LocalAccessStorage } from './local-access-storage';
import { type LocalAuthenticationOutcome } from './local-authentication';

let stop: (() => void) | undefined = undefined;
const absent: LocalAccessReadResult = { status: 'absent' };
const releases: (() => void)[] = [];
function deferred<T>(fallback: T) {
  const pending = Promise.withResolvers<T>();
  releases.push(() => {
    pending.resolve(fallback);
  });
  return pending;
}
afterEach(async () => {
  stop?.();
  stop = undefined;
  for (const release of releases.splice(0)) {
    release();
  }
  await requestLocalAccess();
  vi.useRealTimers();
});

function setup(initial: LocalAccessReadResult = absent, state: AppStateStatus = 'active') {
  let now = 1000;
  let appState = state;
  const listeners = new Set<(state: AppStateStatus) => void>();
  const records = new Map<string, LocalAccessReadResult>([['A', initial]]);
  const storage = {
    read: vi.fn<LocalAccessStorage['read']>(async userId => {
      const result = await Promise.resolve(records.get(userId) ?? absent);
      return result;
    }),
    write: vi.fn<LocalAccessStorage['write']>(async (userId, enabled, isCurrent) => {
      await Promise.resolve();
      if (!isCurrent()) {
        return 'stale';
      }
      records.set(userId, { status: 'present', enabled });
      return 'committed';
    }),
  };
  const authenticate = vi
    .fn<() => Promise<LocalAuthenticationOutcome>>()
    .mockResolvedValue({ status: 'retryable', reason: 'user_cancel' });
  stop = initializeLocalAccess({
    storage,
    authenticate,
    now: () => now,
    lifecycle: {
      getCurrentState: () => appState,
      subscribe: listener => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  });
  return {
    storage,
    authenticate,
    records,
    setTime: (time: number) => {
      now = time;
    },
    emit: (next: AppStateStatus) => {
      appState = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
    queue: (next: AppStateStatus) => {
      const queued = [...listeners];
      return () => {
        for (const listener of queued) {
          listener(next);
        }
      };
    },
  };
}
async function bind(userId = 'A', epoch = 1) {
  await setLocalAccessOwner(userId, epoch);
  setLocalAccessContextReady(true);
  await requestLocalAccess('unlock', true);
}
async function ready(enabled = true) {
  const fixture = setup({ status: 'present', enabled });
  fixture.authenticate.mockResolvedValue({ status: 'authenticated' });
  await bind();
  return fixture;
}
const scope = { userId: 'A', organizationId: null } as const;

function expectDenied() {
  expect(() => captureLocalAccessLease(scope)).toThrow(LocalAccessDeniedError);
}

describe('initialization and security restoration', () => {
  it('denies absent services, unresolved owners, and unresolved context', async () => {
    expectDenied();
    setup();
    setLocalAccessContextReady(true);
    expectDenied();
    await setLocalAccessOwner('A', 1);
    expectDenied();
    setLocalAccessContextReady(true);
    expect(() => captureLocalAccessLease(scope)).not.toThrow();
  });

  it.each([
    [{ status: 'absent' }, false, true],
    [{ status: 'present', enabled: false }, false, true],
    [{ status: 'present', enabled: true }, true, false],
    [{ status: 'malformed' }, null, false],
    [{ status: 'failed' }, null, false],
  ] satisfies [LocalAccessReadResult, boolean | null, boolean][])(
    'separates loading from restored %j',
    async (record, enabled, unlocked) => {
      const fixture = setup(record);
      const read = deferred<LocalAccessReadResult>({ status: 'failed' });
      fixture.storage.read.mockReturnValueOnce(read.promise);
      const loading = setLocalAccessOwner('A', 1);
      setLocalAccessContextReady(true);
      expect(getLocalAccessSnapshot()).toMatchObject({
        preference: 'loading',
        enabled: null,
        unlocked: false,
      });
      expectDenied();
      read.resolve(record);
      await loading;
      await requestLocalAccess('unlock', true);
      expect(getLocalAccessSnapshot()).toMatchObject({
        preference: record.status,
        enabled,
        unlocked,
      });
      if (unlocked) {
        expect(getLocalAccessSnapshot().recovery).toBeNull();
      } else {
        expectDenied();
      }
    }
  );

  it('retries failed reads without treating them as malformed or disabled', async () => {
    const fixture = setup({ status: 'present', enabled: true });
    fixture.storage.read.mockRejectedValueOnce(new Error('Read failed'));
    await bind();
    expect(getLocalAccessSnapshot()).toMatchObject({
      preference: 'failed',
      recovery: { status: 'retryable', reason: 'read_failed' },
    });
    expect(await requestLocalAccess('repair')).toBe('denied');
    expect(await requestLocalAccess('disable')).toBe('denied');
    await reloadLocalAccessPreference();
    await requestLocalAccess('unlock', true);
    expect(getLocalAccessSnapshot()).toMatchObject({ enabled: true, unlocked: false });
    expect(fixture.records.get('A')).toEqual({ status: 'present', enabled: true });
  });

  it('fences a delayed A read after direct replacement by B', async () => {
    const fixture = setup();
    const read = deferred<LocalAccessReadResult>({ status: 'failed' });
    fixture.storage.read.mockReturnValueOnce(read.promise);
    const oldRead = setLocalAccessOwner('A', 1);
    await bind('B', 2);
    read.resolve({ status: 'present', enabled: true });
    await oldRead;
    expect(getLocalAccessSnapshot()).toMatchObject({
      userId: 'B',
      authEpoch: 2,
      preference: 'absent',
      enabled: false,
      unlocked: true,
    });
    expectDenied();
  });

  it('keeps enabled security across logout and same-account re-entry', async () => {
    const fixture = await ready();
    const oldLease = captureLocalAccessLease(scope);
    await setLocalAccessOwner(null, 2);
    expectDenied();
    await bind('B', 3);
    expect(getLocalAccessSnapshot()).toMatchObject({ userId: 'B', enabled: false, unlocked: true });
    fixture.authenticate.mockResolvedValue({ status: 'retryable', reason: 'user_cancel' });
    await bind('A', 4);
    expect(getLocalAccessSnapshot()).toMatchObject({ userId: 'A', enabled: true, unlocked: false });
    expect(fixture.records.get('A')).toEqual({ status: 'present', enabled: true });
    expect(() => {
      assertLocalAccessLease(oldLease);
    }).toThrow(LocalAccessDeniedError);
  });

  it('never carries an unlock grant into a fresh process owner', async () => {
    await ready();
    const oldLease = captureLocalAccessLease(scope);
    stop?.();
    setup({ status: 'present', enabled: true });
    await bind();
    expect(getLocalAccessSnapshot().unlocked).toBe(false);
    expect(() => {
      assertLocalAccessOwner(oldLease);
    }).toThrow(LocalAccessDeniedError);
  });

  it('keeps immutable snapshots and removes subscriptions on cleanup', async () => {
    const fixture = await ready(false);
    const observed: boolean[] = [];
    const unsubscribe = subscribeLocalAccess(() => {
      observed.push(getLocalAccessSnapshot().foregroundReady);
    });
    const previous = getLocalAccessSnapshot();
    fixture.emit('inactive');
    expect(previous.foregroundReady).toBe(true);
    expect(getLocalAccessSnapshot().foregroundReady).toBe(false);
    expect(() => Object.assign(previous, { unlocked: false })).toThrow(TypeError);
    unsubscribe();
    fixture.emit('active');
    expect(observed).toEqual([false]);
    stop?.();
    const disposed = getLocalAccessSnapshot();
    fixture.emit('background');
    expect(getLocalAccessSnapshot()).toBe(disposed);
    expectDenied();
  });
});

describe('authenticated setting changes and repair', () => {
  it.each([false, true])('authenticates and commits before changing enabled=%s', async enabled => {
    const fixture = await ready(enabled);
    const prompt = deferred<LocalAuthenticationOutcome>({
      status: 'retryable',
      reason: 'user_cancel',
    });
    const write = deferred<'committed' | 'failed'>('failed');
    const writing = deferred<undefined>(undefined);
    fixture.authenticate.mockReturnValue(prompt.promise);
    fixture.storage.write.mockImplementationOnce(async (userId, value) => {
      writing.resolve(undefined);
      const result = await write.promise;
      if (result === 'committed') {
        fixture.records.set(userId, { status: 'present', enabled: value });
      }
      return result;
    });
    const change = requestLocalAccess(enabled ? 'disable' : 'enable');
    expect(getLocalAccessSnapshot()).toMatchObject({ enabled, operation: 'authenticating' });
    expect(await requestLocalAccess('enable')).toBe('busy');
    prompt.resolve({ status: 'authenticated' });
    await writing.promise;
    expect(getLocalAccessSnapshot()).toMatchObject({ enabled, operation: 'writing' });
    expect(fixture.records.get('A')).toEqual({ status: 'present', enabled });
    expect(await requestLocalAccess('disable')).toBe('busy');
    write.resolve('committed');
    expect(await change).toBe('committed');
    expect(getLocalAccessSnapshot()).toMatchObject({
      enabled: !enabled,
      operation: 'idle',
      unlocked: true,
    });
    expect(fixture.records.get('A')).toEqual({ status: 'present', enabled: !enabled });
  });

  it.each([
    { status: 'retryable', reason: 'user_cancel' },
    { status: 'retryable', reason: 'system_cancel' },
    { status: 'retryable', reason: 'lockout' },
    { status: 'retryable', reason: 'rejected' },
    { status: 'unavailable', reason: 'not_enrolled' },
    { status: 'unavailable', reason: 'passcode_not_set' },
    { status: 'terminal', reason: 'invalid_context' },
    { status: 'terminal', reason: 'missing_usage_description' },
  ] satisfies LocalAuthenticationOutcome[])('preserves both prior values on %j', async outcome => {
    const fixture = await ready(false);
    fixture.authenticate.mockResolvedValue(outcome);
    expect(await requestLocalAccess('enable')).toEqual(outcome);
    expect(getLocalAccessSnapshot()).toMatchObject({ enabled: false, recovery: outcome });
    fixture.records.set('A', { status: 'present', enabled: true });
    await setLocalAccessOwner('A', 2);
    await requestLocalAccess('unlock', true);
    expect(await requestLocalAccess('disable')).toEqual(outcome);
    expect(getLocalAccessSnapshot()).toMatchObject({
      enabled: true,
      unlocked: false,
      recovery: outcome,
    });
    expect(fixture.records.get('A')).toEqual({ status: 'present', enabled: true });
    expectDenied();
  });

  it.each([
    [false, 'failed'],
    [false, 'stale'],
    [false, 'rejected'],
    [true, 'failed'],
    [true, 'stale'],
    [true, 'rejected'],
  ] as const)('preserves enabled=%s on a %s write', async (enabled, outcome) => {
    const fixture = await ready(enabled);
    if (outcome === 'rejected') {
      fixture.storage.write.mockRejectedValueOnce(new Error('Write failed'));
    } else {
      fixture.storage.write.mockResolvedValueOnce(outcome);
    }
    expect(await requestLocalAccess(enabled ? 'disable' : 'enable')).toBe(
      outcome === 'rejected' ? 'failed' : outcome
    );
    expect(getLocalAccessSnapshot()).toMatchObject({
      enabled,
      recovery: { status: 'retryable', reason: 'write_failed' },
    });
    expect(fixture.records.get('A')).toEqual({ status: 'present', enabled });
  });

  it('protects adapter promise rejection and never writes the setting', async () => {
    const fixture = await ready(false);
    fixture.authenticate.mockRejectedValueOnce(new Error('Adapter failed'));
    expect(await requestLocalAccess('enable')).toEqual({ status: 'retryable', reason: 'rejected' });
    expect(getLocalAccessSnapshot().enabled).toBe(false);
    expect(fixture.records.get('A')).toEqual({ status: 'present', enabled: false });
  });

  it('fences native success after account replacement and requires a new attempt', async () => {
    const fixture = setup({ status: 'present', enabled: true });
    fixture.records.set('B', { status: 'present', enabled: true });
    const prompt = deferred<LocalAuthenticationOutcome>({
      status: 'retryable',
      reason: 'user_cancel',
    });
    fixture.authenticate.mockReturnValueOnce(prompt.promise);
    await setLocalAccessOwner('A', 1);
    const old = requestLocalAccess();
    await setLocalAccessOwner('B', 2);
    setLocalAccessContextReady(true);
    prompt.resolve({ status: 'authenticated' });
    expect(await old).toBe('stale');
    expect(getLocalAccessSnapshot()).toMatchObject({ userId: 'B', enabled: true, unlocked: false });
    fixture.authenticate.mockResolvedValue({ status: 'authenticated' });
    expect(await requestLocalAccess()).toBe('unlocked');
    expect(captureLocalAccessLease({ userId: 'B', organizationId: null }).userId).toBe('B');
  });

  it.each([
    ['enable', 'account'],
    ['disable', 'account'],
    ['repair', 'account'],
    ['enable', 'lock'],
    ['disable', 'lock'],
    ['repair', 'lock'],
  ] as const)(
    'never publishes a delayed %s write after %s invalidation',
    async (action, invalidation) => {
      const prior: LocalAccessReadResult =
        action === 'repair'
          ? { status: 'malformed' }
          : { status: 'present', enabled: action === 'disable' };
      const fixture = setup(prior);
      fixture.authenticate.mockResolvedValue({ status: 'authenticated' });
      fixture.records.set('B', { status: 'present', enabled: true });
      await bind();
      const writing = deferred<undefined>(undefined);
      const write = deferred<'committed' | 'failed'>('failed');
      fixture.storage.write.mockImplementationOnce(async (userId, enabled) => {
        writing.resolve(undefined);
        const result = await write.promise;
        fixture.records.set(userId, { status: 'present', enabled });
        return result;
      });
      const old = requestLocalAccess(action);
      await writing.promise;
      if (invalidation === 'account') {
        await setLocalAccessOwner('B', 2);
      } else {
        lockLocalAccess();
      }
      const protectedSnapshot = getLocalAccessSnapshot();
      write.resolve('committed');
      expect(await old).toBe('stale');
      expect(getLocalAccessSnapshot()).toMatchObject({
        userId: protectedSnapshot.userId,
        enabled: protectedSnapshot.enabled,
        preference: protectedSnapshot.preference,
        unlocked: protectedSnapshot.unlocked,
      });
      expect(fixture.records.get('B')).toEqual({ status: 'present', enabled: true });
    }
  );

  it.each(['committed', 'failed', 'stale'] as const)(
    'repairs malformed security only after an enabled write: %s',
    async outcome => {
      const fixture = setup({ status: 'malformed' });
      fixture.authenticate.mockResolvedValue({ status: 'authenticated' });
      await bind();
      expect(getLocalAccessSnapshot()).toMatchObject({
        recovery: { status: 'repair', reason: 'malformed' },
        unlocked: false,
      });
      expect(await requestLocalAccess('disable')).toBe('denied');
      const writing = deferred<undefined>(undefined);
      const write = deferred<typeof outcome>(outcome);
      fixture.storage.write.mockImplementationOnce(async (userId, enabled) => {
        writing.resolve(undefined);
        const result = await write.promise;
        if (result === 'committed') {
          fixture.records.set(userId, { status: 'present', enabled });
        }
        return result;
      });
      const repair = requestLocalAccess('repair');
      await writing.promise;
      expect(getLocalAccessSnapshot()).toMatchObject({
        preference: 'malformed',
        enabled: null,
        unlocked: false,
      });
      write.resolve(outcome);
      expect(await repair).toBe(outcome);
      expect(getLocalAccessSnapshot()).toMatchObject(
        outcome === 'committed'
          ? { preference: 'present', enabled: true, unlocked: true }
          : { preference: 'malformed', enabled: null, unlocked: false }
      );
      expect(fixture.records.get('A')).toEqual(
        outcome === 'committed' ? { status: 'present', enabled: true } : { status: 'malformed' }
      );
    }
  );

  it('cannot repair malformed security after cancelled authentication', async () => {
    const fixture = setup({ status: 'malformed' });
    await bind();
    expect(await requestLocalAccess('repair')).toEqual({
      status: 'retryable',
      reason: 'user_cancel',
    });
    expect(getLocalAccessSnapshot()).toMatchObject({ enabled: null, unlocked: false });
    expect(fixture.records.get('A')).toEqual({ status: 'malformed' });
  });
});

describe.each([
  ['repair', { status: 'malformed' }, { enabled: null, nextEnabled: true }],
  ['enable', { status: 'present', enabled: false }, { enabled: false, nextEnabled: true }],
  ['disable', { status: 'present', enabled: true }, { enabled: true, nextEnabled: false }],
] as const)('pending %s authentication', (action, prior, { enabled, nextEnabled }) => {
  it.each([
    [1000, 300_999, { expected: 'committed', reason: null }],
    [1000, 301_000, { expected: 'stale', reason: null }],
    [1000, 301_001, { expected: 'stale', reason: null }],
    [1000, 999, { expected: 'stale', reason: 'invalid_clock' }],
    [1000, Number.NaN, { expected: 'stale', reason: 'invalid_clock' }],
    [1000, Infinity, { expected: 'stale', reason: 'invalid_clock' }],
    [1000, -Infinity, { expected: 'stale', reason: 'invalid_clock' }],
    [Number.NaN, 1000, { expected: 'stale', reason: 'invalid_clock' }],
    [Infinity, Infinity, { expected: 'stale', reason: 'invalid_clock' }],
  ] as const)(
    'fences delayed persistence across background time %s to %s',
    async (start, end, { expected, reason }) => {
      const fixture = setup(prior);
      fixture.authenticate.mockResolvedValue({ status: 'authenticated' });
      await bind();
      const lease = enabled === null ? null : captureLocalAccessLease(scope);
      const writing = deferred<undefined>(undefined);
      const write = deferred<'committed' | 'failed'>('failed');
      fixture.storage.write.mockImplementationOnce(async (userId, value) => {
        writing.resolve(undefined);
        const result = await write.promise;
        if (result === 'committed') {
          fixture.records.set(userId, { status: 'present', enabled: value });
        }
        return result;
      });
      const pending = requestLocalAccess(action);
      await writing.promise;
      fixture.setTime(start);
      fixture.emit('background');
      fixture.setTime(end);
      const published: (boolean | null)[] = [];
      const unsubscribe = subscribeLocalAccess(() => {
        published.push(getLocalAccessSnapshot().enabled);
      });
      try {
        fixture.emit('active');
        write.resolve('committed');
        expect(await pending).toBe(expected);
        expect(fixture.records.get('A')).toEqual({ status: 'present', enabled: nextEnabled });
        expect(getLocalAccessSnapshot().recovery).toEqual(
          reason ? { status: 'retryable', reason } : null
        );
        if (expected === 'committed') {
          expect(getLocalAccessSnapshot()).toMatchObject({ enabled: nextEnabled, unlocked: true });
          if (lease) {
            expect(() => {
              assertLocalAccessLease(lease);
            }).not.toThrow();
          }
          return;
        }
        expect(published).not.toContain(nextEnabled);
        expect(getLocalAccessSnapshot()).toMatchObject({
          preference: prior.status,
          enabled,
          operation: 'idle',
        });
        if (enabled !== false) {
          expectDenied();
        }
        if (lease) {
          expect(() => {
            assertLocalAccessLease(lease);
          }).toThrow(LocalAccessDeniedError);
        }

        const cancelled = { status: 'retryable', reason: 'user_cancel' } as const;
        fixture.authenticate.mockResolvedValueOnce(cancelled);
        expect(await requestLocalAccess(action)).toEqual(cancelled);
        expect(getLocalAccessSnapshot().enabled).toBe(enabled);
        fixture.emit('inactive');
        fixture.emit('active');
        expect(await requestLocalAccess('unlock', true)).toBe('denied');
        expect(await requestLocalAccess(action)).toBe('committed');
        expect(getLocalAccessSnapshot()).toMatchObject({ enabled: nextEnabled, unlocked: true });
        expect(() => captureLocalAccessLease(scope)).not.toThrow();
        if (lease) {
          expect(() => {
            assertLocalAccessLease(lease);
          }).toThrow(LocalAccessDeniedError);
        }
      } finally {
        unsubscribe();
      }
    }
  );

  it.each([301_000, Number.NaN])('fences a native result after background time %s', async end => {
    const fixture = setup(prior);
    fixture.authenticate.mockResolvedValue({ status: 'authenticated' });
    await bind();
    const prompt = deferred<LocalAuthenticationOutcome>({
      status: 'retryable',
      reason: 'user_cancel',
    });
    fixture.authenticate.mockReturnValueOnce(prompt.promise);
    const pending = requestLocalAccess(action);
    await Promise.resolve();
    fixture.emit('background');
    fixture.setTime(end);
    fixture.emit('active');
    prompt.resolve({ status: 'authenticated' });
    expect(await pending).toBe('stale');
    expect(fixture.records.get('A')).toEqual(prior);
    expect(getLocalAccessSnapshot()).toMatchObject({ preference: prior.status, enabled });
  });

  it('holds inactive-only success until foreground without expiring it', async () => {
    const fixture = setup(prior);
    fixture.authenticate.mockResolvedValue({ status: 'authenticated' });
    await bind();
    const prompt = deferred<LocalAuthenticationOutcome>({
      status: 'retryable',
      reason: 'user_cancel',
    });
    fixture.authenticate.mockReturnValueOnce(prompt.promise);
    const pending = requestLocalAccess(action);
    await Promise.resolve();
    fixture.emit('inactive');
    fixture.setTime(900_000);
    prompt.resolve({ status: 'authenticated' });
    expect(await pending).toBe('committed');
    expect(getLocalAccessSnapshot()).toMatchObject({
      enabled: nextEnabled,
      foregroundReady: false,
      unlocked: false,
    });
    expectDenied();
    fixture.emit('active');
    expect(getLocalAccessSnapshot().unlocked).toBe(true);
    expect(() => captureLocalAccessLease(scope)).not.toThrow();
  });
});

describe('lifecycle and attempt fencing', () => {
  it.each([299_999, 300_000, 300_001, -1, Number.NaN, Infinity, -Infinity])(
    'preserves idle disabled-account access across %sms in background',
    async elapsed => {
      const fixture = await ready(false);
      const lease = captureLocalAccessLease(scope);
      fixture.emit('background');
      fixture.setTime(1000 + elapsed);
      fixture.emit('active');
      expect(getLocalAccessSnapshot()).toMatchObject({
        enabled: false,
        unlocked: true,
        operation: 'idle',
        recovery: null,
      });
      expect(() => {
        assertLocalAccessLease(lease);
      }).not.toThrow();
    }
  );

  it.each([
    [299_999, true],
    [300_000, false],
    [300_001, false],
  ] as const)('evaluates %sms before publishing foreground access', async (elapsed, preserved) => {
    const fixture = await ready();
    const lease = captureLocalAccessLease(scope);
    const prompt = deferred<LocalAuthenticationOutcome>({
      status: 'retryable',
      reason: 'user_cancel',
    });
    fixture.authenticate.mockReturnValue(prompt.promise);
    fixture.emit('background');
    expectDenied();
    fixture.setTime(1000 + elapsed);
    const exposures: boolean[] = [];
    const unsubscribe = subscribeLocalAccess(() => {
      exposures.push(getLocalAccessSnapshot().unlocked);
    });
    fixture.emit('active');
    expect(getLocalAccessSnapshot().unlocked).toBe(preserved);
    expect(exposures.some(Boolean)).toBe(preserved);
    unsubscribe();
    if (preserved) {
      expect(() => {
        assertLocalAccessLease(lease);
      }).not.toThrow();
    } else {
      const pending = requestLocalAccess();
      prompt.resolve({ status: 'retryable', reason: 'user_cancel' });
      await pending;
      expect(() => {
        assertLocalAccessLease(lease);
      }).toThrow(LocalAccessDeniedError);
    }
  });

  it('retains the earliest background entry across repeated background and inactive events', async () => {
    const fixture = await ready();
    fixture.authenticate.mockResolvedValue({ status: 'retryable', reason: 'user_cancel' });
    fixture.emit('background');
    fixture.setTime(200_000);
    fixture.emit('inactive');
    fixture.emit('background');
    fixture.setTime(301_000);
    fixture.emit('active');
    await requestLocalAccess('unlock', true);
    expectDenied();
    expect(getLocalAccessSnapshot().unlocked).toBe(false);
  });

  it.each([
    [1000, 999],
    [1000, Number.NaN],
    [1000, Infinity],
    [1000, -Infinity],
    [Number.NaN, 1000],
    [Infinity, Infinity],
  ] as const)('protects invalid elapsed time from %s to %s', async (start, end) => {
    const fixture = await ready();
    fixture.authenticate.mockResolvedValue({ status: 'retryable', reason: 'user_cancel' });
    fixture.setTime(start);
    fixture.emit('background');
    fixture.setTime(end);
    fixture.emit('active');
    await requestLocalAccess('unlock', true);
    expect(getLocalAccessSnapshot().unlocked).toBe(false);
    expectDenied();
  });

  it('does not start a deadline for inactive-only transitions', async () => {
    const fixture = await ready();
    const lease = captureLocalAccessLease(scope);
    fixture.emit('inactive');
    expect(() => {
      assertLocalAccessLease(lease);
    }).toThrow(LocalAccessDeniedError);
    fixture.setTime(900_000);
    fixture.emit('active');
    expect(getLocalAccessSnapshot().unlocked).toBe(true);
    expect(() => {
      assertLocalAccessLease(lease);
    }).not.toThrow();
  });

  it.each(['inactive', 'background'] as const)(
    'starts protected while the process is %s',
    async state => {
      const fixture = setup({ status: 'present', enabled: true }, state);
      await bind();
      expectDenied();
      fixture.emit('active');
      await requestLocalAccess('unlock', true);
      expect(getLocalAccessSnapshot().unlocked).toBe(false);
    }
  );

  it('uses no suspended timer', async () => {
    vi.useFakeTimers();
    const fixture = await ready();
    fixture.emit('background');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(300_001);
    expect(getLocalAccessSnapshot()).toMatchObject({ foregroundReady: false, operation: 'idle' });
  });

  it('holds inactive success until foreground and coalesces prompt-related active events', async () => {
    const fixture = setup({ status: 'present', enabled: true });
    const prompt = deferred<LocalAuthenticationOutcome>({
      status: 'retryable',
      reason: 'user_cancel',
    });
    fixture.authenticate.mockReturnValue(prompt.promise);
    await setLocalAccessOwner('A', 1);
    setLocalAccessContextReady(true);
    const first = requestLocalAccess();
    fixture.emit('inactive');
    fixture.emit('active');
    const coalesced = requestLocalAccess('unlock', true);
    fixture.emit('inactive');
    fixture.setTime(900_000);
    prompt.resolve({ status: 'authenticated' });
    expect(await first).toBe('pending-foreground');
    expect(await coalesced).toBe('pending-foreground');
    expect(getLocalAccessSnapshot().unlocked).toBe(false);
    fixture.emit('active');
    expect(getLocalAccessSnapshot().unlocked).toBe(true);
  });

  it('requires explicit Retry after cancellation even after long background events', async () => {
    const fixture = setup({ status: 'present', enabled: true });
    await bind();
    fixture.authenticate.mockResolvedValue({ status: 'authenticated' });
    fixture.emit('inactive');
    fixture.emit('active');
    fixture.emit('background');
    fixture.setTime(301_000);
    fixture.emit('active');
    expect(await requestLocalAccess('unlock', true)).toBe('denied');
    expect(getLocalAccessSnapshot().unlocked).toBe(false);
    expect(await requestLocalAccess()).toBe('unlocked');
  });

  it('rejects old-attempt success after locking and permits only a later attempt', async () => {
    const fixture = await ready();
    lockLocalAccess();
    const prompt = deferred<LocalAuthenticationOutcome>({
      status: 'retryable',
      reason: 'user_cancel',
    });
    fixture.authenticate.mockReturnValueOnce(prompt.promise);
    const old = requestLocalAccess();
    await Promise.resolve();
    lockLocalAccess();
    prompt.resolve({ status: 'authenticated' });
    expect(await old).toBe('stale');
    expect(getLocalAccessSnapshot().unlocked).toBe(false);
    expect(await requestLocalAccess()).toBe('unlocked');
  });

  it('invalidates pending authentication when security restoration restarts', async () => {
    const fixture = await ready();
    lockLocalAccess();
    const prompt = deferred<LocalAuthenticationOutcome>({
      status: 'retryable',
      reason: 'user_cancel',
    });
    fixture.authenticate.mockReturnValueOnce(prompt.promise);
    const old = requestLocalAccess();
    await Promise.resolve();
    fixture.records.set('A', { status: 'malformed' });
    await reloadLocalAccessPreference();
    prompt.resolve({ status: 'authenticated' });
    expect(await old).toBe('stale');
    expect(getLocalAccessSnapshot()).toMatchObject({ preference: 'malformed', unlocked: false });
  });
  it.each(['account', 'lock', 'expired'] as const)(
    'rejects inactive success after %s invalidation',
    async invalidation => {
      const fixture = setup({ status: 'present', enabled: true });
      fixture.records.set('B', { status: 'present', enabled: true });
      const prompt = deferred<LocalAuthenticationOutcome>({
        status: 'retryable',
        reason: 'user_cancel',
      });
      fixture.authenticate.mockReturnValueOnce(prompt.promise);
      await setLocalAccessOwner('A', 1);
      const pending = requestLocalAccess();
      fixture.emit('inactive');
      prompt.resolve({ status: 'authenticated' });
      expect(await pending).toBe('pending-foreground');
      if (invalidation === 'account') {
        await setLocalAccessOwner('B', 2);
      } else if (invalidation === 'lock') {
        lockLocalAccess();
      } else {
        fixture.emit('background');
        fixture.setTime(301_000);
      }
      setLocalAccessContextReady(true);
      fixture.emit('active');
      await requestLocalAccess('unlock', true);
      expect(getLocalAccessSnapshot().unlocked).toBe(false);
      expectDenied();
    }
  );

  it('rejects an older same-account read after a newer read settles', async () => {
    const fixture = setup({ status: 'present', enabled: false });
    const read = deferred<LocalAccessReadResult>({ status: 'failed' });
    fixture.storage.read.mockReturnValueOnce(read.promise);
    const old = setLocalAccessOwner('A', 1);
    setLocalAccessContextReady(true);
    await reloadLocalAccessPreference();
    read.resolve({ status: 'present', enabled: true });
    await old;
    expect(getLocalAccessSnapshot()).toMatchObject({ userId: 'A', enabled: false, unlocked: true });
    expect(() => captureLocalAccessLease(scope)).not.toThrow();
  });
  it('ignores a late lifecycle callback from a disposed owner', async () => {
    const original = await ready(false);
    const deliver = original.queue('active');
    stop?.();
    setup({ status: 'present', enabled: false }, 'background');
    await bind();
    deliver();
    expect(getLocalAccessSnapshot()).toMatchObject({ foregroundReady: false, unlocked: false });
    expectDenied();
  });

  it('cannot grant a replacement account access through a setting subscriber', async () => {
    const fixture = await ready(false);
    fixture.records.set('B', { status: 'present', enabled: true });
    fixture.authenticate
      .mockResolvedValue({ status: 'retryable', reason: 'user_cancel' })
      .mockResolvedValueOnce({ status: 'authenticated' });
    const replacements: Promise<void>[] = [];
    const exposures: boolean[] = [];
    const unsubscribe = subscribeLocalAccess(() => {
      const current = getLocalAccessSnapshot();
      if (current.userId === 'B') {
        exposures.push(current.unlocked);
      }
      if (current.userId === 'A' && current.enabled && current.operation === 'writing') {
        replacements.push(setLocalAccessOwner('B', 2));
      }
    });
    try {
      await requestLocalAccess('enable');
      await Promise.all(replacements);
      setLocalAccessContextReady(true);
      await requestLocalAccess('unlock', true);
      expect(getLocalAccessSnapshot()).toMatchObject({
        userId: 'B',
        enabled: true,
        unlocked: false,
      });
      expect(exposures).not.toContain(true);
      expect(() => captureLocalAccessLease({ userId: 'B', organizationId: null })).toThrow(
        LocalAccessDeniedError
      );
    } finally {
      unsubscribe();
    }
  });
});

describe('immutable operation admission and passive completion', () => {
  it('captures context without retargeting an operation during context selection', async () => {
    await ready(false);
    const source = { userId: 'A', organizationId: 'old-org' };
    const lease = captureLocalAccessLease(source);
    source.organizationId = 'new-org';
    setLocalAccessContextReady(false);
    expect(() => {
      assertLocalAccessLease(lease);
    }).toThrow(LocalAccessDeniedError);
    setLocalAccessContextReady(true);
    const next = captureLocalAccessLease(source);
    expect(() => {
      assertLocalAccessLease(lease);
    }).not.toThrow();
    expect([lease.organizationId, next.organizationId]).toEqual(['old-org', 'new-org']);
    expect(() => Object.assign(lease, { organizationId: 'new-org' })).toThrow(TypeError);
  });

  it('never revives a locked lease but retains owner-safe accepted completion', async () => {
    const fixture = await ready();
    const lease = captureLocalAccessLease(scope);
    lockLocalAccess();
    fixture.emit('inactive');
    expect(() => {
      assertLocalAccessLease(lease);
    }).toThrow(LocalAccessDeniedError);
    expect(() => {
      assertLocalAccessOwner(lease);
    }).not.toThrow();
    fixture.emit('active');
    await requestLocalAccess();
    expect(getLocalAccessSnapshot().unlocked).toBe(true);
    expect(() => {
      assertLocalAccessLease(lease);
    }).toThrow(LocalAccessDeniedError);
    expect(() => {
      assertLocalAccessOwner(lease);
    }).not.toThrow();
    expect(() => captureLocalAccessLease(scope)).not.toThrow();
    await setLocalAccessOwner('B', 2);
    expect(() => {
      assertLocalAccessOwner(lease);
    }).toThrow(LocalAccessDeniedError);
  });

  it('rejects forged leases and same-user leases from an older auth epoch', async () => {
    await ready(false);
    const lease = captureLocalAccessLease(scope);
    expect(() => {
      assertLocalAccessOwner({ ...lease });
    }).toThrow(LocalAccessDeniedError);
    await bind('A', 2);
    expect(() => {
      assertLocalAccessOwner(lease);
    }).toThrow(LocalAccessDeniedError);
    expect(() => {
      assertLocalAccessLease(lease);
    }).toThrow(LocalAccessDeniedError);
  });
});
