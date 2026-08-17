/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/lib/persist/cache-persistence-mount.test.ts */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake drafts factories settle without await because they resolve immediately */
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isPendingReviewDraft,
  pendingReviewDraftKey,
  type PendingReviewItem,
  PendingReviewProvider,
  usePendingReview,
} from './pending-review-provider';

const draftsMock = vi.hoisted(() => ({
  loadDraft: vi.fn(async (): Promise<unknown> => null),
  saveDraft: vi.fn(async (): Promise<void> => undefined),
  flushDraft: vi.fn(async (): Promise<void> => undefined),
  clearDraft: vi.fn(async (): Promise<void> => undefined),
  // Mirrors the real key builder so the casing test proves the normalization
  // this module adds, not the format the drafts module owns.
  prReviewDraftKey: (owner: string, repo: string, number: number) =>
    `pr-review:${owner}/${repo}#${number}`,
}));

vi.mock('@/lib/persist/drafts', () => draftsMock);

const sentryMock = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock('@sentry/react-native', () => sentryMock);

const appStateHandlers: ((state: string) => void)[] = [];

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_type: string, handler: (state: string) => void) => {
      appStateHandlers.push(handler);
      return { remove: vi.fn() };
    },
  },
}));

type PendingReviewValue = ReturnType<typeof usePendingReview>;

const ITEM_A: PendingReviewItem = {
  id: 'a',
  path: 'src/a.ts',
  side: 'RIGHT',
  line: 1,
  body: 'A',
  commitSha: 'sha-1',
};
const ITEM_B: PendingReviewItem = {
  id: 'b',
  path: 'src/b.ts',
  side: 'LEFT',
  line: 2,
  body: 'B',
  commitSha: 'sha-1',
};
const ITEM_C: PendingReviewItem = {
  id: 'c',
  path: 'src/c.ts',
  side: 'RIGHT',
  line: 3,
  body: 'C',
  commitSha: 'sha-1',
};

function Consumer({ onRender }: { onRender: (value: PendingReviewValue) => void }) {
  const value = usePendingReview();
  onRender(value);
  return null;
}

function mountProvider(options: { userId?: string; draftEntityKey?: string }): {
  renderer: TestRenderer.ReactTestRenderer | undefined;
  renders: PendingReviewValue[];
} {
  const renders: PendingReviewValue[] = [];
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(
      <PendingReviewProvider userId={options.userId} draftEntityKey={options.draftEntityKey}>
        <Consumer
          onRender={value => {
            renders.push(value);
          }}
        />
      </PendingReviewProvider>
    );
  });
  return { renderer, renders };
}

function latest(renders: PendingReviewValue[]): PendingReviewValue {
  const last = renders.at(-1);
  if (!last) {
    throw new Error('provider has not rendered yet');
  }
  return last;
}

// Helper to produce a controllable promise without uninitialized variables
// (same shape as src/lib/hooks/use-tracking-permission-prompt.test.ts).
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let storedResolve: ((value: T) => void) | undefined = undefined;
  const promise = new Promise<T>(resolve => {
    storedResolve = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      storedResolve?.(value);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  appStateHandlers.length = 0;
  draftsMock.loadDraft.mockResolvedValue(null);
  draftsMock.saveDraft.mockResolvedValue(undefined);
  draftsMock.flushDraft.mockResolvedValue(undefined);
  draftsMock.clearDraft.mockResolvedValue(undefined);
});

describe('PendingReviewProvider persistence', () => {
  it('hydrates the queue keyed by user and PR, then persists only after hydration', async () => {
    const gate = deferred<PendingReviewItem[] | null>();
    draftsMock.loadDraft.mockReturnValue(gate.promise);
    const { renders } = mountProvider({ userId: 'u1', draftEntityKey: 'pr-review:acme/kilo#42' });

    // The load targets exactly the per-user, per-PR storage key and passes the
    // shape validator so malformed persisted values are discarded as corrupt.
    expect(draftsMock.loadDraft).toHaveBeenCalledWith(
      'u1',
      'pr-review:acme/kilo#42',
      isPendingReviewDraft
    );
    expect(latest(renders).items).toEqual([]);

    // First-write guard: the initial empty list and any pre-hydration add
    // never touch storage.
    act(() => {
      latest(renders).addComment(ITEM_C);
    });
    expect(draftsMock.saveDraft).not.toHaveBeenCalled();

    // Hydration resolves: the stored items merge after the user's add.
    await act(async () => {
      gate.resolve([ITEM_A, ITEM_B]);
    });
    await flushMicrotasks();
    expect(latest(renders).items.map(item => item.id)).toEqual(['c', 'a', 'b']);

    // A change after hydration persists the shrunken list.
    draftsMock.saveDraft.mockClear();
    act(() => {
      latest(renders).removeComment('c');
    });
    expect(draftsMock.saveDraft).toHaveBeenCalledWith('u1', 'pr-review:acme/kilo#42', [
      ITEM_A,
      ITEM_B,
    ]);
  });

  it('stays empty without writing when hydration finds no stored draft', async () => {
    const { renders } = mountProvider({ userId: 'u1', draftEntityKey: 'pr-review:acme/kilo#42' });
    await flushMicrotasks();

    expect(latest(renders).items).toEqual([]);
    expect(draftsMock.saveDraft).not.toHaveBeenCalled();
  });

  it('keeps the valid restored items and drops only the invalid ones', async () => {
    // One corrupt row must cost one comment, never the whole queued review:
    // the valid items survive, the malformed ones never reach rendering or
    // submission, and the drop is reported.
    draftsMock.loadDraft.mockResolvedValue([
      ITEM_A,
      { id: 42, path: 'a.ts' },
      'not-an-item',
      null,
      ITEM_B,
    ]);
    const { renders } = mountProvider({ userId: 'u1', draftEntityKey: 'pr-review:acme/kilo#42' });
    await flushMicrotasks();

    expect(latest(renders).items).toEqual([ITEM_A, ITEM_B]);
    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
  });

  it('keeps the queue empty when every restored item is malformed', async () => {
    draftsMock.loadDraft.mockResolvedValue([{ id: 42, path: 'a.ts' }, 'not-an-item', null]);
    const { renders } = mountProvider({ userId: 'u1', draftEntityKey: 'pr-review:acme/kilo#42' });
    await flushMicrotasks();

    expect(latest(renders).items).toEqual([]);
    expect(draftsMock.saveDraft).not.toHaveBeenCalled();
  });

  it('clears the persisted entry on clear()', async () => {
    draftsMock.loadDraft.mockResolvedValue([ITEM_A, ITEM_B]);
    const { renders } = mountProvider({ userId: 'u1', draftEntityKey: 'pr-review:acme/kilo#42' });
    await flushMicrotasks();
    expect(latest(renders).items).toHaveLength(2);

    act(() => {
      latest(renders).clear();
    });
    expect(latest(renders).items).toEqual([]);
    expect(draftsMock.clearDraft).toHaveBeenCalledWith('u1', 'pr-review:acme/kilo#42');
  });

  it('clear() before hydration resolves wins over a late hydration result', async () => {
    // A slow hydration is still in flight when the user submits (or discards)
    // the review, which clears the queue. The late load must not merge the old
    // stored comments back into memory after the successful clear.
    const gate = deferred<PendingReviewItem[] | null>();
    draftsMock.loadDraft.mockReturnValue(gate.promise);
    const { renders } = mountProvider({ userId: 'u1', draftEntityKey: 'pr-review:acme/kilo#42' });

    act(() => {
      latest(renders).clear();
    });
    expect(latest(renders).items).toEqual([]);
    expect(draftsMock.clearDraft).toHaveBeenCalledWith('u1', 'pr-review:acme/kilo#42');

    // The stale hydration resolves with the old comments: they stay cleared.
    await act(async () => {
      gate.resolve([ITEM_A, ITEM_B]);
    });
    await flushMicrotasks();
    expect(latest(renders).items).toEqual([]);
    expect(draftsMock.saveDraft).not.toHaveBeenCalled();

    // The cleared queue stays usable: a later user add persists even though
    // the invalidated load never applied.
    draftsMock.saveDraft.mockClear();
    act(() => {
      latest(renders).addComment(ITEM_C);
    });
    expect(draftsMock.saveDraft).toHaveBeenCalledWith('u1', 'pr-review:acme/kilo#42', [ITEM_C]);
  });

  it('persists the shrunken list when removeComment leaves items', async () => {
    draftsMock.loadDraft.mockResolvedValue([ITEM_A, ITEM_B]);
    const { renders } = mountProvider({ userId: 'u1', draftEntityKey: 'pr-review:acme/kilo#42' });
    await flushMicrotasks();

    act(() => {
      latest(renders).removeComment('a');
    });
    expect(latest(renders).items.map(item => item.id)).toEqual(['b']);
    expect(draftsMock.saveDraft).toHaveBeenCalledWith(
      'u1',
      'pr-review:acme/kilo#42',
      expect.arrayContaining([ITEM_B])
    );
  });

  it('runs memory-only with no hydrate or persist when the userId is unknown', async () => {
    const { renders } = mountProvider({
      userId: undefined,
      draftEntityKey: 'pr-review:acme/kilo#42',
    });
    await flushMicrotasks();

    expect(draftsMock.loadDraft).not.toHaveBeenCalled();
    act(() => {
      latest(renders).addComment(ITEM_A);
    });
    expect(latest(renders).items).toEqual([ITEM_A]);
    expect(draftsMock.saveDraft).not.toHaveBeenCalled();
  });

  it('never applies a hydration result that resolves after unmount', async () => {
    const gate = deferred<PendingReviewItem[] | null>();
    draftsMock.loadDraft.mockReturnValue(gate.promise);
    const { renderer } = mountProvider({ userId: 'u1', draftEntityKey: 'pr-review:acme/kilo#42' });
    act(() => {
      renderer?.unmount();
    });

    await act(async () => {
      gate.resolve([ITEM_A, ITEM_B]);
    });
    await flushMicrotasks();
    expect(draftsMock.saveDraft).not.toHaveBeenCalled();
  });

  it('maps both owner/repo casings of one PR to a single draft key', () => {
    // The recent-PR and viewed-file stores lowercase both segments; a queue
    // reached through `Kilo-Org/cloud` must not be a different queue from the
    // one reached through `kilo-org/cloud`.
    expect(pendingReviewDraftKey('Kilo-Org', 'Cloud', 42)).toBe(
      pendingReviewDraftKey('kilo-org', 'cloud', 42)
    );
    expect(pendingReviewDraftKey('Kilo-Org', 'Cloud', 42)).toBe('pr-review:kilo-org/cloud#42');
  });

  it('flushes the pending save when the app leaves the active state', async () => {
    draftsMock.loadDraft.mockResolvedValue([ITEM_A]);
    mountProvider({ userId: 'u1', draftEntityKey: 'pr-review:acme/kilo#42' });
    await flushMicrotasks();

    expect(appStateHandlers.length).toBeGreaterThan(0);
    act(() => {
      for (const handler of appStateHandlers) {
        handler('background');
      }
    });
    expect(draftsMock.flushDraft).toHaveBeenCalledWith('u1', 'pr-review:acme/kilo#42');
  });
});
