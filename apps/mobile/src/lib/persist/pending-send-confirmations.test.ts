/* eslint-disable max-lines -- one suite owns the pending-send record: its caps, its legacy migration, and its life across sign-out and a schema bump */
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
    listEntryValues: vi.fn(async (scope: string) =>
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
  listEntryValues: kvMock.listEntryValues,
}));

// `readCacheScope` is imported from cache-scope (via read-cache's re-export
// graph, which loads expo-secure-store in some entry points).
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
  clearPendingSendConfirmation,
  PENDING_SEND_MAX_IDS,
  PENDING_SEND_MAX_SESSIONS,
  pendingSendMessageIdForText,
  persistPendingSendConfirmation,
  readPendingSendConfirmations,
} from './pending-send-confirmations';
/* eslint-enable import/first */

const USER_ID = 'u1';
const SESSION_ID = 'ses-1';
const OWNER = { userId: USER_ID, authEpoch: currentAuthEpoch() };
const KEY = `pending-send:${SESSION_ID}`;
const TOMBSTONE_JSON = '{"items":[],"complete":false}';

function deliveryBucket(): Map<string, { v: string; updatedAt: number }> | undefined {
  return kvMock.scopes.get(deliveryScope(USER_ID));
}

function pendingRecord(sessionId: string): { v: string; updatedAt: number } | undefined {
  return deliveryBucket()?.get(`pending-send:${sessionId}`);
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

async function persist(sessionId: string, messageId: string, text = 'hello'): Promise<void> {
  await persistPendingSendConfirmation({ owner: OWNER, sessionId, messageId, text });
}

describe('pending send confirmations', () => {
  beforeEach(() => {
    kvMock.scopes.clear();
    kvMock.getItem.mockClear();
    kvMock.setItem.mockClear();
    kvMock.removeItem.mockClear();
    setSignOutActive(false);
  });

  it('reads a complete, empty record for a session with no pending send', async () => {
    // Nothing is stored for this session in either scope: the ordinary state of
    // a session whose sends all went through. It must not read as cut short.
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [],
      complete: true,
    });
  });

  it('round-trips a pending send in the delivery scope', async () => {
    await persist(SESSION_ID, 'msg-1');

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [{ messageId: 'msg-1', text: 'hello' }],
      complete: true,
    });
    const [scope, key] = vi.mocked(kvMock.setItem).mock.calls[0] ?? [];
    expect(scope).toBe(deliveryScope(USER_ID));
    expect(key).toBe(KEY);
    expect(pendingRecord(SESSION_ID)?.v).toBe(
      '{"items":[{"messageId":"msg-1","text":"hello"}],"complete":true}'
    );
  });

  it('retires an entry once the confirmation arrived', async () => {
    await persist(SESSION_ID, 'msg-1', 'hello');
    await persist(SESSION_ID, 'msg-2', 'world');

    await clearPendingSendConfirmation({ owner: OWNER, sessionId: SESSION_ID, messageId: 'msg-1' });

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [{ messageId: 'msg-2', text: 'world' }],
      complete: true,
    });
  });

  it('removes the entry entirely when the last pending send settles', async () => {
    await persist(SESSION_ID, 'msg-1');
    await clearPendingSendConfirmation({ owner: OWNER, sessionId: SESSION_ID, messageId: 'msg-1' });

    // The emptied record is complete, so it is retired; the session then reads
    // as the complete, empty record it is.
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [],
      complete: true,
    });
    expect(deliveryBucket()?.has(KEY)).toBe(false);
  });

  it('keeps one entry per id and bounds the list', async () => {
    await persist(SESSION_ID, 'msg-1');
    await persist(SESSION_ID, 'msg-1');
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [{ messageId: 'msg-1', text: 'hello' }],
      complete: true,
    });

    for (let index = 0; index < PENDING_SEND_MAX_IDS + 3; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- cap order depends on write order.
      await persist(SESSION_ID, `msg-late-${index}`, `late ${index}`);
    }

    const record = await readPendingSendConfirmations(USER_ID, SESSION_ID);
    expect(record.items).toHaveLength(PENDING_SEND_MAX_IDS);
    expect(record.items.map(entry => entry.messageId)).not.toContain('msg-1');
  });

  it('keeps the other entries readable when a send carried only attachments', async () => {
    await persist(SESSION_ID, 'msg-text', 'hello');
    // An attachment-only send carries no text; it is not recorded, and it must
    // not make the stored list unreadable either.
    await persist(SESSION_ID, 'msg-files', '');

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [{ messageId: 'msg-text', text: 'hello' }],
      complete: true,
    });
  });

  it('reads a stored record whose entry carries empty text', async () => {
    kvMock.scopes.set(
      deliveryScope(USER_ID),
      new Map([
        [
          KEY,
          {
            v: JSON.stringify({ items: [{ messageId: 'msg-files', text: '' }], complete: true }),
            updatedAt: 1,
          },
        ],
      ])
    );

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [{ messageId: 'msg-files', text: '' }],
      complete: true,
    });
  });

  it('never leaks one account pending send to another account', async () => {
    await persist(SESSION_ID, 'msg-1');

    await expect(readPendingSendConfirmations('u2', SESSION_ID)).resolves.toEqual({
      items: [],
      complete: true,
    });
  });

  it('refuses writes after sign-out starts', async () => {
    setSignOutActive(true);

    await persist(SESSION_ID, 'msg-1');

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [],
      complete: true,
    });
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

  it('reports an incomplete record for unreadable stored values', async () => {
    const incomplete = { items: [], complete: false };

    // Invalid JSON.
    kvMock.scopes.set(deliveryScope(USER_ID), new Map([[KEY, { v: 'not-json', updatedAt: 1 }]]));
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual(incomplete);

    // Valid JSON, wrong shape: the old bare array and a broken envelope.
    kvMock.scopes.set(
      deliveryScope(USER_ID),
      new Map([[KEY, { v: '[{"messageId":"m","text":"t"}]', updatedAt: 1 }]])
    );
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual(incomplete);
    kvMock.scopes.set(
      deliveryScope(USER_ID),
      new Map([[KEY, { v: '{"items":"nope","complete":true}', updatedAt: 1 }]])
    );
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual(incomplete);

    // A storage read that throws.
    kvMock.scopes.set(
      deliveryScope(USER_ID),
      new Map([[KEY, { v: '{"items":[],"complete":true}', updatedAt: 1 }]])
    );
    kvMock.getItem.mockRejectedValueOnce(new Error('kv unavailable'));
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual(incomplete);
  });

  it('answers an empty owner id or session id with a complete, empty record', async () => {
    // No account can hold a record for an empty id, so this is not a read
    // failure: the caller must still trust the answer. A real record for the
    // owner makes the empty answer mean something and no store read waived.
    kvMock.scopes.set(
      deliveryScope(USER_ID),
      new Map([
        [
          KEY,
          {
            v: '{"items":[{"messageId":"msg-1","text":"hello"}],"complete":true}',
            updatedAt: 1,
          },
        ],
      ])
    );
    const empty = { items: [], complete: true };

    await expect(readPendingSendConfirmations('', SESSION_ID)).resolves.toEqual(empty);
    expect(kvMock.getItem).not.toHaveBeenCalled();
    await expect(readPendingSendConfirmations(USER_ID, '')).resolves.toEqual(empty);
    await expect(readPendingSendConfirmations('', '')).resolves.toEqual(empty);
    // A guard that kept only one half would consult the store on these reads.
    expect(kvMock.getItem).not.toHaveBeenCalled();
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [{ messageId: 'msg-1', text: 'hello' }],
      complete: true,
    });
  });

  it('keeps a warm-start record across sign-out and the same user signing in again', async () => {
    await persist(SESSION_ID, 'msg-1');
    expect(kvMock.scopes.has(readCacheScope(USER_ID))).toBe(false);

    // Sign-out clears `cache:<userId>:*`; the composer draft survives, so the
    // hint that withdraws its duplicate must survive with it.
    clearReadCacheScopes(USER_ID);

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [{ messageId: 'msg-1', text: 'hello' }],
      complete: true,
    });
  });

  it('keeps the record across a read-cache schema bump', async () => {
    await persist(SESSION_ID, 'msg-1');

    // A bump retires the current read-cache scope; the record is not in it.
    kvMock.scopes.delete(readCacheScope(USER_ID));

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [{ messageId: 'msg-1', text: 'hello' }],
      complete: true,
    });
  });

  it('marks a session incomplete once its ids outgrow the per-session cap', async () => {
    const total = PENDING_SEND_MAX_IDS + 5;
    for (let index = 0; index < total; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- cap order depends on write order.
      await persist(SESSION_ID, `msg-${index}`, `text ${index}`);
    }

    const record = await readPendingSendConfirmations(USER_ID, SESSION_ID);
    expect(record.complete).toBe(false);
    expect(record.items).toHaveLength(PENDING_SEND_MAX_IDS);
    expect(record.items.map(entry => entry.messageId)).toEqual(
      Array.from(
        { length: PENDING_SEND_MAX_IDS },
        (_, index) => `msg-${total - PENDING_SEND_MAX_IDS + index}`
      )
    );
  });

  it('retires the oldest session into a tombstone once the session cap is passed', async () => {
    const total = PENDING_SEND_MAX_SESSIONS + 1;
    for (let index = 0; index < total; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- retirement order depends on write order.
      await persist(`ses-${index}`, 'msg-1', `text ${index}`);
    }

    // The oldest session is retired, not deleted: its key is still there and
    // reads back incomplete, which a miss can never be told apart from.
    expect(pendingRecord('ses-0')?.v).toBe(TOMBSTONE_JSON);
    await expect(readPendingSendConfirmations(USER_ID, 'ses-0')).resolves.toEqual({
      items: [],
      complete: false,
    });
    await expect(readPendingSendConfirmations(USER_ID, `ses-${total - 1}`)).resolves.toEqual({
      items: [{ messageId: 'msg-1', text: `text ${total - 1}` }],
      complete: true,
    });

    const family = [...(deliveryBucket()?.keys() ?? [])].filter(key =>
      key.startsWith('pending-send:')
    );
    expect(family).toHaveLength(PENDING_SEND_MAX_SESSIONS + 1);
  });

  it('migrates a legacy read-cache array on first read', async () => {
    kvMock.scopes.set(
      readCacheScope(USER_ID),
      new Map([
        [KEY, { v: JSON.stringify([{ messageId: 'msg-legacy', text: 'old' }]), updatedAt: 1 }],
      ])
    );

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [{ messageId: 'msg-legacy', text: 'old' }],
      complete: true,
    });
    expect(pendingRecord(SESSION_ID)?.v).toBe(
      '{"items":[{"messageId":"msg-legacy","text":"old"}],"complete":true}'
    );
    // The old copy is authoritative no longer: leaving it behind would be
    // adopted again the next time this record empties.
    expect(kvMock.scopes.get(readCacheScope(USER_ID))?.has(KEY)).toBe(false);
  });

  it('does not resurrect a retired id from the legacy array', async () => {
    kvMock.scopes.set(
      readCacheScope(USER_ID),
      new Map([
        [KEY, { v: JSON.stringify([{ messageId: 'msg-legacy', text: 'old' }]), updatedAt: 1 }],
      ])
    );

    // The first read adopts the legacy array.
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [{ messageId: 'msg-legacy', text: 'old' }],
      complete: true,
    });

    // The confirmation arrives; the record empties and its key is removed.
    await clearPendingSendConfirmation({
      owner: OWNER,
      sessionId: SESSION_ID,
      messageId: 'msg-legacy',
    });
    expect(deliveryBucket()?.has(KEY)).toBe(false);

    // The next read must not re-adopt the retired id.
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [],
      complete: true,
    });
    expect(kvMock.scopes.get(readCacheScope(USER_ID))?.has(KEY)).toBe(false);
  });

  it('seeds from the legacy key when a write arrives before any read', async () => {
    kvMock.scopes.set(
      readCacheScope(USER_ID),
      new Map([
        [KEY, { v: JSON.stringify([{ messageId: 'msg-legacy', text: 'old' }]), updatedAt: 1 }],
      ])
    );

    await persist(SESSION_ID, 'msg-new', 'new');

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [
        { messageId: 'msg-legacy', text: 'old' },
        { messageId: 'msg-new', text: 'new' },
      ],
      complete: true,
    });
    // The write adopted the legacy ids, so the old copy is gone and cannot
    // return them after this record empties.
    expect(kvMock.scopes.get(readCacheScope(USER_ID))?.has(KEY)).toBe(false);

    await clearPendingSendConfirmation({
      owner: OWNER,
      sessionId: SESSION_ID,
      messageId: 'msg-legacy',
    });
    await clearPendingSendConfirmation({
      owner: OWNER,
      sessionId: SESSION_ID,
      messageId: 'msg-new',
    });
    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [],
      complete: true,
    });
  });

  it('returns the legacy items even when the migration write fails', async () => {
    kvMock.scopes.set(
      readCacheScope(USER_ID),
      new Map([
        [KEY, { v: JSON.stringify([{ messageId: 'msg-legacy', text: 'old' }]), updatedAt: 1 }],
      ])
    );
    kvMock.setItem.mockRejectedValueOnce(new Error('kv unavailable'));

    await expect(readPendingSendConfirmations(USER_ID, SESSION_ID)).resolves.toEqual({
      items: [{ messageId: 'msg-legacy', text: 'old' }],
      complete: true,
    });
    expect(pendingRecord(SESSION_ID)).toBeUndefined();
  });
});

describe('pendingSendMessageIdForText', () => {
  const record = (
    items: readonly { messageId: string; text: string }[],
    complete = true
  ): { items: readonly { messageId: string; text: string }[]; complete: boolean } => ({
    items,
    complete,
  });

  it('names the newest recorded send with that prompt', () => {
    expect(
      pendingSendMessageIdForText(
        record([
          { messageId: 'msg-old', text: 'Delivered late' },
          { messageId: 'msg-new', text: 'Delivered late' },
        ]),
        'Delivered late'
      )
    ).toBe('msg-new');
  });

  it('compares the prompt a send carries, so surrounding whitespace matches', () => {
    expect(
      pendingSendMessageIdForText(record([{ messageId: 'msg-1', text: 'hello' }]), '  hello\n')
    ).toBe('msg-1');
  });

  it('answers null for text no recorded send matches', () => {
    expect(
      pendingSendMessageIdForText(record([{ messageId: 'msg-1', text: 'hello' }]), 'another')
    ).toBeNull();
    expect(pendingSendMessageIdForText(record([]), 'hello')).toBeNull();
  });

  it('never attributes from an incomplete record', () => {
    // A cut record may have lost the entry, so its silence is not evidence.
    expect(
      pendingSendMessageIdForText(record([{ messageId: 'msg-1', text: 'hello' }], false), 'hello')
    ).toBeNull();
  });

  it('answers null for an empty or invisible draft', () => {
    // An attachment-only entry carries no text, so it can never name a draft.
    expect(pendingSendMessageIdForText(record([{ messageId: 'msg-1', text: '' }]), '')).toBeNull();
    expect(
      pendingSendMessageIdForText(record([{ messageId: 'msg-1', text: '' }]), ' \u200B ')
    ).toBeNull();
  });
});
