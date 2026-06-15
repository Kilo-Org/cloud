'use client';

import { useQuery } from '@tanstack/react-query';

import { ImpactAdvocateReferralWidget } from '@/components/referrals/ImpactAdvocateReferralCard';
import { KiloPassReferralPageContent } from '@/components/referrals/KiloPassReferralPageContent';
import { useTRPC } from '@/lib/trpc/utils';

export default function KiloPassReferralPage() {
  const trpc = useTRPC();
  const rewardSummary = useQuery(trpc.kiloPass.getReferralRewardSummary.queryOptions());
  const state = useQuery(trpc.kiloPass.getState.queryOptions());
  const subscription = state.isPending ? undefined : (state.data?.subscription ?? null);

  return (
    <KiloPassReferralPageContent
      summary={rewardSummary.data ?? null}
      subscriptionContext={
        subscription
          ? {
              status: subscription.status,
              cadence: subscription.cadence,
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            }
          : subscription
      }
      isSubscriptionContextLoading={state.isPending}
      isLoading={rewardSummary.isLoading}
      errorMessage={
        rewardSummary.isError ? 'Rewards are temporarily unavailable. Try again in a minute.' : null
      }
    >
      <ImpactAdvocateReferralWidget product="kilo_pass" />
    </KiloPassReferralPageContent>
  );
}
