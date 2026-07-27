import { type FlashListRef } from '@shopify/flash-list';
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';

import {
  armInitialTopScroll,
  INITIAL_TOP_SCROLL_IDLE,
  type InitialTopScrollState,
  onInitialTopScrollContentSize,
} from '@/lib/pr-review/diff/initial-top-scroll';
import { fileHeaderKey, type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import {
  cancelPendingScroll,
  decideOnItemsChange,
  decideOnScrollRequest,
  type PendingScrollState,
} from '@/lib/pr-review/diff/pending-scroll-request';
import {
  type FileNavigatorRequest,
  subscribeFileNavigatorRequest,
} from '@/lib/pr-review/file-navigator-bridge';

type UsePrDiffListScrollInput = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** Number of real files behind the list; arms the one-shot top scroll. */
  readonly filesLength: number;
  readonly items: ListItem[];
  readonly listRef: RefObject<FlashListRef<ListItem> | null>;
  readonly setExpanded: Dispatch<SetStateAction<Record<string, boolean>>>;
};

/**
 * Scroll behavior for the PR diff file list: the one-shot scroll-to-top after
 * first content layout, and the resilient navigator scroll-to-file that parks
 * when the target key is not yet in the list, retries on items change,
 * supersedes on a newer request, and cancels on unmount.
 */
export function usePrDiffListScroll({
  owner,
  repo,
  number,
  filesLength,
  items,
  listRef,
  setExpanded,
}: UsePrDiffListScrollInput) {
  const indexByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item) {
        map.set(item.key, index);
      }
    }
    return map;
  }, [items]);
  const indexByKeyRef = useRef(indexByKey);
  indexByKeyRef.current = indexByKey;

  // AC4 / D7: one-shot scroll-to-top after first real content lays out.
  // Arm synchronously on first files.length > 0 (cold + warm-cache remount);
  // fire from onContentSizeChange only — never in useEffect, which races
  // FlashList's first layout and blanks the window until the user scrolls.
  // Page appends cannot re-arm once done.
  const initialTopScrollRef = useRef<InitialTopScrollState>(INITIAL_TOP_SCROLL_IDLE);
  initialTopScrollRef.current = armInitialTopScroll(initialTopScrollRef.current, filesLength);

  const handleContentSizeChange = (_width: number, height: number) => {
    const result = onInitialTopScrollContentSize(initialTopScrollRef.current, height);
    initialTopScrollRef.current = result.state;
    if (result.shouldScroll) {
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
    }
  };

  // AC4b / D7: resilient navigator scroll — park when key is absent from
  // indexByKey (items rebuild race), retry on next items change, supersede
  // on a newer request, cancel on unmount.
  const pendingScrollRef = useRef<PendingScrollState>(null);

  const applyScrollDecision = useCallback(
    (decision: ReturnType<typeof decideOnScrollRequest>) => {
      pendingScrollRef.current = decision.pending;
      if (decision.index === null) {
        return;
      }
      void listRef.current?.scrollToIndex({
        index: decision.index,
        animated: true,
        viewPosition: 0,
      });
    },
    [listRef]
  );

  useEffect(() => {
    const unsubscribe = subscribeFileNavigatorRequest(
      { owner, repo, number },
      (request: FileNavigatorRequest) => {
        const targetKey = fileHeaderKey(request.path);
        const decision = decideOnScrollRequest(
          pendingScrollRef.current,
          targetKey,
          indexByKeyRef.current
        );
        // Expand as soon as we accept the request so the file is open once
        // the list can scroll to it (including the deferred/pending path).
        setExpanded(prev => (prev[request.path] ? prev : { ...prev, [request.path]: true }));
        applyScrollDecision(decision);
      }
    );
    return () => {
      unsubscribe();
      pendingScrollRef.current = cancelPendingScroll();
    };
  }, [owner, repo, number, setExpanded, applyScrollDecision]);

  useEffect(() => {
    const decision = decideOnItemsChange(pendingScrollRef.current, indexByKey);
    applyScrollDecision(decision);
  }, [indexByKey, applyScrollDecision]);

  return { handleContentSizeChange };
}
