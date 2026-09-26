import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { Button } from '@/components/ui/button';
import { Wrench } from '@/components/ui/icons';
import { PreferenceRow } from '@/components/ui/preference-row';
import { Text } from '@/components/ui/text';
import { kiloMcpState, mcpEnabledFor, watchKiloMcp } from '@/lib/chat/kilo-mcp';
import { retryKiloMcp, setMcpEnabled as setChatMcpEnabled } from '@/lib/chat/registry';

import { mcpSettingsView, type McpSettingsView } from './mcp-settings-state';

/**
 * The per-chat Kilo MCP control.
 *
 * One sheet: the setting, what the connection is doing, and — when a Retry can
 * change the answer — the Retry. The state the sheet draws comes from the pure
 * mapping, so the same view drives the dot on the header control.
 *
 * The setting is written first and the chat is moved onto the tool set it names,
 * which is what the registry does; the sheet only says which switch the person
 * moved.
 */

/** The Kilo MCP control as a screen reads it. */
export type McpSettings = {
  readonly view: McpSettingsView;
  readonly setEnabled: (next: boolean) => void;
  readonly retry: () => void;
  /** A Retry is in flight, so the button shows it is working. */
  readonly retrying: boolean;
};

/**
 * Subscribes to the connection and reads the chat's setting.
 *
 * The connection is the module's snapshot, so a discovery that lands while the
 * screen is open redraws the dot and the sheet. The setting is read once per
 * session and followed across a model switch, because the registry carries it
 * to the new session id.
 */
export function useMcpSettings(sessionId: string): McpSettings {
  const { t } = useTranslation();
  const state = useSyncExternalStore(watchKiloMcp, kiloMcpState);
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

  return { view: mcpSettingsView(state, enabled), setEnabled, retry, retrying };
}

type McpSettingsSheetProps = {
  visible: boolean;
  onClose: () => void;
  view: McpSettingsView;
  onValueChange: (next: boolean) => void;
  onRetry: () => void;
  retrying: boolean;
};

export function McpSettingsSheet({
  visible,
  onClose,
  view,
  onValueChange,
  onRetry,
  retrying,
}: Readonly<McpSettingsSheetProps>) {
  const { t } = useTranslation();
  return (
    <SessionPageSheet visible={visible} onClose={onClose}>
      <SheetHeader title={t('modelChat.mcp.title')} onDone={onClose} topInset="ios-page-sheet" />
      <View className="gap-4 px-6 pb-6 pt-4">
        <PreferenceRow
          icon={Wrench}
          title={t('modelChat.mcp.use')}
          subtitle={t('modelChat.mcp.useDescription')}
          value={view.enabled}
          disabled={!view.toggleable}
          busy={view.busy}
          onValueChange={onValueChange}
        />
        {/* The status keeps one line's height in every state, so a discovery
            that moves connecting -> ready -> failed never moves the row above
            it or the Retry below. */}
        <View className="min-h-6 justify-center px-1">
          <Text className="text-sm font-medium text-foreground">
            {t(view.statusKey, { count: view.toolCount })}
          </Text>
        </View>
        {view.descriptionKey === null ? null : (
          <Text variant="muted" className="px-1 text-xs">
            {t(view.descriptionKey)}
          </Text>
        )}
        {view.retry ? (
          <Button variant="secondary" onPress={onRetry} loading={retrying}>
            <Text>{t('common.retry')}</Text>
          </Button>
        ) : null}
      </View>
    </SessionPageSheet>
  );
}
