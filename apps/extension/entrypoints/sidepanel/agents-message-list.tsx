import { useMemo } from 'react';
import type { JSX } from 'react';
import type { StoredMessage } from '@kilocode/cloud-agent-sdk';
import {
  getStreamingTextPartId,
  shouldShowWorkingIndicator,
  toAgentConversationItems,
} from './agents-conversation-adapter';
import { ConversationList } from './conversation-list';

const WorkingIndicatorRow = (): JSX.Element => (
  <div className="flex justify-start">
    <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-foreground-muted">
      <span className="inline-block size-1.5 animate-pulse rounded-full bg-foreground-muted" />
      Working…
    </div>
  </div>
);

export const AgentsMessageList = ({
  messages,
  isStreaming = false,
}: {
  messages: StoredMessage[];
  isStreaming?: boolean;
}): JSX.Element => {
  const items = useMemo(() => toAgentConversationItems(messages), [messages]);
  const streamingMessageId = useMemo(() => getStreamingTextPartId(messages), [messages]);
  const showWorking = shouldShowWorkingIndicator(isStreaming, messages);

  if (items.length === 0 && !showWorking) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-6">
        <p className="type-body text-foreground-muted">No messages yet</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {items.length === 0 ? null : (
        <ConversationList items={items} streamingMessageId={streamingMessageId} />
      )}
      {showWorking ? <WorkingIndicatorRow /> : null}
    </div>
  );
};
