import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearViewedFiles, getViewedFiles, toggleViewedFile } from './viewed-files';

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
  PR_REVIEW_VIEWED_KEY: 'pr-review-viewed',
}));

beforeEach(() => {
  store.clear();
});

const OWNER = 'octocat';
const REPO = 'hello-world';
const NUMBER = 42;
const SHA1 = 'aaaaaaaaaaaaaaaa';
const SHA2 = 'bbbbbbbbbbbbbbbb';
const REF = { owner: OWNER, repo: REPO, number: NUMBER };

function setStored(map: object) {
  store.set('pr-review-viewed', JSON.stringify(map));
}

describe('viewed-files', () => {
  it('returns an empty list when nothing has been stored', async () => {
    await expect(getViewedFiles(REF, SHA1)).resolves.toEqual([]);
  });

  it('returns the stored viewed paths when headSha matches', async () => {
    setStored({ 'octocat/hello-world#42': { headSha: SHA1, viewedPaths: ['a.ts', 'b.ts'] } });
    await expect(getViewedFiles(REF, SHA1)).resolves.toEqual(['a.ts', 'b.ts']);
  });

  it('returns an empty list when headSha has changed (no leakage from previous SHA)', async () => {
    setStored({ 'octocat/hello-world#42': { headSha: SHA1, viewedPaths: ['a.ts'] } });
    await expect(getViewedFiles(REF, SHA2)).resolves.toEqual([]);
  });

  it('toggle adds a path when none was set for the current headSha', async () => {
    setStored({});
    await toggleViewedFile({ ...REF, headSha: SHA1, path: 'src/index.ts' });
    await expect(getViewedFiles(REF, SHA1)).resolves.toEqual(['src/index.ts']);
  });

  it('toggle removes a path when it is already viewed', async () => {
    setStored({
      'octocat/hello-world#42': { headSha: SHA1, viewedPaths: ['src/index.ts', 'src/util.ts'] },
    });
    await toggleViewedFile({ ...REF, headSha: SHA1, path: 'src/index.ts' });
    await expect(getViewedFiles(REF, SHA1)).resolves.toEqual(['src/util.ts']);
  });

  it('toggle resets viewedPaths when headSha changes', async () => {
    setStored({
      'octocat/hello-world#42': { headSha: SHA1, viewedPaths: ['old.ts', 'stale.ts'] },
    });
    await toggleViewedFile({ ...REF, headSha: SHA2, path: 'new.ts' });
    await expect(getViewedFiles(REF, SHA2)).resolves.toEqual(['new.ts']);
    // And the old SHA no longer leaks its viewed set.
    await expect(getViewedFiles(REF, SHA1)).resolves.toEqual([]);
  });

  it('caps the map at 20 PRs, evicting the least-recently-touched', async () => {
    const seed: Record<string, { headSha: string; viewedPaths: string[] }> = {};
    for (let index = 0; index < 20; index += 1) {
      seed[`octocat/repo-${index}#1`] = { headSha: SHA1, viewedPaths: [] };
    }
    setStored(seed);
    await toggleViewedFile({
      owner: 'octocat',
      repo: 'brand-new-repo',
      number: 1,
      headSha: SHA1,
      path: 'a.ts',
    });

    // The newest entry exists with its single viewed file.
    await expect(
      getViewedFiles({ owner: 'octocat', repo: 'brand-new-repo', number: 1 }, SHA1)
    ).resolves.toEqual(['a.ts']);
    // The oldest (repo-0) was evicted; reading it yields an empty list.
    await expect(
      getViewedFiles({ owner: 'octocat', repo: 'repo-0', number: 1 }, SHA1)
    ).resolves.toEqual([]);
    // The most-recently-touched original (repo-19) is still present.
    await expect(
      getViewedFiles({ owner: 'octocat', repo: 'repo-19', number: 1 }, SHA1)
    ).resolves.toEqual([]);
  });

  it('treats corrupt stored data as an empty map', async () => {
    store.set('pr-review-viewed', '{not json');
    await expect(getViewedFiles(REF, SHA1)).resolves.toEqual([]);
  });

  it('drops structurally invalid entries (non-string headSha / non-array viewedPaths)', async () => {
    setStored({
      'octocat/hello-world#42': { headSha: SHA1, viewedPaths: ['keep.ts'] },
      'octocat/bad-sha#1': { headSha: 123, viewedPaths: ['x'] },
      'octocat/bad-paths#2': { headSha: SHA1, viewedPaths: null },
      'octocat/bad-nested#3': { headSha: SHA1, viewedPaths: ['ok', 5] },
    });
    // The valid entry is preserved.
    await expect(getViewedFiles(REF, SHA1)).resolves.toEqual(['keep.ts']);
    // The malformed entries are discarded, not returned as non-arrays.
    await expect(
      getViewedFiles({ owner: 'octocat', repo: 'bad-paths', number: 2 }, SHA1)
    ).resolves.toEqual([]);
    // And toggling on top of malformed data does not throw.
    await expect(
      toggleViewedFile({
        owner: 'octocat',
        repo: 'bad-nested',
        number: 3,
        headSha: SHA1,
        path: 'z.ts',
      })
    ).resolves.toBeUndefined();
  });

  it('clearViewedFiles deletes the storage key', async () => {
    store.set('pr-review-viewed', 'placeholder');
    await clearViewedFiles();
    expect(store.has('pr-review-viewed')).toBe(false);
  });
});
