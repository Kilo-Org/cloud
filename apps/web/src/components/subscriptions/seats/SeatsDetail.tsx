'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRight, ExternalLink, Minus, Plus, Users } from 'lucide-react';
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
import { capitalize } from '@/lib/utils';
import { SEAT_PRICING } from '@/lib/organizations/constants';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { DetailPageHeader } from '@/components/subscriptions/DetailPageHeader';
import { BillingHistoryTable } from '@/components/subscriptions/BillingHistoryTable';
import { formatDateLabel, isSeatsTerminal } from '@/components/subscriptions/helpers';
import { useCursorPagination } from '@/components/subscriptions/useCursorPagination';

export function SeatsDetail({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const [seatDialogOpen, setSeatDialogOpen] = useState(false);
  const [billingCycleDialogOpen, setBillingCycleDialogOpen] = useState(false);
  const [seatCount, setSeatCount] = useState('1');
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [isCancelingCycleChange, setIsCancelingCycleChange] = useState(false);

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

  const fetchMoreBilling = useCallback(
    (cursor: string) =>
      trpcClient.organizations.subscription.getBillingHistory.query({
        organizationId,
        cursor,
      }),
    [trpcClient, organizationId]
  );
  const billing = useCursorPagination({
    initialData: billingQuery.data,
    fetchMore: fetchMoreBilling,
    resetKey: organizationId,
  });

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

  function openCustomerPortal() {
    if (isOpeningPortal) return;
    setIsOpeningPortal(true);
    void (async () => {
      try {
        const result = await trpcClient.organizations.subscription.getCustomerPortalUrl.mutate({
          organizationId,
          returnUrl: window.location.href,
        });
        window.location.href = result.url;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to open Stripe portal');
        setIsOpeningPortal(false);
      }
    })();
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

  const paidSeatItemId = subscriptionQuery.data?.paidSeatItemId ?? null;
  const paidSeatItem = subscription.items.data.find(item => item.id === paidSeatItemId) ?? null;
  const currentInterval =
    paidSeatItem?.price?.recurring?.interval === 'year' ? 'annual' : 'monthly';
  const totalAmount = subscription.items.data.reduce(
    (sum, item) => sum + (item.price?.unit_amount ?? 0) * (item.quantity ?? 0),
    0
  );
  const hasPendingCycleChange = subscription.schedule != null;

  return (
    <div className="space-y-6">
      <DetailPageHeader
        backHref={`/organizations/${organizationId}/subscriptions`}
        backLabel="Back to subscriptions"
        title="Teams / Enterprise Seats"
        status={subscription.status}
      />

      <Card>
        <CardHeader className="pb-4">
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
            <DetailRow label="Plan" value={capitalize(organizationQuery.data?.plan ?? 'teams')} />
            <DetailRow label="Billing cycle" value={capitalize(currentInterval)} />
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
                {subscriptionQuery.data?.seatsUsed ?? 0} / {subscriptionQuery.data?.totalSeats ?? 0}
              </span>
            </div>
            <Progress
              value={seatUsagePercent}
              className="bg-amber-500/20"
              indicatorClassName="bg-linear-to-r from-amber-500 to-amber-300"
            />
          </div>

          {hasPendingCycleChange ? (
            <Card className="border-blue-500/30 bg-blue-500/5">
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">Scheduled billing cycle change</p>
                  <p className="text-muted-foreground text-sm">
                    Switching to {currentInterval === 'annual' ? 'monthly' : 'annual'} billing at
                    the next renewal
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (isCancelingCycleChange) return;
                    setIsCancelingCycleChange(true);
                    void (async () => {
                      try {
                        await trpcClient.organizations.subscription.cancelBillingCycleChange.mutate(
                          {
                            organizationId,
                          }
                        );
                        toast.success('Billing cycle change canceled');
                        await refreshData();
                      } catch (error) {
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : 'Failed to cancel billing cycle change'
                        );
                      } finally {
                        setIsCancelingCycleChange(false);
                      }
                    })();
                  }}
                  disabled={isCancelingCycleChange}
                >
                  {isCancelingCycleChange ? 'Canceling...' : 'Cancel Scheduled Change'}
                </Button>
              </CardContent>
            </Card>
          ) : null}
        </CardContent>
      </Card>

      {isSeatsTerminal(subscription.status) ? null : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setSeatDialogOpen(true)}>
            Change Seat Count
          </Button>
          <Button
            variant="outline"
            onClick={() => setBillingCycleDialogOpen(true)}
            disabled={hasPendingCycleChange}
          >
            Change Billing Cycle
          </Button>
          {subscription.cancel_at_period_end ? (
            <Button
              variant="outline"
              onClick={() =>
                void (async () => {
                  try {
                    await trpcClient.organizations.subscription.stopCancellation.mutate({
                      organizationId,
                    });
                    toast.success('Subscription resumed');
                    await refreshData();
                  } catch (error) {
                    toast.error(
                      error instanceof Error ? error.message : 'Failed to resume subscription'
                    );
                  }
                })()
              }
            >
              Resume Subscription
            </Button>
          ) : (
            <Button
              variant="outline"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                if (!window.confirm('Cancel this seats subscription at period end?')) return;
                void (async () => {
                  try {
                    await trpcClient.organizations.subscription.cancel.mutate({ organizationId });
                    toast.success('Subscription will cancel at period end');
                    await refreshData();
                  } catch (error) {
                    toast.error(
                      error instanceof Error ? error.message : 'Failed to cancel subscription'
                    );
                  }
                })();
              }}
            >
              Cancel Subscription
            </Button>
          )}
          <Button variant="outline" onClick={openCustomerPortal} disabled={isOpeningPortal}>
            <ExternalLink className="h-4 w-4" />
            {isOpeningPortal ? 'Opening...' : 'Manage Payment Method'}
          </Button>
        </div>
      )}

      <Card>
        <CardHeader className="pb-4">
          <CardTitle>Billing history</CardTitle>
        </CardHeader>
        <CardContent className="pt-1">
          <BillingHistoryTable
            variant="stripe"
            entries={billing.entries}
            hasMore={billing.hasMore}
            onLoadMore={() => void billing.loadMore()}
            isLoading={billing.isLoadingMore}
          />
        </CardContent>
      </Card>

      <Dialog open={seatDialogOpen} onOpenChange={setSeatDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Change seat count</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setSeatCount(String(Math.max(1, Number(seatCount) - 1)))}
              disabled={Number(seatCount) <= 1}
            >
              <Minus className="h-4 w-4" />
            </Button>
            <Input
              className="w-20 text-center"
              value={seatCount}
              onChange={event => setSeatCount(event.target.value)}
              inputMode="numeric"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => setSeatCount(String(Number(seatCount) + 1))}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <SeatCountChangeMessage
            currentSeats={subscriptionQuery.data?.totalSeats ?? 0}
            newSeats={Number(seatCount)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSeatDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                void (async () => {
                  try {
                    await trpcClient.organizations.subscription.updateSeatCount.mutate({
                      organizationId,
                      newSeatCount: Number(seatCount),
                    });
                    toast.success('Seat count updated');
                    setSeatDialogOpen(false);
                    await refreshData();
                  } catch (error) {
                    toast.error(
                      error instanceof Error ? error.message : 'Failed to update seat count'
                    );
                  }
                })()
              }
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={billingCycleDialogOpen} onOpenChange={setBillingCycleDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change billing cycle</DialogTitle>
          </DialogHeader>
          <BillingCycleChangeContent
            currentInterval={currentInterval}
            perSeatCents={paidSeatItem?.price?.unit_amount ?? 0}
            seatCount={subscriptionQuery.data?.totalSeats ?? 0}
            plan={(organizationQuery.data?.plan as 'teams' | 'enterprise') ?? 'teams'}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBillingCycleDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                void (async () => {
                  try {
                    await trpcClient.organizations.subscription.changeBillingCycle.mutate({
                      organizationId,
                      targetCycle: currentInterval === 'annual' ? 'monthly' : 'annual',
                    });
                    toast.success('Billing cycle change scheduled');
                    setBillingCycleDialogOpen(false);
                    await refreshData();
                  } catch (error) {
                    toast.error(
                      error instanceof Error ? error.message : 'Failed to change billing cycle'
                    );
                  }
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

function SeatCountChangeMessage({
  currentSeats,
  newSeats,
}: {
  currentSeats: number;
  newSeats: number;
}) {
  if (isNaN(newSeats) || newSeats === currentSeats) return null;

  if (newSeats > currentSeats) {
    return (
      <p className="text-muted-foreground text-sm">
        Adding {newSeats - currentSeats} seat{newSeats - currentSeats === 1 ? '' : 's'}. You will be
        billed a prorated amount immediately.
      </p>
    );
  }

  return (
    <p className="text-muted-foreground text-sm">
      Removing {currentSeats - newSeats} seat{currentSeats - newSeats === 1 ? '' : 's'}. This will
      take effect at the start of your next billing cycle.
    </p>
  );
}

function BillingCycleChangeContent({
  currentInterval,
  perSeatCents,
  seatCount,
  plan,
}: {
  currentInterval: 'monthly' | 'annual';
  perSeatCents: number;
  seatCount: number;
  plan: 'teams' | 'enterprise';
}) {
  const targetInterval = currentInterval === 'annual' ? 'monthly' : 'annual';
  const currentPerSeat = perSeatCents / 100;
  const targetPerSeat = SEAT_PRICING[plan][targetInterval === 'annual' ? 'annual' : 'monthly'];

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-center gap-3">
        <div className="bg-muted/20 border-border/60 flex-1 rounded-lg border px-3 py-2 text-center">
          <div className="text-muted-foreground text-xs">Current cycle</div>
          <div className="font-medium">{capitalize(currentInterval)}</div>
          <div className="text-muted-foreground text-xs">${currentPerSeat.toFixed(2)}/seat/mo</div>
        </div>
        <ArrowRight className="text-muted-foreground h-4 w-4 shrink-0" />
        <div className="bg-muted/20 border-border/60 flex-1 rounded-lg border px-3 py-2 text-center">
          <div className="text-muted-foreground text-xs">New cycle</div>
          <div className="font-medium">{capitalize(targetInterval)}</div>
          <div className="text-muted-foreground text-xs">${targetPerSeat.toFixed(2)}/seat/mo</div>
        </div>
      </div>
      <p className="text-muted-foreground">
        {targetInterval === 'annual'
          ? `Switching to annual billing takes effect at your next renewal. You will be billed $${(targetPerSeat * seatCount * 12).toFixed(2)}/year upfront for ${seatCount} seat${seatCount === 1 ? '' : 's'}.`
          : `Switching to monthly billing takes effect at your next renewal. You will be billed $${(targetPerSeat * seatCount).toFixed(2)}/month for ${seatCount} seat${seatCount === 1 ? '' : 's'}.`}
      </p>
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
