import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { trackSecurityAgentCommand } from '@/lib/hooks/use-security-agent-commands';
import { isPersonalSecurityScope } from '@/lib/security-agent';
import { trpcClient, useTRPC } from '@/lib/trpc';

// Personal and org procedures resolve to nominally distinct tRPC option
// types even when structurally identical, so we always call both hooks (one
// disabled) and return whichever is active. See use-code-reviewer.ts:32.

type ListFindingsFilters = Parameters<typeof trpcClient.securityAgent.listFindings.query>[0];

export function useSecurityFindings(scope: string, filters: ListFindingsFilters) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.listFindings.queryOptions(filters),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.listFindings.queryOptions({
      organizationId: scope,
      ...filters,
    }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
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

export function useSecurityAnalysis(scope: string, findingId: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getAnalysis.queryOptions({ findingId }),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getAnalysis.queryOptions({
      organizationId: scope,
      findingId,
    }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
}

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
    onError: error => {
      toast.error(error.message);
    },
    onSuccess: result => {
      trackSecurityAgentCommand(queryClient, scope, result.commandId);
    },
  });
}

export function useStartSecurityAnalysis(scope: string) {
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
    onSuccess: result => {
      trackSecurityAgentCommand(queryClient, scope, result.commandId);
    },
  });
}

// Ported from apps/web/src/components/security-agent/remediation-unavailable-copy.ts:6
// — the user-visible copy per admission rejection reason.
const REMEDIATION_REJECTION_MESSAGES: Record<string, string> = {
  finding_not_found: 'Security finding no longer exists.',
  finding_not_open: 'Finding is no longer open.',
  repo_not_in_scope: 'Repository is not selected for Security Agent.',
  analysis_required: 'Run codebase analysis before starting remediation.',
  sandbox_analysis_required: 'Run codebase analysis before starting remediation.',
  stale_analysis: 'Finding changed after analysis. Rerun analysis before starting remediation.',
  not_exploitable: 'Analysis found no reachable vulnerable path. Auto Remediation is unavailable.',
  exploitability_unknown:
    'Analysis could not confirm exploitability. Manual review is required before one-click remediation.',
  manual_review_required:
    'Analysis recommends manual review, so one-click remediation is unavailable.',
  monitor_required: 'Analysis recommends monitoring instead of opening a PR.',
  triage_only: 'Only triage has completed. Run codebase analysis before starting remediation.',
  action_not_concrete: 'No concrete dependency patch or suggested fix is available.',
  remediation_active: 'A remediation attempt is already active.',
  pr_already_opened: 'A remediation PR is already open.',
  duplicate_analysis_result: 'This analysis result already produced remediation work.',
  retry_not_allowed: 'Retry is not available for this attempt.',
  security_agent_disabled: 'Security Agent is disabled for this owner.',
  auto_remediation_disabled:
    'Auto Remediation is disabled. Manual remediation can still start when safety gates pass.',
  include_existing_disabled: 'Existing findings are excluded from automatic remediation.',
  below_threshold:
    'Finding is below automatic severity threshold. Manual remediation can still start when safety gates pass.',
  before_enablement:
    'Analysis completed before Auto Remediation was enabled. Manual remediation can still start when safety gates pass.',
};

function getRemediationRejectionMessage(reason: string): string {
  return REMEDIATION_REJECTION_MESSAGES[reason] ?? 'Remediation is unavailable for this finding.';
}

export function useStartSecurityRemediation(scope: string) {
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
    onSuccess: result => {
      if (!result.queued) {
        toast.error(getRemediationRejectionMessage(result.reason));
      }
    },
  });
}

export function useRetrySecurityRemediation(scope: string) {
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
    onSuccess: result => {
      if (!result.queued) {
        toast.error(getRemediationRejectionMessage(result.reason));
      }
    },
  });
}

// cancelRemediation resolves synchronously (no background command to track),
// so — unlike start/retry — we invalidate the affected queries ourselves
// once the immediate result comes back.
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
    onError: error => {
      toast.error(error.message);
    },
    onSuccess: async (_result, vars) => {
      if (isPersonalSecurityScope(scope)) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getFinding.queryKey({ id: vars.findingId }),
          }),
          queryClient.invalidateQueries({ queryKey: trpc.securityAgent.listFindings.queryKey() }),
          queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getDashboardStats.queryKey(),
          }),
        ]);
        return;
      }
      await Promise.all([
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
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getDashboardStats.queryKey({
            organizationId: scope,
          }),
        }),
      ]);
    },
  });
}
