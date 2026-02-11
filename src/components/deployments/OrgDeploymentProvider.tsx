'use client';

import { useCallback, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC, useRawTRPCClient } from '@/lib/trpc/utils';
import { DeploymentProvider } from './DeploymentContext';
import type {
  DeploymentQueries,
  DeploymentMutations,
  BuildEventsParams,
} from '@/lib/user-deployments/router-types';
import { isDeploymentInProgress, type BuildStatus } from '@/lib/user-deployments/types';
import { DEPLOYMENT_POLL_INTERVAL_MS } from '@/lib/user-deployments/constants';

type OrgDeploymentProviderProps = {
  organizationId: string;
  children: ReactNode;
};

/**
 * Provider for organization-level deployments
 */
export function OrgDeploymentProvider({ organizationId, children }: OrgDeploymentProviderProps) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();

  const queries: DeploymentQueries = {
    checkDeploymentEligibility: () =>
      useQuery(
        trpc.organizations.deployments.checkDeploymentEligibility.queryOptions({ organizationId })
      ),

    listDeployments: () =>
      useQuery(
        trpc.organizations.deployments.listDeployments.queryOptions(
          { organizationId },
          {
            refetchInterval: query => {
              const deployments = query.state.data?.data || [];
              const hasInProgressDeployments = deployments.some(
                d => !d.latestBuild || isDeploymentInProgress(d.latestBuild.status)
              );
              return hasInProgressDeployments ? DEPLOYMENT_POLL_INTERVAL_MS : false;
            },
          }
        )
      ),

    getDeployment: (id: string) =>
      useQuery(
        trpc.organizations.deployments.getDeployment.queryOptions(
          { organizationId, id },
          {
            refetchInterval: query => {
              const deploymentStatus = query.state.data?.latestBuild?.status;
              return !deploymentStatus || isDeploymentInProgress(deploymentStatus)
                ? DEPLOYMENT_POLL_INTERVAL_MS
                : false;
            },
          }
        )
      ),

    getBuildEvents: (params: BuildEventsParams & { status: BuildStatus }) =>
      useQuery(
        trpc.organizations.deployments.getBuildEvents.queryOptions(
          {
            organizationId,
            deploymentId: params.deploymentId,
            buildId: params.buildId,
            limit: params.limit,
            afterEventId: params.afterEventId,
          },
          {
            refetchInterval: isDeploymentInProgress(params.status)
              ? DEPLOYMENT_POLL_INTERVAL_MS
              : false,
          }
        )
      ),

    listEnvVars: (deploymentId: string) =>
      useQuery(
        trpc.organizations.deployments.listEnvVars.queryOptions({ organizationId, deploymentId })
      ),

    getPasswordStatus: (deploymentId: string) =>
      useQuery(
        trpc.organizations.deployments.getPasswordStatus.queryOptions({
          organizationId,
          deploymentId,
        })
      ),

    checkSlugAvailability: useCallback(
      (slug: string) =>
        trpcClient.organizations.deployments.checkSlugAvailability.query({
          organizationId,
          slug,
        }),
      [trpcClient, organizationId]
    ),
  };

  // Base mutations from TRPC
  const createDeploymentMutation = useMutation(
    trpc.organizations.deployments.createDeployment.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.listDeployments.queryKey({
            organizationId,
          }),
        });
      },
    })
  );

  const deleteDeploymentMutation = useMutation(
    trpc.organizations.deployments.deleteDeployment.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.listDeployments.queryKey({
            organizationId,
          }),
        });
      },
    })
  );

  const cancelBuildMutation = useMutation(
    trpc.organizations.deployments.cancelBuild.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.listDeployments.queryKey({
            organizationId,
          }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.getDeployment.queryKey({
            organizationId,
          }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.getBuildEvents.queryKey({
            organizationId,
          }),
        });
      },
    })
  );

  const redeployMutation = useMutation(
    trpc.organizations.deployments.redeploy.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.listDeployments.queryKey({
            organizationId,
          }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.getDeployment.queryKey({
            organizationId,
          }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.getBuildEvents.queryKey({
            organizationId,
          }),
        });
      },
    })
  );

  const setEnvVarMutation = useMutation(
    trpc.organizations.deployments.setEnvVar.mutationOptions({
      onSuccess: (_data, variables) => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.listEnvVars.queryKey({
            organizationId,
            deploymentId: variables.deploymentId,
          }),
        });
      },
    })
  );

  const deleteEnvVarMutation = useMutation(
    trpc.organizations.deployments.deleteEnvVar.mutationOptions({
      onSuccess: (_data, variables) => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.listEnvVars.queryKey({
            organizationId,
            deploymentId: variables.deploymentId,
          }),
        });
      },
    })
  );

  const renameEnvVarMutation = useMutation(
    trpc.organizations.deployments.renameEnvVar.mutationOptions({
      onSuccess: (_data, variables) => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.listEnvVars.queryKey({
            organizationId,
            deploymentId: variables.deploymentId,
          }),
        });
      },
    })
  );

  const setPasswordMutation = useMutation(
    trpc.organizations.deployments.setPassword.mutationOptions({
      onSuccess: (_data, variables) => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.getPasswordStatus.queryKey({
            organizationId,
            deploymentId: variables.deploymentId,
          }),
        });
      },
    })
  );

  const removePasswordMutation = useMutation(
    trpc.organizations.deployments.removePassword.mutationOptions({
      onSuccess: (_data, variables) => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.getPasswordStatus.queryKey({
            organizationId,
            deploymentId: variables.deploymentId,
          }),
        });
      },
    })
  );

  const renameDeploymentMutation = useMutation(
    trpc.organizations.deployments.renameDeployment.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.getDeployment.queryKey({
            organizationId,
          }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.deployments.listDeployments.queryKey({
            organizationId,
          }),
        });
      },
    })
  );

  // Wrap mutations to match the DeploymentMutations interface
  const mutations: DeploymentMutations = {
    createDeployment: {
      ...createDeploymentMutation,
      mutate: (input, options) => {
        createDeploymentMutation.mutate({ ...input, organizationId }, options);
      },
      mutateAsync: async (input, options) => {
        return createDeploymentMutation.mutateAsync({ ...input, organizationId }, options);
      },
    } as DeploymentMutations['createDeployment'],

    deleteDeployment: {
      ...deleteDeploymentMutation,
      mutate: (input, options) => {
        deleteDeploymentMutation.mutate({ ...input, organizationId }, options);
      },
      mutateAsync: async (input, options) => {
        return deleteDeploymentMutation.mutateAsync({ ...input, organizationId }, options);
      },
    } as DeploymentMutations['deleteDeployment'],

    cancelBuild: {
      ...cancelBuildMutation,
      mutate: (input, options) => {
        cancelBuildMutation.mutate({ ...input, organizationId }, options);
      },
      mutateAsync: async (input, options) => {
        return cancelBuildMutation.mutateAsync({ ...input, organizationId }, options);
      },
    } as DeploymentMutations['cancelBuild'],

    redeploy: {
      ...redeployMutation,
      mutate: (input, options) => {
        redeployMutation.mutate({ ...input, organizationId }, options);
      },
      mutateAsync: async (input, options) => {
        return redeployMutation.mutateAsync({ ...input, organizationId }, options);
      },
    } as DeploymentMutations['redeploy'],

    setEnvVar: {
      ...setEnvVarMutation,
      mutate: (input, options) => {
        setEnvVarMutation.mutate({ ...input, organizationId }, options);
      },
      mutateAsync: async (input, options) => {
        return setEnvVarMutation.mutateAsync({ ...input, organizationId }, options);
      },
    } as DeploymentMutations['setEnvVar'],

    deleteEnvVar: {
      ...deleteEnvVarMutation,
      mutate: (input, options) => {
        deleteEnvVarMutation.mutate({ ...input, organizationId }, options);
      },
      mutateAsync: async (input, options) => {
        return deleteEnvVarMutation.mutateAsync({ ...input, organizationId }, options);
      },
    } as DeploymentMutations['deleteEnvVar'],

    renameEnvVar: {
      ...renameEnvVarMutation,
      mutate: (input, options) => {
        renameEnvVarMutation.mutate({ ...input, organizationId }, options);
      },
      mutateAsync: async (input, options) => {
        return renameEnvVarMutation.mutateAsync({ ...input, organizationId }, options);
      },
    } as DeploymentMutations['renameEnvVar'],

    setPassword: {
      ...setPasswordMutation,
      mutate: (input, options) => {
        setPasswordMutation.mutate({ ...input, organizationId }, options);
      },
      mutateAsync: async (input, options) => {
        return setPasswordMutation.mutateAsync({ ...input, organizationId }, options);
      },
    } as DeploymentMutations['setPassword'],

    removePassword: {
      ...removePasswordMutation,
      mutate: (input, options) => {
        removePasswordMutation.mutate({ ...input, organizationId }, options);
      },
      mutateAsync: async (input, options) => {
        return removePasswordMutation.mutateAsync({ ...input, organizationId }, options);
      },
    } as DeploymentMutations['removePassword'],

    renameDeployment: {
      ...renameDeploymentMutation,
      mutate: (input, options) => {
        renameDeploymentMutation.mutate({ ...input, organizationId }, options);
      },
      mutateAsync: async (input, options) => {
        return renameDeploymentMutation.mutateAsync({ ...input, organizationId }, options);
      },
    } as DeploymentMutations['renameDeployment'],
  };

  return (
    <DeploymentProvider queries={queries} mutations={mutations}>
      {children}
    </DeploymentProvider>
  );
}
