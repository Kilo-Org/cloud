import type { JSX } from 'react';
import type { GroupedConversationItem } from '@/src/shared/agent-conversation';
import { AgentConversationItemView } from './agent-conversation-events';

const getConversationItemKey = (item: GroupedConversationItem): string =>
  item.type === 'event' ? item.event.id : item.toolCall.id;

export const ConversationList = ({ items }: { items: GroupedConversationItem[] }): JSX.Element => (
  <section
    aria-label="Agent conversation"
    className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
  >
    {items.map(item => (
      <AgentConversationItemView item={item} key={getConversationItemKey(item)} />
    ))}
  </section>
);
