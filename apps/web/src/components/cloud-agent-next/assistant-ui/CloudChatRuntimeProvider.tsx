'use client';
import React from 'react';

import { useMemo, useState, type ReactNode } from 'react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { createCloudMessageProjector } from './message-projection';
import {
  cloudRuntimeGates,
  type CloudProjectionInput,
  type CloudThreadState,
} from './presentation-types';

const convertMessage = (message: ThreadMessageLike): ThreadMessageLike => message;

type CloudChatRuntimeProviderProps = {
  projection: CloudProjectionInput;
  state: CloudThreadState;
  onNew: (message: AppendMessage) => Promise<void>;
  onCancel?: () => Promise<void>;
  children: ReactNode;
};

export function CloudChatRuntimeProvider({
  projection,
  state,
  onNew,
  onCancel,
  children,
}: CloudChatRuntimeProviderProps) {
  const [project] = useState(createCloudMessageProjector);
  const {
    messages,
    messageGroups,
    isStreaming,
    pendingMessages,
    sendingMessageIds,
    preparationByMessageId,
    commitsAfterMessage,
  } = projection;
  const projectedMessages = useMemo(
    () =>
      project({
        messages,
        messageGroups,
        isStreaming,
        pendingMessages,
        sendingMessageIds,
        preparationByMessageId,
        commitsAfterMessage,
      }).map(row => row.message),
    [
      project,
      messages,
      messageGroups,
      isStreaming,
      pendingMessages,
      sendingMessageIds,
      preparationByMessageId,
      commitsAfterMessage,
    ]
  );
  const { canCancel, ...gates } = cloudRuntimeGates(state);
  const runtime = useExternalStoreRuntime({
    ...gates,
    messages: projectedMessages,
    convertMessage,
    onNew,
    ...(canCancel && onCancel ? { onCancel } : {}),
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
