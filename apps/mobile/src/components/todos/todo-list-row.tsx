import { styled } from 'nativewind';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import Sortable from 'react-native-sortables';

import { TodoSwipeRow } from '@/components/todos/todo-swipe-row';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Archive, ArchiveRestore, ListTodo, Trash2 } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type TodoList } from '@/lib/todos/todo-types';

const SortableTouchable = styled(Sortable.Touchable, { className: 'style' });

type TodoListRowProps = {
  list: TodoList;
  sortable: boolean;
  onOpen: (list: TodoList) => void;
  onToggleArchived: (list: TodoList) => void;
  onDelete: (list: TodoList) => void;
};

/** A list: its emoji, name, open count and repository. Swipe right archives, left deletes. */
export const TodoListRow = memo(function TodoListRow({
  list,
  sortable,
  onOpen,
  onToggleArchived,
  onDelete,
}: Readonly<TodoListRowProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const archived = list.archivedAt !== null;
  const archiveLabel = archived ? t('todos.lists.unarchive') : t('todos.lists.archive');
  const openCount = t('todos.lists.openCount', { count: list.openCount });

  const content = (
    <>
      <View className="size-9 items-center justify-center rounded-lg bg-secondary">
        {list.emoji ? (
          <Text className="text-lg">{list.emoji}</Text>
        ) : (
          <ListTodo size={18} color={colors.mutedForeground} />
        )}
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-base font-medium text-foreground" numberOfLines={1}>
          {list.name}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {list.gitUrl ?? t('todos.lists.noRepository')}
        </Text>
      </View>
      <Text className="text-sm tabular-nums text-muted-foreground">{openCount}</Text>
      <DirectionalChevronRight size={16} color={colors.mutedForeground} />
    </>
  );
  const a11y = {
    accessibilityLabel: t('todos.lists.rowA11y', { name: list.name, openCount }),
    accessibilityActions: [
      { name: 'toggleArchived', label: archiveLabel },
      { name: 'delete', label: t('common.delete') },
    ],
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
      if (event.nativeEvent.actionName === 'toggleArchived') {
        onToggleArchived(list);
      } else if (event.nativeEvent.actionName === 'delete') {
        onDelete(list);
      }
    },
  };
  const rowClass = 'min-h-16 flex-row items-center gap-3 bg-background px-4 py-2';

  return (
    <TodoSwipeRow
      swipeRight={{
        label: archiveLabel,
        icon: archived ? ArchiveRestore : Archive,
        tone: 'warn',
        onTrigger: () => {
          onToggleArchived(list);
        },
      }}
      swipeLeft={{
        label: t('common.delete'),
        icon: Trash2,
        tone: 'destructive',
        onTrigger: () => {
          onDelete(list);
        },
      }}
    >
      {sortable ? (
        <SortableTouchable
          {...a11y}
          accessible
          accessibilityRole="button"
          onAccessibilityTap={() => {
            onOpen(list);
          }}
          gestureMode="simultaneous"
          onTap={() => {
            onOpen(list);
          }}
          className={rowClass}
        >
          {content}
        </SortableTouchable>
      ) : (
        <Pressable
          {...a11y}
          accessibilityRole="button"
          onPress={() => {
            onOpen(list);
          }}
          className={`${rowClass} active:opacity-70`}
        >
          {content}
        </Pressable>
      )}
    </TodoSwipeRow>
  );
});
