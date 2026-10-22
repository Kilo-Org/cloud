'use client';

import { memo } from 'react';
import type {
  MessageDeliveryState,
  PreparationAttempt,
  SessionCommit,
} from '@kilocode/cloud-agent-sdk';
import type { OpenChildSession } from './ChildSessionSection';
import { MessageBubble } from './MessageBubble';
import { MessageErrorBoundary } from './MessageErrorBoundary';
import { PreparationRow } from './PreparationRow';
import { groupConversationMessages } from './message-presentation';
import { CommitCard } from './CommitCard';
import { isMessageStreaming, isUserMessage, type StoredMessage } from './types';

const emptyCommitAnchors: ReadonlyMap<string, readonly SessionCommit[]> = new Map();
const emptySendingMessageIds: ReadonlySet<string> = new Set();

type ConversationMessageGroupProps = {
  messages: StoredMessage[];
  isStreaming: boolean;
  deliveryState?: MessageDeliveryState;
  isSending?: boolean;
  preparations?: readonly PreparationAttempt[];
  commits?: readonly SessionCommit[];
  getChildMessages?: (sessionId: string) => StoredMessage[];
  onOpenChildSession?: OpenChildSession;
  onRetryMessage?: (message: StoredMessage) => void;
  retryTargetMessage?: StoredMessage;
  onCopyToComposer?: (text: string) => void;
  onOpenPreparationDetails: (attemptId: string) => void;
};

const ConversationMessageGroup = memo(
  function ConversationMessageGroup({
    messages,
    isStreaming,
    deliveryState,
    isSending,
    preparations,
    commits,
    getChildMessages,
    onOpenChildSession,
    onRetryMessage,
    retryTargetMessage,
    onCopyToComposer,
    onOpenPreparationDetails,
  }: ConversationMessageGroupProps) {
    const first = messages[0];
    const last = messages.at(-1);
    if (!first || !last) return null;

    const displayMessage =
      messages.length === 1
        ? first
        : { info: first.info, parts: messages.flatMap(message => message.parts) };

    return (
      <MessageErrorBoundary>
        <MessageBubble
          message={displayMessage}
          displayTimestamp={last.info.time.created}
          isStreaming={isStreaming}
          deliveryState={deliveryState}
          isSending={isSending}
          getChildMessages={getChildMessages}
          onOpenChildSession={onOpenChildSession}
          onRetryMessage={onRetryMessage}
          retryTargetMessage={retryTargetMessage}
          onCopyToComposer={onCopyToComposer}
        />
        {preparations?.map(attempt => (
          <PreparationRow
            key={attempt.id}
            attempt={attempt}
            onOpenDetails={onOpenPreparationDetails}
          />
        ))}
        {commits?.map(commit => (
          <CommitCard key={commit.commitHash} commit={commit} />
        ))}
      </MessageErrorBoundary>
    );
  },
  (previous, next) =>
    previous.isStreaming === next.isStreaming &&
    previous.deliveryState === next.deliveryState &&
    previous.isSending === next.isSending &&
    previous.preparations === next.preparations &&
    previous.commits === next.commits &&
    previous.onOpenChildSession === next.onOpenChildSession &&
    previous.onRetryMessage === next.onRetryMessage &&
    previous.retryTargetMessage === next.retryTargetMessage &&
    previous.onCopyToComposer === next.onCopyToComposer &&
    previous.onOpenPreparationDetails === next.onOpenPreparationDetails &&
    previous.messages.length === next.messages.length &&
    previous.messages.every((message, index) => message === next.messages[index])
);

type ConversationMessagesProps = {
  active: boolean;
  isStreaming: boolean;
  staticMessages: StoredMessage[];
  dynamicMessages: StoredMessage[];
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>;
  sendingMessageIds?: ReadonlySet<string>;
  preparationByMessageId: ReadonlyMap<string, readonly PreparationAttempt[]>;
  commitsAfterMessage?: ReadonlyMap<string, readonly SessionCommit[]>;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  onOpenChildSession?: OpenChildSession;
  onRetryMessage?: (message: StoredMessage) => void;
  onCopyToComposer?: (text: string) => void;
  onOpenPreparationDetails: (attemptId: string) => void;
};

export const ConversationMessages = memo(
  function ConversationMessages({
    isStreaming,
    staticMessages,
    dynamicMessages,
    pendingMessages,
    sendingMessageIds = emptySendingMessageIds,
    preparationByMessageId,
    commitsAfterMessage = emptyCommitAnchors,
    getChildMessages,
    onOpenChildSession,
    onRetryMessage,
    onCopyToComposer,
    onOpenPreparationDetails,
  }: ConversationMessagesProps) {
    const messages = [...staticMessages, ...dynamicMessages];
    const groups = groupConversationMessages(messages, preparationByMessageId, commitsAfterMessage);

    let lastUserMessage: StoredMessage | undefined;
    return groups.map(messages => {
      const first = messages[0];
      const last = messages.at(-1);
      if (!first || !last) return null;
      const retryTargetMessage = isUserMessage(first.info) ? first : lastUserMessage;
      if (isUserMessage(last.info)) {
        lastUserMessage = last;
      }

      return (
        <ConversationMessageGroup
          key={first.info.id}
          messages={messages}
          isStreaming={isStreaming && isMessageStreaming(last)}
          deliveryState={pendingMessages.get(first.info.id)}
          isSending={sendingMessageIds.has(first.info.id)}
          preparations={preparationByMessageId.get(first.info.id)}
          commits={commitsAfterMessage.get(last.info.id)}
          getChildMessages={getChildMessages}
          onOpenChildSession={onOpenChildSession}
          onRetryMessage={onRetryMessage}
          retryTargetMessage={retryTargetMessage}
          onCopyToComposer={onCopyToComposer}
          onOpenPreparationDetails={onOpenPreparationDetails}
        />
      );
    });
  },
  (previous, next) => {
    if (!previous.active && !next.active) return true;
    return (
      previous.active === next.active &&
      previous.isStreaming === next.isStreaming &&
      previous.staticMessages === next.staticMessages &&
      previous.dynamicMessages === next.dynamicMessages &&
      previous.pendingMessages === next.pendingMessages &&
      previous.sendingMessageIds === next.sendingMessageIds &&
      previous.preparationByMessageId === next.preparationByMessageId &&
      previous.commitsAfterMessage === next.commitsAfterMessage &&
      previous.onOpenChildSession === next.onOpenChildSession &&
      previous.onRetryMessage === next.onRetryMessage &&
      previous.onCopyToComposer === next.onCopyToComposer &&
      previous.onOpenPreparationDetails === next.onOpenPreparationDetails
    );
  }
);
