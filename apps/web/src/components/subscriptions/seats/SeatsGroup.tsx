'use client';

import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import type Stripe from 'stripe';
import { useTRPC } from '@/lib/trpc/utils';
import { SubscriptionCard } from '@/components/subscriptions/SubscriptionCard';
import { SubscriptionGroup } from '@/components/subscriptions/SubscriptionGroup';
import {
  formatDateLabel,
  isSeatsTerminal,
  isWarningStatus,
} from '@/components/subscriptions/helpers';
import type { OrganizationPlan } from '@/lib/organizations/organization-types';
import { SeatsSubscribeCard } from './SeatsSubscribeCard';

function getSeatPrice(
  subscription: Stripe.Subscription,
  paidSeatItem: Stripe.SubscriptionItem | null
) {
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
  organizationPlan,
  showTerminal,
}: {
  organizationId: string;
  organizationPlan: OrganizationPlan;
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
  const paidSeatItemId = query.data?.paidSeatItemId ?? null;
  const paidSeatItem = subscription?.items.data.find(item => item.id === paidSeatItemId) ?? null;

  return (
    <SubscriptionGroup
      title="Teams / Enterprise Seats"
      description="Manage seats and renewal details for this organization."
      headerIcon={<Users className="h-5 w-5" />}
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
          price={getSeatPrice(subscription, paidSeatItem)}
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
      ) : (
        <SeatsSubscribeCard
          key={organizationId}
          organizationId={organizationId}
          currentPlan={organizationPlan}
        />
      )}
    </SubscriptionGroup>
  );
}
