import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRecentPrs, getRecentPrs, type RecentPr, upsertRecentPr } from './recent-prs';

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
  // Clear the disk mock between tests. The module's write-queue is a
  // module-level variable that survives across tests; since every test
  // awaits its own upsert/clear chain before returning, the queue is
  // always drained before the next test starts.
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

describe('recent-prs', () => {
  it('returns an empty list when nothing has been stored', async () => {
    await expect(getRecentPrs()).resolves.toEqual([]);
  });

  it('upsert puts a new entry at the front of the list', async () => {
    await upsertRecentPr(makeRecent({ owner: 'octocat', repo: 'hello', number: 1, title: 'One' }));
    await upsertRecentPr(makeRecent({ owner: 'octocat', repo: 'hello', number: 2, title: 'Two' }));

    await expect(getRecentPrs()).resolves.toMatchObject([
      { number: 2, title: 'Two' },
      { number: 1, title: 'One' },
    ]);
  });

  it('upsert moves an existing entry to the front and updates its title', async () => {
    await upsertRecentPr(makeRecent({ number: 1, title: 'Old title' }));
    await upsertRecentPr(makeRecent({ owner: 'octocat', repo: 'hello', number: 2, title: 'Two' }));
    await upsertRecentPr(makeRecent({ number: 1, title: 'New title' }));

    await expect(getRecentPrs()).resolves.toMatchObject([
      { number: 1, title: 'New title' },
      { number: 2, title: 'Two' },
    ]);
  });

  it('caps the list at 10 entries, keeping the most recent first', async () => {
    // Sequentially upsert so each write sees the previous write's result
    // — the write-queue relies on this ordering. Promise.all would let
    // the in-flight reads race.
    const writes: Promise<void>[] = [];
    for (let index = 0; index < 10; index += 1) {
      writes.push(upsertRecentPr(makeRecent({ number: index + 1, title: `T${index + 1}` })));
    }
    await Promise.all(writes);
    await upsertRecentPr(makeRecent({ number: 99, title: 'Newest' }));

    const recents = await getRecentPrs();
    expect(recents).toHaveLength(10);
    expect(recents[0]).toMatchObject({ number: 99, title: 'Newest' });
    // Most-recent-first: after the cap, the oldest original (T1) drops off
    // the tail, T10 sits at 1, and T2..T10 are all still in the list.
    expect(recents[1]).toMatchObject({ number: 10, title: 'T10' });
    expect(recents.at(-1)).toMatchObject({ number: 2, title: 'T2' });
    expect(recents).not.toContainEqual(expect.objectContaining({ number: 1, title: 'T1' }));
  });

  it('treats corrupt stored data as an empty list', async () => {
    store.set('pr-review-recents', '{not json');
    await expect(getRecentPrs()).resolves.toEqual([]);
  });

  it('treats malformed entries (missing fields) as not present', async () => {
    // Mixed bag: one valid entry + an entry missing required fields + a
    // string + null. Only the valid one should survive the parse filter.
    store.set(
      'pr-review-recents',
      JSON.stringify([
        {
          owner: 'octocat',
          repo: 'hello',
          number: 1,
          title: 'Good',
          lastOpenedAt: 1_700_000_000_000,
        },
        { owner: 'octocat', repo: 'hello' },
        'not-an-object',
        null,
      ])
    );
    await expect(getRecentPrs()).resolves.toMatchObject([{ number: 1, title: 'Good' }]);
  });

  it('clearRecentPrs deletes the storage key', async () => {
    store.set('pr-review-recents', 'placeholder');
    await clearRecentPrs();
    expect(store.has('pr-review-recents')).toBe(false);
  });
});
