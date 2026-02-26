'use client';

import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { DiscordProvider, type DiscordQueries, type DiscordMutations } from './DiscordContext';

type OrgDiscordProviderProps = {
  organizationId: string;
  children: ReactNode;
};

export function OrgDiscordProvider({ organizationId, children }: OrgDiscordProviderProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const queries: DiscordQueries = {
    getInstallation: () =>
      useQuery(trpc.organizations.discord.getInstallation.queryOptions({ organizationId })),
    getOAuthUrl: () =>
      useQuery(trpc.organizations.discord.getOAuthUrl.queryOptions({ organizationId })),
  };

  const uninstallAppMutation = useMutation(
    trpc.organizations.discord.uninstallApp.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.discord.getInstallation.queryKey({ organizationId }),
        });
      },
    })
  );

  const testConnectionMutation = useMutation(
    trpc.organizations.discord.testConnection.mutationOptions()
  );

  const devRemoveDbRowOnlyMutation = useMutation(
    trpc.organizations.discord.devRemoveDbRowOnly.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.discord.getInstallation.queryKey({ organizationId }),
        });
      },
    })
  );

  const mutations: DiscordMutations = {
    uninstallApp: {
      ...uninstallAppMutation,
      mutate: (_: void, options?: Parameters<typeof uninstallAppMutation.mutate>[1]) => {
        uninstallAppMutation.mutate({ organizationId }, options);
      },
      mutateAsync: async (
        _: void,
        options?: Parameters<typeof uninstallAppMutation.mutateAsync>[1]
      ) => {
        return uninstallAppMutation.mutateAsync({ organizationId }, options);
      },
    } as DiscordMutations['uninstallApp'],

    testConnection: {
      ...testConnectionMutation,
      mutate: (_: void, options?: Parameters<typeof testConnectionMutation.mutate>[1]) => {
        testConnectionMutation.mutate({ organizationId }, options);
      },
      mutateAsync: async (
        _: void,
        options?: Parameters<typeof testConnectionMutation.mutateAsync>[1]
      ) => {
        return testConnectionMutation.mutateAsync({ organizationId }, options);
      },
    } as DiscordMutations['testConnection'],

    devRemoveDbRowOnly: {
      ...devRemoveDbRowOnlyMutation,
      mutate: (_: void, options?: Parameters<typeof devRemoveDbRowOnlyMutation.mutate>[1]) => {
        devRemoveDbRowOnlyMutation.mutate({ organizationId }, options);
      },
      mutateAsync: async (
        _: void,
        options?: Parameters<typeof devRemoveDbRowOnlyMutation.mutateAsync>[1]
      ) => {
        return devRemoveDbRowOnlyMutation.mutateAsync({ organizationId }, options);
      },
    } as DiscordMutations['devRemoveDbRowOnly'],
  };

  return (
    <DiscordProvider queries={queries} mutations={mutations}>
      {children}
    </DiscordProvider>
  );
}
