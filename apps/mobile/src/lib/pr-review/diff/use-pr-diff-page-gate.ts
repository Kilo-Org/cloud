import { useCallback, useRef } from 'react';

import { type usePrReviewFileListQuery } from '@/lib/pr-review/diff/pr-review-file-list-state';

type FileListQuery = ReturnType<typeof usePrReviewFileListQuery>['query'];

type PageGate = { userDragged: boolean; heldEndReach: boolean };

function freshPageGate(): PageGate {
  return { userDragged: false, heldEndReach: false };
}

/**
 * The pagination gate for the diff file list. FlashList reports the end as
 * reached as soon as its content fits the viewport, so a first page shorter
 * than the screen used to be replaced by the next pages before the
 * partial-load row (`prReview.hunkRows.loadedOfTotalFiles`, "1 of 5 files
 * loaded") and its Load all action could be read. The user's own drag is the
 * gate: the row is the resting state until then, and a programmatic scroll
 * (scroll-to-file) pulls nothing.
 *
 * A viewport-fitting first page also reaches the end once, at mount, and
 * FlashList does not report it again until the data changes, so the drag that
 * opens the gate would have nothing left to let through: hold that report in
 * `heldEndReach` and load it on the drag.
 *
 * The drag cannot be read from `onScrollBeginDrag` alone: that event only
 * fires when a scroll begins, and a page that fits the viewport has nothing
 * to scroll, so a reader dragging the resting pane never opened the gate (the
 * android round read "1 of 2 files loaded" after swipe and adb drags, and the
 * stub served no page 2). `onDragStart` is therefore wired to the list's
 * `onTouchMove` too — the finger's own movement, which a viewport-fitting
 * list still reports — and both paths are idempotent: they only consume the
 * held end report once.
 *
 * `identity` is the rendered PR's provider ref key. The list can be handed a
 * different PR while it stays mounted, and a drag on the PR the reader left
 * must not open the next PR's gate before its partial-load row can rest, so
 * the gate is reset during render when the identity changes. Resetting here,
 * not in an effect, means the new list's first end report — a child effect or
 * layout callback that runs before the parent's effects — already sees a
 * closed gate.
 */
export function usePrDiffPageGate(query: FileListQuery, identity: string) {
  const gate = useRef<PageGate>(freshPageGate());

  const identityRef = useRef(identity);
  if (identityRef.current !== identity) {
    identityRef.current = identity;
    gate.current = freshPageGate();
  }

  // Hold the query in a ref so the handlers stay stable across renders; React
  // Query hands back a fresh result object each render, and a handler closed
  // over the mount render's snapshot would read `hasNextPage: false` forever
  // (the same pattern as `useFetchToCompletion`).
  const queryRef = useRef(query);
  queryRef.current = query;

  const loadNextPage = useCallback(() => {
    if (queryRef.current.hasNextPage && !queryRef.current.isFetchingNextPage) {
      void queryRef.current.fetchNextPage();
    }
  }, []);

  const onDragStart = useCallback(() => {
    gate.current.userDragged = true;
    if (gate.current.heldEndReach) {
      gate.current.heldEndReach = false;
      loadNextPage();
    }
  }, [loadNextPage]);

  const onEndReached = useCallback(() => {
    if (!gate.current.userDragged) {
      gate.current.heldEndReach = true;
      return;
    }
    loadNextPage();
  }, [loadNextPage]);

  return { onDragStart, onEndReached };
}
