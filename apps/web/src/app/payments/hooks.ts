import type { Organization } from '@kilocode/db/schema';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

type UseStripeSessionStatusOptions = {
  organizationId: Organization['id'];
  sessionId: string;
};

export function useStripeSessionStatus({
  organizationId,
  sessionId,
}: UseStripeSessionStatusOptions) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.subscription.getByStripeSessionId.queryOptions(
      {
        organizationId,
        sessionId,
      },
      {
        retry: 10,
        retryDelay: 1000,
      }
    )
  );
}
