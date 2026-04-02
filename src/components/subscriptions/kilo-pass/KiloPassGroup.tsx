'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Crown } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF } from '@/lib/kilo-pass/constants';
import { dayjs } from '@/lib/kilo-pass/dayjs';
import { KiloPassCadence } from '@/lib/kilo-pass/enums';
import type { KiloPassTier } from '@/lib/kilo-pass/enums';
import { recommendKiloPassTierFromAverageMonthlyUsageUsd } from '@/lib/kilo-pass/recommend-tier';
import { KiloPassSubscribeCard } from '@/components/profile/kilo-pass/KiloPassSubscribeCard';
import { SubscriptionCard } from '@/components/subscriptions/SubscriptionCard';
import { SubscriptionGroup } from '@/components/subscriptions/SubscriptionGroup';
import {
  formatDateLabel,
  formatKiloPassCadenceLabel,
  formatKiloPassPrice,
  formatKiloPassTierLabel,
  isInfoStatus,
  isKiloPassTerminal,
  isWarningStatus,
} from '@/components/subscriptions/helpers';

function getShowKiloPassTwoMonthPromo(showFirstMonthPromo: boolean): boolean {
  return (
    showFirstMonthPromo && dayjs().utc().isBefore(KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF)
  );
}

export function KiloPassGroup({
  showTerminal,
  accordionValue,
}: {
  showTerminal: boolean;
  accordionValue?: string;
}) {
  const trpc = useTRPC();
  const query = useQuery(trpc.kiloPass.getState.queryOptions());
  const [cadence, setCadence] = useState<KiloPassCadence>(KiloPassCadence.Monthly);

  const subscription = query.data?.subscription ?? null;
  const shouldShowSubscription =
    subscription && (!isKiloPassTerminal(subscription.status) || showTerminal);

  const averageMonthlyUsageQuery = useQuery({
    ...trpc.kiloPass.getAverageMonthlyUsageLast3Months.queryOptions(),
    enabled: query.isSuccess && !shouldShowSubscription,
  });

  const checkout = useMutation(
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

  async function startCheckout(tier: KiloPassTier) {
    await checkout.mutateAsync({ tier, cadence });
  }

  const showFirstMonthPromo = query.data?.isEligibleForFirstMonthPromo ?? false;
  const showSecondMonthPromo = getShowKiloPassTwoMonthPromo(showFirstMonthPromo);
  const averageMonthlyUsageUsd = averageMonthlyUsageQuery.data?.averageMonthlyUsageUsd;
  const recommendedTier =
    typeof averageMonthlyUsageUsd === 'number'
      ? recommendKiloPassTierFromAverageMonthlyUsageUsd({ averageMonthlyUsageUsd })
      : null;

  return (
    <SubscriptionGroup
      title="Kilo Pass"
      description="Manage your Kilo Pass subscription and credit entitlements."
      headerIcon={<Crown className="h-5 w-5" />}
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      onRetry={() => void query.refetch()}
      accordionValue={accordionValue}
    >
      {shouldShowSubscription ? (
        <SubscriptionCard
          icon={<Crown className="h-5 w-5" />}
          title={`Kilo Pass ${formatKiloPassTierLabel(subscription.tier)}`}
          subtitle={`${formatKiloPassTierLabel(subscription.tier)} tier • ${formatKiloPassCadenceLabel(subscription.cadence)}`}
          status={subscription.status}
          price={formatKiloPassPrice(subscription.tier, subscription.cadence)}
          billingDate={formatDateLabel(subscription.nextBillingAt, 'Subscription ended')}
          paymentMethod="Stripe"
          href="/subscriptions/kilo-pass"
          isTerminal={isKiloPassTerminal(subscription.status)}
          warningTone={
            isWarningStatus(subscription.status)
              ? 'warning'
              : isInfoStatus(subscription.status)
                ? 'info'
                : undefined
          }
        />
      ) : (
        <KiloPassSubscribeCard
          cadence={cadence}
          setCadence={setCadence}
          pending={checkout.isPending}
          showFirstMonthPromo={showFirstMonthPromo}
          showSecondMonthPromo={showSecondMonthPromo}
          recommendedTier={recommendedTier}
          onSelectTier={tier => void startCheckout(tier)}
          showHeader={false}
          contentClassName="p-6"
        />
      )}
    </SubscriptionGroup>
  );
}
