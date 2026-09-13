/* eslint-disable require-await, @typescript-eslint/require-await -- the in-memory KV fake settles without await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The transcript cache stores through the encrypted-kv module; the mock below
// is an in-memory per-scope store with the real map semantics, keeping the
// native SQLCipher chain out of this node suite.
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
import { type SessionSnapshotPage } from '@kilocode/cloud-agent-sdk';

import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { readCacheScope } from '@/lib/persist/read-cache';
import {
  clearSessionTranscriptPage,
  readSessionTranscriptPage,
  SESSION_TRANSCRIPT_MAX_BYTES,
  SESSION_TRANSCRIPT_MAX_ENTRIES,
  writeSessionTranscriptPage,
} from './session-transcript-cache';
/* eslint-enable import/first */

const USER_ID = 'u1';
const SESSION_ID = 'ses-1';
const AUTH_EPOCH = currentAuthEpoch();
const OWNER = { userId: USER_ID, authEpoch: AUTH_EPOCH };

function makePage(sessionId: string, messageId: string, text: string): SessionSnapshotPage {
  return {
    info: { id: sessionId },
    messages: [
      {
        info: { id: messageId, sessionID: sessionId, role: 'user' },
        parts: [
          {
            id: `part-${messageId}`,
            sessionID: sessionId,
            messageID: messageId,
            type: 'text',
            text,
          },
        ],
      },
    ],
    nextCursor: null,
    omittedItemCount: 0,
  } as unknown as SessionSnapshotPage;
}

beforeEach(() => {
  vi.clearAllMocks();
  kvMock.scopes.clear();
});

describe('session transcript cache', () => {
  it('round-trips a first page through the per-user read-cache scope', async () => {
    const page = makePage(SESSION_ID, 'msg-1', 'hello');

    await writeSessionTranscriptPage(OWNER, SESSION_ID, page);
    await expect(readSessionTranscriptPage(USER_ID, SESSION_ID)).resolves.toEqual(page);

    expect(kvMock.setItem).toHaveBeenCalledTimes(1);
    const [scope, key] = vi.mocked(kvMock.setItem).mock.calls[0] ?? [];
    expect(scope).toBe(readCacheScope(USER_ID));
    expect(scope).toBe('cache:u1:1');
    expect(key).toBe(`transcript:${SESSION_ID}`);
  });

  it('never leaks one account page to another account', async () => {
    await writeSessionTranscriptPage(OWNER, SESSION_ID, makePage(SESSION_ID, 'msg-1', 'hello'));

    await expect(readSessionTranscriptPage('u2', SESSION_ID)).resolves.toBeNull();
  });

  it('returns null for malformed JSON and for a wrong shape', async () => {
    const scope = readCacheScope(USER_ID);
    kvMock.scopes.set(
      scope,
      new Map([[`transcript:${SESSION_ID}`, { v: 'not-json', updatedAt: 1 }]])
    );

    await expect(readSessionTranscriptPage(USER_ID, SESSION_ID)).resolves.toBeNull();

    kvMock.scopes.set(
      scope,
      new Map([[`transcript:${SESSION_ID}`, { v: '{"nope":true}', updatedAt: 1 }]])
    );
    await expect(readSessionTranscriptPage(USER_ID, SESSION_ID)).resolves.toBeNull();
  });

  it('drops an oversized page instead of writing it', async () => {
    const scope = readCacheScope(USER_ID);
    kvMock.scopes.set(
      scope,
      new Map([[`transcript:${SESSION_ID}`, { v: 'previous', updatedAt: 1 }]])
    );

    const oversized = makePage(SESSION_ID, 'msg-big', 'x'.repeat(SESSION_TRANSCRIPT_MAX_BYTES));
    await writeSessionTranscriptPage(OWNER, SESSION_ID, oversized);

    expect(kvMock.setItem).not.toHaveBeenCalled();
    expect(kvMock.removeItem).toHaveBeenCalledWith(scope, `transcript:${SESSION_ID}`);
    expect(kvMock.scopes.get(scope)?.has(`transcript:${SESSION_ID}`)).toBe(false);
    await expect(readSessionTranscriptPage(USER_ID, SESSION_ID)).resolves.toBeNull();
  });

  it('clears one session page', async () => {
    await writeSessionTranscriptPage(OWNER, SESSION_ID, makePage(SESSION_ID, 'msg-1', 'hello'));

    await clearSessionTranscriptPage(USER_ID, SESSION_ID);

    await expect(readSessionTranscriptPage(USER_ID, SESSION_ID)).resolves.toBeNull();
    expect(kvMock.removeItem).toHaveBeenCalledWith(
      readCacheScope(USER_ID),
      `transcript:${SESSION_ID}`
    );
  });

  it('is a no-op for an empty owner or session id', async () => {
    await writeSessionTranscriptPage(
      { userId: '', authEpoch: AUTH_EPOCH },
      SESSION_ID,
      makePage(SESSION_ID, 'msg-1', 'hello')
    );

    expect(kvMock.setItem).not.toHaveBeenCalled();
    await expect(readSessionTranscriptPage('', SESSION_ID)).resolves.toBeNull();
    await expect(readSessionTranscriptPage(USER_ID, '')).resolves.toBeNull();
  });

  it('evicts the oldest sessions beyond the entry cap', async () => {
    const total = SESSION_TRANSCRIPT_MAX_ENTRIES + 2;
    for (let index = 0; index < total; index += 1) {
      const sessionId = `ses-${index}`;
      // Sequential writes keep `updated_at` strictly increasing so the evicted
      // entries are deterministic.
      // eslint-disable-next-line no-await-in-loop -- eviction order depends on write order.
      await writeSessionTranscriptPage(OWNER, sessionId, makePage(sessionId, `msg-${index}`, 'x'));
    }

    const scope = readCacheScope(USER_ID);
    const transcripts = [...(kvMock.scopes.get(scope)?.keys() ?? [])].filter(key =>
      key.startsWith('transcript:')
    );
    expect(transcripts).toHaveLength(SESSION_TRANSCRIPT_MAX_ENTRIES);
    expect(transcripts).not.toContain('transcript:ses-0');
    expect(transcripts).not.toContain('transcript:ses-1');
    expect(transcripts).toContain(`transcript:ses-${total - 1}`);
  });

  it('does not evict the read-cache blob that shares the scope', async () => {
    const scope = readCacheScope(USER_ID);
    kvMock.scopes.set(scope, new Map([['read-cache', { v: '{"blob":true}', updatedAt: 0 }]]));

    for (let index = 0; index < SESSION_TRANSCRIPT_MAX_ENTRIES + 1; index += 1) {
      const sessionId = `ses-${index}`;
      // eslint-disable-next-line no-await-in-loop -- eviction order depends on write order.
      await writeSessionTranscriptPage(OWNER, sessionId, makePage(sessionId, `msg-${index}`, 'x'));
    }

    expect(kvMock.scopes.get(scope)?.has('read-cache')).toBe(true);
  });

  it('refuses to write while a sign-out is active', async () => {
    setSignOutActive(true);
    try {
      await writeSessionTranscriptPage(OWNER, SESSION_ID, makePage(SESSION_ID, 'msg-1', 'hello'));
      expect(kvMock.setItem).not.toHaveBeenCalled();
      await expect(readSessionTranscriptPage(USER_ID, SESSION_ID)).resolves.toBeNull();
    } finally {
      setSignOutActive(false);
    }
  });

  it('refuses a write whose captured auth epoch has moved', async () => {
    await writeSessionTranscriptPage(
      { userId: USER_ID, authEpoch: AUTH_EPOCH - 1 },
      SESSION_ID,
      makePage(SESSION_ID, 'msg-1', 'hello')
    );

    expect(kvMock.setItem).not.toHaveBeenCalled();
    await expect(readSessionTranscriptPage(USER_ID, SESSION_ID)).resolves.toBeNull();
  });
});
