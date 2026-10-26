import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { TodoLinkSessionSheet } from '@/components/todos/todo-link-session-sheet';
import { useStartTodo } from '@/components/todos/use-start-todo';
import { Button } from '@/components/ui/button';
import { DirectionalArrowRight } from '@/components/ui/directional-icons';
import { Link2, Play } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useTodoItemMutations } from '@/lib/hooks/use-todos';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type TodoItemDetail } from '@/lib/todos/todo-types';

/**
 * The task's session actions. With a linked session, Open session leads and
 * Start new session is secondary; with none, Start session is the primary.
 * Link session stays outline.
 */
export function TodoStartActions({
  todo,
  organizationId,
}: Readonly<{ todo: TodoItemDetail; organizationId: string | null }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { linkSession } = useTodoItemMutations(todo.listId);
  const { review, startNow, startingTodoId } = useStartTodo();
  const navigateToSession = useAgentSessionNavigator();
  const [linking, setLinking] = useState(false);
  const newestSession = todo.sessions[0] ?? null;

  const startButton = (
    <Button
      size="lg"
      variant={newestSession ? 'outline' : 'default'}
      loading={startingTodoId === todo.id}
      onPress={() => {
        review(todo, todo.list);
      }}
      onLongPress={() => {
        void startNow(todo, todo.list);
      }}
      accessibilityHint={t('todos.item.startNowHint')}
    >
      <Play size={16} color={newestSession ? colors.foreground : colors.primaryForeground} />
      <Text>
        {newestSession ? t('todos.item.startNewSession') : t('agentChat.newSession.startSession')}
      </Text>
    </Button>
  );

  return (
    <View className="gap-3 px-4 pt-4">
      {newestSession ? (
        <Button
          size="lg"
          onPress={() => {
            navigateToSession(newestSession.sessionId, organizationId);
          }}
        >
          <DirectionalArrowRight size={16} color={colors.primaryForeground} />
          <Text>{t('notifications.action.openSession')}</Text>
        </Button>
      ) : null}
      {startButton}
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
    </View>
  );
}
