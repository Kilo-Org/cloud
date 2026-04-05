import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

type UseStripeSessionStatusOptions = {
  sessionId: string;
};

export function useStripeSessionStatus({ sessionId }: UseStripeSessionStatusOptions) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.subscription.getByStripeSessionId.queryOptions(
      {
        sessionId,
      },
      {
        retry: 10,
        retryDelay: 1000,
      }
    )
  );
}
