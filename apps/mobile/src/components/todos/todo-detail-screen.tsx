import * as Haptics from 'expo-haptics';
import { type Href } from 'expo-router';
import { type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MarkdownText } from '@/components/agents/markdown-text';
import { namedSessionTitle } from '@/components/agents/session-detail-rename-state';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { SectionHeader } from '@/components/home/section-header';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TodoLinkSessionSheet } from '@/components/todos/todo-link-session-sheet';
import { TodoStatusChip } from '@/components/todos/todo-status-chip';
import { useStartTodo } from '@/components/todos/use-start-todo';
import { Button } from '@/components/ui/button';
import { Circle, CircleCheck, Link2, Play, Unlink } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useTodoItem, useTodoItemMutations } from '@/lib/hooks/use-todos';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { TODO_NOTES_MAX_LENGTH, TODO_TITLE_MAX_LENGTH } from '@/lib/todos/todo-model';
import { type TodoItemDetail } from '@/lib/todos/todo-types';
import { cn } from '@/lib/utils';

const LISTS_HREF = '/(app)/(tabs)/(2_agents)' as Href;

function TodoDetailBody({ todo }: Readonly<{ todo: TodoItemDetail }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const { update, linkSession, unlinkSession } = useTodoItemMutations(todo.listId);
  const { review, startNow, startingTodoId } = useStartTodo();
  const navigateToSession = useAgentSessionNavigator();
  const titleRef = useRef(todo.title);
  const notesRef = useRef(todo.notes ?? '');
  const [editingNotes, setEditingNotes] = useState(false);
  const [linking, setLinking] = useState(false);
  const done = todo.doneAt !== null;
  const mayBeDone = !done && todo.sessions.some(session => session.prVerified);

  function saveTitle() {
    const title = titleRef.current.trim();
    if (title.length === 0 || title === todo.title) {
      return;
    }
    update.mutate({ id: todo.id, title });
  }

  function saveNotes() {
    setEditingNotes(false);
    const notes = notesRef.current.trim();
    if (notes === (todo.notes ?? '').trim()) {
      return;
    }
    update.mutate({ id: todo.id, notes: notes.length > 0 ? notes : null });
  }

  function setDone(next: boolean) {
    if (next) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    update.mutate({ id: todo.id, done: next });
  }

  let notesView: ReactNode = null;
  if (editingNotes) {
    notesView = (
      <TextInput
        autoFocus
        multiline
        defaultValue={notesRef.current}
        onChangeText={text => {
          notesRef.current = text;
        }}
        onEndEditing={saveNotes}
        maxLength={TODO_NOTES_MAX_LENGTH}
        accessibilityLabel={t('todos.item.notes')}
        placeholder={t('todos.item.notesPlaceholder')}
        placeholderTextColor={colors.mutedForeground}
        className="min-h-32 rounded-lg border border-border bg-secondary pb-2.5 pl-3 pr-3 pt-2.5 text-base leading-6 text-foreground"
      />
    );
  } else if (todo.notes) {
    notesView = (
      <Pressable
        onPress={() => {
          setEditingNotes(true);
        }}
        accessibilityRole="button"
        accessibilityHint={t('chat.messageActions.edit')}
      >
        <MarkdownText value={todo.notes} />
      </Pressable>
    );
  } else {
    notesView = (
      <Pressable
        onPress={() => {
          setEditingNotes(true);
        }}
        accessibilityRole="button"
        className="py-2 active:opacity-70"
      >
        <Text className="text-sm text-muted-foreground">{t('todos.item.notesPlaceholder')}</Text>
      </Pressable>
    );
  }

  return (
    <KeyboardAvoidingView className="flex-1" behavior="padding">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: bottom + 24 }}
      >
        <View className="flex-row items-start gap-3 px-4 pt-2">
          <Pressable
            onPress={() => {
              setDone(!done);
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
          <TextInput
            defaultValue={todo.title}
            onChangeText={text => {
              titleRef.current = text;
            }}
            // `blurAndSubmit` blurs on return, so `onEndEditing` fires for
            // both return and tap-away; a second handler would save twice.
            onEndEditing={saveTitle}
            submitBehavior="blurAndSubmit"
            multiline
            maxLength={TODO_TITLE_MAX_LENGTH}
            accessibilityLabel={t('todos.item.titleLabel')}
            placeholder={t('todos.item.titleLabel')}
            placeholderTextColor={colors.mutedForeground}
            className={cn(
              'min-w-0 flex-1 pb-2 pl-0 pr-0 pt-2 text-xl font-semibold leading-7',
              done ? 'text-muted-foreground line-through' : 'text-foreground'
            )}
          />
        </View>

        {mayBeDone ? (
          <View className="flex-row px-4 pt-2">
            <Pressable
              onPress={() => {
                setDone(true);
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
        ) : null}

        <SectionHeader
          label={t('todos.item.notes')}
          actionLabel={editingNotes ? t('common.done') : t('chat.messageActions.edit')}
          onActionPress={() => {
            if (editingNotes) {
              saveNotes();
            } else {
              setEditingNotes(true);
            }
          }}
        />
        <View className="px-4">{notesView}</View>

        <SectionHeader label={t('todos.item.sessions')} />
        {todo.sessions.length === 0 ? (
          <Text className="px-4 pb-2 text-sm text-muted-foreground">
            {t('todos.item.noSessions')}
          </Text>
        ) : (
          todo.sessions.map(session => {
            const title =
              namedSessionTitle(session.title, session.sessionId) ??
              t('agents.sessionRow.untitled');
            return (
              <View key={session.sessionId} className="min-h-14 flex-row items-center gap-2 px-4">
                <Pressable
                  onPress={() => {
                    navigateToSession(session.sessionId, todo.list.organizationId);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={title}
                  className="min-w-0 flex-1 gap-0.5 py-2 active:opacity-70"
                >
                  <Text className="text-base text-foreground" numberOfLines={1}>
                    {title}
                  </Text>
                  <TodoStatusChip sessions={[session]} />
                </Pressable>
                <Pressable
                  onPress={() => {
                    unlinkSession.mutate({ id: todo.id, sessionId: session.sessionId });
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('todos.item.unlinkSession', { title })}
                  className="size-11 items-center justify-center active:opacity-70"
                >
                  <Unlink size={18} color={colors.mutedForeground} />
                </Pressable>
              </View>
            );
          })
        )}

        <View className="gap-3 px-4 pt-4">
          <Button
            size="lg"
            loading={startingTodoId === todo.id}
            onPress={() => {
              review(todo, todo.list);
            }}
            onLongPress={() => {
              void startNow(todo, todo.list);
            }}
            accessibilityHint={t('todos.item.startNowHint')}
          >
            <Play size={16} color={colors.primaryForeground} />
            <Text>{t('agentChat.newSession.startSession')}</Text>
          </Button>
          <Button
            variant="outline"
            size="lg"
            onPress={() => {
              setLinking(true);
            }}
          >
            <Link2 size={16} color={colors.foreground} />
            <Text>{t('todos.item.linkSession')}</Text>
          </Button>
        </View>
      </ScrollView>
      <TodoLinkSessionSheet
        visible={linking}
        todo={todo}
        list={todo.list}
        onLink={sessionId => {
          setLinking(false);
          linkSession.mutate({ id: todo.id, sessionId, origin: 'linked' });
        }}
        onClose={() => {
          setLinking(false);
        }}
      />
    </KeyboardAvoidingView>
  );
}

/** One to-do: its title, Markdown notes, linked sessions, and the ways to start or link one. */
export function TodoDetailScreen({ itemId }: Readonly<{ itemId: string }>) {
  const query = useTodoItem(itemId);
  const todo = query.data;
  const title = todo ? [todo.list.emoji, todo.list.name].filter(Boolean).join(' ') : '';

  let body: ReactNode = null;
  if (todo) {
    body = <TodoDetailBody key={todo.id} todo={todo} />;
  } else if (query.isError) {
    body = (
      <QueryError
        variant={query.error.data?.code === 'NOT_FOUND' ? 'not-found' : 'server'}
        placement="top"
        onRetry={query.error.data?.code === 'NOT_FOUND' ? undefined : () => void query.refetch()}
        isRetrying={query.isFetching}
      />
    );
  } else {
    body = (
      <View className="gap-3 px-4 pt-4">
        <Skeleton className="h-7 w-3/4 rounded" />
        <Skeleton className="h-4 w-1/2 rounded" />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} reserveTitleSpace backFallback={LISTS_HREF} />
      {body}
    </View>
  );
}
