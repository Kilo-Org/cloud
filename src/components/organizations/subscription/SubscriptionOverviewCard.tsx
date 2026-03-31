import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Calendar, Users, AlertTriangle, Clock, RefreshCcw } from 'lucide-react';
import type Stripe from 'stripe';
import { toast } from 'sonner';
import {
  useStopOrganizationSubscriptionCancellation,
  useOrganizationSubscriptionLink,
  useCancelBillingCycleChange,
} from '@/app/api/organizations/hooks';
import { SubscriptionStatusBadge } from './SubscriptionStatusBadge';
import type {
  SubscriptionItemWithPeriod,
  SubscriptionWithPeriod,
} from '@/components/organizations/subscription/types';
import {
  formatDate,
  formatCurrency,
  canManageBilling,
  findPaidSeatItem,
  paidSeatQuantity,
} from './utils';
import { useIsKiloAdmin } from '@/components/organizations/OrganizationContext';
import { getSubscriptionStatusConfig, formatBillingInterval } from './subscriptionStatusConfig';
import { useState } from 'react';
type SeatCountChangeNotificationProps = {
  totalSeats: number;
  subscriptionQuantity: number;
  seatsUsed: number;
};

function SeatCountChangeNotification({
  totalSeats,
  subscriptionQuantity,
  seatsUsed,
}: SeatCountChangeNotificationProps) {
  const isDisruptive = subscriptionQuantity < seatsUsed;
  const bgColor = isDisruptive ? 'bg-red-50' : 'bg-blue-50';
  const iconColor = isDisruptive ? 'text-red-600' : 'text-blue-600';
  const titleColor = isDisruptive ? 'text-red-800' : 'text-blue-800';
  const textColor = isDisruptive ? 'text-red-700' : 'text-blue-700';

  return (
    <div className={`border-t ${bgColor} rounded-b-lg px-6 py-4`}>
      <div className="flex items-center gap-2">
        <AlertTriangle className={`h-4 w-4 ${iconColor}`} />
        <div>
          <p className={`text-sm font-medium ${titleColor}`}>Seat Count Change Scheduled</p>
          <p className={`text-sm ${textColor}`}>
            Next billing cycle your total seats will drop from {totalSeats} to{' '}
            {subscriptionQuantity}
          </p>
          {isDisruptive && (
            <p className={`text-sm ${textColor} mt-1`}>
              To prevent your team from disruption please remove members from seats or upgrade to
              more seats before the next billing cycle.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

type PendingCycleChange = {
  targetCycleName: string;
  effectiveDate: string;
  description: string | null;
  targetInterval: string;
};

function detectPendingCycleChange(
  subscription: Stripe.Subscription,
  currentBillingInterval: string | undefined
): PendingCycleChange | null {
  const schedule = subscription.schedule;
  if (!schedule || typeof schedule === 'string') return null;
  if (schedule.status !== 'active' && schedule.status !== 'not_started') return null;

  const phase2 = schedule.phases?.[1];
  if (!phase2?.items?.length) return null;

  const currentPriceIds = new Set(subscription.items.data.map(item => item.price?.id));
  const phase2PriceIds = phase2.items.map(item =>
    typeof item.price === 'string' ? item.price : item.price?.id
  );

  const hasChangedPrice = phase2PriceIds.some(id => id && !currentPriceIds.has(id));
  if (!hasChangedPrice) return null;

  const targetCycleName = currentBillingInterval === 'month' ? 'Annual' : 'Monthly';
  const effectiveDate = formatDate(phase2.start_date);
  const isUpgradeToAnnual = currentBillingInterval === 'month';
  const description = isUpgradeToAnnual
    ? 'No charges or proration until the switch takes effect.'
    : null;
  const targetInterval = currentBillingInterval === 'month' ? 'year' : 'month';

  return { targetCycleName, effectiveDate, description, targetInterval };
}

export function SubscriptionOverviewCard({
  subscription,
  organizationId,
  userRole,
  seatsUsed,
  totalSeats,
}: {
  subscription: Stripe.Subscription;
  organizationId: string;
  userRole: string;
  seatsUsed: number;
  totalSeats: number;
}) {
  // Get current period dates from subscription.items[0] if it exists, otherwise from subscription
  const firstItem = subscription.items?.data?.[0] as SubscriptionItemWithPeriod | undefined;
  const subscriptionWithPeriod = subscription as SubscriptionWithPeriod;

  // Try to get from items first, then fallback to subscription properties
  // const currentPeriodStart =
  //   firstItem?.current_period_start || subscriptionWithPeriod.current_period_start;
  const currentPeriodEnd =
    firstItem?.current_period_end || subscriptionWithPeriod.current_period_end;

  // Derive billing interval from the paid seat item (unit_amount > 0),
  // not free promotional items which may have a different cadence.
  const currentBillingInterval = (
    findPaidSeatItem(subscription.items.data) ?? subscription.items.data[0]
  )?.price?.recurring?.interval;

  const stopCancellation = useStopOrganizationSubscriptionCancellation();
  const subscriptionLink = useOrganizationSubscriptionLink();
  const cancelBillingCycleChange = useCancelBillingCycleChange();
  const isKiloAdmin = useIsKiloAdmin();
  const [resubscribeError, setResubscribeError] = useState<string | null>(null);

  const pendingCycleChange = detectPendingCycleChange(subscription, currentBillingInterval);

  const handleCancelBillingCycleChange = async () => {
    try {
      const result = await cancelBillingCycleChange.mutateAsync({ organizationId });
      toast.success(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to cancel billing cycle change');
    }
  };

  const handleStopCancellation = async () => {
    try {
      const result = await stopCancellation.mutateAsync({
        organizationId,
      });
      toast.success(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to stop cancellation');
    }
  };

  const handleResubscribe = async () => {
    setResubscribeError(null);

    try {
      // Only count paid seat items (unit_amount > 0). Free-seat items have
      // unit_amount === 0 and must not be included because checkout creates a
      // single paid line item — including free seats would overcharge.
      const currentSeatCount = paidSeatQuantity(subscription.items.data) || 1;

      // Preserve the billing cycle the org was on before cancellation
      const billingCycle = currentBillingInterval === 'month' ? 'monthly' : 'annual';

      const result = await subscriptionLink.mutateAsync({
        organizationId,
        seats: currentSeatCount,
        cancelUrl: window.location.href, // Return to current page if cancelled
        billingCycle,
      });

      // Redirect to Stripe checkout
      if (result.url) {
        window.location.href = result.url;
      } else {
        throw new Error('No checkout URL received from server');
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to create subscription link';
      setResubscribeError(errorMessage);
      toast.error(errorMessage);
    }
  };

  const willCancelAtPeriodEnd =
    subscriptionWithPeriod.cancel_at || subscription.cancel_at_period_end;

  const ended = Boolean(subscription.ended_at);

  const billingAccess = canManageBilling(userRole);

  const canStopCancellation =
    billingAccess && subscription.status === 'active' && willCancelAtPeriodEnd;

  const statusConfig = getSubscriptionStatusConfig(subscription.status);

  const subscriptionQuantity = paidSeatQuantity(subscription.items.data);
  const willSeatsDropNextCycle =
    totalSeats > subscriptionQuantity && !ended && !willCancelAtPeriodEnd;

  // Calculate days until renewal
  const calculateDaysUntilRenewal = () => {
    if (!currentPeriodEnd) return 0;
    const now = new Date();
    const renewalDate = new Date(currentPeriodEnd * 1000); // Convert Unix timestamp to Date
    const diffTime = renewalDate.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(0, diffDays); // Don't show negative days
  };

  const daysUntilRenewal = calculateDaysUntilRenewal();

  return (
    <>
      <Card className={`mb-6 border-l-4 ${statusConfig.borderColor} shadow-sm`}>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-2xl">
              Current Subscription
              <SubscriptionStatusBadge status={subscription.status} />
            </div>
          </CardTitle>
          {isKiloAdmin && <CardDescription>Subscription ID: {subscription.id}</CardDescription>}
        </CardHeader>
        <CardContent className="mt-2">
          <div
            className={`grid grid-cols-1 gap-6 ${ended || willCancelAtPeriodEnd ? 'md:grid-cols-2' : 'md:grid-cols-4'}`}
          >
            {!ended && !willCancelAtPeriodEnd && (
              <div className="space-y-2">
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Calendar className="h-4 w-4" />
                  Next Payment
                </div>
                <div className="text-xl font-bold">
                  {(() => {
                    if (pendingCycleChange) {
                      // Phase 2 prices aren't expanded so we can't read
                      // unit_amount. Show a qualitative indicator instead of
                      // a stale dollar figure from the current phase.
                      return 'Changes at renewal';
                    }
                    // Sum unit_amount * quantity across all items
                    const totalAmount = subscription.items.data.reduce(
                      (sum, item) => sum + (item.price?.unit_amount ?? 0) * (item.quantity ?? 0),
                      0
                    );
                    return totalAmount > 0 ? formatCurrency(totalAmount) : 'N/A';
                  })()}
                </div>
                <div className="text-muted-foreground text-sm">
                  {currentPeriodEnd ? formatDate(currentPeriodEnd) : 'N/A'}
                </div>
              </div>
            )}
            <div className="space-y-2">
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Users className="h-4 w-4" />
                Seats Used
              </div>
              <div className="text-xl font-bold">
                {seatsUsed}/{totalSeats || 0}
              </div>
              <div className="text-muted-foreground text-sm">
                {Math.max(0, (totalSeats || 0) - seatsUsed)} seats available
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <RefreshCcw className="h-4 w-4" />
                Billing Cycle
              </div>
              <div className="text-xl font-bold">
                {pendingCycleChange
                  ? `${formatBillingInterval(currentBillingInterval)} \u2192 ${formatBillingInterval(pendingCycleChange.targetInterval)}`
                  : formatBillingInterval(currentBillingInterval)}
              </div>
              <div className="text-muted-foreground text-sm">
                Collection:{' '}
                {subscription.collection_method === 'charge_automatically' ? 'Automatic' : 'Manual'}
              </div>
            </div>
            {!ended && (
              <div className="space-y-2">
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Clock className="h-4 w-4" />
                  Days Until Renewal
                </div>
                <div className="text-xl font-bold">{daysUntilRenewal}</div>
                <div className="text-muted-foreground text-sm">
                  {subscription.cancel_at_period_end
                    ? 'Will cancel at period end'
                    : 'Auto-renewal enabled'}
                </div>
              </div>
            )}
          </div>

          {/* Pending billing cycle change banner */}
          {pendingCycleChange && (
            <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-amber-400/20 bg-amber-400/[0.08] p-3">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div>
                <p className="text-sm text-amber-300">
                  <span className="font-semibold">
                    Switching to {pendingCycleChange.targetCycleName} billing on{' '}
                    {pendingCycleChange.effectiveDate}.
                  </span>{' '}
                  {pendingCycleChange.description}
                </p>
                {billingAccess && (
                  <div className="mt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-amber-400/30 text-amber-400 hover:bg-amber-400/10"
                      onClick={handleCancelBillingCycleChange}
                      disabled={cancelBillingCycleChange.isPending}
                    >
                      {cancelBillingCycleChange.isPending ? 'Cancelling...' : 'Cancel Change'}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            {ended && subscription.ended_at ? (
              <div>
                <p className="text-sm font-medium">Subscription Ended</p>
                <p className="text-muted-foreground text-sm">{formatDate(subscription.ended_at)}</p>
              </div>
            ) : (
              subscriptionWithPeriod.cancel_at && (
                <div>
                  <p className="text-sm font-medium">Scheduled Cancellation</p>
                  <p className="text-muted-foreground text-sm">
                    {subscriptionWithPeriod.cancel_at
                      ? formatDate(subscriptionWithPeriod.cancel_at)
                      : 'N/A'}
                  </p>
                </div>
              )
            )}
          </div>
        </CardContent>

        {willSeatsDropNextCycle && (
          <SeatCountChangeNotification
            totalSeats={totalSeats}
            subscriptionQuantity={subscriptionQuantity}
            seatsUsed={seatsUsed}
          />
        )}

        {/* Payment issue warning for incomplete or past_due subscriptions */}
        {(subscription.status === 'incomplete' || subscription.status === 'past_due') && (
          <div className="rounded-b-lg border-t bg-amber-50 px-6 py-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <div>
                <p className="text-sm font-medium text-amber-800">
                  {subscription.status === 'incomplete' ? 'Payment Required' : 'Payment Past Due'}
                </p>
                <p className="text-sm text-amber-700">
                  {subscription.status === 'incomplete'
                    ? 'Your subscription is pending payment. Please complete payment to activate your seats.'
                    : 'Your payment has failed. Please update your payment method to avoid service interruption.'}
                </p>
              </div>
            </div>
          </div>
        )}

        {(willCancelAtPeriodEnd || ended) && (
          <div className={`rounded-b-lg border-t px-6 py-4 ${ended ? 'bg-red-50' : 'bg-amber-50'}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className={`h-4 w-4 ${ended ? 'text-red-600' : 'text-amber-600'}`} />
                <div>
                  <p className={`text-sm font-medium ${ended ? 'text-red-800' : 'text-amber-800'}`}>
                    {ended ? 'Subscription has been canceled' : 'Subscription will be canceled'}
                  </p>
                  <p className={`text-sm ${ended ? 'text-red-700' : 'text-amber-700'}`}>
                    Your subscription {ended ? 'ended on ' : 'will end on '}
                    {ended && subscription.ended_at
                      ? formatDate(subscription.ended_at)
                      : currentPeriodEnd
                        ? formatDate(currentPeriodEnd)
                        : 'the end of the current period'}
                  </p>
                </div>
              </div>
              {canStopCancellation && !ended && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStopCancellation}
                  disabled={stopCancellation.isPending}
                  className="border-amber-300 bg-white text-amber-800 hover:bg-amber-100 hover:text-amber-900"
                >
                  {stopCancellation.isPending ? 'Stopping...' : 'Stop Pending Cancellation'}
                </Button>
              )}
              {ended && billingAccess && (
                <div className="flex flex-col items-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-green-700 bg-green-700 text-white hover:bg-green-800"
                    onClick={handleResubscribe}
                    disabled={subscriptionLink.isPending}
                  >
                    Resubscribe
                  </Button>
                  {resubscribeError && (
                    <p className="max-w-xs text-right text-sm text-red-600">{resubscribeError}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
