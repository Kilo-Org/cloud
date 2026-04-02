'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Crown } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import { AvailableProductCard } from '@/components/subscriptions/AvailableProductCard';
import { SubscriptionCard } from '@/components/subscriptions/SubscriptionCard';
import { SubscriptionGroup } from '@/components/subscriptions/SubscriptionGroup';
import {
  formatDateLabel,
  formatKiloPassPrice,
  isInfoStatus,
  isKiloPassTerminal,
  isWarningStatus,
} from '@/components/subscriptions/helpers';

const kiloPassPlans: Array<{
  tier: KiloPassTier;
  title: string;
  description: string;
  price: string;
  badge?: string;
}> = [
  {
    tier: KiloPassTier.Tier19,
    title: 'Kilo Pass Starter',
    description: 'Get paid credits for personal usage and hosting.',
    price: '$19.00/month',
  },
  {
    tier: KiloPassTier.Tier49,
    title: 'Kilo Pass Pro',
    description: 'Higher monthly credits with stronger bonus ramps.',
    price: '$49.00/month',
    badge: 'Recommended',
  },
  {
    tier: KiloPassTier.Tier199,
    title: 'Kilo Pass Ultra',
    description: 'Maximum monthly credits for heavy usage.',
    price: '$199.00/month',
  },
];

export function KiloPassGroup({ showTerminal }: { showTerminal: boolean }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.kiloPass.getState.queryOptions());
  const checkout = useMutation(trpc.kiloPass.createCheckoutSession.mutationOptions());

  async function startCheckout(tier: KiloPassTier) {
    const result = await checkout.mutateAsync({ tier, cadence: KiloPassCadence.Monthly });
    if (result.url) {
      window.location.href = result.url;
    }
  }

  const subscription = query.data?.subscription ?? null;
  const shouldShowSubscription =
    subscription && (!isKiloPassTerminal(subscription.status) || showTerminal);

  return (
    <SubscriptionGroup
      title="Kilo Pass"
      description="Manage your Kilo Pass subscription and credit entitlements."
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      onRetry={() => void query.refetch()}
    >
      {shouldShowSubscription ? (
        <SubscriptionCard
          icon={<Crown className="h-5 w-5" />}
          title={`Kilo Pass ${subscription.tier}`}
          subtitle={`${subscription.tier} tier • ${subscription.cadence}`}
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
        <div className="grid gap-3 lg:grid-cols-3">
          {kiloPassPlans.map(plan => (
            <AvailableProductCard
              key={plan.tier}
              icon={<Crown className="h-5 w-5" />}
              title={plan.title}
              description={plan.description}
              price={plan.price}
              badge={plan.badge}
              cta={{
                label: checkout.isPending ? 'Opening...' : 'Subscribe',
                onClick: () => void startCheckout(plan.tier),
                disabled: checkout.isPending,
              }}
            />
          ))}
        </div>
      )}
    </SubscriptionGroup>
  );
}
