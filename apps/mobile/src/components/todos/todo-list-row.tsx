import { styled } from 'nativewind';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import Sortable from 'react-native-sortables';

import { TodoSwipeRow } from '@/components/todos/todo-swipe-row';
import { IconTile } from '@/components/ui/icon-tile';
import { RowChevron } from '@/components/ui/row-chevron';
import { Archive, ArchiveRestore, ListTodo, Trash2 } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { NEUTRAL_TINT } from '@/lib/agent-color';
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
  const archived = list.archivedAt !== null;
  const archiveLabel = archived ? t('todos.lists.unarchive') : t('todos.lists.archive');
  const openCount = t('todos.lists.openCount', { count: list.openCount });

  const content = (
    <>
      <IconTile
        tint={NEUTRAL_TINT}
        icon={list.emoji ? undefined : ListTodo}
        content={list.emoji ? <Text className="text-base">{list.emoji}</Text> : undefined}
      />
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {list.name}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {list.gitUrl ?? t('todos.lists.noRepository')}
        </Text>
      </View>
      <Text className="text-sm tabular-nums text-muted-foreground">{openCount}</Text>
      <RowChevron />
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
  const rowClass = 'min-h-14 flex-row items-center gap-3 bg-background px-4 py-3';

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
