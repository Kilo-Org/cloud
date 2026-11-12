/* eslint-disable require-await, @typescript-eslint/require-await -- the in-memory KV fake settles without await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The pending-send memory stores through the encrypted-kv module; the mock
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
  clearPendingSendConfirmation,
  PENDING_SEND_MAX_IDS,
  persistPendingSendConfirmation,
  readPendingSendConfirmations,
} from './pending-send-confirmations';
/* eslint-enable import/first */

const USER_ID = 'u1';
const SESSION_ID = 'ses-1';
const OWNER = { userId: USER_ID, authEpoch: currentAuthEpoch() };
const KEY = `pending-send:${SESSION_ID}`;

describe('pending send confirmations', () => {
  beforeEach(() => {
    kvMock.scopes.clear();
    kvMock.getItem.mockClear();
    kvMock.setItem.mockClear();
    kvMock.removeItem.mockClear();
    setSignOutActive(false);
  });

  it('reads an empty list for a session with no pending send', async () => {
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual([]);
  });

  it('round-trips a pending send in the read-cache scope', async () => {
    await persistPendingSendConfirmation({
      owner: OWNER,
      sessionId: SESSION_ID,
      messageId: 'msg-1',
      text: 'hello',
    });

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual([
      { messageId: 'msg-1', text: 'hello' },
    ]);
    const [scope, key] = vi.mocked(kvMock.setItem).mock.calls[0] ?? [];
    expect(scope).toBe(readCacheScope(USER_ID));
    expect(key).toBe(KEY);
  });

  it('retires an entry once the confirmation arrived', async () => {
    await persistPendingSendConfirmation({
      owner: OWNER,
      sessionId: SESSION_ID,
      messageId: 'msg-1',
      text: 'hello',
    });
    await persistPendingSendConfirmation({
      owner: OWNER,
      sessionId: SESSION_ID,
      messageId: 'msg-2',
      text: 'world',
    });

    await clearPendingSendConfirmation({ owner: OWNER, sessionId: SESSION_ID, messageId: 'msg-1' });

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual([
      { messageId: 'msg-2', text: 'world' },
    ]);
  });

  it('removes the entry entirely when the last pending send settles', async () => {
    await persistPendingSendConfirmation({
      owner: OWNER,
      sessionId: SESSION_ID,
      messageId: 'msg-1',
      text: 'hello',
    });
    await clearPendingSendConfirmation({ owner: OWNER, sessionId: SESSION_ID, messageId: 'msg-1' });

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual([]);
    expect(kvMock.scopes.get(readCacheScope(USER_ID))?.has(KEY)).toBe(false);
  });

  it('keeps one entry per id and bounds the list', async () => {
    await persistPendingSendConfirmation({
      owner: OWNER,
      sessionId: SESSION_ID,
      messageId: 'msg-1',
      text: 'hello',
    });
    await persistPendingSendConfirmation({
      owner: OWNER,
      sessionId: SESSION_ID,
      messageId: 'msg-1',
      text: 'hello',
    });
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual([
      { messageId: 'msg-1', text: 'hello' },
    ]);

    for (let index = 0; index < PENDING_SEND_MAX_IDS + 3; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- cap order depends on write order.
      await persistPendingSendConfirmation({
        owner: OWNER,
        sessionId: SESSION_ID,
        messageId: `msg-late-${index}`,
        text: `late ${index}`,
      });
    }

    const ids = await readPendingSendConfirmations(USER_ID, SESSION_ID);
    expect(ids).toHaveLength(PENDING_SEND_MAX_IDS);
    expect(ids.map(entry => entry.messageId)).not.toContain('msg-1');
  });

  it('never leaks one account pending send to another account', async () => {
    await persistPendingSendConfirmation({
      owner: OWNER,
      sessionId: SESSION_ID,
      messageId: 'msg-1',
      text: 'hello',
    });

    await expect(readPendingSendConfirmations('u2', SESSION_ID)).resolves.toEqual([]);
  });

  it('refuses writes after sign-out starts', async () => {
    setSignOutActive(true);

    await persistPendingSendConfirmation({
      owner: OWNER,
      sessionId: SESSION_ID,
      messageId: 'msg-1',
      text: 'hello',
    });

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual([]);
    expect(kvMock.setItem).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty owner, session id, or message id', async () => {
    await persistPendingSendConfirmation({
      owner: { userId: '', authEpoch: OWNER.authEpoch },
      sessionId: SESSION_ID,
      messageId: 'm',
      text: 'hello',
    });
    await persistPendingSendConfirmation({
      owner: OWNER,
      sessionId: '',
      messageId: 'm',
      text: 'hello',
    });
    await persistPendingSendConfirmation({
      owner: OWNER,
      sessionId: SESSION_ID,
      messageId: '',
      text: 'hello',
    });

    expect(kvMock.setItem).not.toHaveBeenCalled();
  });

  it('treats a corrupt entry as a miss', async () => {
    const scope = readCacheScope(USER_ID);
    kvMock.scopes.set(scope, new Map([[KEY, { v: 'not-json', updatedAt: 1 }]]));
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual([]);
  });
});
