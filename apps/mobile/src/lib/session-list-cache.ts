import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';

type RouterOutputs = inferRouterOutputs<RootRouter>;
export type SessionsListPage = RouterOutputs['cliSessionsV2']['list'];
export type SessionsListData = { pages: SessionsListPage[]; pageParams: unknown[] };

export function mapStoredSessions(
  data: SessionsListData,
  sessionId: string,
  update: (
    session: SessionsListPage['cliSessions'][number]
  ) => SessionsListPage['cliSessions'][number]
): SessionsListData {
  return {
    ...data,
    pages: data.pages.map(page => ({
      ...page,
      cliSessions: page.cliSessions.map(session =>
        session.session_id === sessionId ? update(session) : session
      ),
    })),
  };
}

export function removeStoredSession(data: SessionsListData, sessionId: string): SessionsListData {
  return {
    ...data,
    pages: data.pages.map(page => ({
      ...page,
      cliSessions: page.cliSessions.filter(session => session.session_id !== sessionId),
    })),
  };
}
