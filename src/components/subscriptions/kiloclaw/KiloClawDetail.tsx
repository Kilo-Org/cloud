'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import KiloCrabIcon from '@/components/KiloCrabIcon';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { DetailPageHeader } from '@/components/subscriptions/DetailPageHeader';
import { StripePortalLink } from '@/components/subscriptions/StripePortalLink';
import { BillingHistoryTable } from '@/components/subscriptions/BillingHistoryTable';
import {
  formatDateLabel,
  formatKiloclawPrice,
  formatPaymentSummary,
} from '@/components/subscriptions/helpers';

export function KiloClawDetail({ instanceId }: { instanceId: string }) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const [billingEntries, setBillingEntries] = useState<
    Array<
      Awaited<ReturnType<typeof trpcClient.kiloclaw.getBillingHistory.query>>['entries'][number]
    >
  >([]);
  const [billingCursor, setBillingCursor] = useState<string | null>(null);
  const [billingHasMore, setBillingHasMore] = useState(false);
  const [billingLoadingMore, setBillingLoadingMore] = useState(false);

  const detailQuery = useQuery(trpc.kiloclaw.getSubscriptionDetail.queryOptions({ instanceId }));
  const billingQuery = useQuery(trpc.kiloclaw.getBillingHistory.queryOptions({ instanceId }));

  useEffect(() => {
    if (!instanceId) {
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
  }, [instanceId]);

  useEffect(() => {
    if (!billingQuery.data) return;
    setBillingEntries(billingQuery.data.entries);
    setBillingCursor(billingQuery.data.cursor);
    setBillingHasMore(billingQuery.data.hasMore);
  }, [billingQuery.data]);

  async function refreshData() {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.listPersonalSubscriptions.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.getSubscriptionDetail.queryKey({ instanceId }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.getBillingHistory.queryKey({ instanceId }),
      }),
    ]);
  }

  async function loadMoreBilling() {
    if (!billingCursor || billingLoadingMore) return;
    setBillingLoadingMore(true);
    try {
      const result = await trpcClient.kiloclaw.getBillingHistory.query({
        instanceId,
        cursor: billingCursor,
      });
      setBillingEntries(current => [...current, ...result.entries]);
      setBillingCursor(result.cursor);
      setBillingHasMore(result.hasMore);
    } finally {
      setBillingLoadingMore(false);
    }
  }

  async function runAction(action: () => Promise<unknown>, successMessage: string) {
    await action();
    toast.success(successMessage);
    await refreshData();
  }

  const subscription = detailQuery.data;

  if (detailQuery.isLoading) {
    return (
      <Card>
        <CardContent className="p-6">Loading subscription...</CardContent>
      </Card>
    );
  }

  if (!subscription) {
    return (
      <Card>
        <CardContent className="p-6">KiloClaw subscription not found.</CardContent>
      </Card>
    );
  }

  const otherPlan = subscription.plan === 'commit' ? 'standard' : 'commit';

  return (
    <div className="space-y-6">
      <DetailPageHeader
        backHref="/subscriptions"
        backLabel="Back to subscriptions"
        title={subscription.instanceName ?? 'KiloClaw'}
        status={subscription.status}
        actions={
          subscription.hasStripeFunding ? (
            <StripePortalLink
              onOpenPortal={async () => {
                const result = await trpcClient.kiloclaw.getCustomerPortalUrl.mutate({
                  instanceId,
                  returnUrl: window.location.href,
                });
                return result.url;
              }}
            />
          ) : null
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KiloCrabIcon className="h-5 w-5" />
            Instance details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailRow label="Instance ID" value={subscription.instanceId} />
            <DetailRow label="Sandbox ID" value={subscription.sandboxId} />
            <DetailRow label="Plan" value={subscription.plan} />
            <DetailRow label="Price" value={formatKiloclawPrice(subscription.plan)} />
            <DetailRow
              label="Payment source"
              value={formatPaymentSummary({
                paymentSource: subscription.paymentSource,
                hasStripeFunding: subscription.hasStripeFunding,
              })}
            />
            <DetailRow
              label="Next renewal"
              value={formatDateLabel(
                subscription.creditRenewalAt ??
                  subscription.currentPeriodEnd ??
                  subscription.trialEndsAt,
                '—'
              )}
            />
            <DetailRow
              label="Commit ends"
              value={formatDateLabel(subscription.commitEndsAt, '—')}
            />
            <DetailRow label="Trial ends" value={formatDateLabel(subscription.trialEndsAt, '—')} />
            <DetailRow
              label="Suspended at"
              value={formatDateLabel(subscription.suspendedAt, '—')}
            />
            <DetailRow
              label="Destruction deadline"
              value={formatDateLabel(subscription.destructionDeadline, '—')}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {subscription.plan !== 'trial' ? (
              subscription.scheduledPlan ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    void runAction(
                      () => trpcClient.kiloclaw.cancelPlanSwitchAtInstance.mutate({ instanceId }),
                      'Plan switch canceled'
                    )
                  }
                >
                  Cancel Plan Switch
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() =>
                    void runAction(
                      () =>
                        trpcClient.kiloclaw.switchPlanAtInstance.mutate({
                          instanceId,
                          toPlan: otherPlan,
                        }),
                      'Plan switch scheduled'
                    )
                  }
                >
                  Switch to {otherPlan}
                </Button>
              )
            ) : null}

            {subscription.showConversionPrompt ? (
              <Button
                variant="outline"
                onClick={() =>
                  void runAction(
                    () => trpcClient.kiloclaw.acceptConversionAtInstance.mutate({ instanceId }),
                    'Stripe billing will switch to credits at period end'
                  )
                }
              >
                Switch to Credits
              </Button>
            ) : null}

            {subscription.cancelAtPeriodEnd ? (
              <Button
                variant="outline"
                onClick={() =>
                  void runAction(
                    () =>
                      trpcClient.kiloclaw.reactivateSubscriptionAtInstance.mutate({ instanceId }),
                    'Subscription reactivated'
                  )
                }
              >
                Reactivate
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => {
                  if (!window.confirm('Cancel this KiloClaw subscription at period end?')) return;
                  void runAction(
                    () => trpcClient.kiloclaw.cancelSubscriptionAtInstance.mutate({ instanceId }),
                    'Subscription will cancel at period end'
                  );
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
          <CardTitle>Billing history</CardTitle>
        </CardHeader>
        <CardContent>
          <BillingHistoryTable
            variant={subscription.hasStripeFunding ? 'stripe' : 'credits'}
            entries={billingEntries}
            hasMore={billingHasMore}
            onLoadMore={() => void loadMoreBilling()}
            isLoading={billingLoadingMore}
          />
        </CardContent>
      </Card>
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
