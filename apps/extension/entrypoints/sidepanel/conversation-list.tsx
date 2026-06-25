import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { getConversationScrollKey } from '@/src/shared/agent-conversation';
import type { GroupedConversationItem } from '@/src/shared/agent-conversation';
import { AgentConversationItemView } from './agent-conversation-events';

const getConversationItemKey = (item: GroupedConversationItem): string =>
  item.type === 'event' ? item.event.id : item.toolCall.id;
const getListSpacerStyle = (height: number): CSSProperties => ({
  height: `${height}px`,
});
const getVirtualRowStyle = (start: number): CSSProperties => ({
  transform: `translateY(${start}px)`,
});
const isScrolledToBottom = (element: HTMLElement): boolean =>
  element.scrollTop + element.clientHeight >= element.scrollHeight - 16;
const isScrollable = (element: HTMLElement): boolean => element.scrollHeight > element.clientHeight;

const ConversationVirtualRow = ({
  index,
  item,
  measureElement,
  start,
}: {
  index: number;
  item: GroupedConversationItem;
  measureElement: (element: HTMLElement) => void;
  start: number;
}): JSX.Element => {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;

    if (row === null) {
      return;
    }

    measureElement(row);

    const observer = new ResizeObserver(() => {
      measureElement(row);
    });

    observer.observe(row);

    return () => {
      observer.disconnect();
    };
  }, [measureElement]);

  return (
    <div
      className="absolute left-0 top-0 w-full pb-2"
      data-index={index}
      key={getConversationItemKey(item)}
      ref={rowRef}
      style={getVirtualRowStyle(start)}
    >
      <AgentConversationItemView item={item} />
    </div>
  );
};

export const ConversationList = ({ items }: { items: GroupedConversationItem[] }): JSX.Element => {
  const listRef = useRef<HTMLElement | null>(null);
  // Source of truth for auto-scroll, owned outside React so a streaming render cannot race it. The state mirror below only drives the jump button.
  const isStuckToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastPinnedTopRef = useRef(0);
  const pinFrameRef = useRef<number | null>(null);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const scrollKey = getConversationScrollKey(items);
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => 52,
    getScrollElement: () => listRef.current,
    overscan: 8,
  });
  const totalSize = virtualizer.getTotalSize();

  const cancelPin = useCallback((): void => {
    if (pinFrameRef.current !== null) {
      cancelAnimationFrame(pinFrameRef.current);
      pinFrameRef.current = null;
    }
  }, []);

  // Drive the scroll to the bottom directly on the DOM node across a few frames so late virtualizer row measurements cannot leave us short. Every pass re-checks the stuck flag, so a user scroll-up that flips it stops the chain immediately.
  const pinToBottom = useCallback((): void => {
    cancelPin();

    const runPass = (remainingPasses: number): void => {
      const element = listRef.current;

      if (element === null || !isStuckToBottomRef.current || items.length === 0) {
        pinFrameRef.current = null;
        return;
      }

      virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
      element.scrollTop = element.scrollHeight;
      lastPinnedTopRef.current = element.scrollTop;
      lastScrollTopRef.current = element.scrollTop;

      if (remainingPasses > 0) {
        pinFrameRef.current = requestAnimationFrame(() => {
          runPass(remainingPasses - 1);
        });
        return;
      }

      pinFrameRef.current = null;
    };

    runPass(5);
  }, [cancelPin, items.length, virtualizer]);

  const releaseToManualScroll = useCallback((): void => {
    if (!isStuckToBottomRef.current) {
      return;
    }

    isStuckToBottomRef.current = false;
    cancelPin();
    setShowJumpButton(true);
  }, [cancelPin]);

  const followBottomAgain = useCallback((): void => {
    if (isStuckToBottomRef.current) {
      return;
    }

    isStuckToBottomRef.current = true;
    setShowJumpButton(false);
  }, []);

  // Bind scroll detection straight to the DOM node so upward intent is seen on the input event itself, before any in-flight pin can write the position back to the bottom.
  useEffect(() => {
    const element = listRef.current;

    if (element === null) {
      return;
    }

    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0 && isScrollable(element)) {
        releaseToManualScroll();
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      const isUpwardKey = event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home';

      if (isUpwardKey && isScrollable(element)) {
        releaseToManualScroll();
      }
    };
    let touchStartY = 0;
    const handleTouchStart = (event: TouchEvent): void => {
      touchStartY = event.touches[0]?.clientY ?? 0;
    };
    const handleTouchMove = (event: TouchEvent): void => {
      const currentY = event.touches[0]?.clientY ?? 0;

      // A downward finger drag scrolls the content upward.
      if (currentY > touchStartY + 2 && isScrollable(element)) {
        releaseToManualScroll();
      }
    };
    const handleScroll = (): void => {
      const currentTop = element.scrollTop;
      const previousTop = lastScrollTopRef.current;
      lastScrollTopRef.current = currentTop;

      // Backstop for gestures with no input event of their own, such as dragging the scrollbar: any move above the last pinned position is the user leaving the bottom. Re-arming is left to the jump button.
      if (
        currentTop < previousTop - 1 &&
        currentTop < lastPinnedTopRef.current - 1 &&
        !isScrolledToBottom(element)
      ) {
        releaseToManualScroll();
      }
    };

    element.addEventListener('wheel', handleWheel, { passive: true });
    element.addEventListener('keydown', handleKeyDown);
    element.addEventListener('touchstart', handleTouchStart, { passive: true });
    element.addEventListener('touchmove', handleTouchMove, { passive: true });
    element.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      element.removeEventListener('wheel', handleWheel);
      element.removeEventListener('keydown', handleKeyDown);
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('touchmove', handleTouchMove);
      element.removeEventListener('scroll', handleScroll);
    };
  }, [releaseToManualScroll]);

  useEffect(() => cancelPin, [cancelPin]);

  useLayoutEffect(() => {
    if (items.length > 0 && isStuckToBottomRef.current) {
      pinToBottom();
    }
  }, [items.length, pinToBottom, scrollKey, totalSize]);

  const jumpToLatest = (): void => {
    followBottomAgain();
    pinToBottom();
  };
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="relative min-h-0 flex-1">
      <section
        aria-label="Agent conversation"
        className="agent-conversation-scrollbar h-full overflow-y-auto px-4 py-4"
        ref={listRef}
      >
        <div className="relative w-full" style={getListSpacerStyle(totalSize)}>
          {virtualItems.map(virtualItem => {
            const item = items[virtualItem.index];

            if (item === undefined) {
              return null;
            }

            return (
              <ConversationVirtualRow
                index={virtualItem.index}
                item={item}
                key={getConversationItemKey(item)}
                measureElement={virtualizer.measureElement}
                start={virtualItem.start}
              />
            );
          })}
        </div>
      </section>
      {showJumpButton ? (
        <button
          aria-label="Jump to latest"
          className="absolute bottom-3 right-3 z-10 flex size-9 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950 text-zinc-100 shadow-lg shadow-zinc-950/60 outline-none transition hover:border-[#EDFF00] hover:text-[#EDFF00] focus:ring-2 focus:ring-[#EDFF00]/50"
          onClick={jumpToLatest}
          type="button"
        >
          <ArrowDown aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  );
};
