'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type { TRPCClientErrorLike } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';

type DiscordError = TRPCClientErrorLike<AnyRouter>;

type DiscordInstallation = {
  guildId: string | null;
  guildName: string | null;
  scopes: string[] | null;
  installedAt: string;
};

type DiscordInstallationResult = {
  installed: boolean;
  installation: DiscordInstallation | null;
};

type DiscordOAuthUrlResult = {
  url: string;
};

type DiscordTestConnectionResult = {
  success: boolean;
  error?: string;
};

export type DiscordQueries = {
  getInstallation: () => UseQueryResult<DiscordInstallationResult, DiscordError>;
  getOAuthUrl: () => UseQueryResult<DiscordOAuthUrlResult, DiscordError>;
};

export type DiscordMutations = {
  uninstallApp: UseMutationResult<{ success: boolean }, DiscordError, void>;
  testConnection: UseMutationResult<DiscordTestConnectionResult, DiscordError, void>;
  devRemoveDbRowOnly: UseMutationResult<{ success: boolean }, DiscordError, void>;
};

type DiscordContextValue = {
  queries: DiscordQueries;
  mutations: DiscordMutations;
};

const DiscordContext = createContext<DiscordContextValue | null>(null);

/**
 * Hook to access Discord queries and mutations from context
 * Must be used within a DiscordProvider
 */
export function useDiscordQueries() {
  const context = useContext(DiscordContext);
  if (!context) {
    throw new Error('useDiscordQueries must be used within a DiscordProvider');
  }
  return context;
}

/**
 * Base provider component that accepts queries and mutations
 */
export function DiscordProvider({
  queries,
  mutations,
  children,
}: {
  queries: DiscordQueries;
  mutations: DiscordMutations;
  children: ReactNode;
}) {
  return (
    <DiscordContext.Provider value={{ queries, mutations }}>{children}</DiscordContext.Provider>
  );
}
