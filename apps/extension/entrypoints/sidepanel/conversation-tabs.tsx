import type { JSX } from 'react';
import { useAtomValue } from 'jotai';
import { compactingConversationIdsAtom, runningConversationIdsAtom } from './agent-chat-atoms';
import { getStoredConversationTitle } from './agent-conversation-storage';
import type { StoredAgentConversation } from './agent-conversation-storage';

export const ConversationTabs = ({
  activeConversationId,
  conversations,
  isDisabled,
  onCloseConversation,
  onCreateConversation,
  onSelectConversation,
}: {
  activeConversationId: string;
  conversations: StoredAgentConversation[];
  isDisabled: boolean;
  onCloseConversation: (conversationId: string) => void;
  onCreateConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
}): JSX.Element => {
  const runningConversationIds = useAtomValue(runningConversationIdsAtom);
  const compactingConversationIds = useAtomValue(compactingConversationIdsAtom);

  return (
    <div className="border-b border-border bg-surface-raised">
      <div
        aria-label="Conversation tabs"
        className="agent-conversation-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto px-2 py-2"
        role="tablist"
      >
        {conversations.map(conversation => {
          const title = getStoredConversationTitle(conversation);
          const isActive = conversation.id === activeConversationId;
          const isRunning =
            runningConversationIds.includes(conversation.id) ||
            compactingConversationIds.includes(conversation.id);

          return (
            <div
              className={
                isActive
                  ? 'flex h-8 max-w-44 shrink-0 items-center rounded-md border border-border-strong bg-surface-selected text-foreground'
                  : 'flex h-8 max-w-44 shrink-0 items-center rounded-md border border-border text-foreground-muted hover:border-border-strong hover:text-foreground'
              }
              key={conversation.id}
            >
              <button
                aria-selected={isActive}
                className="flex h-full min-w-0 items-center gap-1.5 px-2 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:text-foreground-subtle"
                disabled={isDisabled}
                onClick={() => {
                  onSelectConversation(conversation.id);
                }}
                role="tab"
                title={title}
                type="button"
              >
                {isRunning ? (
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 animate-pulse rounded-full bg-status-blue-400"
                  />
                ) : null}
                <span className="truncate">{title}</span>
              </button>
              <button
                aria-label={`Close ${title}`}
                className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-foreground-muted outline-none transition hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
                disabled={isDisabled}
                onClick={() => {
                  onCloseConversation(conversation.id);
                }}
                type="button"
              >
                <span aria-hidden="true" className="text-sm leading-none">
                  x
                </span>
              </button>
            </div>
          );
        })}
        <button
          aria-label="New conversation"
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-overlay text-foreground-on-secondary outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:text-foreground-subtle"
          disabled={isDisabled}
          onClick={onCreateConversation}
          type="button"
        >
          <span aria-hidden="true" className="text-lg leading-none">
            +
          </span>
        </button>
      </div>
    </div>
  );
};
