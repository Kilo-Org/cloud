import { useEffect, useRef } from 'react';
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

export const ConversationList = ({ items }: { items: GroupedConversationItem[] }): JSX.Element => {
  const listRef = useRef<HTMLElement | null>(null);
  const scrollKey = getConversationScrollKey(items);
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => 88,
    getScrollElement: () => listRef.current,
    overscan: 8,
  });

  useEffect(() => {
    if (items.length > 0) {
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
      });
    }
  }, [items.length, scrollKey, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <section
      aria-label="Agent conversation"
      className="agent-conversation-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4"
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
  );
};
