/* eslint-disable require-await, @typescript-eslint/require-await -- the in-memory KV fake settles without await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The resolved-failure memory stores through the encrypted-kv module; the mock
// below is an in-memory per-scope store with the real map semantics, keeping
// the native SQLCipher chain out of this node suite.
const kvMock = vi.hoisted(() => {
  const scopes = new Map<string, Map<string, { v: string; updatedAt: number }>>();
  let clock = 0;
  return {
    scopes,
    getItem: vi.fn<(scope: string, k: string) => Promise<string | null>>(
      async (scope, k) => scopes.get(scope)?.get(k)?.v ?? null
    ),
    setItem: vi.fn(async (scope: string, k: string, v: string) => {
      clock += 1;
      let bucket = scopes.get(scope);
      if (!bucket) {
        bucket = new Map();
        scopes.set(scope, bucket);
      }
      bucket.set(k, { v, updatedAt: clock });
    }),
    removeItem: vi.fn(async (scope: string, k: string) => {
      scopes.get(scope)?.delete(k);
    }),
    listEntries: vi.fn(async (scope: string) =>
      [...(scopes.get(scope)?.entries() ?? [])]
        .map(([k, entry]) => ({ k, updatedAt: entry.updatedAt }))
        .sort((a, b) => a.updatedAt - b.updatedAt)
    ),
  };
});

vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: kvMock.getItem,
  setItem: kvMock.setItem,
  removeItem: kvMock.removeItem,
  listEntries: kvMock.listEntries,
}));

// `readCacheScope` is imported from read-cache, which loads expo-secure-store.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

/* eslint-disable import/first */
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { readCacheScope } from '@/lib/persist/read-cache';
import {
  persistResolvedDeliveryFailure,
  readResolvedDeliveryFailures,
  RESOLVED_DELIVERY_MAX_IDS,
  RESOLVED_DELIVERY_MAX_SESSIONS,
} from './resolved-delivery-failures';
/* eslint-enable import/first */

const USER_ID = 'u1';
const SESSION_ID = 'ses-1';
const OWNER = { userId: USER_ID, authEpoch: currentAuthEpoch() };
const KEY = `resolved-delivery:${SESSION_ID}`;

describe('resolved delivery failures', () => {
  beforeEach(() => {
    kvMock.scopes.clear();
    kvMock.getItem.mockClear();
    kvMock.setItem.mockClear();
    kvMock.removeItem.mockClear();
    setSignOutActive(false);
  });

  it('reads an empty list for a session with no recorded resolution', async () => {
    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual([]);
  });

  it('round-trips a recorded resolution in the read-cache scope', async () => {
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual(['msg-1']);
    const [scope, key] = vi.mocked(kvMock.setItem).mock.calls[0] ?? [];
    expect(scope).toBe(readCacheScope(USER_ID));
    expect(key).toBe(KEY);
  });

  it('keeps one entry per id and preserves order', async () => {
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-2');
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual([
      'msg-1',
      'msg-2',
    ]);
  });

  it('caps the list, dropping the oldest ids', async () => {
    const total = RESOLVED_DELIVERY_MAX_IDS + 2;
    for (let index = 0; index < total; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- cap order depends on write order.
      await persistResolvedDeliveryFailure(OWNER, SESSION_ID, `msg-${index}`);
    }

    const ids = await readResolvedDeliveryFailures(USER_ID, SESSION_ID);
    expect(ids).toHaveLength(RESOLVED_DELIVERY_MAX_IDS);
    expect(ids).not.toContain('msg-0');
    expect(ids).not.toContain('msg-1');
    expect(ids).toContain(`msg-${total - 1}`);
  });

  it('never leaks one account resolution to another account', async () => {
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');

    await expect(readResolvedDeliveryFailures('u2', SESSION_ID)).resolves.toEqual([]);
  });

  it('evicts the oldest sessions beyond the session cap', async () => {
    const total = RESOLVED_DELIVERY_MAX_SESSIONS + 2;
    for (let index = 0; index < total; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- eviction order depends on write order.
      await persistResolvedDeliveryFailure(OWNER, `ses-${index}`, 'msg-1');
    }

    const resolved = [...(kvMock.scopes.get(readCacheScope(USER_ID))?.keys() ?? [])].filter(key =>
      key.startsWith('resolved-delivery:')
    );
    expect(resolved).toHaveLength(RESOLVED_DELIVERY_MAX_SESSIONS);
    expect(resolved).not.toContain('resolved-delivery:ses-0');
    expect(resolved).not.toContain('resolved-delivery:ses-1');
    expect(resolved).toContain(`resolved-delivery:ses-${total - 1}`);
  });

  it('does not evict the read-cache blob or transcript pages that share the scope', async () => {
    const scope = readCacheScope(USER_ID);
    kvMock.scopes.set(
      scope,
      new Map([
        ['read-cache', { v: '{"blob":true}', updatedAt: 0 }],
        ['transcript:ses-1', { v: '{"page":true}', updatedAt: 0 }],
      ])
    );

    for (let index = 0; index <= RESOLVED_DELIVERY_MAX_SESSIONS; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- eviction order depends on write order.
      await persistResolvedDeliveryFailure(OWNER, `ses-${index}`, 'msg-1');
    }

    expect(kvMock.scopes.get(scope)?.has('read-cache')).toBe(true);
    expect(kvMock.scopes.get(scope)?.has('transcript:ses-1')).toBe(true);
  });

  it('returns an empty list for malformed JSON and a wrong shape', async () => {
    const scope = readCacheScope(USER_ID);
    kvMock.scopes.set(scope, new Map([[KEY, { v: 'not-json', updatedAt: 1 }]]));
    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual([]);

    kvMock.scopes.set(scope, new Map([[KEY, { v: '{"nope":true}', updatedAt: 1 }]]));
    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual([]);
  });

  it('is a no-op for an empty owner, session id, or message id', async () => {
    await persistResolvedDeliveryFailure(
      { userId: '', authEpoch: OWNER.authEpoch },
      SESSION_ID,
      'm'
    );
    await persistResolvedDeliveryFailure(OWNER, '', 'm');
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, '');

    expect(kvMock.setItem).not.toHaveBeenCalled();
    await expect(readResolvedDeliveryFailures('', SESSION_ID)).resolves.toEqual([]);
    await expect(readResolvedDeliveryFailures(USER_ID, '')).resolves.toEqual([]);
  });

  it('refuses to write while a sign-out is active', async () => {
    setSignOutActive(true);
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');

    expect(kvMock.setItem).not.toHaveBeenCalled();
  });

  it('refuses a write whose captured auth epoch has moved', async () => {
    await persistResolvedDeliveryFailure(
      { userId: USER_ID, authEpoch: OWNER.authEpoch - 1 },
      SESSION_ID,
      'msg-1'
    );

    expect(kvMock.setItem).not.toHaveBeenCalled();
  });

  it('serializes concurrent writes so neither resolution is dropped', async () => {
    // `persistResolvedDeliveryFailure` is fired without awaiting per retry, so
    // the second call starts while the first one's read is still in flight. The
    // chain must keep the read-modify-write pairs apart: unserialized, the
    // second write would start from the pre-write list and drop the first id.
    const first = persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');
    const second = persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-2');
    await Promise.all([first, second]);

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual([
      'msg-1',
      'msg-2',
    ]);
  });

  it('refuses a write when sign-out starts during the awaited read', async () => {
    // Sign-out flips its flag, bumps the epoch and clears `cache:<userId>:`
    // while this call is still awaiting its read. The write that follows must
    // not repopulate the scope teardown just cleared.
    kvMock.getItem.mockImplementationOnce(async () => {
      setSignOutActive(true);
      return null;
    });

    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');

    expect(kvMock.setItem).not.toHaveBeenCalled();
  });

  it('swallows a read failure', async () => {
    kvMock.getItem.mockRejectedValueOnce(new Error('kv unavailable'));

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual([]);
  });
});
