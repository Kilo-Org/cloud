/**
 * Hook for polling active CLI sessions from the session-ingest worker.
 */

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export type ActiveSession = {
  id: string;
  status: string;
  title: string;
  connectionId: string;
  gitUrl?: string;
  gitBranch?: string;
};

export function useActiveSessions(): {
  activeSessions: ActiveSession[];
  isLoading: boolean;
} {
  const trpc = useTRPC();

  const { data, isLoading } = useQuery({
    ...trpc.activeSessions.list.queryOptions(),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  return {
    activeSessions: data?.sessions ?? [],
    isLoading,
  };
}
