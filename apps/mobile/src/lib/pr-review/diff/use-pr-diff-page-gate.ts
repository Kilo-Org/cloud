import { useCallback, useRef } from 'react';

import { type usePrReviewFileListQuery } from '@/lib/pr-review/diff/pr-review-file-list-state';

type FileListQuery = ReturnType<typeof usePrReviewFileListQuery>['query'];

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
 */
export function usePrDiffPageGate(query: FileListQuery) {
  const gate = useRef({ userDragged: false, heldEndReach: false });

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

  const onScrollBeginDrag = useCallback(() => {
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

  return { onScrollBeginDrag, onEndReached };
}
