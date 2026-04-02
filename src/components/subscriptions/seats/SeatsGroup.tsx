'use client';

import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import type Stripe from 'stripe';
import { Card, CardContent } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc/utils';
import { CreateSubscriptionButton } from '@/components/organizations/subscription/CreateSubscriptionButton';
import { AvailableProductCard } from '@/components/subscriptions/AvailableProductCard';
import { SubscriptionCard } from '@/components/subscriptions/SubscriptionCard';
import { SubscriptionGroup } from '@/components/subscriptions/SubscriptionGroup';
import {
  formatDateLabel,
  getPaidSeatSubscriptionItem,
  isSeatsTerminal,
  isWarningStatus,
} from '@/components/subscriptions/helpers';

function getSeatPrice(subscription: Stripe.Subscription) {
  const paidSeatItem = getPaidSeatSubscriptionItem(subscription);
  const totalAmount = subscription.items.data.reduce(
    (sum: number, item: Stripe.SubscriptionItem) =>
      sum + (item.price?.unit_amount ?? 0) * (item.quantity ?? 0),
    0
  );
  const interval = paidSeatItem?.price?.recurring?.interval === 'year' ? 'year' : 'month';
  return `$${(totalAmount / 100).toFixed(2)}/${interval}`;
}

export function SeatsGroup({
  organizationId,
  showTerminal,
}: {
  organizationId: string;
  showTerminal: boolean;
}) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.organizations.subscription.get.queryOptions(
      { organizationId },
      { enabled: !!organizationId }
    )
  );

  const subscription = query.data?.subscription ?? null;
  const status = subscription?.status ?? 'ended';
  const isVisible = subscription && (!isSeatsTerminal(status) || showTerminal);
  const paidSeatItem = subscription ? getPaidSeatSubscriptionItem(subscription) : null;

  return (
    <SubscriptionGroup
      title="Teams / Enterprise Seats"
      description="Manage seats and renewal details for this organization."
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      onRetry={() => void query.refetch()}
    >
      {isVisible && subscription ? (
        <SubscriptionCard
          icon={<Users className="h-5 w-5" />}
          title="Teams / Enterprise Seats"
          subtitle={`${query.data?.seatsUsed ?? 0} of ${query.data?.totalSeats ?? 0} seats in use`}
          status={subscription.status}
          price={getSeatPrice(subscription)}
          billingDate={formatDateLabel(
            paidSeatItem?.current_period_end
              ? new Date(paidSeatItem.current_period_end * 1000).toISOString()
              : null,
            '—'
          )}
          paymentMethod="Stripe"
          href={`/organizations/${organizationId}/subscriptions/seats`}
          isTerminal={isSeatsTerminal(subscription.status)}
          warningTone={
            isWarningStatus(subscription.status) || subscription.cancel_at_period_end
              ? 'warning'
              : undefined
          }
        />
      ) : subscription ? (
        <Card>
          <CardContent className="text-muted-foreground p-5 text-sm">
            This organization has an ended seats subscription. Turn on &quot;Show ended&quot; to
            review it.
          </CardContent>
        </Card>
      ) : (
        <AvailableProductCard
          icon={<Users className="h-5 w-5" />}
          title="Teams / Enterprise Seats"
          description="Create a seats subscription for this organization."
          price="Flexible monthly or annual billing"
          action={<CreateSubscriptionButton organizationId={organizationId} className="w-full" />}
        />
      )}
    </SubscriptionGroup>
  );
}
