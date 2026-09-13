import { type AgentStatus, type ResolvedSession } from '@kilocode/cloud-agent-sdk';
import { WifiOff } from '@/components/ui/icons';
import { useEffect, useRef } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import { useUserWebConnectionHealth } from '@/lib/hooks/use-user-web-connection-state';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { resolveSessionConnectionState } from './session-connection-indicator-state';

type SessionConnectionIndicatorProps = {
  activeSessionType?: ResolvedSession['type'] | null;
  agentStatusType?: AgentStatus['type'];
  /** Cached transcript is readable, but session metadata still needs a refresh. */
  sessionRefresh?: { isLoading: boolean; onRetry: () => void };
};

/** A pending metadata refresh reads as connecting; a failed one reads as lost. */
function resolveSessionRefreshState({ isLoading }: { isLoading: boolean }): 'down' | 'exhausted' {
  return isLoading ? 'down' : 'exhausted';
}

export function SessionConnectionIndicator({
  activeSessionType = null,
  agentStatusType = 'idle',
  sessionRefresh,
}: Readonly<SessionConnectionIndicatorProps>) {
  const { isConnected: userWebConnected, reconnectExhausted } = useUserWebConnectionHealth();
  const connection = useUserWebConnection();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const state = sessionRefresh
    ? resolveSessionRefreshState(sessionRefresh)
    : resolveSessionConnectionState({
        activeSessionType,
        agentStatusType,
        userWebConnected,
        reconnectExhausted,
      });
  // "Ever up" is a committed-state ref (written in an effect), so a drop
  // after the first committed up reads "Reconnecting…" while a cold start
  // reads "Connecting…". Writing it during render would leak abandoned
  // render state under concurrent React.
  const wasUpRef = useRef(false);
  useEffect(() => {
    if (state === 'up') {
      wasUpRef.current = true;
    }
  }, [state]);
  let label: string | null = null;
  if (state === 'down') {
    label = wasUpRef.current
      ? t('agentChat.sessionConnection.reconnecting')
      : t('agentChat.sessionConnection.connecting');
  } else if (state === 'exhausted') {
    label = t('agentChat.sessionConnection.connectionLost');
  }
  // The exhausted state adds an interactive `Retry` action. The row stays a
  // single accessibility element for the non-interactive labels only; with a
  // pressable child the label text and the action must stay separately
  // reachable for assistive technology.
  const interactive = state === 'exhausted';
  return (
    // Keying the row on blank/labelled forces a fresh Android view when the
    // label clears. React Native does not always clear a view's previously
    // committed `contentDescription` when `accessibilityLabel` becomes
    // `undefined`, so the row kept announcing "Connecting…" to accessibility
    // services (and uiautomator) after the metadata refresh settled — a
    // phantom "Connecting…" that never cleared (p7). Remounting the row drops
    // the stale description while keeping the fixed h-6 slot.
    <View
      key={label === null ? 'blank' : 'label'}
      className="h-6 flex-row items-center justify-center gap-1.5"
      accessibilityElementsHidden={label === null}
      importantForAccessibility={label === null ? 'no-hide-descendants' : 'auto'}
      accessible={label !== null && !interactive}
      accessibilityLabel={label !== null && !interactive ? label : undefined}
    >
      {label !== null ? (
        <>
          <WifiOff size={12} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground">{label}</Text>
          {interactive ? (
            <Pressable
              onPress={() => {
                if (sessionRefresh) {
                  sessionRefresh.onRetry();
                } else {
                  connection.retryConnection();
                }
              }}
              hitSlop={8}
              className="active:opacity-70"
              accessibilityRole="button"
              accessibilityLabel={t('agentChat.sessionConnection.retryConnection')}
            >
              <Text className="text-xs font-medium text-primary">{t('common.retry')}</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
