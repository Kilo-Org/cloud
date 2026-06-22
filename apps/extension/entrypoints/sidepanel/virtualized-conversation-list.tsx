import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, JSX, ReactNode, UIEvent } from 'react';
import type { GroupedConversationItem } from '@/src/shared/agent-conversation';
import { AgentConversationItemView } from './agent-conversation-events';

const estimatedItemHeight = 64;
const itemGap = 12;
const overscanPx = 320;

interface PositionedConversationItem {
  readonly item: GroupedConversationItem;
  readonly key: string;
  readonly size: number;
  readonly start: number;
}

const getConversationItemKey = (item: GroupedConversationItem): string =>
  item.type === 'event' ? item.event.id : item.toolCall.id;

const getMeasuredItemSize = (
  item: GroupedConversationItem,
  itemHeights: ReadonlyMap<string, number>
): number => itemHeights.get(getConversationItemKey(item)) ?? estimatedItemHeight;

const getPositionedItems = (
  items: GroupedConversationItem[],
  itemHeights: ReadonlyMap<string, number>
): {
  readonly contentHeight: number;
  readonly positionedItems: PositionedConversationItem[];
} => {
  let nextStart = 0;
  const positionedItems = items.map(item => {
    const key = getConversationItemKey(item);
    const size = getMeasuredItemSize(item, itemHeights);
    const positionedItem = { item, key, size, start: nextStart };

    nextStart += size + itemGap;

    return positionedItem;
  });

  return {
    contentHeight: Math.max(0, nextStart - itemGap),
    positionedItems,
  };
};

const VirtualizedRow = ({
  children,
  itemKey,
  offsetY,
  onSizeChange,
}: {
  children: ReactNode;
  itemKey: string;
  offsetY: number;
  onSizeChange: (itemKey: string, size: number) => void;
}): JSX.Element => {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const style = useMemo<CSSProperties>(
    () => ({
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
      transform: `translateY(${offsetY}px)`,
    }),
    [offsetY]
  );

  useEffect(() => {
    const row = rowRef.current;

    if (row === null) {
      return;
    }

    const reportSize = (): void => {
      onSizeChange(itemKey, row.getBoundingClientRect().height);
    };
    const resizeObserver = new ResizeObserver(reportSize);

    reportSize();
    resizeObserver.observe(row);

    return () => {
      resizeObserver.disconnect();
    };
  }, [itemKey, onSizeChange]);

  return (
    <div data-conversation-item ref={rowRef} style={style}>
      {children}
    </div>
  );
};

export const VirtualizedConversationList = ({
  items,
}: {
  items: GroupedConversationItem[];
}): JSX.Element => {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [itemHeights, setItemHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const { contentHeight, positionedItems } = useMemo(
    () => getPositionedItems(items, itemHeights),
    [itemHeights, items]
  );
  const effectiveViewportHeight = viewportHeight === 0 ? 600 : viewportHeight;
  const scrollHeight = Math.max(contentHeight, effectiveViewportHeight);
  const bottomOffset = Math.max(0, effectiveViewportHeight - contentHeight);
  const spacerStyle = useMemo<CSSProperties>(() => ({ height: scrollHeight }), [scrollHeight]);
  const visibleStart = Math.max(0, scrollTop - overscanPx);
  const visibleEnd = scrollTop + effectiveViewportHeight + overscanPx;
  const visibleItems = positionedItems.filter(
    item => item.start + item.size >= visibleStart && item.start <= visibleEnd
  );

  useEffect(() => {
    if (viewport === null) {
      return;
    }

    const updateViewportHeight = (): void => {
      setViewportHeight(viewport.clientHeight);
    };
    const resizeObserver = new ResizeObserver(updateViewportHeight);

    updateViewportHeight();
    resizeObserver.observe(viewport);

    return () => {
      resizeObserver.disconnect();
    };
  }, [viewport]);

  useEffect(() => {
    if (viewport === null) {
      return;
    }

    const frame = globalThis.requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
      setScrollTop(viewport.scrollTop);
    });

    return () => {
      globalThis.cancelAnimationFrame(frame);
    };
  }, [items.length, viewport]);

  const handleScroll = (event: UIEvent<HTMLElement>): void => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  const handleSizeChange = useCallback((itemKey: string, size: number): void => {
    setItemHeights(currentHeights => {
      if (currentHeights.get(itemKey) === size) {
        return currentHeights;
      }

      return new Map([...currentHeights, [itemKey, size]]);
    });
  }, []);

  return (
    <section
      aria-label="Agent conversation"
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      onScroll={handleScroll}
      ref={setViewport}
    >
      <div className="relative min-h-full" style={spacerStyle}>
        {visibleItems.map(item => (
          <VirtualizedRow
            itemKey={item.key}
            key={item.key}
            offsetY={bottomOffset + item.start}
            onSizeChange={handleSizeChange}
          >
            <AgentConversationItemView item={item.item} />
          </VirtualizedRow>
        ))}
      </div>
    </section>
  );
};
