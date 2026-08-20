/* eslint-disable max-lines */
import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import { elementScroll, useVirtualizer } from '@tanstack/react-virtual';
import { getConversationScrollKey } from '@/src/shared/agent-conversation';
import type { GroupedConversationItem } from '@/src/shared/agent-conversation';
import { LEGACY_CONVERSATION_GREETING } from '@/src/shared/agent-conversation-tabs';
import { AgentConversationItemView } from './agent-conversation-events';

/**
 * Distance from the end that still counts as "at the bottom". Mobile uses the
 * same 100px band (`use-session-auto-scroll-state.ts`). It must stay well above
 * the corrections the virtualizer applies when a row's real height replaces the
 * estimate, otherwise its own scroll writes read as the user leaving the bottom.
 */
const AT_BOTTOM_THRESHOLD_PX = 100;

// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type
type ScrollPosition = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

/** What a scroll position means for auto-scroll. Pure, so it is unit tested. */
export type ConversationScrollDecision = 'follow' | 'keep' | 'release';

export const isAtConversationBottom = (position: ScrollPosition): boolean =>
  position.scrollTop + position.clientHeight >= position.scrollHeight - AT_BOTTOM_THRESHOLD_PX;

/*
 * A scroll event carries no gesture, so user intent is decided by who wrote the
 * offset, not by how far it moved. `lastPinnedTop` is the offset our own pin
 * wrote, so a position away from the bottom that still equals it is content
 * growing below us; any other position away from the bottom is someone else
 * moving the list, which is the user leaving. Inside the bottom band nothing is
 * released, so the virtualizer's own end-anchoring writes stay harmless.
 */
export const decideConversationScroll = ({
  lastPinnedTop,
  position,
  sawDownwardIntent,
}: {
  lastPinnedTop: number;
  position: ScrollPosition;
  sawDownwardIntent: boolean;
}): ConversationScrollDecision => {
  if (isAtConversationBottom(position)) {
    return sawDownwardIntent ? 'follow' : 'keep';
  }

  return Math.abs(position.scrollTop - lastPinnedTop) > 1 ? 'release' : 'keep';
};

// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type
type ConversationEnds = { firstKey: string; lastKey: string };

/*
 * The list stays mounted while the panel swaps conversations, so a released pin
 * must not leak into the next one. Loading older messages keeps the last item,
 * a new message keeps the first: only another conversation replaces both ends.
 */
export const isDifferentConversation = (
  previous: ConversationEnds,
  next: ConversationEnds
): boolean => previous.firstKey !== next.firstKey && previous.lastKey !== next.lastKey;

const getConversationItemKey = (item: GroupedConversationItem): string =>
  item.type === 'event' ? item.event.id : item.toolCall.id;
const getListSpacerStyle = (height: number): CSSProperties => ({
  height: `${height}px`,
});
const getVirtualRowStyle = (start: number): CSSProperties => ({
  transform: `translateY(${start}px)`,
});
const readScrollPosition = (element: HTMLElement): ScrollPosition => ({
  clientHeight: element.clientHeight,
  scrollHeight: element.scrollHeight,
  scrollTop: element.scrollTop,
});
const isScrollable = (element: HTMLElement): boolean => element.scrollHeight > element.clientHeight;
const getConversationEnds = (items: GroupedConversationItem[]): ConversationEnds | null => {
  const [first] = items;
  const last = items.at(-1);

  return first === undefined || last === undefined
    ? null
    : { firstKey: getConversationItemKey(first), lastKey: getConversationItemKey(last) };
};

const ConversationVirtualRow = ({
  index,
  item,
  measureElement,
  start,
  streamingMessageId,
}: {
  index: number;
  item: GroupedConversationItem;
  measureElement: (element: HTMLElement) => void;
  start: number;
  streamingMessageId?: string | undefined;
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
      <AgentConversationItemView item={item} streamingMessageId={streamingMessageId} />
    </div>
  );
};

export const ConversationList = ({
  items,
  streamingMessageId,
}: {
  items: GroupedConversationItem[];
  streamingMessageId?: string | undefined;
}): JSX.Element => {
  const listRef = useRef<HTMLElement | null>(null);
  // Source of truth for auto-scroll, owned outside React so a streaming render cannot race it. The state mirror below only drives the jump button.
  const isStuckToBottomRef = useRef(true);
  const lastPinnedTopRef = useRef(0);
  /* A pin that follows a deliberate re-arm (mount, jump button, conversation swap,
     downward gesture) starts from wherever the user is, so it skips the guard once. */
  const forcePinRef = useRef(true);
  const conversationEndsRef = useRef<ConversationEnds | null>(null);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const scrollKey = getConversationScrollKey(items);
  /*
   * Deliberately no `anchorTo: 'end'`: `pinToBottom` below re-glues the end off
   * the live DOM offset on every measurement, so a second end-anchor would only
   * add a writer that works from a stale offset (see `scrollToFn`).
   */
  const virtualizer = useVirtualizer({
    count: items.length,
    /*
     * Recorded deviation: measured collapsed row heights are 42-46px, but pinning
     * the estimate into that band destabilized the scroll-pin E2E on the CI browser
     * (wheel-up poll timeouts at 44/46/48). The pre-existing 52 stays; measureElement
     * reconciles real rows regardless.
     */
    estimateSize: () => 52,
    getScrollElement: () => listRef.current,
    overscan: 8,
    /*
     * Every virtualizer scroll write is a measurement correction computed from
     * the offset it last *observed*. That lags the DOM by a frame, because the
     * only thing that tells it about a move is the scroll event: a scrollbar
     * drag lands, the correction fires in the same frame, and the drag is undone
     * before any code can read it. Drop a correction whose starting offset is no
     * longer the live one — it is stale by definition, and the pin below re-glues
     * the bottom from the live DOM anyway. A correction that does agree with the
     * DOM still runs, so a row measured above a reader scrolled up keeps their
     * view in place.
     */
    scrollToFn: (offset, scrollOptions, instance) => {
      const element = listRef.current;

      if (element !== null && Math.abs(offset - element.scrollTop) > 1) {
        return;
      }

      elementScroll(offset, scrollOptions, instance);
    },
  });
  const totalSize = virtualizer.getTotalSize();

  const releaseToManualScroll = useCallback((): void => {
    if (!isStuckToBottomRef.current) {
      return;
    }

    isStuckToBottomRef.current = false;
    setShowJumpButton(true);
  }, []);

  const followBottomAgain = useCallback((): void => {
    if (isStuckToBottomRef.current) {
      return;
    }

    isStuckToBottomRef.current = true;
    forcePinRef.current = true;
    setShowJumpButton(false);
  }, []);

  /*
   * One write against the live DOM, which already accounts for the list padding
   * the virtualizer knows nothing about. Convergence is measurement-driven, not
   * frame-budgeted: every row measurement changes `totalSize` and re-runs the
   * effect below, and `anchorTo: 'end'` holds the end in between. Deliberately
   * not `scrollToIndex`, whose reconcile loop keeps re-targeting the end for
   * seconds and drags a reader who scrolls up back down.
   *
   * The same decision runs here, not only in the scroll handler: this pin fires
   * from a layout effect, before the browser can deliver the scroll event for a
   * scrollbar drag, and a drag plus this write inside one frame coalesce into a
   * single event that reports our offset. Sampling the live offset is the only
   * place that upward drag is still visible.
   */
  const pinToBottom = useCallback((): void => {
    const element = listRef.current;

    if (element === null) {
      return;
    }

    const decision = decideConversationScroll({
      lastPinnedTop: lastPinnedTopRef.current,
      position: readScrollPosition(element),
      sawDownwardIntent: false,
    });

    if (!forcePinRef.current && decision === 'release') {
      releaseToManualScroll();
      return;
    }

    forcePinRef.current = false;
    element.scrollTop = element.scrollHeight;
    lastPinnedTopRef.current = element.scrollTop;
  }, [releaseToManualScroll]);

  // Bind scroll detection straight to the DOM node so upward intent is seen on the input event itself, before any in-flight pin can write the position back to the bottom.
  useEffect(() => {
    const element = listRef.current;

    if (element === null) {
      return;
    }

    /*
     * A downward user gesture arms a re-follow: handleScroll completes it once
     * that gesture actually reaches the bottom. Requiring recorded intent is
     * what stops a programmatic scroll that lands at the bottom from re-arming
     * on its own.
     */
    let sawDownwardIntent = false;
    const handleWheel = (event: WheelEvent): void => {
      if (!isScrollable(element)) {
        return;
      }

      if (event.deltaY < 0) {
        releaseToManualScroll();
      } else if (event.deltaY > 0) {
        sawDownwardIntent = true;
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isScrollable(element)) {
        return;
      }

      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
        releaseToManualScroll();
      } else if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End') {
        sawDownwardIntent = true;
      }
    };
    let touchStartY = 0;
    const handleTouchStart = (event: TouchEvent): void => {
      touchStartY = event.touches[0]?.clientY ?? 0;
    };
    const handleTouchMove = (event: TouchEvent): void => {
      const currentY = event.touches[0]?.clientY ?? 0;

      if (!isScrollable(element)) {
        return;
      }

      // A downward finger drag scrolls the content upward, an upward drag downward.
      if (currentY > touchStartY + 2) {
        releaseToManualScroll();
      } else if (currentY < touchStartY - 2) {
        sawDownwardIntent = true;
      }
    };
    // Backstop for gestures with no input event of their own, such as dragging the scrollbar.
    const handleScroll = (): void => {
      const position = readScrollPosition(element);
      const decision = decideConversationScroll({
        lastPinnedTop: lastPinnedTopRef.current,
        position,
        sawDownwardIntent,
      });

      if (decision === 'release') {
        sawDownwardIntent = false;
        releaseToManualScroll();
        return;
      }

      // Reset the pin baseline to this bottom so the next content-growth pin does not read a stale-high lastPinned and mistake the growth gap for a scroll-up.
      if (decision === 'follow') {
        sawDownwardIntent = false;
        lastPinnedTopRef.current = position.scrollTop;
        followBottomAgain();
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
  }, [followBottomAgain, releaseToManualScroll]);

  // Registered before the pin effect so a conversation swap re-arms following in the same commit that pins it.
  useLayoutEffect(() => {
    const ends = getConversationEnds(items);

    if (ends === null) {
      return;
    }

    const previous = conversationEndsRef.current;
    conversationEndsRef.current = ends;

    if (previous !== null && isDifferentConversation(previous, ends)) {
      followBottomAgain();
    }
  }, [followBottomAgain, items]);

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
        {items.length === 0 ? (
          <p className="type-body text-foreground-muted">{LEGACY_CONVERSATION_GREETING}</p>
        ) : null}
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
                streamingMessageId={streamingMessageId}
              />
            );
          })}
        </div>
      </section>
      {showJumpButton ? (
        <button
          aria-label="Jump to latest"
          className="absolute bottom-3 right-3 z-10 flex size-9 items-center justify-center rounded-full border border-border bg-surface-overlay text-foreground shadow-lg shadow-black/50 outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
          onClick={jumpToLatest}
          type="button"
        >
          <ArrowDown aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  );
};
