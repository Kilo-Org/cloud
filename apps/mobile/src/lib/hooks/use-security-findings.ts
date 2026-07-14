import {
  getNextSecurityFindingsOffset,
  getRemediationUnavailableCopy,
  isActiveRemediationStatus,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { trackSecurityAgentCommand } from '@/lib/hooks/use-security-agent-commands';
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
export function useDismissSecurityFinding(scope: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: Parameters<typeof trpcClient.securityAgent.dismissFinding.mutate>[0]) =>
      isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.dismissFinding.mutate(vars)
        : trpcClient.organizations.securityAgent.dismissFinding.mutate({
            organizationId: scope,
            ...vars,
          }),
    onSuccess: result => {
      trackSecurityAgentCommand(queryClient, scope, result.commandId);
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

async function invalidateRemediationQueries(
  deps: {
    trpc: ReturnType<typeof useTRPC>;
    queryClient: ReturnType<typeof useQueryClient>;
  },
  target: { scope: string; findingId: string }
): Promise<void> {
  const { trpc, queryClient } = deps;
  const { scope, findingId } = target;
  if (isPersonalSecurityScope(scope)) {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.securityAgent.getAnalysis.queryKey({ findingId }),
      }),
      queryClient.invalidateQueries({ queryKey: trpc.securityAgent.getFinding.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.securityAgent.listFindings.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.securityAgent.getDashboardStats.queryKey() }),
    ]);
    return;
  }
  const ownerInput = { organizationId: scope };
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: trpc.organizations.securityAgent.getAnalysis.queryKey({
        ...ownerInput,
        findingId,
      }),
    }),
    queryClient.invalidateQueries({
      queryKey: trpc.organizations.securityAgent.getFinding.queryKey(ownerInput),
    }),
    queryClient.invalidateQueries({
      queryKey: trpc.organizations.securityAgent.listFindings.queryKey(ownerInput),
    }),
    queryClient.invalidateQueries({
      queryKey: trpc.organizations.securityAgent.getDashboardStats.queryKey(ownerInput),
    }),
  ]);
}

export function useStartSecurityRemediation(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: Parameters<typeof trpcClient.securityAgent.startRemediation.mutate>[0]) =>
      isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.startRemediation.mutate(vars)
        : trpcClient.organizations.securityAgent.startRemediation.mutate({
            organizationId: scope,
            ...vars,
          }),
    onError: error => {
      toast.error(error.message);
    },
    onSuccess: async (result, vars) => {
      if (!result.queued) {
        toast.error(
          getRemediationUnavailableCopy(result.reason) ??
            'Remediation is unavailable for this finding.'
        );
      } else {
        toast.success('Remediation queued');
      }
      await invalidateRemediationQueries(
        { trpc, queryClient },
        { scope, findingId: vars.findingId }
      );
    },
  });
}

export function useRetrySecurityRemediation(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: Parameters<typeof trpcClient.securityAgent.retryRemediation.mutate>[0]) =>
      isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.retryRemediation.mutate(vars)
        : trpcClient.organizations.securityAgent.retryRemediation.mutate({
            organizationId: scope,
            ...vars,
          }),
    onError: error => {
      toast.error(error.message);
    },
    onSuccess: async (result, vars) => {
      if (!result.queued) {
        toast.error(
          getRemediationUnavailableCopy(result.reason) ??
            'Remediation is unavailable for this finding.'
        );
      } else {
        toast.success('Remediation retry queued');
      }
      await invalidateRemediationQueries(
        { trpc, queryClient },
        { scope, findingId: vars.findingId }
      );
    },
  });
}

function getSecurityAnalysisQueryKey(
  trpc: ReturnType<typeof useTRPC>,
  scope: string,
  findingId: string
) {
  return isPersonalSecurityScope(scope)
    ? trpc.securityAgent.getAnalysis.queryKey({ findingId })
    : trpc.organizations.securityAgent.getAnalysis.queryKey({ organizationId: scope, findingId });
}

// cancelRemediation resolves synchronously (no background command to track),
// so — unlike start/retry — we invalidate the affected queries ourselves
// once the immediate result comes back. Reuses invalidateRemediationQueries
// (the same helper start/retry use) so the analysis query — the one that
// actually owns remediationAttempts — is never left stale, which the
// hand-rolled invalidation list here used to miss.
export function useCancelSecurityRemediation(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: { attemptId: string; findingId: string }) =>
      isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.cancelRemediation.mutate({ attemptId: vars.attemptId })
        : trpcClient.organizations.securityAgent.cancelRemediation.mutate({
            organizationId: scope,
            attemptId: vars.attemptId,
          }),
    onMutate: async vars => {
      const analysisQueryKey = getSecurityAnalysisQueryKey(trpc, scope, vars.findingId);
      await queryClient.cancelQueries({ queryKey: analysisQueryKey });
      const previous = queryClient.getQueryData<SecurityAnalysis>(analysisQueryKey);
      queryClient.setQueryData<SecurityAnalysis>(analysisQueryKey, old =>
        old
          ? {
              ...old,
              remediationAttempts: old.remediationAttempts.map(attempt =>
                attempt.id === vars.attemptId
                  ? { ...attempt, cancellationRequestedAt: new Date().toISOString() }
                  : attempt
              ),
            }
          : old
      );
      return { previous, analysisQueryKey };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.analysisQueryKey, context.previous);
      }
      toast.error(error.message);
    },
    onSuccess: result => {
      // 'cancellation_requested' means the attempt was already running and
      // was only asked to stop — it may still finish and produce a PR.
      toast.success(
        result.status === 'cancellation_requested'
          ? 'Cancellation requested'
          : 'Remediation cancelled'
      );
    },
    onSettled: async (_result, _error, vars) => {
      await invalidateRemediationQueries(
        { trpc, queryClient },
        { scope, findingId: vars.findingId }
      );
    },
  });
}
