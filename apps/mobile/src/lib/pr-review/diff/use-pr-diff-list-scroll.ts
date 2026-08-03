import { type FlashListRef } from '@shopify/flash-list';
import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef } from 'react';

import { fileHeaderKey, type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import { subscribeFileNavigatorRequest } from '@/lib/pr-review/file-navigator-bridge';

type UsePrDiffListScrollInput = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly items: ListItem[];
  readonly listRef: RefObject<FlashListRef<ListItem> | null>;
  readonly setExpanded: Dispatch<SetStateAction<Record<string, boolean>>>;
};

/**
 * Scrolls the diff list to the file the navigator sheet picked. The navigator
 * reads the same query cache as the list and `buildItems` emits a header row
 * for every file, so the target row already exists when the request arrives.
 */
export function usePrDiffListScroll({
  owner,
  repo,
  number,
  items,
  listRef,
  setExpanded,
}: UsePrDiffListScrollInput) {
  // `items` is read through a ref so a rebuild never re-subscribes and never
  // re-fires a scroll: a programmatic scroll landing mid-drag fights the user.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(
    () =>
      subscribeFileNavigatorRequest({ owner, repo, number }, request => {
        const targetKey = fileHeaderKey(request.path);
        const index = itemsRef.current.findIndex(item => item.key === targetKey);
        if (index === -1) {
          return;
        }
        const target = itemsRef.current[index];
        // A file with no renderable diff has a disabled chevron, so force-expanding
        // it from the navigator would leave a second row the user cannot close.
        if (target?.kind === 'file-header' && target.hasDiff) {
          setExpanded(prev => (prev[request.path] ? prev : { ...prev, [request.path]: true }));
        }
        void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 });
      }),
    [owner, repo, number, setExpanded, listRef]
  );
}
