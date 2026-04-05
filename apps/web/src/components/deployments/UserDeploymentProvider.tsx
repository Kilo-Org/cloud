'use client';

import type { ReactNode } from 'react';
import { useCallback } from 'react';
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

/**
 * Provider for user-level deployments
 */
export function UserDeploymentProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();

  const queries: DeploymentQueries = {
    checkDeploymentEligibility: () =>
      useQuery(trpc.deployments.checkDeploymentEligibility.queryOptions()),

    listDeployments: () =>
      useQuery(
        trpc.deployments.listDeployments.queryOptions(undefined, {
          refetchInterval: query => {
            const deployments = query.state.data?.data || [];
            const hasInProgressDeployments = deployments.some(
              d => !d.latestBuild || isDeploymentInProgress(d.latestBuild.status)
            );
            return hasInProgressDeployments ? DEPLOYMENT_POLL_INTERVAL_MS : false;
          },
        })
      ),

    getDeployment: (id: string) =>
      useQuery(
        trpc.deployments.getDeployment.queryOptions(
          { id },
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
        trpc.deployments.getBuildEvents.queryOptions(
          {
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
      useQuery(trpc.deployments.listEnvVars.queryOptions({ deploymentId })),

    checkSlugAvailability: useCallback(
      (slug: string) => trpcClient.deployments.checkSlugAvailability.query({ slug }),
      [trpcClient]
    ),
  };

  const mutations: DeploymentMutations = {
    createDeployment: useMutation(
      trpc.deployments.createDeployment.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.deployments.listDeployments.queryKey(),
          });
        },
      })
    ),

    deleteDeployment: useMutation(
      trpc.deployments.deleteDeployment.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.deployments.listDeployments.queryKey(),
          });
        },
      })
    ),

    cancelBuild: useMutation(
      trpc.deployments.cancelBuild.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.deployments.listDeployments.queryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: trpc.deployments.getDeployment.queryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: trpc.deployments.getBuildEvents.queryKey(),
          });
        },
      })
    ),

    redeploy: useMutation(
      trpc.deployments.redeploy.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.deployments.listDeployments.queryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: trpc.deployments.getDeployment.queryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: trpc.deployments.getBuildEvents.queryKey(),
          });
        },
      })
    ),

    setEnvVar: useMutation(
      trpc.deployments.setEnvVar.mutationOptions({
        onSuccess: (_data, variables) => {
          void queryClient.invalidateQueries({
            queryKey: trpc.deployments.listEnvVars.queryKey({
              deploymentId: variables.deploymentId,
            }),
          });
        },
      })
    ),

    deleteEnvVar: useMutation(
      trpc.deployments.deleteEnvVar.mutationOptions({
        onSuccess: (_data, variables) => {
          void queryClient.invalidateQueries({
            queryKey: trpc.deployments.listEnvVars.queryKey({
              deploymentId: variables.deploymentId,
            }),
          });
        },
      })
    ),

    renameEnvVar: useMutation(
      trpc.deployments.renameEnvVar.mutationOptions({
        onSuccess: (_data, variables) => {
          void queryClient.invalidateQueries({
            queryKey: trpc.deployments.listEnvVars.queryKey({
              deploymentId: variables.deploymentId,
            }),
          });
        },
      })
    ),

    renameDeployment: useMutation(
      trpc.deployments.renameDeployment.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.deployments.getDeployment.queryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: trpc.deployments.listDeployments.queryKey(),
          });
        },
      })
    ),
  };

  return (
    <DeploymentProvider queries={queries} mutations={mutations}>
      {children}
    </DeploymentProvider>
  );
}
