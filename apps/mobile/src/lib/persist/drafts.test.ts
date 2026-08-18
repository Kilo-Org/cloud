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

vi.mock('@/lib/persist/encrypted-kv', () => kvMock);

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
  isStringDraft,
  loadDraft,
  NEW_SESSION_DRAFT_KEY,
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
  return `${scope}\u0000${k}`;
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
        extra: expect.objectContaining({ scope: 'draft:u1', entityKey: 'k' }),
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
        extra: expect.objectContaining({ scope: 'draft:u1', entityKey: 'k' }),
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

  it('reports the scope and entity key to Sentry', async () => {
    seedStoredValue('draft:u1', 'k', 'not-json{{{');
    await loadDraft('u1', 'k', isStringDraft);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({ scope: 'draft:u1', entityKey: 'k' }),
      })
    );
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

  it('reports the scope and entity key for a shape mismatch', async () => {
    seedStoredValue('draft:u1', 'k', '{}');
    await loadDraft('u1', 'k', isStringDraft);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({ scope: 'draft:u1', entityKey: 'k' }),
      })
    );
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
        extra: expect.objectContaining({ scope: 'draft:u1', entityKey: 'k' }),
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
