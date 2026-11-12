'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAgentWritableSetupRunStatus, isOpenSetupRunStatus } from '@kilocode/cloud-agent-profile';
import { useTRPC } from '@/lib/trpc/utils';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';

export type { SetupRunResponse };

type Options = { organizationId?: string; enabled?: boolean };

export function isOpenEnvironmentSetupRun(status: SetupRunResponse['status'] | undefined) {
  return status !== undefined && isOpenSetupRunStatus(status);
}

const POLL_INTERVAL_MS = 5000;

/** Poll only while the agent can still change the run; user decisions refresh on mutation. */
function isAgentActive(status: SetupRunResponse['status'] | undefined): boolean {
  return status === 'starting' || (status !== undefined && isAgentWritableSetupRunStatus(status));
}

export function useEnvironmentSetupEnabled({ organizationId, enabled = true }: Options = {}) {
  const trpc = useTRPC();
  return useQuery(
    trpc.cloudEnvironments.setupRuns.isEnabled.queryOptions(
      { organizationId },
      { enabled, staleTime: 60_000 }
    )
  );
}

export function useEnvironmentSetupRun(runId: string | null, options: Options = {}) {
  const trpc = useTRPC();
  const toggle = useEnvironmentSetupEnabled(options);
  return useQuery(
    trpc.cloudEnvironments.setupRuns.get.queryOptions(
      { organizationId: options.organizationId, runId: runId ?? '' },
      {
        enabled: options.enabled !== false && toggle.data?.enabled === true && !!runId,
        refetchInterval: query =>
          isAgentActive(query.state.data?.status) ? POLL_INTERVAL_MS : false,
      }
    )
  );
}

export function useEnvironmentSetupRunBySession(
  cloudAgentSessionId: string | null,
  options: Options = {}
) {
  const trpc = useTRPC();
  const toggle = useEnvironmentSetupEnabled(options);
  return useQuery(
    trpc.cloudEnvironments.setupRuns.getBySession.queryOptions(
      { organizationId: options.organizationId, cloudAgentSessionId: cloudAgentSessionId ?? '' },
      {
        enabled:
          options.enabled !== false && toggle.data?.enabled === true && !!cloudAgentSessionId,
        refetchInterval: query =>
          isAgentActive(query.state.data?.status) ? POLL_INTERVAL_MS : false,
      }
    )
  );
}

export function useEnvironmentSetupRunsForEnvironment(
  environmentId: string | null,
  options: Options = {}
) {
  const trpc = useTRPC();
  const toggle = useEnvironmentSetupEnabled(options);
  return useQuery(
    trpc.cloudEnvironments.setupRuns.listForEnvironment.queryOptions(
      { organizationId: options.organizationId, environmentId: environmentId ?? '' },
      {
        enabled: options.enabled !== false && toggle.data?.enabled === true && !!environmentId,
        refetchInterval: query =>
          query.state.data?.some(run => isAgentActive(run.status)) ? POLL_INTERVAL_MS : false,
      }
    )
  );
}

export function useEnvironmentSetupRunMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await Promise.all(
      [
        trpc.cloudEnvironments.setupRuns.get.queryKey(),
        trpc.cloudEnvironments.setupRuns.getBySession.queryKey(),
        trpc.cloudEnvironments.setupRuns.listForEnvironment.queryKey(),
        trpc.cloudEnvironments.list.queryKey(),
        trpc.cloudEnvironments.listAll.queryKey(),
        trpc.cloudEnvironments.get.queryKey(),
        trpc.cloudEnvironments.buildStatus.queryKey(),
      ].map(queryKey => queryClient.invalidateQueries({ queryKey }))
    );
  };
  return {
    start: useMutation(
      trpc.cloudEnvironments.setupRuns.start.mutationOptions({ onSuccess: invalidate })
    ),
    resolveSecretRequests: useMutation(
      trpc.cloudEnvironments.setupRuns.resolveSecretRequests.mutationOptions({
        onSuccess: invalidate,
      })
    ),
    resolveNetworkRequests: useMutation(
      trpc.cloudEnvironments.setupRuns.resolveNetworkRequests.mutationOptions({
        onSuccess: invalidate,
      })
    ),
    publish: useMutation(
      trpc.cloudEnvironments.setupRuns.publish.mutationOptions({ onSuccess: invalidate })
    ),
    revert: useMutation(
      trpc.cloudEnvironments.setupRuns.revert.mutationOptions({ onSuccess: invalidate })
    ),
    cancel: useMutation(
      trpc.cloudEnvironments.setupRuns.cancel.mutationOptions({ onSuccess: invalidate })
    ),
    resume: useMutation(
      trpc.cloudEnvironments.setupRuns.resume.mutationOptions({ onSuccess: invalidate })
    ),
    buildSnapshot: useMutation(
      trpc.cloudEnvironments.setupRuns.buildSnapshot.mutationOptions({ onSuccess: invalidate })
    ),
  };
}
