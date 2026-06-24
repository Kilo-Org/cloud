import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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

export const ConversationList = ({ items }: { items: GroupedConversationItem[] }): JSX.Element => {
  const listRef = useRef<HTMLElement | null>(null);
  const isAutoScrollEnabledRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const [isAutoScrollEnabled, setIsAutoScrollEnabledState] = useState(true);
  const scrollKey = getConversationScrollKey(items);
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => 88,
    getScrollElement: () => listRef.current,
    overscan: 8,
  });

  const setIsAutoScrollEnabled = useCallback((isEnabled: boolean): void => {
    isAutoScrollEnabledRef.current = isEnabled;
    setIsAutoScrollEnabledState(isEnabled);
  }, []);

  const markProgrammaticScroll = useCallback((): void => {
    if (programmaticScrollFrameRef.current !== null) {
      cancelAnimationFrame(programmaticScrollFrameRef.current);
    }

    isProgrammaticScrollRef.current = true;
    programmaticScrollFrameRef.current = requestAnimationFrame(() => {
      programmaticScrollFrameRef.current = requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false;
        programmaticScrollFrameRef.current = null;
      });
    });
  }, []);

  const scrollToLatest = useCallback((): void => {
    if (items.length === 0) {
      return;
    }

    const scrollToLastMeasuredRow = (): void => {
      markProgrammaticScroll();
      virtualizer.scrollToIndex(items.length - 1, { align: 'end' });

      const scrollElement = listRef.current;

      if (scrollElement !== null) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    };
    const scheduleScrollToLastMeasuredRow = (): void => {
      if (isAutoScrollEnabledRef.current) {
        scrollToLastMeasuredRow();
      }
    };

    scrollToLastMeasuredRow();
    requestAnimationFrame(() => {
      scheduleScrollToLastMeasuredRow();
      requestAnimationFrame(scheduleScrollToLastMeasuredRow);
    });
  }, [items.length, markProgrammaticScroll, virtualizer]);

  useEffect(
    () => () => {
      if (programmaticScrollFrameRef.current !== null) {
        cancelAnimationFrame(programmaticScrollFrameRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (items.length > 0) {
      requestAnimationFrame(() => {
        if (isAutoScrollEnabledRef.current) {
          scrollToLatest();
        }
      });
    }
  }, [items.length, scrollKey, scrollToLatest]);

  const jumpToLatest = (): void => {
    setIsAutoScrollEnabled(true);
    requestAnimationFrame(scrollToLatest);
  };
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="relative min-h-0 flex-1">
      <section
        aria-label="Agent conversation"
        className="agent-conversation-scrollbar h-full overflow-y-auto px-4 py-4"
        onScroll={event => {
          if (!isProgrammaticScrollRef.current) {
            setIsAutoScrollEnabled(isScrolledToBottom(event.currentTarget));
          }
        }}
        ref={listRef}
      >
        <div className="relative w-full" style={getListSpacerStyle(virtualizer.getTotalSize())}>
          {virtualItems.map(virtualItem => {
            const item = items[virtualItem.index];

            if (item === undefined) {
              return null;
            }

            return (
              <div
                className="absolute left-0 top-0 w-full pb-3"
                data-index={virtualItem.index}
                key={getConversationItemKey(item)}
                ref={virtualizer.measureElement}
                style={getVirtualRowStyle(virtualItem.start)}
              >
                <AgentConversationItemView item={item} />
              </div>
            );
          })}
        </div>
      </section>
      {isAutoScrollEnabled ? null : (
        <button
          aria-label="Jump to latest"
          className="absolute bottom-3 right-3 z-10 flex size-9 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950 text-zinc-100 shadow-lg shadow-zinc-950/60 outline-none transition hover:border-[#EDFF00] hover:text-[#EDFF00] focus:ring-2 focus:ring-[#EDFF00]/50"
          onClick={jumpToLatest}
          type="button"
        >
          <ArrowDown aria-hidden="true" className="size-4" />
        </button>
      )}
    </div>
  );
};
