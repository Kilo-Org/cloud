import {
  getNextSecurityFindingsOffset,
  isActiveRemediationStatus,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { trackSecurityAgentCommand } from '@/lib/hooks/use-security-agent-commands';
import {
  isSecuritySyncRetryable,
  mapSecurityDismissOperationError,
} from '@/lib/hooks/use-security-agent-mutations';
import { useHoistedOperationKey } from '@/lib/operation-key';
import { type SecurityAnalysis } from '@/lib/security-agent';
import { trpcClient, useTRPC } from '@/lib/trpc';

// Personal and org procedures resolve to nominally distinct tRPC option
// types even when structurally identical, so we always call both hooks (one
// disabled) and return whichever is active. See use-code-reviewer.ts:32.

type ListFindingsFilters = Parameters<typeof trpcClient.securityAgent.listFindings.query>[0];

export function useSecurityFindings(scope: string, filters: ListFindingsFilters) {
  const trpc = useTRPC();
  const isPersonal = isPersonalSecurityScope(scope);
  const baseQueryKey = isPersonal
    ? trpc.securityAgent.listFindings.queryKey()
    : trpc.organizations.securityAgent.listFindings.queryKey({ organizationId: scope });

  return useInfiniteQuery({
    queryKey: [...baseQueryKey, filters],
    initialPageParam: filters.offset ?? 0,
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    queryFn: ({ pageParam }) =>
      isPersonal
        ? trpcClient.securityAgent.listFindings.query({ ...filters, offset: pageParam })
        : trpcClient.organizations.securityAgent.listFindings.query({
            organizationId: scope,
            ...filters,
            offset: pageParam,
          }),
    getNextPageParam: (lastPage, pages) => {
      const loadedCount = pages.reduce((count, page) => count + page.findings.length, 0);
      return getNextSecurityFindingsOffset(filters.offset ?? 0, loadedCount, lastPage.totalCount);
    },
  });
}

export function useSecurityFinding(scope: string, id: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getFinding.queryOptions({ id }),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getFinding.queryOptions({ organizationId: scope, id }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
}

const ANALYSIS_POLL_INTERVAL_MS = 3000;

// Poll only while there's something in flight: analysis still running, or a
// remediation attempt still active. Mirrors FindingDetailDialog.tsx's
// pollWhileActive and use-code-reviews.ts's refetchInterval convention.
function isSecurityAnalysisActive(data: SecurityAnalysis | undefined): boolean {
  if (!data) {
    return false;
  }
  if (data.status === 'pending' || data.status === 'running') {
    return true;
  }
  return data.remediationAttempts.some(attempt => isActiveRemediationStatus(attempt.status));
}

export function useSecurityAnalysis(scope: string, findingId: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getAnalysis.queryOptions({ findingId }),
    enabled: isPersonalSecurityScope(scope),
    refetchInterval: query =>
      isSecurityAnalysisActive(query.state.data) ? ANALYSIS_POLL_INTERVAL_MS : false,
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getAnalysis.queryOptions({
      organizationId: scope,
      findingId,
    }),
    enabled: !isPersonalSecurityScope(scope),
    refetchInterval: query =>
      isSecurityAnalysisActive(query.state.data) ? ANALYSIS_POLL_INTERVAL_MS : false,
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
}

// No hook-level onError toast: dismiss-finding-screen.tsx is the sole caller
// and is a form sheet that stays open on failure — it renders
// `dismissFinding.isError` inline above the confirm button instead (P2).

/**
 * Intent fingerprint for a finding dismissal (P1-A-08e): a form edit or a
 * scope change is a new intent.
 */
export function dismissFindingIntentFingerprint(
  scope: string,
  vars: Parameters<typeof trpcClient.securityAgent.dismissFinding.mutate>[0]
): string {
  return JSON.stringify({
    resource: [scope],
    findingId: vars.findingId,
    reason: vars.reason,
    comment: vars.comment,
  });
}

export function useDismissSecurityFinding(scope: string) {
  const queryClient = useQueryClient();
  const { getKey, rotateKey } = useHoistedOperationKey();
  return useMutation({
    mutationFn: async (
      vars: Parameters<typeof trpcClient.securityAgent.dismissFinding.mutate>[0]
    ) => {
      const operationKey = getKey(dismissFindingIntentFingerprint(scope, vars));
      try {
        const result = isPersonalSecurityScope(scope)
          ? await trpcClient.securityAgent.dismissFinding.mutate({ ...vars, operationKey })
          : await trpcClient.organizations.securityAgent.dismissFinding.mutate({
              organizationId: scope,
              ...vars,
              operationKey,
            });
        rotateKey();
        return result;
      } catch (error) {
        if (!isSecuritySyncRetryable(error)) {
          rotateKey();
        }
        // Map the raw `operation_in_progress` CONFLICT marker onto retryable
        // dismissal copy before the form renders it inline (P2).
        throw mapSecurityDismissOperationError(error);
      }
    },
    onSuccess: result => {
      if (result.commandId) {
        trackSecurityAgentCommand(queryClient, scope, result.commandId);
      }
    },
  });
}

export function useStartSecurityAnalysis(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: Parameters<typeof trpcClient.securityAgent.startAnalysis.mutate>[0]) =>
      isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.startAnalysis.mutate(vars)
        : trpcClient.organizations.securityAgent.startAnalysis.mutate({
            organizationId: scope,
            ...vars,
          }),
    onError: error => {
      toast.error(error.message);
    },
    onSuccess: async (result, vars) => {
      trackSecurityAgentCommand(queryClient, scope, result.commandId);
      if (isPersonalSecurityScope(scope)) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getAnalysis.queryKey({ findingId: vars.findingId }),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getFinding.queryKey({ id: vars.findingId }),
          }),
          queryClient.invalidateQueries({ queryKey: trpc.securityAgent.listFindings.queryKey() }),
        ]);
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getAnalysis.queryKey({
            organizationId: scope,
            findingId: vars.findingId,
          }),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getFinding.queryKey({
            organizationId: scope,
            id: vars.findingId,
          }),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.listFindings.queryKey({
            organizationId: scope,
          }),
        }),
      ]);
    },
  });
}
