import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import Sortable, { type SortableGridRenderItemInfo } from 'react-native-sortables';

import { EmptyState } from '@/components/empty-state';
import { useLiveSessionContext } from '@/components/home/live-session-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { TodoListRow } from '@/components/todos/todo-list-row';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { ChevronDown, ChevronRight, ListTodo, Plus } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useTodoListMutations, useTodoLists } from '@/lib/hooks/use-todos';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { todoListPath, todoListSettingsPath } from '@/lib/todos/todo-routes';
import { type TodoList } from '@/lib/todos/todo-types';
import { useTRPC } from '@/lib/trpc';

function ListRowsSkeleton() {
  return (
    <View className="gap-3 px-4 pt-2">
      {[0, 1, 2].map(row => (
        <View key={row} className="min-h-16 flex-row items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <View className="flex-1 gap-2">
            <Skeleton className="h-4 w-1/2 rounded" />
            <Skeleton className="h-3 w-1/3 rounded" />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * The Agents tab's To-dos view: the context's lists, drag to reorder, swipe
 * to archive or delete, with the archived ones collapsed at the bottom.
 */
export function TodoListsScreen({ segmentControl }: Readonly<{ segmentControl: ReactNode }>) {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const context = useLiveSessionContext();
  const { organizationId } = context;
  const lists = useTodoLists(organizationId, context.isReady);
  const { update, move, remove } = useTodoListMutations(organizationId);
  const { confirm, dialog } = useConfirmDialog();
  const [showArchived, setShowArchived] = useState(false);

  const activeLists = useMemo(
    () => (lists.data ?? []).filter(list => list.archivedAt === null),
    [lists.data]
  );
  const archivedLists = useMemo(
    () => (lists.data ?? []).filter(list => list.archivedAt !== null),
    [lists.data]
  );

  const openNewList = useCallback(() => {
    router.push(todoListSettingsPath({ organizationId }));
  }, [organizationId, router]);
  const handleOpen = useCallback(
    (list: TodoList) => {
      router.push(todoListPath(list.id));
    },
    [router]
  );
  const handleToggleArchived = useCallback(
    (list: TodoList) => {
      update.mutate({ id: list.id, archived: list.archivedAt === null });
    },
    [update]
  );
  const handleDelete = useCallback(
    (list: TodoList) => {
      void (async () => {
        // The count covers finished to-dos too, which `openCount` leaves out.
        const items = await queryClient
          .query(trpc.todos.items.list.queryOptions({ listId: list.id }))
          .catch(() => null);
        const deleteList = () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          remove.mutate({ id: list.id });
        };
        if (items?.length === 0) {
          deleteList();
          return;
        }
        confirm({
          title: t('todos.lists.deleteTitle', { name: list.name }),
          message: t('todos.lists.deleteMessage'),
          confirmLabel: t('common.delete'),
          onConfirm: deleteList,
        });
      })();
    },
    [confirm, queryClient, remove, t, trpc]
  );

  const renderActiveList = useCallback(
    ({ item }: SortableGridRenderItemInfo<TodoList>) => (
      <TodoListRow
        list={item}
        sortable
        onOpen={handleOpen}
        onToggleArchived={handleToggleArchived}
        onDelete={handleDelete}
      />
    ),
    [handleDelete, handleOpen, handleToggleArchived]
  );

  let body: ReactNode = null;
  if (!context.isReady || lists.isPending) {
    body = <ListRowsSkeleton />;
  } else if (lists.isError) {
    body = (
      <QueryError
        title={t('todos.lists.couldNotLoad')}
        placement="top"
        onRetry={() => void lists.refetch()}
        isRetrying={lists.isFetching}
      />
    );
  } else if (lists.data.length === 0) {
    body = (
      <EmptyState
        icon={ListTodo}
        title={t('todos.lists.empty')}
        placement="top"
        action={
          <Button className={STATE_ACTION_CLASS} variant="outline" onPress={openNewList}>
            <Text>{t('todos.lists.newList')}</Text>
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        <Sortable.Grid
          columns={1}
          data={activeLists}
          renderItem={renderActiveList}
          keyExtractor={list => list.id}
          dragActivationDelay={300}
          activeItemScale={1.02}
          overDrag="vertical"
          onDragEnd={({ key, data, fromIndex, toIndex }) => {
            if (fromIndex === toIndex) {
              return;
            }
            void Haptics.selectionAsync();
            move.mutate({
              id: key,
              beforeId: data[toIndex - 1]?.id ?? null,
              afterId: data[toIndex + 1]?.id ?? null,
            });
          }}
        />
        {archivedLists.length > 0 ? (
          <Pressable
            onPress={() => {
              setShowArchived(value => !value);
            }}
            accessibilityRole="button"
            accessibilityState={{ expanded: showArchived }}
            className="mt-4 flex-row items-center gap-2 px-4 py-3 active:opacity-70"
          >
            {showArchived ? (
              <ChevronDown size={16} color={colors.mutedForeground} />
            ) : (
              <ChevronRight size={16} color={colors.mutedForeground} />
            )}
            <Text variant="eyebrow">
              {t('todos.lists.archived', { count: archivedLists.length })}
            </Text>
          </Pressable>
        ) : null}
        {showArchived
          ? archivedLists.map(list => (
              <TodoListRow
                key={list.id}
                list={list}
                sortable={false}
                onOpen={handleOpen}
                onToggleArchived={handleToggleArchived}
                onDelete={handleDelete}
              />
            ))
          : null}
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('common.agents')}
        size="large"
        showBackButton={false}
        className="px-[22px]"
        headerRight={
          context.isReady ? (
            <Pressable
              onPress={openNewList}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('todos.lists.newList')}
              className="size-11 items-center justify-center active:opacity-70"
            >
              <Plus size={22} color={colors.foreground} />
            </Pressable>
          ) : undefined
        }
      />
      {segmentControl}
      <TabScreenScrollView>{body}</TabScreenScrollView>
      {dialog}
    </View>
  );
}
