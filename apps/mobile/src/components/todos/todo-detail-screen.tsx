import * as Haptics from 'expo-haptics';
import { type Href } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SectionHeader } from '@/components/home/section-header';
import { QueryError } from '@/components/query-error';
import { RenameModal } from '@/components/rename-modal';
import { ScreenHeader } from '@/components/screen-header';
import { TodoNotesSection } from '@/components/todos/todo-notes-section';
import { TodoSessionRow } from '@/components/todos/todo-session-row';
import { TodoStartActions } from '@/components/todos/todo-start-actions';
import { Circle, CircleCheck } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useNowTicker } from '@/lib/hooks/use-now-ticker';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTodoItem, useTodoItemMutations } from '@/lib/hooks/use-todos';
import { TODO_TITLE_MAX_LENGTH } from '@/lib/todos/todo-model';
import { type TodoItemDetail } from '@/lib/todos/todo-types';

const LISTS_HREF = '/(app)/(tabs)/(2_agents)' as Href;

/** One done circle, and it means task completion only. */
function TodoCompletionCircle({ todo }: Readonly<{ todo: TodoItemDetail }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { update } = useTodoItemMutations(todo.listId);
  const done = todo.doneAt !== null;

  return (
    <Pressable
      onPress={() => {
        if (!done) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        update.mutate({ id: todo.id, done: !done });
      }}
      hitSlop={8}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done }}
      accessibilityLabel={done ? t('todos.item.markOpen') : t('todos.item.markDone')}
      className="size-11 items-center justify-center active:opacity-70"
    >
      {done ? (
        <CircleCheck size={24} color={colors.primary} />
      ) : (
        <Circle size={24} color={colors.mutedForeground} />
      )}
    </Pressable>
  );
}

/** Marks a not-done task done once one of its sessions' pull request is verified. */
function TodoDonePrompt({ todo }: Readonly<{ todo: TodoItemDetail }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { update } = useTodoItemMutations(todo.listId);
  const mayBeDone = todo.doneAt === null && todo.sessions.some(session => session.prVerified);
  if (!mayBeDone) {
    return null;
  }
  return (
    <View className="flex-row px-4 pt-2">
      <Pressable
        onPress={() => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          update.mutate({ id: todo.id, done: true });
        }}
        accessibilityRole="button"
        className="flex-row items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 active:opacity-70"
      >
        <CircleCheck size={14} color={colors.primaryForeground} />
        <Text className="text-sm font-medium text-primary-foreground">
          {t('todos.item.markDonePrompt')}
        </Text>
      </Pressable>
    </View>
  );
}

function TodoDetailBody({ todo }: Readonly<{ todo: TodoItemDetail }>) {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const { update, unlinkSession } = useTodoItemMutations(todo.listId);
  const now = useNowTicker(60_000);
  const [renaming, setRenaming] = useState(false);
  const listLabel = [todo.list.emoji, todo.list.name].filter(Boolean).join(' ');

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={todo.title}
        eyebrow={listLabel}
        titleNumberOfLines={2}
        reserveTitleSpace
        backFallback={LISTS_HREF}
        onTitlePress={() => {
          setRenaming(true);
        }}
        onTitlePressAccessibilityHint={t('todos.item.renameTitle')}
        inlineActions={<TodoCompletionCircle todo={todo} />}
      />
      <KeyboardAvoidingView className="flex-1" behavior="padding">
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: bottom + 24 }}
        >
          <TodoDonePrompt todo={todo} />
          <TodoNotesSection todo={todo} />
          <SectionHeader label={t('todos.item.sessions')} />
          {todo.sessions.length === 0 ? (
            <Text className="px-4 pb-2 text-sm text-ink2">{t('todos.item.noSessions')}</Text>
          ) : (
            todo.sessions.map(session => (
              <TodoSessionRow
                key={session.sessionId}
                todo={todo}
                session={session}
                now={now}
                onUnlink={sessionId => {
                  unlinkSession.mutate({ id: todo.id, sessionId });
                }}
              />
            ))
          )}
          <TodoStartActions todo={todo} organizationId={todo.list.organizationId} />
        </ScrollView>
      </KeyboardAvoidingView>
      {renaming ? (
        <RenameModal
          title={t('todos.item.renameTitle')}
          placeholder={t('todos.item.titleLabel')}
          initialValue={todo.title}
          maxLength={TODO_TITLE_MAX_LENGTH}
          onSave={async name => {
            await update.mutateAsync({ id: todo.id, title: name });
          }}
          onClose={() => {
            setRenaming(false);
          }}
        />
      ) : null}
    </View>
  );
}

/** One to-do: its title over its list, Markdown notes, linked sessions, and the ways to reach or start one. */
export function TodoDetailScreen({ itemId }: Readonly<{ itemId: string }>) {
  const query = useTodoItem(itemId);
  const todo = query.data;

  if (todo) {
    return <TodoDetailBody key={todo.id} todo={todo} />;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title=""
        titleNumberOfLines={2}
        reserveTitleSpace
        reserveEyebrow
        backFallback={LISTS_HREF}
      />
      {query.isError ? (
        <QueryError
          variant={query.error.data?.code === 'NOT_FOUND' ? 'not-found' : 'server'}
          placement="top"
          onRetry={query.error.data?.code === 'NOT_FOUND' ? undefined : () => void query.refetch()}
          isRetrying={query.isFetching}
        />
      ) : (
        <View className="gap-3 px-4 pt-4">
          <Skeleton className="h-7 w-3/4 rounded" />
          <Skeleton className="h-4 w-1/2 rounded" />
        </View>
      )}
    </View>
  );
}
