'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export function usePaidCreditPolicyReady() {
  const trpc = useTRPC();
  const policy = useQuery(trpc.user.getPaidCreditPolicy.queryOptions());
  return policy.isSuccess && policy.data !== undefined;
}

export function CreditExpiryNotice({ purchase = 'credits' }: { purchase?: 'credits' | 'pass' }) {
  const trpc = useTRPC();
  const policyQuery = useQuery(trpc.user.getPaidCreditPolicy.queryOptions());
  const policy = policyQuery.data;
  const expiryPolicy = purchase === 'pass' ? policy?.passExpiryPolicy : policy?.creditExpiryPolicy;

  if (!policyQuery.isSuccess) {
    return (
      <p className="text-muted-foreground text-xs leading-5" role="status">
        {policyQuery.isError ? (
          <>
            Credit expiration terms are unavailable.{' '}
            <button
              type="button"
              className="underline underline-offset-4"
              onClick={() => void policyQuery.refetch()}
            >
              Retry loading terms
            </button>
          </>
        ) : (
          'Loading credit expiration terms...'
        )}
      </p>
    );
  }

  if (expiryPolicy !== 'one_year') return null;

  return (
    <p className="text-muted-foreground text-xs leading-5">
      {purchase === 'pass'
        ? 'Each monthly base-credit allotment expires one year after issuance. Bonus-credit deadlines are unchanged. Existing credits keep their current terms. Annual terms paid before this policy began keep their original terms until renewal.'
        : 'Purchased credits expire one year after purchase. Existing credits keep their current terms. Promotional and bonus credits may expire sooner.'}
    </p>
  );
}
