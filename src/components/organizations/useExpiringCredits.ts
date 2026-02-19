import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export function useExpiringCredits(organizationId: string) {
  const trpc = useTRPC();
  const { data: creditBlocksData } = useQuery(
    trpc.organizations.getCreditBlocks.queryOptions({ organizationId })
  );

  const expiringBlocks =
    creditBlocksData?.creditBlocks.filter(
      block => block.expiry_date !== null && block.balance_mUsd > 0
    ) ?? [];
  const expiring_mUsd = expiringBlocks.reduce((sum, block) => sum + block.balance_mUsd, 0);
  const earliestExpiry = expiringBlocks
    .map(block => block.expiry_date)
    .filter((date): date is string => date !== null)
    .sort()[0] as string | undefined;

  return { expiringBlocks, expiring_mUsd, earliestExpiry };
}
