'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import Link from 'next/link';
import { Users } from 'lucide-react';
import { ErrorCard } from '../ErrorCard';
import { LoadingCard } from '../LoadingCard';
import { useUserOrganizationRole } from '@/components/organizations/OrganizationContext';
import { Button } from '@/components/ui/button';
import { SeatsUsageProgress } from './SeatsUsageProgress';
import {
  useOrganizationSeatUsage,
  useOrganizationTrialStatus,
  useOrganizationWithMembers,
} from '@/app/api/organizations/hooks';

type Props = {
  organizationId: string;
};

export function SeatUsageCard({ organizationId }: Props) {
  const currentUserRole = useUserOrganizationRole();

  const {
    data: org,
    isLoading: orgLoading,
    error: orgError,
    refetch: orgRefetch,
  } = useOrganizationWithMembers(organizationId);
  const { data: seatUsage, isLoading, error, refetch } = useOrganizationSeatUsage(organizationId);
  const status = useOrganizationTrialStatus(organizationId);

  if (isLoading || orgLoading || status === 'loading') {
    return (
      <LoadingCard
        title="Seat Usage"
        description="Loading seat usage information..."
        rowCount={1}
      />
    );
  }

  if (error || orgError || status === 'error') {
    return (
      <ErrorCard
        title="Seat Usage"
        description="Error loading seat usage information"
        error={error || orgError || 'Error loading trial status'}
        onRetry={() => {
          void refetch();
          void orgRefetch();
        }}
      />
    );
  }

  if (!org) {
    return null;
  }

  if (!seatUsage) {
    return null;
  }

  const { usedSeats, totalSeats } = seatUsage;
  const isTrial = status !== 'subscribed';

  // Hide seat usage card when trial messaging is suppressed (e.g., OSS program participants)
  if (org.settings.suppress_trial_messaging) {
    return null;
  }

  // Show seat usage card for subscribed orgs or orgs with require_seats
  if (status !== 'subscribed' && !org.require_seats) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            <CardTitle>Seat Usage</CardTitle>
          </div>
          {(currentUserRole === 'owner' || currentUserRole === 'billing_manager') && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/organizations/${organizationId}/subscriptions/seats`}>
                Manage Subscription
              </Link>
            </Button>
          )}
        </div>
        <CardDescription className="text-xs">
          {isTrial
            ? `You've used ${usedSeats} seat${usedSeats !== 1 ? 's' : ''} during your trial`
            : `${usedSeats} of ${totalSeats} seats used`}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <SeatsUsageProgress
          usedSeats={usedSeats}
          totalSeats={totalSeats}
          showTitle={false}
          isTrial={isTrial}
        />
      </CardContent>
    </Card>
  );
}
