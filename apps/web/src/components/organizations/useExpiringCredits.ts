import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { getExpiringCreditGroups } from '@/lib/getExpiringCreditGroups';

export function useExpiringCredits(organizationId: string) {
  const trpc = useTRPC();
  const { data: creditBlocksData } = useQuery(
    trpc.organizations.getCreditBlocks.queryOptions({ organizationId })
  );

  return getExpiringCreditGroups(creditBlocksData?.creditBlocks ?? []);
}
