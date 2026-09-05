import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { encryptedDatabase } from '@/lib/persist/encrypted-kv';
import { chatScope } from './scope';
import {
  type ChatPlace,
  type ChatState,
  enterChat,
  prepareChats,
  releaseChat,
  retryChat,
  say,
  snapshotOf,
  startChat,
  stopChat,
  watch,
  watchChats,
} from './registry';
import { type ChatSummary, deleteChat, listChats } from './store';

/**
 * The chat surface, as React sees it.
 *
 * The list is a query, because it is read from the database and refetched when
 * something changes it. One conversation is not: it is running in the registry
 * whether or not a screen is mounted, so a screen subscribes to it and draws
 * whatever it says.
 */

export function chatPlaceOf(
  userId: string | null | undefined,
  organizationId: string | null | undefined
): ChatPlace | null {
  if (userId === null || userId === undefined || userId === '') {
    return null;
  }
  return {
    chatScope: chatScope(userId, organizationId),
    org:
      organizationId === null || organizationId === undefined || organizationId === ''
        ? { kind: 'personal' }
        : { kind: 'organization', id: organizationId },
  };
}

const listKey = (scope: string) => ['chats', scope] as const;

/** The chat list, as a screen reads it. */
export type ChatList = {
  readonly chats: readonly ChatSummary[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly refetch: () => void;
  readonly remove: (sessionId: string) => Promise<void>;
};

export function useChatList(place: ChatPlace | null): ChatList {
  const scope = place?.chatScope ?? null;
  const client = useQueryClient();
  const query = useQuery({
    queryKey: listKey(scope ?? ''),
    enabled: place !== null,
    queryFn: async () => {
      if (place === null) {
        return [];
      }
      await prepareChats(place);
      return listChats(await encryptedDatabase(), place.chatScope);
    },
  });
  // A chat writes its turns when its answer ends, and the title of a row is the
  // first thing said in it. The list is read again whenever a chat starts or
  // stops working, whichever screen that happened on.
  useEffect(
    () =>
      watchChats(() => {
        void client.invalidateQueries({ queryKey: listKey(scope ?? '') });
      }),
    [client, scope]
  );

  const remove = useCallback(
    async (sessionId: string) => {
      await releaseChat(sessionId);
      deleteChat(await encryptedDatabase(), sessionId);
      await client.invalidateQueries({ queryKey: listKey(scope ?? '') });
    },
    [client, scope]
  );
  return {
    chats: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
    remove,
  };
}

/**
 * One conversation.
 *
 * `sessionId` is state rather than a prop straight from the route, because
 * switching models moves the conversation onto a new session and the screen
 * has to follow it.
 */
/** One conversation, as a screen reads it. */
export type OpenChat = {
  readonly state: ChatState;
  readonly send: (text: string, model: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly retry: () => Promise<void>;
};

export function useChat(place: ChatPlace | null, opened: string): OpenChat {
  const [sessionId, setSessionId] = useState(opened);

  useEffect(() => {
    if (place !== null) {
      void enterChat(place, sessionId);
    }
  }, [place, sessionId]);

  const state = useSyncExternalStore(
    useCallback(listener => watch(sessionId, listener), [sessionId]),
    useCallback(() => snapshotOf(sessionId), [sessionId])
  );

  return {
    state,
    send: async (text, model) => {
      setSessionId(await say(sessionId, text, model));
    },
    stop: async () => {
      await stopChat(sessionId);
    },
    retry: async () => {
      setSessionId(await retryChat(sessionId));
    },
  };
}

/** Starts a chat and answers with the session to open. */
export { startChat as newChat };
