// The session's change capture and its refresh: the session, its Cloud Agent
// session, the saved worktree snapshot, and — for a session with no Cloud Agent
// — the read-only session diff. Kept out of the screen so the screen file stays
// a render tree.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { sessionDiffFileToPrReviewFile } from '@/lib/session-changes';
import { trpcClient, useTRPC } from '@/lib/trpc';

export function useSessionChangesData(sessionId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const sessionQuery = useQuery(trpc.cliSessionsV2.get.queryOptions({ session_id: sessionId }));
  const cloudAgentSessionId = sessionQuery.data?.cloud_agent_session_id ?? null;
  const organizationId = sessionQuery.data?.organization_id ?? undefined;
  const readOnly = sessionQuery.isSuccess && cloudAgentSessionId === null;

  const cloudSessionKey = [
    'session-changes',
    'cloud-session',
    cloudAgentSessionId,
    organizationId ?? null,
  ] as const;
  const cloudSessionQuery = useQuery({
    queryKey: cloudSessionKey,
    queryFn: () => {
      if (cloudAgentSessionId === null) {
        throw new Error('No Cloud Agent session');
      }
      return organizationId
        ? trpcClient.organizations.cloudAgentNext.getSession.query({
            cloudAgentSessionId,
            organizationId,
          })
        : trpcClient.cloudAgentNext.getSession.query({ cloudAgentSessionId });
    },
    enabled: cloudAgentSessionId !== null,
  });

  const changesKey = [
    'session-changes',
    'worktree-changes',
    cloudAgentSessionId,
    organizationId ?? null,
  ] as const;
  const changesQuery = useQuery({
    queryKey: changesKey,
    queryFn: () => {
      if (cloudAgentSessionId === null) {
        throw new Error('No Cloud Agent session');
      }
      return organizationId
        ? trpcClient.organizations.cloudAgentNext.getWorktreeChanges.query({
            cloudAgentSessionId,
            organizationId,
          })
        : trpcClient.cloudAgentNext.getWorktreeChanges.query({ cloudAgentSessionId });
    },
    enabled: cloudAgentSessionId !== null,
  });
  const snapshot = changesQuery.data?.snapshot ?? null;

  const legacyDiffQuery = useQuery({
    ...trpc.cliSessionsV2.getSessionDiff.queryOptions({ session_id: sessionId }),
    enabled: readOnly,
  });

  const [refreshFailed, setRefreshFailed] = useState(false);
  const refreshMutation = useMutation({
    mutationFn: () => {
      if (cloudAgentSessionId === null) {
        throw new Error('No Cloud Agent session');
      }
      return organizationId
        ? trpcClient.organizations.cloudAgentNext.refreshWorktreeChanges.mutate({
            cloudAgentSessionId,
            organizationId,
          })
        : trpcClient.cloudAgentNext.refreshWorktreeChanges.mutate({ cloudAgentSessionId });
    },
    onSuccess: result => {
      if (result.snapshot) {
        queryClient.setQueryData(changesKey, { snapshot: result.snapshot });
      }
      setRefreshFailed(result.status !== 'refreshed');
    },
    onError: () => {
      setRefreshFailed(true);
    },
  });
  const refreshing = refreshMutation.isPending;
  const refresh = useCallback(() => {
    if (cloudAgentSessionId === null) {
      return;
    }
    setRefreshFailed(false);
    refreshMutation.mutate();
  }, [cloudAgentSessionId, refreshMutation]);

  const legacyFiles = useMemo(
    () =>
      legacyDiffQuery.data?.kind === 'files'
        ? legacyDiffQuery.data.files.map(sessionDiffFileToPrReviewFile)
        : null,
    [legacyDiffQuery.data]
  );

  return {
    sessionQuery,
    cloudAgentSessionId,
    organizationId,
    readOnly,
    cloudSessionQuery,
    cloudSession: cloudSessionQuery.data,
    changesQuery,
    changesKey,
    snapshot,
    legacyDiffQuery,
    legacyFiles,
    refreshing,
    refresh,
    refreshFailed,
  };
}
