import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { kiloMcpState, mcpEnabledFor, watchKiloMcp } from '@/lib/chat/kilo-mcp';
import {
  refreshChatTools,
  retryKiloMcp,
  setMcpEnabled as setChatMcpEnabled,
} from '@/lib/chat/registry';
import { type RemoteMcpServerDraft, type StoredRemoteMcpServer } from '@/lib/chat/remote-mcp-store';
import { type ChatPlace } from '@/lib/chat/scope';
import {
  isSettingsToolsEnabled,
  setSettingsToolsEnabled,
  subscribeSettingsToolsEnabled,
} from '@/lib/chat/settings-tools-switch';
import { useRemoteMcpServers } from '@/lib/chat/use-remote-mcp-servers';

import {
  mcpSettingsView,
  type McpSettingsView,
  type RemoteMcpServerRow,
  remoteServerRows,
  settingsToolsView,
  type SettingsToolsView,
} from './mcp-settings-state';

/** The Kilo MCP control as a screen reads it. */
export type McpSettings = {
  /** The Kilo row's view, and the tone the header dot draws. */
  readonly view: McpSettingsView;
  readonly setEnabled: (next: boolean) => void;
  readonly retry: () => void;
  /** A Retry is in flight, so the button shows it is working. */
  readonly retrying: boolean;
  /** The one group switch for the settings-changing tools. */
  readonly settingsTools: SettingsToolsView;
  readonly settingsToolsEnabled: boolean;
  readonly setSettingsToolsEnabled: (next: boolean) => void;
  /** One row per stored remote server, in the stored order. */
  readonly servers: readonly RemoteMcpServerRow[];
  /** Whether the stored list has been read, so an empty list means none. */
  readonly loaded: boolean;
  /** The stored servers behind those rows, so an edit can prefill the form. */
  readonly storedServers: readonly StoredRemoteMcpServer[];
  readonly setServerEnabled: (id: string, next: boolean) => void;
  /** The servers whose Retry is in flight, so only those buttons show it. */
  readonly retryingServerIds: readonly string[];
  /** Asks one server with no tools on hand again, with the longer deadline a Retry gets. */
  readonly retryServer: (id: string) => void;
  /** Asks every enabled server with no tools on hand, as the sheet opens. */
  readonly discoverServers: () => void;
  /** Adds a server, discovers it, and answers whether the write landed. */
  readonly addServer: (draft: RemoteMcpServerDraft) => Promise<boolean>;
  /** Replaces one server, discovers it, and answers whether the write landed. */
  readonly updateServer: (id: string, draft: RemoteMcpServerDraft) => Promise<boolean>;
  /** Removes one server and answers whether the write landed. */
  readonly deleteServer: (id: string) => Promise<boolean>;
  /** A server write is in flight, so the form's Save shows it is working. */
  readonly saving: boolean;
};

/**
 * Subscribes to the connection and the stores, and reads the chat's setting.
 *
 * The connection is the module's snapshot, so a discovery that lands while the
 * screen is open redraws the dot and the sheet. The setting is read once per
 * session and followed across a model switch, because the registry carries it
 * to the new session id. The server list and what each server answered are
 * read the same way, so an agent's write is on screen without a reopen.
 */
export function useMcpSettings(place: ChatPlace | null, sessionId: string): McpSettings {
  const { t } = useTranslation();
  const state = useSyncExternalStore(watchKiloMcp, kiloMcpState);
  const settingsToolsEnabled = useSyncExternalStore(
    subscribeSettingsToolsEnabled,
    isSettingsToolsEnabled
  );
  const remote = useRemoteMcpServers(place);
  const [enabled, setEnabledState] = useState(true);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    // The read is async and the session id can change under it (a model switch),
    // so the run keeps its own flag: a value that answers late for the session
    // that left is dropped, and a flag shared between runs could not tell the
    // run that was replaced from the one that replaced it.
    let cancelled = false;
    const read = async () => {
      const stored = await mcpEnabledFor(sessionId);
      if (!cancelled) {
        setEnabledState(stored);
      }
    };
    void read();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const setEnabled = useCallback(
    (next: boolean) => {
      /* The switch moves at once, so the tap answers without waiting for the
         write. The write and the move it makes can both fail, and the chat is
         then still on the tool set it had: the switch is put back where it was
         and the reason is said out loud, rather than left claiming a tool set
         the live session never got. */
      const previous = enabled;
      setEnabledState(next);
      void (async () => {
        try {
          await setChatMcpEnabled(sessionId, next);
        } catch (error) {
          setEnabledState(previous);
          toast.error(error instanceof Error ? error.message : t('common.somethingWentWrong'));
        }
      })();
    },
    [enabled, sessionId, t]
  );

  const retry = useCallback(() => {
    setRetrying(true);
    void (async () => {
      try {
        await retryKiloMcp(sessionId);
      } catch (error) {
        /* A Retry can fail before it reaches the server — the chat may not be
           movable — and the sheet then keeps the failure it already showed.
           Saying it out loud is the only cue, because the state behind the sheet
           is unchanged. */
        toast.error(error instanceof Error ? error.message : t('common.somethingWentWrong'));
      } finally {
        setRetrying(false);
      }
    })();
  }, [sessionId, t]);

  /**
   * Moves the group switch and the tool list together.
   *
   * The store is the one source of truth, so it is written first; the registry
   * is then told, and every open chat moves onto the names the switch now
   * names at its next use. Without the second call an open chat would keep the
   * settings tools the switch just took away.
   */
  const setGroupEnabled = useCallback((next: boolean) => {
    setSettingsToolsEnabled(next);
    void refreshChatTools();
  }, []);

  return {
    view: mcpSettingsView(state, enabled),
    setEnabled,
    retry,
    retrying,
    settingsTools: settingsToolsView(settingsToolsEnabled),
    settingsToolsEnabled,
    setSettingsToolsEnabled: setGroupEnabled,
    servers: remoteServerRows(remote.servers, remote.discovered),
    loaded: remote.loaded,
    storedServers: remote.servers,
    setServerEnabled: remote.setEnabled,
    retryingServerIds: remote.retryingIds,
    retryServer: remote.retryServer,
    discoverServers: remote.discover,
    addServer: remote.addServer,
    updateServer: remote.updateServer,
    deleteServer: remote.deleteServer,
    saving: remote.saving,
  };
}
