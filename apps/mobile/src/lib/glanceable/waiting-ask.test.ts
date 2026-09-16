import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOpaqueScopeKey } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { CLOUD_AGENT_CONNECTION_ID } from '@/lib/active-sessions-live';

import {
  _resetWaitingAskForTests,
  _setSecureStoreForTests,
  getWaitingAsk,
  readWaitingAsk,
  recordWaitingAsk,
  selectWaitingAsk,
  type WaitingAsk,
} from './waiting-ask';

const NOW = 1_750_000_000_000;
const CTX = { userId: 'u1', organizationId: null };
const ASK_KEY = 'glanceable-waiting-ask';

const store = new Map<string, string>();

// Fake SecureStore surface backed by an in-memory Map, injected through the
// test-only setter so the durable mirror never loads the real native module.
const secureStoreMock = {
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    await Promise.resolve();
  }),
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
    await Promise.resolve();
  }),
};

function askFor(overrides: Partial<WaitingAsk> = {}): WaitingAsk {
  return {
    kiloSessionId: 's1',
    status: 'permission',
    isCloudAgent: false,
    scopeKey: buildOpaqueScopeKey(CTX),
    organizationId: null,
    userId: 'u1',
    recordedAt: NOW,
    ...overrides,
  };
}

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let storedResolve: (() => void) | undefined = undefined;
  const promise = new Promise<void>(resolve => {
    storedResolve = resolve;
  });
  return {
    promise,
    resolve: () => {
      storedResolve?.();
    },
  };
}

describe('selectWaitingAsk', () => {
  it('picks the oldest permission over a newer question', () => {
    const ask = selectWaitingAsk(
      [
        { id: 'question', status: 'question', statusUpdatedAt: at(-1000) },
        { id: 'permission', status: 'permission', statusUpdatedAt: at(-60_000) },
      ],
      CTX,
      NOW
    );
    expect(ask).toMatchObject({
      kiloSessionId: 'permission',
      status: 'permission',
      organizationId: null,
      userId: 'u1',
      recordedAt: NOW,
    });
  });

  it('breaks a tie on tray order', () => {
    const ask = selectWaitingAsk(
      [
        { id: 'first', status: 'permission', statusUpdatedAt: at(-5000) },
        { id: 'second', status: 'question', statusUpdatedAt: at(-5000) },
      ],
      CTX,
      NOW
    );
    expect(ask?.kiloSessionId).toBe('first');
  });

  it('returns null when only busy and idle rows are connected', () => {
    expect(
      selectWaitingAsk(
        [
          { id: 'busy', status: 'busy' },
          { id: 'idle', status: 'idle' },
        ],
        CTX,
        NOW
      )
    ).toBeNull();
    expect(selectWaitingAsk([], CTX, NOW)).toBeNull();
  });

  it('does not treat a retry row as an approvable ask', () => {
    // The tray folds `retry` into needs-input, but a retry has no permission or
    // question the activity could approve.
    expect(selectWaitingAsk([{ id: 'retry', status: 'retry' }], CTX, NOW)).toBeNull();
  });

  it('skips a waiting row that names no session', () => {
    expect(selectWaitingAsk([{ status: 'permission' }], CTX, NOW)).toBeNull();
    expect(
      selectWaitingAsk([{ status: 'permission' }, { id: 's2', status: 'question' }], CTX, NOW)
    ).toMatchObject({ kiloSessionId: 's2' });
  });

  it('names a lone waiting row that carries no status time, after any dated row', () => {
    expect(selectWaitingAsk([{ id: 'undated', status: 'question' }], CTX, NOW)?.kiloSessionId).toBe(
      'undated'
    );
    expect(
      selectWaitingAsk(
        [
          { id: 'undated', status: 'question' },
          { id: 'dated', status: 'permission', statusUpdatedAt: at(-1) },
        ],
        CTX,
        NOW
      )?.kiloSessionId
    ).toBe('dated');
  });

  it('marks the cloud-agent row and reuses the snapshot scope key', () => {
    const cloudCtx = { userId: 'u1', organizationId: 'org-1' };
    const ask = selectWaitingAsk(
      [{ id: 'cloud', status: 'permission', connectionId: CLOUD_AGENT_CONNECTION_ID }],
      cloudCtx,
      NOW
    );
    expect(ask).toMatchObject({
      isCloudAgent: true,
      organizationId: 'org-1',
      scopeKey: buildOpaqueScopeKey(cloudCtx),
    });
  });

  it('treats a row with no connectionId as not cloud-agent', () => {
    const ask = selectWaitingAsk(
      [{ id: 'cli', status: 'question', connectionId: 'cli-1' }],
      CTX,
      NOW
    );
    expect(ask?.isCloudAgent).toBe(false);
    expect(selectWaitingAsk([{ id: 'bare', status: 'question' }], CTX, NOW)?.isCloudAgent).toBe(
      false
    );
  });
});

describe('waiting ask store', () => {
  beforeEach(() => {
    _resetWaitingAskForTests();
    _setSecureStoreForTests(secureStoreMock);
    store.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetWaitingAskForTests();
    store.clear();
  });

  it('round-trips the ask and clears both the memory and the mirror', async () => {
    const ask = askFor();
    recordWaitingAsk(ask);
    expect(getWaitingAsk()).toEqual(ask);
    expect(store.get(ASK_KEY)).toBe(JSON.stringify(ask));

    recordWaitingAsk(null);
    expect(getWaitingAsk()).toBeNull();
    expect(store.has(ASK_KEY)).toBe(false);
    await expect(readWaitingAsk()).resolves.toBeNull();
  });

  it('replaces the previous ask with the next one', () => {
    recordWaitingAsk(askFor({ kiloSessionId: 's1' }));
    const second = askFor({ kiloSessionId: 's2', status: 'question' });
    recordWaitingAsk(second);
    expect(getWaitingAsk()).toEqual(second);
    expect(store.get(ASK_KEY)).toBe(JSON.stringify(second));
  });

  it('survives a JS restart through the SecureStore mirror', async () => {
    const ask = askFor({ kiloSessionId: 's7', status: 'question' });
    recordWaitingAsk(ask);

    // A JS restart drops every module-local value; only the mirror remains.
    _resetWaitingAskForTests();
    _setSecureStoreForTests(secureStoreMock);
    expect(getWaitingAsk()).toBeNull();

    await expect(readWaitingAsk()).resolves.toEqual(ask);
    expect(getWaitingAsk()).toEqual(ask);
  });

  it('keeps a live record that lands during the hydration read', async () => {
    const stale = askFor({ kiloSessionId: 'stale' });
    store.set(ASK_KEY, JSON.stringify(stale));

    const gate = deferred();
    secureStoreMock.getItemAsync.mockImplementationOnce(async () => {
      await gate.promise;
      return JSON.stringify(stale);
    });

    const pending = readWaitingAsk();
    const fresh = askFor({ kiloSessionId: 'fresh', status: 'question' });
    recordWaitingAsk(fresh);
    gate.resolve();

    await expect(pending).resolves.toEqual(fresh);
  });

  it('treats a malformed mirror as absent', async () => {
    store.set(ASK_KEY, JSON.stringify({ kiloSessionId: 42 }));
    await expect(readWaitingAsk()).resolves.toBeNull();
  });

  it('hydrates once, so a later read sees a record made after the first read', async () => {
    await expect(readWaitingAsk()).resolves.toBeNull();
    const ask = askFor({ kiloSessionId: 'late' });
    recordWaitingAsk(ask);
    await expect(readWaitingAsk()).resolves.toEqual(ask);
  });
});
