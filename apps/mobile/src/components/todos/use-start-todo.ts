import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { notificationHaptic } from '@/lib/haptics';
import { type Href } from 'expo-router';
import { useCallback } from 'react';
import { toast } from 'sonner-native';

import { appendNewSessionPrefill } from '@/components/agents/new-session-prefill';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { useNewSessionNavigator } from '@/components/agents/use-new-session-navigator';
import { i18n } from '@/i18n';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { startAgent } from '@/lib/app-actions/start-agent';
import { linkStartedTodoSession } from '@/lib/hooks/todo-session-link';
import { useKeyedSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { todoSessionPrompt } from '@/lib/todos/todo-model';
import { type TodoList } from '@/lib/todos/todo-types';
import { useTRPC } from '@/lib/trpc';

type StartableTodo = { id: string; title: string; notes: string | null };
type StartDefaults = Pick<TodoList, 'organizationId' | 'gitUrl' | 'mode' | 'model' | 'variant'>;

/** The refusal a start publishes; the toast owns the copy, the row only its spinner. */
type StartTodoFailure = { readonly kind: 'start-failed' };

/** What the to-do screens get from `useStartTodo`. */
export type StartTodoControls = {
  review: (todo: StartableTodo, list: StartDefaults) => void;
  startNow: (todo: StartableTodo, list: StartDefaults) => Promise<void>;
  /** Whether this to-do's start is in flight, for its row's spinner and control. */
  isStarting: (todoId: string) => boolean;
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
  // One admission per to-do: a to-do already starting refuses a second press,
  // and its row reads the pending entry for its spinner.
  const starts = useKeyedSurfaceFeedback<string, StartTodoFailure>();

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
      const attempt = starts.begin(todo.id);
      if (attempt === null) {
        return;
      }
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
          attempt.fail({ kind: 'start-failed' });
          toast.error(result.message);
          return;
        }
        notificationHaptic(Haptics.NotificationFeedbackType.Success);
        // The session exists now: that is the start's outcome, so the row's
        // spinner ends here and the token publishes nothing.
        attempt.abandon();
        // Nothing below may stop the session from opening: a failed link or
        // cache refresh is reported and the session still opens.
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
        attempt.fail({ kind: 'start-failed' });
        toast.error(i18n.t('common.somethingWentWrong'));
      }
    },
    [navigateToSession, queryClient, review, starts, trpc]
  );

  const isStarting = useCallback(
    (todoId: string) => starts.snapshot.states.get(todoId)?.status === 'pending',
    [starts.snapshot.states]
  );

  return { review, startNow, isStarting };
}
