import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useTRPC } from '@/lib/trpc/utils';
import { WORKSPACE_STALE_STATUS_MS } from '@/lib/cloud-agent/workspace-activity';
import { apiSessionToDbSession } from '../store/db-session-atoms';
import { dbSessionToStoredSession } from './sidebar-session-model';
import { sidebarQueryScopeKey, sidebarScopeKey, type sidebarListInput } from './sidebar-queries';

export const PR_LINK_ATTEMPT_HISTORY_LIMIT = 1000;

export function recordPrLinkVerificationAttempt(
  attempted: Map<string, string>,
  sessionId: string,
  verificationKey: string
) {
  attempted.delete(sessionId);
  attempted.set(sessionId, verificationKey);
  if (attempted.size > PR_LINK_ATTEMPT_HISTORY_LIMIT) {
    const oldest = attempted.keys().next().value;
    if (oldest !== undefined) attempted.delete(oldest);
  }
}

export function shouldRetryPrLinkVerification(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1 || !(error instanceof TRPCClientError)) return false;
  const code: unknown = error.data?.code;
  return (
    [
      'INTERNAL_SERVER_ERROR',
      'BAD_GATEWAY',
      'SERVICE_UNAVAILABLE',
      'GATEWAY_TIMEOUT',
      'TIMEOUT',
    ].includes(typeof code === 'string' ? code : '') ||
    (code === undefined && error.cause instanceof TypeError)
  );
}

export function nextPrLinkVerification(
  sessions: readonly { session_id: string; prLinkVerificationKey?: string }[],
  attempted: ReadonlyMap<string, string>
) {
  return sessions.find(
    session =>
      session.prLinkVerificationKey !== undefined &&
      attempted.get(session.session_id) !== session.prLinkVerificationKey
  );
}

export type SidebarSearchInput = {
  search_string: string;
  organizationId: string | null;
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
};

export function getStandaloneSessionRefetchInterval(
  sessions: readonly {
    status: string | null;
    updated_at: string;
    latest_run_status?: string | null;
    associatedPr?: { reviewDecisionPending: boolean } | null;
  }[],
  now = Date.now()
): number | false {
  if (sessions.some(session => session.associatedPr?.reviewDecisionPending)) return 5_000;
  return sessions.some(
    session =>
      now - Date.parse(session.updated_at) < WORKSPACE_STALE_STATUS_MS &&
      (session.status === 'busy' ||
        session.status === 'retry' ||
        session.latest_run_status === 'queued' ||
        session.latest_run_status === 'accepted')
  )
    ? 30_000
    : false;
}

export function useStandaloneSessions({
  listInput,
  searchInput,
  isSearchActive,
  onPrChanged,
}: {
  listInput: ReturnType<typeof sidebarListInput>;
  searchInput: SidebarSearchInput;
  isSearchActive: boolean;
  onPrChanged: () => void;
}) {
  const trpc = useTRPC();
  const list = useQuery({
    ...trpc.cliSessionsV2.list.queryOptions(listInput),
    staleTime: 5_000,
    enabled: !isSearchActive,
    refetchInterval: query =>
      getStandaloneSessionRefetchInterval(query.state.data?.cliSessions ?? []),
  });
  const search = useQuery({
    ...trpc.cliSessionsV2.search.queryOptions(searchInput),
    staleTime: 5_000,
    enabled: isSearchActive,
    placeholderData: (previous, query) =>
      query && sidebarQueryScopeKey(query.queryKey) === sidebarScopeKey(searchInput)
        ? previous
        : undefined,
    refetchInterval: query => getStandaloneSessionRefetchInterval(query.state.data?.results ?? []),
  });
  const attempted = useRef(new Map<string, string>());
  const { mutate: verifyPrLink, isPending } = useMutation({
    ...trpc.cliSessionsV2.refreshAssociatedPullRequest.mutationOptions(),
    retry: shouldRetryPrLinkVerification,
    onSuccess: result => {
      if (result.associatedPr) onPrChanged();
    },
  });
  const rows = isSearchActive ? search.data?.results : list.data?.cliSessions;
  useEffect(() => {
    if (isPending || !rows) return;
    const candidate = nextPrLinkVerification(rows, attempted.current);
    if (!candidate?.prLinkVerificationKey) return;
    recordPrLinkVerificationAttempt(
      attempted.current,
      candidate.session_id,
      candidate.prLinkVerificationKey
    );
    verifyPrLink({ sessionId: candidate.session_id });
  }, [isPending, rows, verifyPrLink]);
  const standaloneSessions = useMemo(
    () =>
      list.data?.cliSessions.map(row => dbSessionToStoredSession(apiSessionToDbSession(row))) ?? [],
    [list.data?.cliSessions]
  );
  const sessions = useMemo(
    () =>
      isSearchActive
        ? (search.data?.results.map(row => dbSessionToStoredSession(apiSessionToDbSession(row))) ??
          [])
        : standaloneSessions,
    [isSearchActive, search.data?.results, standaloneSessions]
  );
  return {
    sessions,
    standaloneSessions,
    isLoading: !isSearchActive && list.isLoading,
    isFetching: isSearchActive ? search.isFetching : list.isFetching,
  };
}
