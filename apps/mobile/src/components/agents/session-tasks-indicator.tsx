import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { ChevronRight, ListTodo } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

import { useOpenPartDetail } from './open-part-detail-context';
import { type SessionTodoSummary } from './session-todo-summary';

type SessionTasksIndicatorProps = {
  summary: SessionTodoSummary;
};

/**
 * Both indicators open the transcript's detail sheet for the latest
 * `todowrite`, the same task list its tool row opens.
 *
 * Compact task-progress pill for the goal row's trailing column, under the PR
 * pill. Same box as `SessionPrBadge`, so the two stack into one column. The
 * extra tap area grows sideways and only 3px down, so it never overlaps the PR
 * pill above it or the transcript below the row.
 */
export function SessionTasksChip({ summary }: Readonly<SessionTasksIndicatorProps>) {
  const openPartDetail = useOpenPartDetail();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const counts = { completed: summary.completed, total: summary.total };

  return (
    <Pressable
      onPress={() => openPartDetail?.(summary.partId)}
      hitSlop={{ bottom: 3, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel={t('agentChat.tasks.progressAccessibility', counts)}
      className="active:opacity-70"
    >
      <View className="flex-row items-center gap-1 rounded-full bg-secondary py-0.5 pl-1.5 pr-2">
        <ListTodo size={12} color={colors.primary} />
        <Text className="text-xs font-medium tabular-nums text-foreground">
          {t('agentChat.tasks.progress', counts)}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * One-line task row under the session header, for a session without a goal:
 * the progress count, then the current task. The whole row is one target at
 * the 44pt touch minimum.
 */
export function SessionTasksRow({ summary }: Readonly<SessionTasksIndicatorProps>) {
  const openPartDetail = useOpenPartDetail();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const counts = { completed: summary.completed, total: summary.total };
  const isActive = summary.current.status === 'in_progress';

  return (
    <Pressable
      onPress={() => openPartDetail?.(summary.partId)}
      accessibilityRole="button"
      accessibilityLabel={t('agentChat.tasks.rowAccessibility', {
        ...counts,
        task: summary.current.content,
      })}
      className="min-h-[44px] flex-row items-center gap-2 border-b border-hair-soft px-4 active:opacity-70"
    >
      <ListTodo size={14} color={colors.primary} />
      <Text className="text-xs font-semibold tabular-nums text-primary">
        {t('agentChat.tasks.progress', counts)}
      </Text>
      <Text
        numberOfLines={1}
        className={cn(
          'min-w-0 flex-1 text-sm',
          isActive ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {summary.current.content}
      </Text>
      <ChevronRight size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}
