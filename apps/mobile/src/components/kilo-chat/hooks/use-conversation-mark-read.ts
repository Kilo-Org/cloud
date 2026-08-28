import { type KiloChatClient, type KiloChatOperation, type Message } from '@kilocode/kilo-chat';
import {
  attemptMarkCurrentConversationRead,
  clearMarkReadRetry,
  createMarkReadRetryState,
  createMarkReadState,
  latestMarkReadMessageId,
} from '@kilocode/kilo-chat-hooks';
import { useCallback, useEffect, useRef } from 'react';

import { subscribeAuthenticatedOwner } from '@/lib/context-scope';
import { subscribeLocalAccess } from '@/lib/local-access';
import { useAppActiveAndFocused } from './use-app-active-and-focused';
import { useMarkRead } from './use-mark-read';
import { shouldMarkLatestMessageRead } from '../message-history-state';

type Params = {
  client: KiloChatClient;
  conversationId: string;
  currentUserId: string | null;
  hasInitialMessages: boolean;
  messages: readonly Message[];
  sandboxId: string;
};

export function useConversationMarkRead({
  client,
  conversationId,
  currentUserId,
  hasInitialMessages,
  messages,
  sandboxId,
}: Params) {
  const latestMessageId = latestMarkReadMessageId(messages);
  const latestSenderId = messages.find(message => message.id === latestMessageId)?.senderId ?? null;
  const activeAndFocused = useAppActiveAndFocused();
  const markRead = useMarkRead(client);
  const markReadStateRef = useRef(createMarkReadState());
  const markReadRetryStateRef = useRef(createMarkReadRetryState());
  const currentMarker = latestMessageId === null ? null : `${conversationId}:${latestMessageId}`;
  const currentMarkerRef = useRef(currentMarker);
  const activeAndFocusedRef = useRef(activeAndFocused);
  const operationRef = useRef<KiloChatOperation | null>(null);
  currentMarkerRef.current = currentMarker;
  activeAndFocusedRef.current = activeAndFocused;

  const markCurrentConversationRead = useCallback(() => {
    if (
      !hasInitialMessages ||
      latestMessageId === null ||
      currentMarker === null ||
      !activeAndFocusedRef.current ||
      !shouldMarkLatestMessageRead({
        currentUserId,
        latestMessageSenderId: latestSenderId,
      })
    ) {
      return;
    }
    // A rerender cannot replace the closure behind an already scheduled retry.
    if (markReadRetryStateRef.current.marker === currentMarker) {
      return;
    }
    let operation: KiloChatOperation | undefined = undefined;
    try {
      operation = client.captureOperation();
    } catch {
      return;
    }
    operationRef.current = operation;
    const retryState = markReadRetryStateRef.current;
    const isActive = () => {
      try {
        operation.assertDispatch();
        return activeAndFocusedRef.current;
      } catch {
        clearMarkReadRetry(retryState);
        return false;
      }
    };
    const attempt = () => {
      if (!isActive()) {
        return;
      }
      void attemptMarkCurrentConversationRead({
        marker: currentMarker,
        markReadState: markReadStateRef.current,
        retryState,
        currentMarker: () => currentMarkerRef.current,
        isActive,
        markRead: async () => {
          await markRead(sandboxId, conversationId, latestMessageId, operation);
        },
        retry: attempt,
      });
    };
    attempt();
  }, [
    client,
    conversationId,
    currentMarker,
    currentUserId,
    hasInitialMessages,
    latestMessageId,
    latestSenderId,
    markRead,
    sandboxId,
  ]);

  useEffect(() => {
    if (
      !activeAndFocused ||
      currentMarker === null ||
      (markReadRetryStateRef.current.marker !== null &&
        markReadRetryStateRef.current.marker !== currentMarker)
    ) {
      clearMarkReadRetry(markReadRetryStateRef.current);
    }
  }, [activeAndFocused, currentMarker]);

  useEffect(() => {
    const retryState = markReadRetryStateRef.current;
    const cancelInvalidRetry = () => {
      try {
        operationRef.current?.assertDispatch();
      } catch {
        clearMarkReadRetry(retryState);
      }
    };
    const offAccess = subscribeLocalAccess(cancelInvalidRetry);
    const offOwner = subscribeAuthenticatedOwner(cancelInvalidRetry);
    return () => {
      offAccess();
      offOwner();
      clearMarkReadRetry(retryState);
    };
  }, []);

  useEffect(() => {
    if (activeAndFocused) {
      markCurrentConversationRead();
    }
  }, [activeAndFocused, markCurrentConversationRead]);
}
