import { useCallback, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import {
  ensureRemoteMcp,
  type RemoteMcpServerState,
  remoteMcpState,
  subscribeRemoteMcp,
} from './remote-mcp';
import {
  addRemoteMcpServer,
  deleteRemoteMcpServer,
  getRemoteMcpServersHasLoaded,
  listRemoteMcpServers,
  type RemoteMcpServerDraft,
  setRemoteMcpServerEnabled,
  type StoredRemoteMcpServer,
  subscribeRemoteMcpServers,
  updateRemoteMcpServer,
} from './remote-mcp-store';
import { refreshChatTools } from './registry';
import { type ChatPlace } from './scope';

/**
 * The remote MCP servers a person added, as a screen writes them.
 *
 * The list is the app's own store and the discovery is the module's, so this
 * hook subscribes to both rather than copying either: a server an agent adds,
 * or a discovery that lands while the sheet is open, redraws whoever reads it.
 *
 * Every write goes through the one store, then tells the registry so an open
 * chat moves onto the tools the change names. A write that fails leaves the
 * store as it was and says why; the caller is told whether it landed.
 */

/** What the sheet reads and writes. */
export type RemoteMcpServers = {
  /** The stored servers, in the order they were added. */
  readonly servers: readonly StoredRemoteMcpServer[];
  /** Whether the stored list has been read, so an empty list means none. */
  readonly loaded: boolean;
  /** What each enabled server answered, joined by id. */
  readonly discovered: readonly RemoteMcpServerState[];
  /** The servers whose Retry is in flight, so their buttons show it is working. */
  readonly retryingIds: readonly string[];
  readonly setEnabled: (id: string, next: boolean) => void;
  /** Asks one failed server again, with the longer deadline a Retry gets. */
  readonly retryServer: (id: string) => void;
  readonly addServer: (draft: RemoteMcpServerDraft) => Promise<boolean>;
  readonly updateServer: (id: string, draft: RemoteMcpServerDraft) => Promise<boolean>;
  readonly deleteServer: (id: string) => Promise<boolean>;
  /** A write is in flight, so a form's Save shows it is working. */
  readonly saving: boolean;
};

export function useRemoteMcpServers(place: ChatPlace | null): RemoteMcpServers {
  const { t } = useTranslation();
  const servers = useSyncExternalStore(subscribeRemoteMcpServers, listRemoteMcpServers);
  const loaded = useSyncExternalStore(subscribeRemoteMcpServers, getRemoteMcpServersHasLoaded);
  const discovered = useSyncExternalStore(subscribeRemoteMcp, remoteMcpState);
  const [saving, setSaving] = useState(false);
  const [retryingIds, setRetryingIds] = useState<ReadonlySet<string>>(() => new Set());

  /** The reason a write failed, said out loud because the store kept its value. */
  const failed = useCallback(
    (error: unknown): false => {
      toast.error(error instanceof Error ? error.message : t('common.somethingWentWrong'));
      return false;
    },
    [t]
  );

  const setEnabled = useCallback(
    (id: string, next: boolean) => {
      setRemoteMcpServerEnabled(id, next);
      void refreshChatTools();
      if (next && place !== null) {
        /* A server turned on may never have been discovered — a chat that had
           it off never asked it — so it is reached now rather than leaving the
           chat on the tools it already had. */
        void ensureRemoteMcp(place, { retry: true });
      }
    },
    [place]
  );

  /**
   * Asks one server again, on the person's tap.
   *
   * The discovery is the module's and the answer is per server, so the busy
   * flag is too: a second row's Retry is its own button, and one row working
   * must not put a spinner on another. The Retry deadline is the longer one a
   * person's own ask gets, so a server that is slow to answer is not failed on
   * the automatic deadline. After it answers, the registry is told so an open
   * chat moves onto the tools the Retry just found.
   */
  const retryServer = useCallback(
    (id: string) => {
      if (place === null) {
        return;
      }
      setRetryingIds(current => new Set(current).add(id));
      void (async () => {
        try {
          await ensureRemoteMcp(place, { retry: true });
          await refreshChatTools();
        } catch (error) {
          failed(error);
        } finally {
          setRetryingIds(current => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }
      })();
    },
    [failed, place]
  );

  const addServer = useCallback(
    async (draft: RemoteMcpServerDraft): Promise<boolean> => {
      setSaving(true);
      try {
        addRemoteMcpServer(draft);
        if (place !== null) {
          await ensureRemoteMcp(place, { retry: true });
        }
        await refreshChatTools();
        return true;
      } catch (error) {
        return failed(error);
      } finally {
        setSaving(false);
      }
    },
    [failed, place]
  );

  const updateServer = useCallback(
    async (id: string, draft: RemoteMcpServerDraft): Promise<boolean> => {
      setSaving(true);
      try {
        updateRemoteMcpServer(id, draft);
        if (place !== null) {
          await ensureRemoteMcp(place, { retry: true });
        }
        await refreshChatTools();
        return true;
      } catch (error) {
        return failed(error);
      } finally {
        setSaving(false);
      }
    },
    [failed, place]
  );

  const deleteServer = useCallback(
    async (id: string): Promise<boolean> => {
      setSaving(true);
      try {
        deleteRemoteMcpServer(id);
        await refreshChatTools();
        return true;
      } catch (error) {
        return failed(error);
      } finally {
        setSaving(false);
      }
    },
    [failed]
  );

  return {
    servers,
    loaded,
    discovered,
    retryingIds: [...retryingIds],
    setEnabled,
    retryServer,
    addServer,
    updateServer,
    deleteServer,
    saving,
  };
}
