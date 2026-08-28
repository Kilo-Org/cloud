/* eslint-disable max-lines -- cohesive suite for debounce, fence, flush, size, eviction, and corrupt-read contracts */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake KV factories settle without await because they resolve immediately */
import * as Sentry from '@sentry/react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The drafts module imports the native encrypted-kv chain; the fake below is
// an in-memory Map-backed KV that mirrors the real upsert/list semantics so
// eviction and scope behavior behave like the SQLCipher store.
const kvStore = new Map<string, { scope: string; k: string; v: string; updatedAt: number }>();
let nextUpdatedAt = 1;

const kvMock = vi.hoisted(() => ({
  getItem: vi.fn(async (_scope: string, _k: string): Promise<string | null> => null),
  setItem: vi.fn(async (_scope: string, _k: string, _v: string): Promise<void> => undefined),
  removeItem: vi.fn(async (_scope: string, _k: string): Promise<void> => undefined),
  listEntries: vi.fn(async (_scope: string): Promise<{ k: string; updatedAt: number }[]> => []),
}));

vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: kvMock.getItem,
  listEntries: kvMock.listEntries,
  // eslint-disable-next-line max-params -- mirror the guarded native KV write API
  setItem: async (scope: string, key: string, value: string, guard?: () => boolean) => {
    if (!guard || guard()) {
      await kvMock.setItem(scope, key, value);
    }
  },
  removeItem: async (scope: string, key: string, guard?: () => boolean) => {
    if (!guard || guard()) {
      await kvMock.removeItem(scope, key);
    }
  },
}));

vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
}));

/* eslint-disable import/first */
import {
  agentComposerDraftKey,
  clearDraft,
  DRAFT_DEBOUNCE_MS,
  DRAFT_MAX_BYTES,
  DRAFT_MAX_ENTRIES,
  draftScope,
  flushDraft,
  isMergeDraft,
  isStringDraft,
  loadDraft,
  NEW_SESSION_DRAFT_KEY,
  prCommentDraftKey,
  prMergeDraftKey,
  prReplyDraftKey,
  prReviewDraftKey,
  resetDraftTimersForTests,
  resolvePrefillOverDraft,
  saveDraft,
  securityDismissDraftKey,
} from './drafts';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { inFlightSaveCount } from '@/lib/hooks/save-chain';
/* eslint-enable import/first */

// Local structural guard for the pending-review draft shape (the real guard
// lives in the pr-review provider; this test keeps drafts self-contained).
type ReviewDraftItem = {
  id: string;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  body: string;
  commitSha: string;
};

function isReviewDraft(value: unknown): value is ReviewDraftItem[] {
  return (
    Array.isArray(value) &&
    value.every(item => {
      if (item === null || typeof item !== 'object') {
        return false;
      }
      const record = item as Record<string, unknown>;
      return (
        typeof record.id === 'string' &&
        typeof record.path === 'string' &&
        (record.side === 'LEFT' || record.side === 'RIGHT') &&
        typeof record.line === 'number' &&
        typeof record.body === 'string' &&
        typeof record.commitSha === 'string'
      );
    })
  );
}

function storageKey(scope: string, k: string): string {
  return JSON.stringify([scope, k]);
}

function seedStoredValue(scope: string, k: string, v: string): void {
  kvStore.set(storageKey(scope, k), { scope, k, v, updatedAt: nextUpdatedAt });
  nextUpdatedAt += 1;
}

beforeEach(() => {
  vi.clearAllMocks();
  kvStore.clear();
  nextUpdatedAt = 1;
  resetDraftTimersForTests();
  kvMock.getItem.mockImplementation(
    async (scope, k) => kvStore.get(storageKey(scope, k))?.v ?? null
  );
  kvMock.setItem.mockImplementation(async (scope, k, v) => {
    kvStore.set(storageKey(scope, k), { scope, k, v, updatedAt: nextUpdatedAt });
    nextUpdatedAt += 1;
  });
  kvMock.removeItem.mockImplementation(async (scope, k) => {
    kvStore.delete(storageKey(scope, k));
  });
  kvMock.listEntries.mockImplementation(async scope =>
    [...kvStore.values()]
      .filter(entry => entry.scope === scope)
      .toSorted((a, b) => a.updatedAt - b.updatedAt)
      .map(entry => ({ k: entry.k, updatedAt: entry.updatedAt }))
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('draft scope and entity keys', () => {
  it('builds the account-scoped storage key and entity keys', () => {
    expect(draftScope('u1')).toBe('draft:u1');
    expect(agentComposerDraftKey('sess-1')).toBe('agent-composer:sess-1');
    expect(NEW_SESSION_DRAFT_KEY).toBe('agent-composer:new');
    expect(prReviewDraftKey('acme', 'kilo', 42)).toBe('pr-review:acme/kilo#42');
    expect(securityDismissDraftKey('personal', 'finding-1')).toBe(
      'security-dismiss:personal:finding-1'
    );
  });

  it('builds the merge, reply, and comment draft entity keys', () => {
    expect(prMergeDraftKey('acme', 'kilo', 42)).toBe('pr-merge:acme/kilo#42');
    expect(prReplyDraftKey('acme', 'kilo', 42, 7)).toBe('pr-reply:acme/kilo#42:7');
    expect(prCommentDraftKey('acme', 'kilo', 42, 'src/a.ts', 'RIGHT', 10)).toBe(
      'pr-comment:acme/kilo#42:src/a.ts:RIGHT:10-10'
    );
    expect(prCommentDraftKey('acme', 'kilo', 42, 'src/a.ts', 'RIGHT', 10, 8)).toBe(
      'pr-comment:acme/kilo#42:src/a.ts:RIGHT:8-10'
    );
  });

  it('isMergeDraft accepts a title+message object and rejects other shapes', () => {
    expect(isMergeDraft({ title: 'T', message: 'M' })).toBe(true);
    expect(isMergeDraft({ title: '', message: '' })).toBe(true);
    expect(isMergeDraft({ title: 'T' })).toBe(false);
    expect(isMergeDraft({ message: 'M' })).toBe(false);
    expect(isMergeDraft({ title: 1, message: 'M' })).toBe(false);
    expect(isMergeDraft({ title: 'T', message: 2 })).toBe(false);
    expect(isMergeDraft('not an object')).toBe(false);
    expect(isMergeDraft(null)).toBe(false);
    expect(isMergeDraft(['T', 'M'])).toBe(false);
  });

  it('resolvePrefillOverDraft lets a non-empty prefill beat the stored draft', () => {
    expect(resolvePrefillOverDraft('shared text', 'draft text')).toBe('shared text');
    expect(resolvePrefillOverDraft(undefined, 'draft text')).toBe('draft text');
    expect(resolvePrefillOverDraft(null, 'draft text')).toBe('draft text');
    expect(resolvePrefillOverDraft('  ', 'draft text')).toBe('draft text');
    expect(resolvePrefillOverDraft(null, null)).toBeUndefined();
    expect(resolvePrefillOverDraft('', '')).toBe('');
  });
});

describe('round trip and absent load', () => {
  it('round-trips a text draft through the encrypted kv', async () => {
    saveDraft('u1', agentComposerDraftKey('sess-1'), 'hello');
    await flushDraft('u1', agentComposerDraftKey('sess-1'));
    await expect(loadDraft('u1', agentComposerDraftKey('sess-1'), isStringDraft)).resolves.toBe(
      'hello'
    );
  });

  it('round-trips a JSON array draft (pending review shape)', async () => {
    const items = [
      { id: 'c1', path: 'a.ts', side: 'RIGHT' as const, line: 3, body: 'x', commitSha: 's' },
    ];
    saveDraft('u1', prReviewDraftKey('acme', 'kilo', 42), items);
    await flushDraft('u1', prReviewDraftKey('acme', 'kilo', 42));
    await expect(
      loadDraft('u1', prReviewDraftKey('acme', 'kilo', 42), isReviewDraft)
    ).resolves.toEqual(items);
  });

  it('loads null for an absent key without reporting Sentry', async () => {
    await expect(loadDraft('u1', 'missing', isStringDraft)).resolves.toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('keeps scopes separate per user', async () => {
    saveDraft('u1', 'k', 'a');
    saveDraft('u2', 'k', 'b');
    await Promise.all([flushDraft('u1', 'k'), flushDraft('u2', 'k')]);
    await expect(loadDraft('u1', 'k', isStringDraft)).resolves.toBe('a');
    await expect(loadDraft('u2', 'k', isStringDraft)).resolves.toBe('b');
  });

  it('no-ops every API when the userId is unknown', async () => {
    saveDraft('', 'k', 'v');
    await flushDraft('', 'k');
    await clearDraft('', 'k');
    await expect(loadDraft('', 'k', isStringDraft)).resolves.toBeNull();
    expect(kvMock.setItem).not.toHaveBeenCalled();
    expect(kvMock.removeItem).not.toHaveBeenCalled();
  });
});

describe('merge, reply, and comment keys restore per account and destination', () => {
  it('saves and restores a merge draft under the same account and PR', async () => {
    const key = prMergeDraftKey('acme', 'kilo', 42);
    saveDraft('u1', key, { title: 'T', message: 'M' });
    await flushDraft('u1', key);
    await expect(loadDraft('u1', key, isMergeDraft)).resolves.toEqual({ title: 'T', message: 'M' });
  });

  it('does not restore a merge draft under a different account or PR', async () => {
    const key = prMergeDraftKey('acme', 'kilo', 42);
    saveDraft('u1', key, { title: 'T', message: 'M' });
    await flushDraft('u1', key);
    await expect(loadDraft('u2', key, isMergeDraft)).resolves.toBeNull();
    await expect(
      loadDraft('u1', prMergeDraftKey('acme', 'kilo', 43), isMergeDraft)
    ).resolves.toBeNull();
  });

  it('saves and restores a reply draft under the same account and thread', async () => {
    const key = prReplyDraftKey('acme', 'kilo', 42, 7);
    saveDraft('u1', key, 'a reply');
    await flushDraft('u1', key);
    await expect(loadDraft('u1', key, isStringDraft)).resolves.toBe('a reply');
  });

  it('does not restore a reply draft under a different account or comment', async () => {
    const key = prReplyDraftKey('acme', 'kilo', 42, 7);
    saveDraft('u1', key, 'a reply');
    await flushDraft('u1', key);
    await expect(loadDraft('u2', key, isStringDraft)).resolves.toBeNull();
    await expect(
      loadDraft('u1', prReplyDraftKey('acme', 'kilo', 42, 8), isStringDraft)
    ).resolves.toBeNull();
  });

  it('saves and restores a comment draft under the same account and diff position', async () => {
    const key = prCommentDraftKey('acme', 'kilo', 42, 'src/a.ts', 'RIGHT', 10);
    saveDraft('u1', key, 'a comment');
    await flushDraft('u1', key);
    await expect(loadDraft('u1', key, isStringDraft)).resolves.toBe('a comment');
  });

  it('does not restore a comment draft under a different account or line', async () => {
    const key = prCommentDraftKey('acme', 'kilo', 42, 'src/a.ts', 'RIGHT', 10);
    saveDraft('u1', key, 'a comment');
    await flushDraft('u1', key);
    await expect(loadDraft('u2', key, isStringDraft)).resolves.toBeNull();
    await expect(
      loadDraft('u1', prCommentDraftKey('acme', 'kilo', 42, 'src/a.ts', 'RIGHT', 11), isStringDraft)
    ).resolves.toBeNull();
  });

  it('clear removes the merge, reply, and comment entries', async () => {
    const mergeKey = prMergeDraftKey('acme', 'kilo', 42);
    const replyKey = prReplyDraftKey('acme', 'kilo', 42, 7);
    const commentKey = prCommentDraftKey('acme', 'kilo', 42, 'src/a.ts', 'RIGHT', 10);
    saveDraft('u1', mergeKey, { title: 'T', message: 'M' });
    saveDraft('u1', replyKey, 'a reply');
    saveDraft('u1', commentKey, 'a comment');
    await Promise.all([
      flushDraft('u1', mergeKey),
      flushDraft('u1', replyKey),
      flushDraft('u1', commentKey),
    ]);
    await clearDraft('u1', mergeKey);
    await clearDraft('u1', replyKey);
    await clearDraft('u1', commentKey);
    await expect(loadDraft('u1', mergeKey, isMergeDraft)).resolves.toBeNull();
    await expect(loadDraft('u1', replyKey, isStringDraft)).resolves.toBeNull();
    await expect(loadDraft('u1', commentKey, isStringDraft)).resolves.toBeNull();
  });
});

describe('debounce', () => {
  it('collapses rapid saves into one write 500 ms after the last one', async () => {
    vi.useFakeTimers();
    saveDraft('u1', 'k', 'first');
    vi.advanceTimersByTime(300);
    saveDraft('u1', 'k', 'second');
    vi.advanceTimersByTime(200);
    expect(kvMock.setItem).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(kvMock.setItem).toHaveBeenCalledTimes(1);
    expect(kvMock.setItem).toHaveBeenCalledWith('draft:u1', 'k', '"second"');
  });

  it('debounces per full storage key so a key switch never retargets an older timer', async () => {
    vi.useFakeTimers();
    saveDraft('u1', 'A', 'va');
    saveDraft('u1', 'B', 'vb');
    // Flushing only A writes A's value under A's key; B stays pending.
    await flushDraft('u1', 'A');
    expect(kvMock.setItem).toHaveBeenCalledWith('draft:u1', 'A', '"va"');
    expect(kvMock.setItem).not.toHaveBeenCalledWith('draft:u1', 'B', expect.anything());
    await flushDraft('u1', 'B');
    expect(kvMock.setItem).toHaveBeenCalledWith('draft:u1', 'B', '"vb"');
  });

  it('keeps the same entity key pending writes scoped to their own user', async () => {
    saveDraft('u1', 'k', 'a');
    saveDraft('u2', 'k', 'b');
    await flushDraft('u1', 'k');
    expect(kvMock.setItem).toHaveBeenCalledWith('draft:u1', 'k', '"a"');
    expect(kvMock.setItem).not.toHaveBeenCalledWith('draft:u2', 'k', expect.anything());
  });

  it('flushDraft forces the pending write immediately and leaves no timer', async () => {
    vi.useFakeTimers();
    saveDraft('u1', 'k', 'forced');
    await flushDraft('u1', 'k');
    expect(kvMock.setItem).toHaveBeenCalledWith('draft:u1', 'k', '"forced"');
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 2);
    expect(kvMock.setItem).toHaveBeenCalledTimes(1);
  });
});

describe('epoch fence', () => {
  it('skips a debounced write scheduled before an epoch bump', async () => {
    saveDraft('u1', 'k', 'stale');
    bumpAuthEpoch();
    await flushDraft('u1', 'k');
    expect(kvMock.setItem).not.toHaveBeenCalled();
    await expect(loadDraft('u1', 'k', isStringDraft)).resolves.toBeNull();
  });

  it('skips a debounced write whose timer fires after an epoch bump', async () => {
    vi.useFakeTimers();
    saveDraft('u1', 'k', 'stale');
    bumpAuthEpoch();
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(kvMock.setItem).not.toHaveBeenCalled();
  });

  it('clears the draft even after an epoch bump (explicit user intent)', async () => {
    seedStoredValue('draft:u1', 'k', '"old"');
    bumpAuthEpoch();
    await clearDraft('u1', 'k');
    await expect(loadDraft('u1', 'k', isStringDraft)).resolves.toBeNull();
    expect(kvMock.removeItem).toHaveBeenCalledWith('draft:u1', 'k');
  });
});

describe('clear', () => {
  it('cancels the pending write and removes the stored entry', async () => {
    vi.useFakeTimers();
    seedStoredValue('draft:u1', 'k', '"old"');
    saveDraft('u1', 'k', 'new');
    await clearDraft('u1', 'k');
    expect(kvMock.removeItem).toHaveBeenCalledWith('draft:u1', 'k');
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 2);
    expect(kvMock.setItem).not.toHaveBeenCalled();
    await expect(loadDraft('u1', 'k', isStringDraft)).resolves.toBeNull();
  });

  it('serializes behind an in-flight write so a clear always wins', async () => {
    // A slow in-flight write for the key, then a clear: chainSave orders the
    // remove after the set, so the entry never survives.
    let releaseSet: (() => void) | undefined = undefined;
    const gate = new Promise<void>(resolve => {
      releaseSet = resolve;
    });
    kvMock.setItem.mockImplementationOnce(async (scope, k, v) => {
      await gate;
      kvStore.set(storageKey(scope, k), { scope, k, v, updatedAt: nextUpdatedAt });
      nextUpdatedAt += 1;
    });
    const firstWrite = (async () => {
      saveDraft('u1', 'k', 'a');
      await flushDraft('u1', 'k');
    })();
    const clear = clearDraft('u1', 'k');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    releaseSet!();
    await Promise.all([firstWrite, clear]);
    await expect(loadDraft('u1', 'k', isStringDraft)).resolves.toBeNull();
    expect(inFlightSaveCount()).toBe(0);
  });
});

describe('size cap', () => {
  it('skips a save larger than 64 KB without scheduling a write', async () => {
    vi.useFakeTimers();
    const oversized = 'x'.repeat(DRAFT_MAX_BYTES + 1);
    saveDraft('u1', 'k', oversized);
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS * 2);
    expect(kvMock.setItem).not.toHaveBeenCalled();
  });

  it('allows a value whose serialized form is exactly 64 KB', async () => {
    // JSON stringification adds two quotes, so a 64 KB text draft is
    // DRAFT_MAX_BYTES - 2 characters long.
    const exact = 'x'.repeat(DRAFT_MAX_BYTES - 2);
    saveDraft('u1', 'k', exact);
    await flushDraft('u1', 'k');
    expect(kvMock.setItem).toHaveBeenCalledWith('draft:u1', 'k', expect.any(String));
  });

  it('loads null and reports Sentry for a stored value over the cap', async () => {
    seedStoredValue('draft:u1', 'k', `"${'x'.repeat(DRAFT_MAX_BYTES + 1)}"`);
    await expect(loadDraft('u1', 'k', isStringDraft)).resolves.toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('unsupported serialization boundary', () => {
  it('does not throw and reports Sentry for a circular value without scheduling a write', async () => {
    vi.useFakeTimers();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => {
      saveDraft('u1', 'k', circular);
    }).not.toThrow();
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { 'error.subsystem': 'drafts', 'error.operation': 'write' },
      })
    );
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS * 2);
    expect(kvMock.setItem).not.toHaveBeenCalled();
  });

  it('does not throw and reports Sentry for an undefined value without scheduling a write', async () => {
    vi.useFakeTimers();
    expect(() => {
      saveDraft('u1', 'k', undefined);
    }).not.toThrow();
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { 'error.subsystem': 'drafts', 'error.operation': 'write' },
        fingerprint: ['draft-write-unsupported-value'],
      })
    );
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS * 2);
    expect(kvMock.setItem).not.toHaveBeenCalled();
  });

  it('leaves a previously stored draft untouched when serialization fails', async () => {
    seedStoredValue('draft:u1', 'k', '"old"');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    saveDraft('u1', 'k', circular);
    await flushDraft('u1', 'k');
    await expect(loadDraft('u1', 'k', isStringDraft)).resolves.toBe('old');
  });
});

describe('corrupt read', () => {
  it('loads null and reports Sentry for a value that is not valid JSON', async () => {
    seedStoredValue('draft:u1', 'k', 'not-json{{{');
    await expect(loadDraft('u1', 'k', isStringDraft)).resolves.toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('reports safe fixed context without overriding native error grouping', async () => {
    seedStoredValue('draft:u1', 'k', 'not-json{{{');
    await loadDraft('u1', 'k', isStringDraft);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      level: 'warning',
      tags: { 'error.subsystem': 'drafts', 'error.operation': 'read' },
    });
  });
});

describe('shape validation', () => {
  it('loads null and reports Sentry when a composer draft is not a string', async () => {
    seedStoredValue('draft:u1', 'k', '42');
    await expect(loadDraft('u1', 'k', isStringDraft)).resolves.toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('loads null and reports Sentry when a review draft is not an array', async () => {
    seedStoredValue('draft:u1', 'k', '{"id":"c1"}');
    await expect(loadDraft('u1', 'k', isReviewDraft)).resolves.toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('loads null and reports Sentry when a review draft holds a malformed item', async () => {
    seedStoredValue(
      'draft:u1',
      'k',
      '[{"id":42,"path":"a.ts","side":"RIGHT","line":1,"body":"x"}]'
    );
    await expect(loadDraft('u1', 'k', isReviewDraft)).resolves.toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('uses a fixed fingerprint for a recognized shape mismatch', async () => {
    seedStoredValue('draft:u1', 'k', '{}');
    await loadDraft('u1', 'k', isStringDraft);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      level: 'warning',
      tags: { 'error.subsystem': 'drafts', 'error.operation': 'read' },
      fingerprint: ['draft-read-shape-mismatch'],
    });
  });
});

describe('write rejection boundary', () => {
  it('reports and swallows a failed debounced write so the timer never leaks an unhandled rejection', async () => {
    vi.useFakeTimers();
    kvMock.setItem.mockRejectedValueOnce(new Error('kv down'));
    saveDraft('u1', 'k', 'v');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { 'error.subsystem': 'drafts', 'error.operation': 'write' },
      })
    );
  });

  it('flushDraft reports and resolves when the write fails', async () => {
    kvMock.setItem.mockRejectedValueOnce(new Error('kv down'));
    saveDraft('u1', 'k', 'v');
    await expect(flushDraft('u1', 'k')).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('flushDraft reports and resolves when eviction fails', async () => {
    kvMock.listEntries.mockRejectedValueOnce(new Error('list down'));
    saveDraft('u1', 'k', 'v');
    await expect(flushDraft('u1', 'k')).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('clearDraft reports and returns false when the remove fails', async () => {
    kvMock.removeItem.mockRejectedValueOnce(new Error('kv down'));
    seedStoredValue('draft:u1', 'k', '"old"');
    await expect(clearDraft('u1', 'k')).resolves.toBe(false);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('keeps the composer usable: a failed flush leaves no pending timer and a later save still works', async () => {
    vi.useFakeTimers();
    kvMock.setItem.mockRejectedValueOnce(new Error('kv down'));
    saveDraft('u1', 'k', 'first');
    await flushDraft('u1', 'k');
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 2);
    expect(kvMock.setItem).toHaveBeenCalledTimes(1);
    saveDraft('u1', 'k', 'second');
    await flushDraft('u1', 'k');
    expect(kvMock.setItem).toHaveBeenCalledTimes(2);
  });
});

describe('eviction at the entry cap', () => {
  it('evicts the oldest entries down to 100 after a save that overflows', async () => {
    // 101 stored entries: saving one more key makes 102, overflowing by two.
    for (let index = 0; index < DRAFT_MAX_ENTRIES + 1; index += 1) {
      seedStoredValue('draft:u1', `old-${index}`, `"${index}"`);
    }
    saveDraft('u1', 'newest', 'v');
    await flushDraft('u1', 'newest');

    const entries = await kvMock.listEntries('draft:u1');
    expect(entries).toHaveLength(DRAFT_MAX_ENTRIES);
    // The two oldest seeds were evicted; the newest key survived.
    expect(entries.some(entry => entry.k === 'old-0')).toBe(false);
    expect(entries.some(entry => entry.k === 'old-1')).toBe(false);
    expect(entries.some(entry => entry.k === 'newest')).toBe(true);
    expect(kvMock.removeItem).toHaveBeenCalledWith('draft:u1', 'old-0');
    expect(kvMock.removeItem).toHaveBeenCalledWith('draft:u1', 'old-1');
  });

  it('does not evict when the scope is at or below the cap', async () => {
    for (let index = 0; index < DRAFT_MAX_ENTRIES; index += 1) {
      seedStoredValue('draft:u1', `old-${index}`, `"${index}"`);
    }
    saveDraft('u1', 'old-0', 'updated');
    await flushDraft('u1', 'old-0');
    const entries = await kvMock.listEntries('draft:u1');
    expect(entries).toHaveLength(DRAFT_MAX_ENTRIES);
    expect(kvMock.removeItem).not.toHaveBeenCalled();
  });
});

// a6 activates production-caller enforcement for each row as it converts the surface.
const scopedDraftInventory = [
  { caller: 'new-session', target: { kind: 'new-session' } },
  { caller: 'session-detail/composer-autosave', target: { kind: 'session', sessionId: 'new' } },
  { caller: 'history/search', target: { kind: 'search' } },
  { caller: 'Quick Chat', target: { kind: 'quick-chat' } },
] as const;

describe('strict draft boundaries and scoped-key inventory', () => {
  it.each(scopedDraftInventory)(
    'isolates $caller by tagged context and durable arbitrary user ID',
    async ({ caller, target }) => {
      const context = await import('@/lib/context-scope');
      const { scopedDraftKey } = await import('./scoped-draft-keys');
      const { loadDraftResult, saveDraftConfirmed } = await import('./drafts');
      context.beginAuthenticatedOwner();
      const userId = 'oauth/user:a/b_用户';
      context.confirmAuthenticatedOwner(context.getAuthenticatedOwner(), userId);
      const owner = context.getAuthenticatedOwner();
      const isCurrent = () => context.isAuthenticatedOwner(owner);
      await Promise.all(
        [null, 'personal', 'org:a/b'].map(async (org, index) => {
          const key = scopedDraftKey(context.contextScope(org), target);
          const text = `${caller} draft ${index}`;
          expect(await saveDraftConfirmed(userId, key, text, { isCurrent })).toBe('committed');
          expect(await loadDraftResult(userId, key, isStringDraft, isCurrent)).toMatchObject({
            status: 'present',
            value: text,
          });
          expect(
            await loadDraftResult('another-user', key, isStringDraft, isCurrent)
          ).toMatchObject({ status: 'failed' });
        })
      );
    }
  );
  it('does not interpret rejected I/O as an absent draft', async () => {
    const { loadDraftResult } = await import('./drafts');
    seedStoredValue('draft:u1', 'k', '"preserved"');
    kvMock.getItem.mockRejectedValueOnce(new Error('I/O unavailable'));
    expect(await loadDraftResult('u1', 'k', isStringDraft)).toMatchObject({ status: 'failed' });
    expect(kvStore.get(storageKey('draft:u1', 'k'))?.v).toBe('"preserved"');
  });
  it.each([
    ['{broken', 'json'],
    ['42', 'shape'],
  ])('keeps malformed %s distinct from absence', async (raw, reason) => {
    const { loadDraftResult } = await import('./drafts');
    seedStoredValue('draft:u1', 'k', raw);
    expect(await loadDraftResult('u1', 'k', isStringDraft)).toEqual({
      status: 'malformed',
      reason,
    });
    expect(kvStore.get(storageKey('draft:u1', 'k'))?.v).toBe(raw);
  });
  it('does not publish a draft read after a direct account replacement', async () => {
    const context = await import('@/lib/context-scope');
    const { loadDraftResult } = await import('./drafts');
    const gate = Promise.withResolvers<string | null>();
    kvMock.getItem.mockReturnValueOnce(gate.promise);
    const read = loadDraftResult('u1', 'k', isStringDraft);
    context.beginAuthenticatedOwner();
    context.confirmAuthenticatedOwner(context.getAuthenticatedOwner(), 'u2');
    gate.resolve('"private u1"');
    expect(await read).toMatchObject({ status: 'failed' });
  });
  it('cannot write a tagged key from an unproved prefilled/raw save', async () => {
    const context = await import('@/lib/context-scope');
    const { scopedDraftKey } = await import('./scoped-draft-keys');
    const key = scopedDraftKey(context.contextScope(null), { kind: 'new-session' });
    seedStoredValue('draft:u1', key, '"saved"');
    saveDraft('u1', key, 'prefill');
    await flushDraft('u1', key);
    expect(await clearDraft('u1', key)).toBe(false);
    expect(kvStore.get(storageKey('draft:u1', key))?.v).toBe('"saved"');
  });
  it('does not alias pending keys through NUL delimiters in arbitrary user IDs', async () => {
    saveDraft('a', 'b\u0000c', 'first');
    saveDraft('a\u0000b', 'c', 'second');
    await Promise.all([flushDraft('a', 'b\u0000c'), flushDraft('a\u0000b', 'c')]);
    expect(kvStore.get(storageKey('draft:a', 'b\u0000c'))?.v).toBe('"first"');
    expect(kvStore.get(storageKey('draft:a\u0000b', 'c'))?.v).toBe('"second"');
  });
});
