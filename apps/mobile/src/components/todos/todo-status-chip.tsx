import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Bot, CircleDot, GitPullRequest, HelpCircle } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { todoSessionStatus } from '@/lib/todos/todo-model';
import { type TodoLinkedSession } from '@/lib/todos/todo-types';

/**
 * The newest linked session's state, plus how many sessions ran for the to-do.
 * Every state names the session, so a finished run can never be read as the
 * to-do's own done circle, and no state reuses that circle's glyph.
 */
export function TodoStatusChip({ sessions }: Readonly<{ sessions: readonly TodoLinkedSession[] }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const status = todoSessionStatus(sessions);
  const runCount =
    sessions.length > 1 ? t('todos.item.runCount', { count: sessions.length }) : null;

  let icon = null;
  let label: string | null = null;
  if (status?.kind === 'needsInput') {
    icon = <HelpCircle size={14} color={colors.warn} />;
    label = t('todos.item.sessionNeedsInput');
  } else if (status?.kind === 'running') {
    icon = <CircleDot size={14} color={colors.primary} />;
    label = t('todos.item.sessionRunning');
  } else if (status?.kind === 'pullRequest') {
    icon = <GitPullRequest size={14} color={colors.good} />;
    label =
      status.number === null
        ? t('todos.item.sessionPullRequest')
        : t('todos.item.sessionPullRequestNumber', { number: status.number });
  } else if (status?.kind === 'done') {
    icon = <Bot size={14} color={colors.mutedForeground} />;
    label = t('todos.item.sessionFinished');
  }

  if (label === null && runCount === null) {
    return null;
  }
  return (
    <View className="min-w-0 flex-row items-center gap-1.5">
      {icon}
      <Text className="min-w-0 shrink text-sm text-ink2">
        {[label, runCount].filter(Boolean).join(' · ')}
      </Text>
    </View>
  );
}
