import { styled } from 'nativewind';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View, type ViewProps } from 'react-native';
import Sortable from 'react-native-sortables';

import { TodoStatusChip } from '@/components/todos/todo-status-chip';
import { TodoSwipeRow } from '@/components/todos/todo-swipe-row';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Check, Circle, CircleCheck, Play, RotateCcw, Trash2 } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { PENDING_TODO_ID_PREFIX } from '@/lib/hooks/use-todos';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type TodoItem } from '@/lib/todos/todo-types';
import { cn } from '@/lib/utils';

const SortableTouchable = styled(Sortable.Touchable, { className: 'style' });

type RowTouchableProps = Pick<
  ViewProps,
  'accessibilityLabel' | 'accessibilityHint' | 'accessibilityActions' | 'onAccessibilityAction'
> & {
  /** Inside a sortable list the touch must hand a long press to the drag. */
  sortable: boolean;
  /** Claim the touch so a long press here never starts the drag. */
  exclusive?: boolean;
  className?: string;
  disabled?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  children: ReactNode;
};

function RowTouchable({
  sortable,
  exclusive = false,
  className,
  disabled = false,
  onPress,
  onLongPress,
  children,
  ...a11y
}: RowTouchableProps) {
  if (sortable && !disabled) {
    return (
      <SortableTouchable
        {...a11y}
        accessible
        accessibilityRole="button"
        onAccessibilityTap={onPress}
        gestureMode={exclusive ? 'exclusive' : 'simultaneous'}
        onTap={onPress}
        onLongPress={onLongPress}
        className={className}
      >
        {children}
      </SortableTouchable>
    );
  }
  return (
    <Pressable
      {...a11y}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      className={cn(className, 'active:opacity-70')}
    >
      {children}
    </Pressable>
  );
}

type TodoItemRowProps = {
  item: TodoItem;
  sortable: boolean;
  starting: boolean;
  onOpen: (item: TodoItem) => void;
  onToggleDone: (item: TodoItem) => void;
  onDelete: (item: TodoItem) => void;
  onStart: (item: TodoItem) => void;
  onStartNow: (item: TodoItem) => void;
};

/**
 * One to-do: its done circle, its title, and either the newest session's state
 * or a Start button when nothing ran yet. Swipe right finishes it (or reopens a
 * finished one), swipe left deletes it. Long-press Start sends at once.
 */
export const TodoItemRow = memo(function TodoItemRow({
  item,
  sortable,
  starting,
  onOpen,
  onToggleDone,
  onDelete,
  onStart,
  onStartNow,
}: Readonly<TodoItemRowProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const done = item.doneAt !== null;
  const pending = item.id.startsWith(PENDING_TODO_ID_PREFIX);
  const toggleLabel = done ? t('todos.item.markOpen') : t('todos.item.markDone');

  return (
    <TodoSwipeRow
      swipeRight={
        pending
          ? undefined
          : {
              label: toggleLabel,
              icon: done ? RotateCcw : Check,
              tone: 'primary',
              onTrigger: () => {
                onToggleDone(item);
              },
            }
      }
      swipeLeft={
        pending
          ? undefined
          : {
              label: t('common.delete'),
              icon: Trash2,
              tone: 'destructive',
              onTrigger: () => {
                onDelete(item);
              },
            }
      }
    >
      <View
        className={cn(
          'min-h-14 flex-row items-center gap-3 bg-background px-4 py-2',
          pending && 'opacity-60'
        )}
      >
        <RowTouchable
          sortable={sortable}
          exclusive
          disabled={pending}
          onPress={() => {
            onToggleDone(item);
          }}
          accessibilityLabel={toggleLabel}
          className="size-8 items-center justify-center"
        >
          {done ? (
            <CircleCheck size={22} color={colors.primary} />
          ) : (
            <Circle size={22} color={colors.mutedForeground} />
          )}
        </RowTouchable>
        <RowTouchable
          sortable={sortable}
          disabled={pending}
          onPress={() => {
            onOpen(item);
          }}
          accessibilityLabel={item.title}
          accessibilityActions={[
            { name: 'toggleDone', label: toggleLabel },
            { name: 'delete', label: t('common.delete') },
          ]}
          onAccessibilityAction={event => {
            if (event.nativeEvent.actionName === 'toggleDone') {
              onToggleDone(item);
            } else if (event.nativeEvent.actionName === 'delete') {
              onDelete(item);
            }
          }}
          className="min-w-0 flex-1 gap-0.5 py-1"
        >
          <Text
            className={cn(
              'text-base',
              done ? 'text-muted-foreground line-through' : 'text-foreground'
            )}
            numberOfLines={2}
          >
            {item.title}
          </Text>
          {item.sessions.length > 0 ? <TodoStatusChip sessions={item.sessions} /> : null}
        </RowTouchable>
        {!done && !pending && item.sessions.length === 0 ? (
          <RowTouchable
            sortable={sortable}
            exclusive
            disabled={starting}
            onPress={() => {
              onStart(item);
            }}
            onLongPress={() => {
              onStartNow(item);
            }}
            accessibilityLabel={t('agentChat.newSession.startSession')}
            accessibilityHint={t('todos.item.startNowHint')}
            accessibilityActions={[{ name: 'longpress', label: t('todos.item.startNow') }]}
            onAccessibilityAction={event => {
              if (event.nativeEvent.actionName === 'longpress') {
                onStartNow(item);
              }
            }}
            className="size-10 items-center justify-center rounded-full bg-secondary"
          >
            {starting ? (
              <ActivityIndicator size="small" color={colors.foreground} />
            ) : (
              <Play size={16} color={colors.foreground} />
            )}
          </RowTouchable>
        ) : null}
      </View>
    </TodoSwipeRow>
  );
});
