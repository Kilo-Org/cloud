import {
  canManageSecurityAgent,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { trackSecurityAgentCommand } from '@/lib/hooks/use-security-agent-commands';
import {
  type OrganizationRole,
  type SecurityAgentConfig,
  type SecurityAgentConfigPatch,
} from '@/lib/security-agent';
import { trpcClient, useTRPC } from '@/lib/trpc';

// Personal and org procedures resolve to nominally distinct tRPC option
// types even when structurally identical, so we can't pick between them
// with a ternary and spread the result — we always call both hooks (one
// disabled) and return whichever is active. See use-code-reviewer.ts:32.

export function useSecurityAgentPermissionStatus(scope: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getPermissionStatus.queryOptions(),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getPermissionStatus.queryOptions({
      organizationId: scope,
    }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
}

export function useSecurityAgentConfig(scope: string): UseQueryResult<SecurityAgentConfig> {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getConfig.queryOptions(),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getConfig.queryOptions({ organizationId: scope }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return (
    isPersonalSecurityScope(scope) ? personal : organization
  ) as UseQueryResult<SecurityAgentConfig>;
}

function useSecurityAgentConfigQueryKey(scope: string) {
  const trpc = useTRPC();
  return isPersonalSecurityScope(scope)
    ? trpc.securityAgent.getConfig.queryKey()
    : trpc.organizations.securityAgent.getConfig.queryKey({ organizationId: scope });
}

export function useSecurityAgentRepositories(scope: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getRepositories.queryOptions(),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getRepositories.queryOptions({ organizationId: scope }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
}

export function useSecurityAgentDashboardStats(scope: string, repoFullName?: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getDashboardStats.queryOptions({ repoFullName }),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getDashboardStats.queryOptions({
      organizationId: scope,
      repoFullName,
    }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
}

export function useSecurityAgentLastSyncTime(scope: string, repoFullName?: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getLastSyncTime.queryOptions({ repoFullName }),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getLastSyncTime.queryOptions({
      organizationId: scope,
      repoFullName,
    }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
}

// Personal scope always has full access; for an organization, only owner and
// billing_manager can manage config. `organizations.list` is already fetched
// app-wide for the org switcher, so this reuses that cache rather than adding
// a new procedure (mirrors useCanEditReviewer in use-code-reviewer.ts:234).
export function useSecurityAgentOrgRole(scope: string): OrganizationRole | undefined {
  const trpc = useTRPC();
  const { data: orgs } = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: !isPersonalSecurityScope(scope),
  });
  return orgs?.find(org => org.organizationId === scope)?.role;
}

export function useSecurityAgentEditCapability(scope: string): boolean {
  const role = useSecurityAgentOrgRole(scope);
  return canManageSecurityAgent(scope, role);
}

// Reuses listFindings (status: 'open', limit 1) instead of a dedicated
// procedure — the concurrency numbers ride along on every findings fetch.
export function useSecurityAnalysisCapacity(scope: string): {
  runningCount: number | undefined;
  concurrencyLimit: number | undefined;
} {
  const trpc = useTRPC();
  const capacityInput = { status: 'open' as const, limit: 1, offset: 0 };
  const personal = useQuery({
    ...trpc.securityAgent.listFindings.queryOptions(capacityInput),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.listFindings.queryOptions({
      organizationId: scope,
      ...capacityInput,
    }),
    enabled: !isPersonalSecurityScope(scope),
  });
  const data = isPersonalSecurityScope(scope) ? personal.data : organization.data;
  return { runningCount: data?.runningCount, concurrencyLimit: data?.concurrencyLimit };
}

function pick<K extends keyof SecurityAgentConfig>(
  config: SecurityAgentConfig,
  keys: readonly K[]
): Pick<SecurityAgentConfig, K> {
  const result: Partial<SecurityAgentConfig> = {};
  for (const key of keys) {
    result[key] = config[key];
  }
  return result as Pick<SecurityAgentConfig, K>;
}

export function useSaveSecurityAgentConfig(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const configQueryKey = useSecurityAgentConfigQueryKey(scope);

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (patch: SecurityAgentConfigPatch) =>
      isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.saveConfig.mutate(patch)
        : trpcClient.organizations.securityAgent.saveConfig.mutate({
            organizationId: scope,
            ...patch,
          }),
    onMutate: async patch => {
      await queryClient.cancelQueries({ queryKey: configQueryKey });
      const previous = queryClient.getQueryData<SecurityAgentConfig>(configQueryKey);
      queryClient.setQueryData<SecurityAgentConfig>(configQueryKey, old =>
        old ? { ...old, ...patch } : old
      );
      return { previous, patch };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) {
        const keys = Object.keys(context.patch) as (keyof SecurityAgentConfigPatch)[];
        const restoredFields = pick(context.previous, keys);
        queryClient.setQueryData<SecurityAgentConfig>(configQueryKey, old =>
          old ? { ...old, ...restoredFields } : old
        );
      }
      toast.error(error.message);
    },
    onSuccess: result => {
      if (result.existingRemediationCommandId) {
        trackSecurityAgentCommand(queryClient, scope, result.existingRemediationCommandId);
      }
      if (result.backlogAdmissionWarning) {
        toast.error(result.backlogAdmissionWarning);
      }
      if (result.remediationBacklogAdmissionWarning) {
        toast.error(result.remediationBacklogAdmissionWarning);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: configQueryKey });
      if (isPersonalSecurityScope(scope)) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getDashboardStats.queryKey(),
          }),
          queryClient.invalidateQueries({ queryKey: trpc.securityAgent.listFindings.queryKey() }),
        ]);
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getDashboardStats.queryKey({
            organizationId: scope,
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

export function useSetSecurityAgentEnabled(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const configQueryKey = useSecurityAgentConfigQueryKey(scope);

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: Parameters<typeof trpcClient.securityAgent.setEnabled.mutate>[0]) =>
      isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.setEnabled.mutate(vars)
        : trpcClient.organizations.securityAgent.setEnabled.mutate({
            organizationId: scope,
            ...vars,
          }),
    onMutate: async vars => {
      await queryClient.cancelQueries({ queryKey: configQueryKey });
      const previous = queryClient.getQueryData<SecurityAgentConfig>(configQueryKey);
      queryClient.setQueryData<SecurityAgentConfig>(configQueryKey, old =>
        old ? { ...old, isEnabled: vars.isEnabled } : old
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      queryClient.setQueryData<SecurityAgentConfig>(configQueryKey, old =>
        old && context?.previous ? { ...old, isEnabled: context.previous.isEnabled } : old
      );
      toast.error(error.message);
    },
    onSuccess: result => {
      if ('initialSyncAdmissionFailed' in result && result.initialSyncAdmissionFailed) {
        toast.error(
          'Security Agent was enabled, but the initial sync could not be queued. Sync again.'
        );
      } else if ('initialSync' in result && result.initialSync) {
        trackSecurityAgentCommand(queryClient, scope, result.initialSync.commandId);
      }
    },
    onSettled: async () => {
      if (isPersonalSecurityScope(scope)) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getPermissionStatus.queryKey(),
          }),
          queryClient.invalidateQueries({ queryKey: configQueryKey }),
          queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getRepositories.queryKey(),
          }),
        ]);
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getPermissionStatus.queryKey({
            organizationId: scope,
          }),
        }),
        queryClient.invalidateQueries({ queryKey: configQueryKey }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getRepositories.queryKey({
            organizationId: scope,
          }),
        }),
      ]);
    },
  });
}

export function useTriggerSecuritySync(scope: string) {
  const queryClient = useQueryClient();

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: Parameters<typeof trpcClient.securityAgent.triggerSync.mutate>[0] = {}) =>
      isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.triggerSync.mutate(vars)
        : trpcClient.organizations.securityAgent.triggerSync.mutate({
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

export function useTrackSecurityAgentInteraction(scope: string) {
  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: Parameters<typeof trpcClient.securityAgent.trackUiInteraction.mutate>[0]) =>
      isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.trackUiInteraction.mutate(vars)
        : trpcClient.organizations.securityAgent.trackUiInteraction.mutate({
            organizationId: scope,
            ...vars,
          }),
    onError: error => {
      toast.error(error.message);
    },
  });
}
