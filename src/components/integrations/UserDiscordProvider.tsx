'use client';

import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { DiscordProvider, type DiscordQueries, type DiscordMutations } from './DiscordContext';

export function UserDiscordProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const queries: DiscordQueries = {
    getInstallation: () => useQuery(trpc.discord.getInstallation.queryOptions()),
    getOAuthUrl: () => useQuery(trpc.discord.getOAuthUrl.queryOptions()),
  };

  const mutations: DiscordMutations = {
    uninstallApp: useMutation(
      trpc.discord.uninstallApp.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.discord.getInstallation.queryKey(),
          });
        },
      })
    ),

    testConnection: useMutation(trpc.discord.testConnection.mutationOptions()),

    devRemoveDbRowOnly: useMutation(
      trpc.discord.devRemoveDbRowOnly.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.discord.getInstallation.queryKey(),
          });
        },
      })
    ),
  };

  return (
    <DiscordProvider queries={queries} mutations={mutations}>
      {children}
    </DiscordProvider>
  );
}
