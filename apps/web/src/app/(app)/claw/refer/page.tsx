'use client';

import { Gift } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { SetPageTitle } from '@/components/SetPageTitle';
import { Card, CardContent } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc/utils';
import { ImpactAdvocateReferralWidget } from '@/components/referrals/ImpactAdvocateReferralCard';
import { ReferralRewardStatusCard } from '../components/billing/ReferralRewardStatusCard';

const emptyRewardSummary = {
  totals: {
    totalRewards: 0,
    pendingRewards: 0,
    totalAppliedMonths: 0,
  },
  pendingRewardAction: {
    showStartReactivateCta: false,
    pendingRewardCount: 0,
  },
  referredPeople: [],
  rewards: [],
};

export default function PersonalClawReferPage() {
  const trpc = useTRPC();
  const rewardSummary = useQuery(trpc.kiloclaw.getReferralRewardSummary.queryOptions());

  return (
    <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
      <SetPageTitle
        title="Refer and earn"
        icon={<Gift className="text-muted-foreground h-4 w-4" />}
      />
      {rewardSummary.isLoading ? (
        <Card>
          <CardContent className="text-muted-foreground p-6 text-sm">Loading rewards…</CardContent>
        </Card>
      ) : (
        <ReferralRewardStatusCard
          summary={rewardSummary.data ?? emptyRewardSummary}
          shareWidget={<ImpactAdvocateReferralWidget />}
        />
      )}
    </div>
  );
}
