import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { notificationHaptic } from '@/lib/haptics';
import { type Href } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner-native';

import { appendNewSessionPrefill } from '@/components/agents/new-session-prefill';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { useNewSessionNavigator } from '@/components/agents/use-new-session-navigator';
import { i18n } from '@/i18n';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { startAgent } from '@/lib/app-actions/start-agent';
import { linkStartedTodoSession } from '@/lib/hooks/todo-session-link';
import { todoSessionPrompt } from '@/lib/todos/todo-model';
import { type TodoList } from '@/lib/todos/todo-types';
import { useTRPC } from '@/lib/trpc';

type StartableTodo = { id: string; title: string; notes: string | null };
type StartDefaults = Pick<TodoList, 'organizationId' | 'gitUrl' | 'mode' | 'model' | 'variant'>;

/** What the to-do screens get from `useStartTodo`. */
export type StartTodoControls = {
  review: (todo: StartableTodo, list: StartDefaults) => void;
  startNow: (todo: StartableTodo, list: StartDefaults) => Promise<void>;
  /** The to-do whose start is in flight, for its row's spinner. */
  startingTodoId: string | null;
};

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
    todoTitle: todo.title,
  }) as Href;
}

/**
 * Start a session from a to-do. `review` opens the prefilled new-session
 * screen; `startNow` sends at once through the same `startAgent` prepare the
 * OS surfaces use, links the session, and opens it. Sending at once needs the
 * list's repository, so without one `startNow` falls back to the review.
 */
export function useStartTodo(): StartTodoControls {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const navigateToSession = useAgentSessionNavigator();
  const { openNewSessionHref } = useNewSessionNavigator();
  const [startingTodoId, setStartingTodoId] = useState<string | null>(null);
  // A to-do already starting ignores a second press. Held in a ref because the
  // state that drives the spinner lands after this tick.
  const startingRef = useRef(new Set<string>());

  const review = useCallback(
    (todo: StartableTodo, list: StartDefaults) => {
      openNewSessionHref(todoNewSessionHref(todo, list));
    },
    [openNewSessionHref]
  );

  const startNow = useCallback(
    async (todo: StartableTodo, list: StartDefaults) => {
      if (!list.gitUrl) {
        review(todo, list);
        return;
      }
      if (startingRef.current.has(todo.id)) {
        return;
      }
      startingRef.current.add(todo.id);
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
        notificationHaptic(Haptics.NotificationFeedbackType.Success);
        // The session exists now, so nothing below may stop it from opening: a
        // failed link or cache refresh is reported and the session still opens.
        const settled = await Promise.allSettled([
          linkStartedTodoSession({
            queryClient,
            trpc,
            todoId: todo.id,
            sessionId: result.sessionId,
            title: todo.title,
          }),
          invalidateAgentSessionQueries(queryClient, trpc),
        ]);
        if (settled.some(outcome => outcome.status === 'rejected')) {
          toast.error(i18n.t('todos.item.startRefreshFailed'));
        }
        navigateToSession(result.sessionId, list.organizationId);
      } catch {
        // Callers fire this without awaiting, so a failure has to be reported
        // here rather than escape as an unhandled rejection.
        toast.error(i18n.t('common.somethingWentWrong'));
      } finally {
        startingRef.current.delete(todo.id);
        setStartingTodoId(current => (current === todo.id ? null : current));
      }
    },
    [navigateToSession, queryClient, review, trpc]
  );

  return { review, startNow, startingTodoId };
}
