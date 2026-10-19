import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Animated, { useAnimatedRef } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Sortable, { type SortableGridRenderItemInfo } from 'react-native-sortables';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TodoItemRow } from '@/components/todos/todo-item-row';
import { TodoQuickAdd } from '@/components/todos/todo-quick-add';
import { useStartTodo } from '@/components/todos/use-start-todo';
import { useTodoListDefaultsSummary } from '@/components/todos/use-todo-list-defaults-summary';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { ChevronDown, ChevronRight, Settings2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  PENDING_TODO_ID_PREFIX,
  useTodoItemMutations,
  useTodoItems,
  useTodoLists,
} from '@/lib/hooks/use-todos';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { todoItemPath, todoListSettingsPath } from '@/lib/todos/todo-routes';
import { type TodoItem, type TodoList } from '@/lib/todos/todo-types';

const LISTS_HREF = '/(app)/(tabs)/(2_agents)' as Href;

function TodoRowsSkeleton() {
  return (
    <View className="gap-3 px-4 pt-2">
      {[0, 1, 2].map(row => (
        <View key={row} className="min-h-14 flex-row items-center gap-3">
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="h-4 flex-1 rounded" />
        </View>
      ))}
    </View>
  );
}

function ListDefaultsLine({ list, onPress }: Readonly<{ list: TodoList; onPress: () => void }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const summary = useTodoListDefaultsSummary(list);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('todos.listSettings.title')}
      accessibilityHint={summary ?? undefined}
      className="mx-4 mb-1 min-h-11 flex-row items-center gap-2 py-2 active:opacity-70"
    >
      <Settings2 size={16} color={colors.mutedForeground} />
      <Text className="min-w-0 flex-1 text-sm leading-5 text-ink2">
        {summary ?? t('todos.list.setDefaults')}
      </Text>
      <DirectionalChevronRight size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

/** One list: quick add, the open to-dos (drag to reorder), and the collapsed finished ones. */
export function TodoListScreen({ listId }: Readonly<{ listId: string }>) {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const { organizationId } = useOrganization();
  const lists = useTodoLists(organizationId);
  const list = lists.data?.find(candidate => candidate.id === listId);
  const items = useTodoItems(listId);
  const { create, update, move, removeWithUndo } = useTodoItemMutations(listId);
  const { review, startNow, startingTodoId } = useStartTodo();
  const [showCompleted, setShowCompleted] = useState(false);
  const scrollRef = useAnimatedRef<Animated.ScrollView>();

  const openItems = useMemo(
    () => (items.data ?? []).filter(item => item.doneAt === null),
    [items.data]
  );
  const doneItems = useMemo(
    () => (items.data ?? []).filter(item => item.doneAt !== null),
    [items.data]
  );

  const openSettings = useCallback(() => {
    router.push(todoListSettingsPath({ listId, organizationId }));
  }, [listId, organizationId, router]);

  const handleOpen = useCallback(
    (item: TodoItem) => {
      router.push(todoItemPath(item.id));
    },
    [router]
  );
  const handleToggleDone = useCallback(
    (item: TodoItem) => {
      if (item.doneAt === null) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      update.mutate({ id: item.id, done: item.doneAt === null });
    },
    [update]
  );
  const handleStart = useCallback(
    (item: TodoItem) => {
      if (list) {
        review(item, list);
      }
    },
    [list, review]
  );
  const handleStartNow = useCallback(
    (item: TodoItem) => {
      if (list) {
        void startNow(item, list);
      }
    },
    [list, startNow]
  );

  const renderOpenItem = useCallback(
    ({ item }: SortableGridRenderItemInfo<TodoItem>) => (
      <TodoItemRow
        item={item}
        sortable
        starting={startingTodoId === item.id}
        onOpen={handleOpen}
        onToggleDone={handleToggleDone}
        onDelete={removeWithUndo}
        onStart={handleStart}
        onStartNow={handleStartNow}
      />
    ),
    [handleOpen, handleStart, handleStartNow, handleToggleDone, removeWithUndo, startingTodoId]
  );

  const notFound = lists.isSuccess && !list;
  const title = list ? [list.emoji, list.name].filter(Boolean).join(' ') : '';

  let body: ReactNode = null;
  if (items.isPending || (lists.isPending && !list)) {
    body = <TodoRowsSkeleton />;
  } else if (items.isError || notFound) {
    body = (
      <QueryError
        variant={notFound || items.error?.data?.code === 'NOT_FOUND' ? 'not-found' : 'server'}
        placement="top"
        onRetry={notFound ? undefined : () => void items.refetch()}
        isRetrying={items.isFetching}
      />
    );
  } else {
    body = (
      <>
        <TodoQuickAdd
          onAdd={todoTitle => {
            create.mutate({ listId, title: todoTitle });
          }}
        />
        {openItems.length === 0 && doneItems.length === 0 ? (
          <Text className="px-4 py-6 text-center text-sm text-muted-foreground">
            {t('todos.list.empty')}
          </Text>
        ) : null}
        <Sortable.Grid
          columns={1}
          data={openItems}
          renderItem={renderOpenItem}
          keyExtractor={item => item.id}
          scrollableRef={scrollRef}
          dragActivationDelay={300}
          activeItemScale={1.02}
          overDrag="vertical"
          onDragEnd={({ key, data, fromIndex, toIndex }) => {
            if (fromIndex === toIndex || key.startsWith(PENDING_TODO_ID_PREFIX)) {
              return;
            }
            const beforeId = data[toIndex - 1]?.id ?? null;
            const afterId = data[toIndex + 1]?.id ?? null;
            // A neighbour still waiting for its server id is not a UUID the
            // router accepts; the next refetch settles the dropped row anyway.
            if (
              beforeId?.startsWith(PENDING_TODO_ID_PREFIX) ||
              afterId?.startsWith(PENDING_TODO_ID_PREFIX)
            ) {
              return;
            }
            void Haptics.selectionAsync();
            move.mutate({ id: key, beforeId, afterId });
          }}
        />
        {doneItems.length > 0 ? (
          <Pressable
            onPress={() => {
              setShowCompleted(value => !value);
            }}
            accessibilityRole="button"
            accessibilityState={{ expanded: showCompleted }}
            className="mt-4 flex-row items-center gap-2 px-4 py-3 active:opacity-70"
          >
            {showCompleted ? (
              <ChevronDown size={16} color={colors.mutedForeground} />
            ) : (
              <ChevronRight size={16} color={colors.mutedForeground} />
            )}
            <Text variant="eyebrow">{t('todos.list.completed', { count: doneItems.length })}</Text>
          </Pressable>
        ) : null}
        {showCompleted
          ? doneItems.map(item => (
              <TodoItemRow
                key={item.id}
                item={item}
                sortable={false}
                starting={false}
                onOpen={handleOpen}
                onToggleDone={handleToggleDone}
                onDelete={removeWithUndo}
                onStart={handleStart}
                onStartNow={handleStartNow}
              />
            ))
          : null}
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={title}
        // The list name is user prose, not a UI label, so it keeps a second
        // line for a natural break; the shared one-line default only suits
        // fixed labels.
        titleNumberOfLines={2}
        reserveTitleSpace
        backFallback={LISTS_HREF}
        {...(list
          ? {
              onTitlePress: openSettings,
              onTitlePressAccessibilityLabel: t('todos.listSettings.title'),
            }
          : {})}
      />
      {list ? <ListDefaultsLine list={list} onPress={openSettings} /> : null}
      <KeyboardAvoidingView className="flex-1" behavior="padding">
        <Animated.ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: bottom + 24 }}
        >
          {body}
        </Animated.ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
