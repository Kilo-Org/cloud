import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { Button } from '@/components/ui/button';
import { SlidersHorizontal, Wrench } from '@/components/ui/icons';
import { PreferenceRow } from '@/components/ui/preference-row';
import { Text } from '@/components/ui/text';
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
  kiloServerRow,
  mcpSettingsView,
  type McpSettingsView,
  type RemoteMcpServerRow,
  remoteServerRows,
  settingsToolsView,
  type SettingsToolsView,
} from './mcp-settings-state';
import { McpServerFormSheet, type McpServerFormTarget } from './mcp-server-form-sheet';
import { McpServersSection } from './mcp-servers-section';

/**
 * The chat-tools sheet.
 *
 * One sheet, one scroll: the switch for the app-settings tools, the Kilo MCP
 * control, and the remote MCP servers the person added. The state the sheet
 * draws comes from the pure mappings in `mcp-settings-state.ts`, so the same
 * views drive the dot on the header control and every row here.
 *
 * The hook returns the whole sheet model. It subscribes to the stores rather
 * than copying them, so a switch an agent flips — or a server another screen
 * adds — redraws this sheet without it being reopened.
 */

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
  /** Asks one failed server again, with the longer deadline a Retry gets. */
  readonly retryServer: (id: string) => void;
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
    addServer: remote.addServer,
    updateServer: remote.updateServer,
    deleteServer: remote.deleteServer,
    saving: remote.saving,
  };
}

type McpSettingsSheetProps = {
  visible: boolean;
  onClose: () => void;
  settings: McpSettings;
};

export function McpSettingsSheet({ visible, onClose, settings }: Readonly<McpSettingsSheetProps>) {
  const { t } = useTranslation();
  const [form, setForm] = useState<McpServerFormTarget | null>(null);
  const { view, settingsTools } = settings;
  const kilo = kiloServerRow(view);

  // Closing the sheet closes whatever it had open, so reopening it starts on
  // the list rather than on a form the person had already left.
  useEffect(() => {
    if (!visible) {
      setForm(null);
    }
  }, [visible]);

  const closeForm = useCallback(() => {
    setForm(null);
  }, []);

  const openAdd = useCallback(() => {
    setForm({ kind: 'add' });
  }, []);

  const openEdit = useCallback(
    (id: string) => {
      const server = settings.storedServers.find(one => one.id === id);
      if (server !== undefined) {
        setForm({ kind: 'edit', server });
      }
    },
    [settings.storedServers]
  );

  const confirmDelete = useCallback(
    (id: string) => {
      /* The server's tools leave every chat, so the delete is asked for and
         never taken on the tap alone. */
      Alert.alert(t('modelChat.mcp.deleteTitle'), t('modelChat.mcp.deleteMessage'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            void settings.deleteServer(id);
          },
        },
      ]);
    },
    [settings, t]
  );

  const submitForm = useCallback(
    (draft: RemoteMcpServerDraft) => {
      void (async () => {
        const saved =
          form?.kind === 'edit'
            ? await settings.updateServer(form.server.id, draft)
            : await settings.addServer(draft);
        if (saved) {
          setForm(null);
        }
      })();
    },
    [form, settings]
  );

  return (
    <SessionPageSheet visible={visible} onClose={onClose}>
      <SheetHeader
        title={t('modelChat.mcp.sheetTitle')}
        onDone={onClose}
        topInset="ios-page-sheet"
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-6 pb-6 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {/* 1. The one switch for the settings-changing tools. */}
        <View className="gap-2">
          <PreferenceRow
            icon={SlidersHorizontal}
            title={t(settingsTools.titleKey)}
            subtitle={t(settingsTools.subtitleKey)}
            value={settings.settingsToolsEnabled}
            disabled={false}
            onValueChange={next => {
              settings.setSettingsToolsEnabled(next);
            }}
          />
          {/* One line's height in every state, so on -> off never moves what
              follows it. */}
          <View className="min-h-6 justify-center px-1">
            <Text variant="muted" className="text-xs">
              {t(settingsTools.statusKey)}
            </Text>
          </View>
        </View>

        {/* 2. The Kilo row: enable, disable and a Retry, and nothing else. The
            Kilo server is the build's own, so it is never edited or deleted. */}
        <View className="gap-2">
          <PreferenceRow
            icon={Wrench}
            title={t('modelChat.mcp.use')}
            subtitle={t('modelChat.mcp.useDescription')}
            value={kilo.enabled}
            disabled={false}
            busy={kilo.busy}
            onValueChange={next => {
              settings.setEnabled(next);
            }}
          />
          <View className="min-h-6 justify-center px-1">
            <Text className="text-sm font-medium text-foreground">
              {t(kilo.statusKey, { count: kilo.toolCount })}
            </Text>
          </View>
          {kilo.descriptionKey === null ? null : (
            <Text variant="muted" className="px-1 text-xs">
              {t(kilo.descriptionKey)}
            </Text>
          )}
          <Text variant="muted" className="px-1 text-xs">
            {t('modelChat.mcp.kiloBuiltIn')}
          </Text>
          {kilo.retry ? (
            <Button
              variant="secondary"
              onPress={() => {
                settings.retry();
              }}
              loading={settings.retrying}
              /* The name is what the platform restores when the spinner stops:
                 a busy button with none is read as "busy" for the rest of the
                 screen's life (BaseViewManager, RN 0.86). Every other control in
                 this sheet names itself the same way. */
              accessibilityLabel={t('common.retry')}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          ) : null}
        </View>

        {/* 3. The remote servers the person added. */}
        <McpServersSection
          loaded={settings.loaded}
          servers={settings.servers}
          retryingIds={settings.retryingServerIds}
          onToggle={(id, next) => {
            settings.setServerEnabled(id, next);
          }}
          onEdit={openEdit}
          onDelete={confirmDelete}
          onRetry={id => {
            settings.retryServer(id);
          }}
          onAdd={openAdd}
        />
      </ScrollView>
      {form === null ? null : (
        <McpServerFormSheet
          target={form}
          saving={settings.saving}
          onSubmit={submitForm}
          onClose={closeForm}
        />
      )}
    </SessionPageSheet>
  );
}
