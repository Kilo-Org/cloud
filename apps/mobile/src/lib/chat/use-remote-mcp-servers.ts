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
  /** What each enabled server answered, joined by id. */
  readonly discovered: readonly RemoteMcpServerState[];
  readonly setEnabled: (id: string, next: boolean) => void;
  readonly addServer: (draft: RemoteMcpServerDraft) => Promise<boolean>;
  readonly updateServer: (id: string, draft: RemoteMcpServerDraft) => Promise<boolean>;
  readonly deleteServer: (id: string) => Promise<boolean>;
  /** A write is in flight, so a form's Save shows it is working. */
  readonly saving: boolean;
};

export function useRemoteMcpServers(place: ChatPlace | null): RemoteMcpServers {
  const { t } = useTranslation();
  const servers = useSyncExternalStore(subscribeRemoteMcpServers, listRemoteMcpServers);
  const discovered = useSyncExternalStore(subscribeRemoteMcp, remoteMcpState);
  const [saving, setSaving] = useState(false);

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

  return { servers, discovered, setEnabled, addServer, updateServer, deleteServer, saving };
}
