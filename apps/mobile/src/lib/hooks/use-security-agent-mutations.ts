import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { trackSecurityAgentCommand } from '@/lib/hooks/use-security-agent-commands';
import { type SecurityAgentConfig, type SecurityAgentConfigPatch } from '@/lib/security-agent';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { pick } from '@/lib/utils';

// Split out of use-security-agent.ts (mutations only) to stay under the
// 300-line file limit — these are the write-side hooks, kept alongside the
// query-key helper they share.
function useSecurityAgentConfigQueryKey(scope: string) {
  const trpc = useTRPC();
  return isPersonalSecurityScope(scope)
    ? trpc.securityAgent.getConfig.queryKey()
    : trpc.organizations.securityAgent.getConfig.queryKey({ organizationId: scope });
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
    // Intentionally no onError handler: this is fire-and-forget telemetry that
    // pings on nav/tab/toggle. A failure must never surface a user-facing toast —
    // it would spam errors and stack on top of real mutation errors. React Query
    // captures the rejection internally; we deliberately don't act on it.
  });
}
