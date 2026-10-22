import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { QueryError } from '@/components/query-error';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { ListTodo } from '@/components/ui/icons';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { invalidateTodoQueries, useSessionTodo, useTodoCandidates } from '@/lib/hooks/use-todos';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { todoItemPath } from '@/lib/todos/todo-routes';
import { type TodoCandidate } from '@/lib/todos/todo-types';
import { useTRPC } from '@/lib/trpc';

/** `To-do: <title>` under the session header while the session belongs to a to-do. */
export function SessionTodoChip({ sessionId }: Readonly<{ sessionId: string }>) {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const { data: todo } = useSessionTodo(sessionId);
  if (!todo) {
    return null;
  }
  const label = t('todos.sessionTodo', { title: todo.title });
  return (
    <View className="flex-row px-4 pb-1">
      <Pressable
        onPress={() => {
          router.push(todoItemPath(todo.id));
        }}
        accessibilityRole="button"
        accessibilityLabel={label}
        className="min-w-0 shrink flex-row items-center gap-1.5 rounded-full bg-secondary px-3 py-1 active:opacity-70"
      >
        <ListTodo size={14} color={colors.mutedForeground} />
        <Text className="min-w-0 shrink text-xs font-medium text-foreground" numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

type CandidateGroup = { listId: string; listName: string; items: TodoCandidate[] };

function groupByList(candidates: readonly TodoCandidate[]): CandidateGroup[] {
  const groups: CandidateGroup[] = [];
  for (const candidate of candidates) {
    const group = groups.find(entry => entry.listId === candidate.listId);
    if (group) {
      group.items.push(candidate);
    } else {
      groups.push({ listId: candidate.listId, listName: candidate.listName, items: [candidate] });
    }
  }
  return groups;
}

function SessionTodoCandidatesSheet({
  sessionId,
  visible,
  onClose,
}: Readonly<{ sessionId: string; visible: boolean; onClose: () => void }>) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { bottom } = useSafeAreaInsets();
  const { organizationId } = useOrganization();
  const candidates = useTodoCandidates(sessionId, organizationId, visible);
  const linkSession = useMutation(
    trpc.todos.items.linkSession.mutationOptions({
      onError: error => {
        const message = error.message;
        toast.error(message.length > 0 ? message : t('todos.item.linkFailed'));
      },
      onSettled: async () => {
        await invalidateTodoQueries(queryClient, trpc);
      },
    })
  );
  // Same-repository lists first; the router already orders by list and item position.
  const groups = useMemo(() => {
    const rows = candidates.data ?? [];
    return groupByList([...rows.filter(row => row.sameRepo), ...rows.filter(row => !row.sameRepo)]);
  }, [candidates.data]);

  let body: ReactNode = null;
  if (candidates.isPending) {
    body = (
      <View className="items-center py-8">
        <ActivityIndicator />
      </View>
    );
  } else if (candidates.isError) {
    body = (
      <QueryError
        placement="static"
        onRetry={() => void candidates.refetch()}
        isRetrying={candidates.isFetching}
      />
    );
  } else if (groups.length === 0) {
    body = (
      <Text className="px-5 py-8 text-center text-sm text-muted-foreground">
        {t('todos.candidates.empty')}
      </Text>
    );
  } else {
    body = groups.map(group => (
      <View key={group.listId} className="pb-2">
        <Text variant="eyebrow" className="px-5 pb-1 pt-3">
          {group.listName}
        </Text>
        {group.items.map(item => (
          <Pressable
            key={item.id}
            onPress={() => {
              onClose();
              linkSession.mutate({ id: item.id, sessionId, origin: 'linked' });
            }}
            accessibilityRole="button"
            accessibilityLabel={item.title}
            className="min-h-12 justify-center border-b border-hair-soft px-5 py-2 active:opacity-70"
          >
            <Text className="text-base text-foreground" numberOfLines={2}>
              {item.title}
            </Text>
          </Pressable>
        ))}
      </View>
    ));
  }

  return (
    <Sheet visible={visible} onClose={onClose} snapPoints={['70%']}>
      <View className="flex-1 pt-4">
        <Text accessibilityRole="header" className="px-5 pb-2 text-base font-semibold">
          {t('todos.linkToTodo')}
        </Text>
        <ScrollView contentContainerStyle={{ paddingBottom: bottom + 16 }}>{body}</ScrollView>
      </View>
    </Sheet>
  );
}

/**
 * The session menu's to-do row: names the linked to-do (tap opens it), or
 * offers "Link to to-do". Linking again moves the session to the picked to-do.
 */
export function SessionTodoLinkRow({ sessionId }: Readonly<{ sessionId: string }>) {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const { data: todo } = useSessionTodo(sessionId);
  const [picking, setPicking] = useState(false);
  // The primary press opens the linked to-do, so the picker is a named action
  // (and a long press for pointer users) rather than a hidden second tap.
  const linkedA11y = todo
    ? {
        accessibilityHint: t('todos.openTodoHint'),
        accessibilityActions: [{ name: 'changeTodo', label: t('todos.item.moveToAnotherTodo') }],
        onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
          if (event.nativeEvent.actionName === 'changeTodo') {
            setPicking(true);
          }
        },
      }
    : undefined;

  return (
    <>
      <Pressable
        onPress={() => {
          if (todo) {
            router.push(todoItemPath(todo.id));
          } else {
            setPicking(true);
          }
        }}
        onLongPress={
          todo
            ? () => {
                setPicking(true);
              }
            : undefined
        }
        {...linkedA11y}
        accessibilityRole="button"
        className="min-h-11 flex-row items-center gap-2 active:opacity-70"
      >
        <ListTodo size={16} color={colors.mutedForeground} />
        <Text className="min-w-0 flex-1 text-base font-medium text-foreground" numberOfLines={1}>
          {todo ? t('todos.sessionTodo', { title: todo.title }) : t('todos.linkToTodo')}
        </Text>
        <DirectionalChevronRight size={16} color={colors.mutedForeground} />
      </Pressable>
      <SessionTodoCandidatesSheet
        sessionId={sessionId}
        visible={picking}
        onClose={() => {
          setPicking(false);
        }}
      />
    </>
  );
}
