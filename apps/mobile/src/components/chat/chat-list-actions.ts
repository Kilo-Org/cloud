import { type TFunction } from 'i18next';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner-native';

import { type ChatPlace } from '@/lib/chat/scope';
import {
  deleteEverywhere,
  deleteServerSession,
  importServerSession,
} from '@/lib/chat/sync/sync-service';
import { type MergedChatRow } from '@/lib/chat/sync/sync-list';
import { newChat } from '@/lib/chat/use-chat';

/**
 * What the chat list does to a row: start a chat, open one, delete one, and
 * rename one. The screen draws the rows; every write lives here, so the list
 * body stays a body.
 */

/** What the list screen hands its rows and its corner button. */
export type ChatListActions = {
  readonly starting: boolean;
  readonly start: () => void;
  readonly open: (key: string) => void;
  readonly drop: (key: string) => void;
  readonly renameRow: (key: string, title: string) => Promise<void>;
};

export function useChatListActions(input: {
  readonly place: ChatPlace | null;
  readonly enabled: boolean;
  readonly rowsByKey: ReadonlyMap<string, MergedChatRow>;
  readonly selectedModel: string | undefined;
  readonly t: TFunction;
  /** Opens a chat that now exists, by its harness session id. */
  readonly openChat: (sessionId: string) => void;
  readonly refetchList: () => void;
  readonly refetchMerged: () => void;
  readonly remove: (sessionId: string) => Promise<void>;
  readonly rename: (sessionId: string, title: string) => Promise<void>;
}): ChatListActions {
  const { place, enabled, rowsByKey, selectedModel, t, openChat } = input;
  const { refetchList, refetchMerged, remove, rename } = input;

  /* Starting a chat discovers the Kilo MCP server before the session opens, and
     a slow or offline one takes up to four seconds to give up. The button says
     it is working for that whole time, so a tap never reads as one that was
     ignored — and the second tap a silent wait invites cannot open a second
     chat. The ref is the guard, not the state: two presses in one frame both
     read the state as it was before the first one re-rendered. */
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);

  const start = useCallback(() => {
    if (startingRef.current) {
      return;
    }
    const model = selectedModel;
    if (place === null || model === undefined) {
      return;
    }
    startingRef.current = true;
    setStarting(true);
    void (async () => {
      try {
        const sessionId = await newChat(place, {
          model,
          effort: null,
        });
        // Whatever the last attempt failed with is moot once a chat starts.
        toast.dismiss('chat-start-failed');
        openChat(sessionId);
      } catch (error) {
        /* Starting the chat or opening its session failed. Saying nothing would
           read as a button that does not work, and a toast that dismissed itself
           four seconds later was missed by whoever looked away. The reason stays
           until it is dismissed, at the top so it never covers the tab bar. */
        toast.error(error instanceof Error ? error.message : t('common.somethingWentWrong'), {
          id: 'chat-start-failed',
          position: 'top-center',
          duration: Infinity,
          closeButton: true,
        });
      } finally {
        startingRef.current = false;
        setStarting(false);
      }
    })();
  }, [openChat, place, selectedModel, t]);

  const open = useCallback(
    (key: string) => {
      const row = rowsByKey.get(key);
      if (row === undefined) {
        return;
      }
      if (row.localSessionId !== null) {
        openChat(row.localSessionId);
        return;
      }
      if (place === null || row.serverSessionId === null) {
        return;
      }
      const serverSessionId = row.serverSessionId;
      void (async () => {
        const sessionId = await importServerSession(place, serverSessionId, selectedModel ?? '');
        if (sessionId !== null) {
          refetchList();
          openChat(sessionId);
        } else {
          toast.error(t('modelChat.sync.deletedElsewhere'), { position: 'top-center' });
          refetchMerged();
        }
      })();
    },
    [openChat, place, refetchList, refetchMerged, rowsByKey, selectedModel, t]
  );

  const drop = useCallback(
    (key: string) => {
      const row = rowsByKey.get(key);
      if (row === undefined) {
        return;
      }
      void (async () => {
        if (enabled && place !== null && row.serverSessionId !== null) {
          const localSessionId = row.localSessionId;
          await (localSessionId !== null
            ? deleteEverywhere(place, localSessionId)
            : deleteServerSession(place, row.serverSessionId));
          refetchList();
          refetchMerged();
          return;
        }
        if (row.localSessionId !== null) {
          await remove(row.localSessionId);
        }
      })();
    },
    [enabled, place, refetchList, refetchMerged, remove, rowsByKey]
  );

  const renameRow = useCallback(
    async (key: string, title: string) => {
      const row = rowsByKey.get(key);
      if (row === undefined) {
        return;
      }
      if (row.localSessionId !== null) {
        await rename(row.localSessionId, title);
        return;
      }
      if (place === null || row.serverSessionId === null) {
        return;
      }
      const sessionId = await importServerSession(place, row.serverSessionId, selectedModel ?? '');
      if (sessionId !== null) {
        await rename(sessionId, title);
        refetchList();
        refetchMerged();
      }
    },
    [place, refetchList, refetchMerged, rename, rowsByKey, selectedModel]
  );

  return { starting, start, open, drop, renameRow };
}
