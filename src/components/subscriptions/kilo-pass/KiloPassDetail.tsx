'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Crown, Settings2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { formatDollars, formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';
import { DetailPageHeader } from '@/components/subscriptions/DetailPageHeader';
import { StripePortalLink } from '@/components/subscriptions/StripePortalLink';
import { BillingHistoryTable } from '@/components/subscriptions/BillingHistoryTable';
import { CreditHistory } from './CreditHistory';
import { KiloPassSubscriptionInfoProvider } from '@/components/profile/kilo-pass/useKiloPassSubscriptionInfo';
import { KiloPassSubscriptionSettingsModal } from '@/components/profile/kilo-pass/KiloPassSubscriptionSettingsModal';
import { KiloPassBonusRampDialog } from '@/components/profile/kilo-pass/KiloPassBonusRampDialog';

export function KiloPassDetail() {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [billingEntries, setBillingEntries] = useState<
    Array<
      Awaited<ReturnType<typeof trpcClient.kiloPass.getBillingHistory.query>>['entries'][number]
    >
  >([]);
  const [billingCursor, setBillingCursor] = useState<string | null>(null);
  const [billingHasMore, setBillingHasMore] = useState(false);
  const [billingLoadingMore, setBillingLoadingMore] = useState(false);
  const [creditEntries, setCreditEntries] = useState<
    Array<Awaited<ReturnType<typeof trpcClient.kiloPass.getCreditHistory.query>>['entries'][number]>
  >([]);
  const [creditCursor, setCreditCursor] = useState<string | null>(null);
  const [creditHasMore, setCreditHasMore] = useState(false);
  const [creditLoadingMore, setCreditLoadingMore] = useState(false);

  const stateQuery = useQuery(trpc.kiloPass.getState.queryOptions());
  const scheduledChangeQuery = useQuery(trpc.kiloPass.getScheduledChange.queryOptions());
  const billingQuery = useQuery(trpc.kiloPass.getBillingHistory.queryOptions({}));
  const creditHistoryQuery = useQuery(trpc.kiloPass.getCreditHistory.queryOptions({}));

  const subscriptionId = stateQuery.data?.subscription?.stripeSubscriptionId ?? null;

  useEffect(() => {
    if (!subscriptionId) {
      setBillingEntries([]);
      setBillingCursor(null);
      setBillingHasMore(false);
      setBillingLoadingMore(false);
      setCreditEntries([]);
      setCreditCursor(null);
      setCreditHasMore(false);
      setCreditLoadingMore(false);
      return;
    }

    setBillingEntries([]);
    setBillingCursor(null);
    setBillingHasMore(false);
    setBillingLoadingMore(false);
    setCreditEntries([]);
    setCreditCursor(null);
    setCreditHasMore(false);
    setCreditLoadingMore(false);
  }, [subscriptionId]);

  useEffect(() => {
    if (!billingQuery.data) return;
    setBillingEntries(billingQuery.data.entries);
    setBillingCursor(billingQuery.data.cursor);
    setBillingHasMore(billingQuery.data.hasMore);
  }, [billingQuery.data]);

  useEffect(() => {
    if (!creditHistoryQuery.data) return;
    setCreditEntries(creditHistoryQuery.data.entries);
    setCreditCursor(creditHistoryQuery.data.cursor);
    setCreditHasMore(creditHistoryQuery.data.hasMore);
  }, [creditHistoryQuery.data]);

  const subscription = stateQuery.data?.subscription ?? null;
  const scheduledChange = scheduledChangeQuery.data?.scheduledChange ?? null;

  const bonusProgress = useMemo(() => {
    if (!subscription) return 0;
    const total =
      (subscription.currentPeriodBaseCreditsUsd ?? 0) +
      (subscription.currentPeriodBonusCreditsUsd ?? 0);
    if (total <= 0) return 0;
    return Math.min(100, Math.round((subscription.currentPeriodUsageUsd / total) * 100));
  }, [subscription]);

  async function refreshData() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getState.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getScheduledChange.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getBillingHistory.queryKey({}) }),
      queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getCreditHistory.queryKey({}) }),
    ]);
  }

  async function handleResume() {
    await trpcClient.kiloPass.resumeSubscription.mutate();
    toast.success('Subscription resumed');
    await refreshData();
  }

  async function handleCancelScheduledChange() {
    await trpcClient.kiloPass.cancelScheduledChange.mutate();
    toast.success('Scheduled change canceled');
    await refreshData();
  }

  async function loadMoreBilling() {
    if (!billingCursor || billingLoadingMore) return;
    setBillingLoadingMore(true);
    try {
      const result = await trpcClient.kiloPass.getBillingHistory.query({ cursor: billingCursor });
      setBillingEntries(current => [...current, ...result.entries]);
      setBillingCursor(result.cursor);
      setBillingHasMore(result.hasMore);
    } finally {
      setBillingLoadingMore(false);
    }
  }

  async function loadMoreCreditHistory() {
    if (!creditCursor || creditLoadingMore) return;
    setCreditLoadingMore(true);
    try {
      const result = await trpcClient.kiloPass.getCreditHistory.query({ cursor: creditCursor });
      setCreditEntries(current => [...current, ...result.entries]);
      setCreditCursor(result.cursor);
      setCreditHasMore(result.hasMore);
    } finally {
      setCreditLoadingMore(false);
    }
  }

  if (stateQuery.isLoading) {
    return (
      <Card>
        <CardContent className="p-6">Loading subscription...</CardContent>
      </Card>
    );
  }

  if (!subscription) {
    return (
      <Card>
        <CardContent className="p-6">Kilo Pass subscription not found.</CardContent>
      </Card>
    );
  }

  return (
    <KiloPassSubscriptionInfoProvider subscription={subscription}>
      <div className="space-y-6">
        <DetailPageHeader
          backHref="/subscriptions"
          backLabel="Back to subscriptions"
          title="Kilo Pass"
          status={subscription.status}
          actions={
            <StripePortalLink
              onOpenPortal={async () => {
                const result = await trpcClient.kiloPass.getCustomerPortalUrl.mutate({
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
              <CardTitle>Subscription details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailRow label="Tier" value={subscription.tier} />
                <DetailRow label="Cadence" value={subscription.cadence} />
                <DetailRow
                  label="Price"
                  value={formatDollars(subscription.currentPeriodBaseCreditsUsd)}
                />
                <DetailRow
                  label="Next billing"
                  value={formatIsoDateString_UsaDateOnlyFormat(subscription.nextBillingAt)}
                />
                <DetailRow
                  label="Started"
                  value={formatIsoDateString_UsaDateOnlyFormat(subscription.startedAt)}
                />
                <DetailRow
                  label="Current streak"
                  value={`${subscription.currentStreakMonths} months`}
                />
              </div>

              {scheduledChange ? (
                <Card className="border-blue-500/30 bg-blue-500/5">
                  <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-medium">Scheduled change</p>
                      <p className="text-muted-foreground text-sm">
                        {scheduledChange.toTier} {scheduledChange.toCadence} on{' '}
                        {formatIsoDateString_UsaDateOnlyFormat(scheduledChange.effectiveAt)}
                      </p>
                    </div>
                    <Button variant="outline" onClick={() => void handleCancelScheduledChange()}>
                      Cancel Scheduled Change
                    </Button>
                  </CardContent>
                </Card>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setSettingsOpen(true)}>
                  <Settings2 className="h-4 w-4" />
                  Manage subscription
                </Button>
                {subscription.cancelAtPeriodEnd ? (
                  <Button variant="outline" onClick={() => void handleResume()}>
                    Resume Subscription
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Crown className="h-5 w-5" />
                Bonus streak
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Current period usage</span>
                  <span>{formatDollars(subscription.currentPeriodUsageUsd)}</span>
                </div>
                <Progress value={bonusProgress} />
              </div>
              <div className="space-y-2 text-sm">
                <p>
                  Base credits:{' '}
                  <span className="font-medium">
                    {formatDollars(subscription.currentPeriodBaseCreditsUsd)}
                  </span>
                </p>
                <p>
                  Bonus credits:{' '}
                  <span className="font-medium">
                    {subscription.currentPeriodBonusCreditsUsd != null
                      ? formatDollars(subscription.currentPeriodBonusCreditsUsd)
                      : '—'}
                  </span>
                </p>
              </div>
              <div className="flex items-center justify-between rounded-xl border p-3 text-sm">
                <span>Bonus ramp preview</span>
                <KiloPassBonusRampDialog
                  tier={subscription.tier}
                  streakMonths={subscription.currentStreakMonths}
                  subscriptionStartedAtIso={subscription.startedAt ?? undefined}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Credit history</CardTitle>
          </CardHeader>
          <CardContent>
            <CreditHistory
              entries={creditEntries}
              hasMore={creditHasMore}
              onLoadMore={() => void loadMoreCreditHistory()}
              isLoading={creditLoadingMore}
            />
          </CardContent>
        </Card>

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

        <KiloPassSubscriptionSettingsModal
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      </div>
    </KiloPassSubscriptionInfoProvider>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-sm">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
