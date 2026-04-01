import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Edit, CreditCard, Download, AlertTriangle, Loader2, Repeat } from 'lucide-react';
import type Stripe from 'stripe';
import { toast } from 'sonner';
import {
  useCancelOrganizationSubscription,
  useGetCustomerPortalUrl,
  useOrganizationWithMembers,
  useChangeBillingCycle,
} from '@/app/api/organizations/hooks';
import { CancelSubscriptionModal } from './CancelSubscriptionModal';
import { SeatChangeModal } from './SeatChangeModal';
import { BillingCycleChangeDialog } from './BillingCycleChangeDialog';
import Link from 'next/link';
import { seatPrice } from '@/lib/organizations/constants';
import { useOrganizationReadOnly } from '@/lib/organizations/use-organization-read-only';
import { formatDate, canManageBilling, findPaidSeatItem } from './utils';
import type { SubscriptionWithPeriod } from './types';

export function SubscriptionQuickActions({
  subscription,
  organizationId,
  userRole,
}: {
  subscription: Stripe.Subscription;
  organizationId: string;
  userRole: string;
}) {
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showSeatChangeModal, setShowSeatChangeModal] = useState(false);
  const [showCycleChangeDialog, setShowCycleChangeDialog] = useState(false);
  const [isNavigatingToPortal, setIsNavigatingToPortal] = useState(false);
  const cancelSubscription = useCancelOrganizationSubscription();
  const changeBillingCycle = useChangeBillingCycle();
  const getCustomerPortalUrl = useGetCustomerPortalUrl();
  const org = useOrganizationWithMembers(organizationId);
  const isReadOnly = useOrganizationReadOnly(organizationId);

  const handleCancelSubscription = async () => {
    try {
      const result = await cancelSubscription.mutateAsync({ organizationId });
      toast.success(result.message);
      setShowCancelModal(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to cancel subscription');
    }
  };

  const handleChangeBillingCycle = async () => {
    const targetCycle = isMonthly ? 'annual' : 'monthly';
    try {
      const result = await changeBillingCycle.mutateAsync({
        organizationId,
        targetCycle,
      });
      toast.success(result.message);
      setShowCycleChangeDialog(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to change billing cycle');
    }
  };

  const handleUpdatePaymentMethod = async () => {
    try {
      const result = await getCustomerPortalUrl.mutateAsync({
        organizationId,
        returnUrl: window.location.href,
      });
      setIsNavigatingToPortal(true);
      window.location.href = result.url;
    } catch (error) {
      setIsNavigatingToPortal(false);
      toast.error(error instanceof Error ? error.message : 'Failed to get customer portal URL');
    }
  };

  const willCancelAtPeriodEnd = subscription.cancel_at_period_end;
  const billingAccess = canManageBilling(userRole);
  const canCancelSubscription =
    billingAccess && subscription.status === 'active' && !willCancelAtPeriodEnd;
  const canChangeSeatCount = billingAccess && subscription.status === 'active';
  // Derive seat count and interval from the paid seat item (unit_amount > 0),
  // not items[0] which could be a free-seat price in mixed subscriptions.
  const paidSeatItem = findPaidSeatItem(subscription.items.data);
  const currentSeatCount = paidSeatItem?.quantity || 0;
  const currentInterval = paidSeatItem?.price?.recurring?.interval;
  const isMonthly = currentInterval === 'month';
  const schedule = subscription.schedule;
  const hasPendingSchedule =
    schedule != null &&
    typeof schedule !== 'string' &&
    (schedule.status === 'active' || schedule.status === 'not_started');
  const canChangeBillingCycle = canCancelSubscription && !hasPendingSchedule;
  const periodEnd = (subscription as SubscriptionWithPeriod).current_period_end;
  const effectiveDateLabel = periodEnd ? formatDate(periodEnd) : null;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="m-2">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center space-y-3">
          {canChangeSeatCount && (
            <Button
              variant="outline"
              className="w-64 justify-center border-green-800 text-green-400 hover:bg-green-950 hover:text-green-300"
              onClick={() => setShowSeatChangeModal(true)}
              disabled={isReadOnly}
              title={isReadOnly ? 'Upgrade to enable' : undefined}
            >
              <Edit className="mr-2 h-4 w-4" />
              Change Seats
            </Button>
          )}

          {canChangeBillingCycle && (
            <Button
              variant="outline"
              className="w-64 justify-center"
              onClick={() => setShowCycleChangeDialog(true)}
            >
              <Repeat className="mr-2 h-4 w-4" />
              Switch to {isMonthly ? 'Annual' : 'Monthly'}
            </Button>
          )}

          <Button
            variant="outline"
            className="w-64 justify-center"
            onClick={handleUpdatePaymentMethod}
            disabled={getCustomerPortalUrl.isPending || isNavigatingToPortal}
          >
            {getCustomerPortalUrl.isPending || isNavigatingToPortal ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CreditCard className="mr-2 h-4 w-4" />
            )}
            Update Payment Method
          </Button>

          <Button
            variant="outline"
            className="flex w-64 flex-nowrap justify-center text-nowrap"
            asChild
          >
            <Link href={`/organizations/${organizationId}/payment-details`}>
              <Download className="mr-2 h-4 w-4" />
              View Payment History
            </Link>
          </Button>

          {canCancelSubscription && (
            <Button
              variant="outline"
              className="text-destructive w-64 justify-center border-red-800 hover:bg-red-950 hover:text-red-400"
              onClick={() => setShowCancelModal(true)}
            >
              <AlertTriangle className="mr-2 h-4 w-4" />
              Cancel Subscription
            </Button>
          )}
        </CardContent>
      </Card>

      <CancelSubscriptionModal
        isOpen={showCancelModal}
        onClose={() => setShowCancelModal(false)}
        onConfirm={handleCancelSubscription}
        isLoading={cancelSubscription.isPending}
      />

      {org.data && (
        <SeatChangeModal
          isOpen={showSeatChangeModal}
          onClose={() => setShowSeatChangeModal(false)}
          currentSeatCount={currentSeatCount}
          organizationId={organizationId}
          price={seatPrice(org.data.plan, isMonthly ? 'monthly' : 'annual')}
        />
      )}

      {org.data && (
        <BillingCycleChangeDialog
          isOpen={showCycleChangeDialog}
          onClose={() => setShowCycleChangeDialog(false)}
          onConfirm={handleChangeBillingCycle}
          isLoading={changeBillingCycle.isPending}
          targetCycle={isMonthly ? 'annual' : 'monthly'}
          currentCycle={isMonthly ? 'monthly' : 'annual'}
          seatCount={currentSeatCount}
          plan={org.data.plan}
          effectiveDate={effectiveDateLabel}
        />
      )}
    </>
  );
}
