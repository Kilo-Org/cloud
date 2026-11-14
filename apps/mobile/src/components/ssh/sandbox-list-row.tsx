import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { namedSessionTitle } from '@/components/agents/session-detail-rename-state';
import { composeSessionProvenanceSubtitle } from '@/components/agents/session-provenance-subtitle';
import { Cloud, Terminal } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';

type SandboxListRowProps = Readonly<{
  session: ActiveSession;
  /** The row's own spoken name, which names where the tap goes. */
  accessibilityLabel: string;
  onPress: () => void;
}>;

/**
 * One live Cloud Agent session on the SSH screen. It reads like a host row —
 * a name, a provenance line, the same shape — because tapping it opens the same
 * kind of terminal, just one that runs in the session's sandbox.
 */
export function SandboxListRow({ session, accessibilityLabel, onPress }: SandboxListRowProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const title = namedSessionTitle(session.title, session.id) ?? t('ssh.sandboxes.unnamed');
  const subtitle = composeSessionProvenanceSubtitle({
    branch: session.gitBranch,
    prNumber: session.associatedPr?.number,
  });

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      className="min-h-[64px] flex-row items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 active:opacity-70"
    >
      <Cloud size={18} color={colors.mutedForeground} />
      <View className="min-w-0 flex-1 justify-center gap-0.5">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {title}
        </Text>
        {subtitle === null ? null : (
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      <Terminal size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}
