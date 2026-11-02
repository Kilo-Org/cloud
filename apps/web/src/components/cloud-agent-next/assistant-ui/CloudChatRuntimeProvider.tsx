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
  active?: boolean;
  projection: CloudProjectionInput;
  state: CloudThreadState;
  onNew: (message: AppendMessage) => Promise<void>;
  onCancel?: () => Promise<void>;
  children: ReactNode;
};

export function CloudChatRuntimeProvider({
  active = true,
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
      active
        ? project({
            messages,
            messageGroups,
            isStreaming,
            pendingMessages,
            sendingMessageIds,
            preparationByMessageId,
            commitsAfterMessage,
          }).map(row => row.message)
        : null,
    [
      active,
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
  // Keep mounted transcript rows stable while other workspace tabs are active.
  const [lastVisibleMessages, setLastVisibleMessages] = useState(projectedMessages ?? []);
  if (projectedMessages !== null && projectedMessages !== lastVisibleMessages) {
    setLastVisibleMessages(projectedMessages);
  }
  const { canCancel, ...gates } = cloudRuntimeGates(state);
  const runtime = useExternalStoreRuntime({
    ...gates,
    messages: projectedMessages ?? lastVisibleMessages,
    convertMessage,
    onNew,
    ...(canCancel && onCancel ? { onCancel } : {}),
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
