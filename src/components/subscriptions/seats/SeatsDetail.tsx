'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { DetailPageHeader } from '@/components/subscriptions/DetailPageHeader';
import { StripePortalLink } from '@/components/subscriptions/StripePortalLink';
import { BillingHistoryTable } from '@/components/subscriptions/BillingHistoryTable';
import { formatDateLabel, getPaidSeatSubscriptionItem } from '@/components/subscriptions/helpers';

export function SeatsDetail({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const [billingEntries, setBillingEntries] = useState<
    Array<
      Awaited<
        ReturnType<typeof trpcClient.organizations.subscription.getBillingHistory.query>
      >['entries'][number]
    >
  >([]);
  const [billingCursor, setBillingCursor] = useState<string | null>(null);
  const [billingHasMore, setBillingHasMore] = useState(false);
  const [billingLoadingMore, setBillingLoadingMore] = useState(false);
  const [seatDialogOpen, setSeatDialogOpen] = useState(false);
  const [billingCycleDialogOpen, setBillingCycleDialogOpen] = useState(false);
  const [seatCount, setSeatCount] = useState('1');

  const organizationQuery = useOrganizationWithMembers(organizationId, {
    enabled: !!organizationId,
  });
  const subscriptionQuery = useQuery(
    trpc.organizations.subscription.get.queryOptions(
      { organizationId },
      { enabled: !!organizationId }
    )
  );
  const billingQuery = useQuery(
    trpc.organizations.subscription.getBillingHistory.queryOptions(
      { organizationId },
      { enabled: !!organizationId }
    )
  );

  useEffect(() => {
    if (!organizationId) {
      setBillingEntries([]);
      setBillingCursor(null);
      setBillingHasMore(false);
      setBillingLoadingMore(false);
      return;
    }

    setBillingEntries([]);
    setBillingCursor(null);
    setBillingHasMore(false);
    setBillingLoadingMore(false);
  }, [organizationId]);

  useEffect(() => {
    if (!billingQuery.data) return;
    setBillingEntries(billingQuery.data.entries);
    setBillingCursor(billingQuery.data.cursor);
    setBillingHasMore(billingQuery.data.hasMore);
  }, [billingQuery.data]);

  useEffect(() => {
    if (!subscriptionQuery.data) return;
    setSeatCount(String(subscriptionQuery.data.totalSeats || 1));
  }, [subscriptionQuery.data]);

  async function refreshData() {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.organizations.subscription.get.queryKey({ organizationId }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.organizations.subscription.getBillingHistory.queryKey({ organizationId }),
      }),
    ]);
  }

  async function loadMoreBilling() {
    if (!billingCursor || billingLoadingMore) return;
    setBillingLoadingMore(true);
    try {
      const result = await trpcClient.organizations.subscription.getBillingHistory.query({
        organizationId,
        cursor: billingCursor,
      });
      setBillingEntries(current => [...current, ...result.entries]);
      setBillingCursor(result.cursor);
      setBillingHasMore(result.hasMore);
    } finally {
      setBillingLoadingMore(false);
    }
  }

  const subscription = subscriptionQuery.data?.subscription ?? null;
  const seatUsagePercent = useMemo(() => {
    const used = subscriptionQuery.data?.seatsUsed ?? 0;
    const total = subscriptionQuery.data?.totalSeats ?? 0;
    if (total <= 0) return 0;
    return Math.min(100, Math.round((used / total) * 100));
  }, [subscriptionQuery.data]);

  if (subscriptionQuery.isLoading) {
    return (
      <Card>
        <CardContent className="p-6">Loading subscription...</CardContent>
      </Card>
    );
  }

  if (!subscription) {
    return (
      <Card>
        <CardContent className="p-6">
          No seats subscription found for this organization.
        </CardContent>
      </Card>
    );
  }

  const paidSeatItem = getPaidSeatSubscriptionItem(subscription);
  const currentInterval =
    paidSeatItem?.price?.recurring?.interval === 'year' ? 'annual' : 'monthly';
  const totalAmount = subscription.items.data.reduce(
    (sum, item) => sum + (item.price?.unit_amount ?? 0) * (item.quantity ?? 0),
    0
  );

  return (
    <div className="space-y-6">
      <DetailPageHeader
        backHref={`/organizations/${organizationId}/subscriptions`}
        backLabel="Back to subscriptions"
        title="Teams / Enterprise Seats"
        status={subscription.status}
        actions={
          <StripePortalLink
            onOpenPortal={async () => {
              const result =
                await trpcClient.organizations.subscription.getCustomerPortalUrl.mutate({
                  organizationId,
                  returnUrl: window.location.href,
                });
              return result.url;
            }}
          />
        }
      />

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Subscription details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <DetailRow
                label="Organization"
                value={organizationQuery.data?.name ?? 'Organization'}
              />
              <DetailRow label="Plan" value={organizationQuery.data?.plan ?? 'teams'} />
              <DetailRow label="Billing cycle" value={currentInterval} />
              <DetailRow
                label="Price"
                value={`$${(totalAmount / 100).toFixed(2)}/${currentInterval === 'annual' ? 'year' : 'month'}`}
              />
              <DetailRow
                label="Next billing"
                value={formatDateLabel(
                  paidSeatItem?.current_period_end
                    ? new Date(paidSeatItem.current_period_end * 1000).toISOString()
                    : null,
                  '—'
                )}
              />
              <DetailRow label="Seats" value={String(subscriptionQuery.data?.totalSeats ?? 0)} />
            </div>

            <div className="space-y-3 rounded-xl border p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Seat utilization</span>
                <span>
                  {subscriptionQuery.data?.seatsUsed ?? 0} /{' '}
                  {subscriptionQuery.data?.totalSeats ?? 0}
                </span>
              </div>
              <Progress value={seatUsagePercent} />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setSeatDialogOpen(true)}>
                Change Seat Count
              </Button>
              <Button variant="outline" onClick={() => setBillingCycleDialogOpen(true)}>
                Change Billing Cycle
              </Button>
              {subscription.cancel_at_period_end ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    void (async () => {
                      await trpcClient.organizations.subscription.stopCancellation.mutate({
                        organizationId,
                      });
                      toast.success('Subscription resumed');
                      await refreshData();
                    })()
                  }
                >
                  Resume Subscription
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (!window.confirm('Cancel this seats subscription at period end?')) return;
                    void (async () => {
                      await trpcClient.organizations.subscription.cancel.mutate({ organizationId });
                      toast.success('Subscription will cancel at period end');
                      await refreshData();
                    })();
                  }}
                >
                  Cancel Subscription
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Reviewer notes</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            Billing admins and owners can update seats, switch cadence, or manage cancellation from
            this page.
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Billing history</CardTitle>
        </CardHeader>
        <CardContent>
          <BillingHistoryTable
            variant="stripe"
            entries={billingEntries}
            hasMore={billingHasMore}
            onLoadMore={() => void loadMoreBilling()}
            isLoading={billingLoadingMore}
          />
        </CardContent>
      </Card>

      <Dialog open={seatDialogOpen} onOpenChange={setSeatDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change seat count</DialogTitle>
          </DialogHeader>
          <Input
            value={seatCount}
            onChange={event => setSeatCount(event.target.value)}
            inputMode="numeric"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSeatDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                void (async () => {
                  await trpcClient.organizations.subscription.updateSeatCount.mutate({
                    organizationId,
                    newSeatCount: Number(seatCount),
                  });
                  toast.success('Seat count updated');
                  setSeatDialogOpen(false);
                  await refreshData();
                })()
              }
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={billingCycleDialogOpen} onOpenChange={setBillingCycleDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change billing cycle</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBillingCycleDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                void (async () => {
                  await trpcClient.organizations.subscription.changeBillingCycle.mutate({
                    organizationId,
                    targetCycle: currentInterval === 'annual' ? 'monthly' : 'annual',
                  });
                  toast.success('Billing cycle change scheduled');
                  setBillingCycleDialogOpen(false);
                  await refreshData();
                })()
              }
            >
              Switch to {currentInterval === 'annual' ? 'monthly' : 'annual'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-sm">{label}</div>
      <div className="font-medium break-all">{value}</div>
    </div>
  );
}
