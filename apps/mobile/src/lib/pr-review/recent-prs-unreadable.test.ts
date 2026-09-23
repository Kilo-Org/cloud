import * as SecureStore from 'expo-secure-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getRecentPrs,
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

    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain locked'));
    await expect(
      upsertRecentPr(makeRecent({ owner: 'octocat', repo: 'hello', number: 2, title: 'Two' }))
    ).resolves.toBeUndefined();

    await expect(getRecentPrs()).resolves.toMatchObject([{ number: 1, title: 'One' }]);
  });

  it('leaves the stored recents intact when the read for a remove fails', async () => {
    await upsertRecentPr(makeRecent({ owner: 'octocat', repo: 'hello', number: 1, title: 'One' }));
    await upsertRecentPr(makeRecent({ owner: 'octocat', repo: 'hello', number: 2, title: 'Two' }));

    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain locked'));
    await expect(
      removeRecentPr({ owner: 'octocat', repo: 'hello', number: 1 })
    ).resolves.toBeUndefined();

    await expect(getRecentPrs()).resolves.toMatchObject([
      { number: 2, title: 'Two' },
      { number: 1, title: 'One' },
    ]);
  });

  it('leaves the stored recents intact when the read for a failed-mark fails', async () => {
    await upsertRecentPr(makeRecent({ owner: 'octocat', repo: 'hello', number: 1, title: 'One' }));

    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain locked'));
    await expect(
      markRecentPrFailed({ owner: 'octocat', repo: 'hello', number: 1 })
    ).resolves.toBeUndefined();

    await expect(getRecentPrs()).resolves.toMatchObject([{ number: 1, lastResult: 'ok' }]);
  });
});
