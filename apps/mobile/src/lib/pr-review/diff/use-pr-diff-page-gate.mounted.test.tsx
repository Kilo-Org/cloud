import { createElement } from 'react';
import { act } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { usePrDiffPageGate } from '@/lib/pr-review/diff/use-pr-diff-page-gate';
import { renderWithProviders } from '@/test/render-with-providers';
import { QueryClientProvider } from '@tanstack/react-query';

// The gate's consumer-visible contract: FlashList reports end-reached as soon
// as content fits the viewport, so an end-reach before the user drags is held,
// and the drag that opens the gate consumes it. The gate resets when the
// rendered PR's identity changes so a drag on the previous PR cannot load the
// next PR's pages.

// The gate reads only three fields of the query result, so the stub names
// those three and casts once at the hook boundary; the full result type stays
// TanStack's.
type QueryStub = {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
};

type GateResult = ReturnType<typeof usePrDiffPageGate>;

type GateHolder = { current: GateResult | null };

function GateProbe({
  identity,
  query,
  holder,
}: {
  identity: string;
  query: QueryStub;
  holder: GateHolder;
}) {
  holder.current = usePrDiffPageGate(
    query as unknown as Parameters<typeof usePrDiffPageGate>[0],
    identity
  );
  return null;
}

async function mountGate(identity: string, query: QueryStub) {
  const holder: GateHolder = { current: null };
  const { renderer, queryClient } = await renderWithProviders(
    createElement(GateProbe, { identity, query, holder })
  );
  // Rerenders for an identity change must keep the same root element type
  // (QueryClientProvider, as renderWithProviders mounted), or the swapped
  // root remounts the whole tree and every useRef resets — a vacuous pass.
  const rerender = (nextIdentity: string) => {
    act(() => {
      renderer.update(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(GateProbe, { identity: nextIdentity, query, holder })
        )
      );
    });
  };
  return { holder, rerender };
}

function gateOf(holder: GateHolder): GateResult {
  const gate = holder.current;
  if (!gate) {
    throw new Error('gate probe did not render');
  }
  return gate;
}

function queryStub(overrides: Partial<QueryStub> = {}): QueryStub {
  return {
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(async () => {
      await Promise.resolve();
    }),
    ...overrides,
  };
}

describe('usePrDiffPageGate hold-until-drag', () => {
  it('holds an end-reach that arrives before any drag', async () => {
    const query = queryStub();
    const { holder } = await mountGate('pr-1', query);

    act(() => {
      gateOf(holder).onEndReached();
    });

    expect(query.fetchNextPage).not.toHaveBeenCalled();
  });

  it('releases the held end-reach on the next drag, once', async () => {
    const query = queryStub();
    const { holder } = await mountGate('pr-1', query);

    act(() => {
      gateOf(holder).onEndReached();
    });
    // onDragStart is wired to both the scroll-begin and touch-move paths, so
    // one gesture can report it repeatedly; only the first consumes the hold.
    act(() => {
      gateOf(holder).onDragStart();
      gateOf(holder).onDragStart();
    });

    expect(query.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('never fetches from a drag alone', async () => {
    const query = queryStub();
    const { holder } = await mountGate('pr-1', query);

    act(() => {
      gateOf(holder).onDragStart();
    });

    expect(query.fetchNextPage).not.toHaveBeenCalled();
  });

  it('fetches directly on end-reach after the user has dragged', async () => {
    const query = queryStub();
    const { holder } = await mountGate('pr-1', query);

    act(() => {
      gateOf(holder).onDragStart();
    });
    act(() => {
      gateOf(holder).onEndReached();
    });

    expect(query.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('blocks the fetch when the query reports no next page or a running page fetch', async () => {
    const exhausted = queryStub({ hasNextPage: false });
    const { holder: exhaustedHolder } = await mountGate('pr-1', exhausted);
    act(() => {
      gateOf(exhaustedHolder).onDragStart();
    });
    act(() => {
      gateOf(exhaustedHolder).onEndReached();
    });
    expect(exhausted.fetchNextPage).not.toHaveBeenCalled();

    const busy = queryStub({ isFetchingNextPage: true });
    const { holder: busyHolder } = await mountGate('pr-1', busy);
    act(() => {
      gateOf(busyHolder).onDragStart();
    });
    act(() => {
      gateOf(busyHolder).onEndReached();
    });
    expect(busy.fetchNextPage).not.toHaveBeenCalled();
  });

  it('resets the gate when the PR identity changes', async () => {
    const query = queryStub();
    const { holder, rerender } = await mountGate('pr-1', query);

    // Case 1: the reader dragged the previous PR, then switched. The reset
    // must discard userDragged too, or the new PR's mount-time end-reach
    // fetches immediately.
    act(() => {
      gateOf(holder).onDragStart();
    });
    rerender('pr-2');
    act(() => {
      gateOf(holder).onEndReached();
    });
    expect(query.fetchNextPage).not.toHaveBeenCalled();
  });

  it('discards a held end-reach from the previous PR on identity change', async () => {
    const query = queryStub();
    const { holder, rerender } = await mountGate('pr-1', query);

    // Case 2: an end-reach arrived on the previous PR, then the reader
    // switched. A drag on the PR the reader left must not load the new one.
    act(() => {
      gateOf(holder).onEndReached();
    });
    rerender('pr-2');
    act(() => {
      gateOf(holder).onDragStart();
    });
    expect(query.fetchNextPage).not.toHaveBeenCalled();
  });

  it('treats the switched-in PR as a fresh gate: its end-reach is held until a drag', async () => {
    const query = queryStub();
    const { holder, rerender } = await mountGate('pr-1', query);

    act(() => {
      gateOf(holder).onEndReached();
    });
    rerender('pr-2');

    // The new PR's list reports its end before the reader drags (a
    // viewport-fitting first page does this at mount): held again.
    act(() => {
      gateOf(holder).onEndReached();
    });
    expect(query.fetchNextPage).not.toHaveBeenCalled();

    // Exactly one fetch: the drag consumed pr-2's hold, not pr-1's.
    act(() => {
      gateOf(holder).onDragStart();
    });
    expect(query.fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
