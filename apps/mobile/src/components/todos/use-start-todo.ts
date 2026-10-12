import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { toast } from 'sonner-native';

import { appendNewSessionPrefill } from '@/components/agents/new-session-prefill';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { startAgent } from '@/lib/app-actions/start-agent';
import { linkStartedTodoSession } from '@/lib/hooks/use-todos';
import { todoSessionPrompt } from '@/lib/todos/todo-model';
import { type TodoList } from '@/lib/todos/todo-types';
import { useTRPC } from '@/lib/trpc';

type StartableTodo = { id: string; title: string; notes: string | null };
type StartDefaults = Pick<TodoList, 'organizationId' | 'gitUrl' | 'mode' | 'model' | 'variant'>;

/** The new-session route prefilled from a to-do and its list's defaults. */
function todoNewSessionHref(todo: StartableTodo, list: StartDefaults): Href {
  const base = list.organizationId
    ? `/(app)/agent-chat/new?organizationId=${encodeURIComponent(list.organizationId)}`
    : '/(app)/agent-chat/new';
  return appendNewSessionPrefill(base, {
    repo: list.gitUrl ?? undefined,
    mode: list.mode ?? undefined,
    model: list.model ?? undefined,
    variant: list.variant ?? undefined,
    prompt: todoSessionPrompt(todo),
    todoId: todo.id,
  }) as Href;
}

/**
 * Start a session from a to-do. `review` opens the prefilled new-session
 * screen; `startNow` sends at once through the same `startAgent` prepare the
 * OS surfaces use, links the session, and opens it. Sending at once needs the
 * list's repository, so without one `startNow` falls back to the review.
 */
export function useStartTodo() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const navigateToSession = useAgentSessionNavigator();
  const [startingTodoId, setStartingTodoId] = useState<string | null>(null);

  const review = useCallback(
    (todo: StartableTodo, list: StartDefaults) => {
      router.push(todoNewSessionHref(todo, list));
    },
    [router]
  );

  const startNow = useCallback(
    async (todo: StartableTodo, list: StartDefaults) => {
      if (!list.gitUrl) {
        review(todo, list);
        return;
      }
      setStartingTodoId(todo.id);
      try {
        const result = await startAgent({
          prompt: todoSessionPrompt(todo),
          repository: list.gitUrl,
          mode: list.mode ?? undefined,
          model: list.model ?? undefined,
          variant: list.variant ?? undefined,
          organizationId: list.organizationId ?? undefined,
        });
        if (!result.ok || !result.sessionId) {
          toast.error(result.message);
          return;
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await Promise.all([
          linkStartedTodoSession({
            queryClient,
            trpc,
            todoId: todo.id,
            sessionId: result.sessionId,
          }),
          invalidateAgentSessionQueries(queryClient, trpc),
        ]);
        navigateToSession(result.sessionId, list.organizationId);
      } finally {
        setStartingTodoId(current => (current === todo.id ? null : current));
      }
    },
    [navigateToSession, queryClient, review, trpc]
  );

  return { review, startNow, startingTodoId };
}
