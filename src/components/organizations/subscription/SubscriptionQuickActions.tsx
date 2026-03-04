import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Edit, CreditCard, Download, AlertTriangle, Loader2 } from 'lucide-react';
import type Stripe from 'stripe';
import { toast } from 'sonner';
import {
  useCancelOrganizationSubscription,
  useGetCustomerPortalUrl,
  useOrganizationWithMembers,
} from '@/app/api/organizations/hooks';
import { CancelSubscriptionModal } from './CancelSubscriptionModal';
import { SeatChangeModal } from './SeatChangeModal';
import Link from 'next/link';
import {
  TEAM_SEAT_PRICE_MONTHLY_USD,
  ENTERPRISE_SEAT_PRICE_MONTHLY_USD,
} from '@/lib/organizations/constants';
import { useOrganizationReadOnly } from '@/lib/organizations/use-organization-read-only';

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
  const [isNavigatingToPortal, setIsNavigatingToPortal] = useState(false);
  const cancelSubscription = useCancelOrganizationSubscription();
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
  const canCancelSubscription =
    userRole === 'owner' && subscription.status === 'active' && !willCancelAtPeriodEnd;
  const canChangeSeatCount = userRole === 'owner' && subscription.status === 'active';
  const currentSeatCount = subscription.items.data[0]?.quantity || 0;

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
              View Billing History
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
          price={
            org.data.plan === 'teams'
              ? TEAM_SEAT_PRICE_MONTHLY_USD
              : ENTERPRISE_SEAT_PRICE_MONTHLY_USD
          }
        />
      )}
    </>
  );
}
