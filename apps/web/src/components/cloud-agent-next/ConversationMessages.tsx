'use client';

import { memo } from 'react';
import type { MessageDeliveryState, PreparationAttempt } from '@kilocode/cloud-agent-sdk';
import type { OpenChildSession } from './ChildSessionSection';
import { MessageBubble } from './MessageBubble';
import { MessageErrorBoundary } from './MessageErrorBoundary';
import { PreparationRow } from './PreparationRow';
import { groupConversationMessages } from './message-presentation';
import { isMessageStreaming, type StoredMessage } from './types';

type ConversationMessageGroupProps = {
  messages: StoredMessage[];
  isStreaming: boolean;
  deliveryState?: MessageDeliveryState;
  preparations?: readonly PreparationAttempt[];
  getChildMessages?: (sessionId: string) => StoredMessage[];
  onOpenChildSession?: OpenChildSession;
  onOpenPreparationDetails: (attemptId: string) => void;
};

const ConversationMessageGroup = memo(
  function ConversationMessageGroup({
    messages,
    isStreaming,
    deliveryState,
    preparations,
    getChildMessages,
    onOpenChildSession,
    onOpenPreparationDetails,
  }: ConversationMessageGroupProps) {
    const first = messages[0];
    if (!first) return null;

    const displayMessage =
      messages.length === 1
        ? first
        : { info: first.info, parts: messages.flatMap(message => message.parts) };

    return (
      <MessageErrorBoundary>
        <MessageBubble
          message={displayMessage}
          isStreaming={isStreaming}
          deliveryState={deliveryState}
          getChildMessages={getChildMessages}
          onOpenChildSession={onOpenChildSession}
        />
        {preparations?.map(attempt => (
          <PreparationRow
            key={attempt.id}
            attempt={attempt}
            onOpenDetails={onOpenPreparationDetails}
          />
        ))}
      </MessageErrorBoundary>
    );
  },
  (previous, next) =>
    previous.isStreaming === next.isStreaming &&
    previous.deliveryState === next.deliveryState &&
    previous.preparations === next.preparations &&
    previous.getChildMessages === next.getChildMessages &&
    previous.onOpenChildSession === next.onOpenChildSession &&
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
  preparationByMessageId: ReadonlyMap<string, readonly PreparationAttempt[]>;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  onOpenChildSession?: OpenChildSession;
  onOpenPreparationDetails: (attemptId: string) => void;
};

export const ConversationMessages = memo(
  function ConversationMessages({
    isStreaming,
    staticMessages,
    dynamicMessages,
    pendingMessages,
    preparationByMessageId,
    getChildMessages,
    onOpenChildSession,
    onOpenPreparationDetails,
  }: ConversationMessagesProps) {
    const groups = groupConversationMessages(
      [...staticMessages, ...dynamicMessages],
      preparationByMessageId
    );

    return groups.map(messages => {
      const first = messages[0];
      const last = messages.at(-1);
      if (!first || !last) return null;

      return (
        <ConversationMessageGroup
          key={first.info.id}
          messages={messages}
          isStreaming={isStreaming && isMessageStreaming(last)}
          deliveryState={pendingMessages.get(first.info.id)}
          preparations={preparationByMessageId.get(first.info.id)}
          getChildMessages={getChildMessages}
          onOpenChildSession={onOpenChildSession}
          onOpenPreparationDetails={onOpenPreparationDetails}
        />
      );
    });
  },
  (previous, next) => !previous.active && !next.active
);
