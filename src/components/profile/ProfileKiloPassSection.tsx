'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { KiloPassCadence } from '@/lib/kilo-pass/enums';
import { useTRPC } from '@/lib/trpc/utils';
import { KiloPassActiveSubscriptionCard } from '@/components/profile/kilo-pass/KiloPassActiveSubscriptionCard';
import { KiloPassLoadingCard } from '@/components/profile/kilo-pass/KiloPassLoadingCard';
import { KiloPassSubscribeCard } from '@/components/profile/kilo-pass/KiloPassSubscribeCard';
import { isStripeSubscriptionEnded } from '@/lib/kilo-pass/stripe-subscription-status';
import { recommendKiloPassTierFromAverageMonthlyUsageUsd } from '@/lib/kilo-pass/recommend-tier';
import { KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF } from '@/lib/kilo-pass/constants';
import { dayjs } from '@/lib/kilo-pass/dayjs';

export function ProfileKiloPassSection() {
  const trpc = useTRPC();
  const query = useQuery(trpc.kiloPass.getState.queryOptions());

  const subscriptionFromQuery = query.data?.subscription;
  const hasActiveSubscription =
    subscriptionFromQuery != null && !isStripeSubscriptionEnded(subscriptionFromQuery.status);

  const averageMonthlyUsageQuery = useQuery({
    ...trpc.kiloPass.getAverageMonthlyUsageLast3Months.queryOptions(),
    enabled: query.isSuccess && !hasActiveSubscription,
  });

  const [cadence, setCadence] = useState<KiloPassCadence>(KiloPassCadence.Monthly);

  const checkoutMutation = useMutation(
    trpc.kiloPass.createCheckoutSession.mutationOptions({
      onSuccess: result => {
        if (!result.url) {
          toast.error('Failed to create Stripe checkout session');
          return;
        }
        window.location.href = result.url;
      },
      onError: error => {
        toast.error(error.message || 'Failed to start checkout');
      },
    })
  );

  if (query.isPending) {
    return <KiloPassLoadingCard />;
  }

  if (query.isError) {
    return null;
  }

  const subscription = query.data.subscription;
  const activeSubscription =
    subscription != null && !isStripeSubscriptionEnded(subscription.status) ? subscription : null;

  if (!activeSubscription) {
    const pending = checkoutMutation.isPending;
    const showFirstMonthPromo = query.data.isEligibleForFirstMonthPromo;
    const showSecondMonthPromo =
      showFirstMonthPromo && dayjs().utc().isBefore(KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF);
    const averageMonthlyUsageUsd = averageMonthlyUsageQuery.data?.averageMonthlyUsageUsd;
    const recommendedTier =
      typeof averageMonthlyUsageUsd === 'number'
        ? recommendKiloPassTierFromAverageMonthlyUsageUsd({ averageMonthlyUsageUsd })
        : null;

    return (
      <KiloPassSubscribeCard
        cadence={cadence}
        setCadence={setCadence}
        pending={pending}
        showFirstMonthPromo={showFirstMonthPromo}
        showSecondMonthPromo={showSecondMonthPromo}
        recommendedTier={recommendedTier}
        onSelectTier={tier => checkoutMutation.mutate({ tier, cadence })}
      />
    );
  }

  return <KiloPassActiveSubscriptionCard subscription={activeSubscription} />;
}
