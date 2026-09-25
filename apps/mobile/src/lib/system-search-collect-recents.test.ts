/* eslint-disable require-await, @typescript-eslint/require-await -- the SecureStore mock settles without await because it resolves immediately */
import { QueryClient } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PR_REVIEW_RECENTS_KEY } from '@/lib/storage-keys';

import { collectSystemSearchDocuments } from './system-search-collect';
import {
  planSystemSearchUpdate,
  recentPrSearchDocument,
  recentsSourceScope,
} from './system-search-entries';

// The real recents read (no module mock) over a SecureStore that can fail:
// this is the collector's own path, so the assertion covers the read that
// decides whether a recents scope may remove an indexed entry.
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

const storedRecent = {
  owner: 'group/sub',
  repo: 'repo',
  number: 12,
  title: 'Nested MR',
  lastOpenedAt: 1,
};

// The source scope the collector's own read of the list enumerates for the
// stored entry's provider (GitHub).
const RECENTS_SCOPE = recentsSourceScope('github');

beforeEach(() => {
  store.clear();
  vi.mocked(SecureStore.getItemAsync).mockReset();
});

describe('collectSystemSearchDocuments over the stored PR recents', () => {
  it('indexes and observes a recents entry it can read', async () => {
    store.set(PR_REVIEW_RECENTS_KEY, JSON.stringify([storedRecent]));

    const { documents, observedSources } = await collectSystemSearchDocuments(new QueryClient());

    expect(documents.map(document => document.id)).toEqual([
      recentPrSearchDocument(storedRecent).id,
    ]);
    expect(observedSources.has(RECENTS_SCOPE)).toBe(true);
  });

  it('keeps an indexed recents entry when the stored list cannot be read', async () => {
    store.set(PR_REVIEW_RECENTS_KEY, JSON.stringify([storedRecent]));
    const indexed = recentPrSearchDocument(storedRecent);

    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain locked'));
    const { documents, observedSources } = await collectSystemSearchDocuments(new QueryClient());

    // A read that did not happen is not evidence that the entry is gone: the
    // recents scope is not claimed and the plan removes nothing on its strength.
    expect(observedSources.has(RECENTS_SCOPE)).toBe(false);
    const plan = planSystemSearchUpdate({ indexed: [indexed], documents, observedSources });
    expect(plan.remove).toEqual([]);
  });

  it('removes an indexed recents entry once the stored list is read and no longer holds it', async () => {
    store.set(PR_REVIEW_RECENTS_KEY, JSON.stringify([]));
    const indexed = recentPrSearchDocument(storedRecent);

    const { documents, observedSources } = await collectSystemSearchDocuments(new QueryClient());
    const plan = planSystemSearchUpdate({ indexed: [indexed], documents, observedSources });

    expect(plan.remove).toEqual([indexed.id]);
  });
});
