'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';
import type { RootRouter } from '@/routers/root-router';
import { useTRPC, useRawTRPCClient } from '@/lib/trpc/utils';
import type { VercelProject, VercelTeam } from '@/lib/vercel-client';

export type VercelComputeRemoveError = {
  data?: { code?: string } | null;
  message: string;
};

type VercelComputeDataCallbacks = {
  onRemoveSuccess: () => void;
  onRemoveError: (error: VercelComputeRemoveError) => void;
};

type VercelComputeDiscoveryInput = {
  token: string;
};

type VercelComputeProjectsInput = {
  token: string;
  teamId: string;
};

type VercelComputeSetupInput = {
  token: string;
  teamId: string;
  projectId: string;
};

type VercelComputeRemoveInput = {
  acknowledgeCleanupFailure: boolean;
};

type VercelComputeDiscoveryMutationInput =
  | VercelComputeDiscoveryInput
  | (VercelComputeDiscoveryInput & { organizationId: string });

type VercelComputeProjectsMutationInput =
  | VercelComputeProjectsInput
  | (VercelComputeProjectsInput & { organizationId: string });

type VercelComputeSetupMutationInput =
  | VercelComputeSetupInput
  | (VercelComputeSetupInput & { organizationId: string });

type VercelComputeRetryMutationInput = { organizationId: string } | undefined;

type VercelComputeRemoveMutationInput =
  | VercelComputeRemoveInput
  | (VercelComputeRemoveInput & { organizationId: string });

type VercelComputeStatus = NonNullable<
  inferRouterOutputs<RootRouter>['vercelCompute']['getStatus']
>;

function matchesOwner(
  variables: { token: string; organizationId?: string },
  organizationId: string | undefined
): boolean {
  return variables.organizationId === organizationId;
}

export function useVercelComputeData(
  organizationId: string | undefined,
  normalizedToken: string,
  teamId: string,
  { onRemoveSuccess, onRemoveError }: VercelComputeDataCallbacks
) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const organizationOwner = organizationId !== undefined;

  const enrollmentQuery = useQuery(
    organizationOwner
      ? trpc.organizations.vercelCompute.getEnrollment.queryOptions({ organizationId })
      : trpc.vercelCompute.getEnrollment.queryOptions()
  );
  const enrollmentState: 'checking' | 'unavailable' | 'enrolled' | 'not-enrolled' =
    enrollmentQuery.isPending
      ? 'checking'
      : enrollmentQuery.isError
        ? 'unavailable'
        : enrollmentQuery.data?.enrolled
          ? 'enrolled'
          : 'not-enrolled';
  const isEnrolled = enrollmentState === 'enrolled';

  const statusQuery = useQuery({
    ...(organizationOwner
      ? trpc.organizations.vercelCompute.getStatus.queryOptions({ organizationId })
      : trpc.vercelCompute.getStatus.queryOptions()),
    refetchInterval: query =>
      query.state.data?.setupStatus === 'pending' ||
      query.state.data?.setupStatus === 'building' ||
      query.state.data?.upgradeStatus === 'pending' ||
      query.state.data?.upgradeStatus === 'building'
        ? 2_000
        : false,
  });
  const status = statusQuery.data;
  const isSetupFormVisible = !status && statusQuery.isSuccess && isEnrolled;

  const invalidateStatus = () =>
    queryClient.invalidateQueries({
      queryKey: organizationOwner
        ? trpc.organizations.vercelCompute.getStatus.queryKey({ organizationId })
        : trpc.vercelCompute.getStatus.queryKey(),
    });

  const discoverTeamsMutation = useMutation<
    VercelTeam[],
    Error,
    VercelComputeDiscoveryMutationInput
  >({
    mutationKey: organizationOwner
      ? trpc.organizations.vercelCompute.discoverTeams.mutationKey()
      : trpc.vercelCompute.discoverTeams.mutationKey(),
    gcTime: 0,
    mutationFn: input => {
      if (organizationId !== undefined) {
        return trpcClient.organizations.vercelCompute.discoverTeams.mutate({
          organizationId,
          token: input.token,
        });
      }
      return trpcClient.vercelCompute.discoverTeams.mutate({ token: input.token });
    },
  });
  const discoverProjectsMutation = useMutation<
    VercelProject[],
    Error,
    VercelComputeProjectsMutationInput
  >({
    mutationKey: organizationOwner
      ? trpc.organizations.vercelCompute.discoverProjects.mutationKey()
      : trpc.vercelCompute.discoverProjects.mutationKey(),
    gcTime: 0,
    mutationFn: input => {
      if (organizationId !== undefined) {
        return trpcClient.organizations.vercelCompute.discoverProjects.mutate({
          organizationId,
          token: input.token,
          teamId: input.teamId,
        });
      }
      return trpcClient.vercelCompute.discoverProjects.mutate({
        token: input.token,
        teamId: input.teamId,
      });
    },
  });
  const addMutation = useMutation<VercelComputeStatus, Error, VercelComputeSetupMutationInput>({
    mutationKey: organizationOwner
      ? trpc.organizations.vercelCompute.add.mutationKey()
      : trpc.vercelCompute.add.mutationKey(),
    gcTime: 0,
    mutationFn: input => {
      if (organizationId !== undefined) {
        return trpcClient.organizations.vercelCompute.add.mutate({
          organizationId,
          token: input.token,
          teamId: input.teamId,
          projectId: input.projectId,
        });
      }
      return trpcClient.vercelCompute.add.mutate({
        token: input.token,
        teamId: input.teamId,
        projectId: input.projectId,
      });
    },
    onSettled: () => void invalidateStatus(),
  });
  const mutationSuccess = (message: string) => () => {
    toast.success(message);
    void invalidateStatus();
  };
  const retryMutation = useMutation<VercelComputeStatus, Error, VercelComputeRetryMutationInput>({
    mutationKey: organizationOwner
      ? trpc.organizations.vercelCompute.retrySetup.mutationKey()
      : trpc.vercelCompute.retrySetup.mutationKey(),
    mutationFn: _input => {
      if (organizationId !== undefined) {
        return trpcClient.organizations.vercelCompute.retrySetup.mutate({ organizationId });
      }
      return trpcClient.vercelCompute.retrySetup.mutate();
    },
    onSuccess: mutationSuccess('Vercel compute setup restarted'),
    onError: error => toast.error(error.message || 'Could not retry setup'),
  });
  const upgradeMutation = useMutation<VercelComputeStatus, Error, VercelComputeRetryMutationInput>({
    mutationKey: organizationOwner
      ? trpc.organizations.vercelCompute.upgradeRuntime.mutationKey()
      : trpc.vercelCompute.upgradeRuntime.mutationKey(),
    mutationFn: _input => {
      if (organizationId !== undefined) {
        return trpcClient.organizations.vercelCompute.upgradeRuntime.mutate({ organizationId });
      }
      return trpcClient.vercelCompute.upgradeRuntime.mutate();
    },
    onSuccess: mutationSuccess('Runtime upgrade started'),
    onError: error => toast.error(error.message || 'Could not start runtime upgrade'),
  });
  const removeMutation = useMutation<{ success: true }, Error, VercelComputeRemoveMutationInput>({
    mutationKey: organizationOwner
      ? trpc.organizations.vercelCompute.remove.mutationKey()
      : trpc.vercelCompute.remove.mutationKey(),
    mutationFn: input => {
      if (organizationId !== undefined) {
        return trpcClient.organizations.vercelCompute.remove.mutate({
          organizationId,
          acknowledgeCleanupFailure: input.acknowledgeCleanupFailure,
        });
      }
      return trpcClient.vercelCompute.remove.mutate({
        acknowledgeCleanupFailure: input.acknowledgeCleanupFailure,
      });
    },
    onSuccess: () => {
      onRemoveSuccess();
      void invalidateStatus();
    },
    onError: onRemoveError,
  });

  const teamsVariables = discoverTeamsMutation.variables;
  const teams =
    teamsVariables !== undefined &&
    matchesOwner(teamsVariables, organizationId) &&
    teamsVariables.token === normalizedToken
      ? discoverTeamsMutation.data
      : undefined;
  const projectsVariables = discoverProjectsMutation.variables;
  const projects =
    projectsVariables !== undefined &&
    matchesOwner(projectsVariables, organizationId) &&
    projectsVariables.token === normalizedToken &&
    projectsVariables.teamId === teamId
      ? discoverProjectsMutation.data
      : undefined;

  const dispatchDiscoverTeams = (input: VercelComputeDiscoveryInput) =>
    organizationOwner
      ? discoverTeamsMutation.mutateAsync({ organizationId, ...input })
      : discoverTeamsMutation.mutateAsync(input);
  const dispatchDiscoverProjects = (input: VercelComputeProjectsInput) =>
    organizationOwner
      ? discoverProjectsMutation.mutateAsync({ organizationId, ...input })
      : discoverProjectsMutation.mutateAsync(input);
  const dispatchAdd = (input: VercelComputeSetupInput) =>
    organizationOwner
      ? addMutation.mutateAsync({ organizationId, ...input })
      : addMutation.mutateAsync(input);
  const dispatchRetrySetup = () =>
    organizationOwner ? retryMutation.mutate({ organizationId }) : retryMutation.mutate(undefined);
  const dispatchUpgradeRuntime = () =>
    organizationOwner
      ? upgradeMutation.mutate({ organizationId })
      : upgradeMutation.mutate(undefined);
  const dispatchRemove = (input: VercelComputeRemoveInput) =>
    organizationOwner
      ? removeMutation.mutate({ organizationId, ...input })
      : removeMutation.mutate(input);

  return {
    enrollmentState,
    isEnrolled,
    status,
    isSetupFormVisible,
    discoverTeamsMutation,
    discoverProjectsMutation,
    addMutation,
    retryMutation,
    upgradeMutation,
    removeMutation,
    teams,
    projects,
    dispatchDiscoverTeams,
    dispatchDiscoverProjects,
    dispatchAdd,
    dispatchRetrySetup,
    dispatchUpgradeRuntime,
    dispatchRemove,
  };
}
