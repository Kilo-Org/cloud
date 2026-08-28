import type { QueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import type { TRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { RootRouter } from '@/routers/root-router';
import type { DbSession, DbSessionV2 } from './store/db-session-atoms';

type SessionQueryContext = {
  queryClient: QueryClient;
  trpc: Pick<TRPCOptionsProxy<RootRouter>, 'cliSessionsV2' | 'activeSessions'>;
};
type SessionOutputs = inferRouterOutputs<RootRouter>['cliSessionsV2'];
type DbSessions = (DbSession | DbSessionV2)[];
type RemoveDeletedSessionInput = SessionQueryContext & {
  sessionId: string;
  setDbSessions: (update: (sessions: DbSessions) => DbSessions) => void;
  deleteSessionFromStore: (sessionId: string) => Promise<void>;
};

export function invalidateSessionQueries({ queryClient, trpc }: SessionQueryContext) {
  return Promise.all([
    queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter()),
    queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter()),
    queryClient.invalidateQueries(trpc.cliSessionsV2.recentRepositories.pathFilter()),
    queryClient.invalidateQueries(trpc.activeSessions.list.pathFilter()),
  ]);
}

export async function removeDeletedSession({
  sessionId,
  queryClient,
  trpc,
  setDbSessions,
  deleteSessionFromStore,
}: RemoveDeletedSessionInput): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries(trpc.cliSessionsV2.list.pathFilter()),
    queryClient.cancelQueries(trpc.cliSessionsV2.search.pathFilter()),
    queryClient.cancelQueries(trpc.activeSessions.list.pathFilter()),
  ]);

  setDbSessions(sessions => sessions.filter(session => session.session_id !== sessionId));
  queryClient.setQueriesData<SessionOutputs['list']>(
    trpc.cliSessionsV2.list.pathFilter(),
    current =>
      current && {
        ...current,
        cliSessions: current.cliSessions.filter(session => session.session_id !== sessionId),
      }
  );
  queryClient.setQueriesData<SessionOutputs['search']>(
    trpc.cliSessionsV2.search.pathFilter(),
    current =>
      current && {
        ...current,
        results: current.results.filter(session => session.session_id !== sessionId),
      }
  );
  queryClient.setQueryData(
    trpc.activeSessions.list.queryKey(),
    current =>
      current && {
        ...current,
        sessions: current.sessions.filter(session => session.id !== sessionId),
      }
  );

  try {
    await deleteSessionFromStore(sessionId);
  } catch (error) {
    console.error('Error deleting session from IndexedDB:', error);
  }
}
