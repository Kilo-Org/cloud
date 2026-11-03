import { useActionSheet } from '@expo/react-native-action-sheet';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { namedSessionTitle } from '@/components/agents/session-detail-rename-state';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { TodoStatusChip } from '@/components/todos/todo-status-chip';
import { useConfirmDialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { MoreHorizontal } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useThemedActionSheetOptions } from '@/lib/hooks/use-themed-action-sheet';
import { type TodoItemDetail, type TodoLinkedSession } from '@/lib/todos/todo-types';
import { parseTimestamp, timeAgo } from '@/lib/utils';

type TodoSessionRowProps = {
  todo: TodoItemDetail;
  session: TodoLinkedSession;
  /** The screen's one-minute clock tick, so a relative label never freezes. */
  now: number;
  /** Unlink the session from the to-do; the mutation owns error handling. */
  onUnlink: (sessionId: string) => void;
};

/**
 * One linked session. Opening it is the whole row's tap; session management
 * lives in the trailing overflow, and unlinking confirms that the session
 * itself is kept.
 */
export function TodoSessionRow({ todo, session, now, onUnlink }: Readonly<TodoSessionRowProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { showActionSheetWithOptions } = useActionSheet();
  const themedSheet = useThemedActionSheetOptions();
  const { confirm, dialog } = useConfirmDialog();
  const navigateToSession = useAgentSessionNavigator();

  const ownTitle = namedSessionTitle(session.title, session.sessionId);
  let title = t('todos.item.untitledLinkedSession');
  if (ownTitle !== undefined) {
    title = ownTitle;
  } else if (session.origin === 'started') {
    title = todo.title;
  }

  function openSessionActions() {
    showActionSheetWithOptions(
      {
        ...themedSheet,
        title,
        options: [t('todos.item.unlinkSessionAction'), t('common.cancel')],
        cancelButtonIndex: 1,
      },
      index => {
        if (index === 0) {
          confirm({
            title: t('todos.item.unlinkConfirmTitle', { title }),
            message: t('todos.item.unlinkConfirmMessage'),
            confirmLabel: t('todos.item.unlinkSessionAction'),
            onConfirm: () => {
              onUnlink(session.sessionId);
            },
          });
        }
      }
    );
  }

  return (
    <View className="min-h-14 flex-row items-center gap-1 px-4">
      <Pressable
        onPress={() => {
          navigateToSession(session.sessionId, todo.list.organizationId);
        }}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={t('todos.item.openSessionHint')}
        className="min-w-0 flex-1 flex-row items-center gap-2 py-2 active:opacity-70"
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base text-foreground" numberOfLines={1}>
            {title}
          </Text>
          {ownTitle === undefined ? (
            <Text className="text-sm text-ink2">
              {timeAgo(parseTimestamp(session.linkedAt), undefined, now)}
            </Text>
          ) : null}
          <TodoStatusChip sessions={[session]} />
        </View>
        <DirectionalChevronRight size={20} color={colors.mutedForeground} />
      </Pressable>
      <IconButton
        onPress={openSessionActions}
        accessibilityLabel={t('agents.sessionRow.actions')}
        accessibilityHint={title}
      >
        <MoreHorizontal size={20} color={colors.mutedForeground} />
      </IconButton>
      {dialog}
    </View>
  );
}
