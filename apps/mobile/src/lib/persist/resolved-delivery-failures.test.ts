/* eslint-disable max-lines -- one suite owns the resolved-delivery record: its caps, its legacy migration, and its life across sign-out and a schema bump */
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
    listEntriesWithValues: vi.fn(async (scope: string) =>
      [...(scopes.get(scope)?.entries() ?? [])]
        .map(([k, entry]) => ({ k, updatedAt: entry.updatedAt, v: entry.v }))
        .sort((a, b) => a.updatedAt - b.updatedAt)
    ),
  };
});

vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: kvMock.getItem,
  setItem: kvMock.setItem,
  removeItem: kvMock.removeItem,
  listEntriesWithValues: kvMock.listEntriesWithValues,
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
import { deliveryScope } from '@/lib/persist/cache-scope';
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
const TOMBSTONE_JSON = '{"items":[],"complete":false}';

function deliveryBucket(): Map<string, { v: string; updatedAt: number }> | undefined {
  return kvMock.scopes.get(deliveryScope(USER_ID));
}

function resolvedRecord(sessionId: string): { v: string; updatedAt: number } | undefined {
  return deliveryBucket()?.get(`resolved-delivery:${sessionId}`);
}

/** The clear `clearCacheScopeForSignOut` performs: drop `cache:<userId>:*`. */
function clearReadCacheScopes(userId: string): void {
  const prefix = `cache:${userId}:`;
  for (const scope of kvMock.scopes.keys()) {
    if (scope.startsWith(prefix)) {
      kvMock.scopes.delete(scope);
    }
  }
}

describe('resolved delivery failures', () => {
  beforeEach(() => {
    kvMock.scopes.clear();
    kvMock.getItem.mockClear();
    kvMock.setItem.mockClear();
    kvMock.removeItem.mockClear();
    setSignOutActive(false);
  });

  it('reads a complete, empty record for a session with no recorded resolution', async () => {
    // Nothing is stored in either scope: the ordinary state of a session whose
    // footers were never dismissed, which must not read as cut short.
    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [],
      complete: true,
    });
  });

  it('round-trips a recorded resolution in the delivery scope', async () => {
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual({
      items: ['msg-1'],
      complete: true,
    });
    const [scope, key] = vi.mocked(kvMock.setItem).mock.calls[0] ?? [];
    expect(scope).toBe(deliveryScope(USER_ID));
    expect(key).toBe(KEY);
    expect(resolvedRecord(SESSION_ID)?.v).toBe('{"items":["msg-1"],"complete":true}');
  });

  it('keeps one entry per id and preserves order', async () => {
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-2');
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual({
      items: ['msg-1', 'msg-2'],
      complete: true,
    });
  });

  it('marks a session incomplete once its ids outgrow the per-session cap', async () => {
    const total = RESOLVED_DELIVERY_MAX_IDS + 2;
    for (let index = 0; index < total; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- cap order depends on write order.
      await persistResolvedDeliveryFailure(OWNER, SESSION_ID, `msg-${index}`);
    }

    const record = await readResolvedDeliveryFailures(USER_ID, SESSION_ID);
    expect(record.complete).toBe(false);
    expect(record.items).toHaveLength(RESOLVED_DELIVERY_MAX_IDS);
    expect(record.items).not.toContain('msg-0');
    expect(record.items).not.toContain('msg-1');
    expect(record.items).toContain(`msg-${total - 1}`);
  });

  it('never leaks one account resolution to another account', async () => {
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');

    await expect(readResolvedDeliveryFailures('u2', SESSION_ID)).resolves.toEqual({
      items: [],
      complete: true,
    });
  });

  it('retires the oldest session into a tombstone once the session cap is passed', async () => {
    const total = RESOLVED_DELIVERY_MAX_SESSIONS + 1;
    for (let index = 0; index < total; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- retirement order depends on write order.
      await persistResolvedDeliveryFailure(OWNER, `ses-${index}`, 'msg-1');
    }

    // The oldest session is retired, not deleted: its key is still there and
    // reads back incomplete, which a miss can never be told apart from.
    expect(resolvedRecord('ses-0')?.v).toBe(TOMBSTONE_JSON);
    await expect(readResolvedDeliveryFailures(USER_ID, 'ses-0')).resolves.toEqual({
      items: [],
      complete: false,
    });
    await expect(readResolvedDeliveryFailures(USER_ID, `ses-${total - 1}`)).resolves.toEqual({
      items: ['msg-1'],
      complete: true,
    });

    const family = [...(deliveryBucket()?.keys() ?? [])].filter(key =>
      key.startsWith('resolved-delivery:')
    );
    expect(family).toHaveLength(RESOLVED_DELIVERY_MAX_SESSIONS + 1);
  });

  it('does not touch another delivery family or the read cache that shares the store', async () => {
    const cacheScope = readCacheScope(USER_ID);
    kvMock.scopes.set(
      cacheScope,
      new Map([
        ['read-cache', { v: '{"blob":true}', updatedAt: 0 }],
        ['transcript:ses-1', { v: '{"page":true}', updatedAt: 0 }],
      ])
    );
    kvMock.scopes.set(
      deliveryScope(USER_ID),
      new Map([['pending-send:ses-1', { v: '{"items":[],"complete":false}', updatedAt: 0 }]])
    );

    for (let index = 0; index <= RESOLVED_DELIVERY_MAX_SESSIONS; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- retirement order depends on write order.
      await persistResolvedDeliveryFailure(OWNER, `ses-${index}`, 'msg-1');
    }

    expect(kvMock.scopes.get(cacheScope)?.has('read-cache')).toBe(true);
    expect(kvMock.scopes.get(cacheScope)?.has('transcript:ses-1')).toBe(true);
    expect(deliveryBucket()?.has('pending-send:ses-1')).toBe(true);
  });

  it('reports an incomplete record for unreadable stored values', async () => {
    const incomplete = { items: [], complete: false };
    const delivery = deliveryScope(USER_ID);

    // Invalid JSON.
    kvMock.scopes.set(delivery, new Map([[KEY, { v: 'not-json', updatedAt: 1 }]]));
    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual(incomplete);

    // Valid JSON, wrong shape: the old bare array and a broken envelope.
    kvMock.scopes.set(delivery, new Map([[KEY, { v: '["msg-1"]', updatedAt: 1 }]]));
    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual(incomplete);
    kvMock.scopes.set(
      delivery,
      new Map([[KEY, { v: '{"items":[1],"complete":false}', updatedAt: 1 }]])
    );
    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual(incomplete);

    // A storage read that throws.
    kvMock.scopes.set(
      delivery,
      new Map([[KEY, { v: '{"items":["msg-1"],"complete":true}', updatedAt: 1 }]])
    );
    kvMock.getItem.mockRejectedValueOnce(new Error('kv unavailable'));
    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual(incomplete);
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
    await expect(readResolvedDeliveryFailures('', SESSION_ID)).resolves.toEqual({
      items: [],
      complete: false,
    });
    await expect(readResolvedDeliveryFailures(USER_ID, '')).resolves.toEqual({
      items: [],
      complete: false,
    });
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

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual({
      items: ['msg-1', 'msg-2'],
      complete: true,
    });
  });

  it('refuses a write when sign-out starts during the awaited read', async () => {
    // Sign-out flips its flag and bumps the epoch while this call is still
    // awaiting its read. The write that follows must not repopulate a record
    // teardown just swept.
    kvMock.getItem.mockImplementationOnce(async () => {
      setSignOutActive(true);
      return null;
    });

    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');

    expect(kvMock.setItem).not.toHaveBeenCalled();
  });

  it('reports an incomplete record for a throwing read', async () => {
    kvMock.getItem.mockRejectedValueOnce(new Error('kv unavailable'));

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [],
      complete: false,
    });
  });

  it('keeps the record across sign-out and the same user signing in again', async () => {
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');

    // Sign-out clears `cache:<userId>:*`; the failure event it suppresses is
    // replayed after the next sign-in, so the record must outlive the sweep.
    clearReadCacheScopes(USER_ID);

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual({
      items: ['msg-1'],
      complete: true,
    });
  });

  it('keeps the record across a read-cache schema bump', async () => {
    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-1');

    kvMock.scopes.delete(readCacheScope(USER_ID));

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual({
      items: ['msg-1'],
      complete: true,
    });
  });

  it('migrates a legacy read-cache array on first read', async () => {
    kvMock.scopes.set(
      readCacheScope(USER_ID),
      new Map([[KEY, { v: JSON.stringify(['msg-legacy']), updatedAt: 1 }]])
    );

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual({
      items: ['msg-legacy'],
      complete: true,
    });
    expect(resolvedRecord(SESSION_ID)?.v).toBe('{"items":["msg-legacy"],"complete":true}');
    // The old copy is authoritative no longer: leaving it behind would be
    // adopted again the first time this record leaves nothing behind.
    expect(kvMock.scopes.get(readCacheScope(USER_ID))?.has(KEY)).toBe(false);
  });

  it('does not resurrect a retired id from the legacy array', async () => {
    kvMock.scopes.set(
      readCacheScope(USER_ID),
      new Map([[KEY, { v: JSON.stringify(['msg-legacy']), updatedAt: 1 }]])
    );

    // The first read adopts the legacy array.
    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual({
      items: ['msg-legacy'],
      complete: true,
    });

    // The delivery record goes away (an emptied complete record, or a build
    // that retires one). The next read must answer from the delivered scope,
    // not from the stale legacy copy.
    deliveryBucket()?.delete(KEY);

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [],
      complete: true,
    });
    expect(kvMock.scopes.get(readCacheScope(USER_ID))?.has(KEY)).toBe(false);
  });

  it('seeds from the legacy key when a write arrives before any read', async () => {
    kvMock.scopes.set(
      readCacheScope(USER_ID),
      new Map([[KEY, { v: JSON.stringify(['msg-legacy']), updatedAt: 1 }]])
    );

    await persistResolvedDeliveryFailure(OWNER, SESSION_ID, 'msg-new');

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual({
      items: ['msg-legacy', 'msg-new'],
      complete: true,
    });
    // The write adopted the legacy ids, so the old copy is gone and cannot
    // return them once the delivery record is retired.
    expect(kvMock.scopes.get(readCacheScope(USER_ID))?.has(KEY)).toBe(false);

    deliveryBucket()?.delete(KEY);
    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [],
      complete: true,
    });
  });

  it('returns the legacy ids even when the migration write fails', async () => {
    kvMock.scopes.set(
      readCacheScope(USER_ID),
      new Map([[KEY, { v: JSON.stringify(['msg-legacy']), updatedAt: 1 }]])
    );
    kvMock.setItem.mockRejectedValueOnce(new Error('kv unavailable'));

    await expect(readResolvedDeliveryFailures(USER_ID, SESSION_ID)).resolves.toEqual({
      items: ['msg-legacy'],
      complete: true,
    });
    expect(resolvedRecord(SESSION_ID)).toBeUndefined();
  });
});
