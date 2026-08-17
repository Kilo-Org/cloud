import { beforeEach, describe, expect, it, vi } from 'vitest';

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

/* eslint-disable import/first */
import * as SecureStore from 'expo-secure-store';
import { SESSION_FILTERS_KEY } from '@/lib/storage-keys';
import { deleteAccountMetadata, writeAccountMetadata } from './account-metadata-write';
import { bumpAuthEpoch } from './auth-epoch';
/* eslint-enable import/first */

describe('account-metadata-write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it('writes the value through the callback while the epoch is current', async () => {
    await writeAccountMetadata('k', async () => {
      await SecureStore.setItemAsync('k', 'value');
    });
    expect(store.get('k')).toBe('value');
  });

  it('skips a queued write scheduled before an epoch bump', async () => {
    let releaseBlock: (() => void) | undefined = undefined;
    const gate = new Promise<void>(resolve => {
      releaseBlock = resolve;
    });

    // First save holds the key's chain open; the second is queued behind it.
    const block = writeAccountMetadata('k', async () => {
      await gate;
    });
    const queued = writeAccountMetadata('k', async () => {
      await SecureStore.setItemAsync('k', 'stale');
    });

    bumpAuthEpoch();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    releaseBlock!();
    await Promise.all([block, queued]);

    expect(store.has('k')).toBe(false);
  });

  it('a delete always runs and lands after an in-flight write to the same key', async () => {
    let releaseWrite: (() => void) | undefined = undefined;
    const gate = new Promise<void>(resolve => {
      releaseWrite = resolve;
    });

    const write = writeAccountMetadata('del-key', async () => {
      store.set('del-key', 'value');
      await gate;
    });

    // Wait until the write has started and landed its value.
    await vi.waitFor(() => {
      expect(store.get('del-key')).toBe('value');
    });

    const del = deleteAccountMetadata('del-key');
    // The epoch bump fences pending writes but never fences deletes.
    bumpAuthEpoch();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    releaseWrite!();

    await Promise.all([write, del]);
    expect(store.has('del-key')).toBe(false);
  });

  it('regression: a stale filters write never outlives the sign-out delete', async () => {
    let releaseBlock: (() => void) | undefined = undefined;
    const gate = new Promise<void>(resolve => {
      releaseBlock = resolve;
    });

    // An in-flight save keeps the filters key busy while the user changes
    // filters and then signs out. The queued filters write and the delete are
    // both scheduled before the sign-out epoch bump.
    const block = writeAccountMetadata(SESSION_FILTERS_KEY, async () => {
      await gate;
    });
    const filtersWrite = writeAccountMetadata(SESSION_FILTERS_KEY, async () => {
      await SecureStore.setItemAsync(SESSION_FILTERS_KEY, JSON.stringify({ platformFilter: [] }));
    });
    const del = deleteAccountMetadata(SESSION_FILTERS_KEY);

    bumpAuthEpoch();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    releaseBlock!();

    await Promise.all([block, filtersWrite, del]);
    expect(store.has(SESSION_FILTERS_KEY)).toBe(false);
  });
});
