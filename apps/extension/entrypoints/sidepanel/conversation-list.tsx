import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import type { GroupedConversationItem } from '@/src/shared/agent-conversation';
import { AgentConversationItemView } from './agent-conversation-events';

const getConversationItemKey = (item: GroupedConversationItem): string =>
  item.type === 'event' ? item.event.id : item.toolCall.id;

export const ConversationList = ({ items }: { items: GroupedConversationItem[] }): JSX.Element => {
  const listRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const list = listRef.current;

    if (list !== null) {
      list.scrollTop = list.scrollHeight;
    }
  }, [items.length]);

  return (
    <section
      aria-label="Agent conversation"
      className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
      ref={listRef}
    >
      {items.map(item => (
        <AgentConversationItemView item={item} key={getConversationItemKey(item)} />
      ))}
    </section>
  );
};
