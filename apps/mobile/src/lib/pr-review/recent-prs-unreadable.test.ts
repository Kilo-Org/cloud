import * as SecureStore from 'expo-secure-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getRecentPrs,
  getRecentPrsForIndex,
  markRecentPrFailed,
  type RecentPr,
  removeRecentPr,
  upsertRecentPr,
} from './recent-prs';

const store = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    await Promise.resolve();
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    store.delete(key);
  }),
}));

vi.mock('@/lib/storage-keys', () => ({
  PR_REVIEW_RECENTS_KEY: 'pr-review-recents',
}));

beforeEach(() => {
  store.clear();
});

function makeRecent(overrides: Partial<RecentPr> = {}): RecentPr {
  return {
    owner: 'octocat',
    repo: 'hello-world',
    number: 42,
    title: 'Hello PR',
    lastOpenedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// A read that feeds a read-modify-write must tell "unreadable" apart from
// "no recents". Treating a failed read as an empty list would persist a list
// derived from one and destroy the stored recents. The mutations stay total
// (their callers fire them without awaiting), so they abort and resolve.
describe('recent-prs with an unreadable store', () => {
  it('leaves the stored recents intact when the read for an upsert fails', async () => {
    await upsertRecentPr(makeRecent({ owner: 'octocat', repo: 'hello', number: 1, title: 'One' }));
    // The bytes a mutation that always writes would replace. An upsert that
    // read the failed read as "no recents" would persist `[Two]` here, so this
    // assertion pins the abort that `getRecentPrs()` alone reads past.
    const storedBefore = store.get('pr-review-recents');

    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain locked'));
    await expect(
      upsertRecentPr(makeRecent({ owner: 'octocat', repo: 'hello', number: 2, title: 'Two' }))
    ).resolves.toBeUndefined();

    expect(store.get('pr-review-recents')).toBe(storedBefore);
    await expect(getRecentPrs()).resolves.toMatchObject([{ number: 1, title: 'One' }]);
  });

  it('leaves the stored recents intact when the read for a remove fails', async () => {
    await upsertRecentPr(makeRecent({ owner: 'octocat', repo: 'hello', number: 1, title: 'One' }));
    await upsertRecentPr(makeRecent({ owner: 'octocat', repo: 'hello', number: 2, title: 'Two' }));
    // A remove that read the failed read as "no recents" would persist `[]`.
    const storedBefore = store.get('pr-review-recents');

    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain locked'));
    await expect(
      removeRecentPr({ owner: 'octocat', repo: 'hello', number: 1 })
    ).resolves.toBeUndefined();

    expect(store.get('pr-review-recents')).toBe(storedBefore);
    await expect(getRecentPrs()).resolves.toMatchObject([
      { number: 2, title: 'Two' },
      { number: 1, title: 'One' },
    ]);
  });

  it('stays total when the read for a failed-mark fails', async () => {
    await upsertRecentPr(makeRecent({ owner: 'octocat', repo: 'hello', number: 1, title: 'One' }));

    // `markRecentPrFailed` writes only when it finds the entry, and a failed
    // read finds nothing, so the stored bytes cannot witness an abort here:
    // they stay byte-identical whether the unreadable read aborts or is read as
    // "no recents", and the mark never reaches a write. This case pins the
    // reachable failure instead — the unreadable read must not reject into the
    // fire-and-forget caller. The upsert and remove cases above are what pin
    // the abort, because those mutations always write.
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain locked'));
    await expect(
      markRecentPrFailed({ owner: 'octocat', repo: 'hello', number: 1 })
    ).resolves.toBeUndefined();
  });
});

// The OS search index reads the recents to decide whether a recents scope may
// remove an indexed entry, so it must tell a failed read from an empty list:
// `undefined` aborts the scope claim, `[]` authorises removal.
describe('getRecentPrsForIndex with an unreadable store', () => {
  it('resolves undefined when the read fails, so no recents scope is claimed', async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain locked'));

    await expect(getRecentPrsForIndex()).resolves.toBeUndefined();
  });

  it('resolves the stored list when the read succeeds', async () => {
    await upsertRecentPr(makeRecent({ owner: 'octocat', repo: 'hello', number: 1, title: 'One' }));

    await expect(getRecentPrsForIndex()).resolves.toMatchObject([{ number: 1, title: 'One' }]);
  });
});
