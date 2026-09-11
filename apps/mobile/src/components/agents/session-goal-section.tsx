import { type SessionGoal, type SessionGoalStatus } from '@kilocode/cloud-agent-sdk';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { CircleDot } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const STATUS_LABEL_KEY = {
  active: 'agentChat.goal.statusActive',
  paused: 'agentChat.goal.statusPaused',
  complete: 'agentChat.goal.statusComplete',
  blocked: 'agentChat.goal.statusBlocked',
} as const satisfies Record<SessionGoalStatus, string>;

type SessionGoalSectionProps = {
  goal: SessionGoal;
  onPress: () => void;
};

/**
 * Fixed goal row shown under the session header. It lives outside the
 * transcript list, so it stays put while the transcript scrolls. The
 * `min-h-*` reserves the row height across every status, and the optional
 * `reason` is the only part that can add a line.
 */
export function SessionGoalSection({ goal, onPress }: Readonly<SessionGoalSectionProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const isActive = goal.status === 'active';
  const status = t(STATUS_LABEL_KEY[goal.status]);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('agentChat.goal.sectionAccessibility', { status, text: goal.text })}
      className="min-h-12 flex-row items-start gap-2 border-b border-hair-soft px-4 py-2 active:opacity-70"
    >
      <View className="pt-0.5">
        <CircleDot size={14} color={isActive ? colors.primary : colors.mutedForeground} />
      </View>
      <View className="min-w-0 flex-1">
        <Text className={cn('text-xs', isActive ? 'text-primary' : 'text-muted-foreground')}>
          {status}
        </Text>
        <Text className="text-sm text-foreground" numberOfLines={2}>
          {goal.text}
        </Text>
        {goal.reason ? (
          <Text className="text-xs text-muted-foreground" numberOfLines={2}>
            {goal.reason}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
