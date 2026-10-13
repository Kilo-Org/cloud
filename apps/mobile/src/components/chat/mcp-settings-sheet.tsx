import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { SlidersHorizontal, Wrench } from '@/components/ui/icons';
import { PreferenceRow } from '@/components/ui/preference-row';
import { Text } from '@/components/ui/text';
import { type RemoteMcpServerDraft } from '@/lib/chat/remote-mcp-store';

import { kiloServerRow } from './mcp-settings-state';
import { McpServerFormSheet, type McpServerFormTarget } from './mcp-server-form-sheet';
import { McpServersSection } from './mcp-servers-section';
import { type McpSettings, useMcpSettings } from './use-mcp-settings';
import { WebSearchRow, type WebSearchSetting } from './web-search-row';

export { useMcpSettings };

/**
 * The chat-tools sheet.
 *
 * One sheet, one scroll: the web search switch, the switch for the
 * app-settings tools, the Kilo MCP control, and the remote MCP servers the
 * person added. The state the sheet draws comes from the pure mappings in
 * `mcp-settings-state.ts`, so the same views drive the dot on the header
 * control and every row here.
 *
 * The hook in `use-mcp-settings.ts` returns the whole sheet model. It
 * subscribes to the stores rather than copying them, so a switch an agent
 * flips — or a server another screen adds — redraws this sheet without it
 * being reopened.
 */

type McpSettingsSheetProps = {
  visible: boolean;
  onClose: () => void;
  settings: McpSettings;
  webSearch: WebSearchSetting;
};

export function McpSettingsSheet({
  visible,
  onClose,
  settings,
  webSearch,
}: Readonly<McpSettingsSheetProps>) {
  const { confirm, dialog } = useConfirmDialog();
  const { t } = useTranslation();
  const [form, setForm] = useState<McpServerFormTarget | null>(null);
  // Each open is a new native form. Android recycles EditTexts across two
  // mounts of the same add sheet, so the second open would otherwise keep the
  // previous name and URL and a type-in would concatenate them.
  const formGeneration = useRef(0);
  const { view, settingsTools, discoverServers } = settings;
  const kilo = kiloServerRow(view);

  // A restart keeps no discovered tool, so the sheet asks the servers as it
  // opens rather than showing a server with no tools and nothing running.
  useEffect(() => {
    if (visible) {
      discoverServers();
    }
  }, [visible, discoverServers]);

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
    formGeneration.current += 1;
    setForm({ kind: 'add' });
  }, []);

  const openEdit = useCallback(
    (id: string) => {
      const server = settings.storedServers.find(one => one.id === id);
      if (server !== undefined) {
        formGeneration.current += 1;
        setForm({ kind: 'edit', server });
      }
    },
    [settings.storedServers]
  );

  const confirmDelete = useCallback(
    (id: string) => {
      /* The server's tools leave every chat, so the delete is asked for and
         never taken on the tap alone. */
      confirm({
        title: t('modelChat.mcp.deleteTitle'),
        message: t('modelChat.mcp.deleteMessage'),
        confirmLabel: t('common.delete'),
        onConfirm: () => {
          void settings.deleteServer(id);
        },
      });
    },
    [confirm, settings, t]
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
        <WebSearchRow setting={webSearch} />

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
            disabled={!kilo.toggleable}
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
              /* Replacing the native control when the spinner stops is what
                 gives the name back: Android writes busy into the content
                 description and does not restore a label on the same view
                 (BaseViewManager, RN 0.86). */
              key={settings.retrying ? 'retrying' : 'idle'}
              variant="secondary"
              onPress={() => {
                settings.retry();
              }}
              loading={settings.retrying}
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
          key={formGeneration.current}
          target={form}
          saving={settings.saving}
          onSubmit={submitForm}
          onClose={closeForm}
        />
      )}
      {dialog}
    </SessionPageSheet>
  );
}
