import { type KiloChatClient, type Message } from '@kilocode/kilo-chat';
import {
  attemptMarkCurrentConversationRead,
  clearMarkReadRetry,
  createMarkReadRetryState,
  createMarkReadState,
  latestMarkReadMessageId,
} from '@kilocode/kilo-chat-hooks';
import { useCallback, useEffect, useRef } from 'react';

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
  const latestMarkReadMessageSenderId =
    latestMessageId === null
      ? null
      : (messages.find(message => message.id === latestMessageId)?.senderId ?? null);
  const activeAndFocused = useAppActiveAndFocused();
  const markRead = useMarkRead(client);
  const markReadStateRef = useRef(createMarkReadState());
  const markReadRetryStateRef = useRef(createMarkReadRetryState());
  const currentMarkReadMarker =
    latestMessageId === null ? null : `${conversationId}:${latestMessageId}`;
  const currentMarkReadMarkerRef = useRef<string | null>(currentMarkReadMarker);
  const activeAndFocusedRef = useRef(activeAndFocused);
  const markCurrentConversationReadRef = useRef<(() => void) | null>(null);
  currentMarkReadMarkerRef.current = currentMarkReadMarker;
  activeAndFocusedRef.current = activeAndFocused;

  const markCurrentConversationRead = useCallback(() => {
    if (!hasInitialMessages || latestMessageId === null || currentMarkReadMarker === null) {
      return;
    }
    if (
      !shouldMarkLatestMessageRead({
        currentUserId,
        latestMessageSenderId: latestMarkReadMessageSenderId,
      })
    ) {
      return;
    }
    const marker = currentMarkReadMarker;
    void attemptMarkCurrentConversationRead({
      marker,
      markReadState: markReadStateRef.current,
      retryState: markReadRetryStateRef.current,
      currentMarker: () => currentMarkReadMarkerRef.current,
      isActive: () => activeAndFocusedRef.current,
      markRead: async () => {
        await markRead(sandboxId, conversationId, latestMessageId);
      },
      retry: () => {
        markCurrentConversationReadRef.current?.();
      },
    });
  }, [
    conversationId,
    currentMarkReadMarker,
    currentUserId,
    hasInitialMessages,
    latestMessageId,
    latestMarkReadMessageSenderId,
    markRead,
    sandboxId,
  ]);
  markCurrentConversationReadRef.current = markCurrentConversationRead;

  useEffect(() => {
    if (!activeAndFocused || currentMarkReadMarker === null) {
      clearMarkReadRetry(markReadRetryStateRef.current);
      return;
    }
    if (
      markReadRetryStateRef.current.marker !== null &&
      markReadRetryStateRef.current.marker !== currentMarkReadMarker
    ) {
      clearMarkReadRetry(markReadRetryStateRef.current);
    }
  }, [activeAndFocused, currentMarkReadMarker]);

  useEffect(() => {
    const retryState = markReadRetryStateRef.current;
    return () => {
      clearMarkReadRetry(retryState);
    };
  }, []);

  useEffect(() => {
    if (!activeAndFocused) {
      return;
    }
    markCurrentConversationRead();
  }, [activeAndFocused, markCurrentConversationRead]);
}
