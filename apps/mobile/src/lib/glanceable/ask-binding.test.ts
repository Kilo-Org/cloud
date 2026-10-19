/* eslint-disable require-await -- fakes settle without await */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type WaitingAsk } from './waiting-ask';

/**
 * The record's request binding: one control-plane read per ask identity, kept
 * while the ask is still the one the surface names.
 *
 * The two native modules the default read goes through are replaced here; the
 * store under test is the real one, with an in-memory SecureStore, because the
 * binding lives on the record the answer path reads.
 */
vi.mock('./cloud-agent-session', () => ({
  NotApprovableError: class NotApprovableError extends Error {},
  resolveCloudAgentSessionId: vi.fn(),
}));
vi.mock('./pending-permission', () => ({ resolvePendingPermissionId: vi.fn() }));

const {
  ASK_BIND_RETRY_MS,
  _resetAskBindingForTests,
  _setAskBindingForTests,
  _whenAskBindsSettledForTests,
  recordSelectedAsk,
  subscribeAskBound,
  whenAskBindingSettled,
} = await import('./ask-binding');
const { _resetWaitingAskForTests, _setSecureStoreForTests, getWaitingAsk } = await import(
  './waiting-ask'
);

const NOW = 1_750_000_000_000;
const STORED_AT = '2026-01-01T00:00:00.000Z';

const store = new Map<string, string>();
const secureStoreMock = {
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
};

function askFor(overrides: Partial<WaitingAsk> = {}): WaitingAsk {
  return {
    kiloSessionId: 'ses_1',
    status: 'permission',
    isCloudAgent: true,
    scopeKey: 'scope',
    organizationId: null,
    userId: 'u1',
    recordedAt: NOW,
    statusUpdatedAt: STORED_AT,
    boundPermissionId: null,
    ...overrides,
  };
}

/** A read the case settles by hand, so a select can be held mid-flight. */
function deferredRead(): {
  read: () => Promise<string | null>;
  resolve: (permissionId: string | null) => void;
} {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  return {
    read: async () => promise,
    resolve,
  };
}

let clock = NOW;

beforeEach(() => {
  _resetWaitingAskForTests();
  _resetAskBindingForTests();
  _setSecureStoreForTests(secureStoreMock);
  store.clear();
  clock = NOW;
  _setAskBindingForTests({ now: () => clock });
});

afterEach(() => {
  _resetWaitingAskForTests();
  _resetAskBindingForTests();
  store.clear();
});

describe('recordSelectedAsk', () => {
  it('records a new ask unbound, then binds it once the read lands', async () => {
    const read = deferredRead();
    _setAskBindingForTests({ read: read.read, now: () => clock });
    const bound = vi.fn<() => void>();
    subscribeAskBound(bound);

    recordSelectedAsk(askFor());
    expect(getWaitingAsk()).toMatchObject({ boundPermissionId: null });

    read.resolve('perm_1');
    await whenAskBindingSettled();

    expect(getWaitingAsk()).toMatchObject({ kiloSessionId: 'ses_1', boundPermissionId: 'perm_1' });
    // The surfaces read the ask at draw time, so the bind asks for one redraw.
    expect(bound).toHaveBeenCalledTimes(1);
  });

  it('carries the binding across a select of the same ask, with no second read', async () => {
    const read = vi.fn(async () => 'perm_1');
    _setAskBindingForTests({ read, now: () => clock });
    recordSelectedAsk(askFor());
    await whenAskBindingSettled();

    // The publisher re-selects on every tray heartbeat; only `recordedAt` moves.
    recordSelectedAsk(askFor({ recordedAt: NOW + 5000 }));
    await whenAskBindingSettled();

    expect(read).toHaveBeenCalledTimes(1);
    expect(getWaitingAsk()).toMatchObject({ boundPermissionId: 'perm_1' });
  });

  it('reads a new binding when the session asks again', async () => {
    const read = vi.fn(async () => 'perm_1');
    _setAskBindingForTests({ read, now: () => clock });
    recordSelectedAsk(askFor());
    await whenAskBindingSettled();

    // A replacement request on the same session has a new status time: the
    // previous binding names a request the surface no longer shows.
    read.mockResolvedValue('perm_2');
    recordSelectedAsk(askFor({ statusUpdatedAt: '2026-01-01T00:01:00.000Z' }));
    await whenAskBindingSettled();

    expect(read).toHaveBeenCalledTimes(2);
    expect(getWaitingAsk()).toMatchObject({ boundPermissionId: 'perm_2' });
  });

  it('stays unbound after a failed read and retries only after the cooldown', async () => {
    const read = vi.fn(async (): Promise<string | null> => {
      throw new Error('control plane unavailable');
    });
    _setAskBindingForTests({ read, now: () => clock });
    recordSelectedAsk(askFor());
    await whenAskBindingSettled();
    expect(getWaitingAsk()).toMatchObject({ boundPermissionId: null });

    clock += ASK_BIND_RETRY_MS - 1;
    recordSelectedAsk(askFor({ recordedAt: clock }));
    await whenAskBindingSettled();
    expect(read).toHaveBeenCalledTimes(1);

    clock += 1;
    read.mockResolvedValue('perm_1');
    recordSelectedAsk(askFor({ recordedAt: clock }));
    await whenAskBindingSettled();
    expect(read).toHaveBeenCalledTimes(2);
    expect(getWaitingAsk()).toMatchObject({ boundPermissionId: 'perm_1' });
  });

  it('treats an empty projection as unbound, like a failed read', async () => {
    const read = vi.fn(async () => null);
    _setAskBindingForTests({ read, now: () => clock });
    recordSelectedAsk(askFor());
    await whenAskBindingSettled();

    expect(getWaitingAsk()).toMatchObject({ boundPermissionId: null });
  });

  it('drops a read that lands after the ask moved on', async () => {
    const first = deferredRead();
    let reads = 0;
    _setAskBindingForTests({
      read: async () => {
        reads += 1;
        const permissionId = reads === 1 ? await first.read() : 'perm_next';
        return permissionId;
      },
      now: () => clock,
    });

    recordSelectedAsk(askFor());
    recordSelectedAsk(askFor({ kiloSessionId: 'ses_2', statusUpdatedAt: null }));
    await whenAskBindingSettled();
    expect(getWaitingAsk()).toMatchObject({ kiloSessionId: 'ses_2', boundPermissionId: 'perm_next' });

    first.resolve('perm_stale');
    await _whenAskBindsSettledForTests();

    expect(getWaitingAsk()).toMatchObject({ kiloSessionId: 'ses_2', boundPermissionId: 'perm_next' });
  });

  it('never resurrects a cleared ask when its read lands', async () => {
    const read = deferredRead();
    _setAskBindingForTests({ read: read.read, now: () => clock });
    recordSelectedAsk(askFor());
    recordSelectedAsk(null);

    read.resolve('perm_1');
    await whenAskBindingSettled();

    expect(getWaitingAsk()).toBeNull();
  });

  it('does not read the control plane for a question ask', async () => {
    const read = vi.fn(async () => 'perm_1');
    _setAskBindingForTests({ read, now: () => clock });
    recordSelectedAsk(askFor({ status: 'question', isCloudAgent: false }));
    await whenAskBindingSettled();

    expect(read).not.toHaveBeenCalled();
    expect(getWaitingAsk()).toMatchObject({ status: 'question', boundPermissionId: null });
  });
});

describe('whenAskBindingSettled', () => {
  it('resolves immediately when nothing is being read', async () => {
    await expect(whenAskBindingSettled()).resolves.toBeUndefined();
  });

  it('resolves once the read in flight landed', async () => {
    const read = deferredRead();
    _setAskBindingForTests({ read: read.read, now: () => clock });
    recordSelectedAsk(askFor());

    let settled = false;
    const waiting = (async () => {
      await whenAskBindingSettled();
      settled = true;
    })();
    await Promise.resolve();
    expect(settled).toBe(false);

    read.resolve('perm_1');
    await waiting;
    expect(getWaitingAsk()).toMatchObject({ boundPermissionId: 'perm_1' });
  });
});
