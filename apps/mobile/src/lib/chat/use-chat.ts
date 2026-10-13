import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { type LocalImage } from '@/lib/agent-attachments/local-image';
import { getAuthenticatedOwner, subscribeAuthenticatedOwner } from '@/lib/context-scope';
import { useRestoredAccountId } from '@/lib/hooks/use-restored-account-id';
import { useOrganization } from '@/lib/organization-context';
import { encryptedDatabase } from '@/lib/persist/encrypted-kv';
import { type ChatPlace, chatPlaceOf } from './scope';
import {
  enterChat,
  prepareChats,
  releaseChat,
  retryChat,
  say,
  startChat,
  stopChat,
} from './registry';
import { type ChatState, snapshotOf, watch, watchChats } from './state';
import { forgetAsked, titledByAsked } from './pending';
import { type ChatSummary, deleteChat, listChats, renameChat } from './store';

/**
 * The chat surface, as React sees it.
 *
 * The list is a query, because it is read from the database and refetched when
 * something changes it. One conversation is not: it is running in the registry
 * whether or not a screen is mounted, so a screen subscribes to it and draws
 * whatever it says.
 */

/**
 * Where the signed-in account's chats live.
 *
 * A chat is on the device, so it must open when the account cannot be
 * confirmed: offline, or with the API down. The restored account answers then,
 * the same one the app shell opened on.
 */
export function useChatPlace(): ChatPlace | null {
  const { organizationId } = useOrganization();
  const owner = useSyncExternalStore(subscribeAuthenticatedOwner, getAuthenticatedOwner);
  const userId = useRestoredAccountId(owner.authEpoch, owner.restored);
  return chatPlaceOf(userId, organizationId);
}

const listKey = (scope: string) => ['chats', scope] as const;

/** The chat list, as a screen reads it. */
export type ChatList = {
  readonly chats: readonly ChatSummary[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly refetch: () => void;
  readonly remove: (sessionId: string) => Promise<void>;
  readonly rename: (sessionId: string, title: string) => Promise<void>;
};

export function useChatList(place: ChatPlace | null): ChatList {
  const scope = place?.chatScope ?? null;
  const client = useQueryClient();
  const query = useQuery({
    queryKey: listKey(scope ?? ''),
    enabled: place !== null,
    // The list is read from the device's database, so no connection is needed.
    networkMode: 'always',
    queryFn: async () => {
      if (place === null) {
        return [];
      }
      await prepareChats(place);
      return titledByAsked(listChats(await encryptedDatabase(), place.chatScope));
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
      const current = snapshotOf(sessionId).sessionId;
      await releaseChat(current);
      await forgetAsked(current);
      deleteChat(await encryptedDatabase(), current);
      await client.invalidateQueries({ queryKey: listKey(scope ?? '') });
    },
    [client, scope]
  );
  const rename = useCallback(
    async (sessionId: string, title: string) => {
      renameChat(await encryptedDatabase(), snapshotOf(sessionId).sessionId, title);
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
    rename,
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
  readonly send: (text: string, model: string, images?: readonly LocalImage[]) => Promise<void>;
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

  // Switching models clones the conversation onto a new session, and the screen
  // has to follow it. It is not always this screen that asks: a question typed
  // on another model while an answer was arriving moves the chat when it is
  // finally asked. The state says where it went, so the screen reads that
  // rather than every mover having to hand the identifier back.
  const moved = state.sessionId;
  useEffect(() => {
    setSessionId(moved);
  }, [moved]);

  return {
    state,
    send: async (text, model, images = []) => {
      await say(sessionId, { text, images }, model);
    },
    stop: async () => {
      await stopChat(sessionId);
    },
    retry: async () => {
      // A chat whose open failed is not held: entering it again is the retry.
      // Entering an open chat does nothing, so the order is safe either way.
      if (place !== null) {
        await enterChat(place, sessionId);
      }
      await retryChat(sessionId);
    },
  };
}

/**
 * Whether a chat is answering right now.
 *
 * A row in the list shows the same live mark a running session does, and the
 * answer it is waiting on may have been asked on another screen, so the row
 * reads the registry rather than the database.
 */
export function useChatStatus(sessionId: string): ChatState['status'] {
  return useSyncExternalStore(
    useCallback(listener => watch(sessionId, listener), [sessionId]),
    useCallback(() => snapshotOf(sessionId).status, [sessionId])
  );
}

/** Starts a chat and answers with the session to open. */
export { startChat as newChat };
