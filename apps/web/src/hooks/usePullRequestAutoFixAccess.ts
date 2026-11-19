import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export function usePullRequestAutoFixAccess() {
  const trpc = useTRPC();
  const { data } = useQuery(
    trpc.cloudAgentSettings.canUsePullRequestAutoFix.queryOptions(undefined, { staleTime: 60_000 })
  );
  return data === true;
}
