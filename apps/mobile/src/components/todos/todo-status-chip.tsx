import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CircleCheck, CircleDot, GitPullRequest, HelpCircle } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { todoSessionStatus } from '@/lib/todos/todo-model';
import { type TodoLinkedSession } from '@/lib/todos/todo-types';

/** The newest linked session's state, plus how many sessions ran for the to-do. */
export function TodoStatusChip({ sessions }: Readonly<{ sessions: readonly TodoLinkedSession[] }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const status = todoSessionStatus(sessions);
  const runCount =
    sessions.length > 1 ? t('todos.item.runCount', { count: sessions.length }) : null;

  let icon = null;
  let label: string | null = null;
  if (status?.kind === 'needsInput') {
    icon = <HelpCircle size={12} color={colors.warn} />;
    label = t('glanceable.needsInput');
  } else if (status?.kind === 'running') {
    icon = <CircleDot size={12} color={colors.primary} />;
    label = t('common.working');
  } else if (status?.kind === 'pullRequest') {
    icon = <GitPullRequest size={12} color={colors.good} />;
    label =
      status.number === null
        ? t('prReview.terms.pullRequest')
        : t('prReview.screen.title', { number: status.number });
  } else if (status?.kind === 'done') {
    icon = <CircleCheck size={12} color={colors.mutedForeground} />;
    label = t('common.done');
  }

  if (label === null && runCount === null) {
    return null;
  }
  return (
    <View className="flex-row items-center gap-1">
      {icon}
      <Text className="text-xs text-muted-foreground" numberOfLines={1}>
        {[label, runCount].filter(Boolean).join(' · ')}
      </Text>
    </View>
  );
}
