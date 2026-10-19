/* eslint-disable require-await, @typescript-eslint/require-await -- the fake's methods resolve immediately, so the mirror chain settles without await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetWaitingAskBindingForTests, bindWaitingAskPermission } from './waiting-ask-binding';
import {
  _flushWaitingAskMirrorForTests,
  _resetWaitingAskForTests,
  _setSecureStoreForTests,
  getWaitingAsk,
  type WaitingAsk,
} from './waiting-ask';
import { resolveCloudAgentSessionId, resolvePendingPermissionId } from './pending-permission';

vi.mock('./pending-permission', () => ({
  resolveCloudAgentSessionId: vi.fn<() => Promise<string>>(),
  resolvePendingPermissionId: vi.fn<() => Promise<string | null>>(),
}));

const resolveCloudAgentSessionIdMock = vi.mocked(resolveCloudAgentSessionId);
const resolvePendingPermissionIdMock = vi.mocked(resolvePendingPermissionId);

const NOW = Date.parse('2026-10-19T00:00:00.000Z');

function askFor(overrides: Partial<WaitingAsk> = {}): WaitingAsk {
  return {
    kiloSessionId: 'ses_1',
    status: 'permission',
    isCloudAgent: true,
    scopeKey: 'scope',
    organizationId: null,
    userId: 'u1',
    recordedAt: NOW,
    statusUpdatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const inMemoryStore = () => {
  const store = new Map<string, string>();
  return {
    setItemAsync: async (key: string, value: string) => {
      store.set(key, value);
    },
    getItemAsync: async (key: string) => store.get(key) ?? null,
    deleteItemAsync: async (key: string) => {
      store.delete(key);
    },
  };
};

/** Flush the capture chain: the record, then the async attach it scheduled. */
async function flushBinding(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await _flushWaitingAskMirrorForTests();
}

describe('bindWaitingAskPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWaitingAskBindingForTests();
    _resetWaitingAskForTests();
    _setSecureStoreForTests(inMemoryStore());
    resolveCloudAgentSessionIdMock.mockResolvedValue('agent_1');
    resolvePendingPermissionIdMock.mockResolvedValue('perm_live');
  });

  it('records the ask and attaches the live permission id it displayed', async () => {
    bindWaitingAskPermission(askFor());
    expect(getWaitingAsk()?.permissionId).toBeUndefined();
    await flushBinding();
    expect(getWaitingAsk()?.permissionId).toBe('perm_live');
  });

  it('carries the binding across heartbeat re-records of the same ask', async () => {
    bindWaitingAskPermission(askFor());
    await flushBinding();
    // The publisher re-selects the same row every tray tick; only recordedAt
    // moves. The captured id must survive the re-record.
    bindWaitingAskPermission(askFor({ recordedAt: NOW + 1000 }));
    expect(getWaitingAsk()?.permissionId).toBe('perm_live');
    expect(resolvePendingPermissionIdMock).toHaveBeenCalledTimes(1);
  });

  it('re-binds when the displayed request changes (new statusUpdatedAt)', async () => {
    bindWaitingAskPermission(askFor());
    await flushBinding();
    resolvePendingPermissionIdMock.mockResolvedValue('perm_next');
    bindWaitingAskPermission(askFor({ statusUpdatedAt: '2026-01-01T00:01:00.000Z' }));
    await flushBinding();
    expect(getWaitingAsk()?.permissionId).toBe('perm_next');
    expect(resolvePendingPermissionIdMock).toHaveBeenCalledTimes(2);
  });

  it('never attaches a capture after the ask moved on', async () => {
    resolvePendingPermissionIdMock
      .mockResolvedValueOnce('perm_first')
      .mockResolvedValueOnce('perm_fresh');
    bindWaitingAskPermission(askFor());
    // The tray moved on before the first read settled: a different session.
    bindWaitingAskPermission(askFor({ kiloSessionId: 'ses_2', recordedAt: NOW + 1 }));
    await flushBinding();
    expect(getWaitingAsk()?.kiloSessionId).toBe('ses_2');
    // Each ask carries only the capture started for it.
    expect(getWaitingAsk()?.permissionId).toBe('perm_fresh');
  });

  it('clears the record on null and forgets the cooldown', async () => {
    bindWaitingAskPermission(askFor({ permissionId: null }));
    resolvePendingPermissionIdMock.mockRejectedValue(new Error('offline'));
    await flushBinding();
    expect(getWaitingAsk()?.permissionId).toBeNull();
    bindWaitingAskPermission(null);
    expect(getWaitingAsk()).toBeNull();
    // A cleared cooldown means the next ask re-reads the projection.
    resolvePendingPermissionIdMock.mockResolvedValue('perm_next');
    bindWaitingAskPermission(askFor({ kiloSessionId: 'ses_3' }));
    await flushBinding();
    expect(getWaitingAsk()?.permissionId).toBe('perm_next');
  });

  it('skips the capture for a question, a retry, or a non-cloud ask', async () => {
    const asks = [
      askFor({ status: 'question' }),
      askFor({ status: 'retry' }),
      askFor({ isCloudAgent: false }),
    ];
    for (const ask of asks) {
      bindWaitingAskPermission(ask);
      expect(getWaitingAsk()?.permissionId).toBeUndefined();
    }
    await flushBinding();
    expect(resolvePendingPermissionIdMock).not.toHaveBeenCalled();
  });

  it('keeps an already-bound ask without reopening the stream', async () => {
    bindWaitingAskPermission(askFor({ permissionId: 'perm_kept' }));
    await flushBinding();
    expect(getWaitingAsk()?.permissionId).toBe('perm_kept');
    expect(resolvePendingPermissionIdMock).not.toHaveBeenCalled();
  });

  it('backs off a failed capture until the cooldown passes', async () => {
    resolveCloudAgentSessionIdMock.mockRejectedValue(new Error('offline'));
    let now = NOW;
    bindWaitingAskPermission(askFor(), { now: () => now });
    await flushBinding();
    expect(getWaitingAsk()?.permissionId).toBeUndefined();

    // Inside the cooldown the next heartbeat re-record retries nothing.
    now += 1000;
    bindWaitingAskPermission(askFor({ recordedAt: now }), { now: () => now });
    await flushBinding();
    expect(resolveCloudAgentSessionIdMock).toHaveBeenCalledTimes(1);

    // Past the cooldown the next record retries.
    now += 60_000;
    resolveCloudAgentSessionIdMock.mockResolvedValue('agent_1');
    bindWaitingAskPermission(askFor({ recordedAt: now }), { now: () => now });
    await flushBinding();
    expect(getWaitingAsk()?.permissionId).toBe('perm_live');
  });

  it('marks a proven-absent projection as failed until the identity changes', async () => {
    resolvePendingPermissionIdMock.mockResolvedValue(null);
    bindWaitingAskPermission(askFor());
    await flushBinding();
    expect(getWaitingAsk()?.permissionId).toBeUndefined();
    expect(resolvePendingPermissionIdMock).toHaveBeenCalledTimes(1);
    // The next heartbeat inside the window does not reopen the stream.
    bindWaitingAskPermission(askFor({ recordedAt: NOW + 1000 }));
    await flushBinding();
    expect(resolvePendingPermissionIdMock).toHaveBeenCalledTimes(1);
  });
});
