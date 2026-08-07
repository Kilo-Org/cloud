import { type AgentStatus, type ResolvedSession } from '@kilocode/cloud-agent-sdk';
import { WifiOff } from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useUserWebConnectionState } from '@/lib/hooks/use-user-web-connection-state';
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
  const userWebConnected = useUserWebConnectionState();
  const colors = useThemeColors();
  const state = resolveSessionConnectionState({
    activeSessionType,
    agentStatusType,
    userWebConnected,
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
  }
  return (
    <View
      className="h-6 flex-row items-center justify-center gap-1.5"
      accessibilityElementsHidden={label === null}
      importantForAccessibility={label === null ? 'no-hide-descendants' : 'auto'}
      accessible={label !== null}
      accessibilityLabel={label ?? undefined}
    >
      {label !== null ? (
        <>
          <WifiOff size={12} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground">{label}</Text>
        </>
      ) : null}
    </View>
  );
}
