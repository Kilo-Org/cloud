import React from 'react';
import type { ComponentProps } from 'react';
import { CloudChatRuntimeProvider } from './CloudChatRuntimeProvider';
import { CloudThread } from './CloudThread';
import { fixtureAssistant } from './__fixtures__/transcript';
import type { StoredMessage, Part } from '../types';
import type {
  MessageDeliveryState,
  PreparationAttempt,
  SessionCommit,
} from '@kilocode/cloud-agent-sdk';
const noSend = async () => {};
export function ConversationMessages({
  staticMessages,
  dynamicMessages,
  isStreaming = false,
  pendingMessages,
  sendingMessageIds,
  preparationByMessageId,
  commitsAfterMessage,
  ...props
}: {
  staticMessages: StoredMessage[];
  dynamicMessages: StoredMessage[];
  isStreaming?: boolean;
  active?: boolean;
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>;
  sendingMessageIds?: ReadonlySet<string>;
  preparationByMessageId: ReadonlyMap<string, readonly PreparationAttempt[]>;
  commitsAfterMessage?: ReadonlyMap<string, readonly SessionCommit[]>;
} & ComponentProps<typeof CloudThread>) {
  return (
    <CloudChatRuntimeProvider
      projection={{
        messages: [...staticMessages, ...dynamicMessages],
        isStreaming,
        pendingMessages,
        sendingMessageIds,
        preparationByMessageId,
        commitsAfterMessage,
      }}
      state={{
        isLoading: false,
        isRunning: isStreaming,
        isReadOnly: false,
        isSendDisabled: false,
        canInterrupt: false,
      }}
      onNew={noSend}
    >
      <CloudThread {...props} />
    </CloudChatRuntimeProvider>
  );
}
export function MessageBubble({
  message,
  displayTimestamp,
  isStreaming = false,
  deliveryState,
  isSending,
  ...props
}: {
  message: StoredMessage;
  displayTimestamp?: number;
  isStreaming?: boolean;
  deliveryState?: MessageDeliveryState;
  isSending?: boolean;
} & ComponentProps<typeof CloudThread>) {
  const source =
    displayTimestamp === undefined
      ? message
      : {
          ...message,
          info: { ...message.info, time: { ...message.info.time, created: displayTimestamp } },
        };
  return (
    <ConversationMessages
      staticMessages={[source]}
      dynamicMessages={[]}
      isStreaming={isStreaming}
      pendingMessages={deliveryState ? new Map([[message.info.id, deliveryState]]) : new Map()}
      sendingMessageIds={isSending ? new Set([message.info.id]) : undefined}
      preparationByMessageId={new Map()}
      {...props}
    />
  );
}
export function PartRenderer({
  part,
  isStreaming = false,
  ...props
}: { part: Part; isStreaming?: boolean } & ComponentProps<typeof CloudThread>) {
  return (
    <MessageBubble
      message={fixtureAssistant(part.messageID, [part])}
      isStreaming={isStreaming}
      {...props}
    />
  );
}
