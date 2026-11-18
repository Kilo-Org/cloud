import { type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import {
  rememberUserSessionTitle,
  SESSION_TITLE_MAX_LENGTH,
} from '@/components/agents/session-detail-rename-state';
import { i18n } from '@/i18n';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { invalidateTodoQueries, type TodoTrpcQueries } from '@/lib/hooks/use-todos';
import { trpcClient } from '@/lib/trpc';

/** The link path reads to-dos and refreshes the started session's caches. */
type StartedTodoSessionQueries = TodoTrpcQueries &
  Parameters<typeof invalidateAgentSessionQueries>[1];

/**
 * Link a session that was just started from a to-do, and name it after that
 * to-do. The session already exists, so a failed link only toasts; one retry
 * covers a dropped request. Every step is fenced to the account that started
 * the session: after a sign-out or account switch the rest is skipped silently,
 * so nothing is linked, renamed, or reported under the next account.
 */
export async function linkStartedTodoSession(input: {
  queryClient: QueryClient;
  trpc: StartedTodoSessionQueries;
  todoId: string;
  sessionId: string;
  /** The to-do's title: the started session's initial name. */
  title?: string;
}): Promise<void> {
  const { queryClient, trpc, todoId, sessionId, title } = input;
  const epoch = currentAuthEpoch();
  const isCurrent = () => isCurrentAuthEpoch(epoch) && !isSignOutActive();
  const link = { id: todoId, sessionId, origin: 'started' as const };
  try {
    await trpcClient.todos.items.linkSession.mutate(link);
  } catch {
    if (!isCurrent()) {
      return;
    }
    try {
      await trpcClient.todos.items.linkSession.mutate(link);
    } catch {
      if (isCurrent()) {
        toast.error(i18n.t('todos.item.linkFailed'));
      }
      return;
    }
  }
  if (!isCurrent()) {
    return;
  }
  await invalidateTodoQueries(queryClient, trpc);
  const sessionTitle = title?.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
  if (!sessionTitle || !isCurrent()) {
    return;
  }
  try {
    await trpcClient.cliSessionsV2.rename.mutate({ session_id: sessionId, title: sessionTitle });
  } catch (error) {
    if (isCurrent()) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : i18n.t('common.somethingWentWrong')
      );
    }
    return;
  }
  if (!isCurrent()) {
    return;
  }
  rememberUserSessionTitle(sessionId, sessionTitle);
  await invalidateAgentSessionQueries(queryClient, trpc);
}
