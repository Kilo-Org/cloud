/** React Query hooks for environment setup runs. */
'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isOpenSetupRunStatus,
  type EnvironmentSetupRunStatus,
} from '@kilocode/cloud-agent-profile';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';
import { useTRPC } from '@/lib/trpc/utils';

const OPEN_RUN_POLL_MS = 5_000;
const ENABLED_STALE_MS = 60_000;
const POLLED_RUN_STATUSES: readonly EnvironmentSetupRunStatus[] = [
  'starting',
  'running',
  'needs_input',
  'verifying',
  'waiting_for_merge',
];

type UseSetupRunOptions = {
  organizationId?: string;
  enabled?: boolean;
};

function pollWhileOpen(data: SetupRunResponse | null | undefined): number | false {
  return data && isOpenSetupRunStatus(data.status) ? OPEN_RUN_POLL_MS : false;
}

function pollWhileActive(data: SetupRunResponse | null | undefined): number | false {
  return data && POLLED_RUN_STATUSES.includes(data.status) ? OPEN_RUN_POLL_MS : false;
}

/** Whether the setup agent is enabled for this owner, and whether they may start a run. */
export function useEnvironmentSetupEnabled(options: UseSetupRunOptions = {}) {
  const { organizationId, enabled = true } = options;
  const trpc = useTRPC();

  return useQuery(
    trpc.cloudEnvironments.setupRuns.isEnabled.queryOptions(
      { organizationId },
      { enabled, staleTime: ENABLED_STALE_MS }
    )
  );
}

export function useEnvironmentSetupRun(runId: string | null, options: UseSetupRunOptions = {}) {
  const { organizationId, enabled = true } = options;
  const trpc = useTRPC();

  return useQuery(
    trpc.cloudEnvironments.setupRuns.get.queryOptions(
      { organizationId, runId: runId ?? '' },
      { enabled: enabled && !!runId, refetchInterval: query => pollWhileOpen(query.state.data) }
    )
  );
}

export function useEnvironmentSetupRunBySession(
  cloudAgentSessionId: string | null,
  options: UseSetupRunOptions = {}
) {
  const { organizationId, enabled = true } = options;
  const trpc = useTRPC();

  return useQuery(
    trpc.cloudEnvironments.setupRuns.getBySession.queryOptions(
      { organizationId, cloudAgentSessionId: cloudAgentSessionId ?? '' },
      {
        enabled: enabled && !!cloudAgentSessionId,
        refetchInterval: query => pollWhileActive(query.state.data),
      }
    )
  );
}

export function useEnvironmentSetupRunsForEnvironment(
  environmentId: string | null,
  options: UseSetupRunOptions = {}
) {
  const { organizationId, enabled = true } = options;
  const trpc = useTRPC();

  return useQuery(
    trpc.cloudEnvironments.setupRuns.listForEnvironment.queryOptions(
      { organizationId, environmentId: environmentId ?? '' },
      {
        enabled: enabled && !!environmentId,
        refetchInterval: query =>
          query.state.data?.some(run => POLLED_RUN_STATUSES.includes(run.status))
            ? OPEN_RUN_POLL_MS
            : false,
      }
    )
  );
}

export function useEnvironmentSetupRunMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.cloudEnvironments.setupRuns.get.queryKey(),
    });
    await queryClient.invalidateQueries({
      queryKey: trpc.cloudEnvironments.setupRuns.getBySession.queryKey(),
    });
    await queryClient.invalidateQueries({
      queryKey: trpc.cloudEnvironments.setupRuns.listForEnvironment.queryKey(),
    });
    await queryClient.invalidateQueries({ queryKey: trpc.cloudEnvironments.list.queryKey() });
    await queryClient.invalidateQueries({ queryKey: trpc.cloudEnvironments.listAll.queryKey() });
    await queryClient.invalidateQueries({ queryKey: trpc.cloudEnvironments.get.queryKey() });
    await queryClient.invalidateQueries({
      queryKey: trpc.cloudEnvironments.buildStatus.queryKey(),
    });
  };

  const options = { onSuccess: invalidate };
  const start = useMutation(trpc.cloudEnvironments.setupRuns.start.mutationOptions(options));
  const resolveSecretRequests = useMutation(
    trpc.cloudEnvironments.setupRuns.resolveSecretRequests.mutationOptions(options)
  );
  const resolveNetworkRequests = useMutation(
    trpc.cloudEnvironments.setupRuns.resolveNetworkRequests.mutationOptions(options)
  );
  const publish = useMutation(trpc.cloudEnvironments.setupRuns.publish.mutationOptions(options));
  const revert = useMutation(trpc.cloudEnvironments.setupRuns.revert.mutationOptions(options));
  const cancel = useMutation(trpc.cloudEnvironments.setupRuns.cancel.mutationOptions(options));
  const resume = useMutation(trpc.cloudEnvironments.setupRuns.resume.mutationOptions(options));
  const buildSnapshot = useMutation(
    trpc.cloudEnvironments.setupRuns.buildSnapshot.mutationOptions(options)
  );

  return {
    start,
    resolveSecretRequests,
    resolveNetworkRequests,
    publish,
    revert,
    cancel,
    resume,
    buildSnapshot,
  };
}
