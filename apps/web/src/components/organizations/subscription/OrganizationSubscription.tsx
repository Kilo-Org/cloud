'use client';
import {
  useOrganizationSubscription,
  useOrganizationWithMembers,
} from '@/app/api/organizations/hooks';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { ErrorCard } from '@/components/ErrorCard';
import { LoadingCard } from '@/components/LoadingCard';
import { OrganizationPageHeader } from '../OrganizationPageHeader';
import { OrganizationContextProvider } from '../OrganizationContext';
import { Card, CardDescription, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Mail } from 'lucide-react';
import { SubscriptionOverviewCard } from './SubscriptionOverviewCard';
import { SubscriptionQuickActions } from '@/components/organizations/subscription/SubscriptionQuickActions';
import { SeatPurchasesTable } from './SeatPurchasesTable';
import { LockableContainer } from '../LockableContainer';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import { CreateSubscriptionButton } from '@/components/organizations/subscription/CreateSubscriptionButton';

export function OrganizationSubscription({
  organizationId,
  role,
}: {
  organizationId: string;
  role?: OrganizationRole;
}) {
  const { assumedRole } = useRoleTesting();

  const {
    data: subscriptionData,
    isLoading,
    error,
    refetch,
  } = useOrganizationSubscription(organizationId);
  const { data: orgData } = useOrganizationWithMembers(organizationId);

  // Use assumed role if available, otherwise use actual role
  const currentRole = assumedRole === 'KILO ADMIN' ? 'owner' : assumedRole || role || 'member';
  const isKiloAdmin = assumedRole === 'KILO ADMIN';
  const planLabel = orgData?.plan === 'enterprise' ? 'Kilo Enterprise Plan' : 'Kilo Teams Plan';

  return (
    <OrganizationContextProvider value={{ userRole: currentRole, isKiloAdmin }}>
      <div className="flex w-full flex-col gap-y-4">
        <OrganizationPageHeader
          organizationId={organizationId}
          title={planLabel}
          showBackButton={false}
        />

        <div className="flex items-center gap-2">
          <p className="text-muted-foreground text-lg">
            Manage subscription and billing for your organization
          </p>
        </div>

        {isLoading ? (
          <LoadingCard
            title="Subscription Information"
            description="Loading subscription details..."
          />
        ) : error ? (
          <ErrorCard
            title="Subscription Information"
            description="Error loading subscription details"
            error={error}
            onRetry={() => refetch()}
          />
        ) : !subscriptionData?.subscription ? (
          <Card>
            <CardHeader>
              <CardTitle>No Active Subscription</CardTitle>
              <CardDescription>
                This organization does not have an active subscription.
              </CardDescription>
            </CardHeader>
            <CardContent className="gap-4">
              <CreateSubscriptionButton organizationId={organizationId} />
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
              <div className="space-y-8 lg:col-span-2">
                {subscriptionData?.subscription && (
                  <LockableContainer>
                    <SubscriptionOverviewCard
                      subscription={subscriptionData.subscription}
                      organizationId={organizationId}
                      userRole={currentRole}
                      seatsUsed={subscriptionData.seatsUsed}
                      totalSeats={subscriptionData.totalSeats}
                    />
                  </LockableContainer>
                )}

                {/* Admin-only seat purchases table */}
                {isKiloAdmin && (
                  <div className="mt-8">
                    <SeatPurchasesTable organizationId={organizationId} />
                  </div>
                )}
              </div>
              <div className="space-y-8 lg:col-span-1">
                {subscriptionData?.subscription && (
                  <LockableContainer>
                    <SubscriptionQuickActions
                      subscription={subscriptionData.subscription}
                      organizationId={organizationId}
                      userRole={currentRole}
                    />
                  </LockableContainer>
                )}

                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Need Help?</CardTitle>
                    <CardDescription>
                      Have questions about your subscription or billing?
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col items-center">
                    <Button
                      variant="outline"
                      className="w-64 justify-center"
                      onClick={() => (window.location.href = 'mailto:teams@kilocode.ai')}
                    >
                      <Mail className="mr-2 h-4 w-4" />
                      Contact Support
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </div>
          </>
        )}
      </div>
    </OrganizationContextProvider>
  );
}
