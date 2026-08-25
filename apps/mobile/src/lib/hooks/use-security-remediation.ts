// Remediation write hooks for a security finding: start, retry, and cancel.
// Split out of `use-security-findings.ts` (which keeps the finding queries and
// the dismiss hook) so each file stays under the max-lines limit.
import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import { hashKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { i18n } from '@/i18n';
import { reconcileFirstPage } from '@/lib/query/infinite-retention';
import { scheduleCacheMaintenance } from '@/lib/query/schedule-cache-maintenance';
import { type SecurityAnalysis } from '@/lib/security-agent';
import { trpcClient, useTRPC } from '@/lib/trpc';

// Catalog keys for the remediation-unavailable reason codes, mapped from
// REMEDIATION_UNAVAILABLE_COPY and getRemediationUnavailableCopy in
// packages/app-shared. Unknown reasons keep the generic copy; a null/eligible
// reason stays null so callers keep their existing fallback.
const REMEDIATION_UNAVAILABLE_KEYS = {
  finding_not_found: 'securityAgent.remediationUnavailable.findingNotFound',
  approval_required: 'securityAgent.remediationUnavailable.approvalRequired',
  finding_not_open: 'securityAgent.remediationUnavailable.findingNotOpen',
  repo_not_in_scope: 'securityAgent.remediationUnavailable.repoNotInScope',
  analysis_required: 'securityAgent.remediationUnavailable.analysisRequired',
  sandbox_analysis_required: 'securityAgent.remediationUnavailable.sandboxAnalysisRequired',
  stale_analysis: 'securityAgent.remediationUnavailable.staleAnalysis',
  not_exploitable: 'securityAgent.remediationUnavailable.notExploitable',
  exploitability_unknown: 'securityAgent.remediationUnavailable.exploitabilityUnknown',
  manual_review_required: 'securityAgent.remediationUnavailable.manualReviewRequired',
  monitor_required: 'securityAgent.remediationUnavailable.monitorRequired',
  triage_only: 'securityAgent.remediationUnavailable.triageOnly',
  action_not_concrete: 'securityAgent.remediationUnavailable.actionNotConcrete',
  remediation_active: 'securityAgent.remediationUnavailable.remediationActive',
  pr_already_opened: 'securityAgent.remediationUnavailable.prAlreadyOpened',
  duplicate_analysis_result: 'securityAgent.remediationUnavailable.duplicateAnalysisResult',
  retry_not_allowed: 'securityAgent.remediationUnavailable.retryNotAllowed',
  security_agent_disabled: 'securityAgent.remediationUnavailable.securityAgentDisabled',
  auto_remediation_disabled: 'securityAgent.remediationUnavailable.autoRemediationDisabled',
  include_existing_disabled: 'securityAgent.remediationUnavailable.includeExistingDisabled',
  below_threshold: 'securityAgent.remediationUnavailable.belowThreshold',
  before_enablement: 'securityAgent.remediationUnavailable.beforeEnablement',
} as const satisfies Record<string, string>;

const REMEDIATION_UNAVAILABLE_GENERIC_KEY = 'securityAgent.remediationUnavailable.generic';

function getRemediationUnavailableKey(reason: string | null | undefined): string | null {
  if (!reason || reason === 'eligible') {
    return null;
  }
  // Object.hasOwn (not `in`) so inherited keys like 'constructor' fall
  // through to the generic copy instead of leaking prototype members.
  return Object.hasOwn(REMEDIATION_UNAVAILABLE_KEYS, reason)
    ? REMEDIATION_UNAVAILABLE_KEYS[reason as keyof typeof REMEDIATION_UNAVAILABLE_KEYS]
    : REMEDIATION_UNAVAILABLE_GENERIC_KEY;
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
          i18n.t(
            getRemediationUnavailableKey(result.reason) ?? 'securityAgent.remediation.unavailable'
          )
        );
      } else {
        toast.success(i18n.t('securityAgent.remediation.queued'));
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
          i18n.t(
            getRemediationUnavailableKey(result.reason) ?? 'securityAgent.remediation.unavailable'
          )
        );
      } else {
        toast.success(i18n.t('securityAgent.remediation.retryQueued'));
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
  // onError policy: roll back the onMutate snapshot (latest generation only)
  // and toast error.message.
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
      const generation = nextMutationGeneration(hashKey(analysisQueryKey));
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
      return { previous, analysisQueryKey, generation };
    },
    onError: (error, _vars, context) => {
      if (
        context?.previous &&
        isLatestMutationGeneration(hashKey(context.analysisQueryKey), context.generation)
      ) {
        queryClient.setQueryData(context.analysisQueryKey, context.previous);
      }
      toast.error(error.message);
    },
    onSuccess: result => {
      // 'cancellation_requested' means the attempt was already running and
      // was only asked to stop — it may still finish and produce a PR.
      toast.success(
        result.status === 'cancellation_requested'
          ? i18n.t('securityAgent.remediation.cancellationRequested')
          : i18n.t('securityAgent.remediation.cancelled')
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
