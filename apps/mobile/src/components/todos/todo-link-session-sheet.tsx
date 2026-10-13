import { useInfiniteQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { namedSessionTitle } from '@/components/agents/session-detail-rename-state';
import { formatGitUrlProject } from '@/components/agents/session-list-helpers';
import { QueryError } from '@/components/query-error';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { buildStoredSessionsQueryOptions } from '@/lib/hooks/use-agent-sessions';
import { type TodoItem, type TodoList } from '@/lib/todos/todo-types';
import { useTRPC } from '@/lib/trpc';

type TodoLinkSessionSheetProps = {
  visible: boolean;
  todo: Pick<TodoItem, 'id' | 'sessions'>;
  list: Pick<TodoList, 'organizationId' | 'gitUrl'>;
  onLink: (sessionId: string) => void;
  onClose: () => void;
};

/**
 * Recent sessions to link to a to-do: those in the list's repository when it
 * names one, never the sessions already linked.
 */
export function TodoLinkSessionSheet({
  visible,
  todo,
  list,
  onLink,
  onClose,
}: Readonly<TodoLinkSessionSheetProps>) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const { bottom } = useSafeAreaInsets();
  const sessions = useInfiniteQuery(
    buildStoredSessionsQueryOptions(trpc, {
      organizationId: list.organizationId,
      enabled: visible,
    })
  );

  const candidates = useMemo(() => {
    const linked = new Set(todo.sessions.map(session => session.sessionId));
    const repo = list.gitUrl?.toLowerCase();
    const page = sessions.data?.pages[0];
    return (page?.cliSessions ?? []).filter(
      session =>
        !linked.has(session.session_id) &&
        (!repo ||
          (session.git_url ? formatGitUrlProject(session.git_url).toLowerCase() === repo : false))
    );
  }, [list.gitUrl, sessions.data, todo.sessions]);

  let body: ReactNode = null;
  if (sessions.isPending) {
    body = (
      <View className="items-center py-8">
        <ActivityIndicator />
      </View>
    );
  } else if (sessions.isError) {
    body = (
      <QueryError
        placement="static"
        onRetry={() => void sessions.refetch()}
        isRetrying={sessions.isFetching}
      />
    );
  } else if (candidates.length === 0) {
    body = (
      <Text className="px-5 py-8 text-center text-sm text-muted-foreground">
        {list.gitUrl
          ? t('todos.linkSession.emptyInRepository', { repository: list.gitUrl })
          : t('todos.linkSession.empty')}
      </Text>
    );
  } else {
    body = candidates.map(session => {
      const title =
        namedSessionTitle(session.title, session.session_id) ?? t('agents.sessionRow.untitled');
      return (
        <Pressable
          key={session.session_id}
          onPress={() => {
            onLink(session.session_id);
          }}
          accessibilityRole="button"
          accessibilityLabel={title}
          className="min-h-14 justify-center gap-0.5 border-b border-hair-soft px-5 py-2 active:opacity-70"
        >
          <Text className="text-base text-foreground" numberOfLines={1}>
            {title}
          </Text>
          {session.git_url ? (
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {formatGitUrlProject(session.git_url)}
            </Text>
          ) : null}
        </Pressable>
      );
    });
  }

  return (
    <Sheet visible={visible} onClose={onClose} snapPoints={['70%']}>
      <View className="flex-1 pt-4">
        <Text accessibilityRole="header" className="px-5 pb-3 text-base font-semibold">
          {t('todos.linkSession.title')}
        </Text>
        <ScrollView contentContainerStyle={{ paddingBottom: bottom + 16 }}>{body}</ScrollView>
      </View>
    </Sheet>
  );
}
