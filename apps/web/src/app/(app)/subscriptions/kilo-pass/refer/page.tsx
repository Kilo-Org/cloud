'use client';

import { useQuery } from '@tanstack/react-query';

import { ImpactAdvocateReferralWidget } from '@/components/referrals/ImpactAdvocateReferralCard';
import { KiloPassReferralPageContent } from '@/components/referrals/KiloPassReferralPageContent';
import { useTRPC } from '@/lib/trpc/utils';

export default function KiloPassReferralPage() {
  const trpc = useTRPC();
  const rewardSummary = useQuery(trpc.kiloPass.getReferralRewardSummary.queryOptions());

  return (
    <KiloPassReferralPageContent
      summary={rewardSummary.data ?? null}
      isLoading={rewardSummary.isLoading}
      errorMessage={
        rewardSummary.isError ? 'Rewards are temporarily unavailable. Try again in a minute.' : null
      }
    >
      <ImpactAdvocateReferralWidget product="kilo_pass" />
    </KiloPassReferralPageContent>
  );
}
