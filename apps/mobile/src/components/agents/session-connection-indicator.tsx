import { type AgentStatus, type ResolvedSession } from '@kilocode/cloud-agent-sdk';
import { WifiOff } from '@/components/ui/icons';
import { useEffect, useRef } from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import { useUserWebConnectionHealth } from '@/lib/hooks/use-user-web-connection-state';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { resolveSessionConnectionState } from './session-connection-indicator-state';

type SessionConnectionIndicatorProps = {
  activeSessionType?: ResolvedSession['type'] | null;
  agentStatusType?: AgentStatus['type'];
};

export function SessionConnectionIndicator({
  activeSessionType = null,
  agentStatusType = 'idle',
}: Readonly<SessionConnectionIndicatorProps>) {
  const { isConnected: userWebConnected, reconnectExhausted } = useUserWebConnectionHealth();
  const connection = useUserWebConnection();
  const colors = useThemeColors();
  const state = resolveSessionConnectionState({
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
    label = wasUpRef.current ? 'Reconnecting…' : 'Connecting…';
  } else if (state === 'exhausted') {
    label = 'Connection lost';
  }
  // The exhausted state adds an interactive `Retry` action. The row stays a
  // single accessibility element for the non-interactive labels only; with a
  // pressable child the label text and the action must stay separately
  // reachable for assistive technology.
  const interactive = state === 'exhausted';
  return (
    <View
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
                connection.retryConnection();
              }}
              hitSlop={8}
              className="active:opacity-70"
              accessibilityRole="button"
              accessibilityLabel="Retry connection"
            >
              <Text className="text-xs font-medium text-primary">Retry</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
