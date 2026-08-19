// Remediation write hooks for a security finding: start, retry, and cancel.
// Split out of `use-security-findings.ts` (which keeps the finding queries and
// the dismiss hook) so each file stays under the max-lines limit.
import {
  getRemediationUnavailableCopy,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { reconcileFirstPage } from '@/lib/query/infinite-retention';
import { scheduleCacheMaintenance } from '@/lib/query/schedule-cache-maintenance';
import { type SecurityAnalysis } from '@/lib/security-agent';
import { trpcClient, useTRPC } from '@/lib/trpc';

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
      queryClient.invalidateQueries({ queryKey: trpc.securityAgent.getDashboardStats.queryKey() }),
    ]);
    scheduleCacheMaintenance(() => {
      reconcileFirstPage(queryClient, trpc.securityAgent.listFindings.queryKey());
    });
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
      queryKey: trpc.organizations.securityAgent.getDashboardStats.queryKey(ownerInput),
    }),
  ]);
  scheduleCacheMaintenance(() => {
    reconcileFirstPage(
      queryClient,
      trpc.organizations.securityAgent.listFindings.queryKey(ownerInput)
    );
  });
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
