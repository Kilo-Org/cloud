import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyViewedFilesToggle,
  getViewedFilesSnapshot,
  resetViewedFilesStoreForTests,
  revalidateAllViewedFiles,
  revalidateViewedFiles,
  subscribeViewedFiles,
} from './viewed-files-store';

// The store's only dependency is the durable viewed-files module, so the pure
// (node) project can exercise the subscription/publish rules without SecureStore
// or React. `viewedFilesKey` is the provider-scoped key the durable map also
// uses; the stub stands in for the real (identity rule 17) implementation.
const storeMocks = vi.hoisted(() => ({
  getViewedFiles: vi.fn(),
  toggleViewedFile: vi.fn(),
  viewedFilesKey: vi.fn(
    (ref: { owner: string; repo: string; number: number }) =>
      `${ref.owner}/${ref.repo}#${ref.number}`
  ),
}));

vi.mock('@/lib/pr-review/viewed-files', () => storeMocks);

const REF = { owner: 'octocat', repo: 'hello-world', number: 42 };
const OTHER_REF = { owner: 'octocat', repo: 'other-repo', number: 7 };
const SHA1 = 'sha-1';
const SHA2 = 'sha-2';

/**
 * Flush one macrotask turn: every pending microtask chain (any await depth)
 * settles before the timeout fires. Tests that assert a publish HAS happened
 * poll an observable condition with `waitFor`; tests that assert nothing
 * published yet use one `flushTurn()` so the assertion is not coupled to the
 * read chain's await count.
 */
async function flushTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(resolve, undefined);
  await promise;
}

/**
 * Bounded poll for an observable store condition. Each attempt flushes a
 * macrotask turn before re-checking, so it observes any settled publish
 * regardless of how many awaits the read chain contains.
 */
async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- polling must flush and re-check sequentially between turns
    await flushTurn();
  }
  if (!predicate()) {
    throw new Error('waitFor: condition not met after 50 attempts');
  }
}

/** A `() => void` listener stub (typed so a void-returning parameter accepts it). */
function listenerStub() {
  return vi.fn<() => void>();
}

beforeEach(() => {
  resetViewedFilesStoreForTests();
  storeMocks.getViewedFiles.mockReset().mockResolvedValue([] as string[]);
  storeMocks.toggleViewedFile.mockReset().mockResolvedValue(undefined);
});

describe('viewed-files-store', () => {
  it('reads pending, then publishes the loaded set without notifying on subscribe', async () => {
    storeMocks.getViewedFiles.mockResolvedValue(['a.ts']);
    const listener = listenerStub();

    expect(getViewedFilesSnapshot(REF, SHA1)).toEqual({ paths: [], isLoading: true });

    const unsubscribe = subscribeViewedFiles(REF, SHA1, listener);
    expect(listener).not.toHaveBeenCalled();
    expect(getViewedFilesSnapshot(REF, SHA1)).toEqual({ paths: [], isLoading: true });

    await waitFor(() => listener.mock.calls.length > 0);
    expect(storeMocks.getViewedFiles).toHaveBeenCalledWith(REF, SHA1);
    expect(getViewedFilesSnapshot(REF, SHA1)).toEqual({ paths: ['a.ts'], isLoading: false });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('publishes an empty loaded set when the read rejects', async () => {
    storeMocks.getViewedFiles.mockRejectedValue(new Error('read failed'));
    subscribeViewedFiles(REF, SHA1, listenerStub());

    await waitFor(() => !getViewedFilesSnapshot(REF, SHA1).isLoading);
    expect(getViewedFilesSnapshot(REF, SHA1)).toEqual({ paths: [], isLoading: false });
  });

  it('returns one object until a publish replaces it', async () => {
    storeMocks.getViewedFiles.mockResolvedValue(['a.ts']);
    subscribeViewedFiles(REF, SHA1, listenerStub());
    expect(getViewedFilesSnapshot(REF, SHA1)).toBe(getViewedFilesSnapshot(REF, SHA1));

    await waitFor(() => !getViewedFilesSnapshot(REF, SHA1).isLoading);
    const loaded = getViewedFilesSnapshot(REF, SHA1);
    expect(loaded).toBe(getViewedFilesSnapshot(REF, SHA1));

    storeMocks.getViewedFiles.mockResolvedValue(['a.ts', 'b.ts']);
    await revalidateViewedFiles(REF, SHA1);
    const revalidated = getViewedFilesSnapshot(REF, SHA1);
    expect(revalidated).not.toBe(loaded);
    expect(revalidated).toEqual({ paths: ['a.ts', 'b.ts'], isLoading: false });
    expect(revalidated).toBe(getViewedFilesSnapshot(REF, SHA1));
  });

  it('reads once and fans one publish out to every listener on the key', async () => {
    storeMocks.getViewedFiles.mockResolvedValue(['a.ts']);
    const first = listenerStub();
    const second = listenerStub();
    subscribeViewedFiles(REF, SHA1, first);
    subscribeViewedFiles(REF, SHA1, second);

    await waitFor(() => second.mock.calls.length > 0);
    expect(storeMocks.getViewedFiles).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(getViewedFilesSnapshot(REF, SHA1).paths).toEqual(['a.ts']);
  });

  it('drops the entry on the last unsubscribe and re-reads on the next subscribe', async () => {
    storeMocks.getViewedFiles.mockResolvedValue(['a.ts']);
    const unsubscribeFirst = subscribeViewedFiles(REF, SHA1, listenerStub());
    const unsubscribeSecond = subscribeViewedFiles(REF, SHA1, listenerStub());
    await waitFor(() => !getViewedFilesSnapshot(REF, SHA1).isLoading);

    // One listener leaving keeps the entry (and its loaded snapshot) alive.
    unsubscribeFirst();
    expect(getViewedFilesSnapshot(REF, SHA1).paths).toEqual(['a.ts']);

    unsubscribeSecond();
    expect(getViewedFilesSnapshot(REF, SHA1)).toEqual({ paths: [], isLoading: true });

    storeMocks.getViewedFiles.mockResolvedValue(['b.ts']);
    subscribeViewedFiles(REF, SHA1, listenerStub());
    await waitFor(() => getViewedFilesSnapshot(REF, SHA1).paths.includes('b.ts'));
    expect(storeMocks.getViewedFiles).toHaveBeenCalledTimes(2);
    expect(getViewedFilesSnapshot(REF, SHA1).paths).toEqual(['b.ts']);
  });

  it('never cross-notifies two refs, or two head SHAs of one ref', async () => {
    storeMocks.getViewedFiles.mockResolvedValue(['a.ts']);
    const otherRef = listenerStub();
    const otherSha = listenerStub();
    const own = listenerStub();
    subscribeViewedFiles(REF, SHA1, own);
    subscribeViewedFiles(OTHER_REF, SHA1, otherRef);
    subscribeViewedFiles(REF, SHA2, otherSha);
    await waitFor(() => !getViewedFilesSnapshot(REF, SHA2).isLoading);

    own.mockClear();
    otherRef.mockClear();
    otherSha.mockClear();
    await revalidateViewedFiles(REF, SHA1);

    expect(own).toHaveBeenCalledTimes(1);
    expect(otherRef).not.toHaveBeenCalled();
    expect(otherSha).not.toHaveBeenCalled();
    expect(getViewedFilesSnapshot(REF, SHA1).paths).toEqual(['a.ts']);
    expect(getViewedFilesSnapshot(OTHER_REF, SHA1).paths).toEqual(['a.ts']);
    expect(getViewedFilesSnapshot(REF, SHA2).paths).toEqual(['a.ts']);
  });

  it('publishes the optimistic toggle before the durable write settles, then revalidates every key', async () => {
    storeMocks.getViewedFiles.mockResolvedValue([] as string[]);
    const own = listenerStub();
    const other = listenerStub();
    subscribeViewedFiles(REF, SHA1, own);
    subscribeViewedFiles(OTHER_REF, SHA1, other);
    await waitFor(() => !getViewedFilesSnapshot(OTHER_REF, SHA1).isLoading);

    const writeGate = Promise.withResolvers<undefined>();
    storeMocks.toggleViewedFile.mockReturnValue(writeGate.promise);
    storeMocks.getViewedFiles.mockClear();
    own.mockClear();
    other.mockClear();

    const toggling = applyViewedFilesToggle(REF, SHA1, 'a.ts');
    // The flipped set is published synchronously, before the write resolves.
    expect(getViewedFilesSnapshot(REF, SHA1)).toEqual({ paths: ['a.ts'], isLoading: false });
    expect(own).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();

    writeGate.resolve(undefined);
    await toggling;
    await waitFor(() => other.mock.calls.length > 0);

    expect(storeMocks.toggleViewedFile).toHaveBeenCalledWith({
      ...REF,
      headSha: SHA1,
      path: 'a.ts',
    });
    // Both open keys were re-read after the write.
    expect(storeMocks.getViewedFiles).toHaveBeenCalledWith(REF, SHA1);
    expect(storeMocks.getViewedFiles).toHaveBeenCalledWith(OTHER_REF, SHA1);
    expect(own).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('drops a path on a second optimistic toggle', async () => {
    const durable: string[] = ['a.ts'];
    storeMocks.getViewedFiles.mockImplementation(async () => {
      await Promise.resolve();
      return [...durable];
    });
    storeMocks.toggleViewedFile.mockImplementation(async (input: { path: string }) => {
      await Promise.resolve();
      const index = durable.indexOf(input.path);
      if (index === -1) {
        durable.push(input.path);
      } else {
        durable.splice(index, 1);
      }
    });
    subscribeViewedFiles(REF, SHA1, listenerStub());
    await waitFor(() => !getViewedFilesSnapshot(REF, SHA1).isLoading);

    await applyViewedFilesToggle(REF, SHA1, 'a.ts');
    await waitFor(
      () =>
        !getViewedFilesSnapshot(REF, SHA1).isLoading &&
        !getViewedFilesSnapshot(REF, SHA1).paths.includes('a.ts')
    );
    expect(getViewedFilesSnapshot(REF, SHA1).paths).toEqual([]);
  });

  it('revalidateAllViewedFiles re-reads every open key', async () => {
    const durable: Record<string, string[]> = {};
    storeMocks.getViewedFiles.mockImplementation(async (ref: { owner: string; repo: string }) => {
      await Promise.resolve();
      return durable[`${ref.owner}/${ref.repo}`] ?? [];
    });
    subscribeViewedFiles(REF, SHA1, listenerStub());
    subscribeViewedFiles(OTHER_REF, SHA1, listenerStub());
    await waitFor(() => !getViewedFilesSnapshot(REF, SHA1).isLoading);

    durable['octocat/hello-world'] = ['a.ts'];
    durable['octocat/other-repo'] = ['b.ts'];
    revalidateAllViewedFiles();
    await waitFor(
      () =>
        getViewedFilesSnapshot(REF, SHA1).paths.includes('a.ts') &&
        getViewedFilesSnapshot(OTHER_REF, SHA1).paths.includes('b.ts')
    );

    expect(getViewedFilesSnapshot(REF, SHA1).paths).toEqual(['a.ts']);
    expect(getViewedFilesSnapshot(OTHER_REF, SHA1).paths).toEqual(['b.ts']);
  });

  it('does not resurrect an entry whose read resolves after the last unsubscribe', async () => {
    const readGate = Promise.withResolvers<string[]>();
    storeMocks.getViewedFiles.mockReturnValue(readGate.promise);

    const unsubscribe = subscribeViewedFiles(REF, SHA1, listenerStub());
    unsubscribe();
    readGate.resolve(['a.ts']);
    await flushTurn();
    expect(getViewedFilesSnapshot(REF, SHA1)).toEqual({ paths: [], isLoading: true });
  });

  it('resetViewedFilesStoreForTests clears every entry', async () => {
    storeMocks.getViewedFiles.mockResolvedValue(['a.ts']);
    subscribeViewedFiles(REF, SHA1, listenerStub());
    await waitFor(() => !getViewedFilesSnapshot(REF, SHA1).isLoading);
    expect(getViewedFilesSnapshot(REF, SHA1).isLoading).toBe(false);

    resetViewedFilesStoreForTests();
    expect(getViewedFilesSnapshot(REF, SHA1)).toEqual({ paths: [], isLoading: true });
  });
});
