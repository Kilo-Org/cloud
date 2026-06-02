'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { BillingHistoryTable } from '@/components/subscriptions/BillingHistoryTable';
import { DetailPageHeader } from '@/components/subscriptions/DetailPageHeader';
import { DetailRow } from '@/components/subscriptions/DetailRow';
import {
  formatCodingPlanBillingAmount,
  formatCodingPlanPrice,
  formatDateLabel,
  formatLocalDateTimeLabel,
  getCodingPlanBillingDate,
  getCodingPlanDisplayStatus,
} from '@/components/subscriptions/helpers';
import { useCursorPagination } from '@/components/subscriptions/useCursorPagination';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { MiniMaxPlanIcon } from './MiniMaxPlanIcon';

export function CodingPlanDetail({ subscriptionId }: { subscriptionId: string }) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  const detailQuery = useQuery(
    trpc.codingPlans.getSubscriptionDetail.queryOptions({ subscriptionId })
  );
  const billingQuery = useQuery({
    ...trpc.codingPlans.getBillingHistory.queryOptions({ subscriptionId }),
    enabled: detailQuery.isSuccess,
  });
  const fetchMoreBilling = (cursor: string) =>
    trpcClient.codingPlans.getBillingHistory.query({ subscriptionId, cursor });
  const billing = useCursorPagination({
    initialData: billingQuery.data,
    fetchMore: fetchMoreBilling,
    resetKey: subscriptionId,
  });
  const cancelMutation = useMutation(
    trpc.codingPlans.cancel.mutationOptions({
      onSuccess: async () => {
        toast.success('Coding Plan subscription will cancel at period end');
        setCancelDialogOpen(false);
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.codingPlans.getSubscriptionDetail.queryKey({ subscriptionId }),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.codingPlans.listSubscriptions.queryKey(),
          }),
        ]);
      },
      onError: error => {
        toast.error(error.message || 'Unable to cancel Coding Plan subscription');
      },
    })
  );

  if (detailQuery.isLoading) {
    return (
      <Card>
        <CardContent className="p-6">Loading subscription&hellip;</CardContent>
      </Card>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <Card>
        <CardContent className="space-y-4 p-6">
          <p>{detailQuery.error?.message ?? 'Coding Plan subscription not found.'}</p>
          <Button variant="outline" onClick={() => void detailQuery.refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const subscription = detailQuery.data;
  const isActive = subscription.status === 'active';
  const isPastDue = subscription.status === 'past_due';
  const isCanceled = subscription.status === 'canceled';
  const displayStatus = getCodingPlanDisplayStatus(subscription);
  const billingDate = getCodingPlanBillingDate(subscription);
  const formattedBillingDate = isPastDue
    ? formatLocalDateTimeLabel(billingDate.date)
    : formatDateLabel(billingDate.date);
  const periodEnd = formatDateLabel(subscription.currentPeriodEnd);
  const hasInstalledPlanKey = subscription.hasInstalledByokKey;
  const subscriptionTitle = `${subscription.providerName} ${subscription.planName}`;

  return (
    <div className="space-y-6">
      <DetailPageHeader
        backHref="/subscriptions#coding-plans"
        backLabel="Back to subscriptions"
        title={subscriptionTitle}
        icon={<MiniMaxPlanIcon />}
        status={displayStatus}
      />

      <Card>
        <CardContent className="space-y-6 p-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <DetailRow label="Provider" value={subscription.providerName} />
            <DetailRow label="Plan" value={subscription.planName} />
            <DetailRow
              label="Price"
              value={formatCodingPlanPrice(
                subscription.costKiloCredits,
                subscription.billingPeriodDays,
                subscription.planId
              )}
              numeric
            />
            <DetailRow label="Payment source" value="Credits" />
            <DetailRow label={billingDate.label} value={formattedBillingDate} numeric />
          </div>

          {subscription.cancelAtPeriodEnd ? (
            <Alert variant="warning">
              <CalendarClock />
              <AlertDescription>
                Token Plan Plus remains active through {periodEnd}. Kilo deletes the installed
                MiniMax key if unchanged and revokes the issued credential when billing ends.
              </AlertDescription>
            </Alert>
          ) : isPastDue ? (
            <Alert variant="warning">
              <CalendarClock />
              <AlertDescription>
                Renewal requires Kilo Credits. If payment recovery fails by {formattedBillingDate},
                Token Plan Plus ends and Kilo revokes its issued MiniMax credential. A MiniMax key
                you replaced or created yourself is not deleted.
              </AlertDescription>
            </Alert>
          ) : isCanceled ? (
            <Alert>
              <CalendarClock />
              <AlertDescription>
                Token Plan Plus ended on {formattedBillingDate}. Kilo has initiated revocation of
                the MiniMax credential issued for this subscription.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-5" />
            API Key Configuration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailRow
              label="Setup"
              value={
                hasInstalledPlanKey ? (
                  <>
                    Configured in{' '}
                    <Link href="/byok" className="underline underline-offset-4">
                      BYOK
                    </Link>
                  </>
                ) : (
                  'No Token Plan Plus-managed BYOK key installed'
                )
              }
            />
            <DetailRow
              label="Routing"
              value={
                hasInstalledPlanKey ? subscription.routeLabel : 'No managed routing configured'
              }
            />
          </div>
        </CardContent>
      </Card>

      {isActive && !subscription.cancelAtPeriodEnd ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive h-11 md:h-9"
            onClick={() => setCancelDialogOpen(true)}
            disabled={cancelMutation.isPending}
          >
            Cancel subscription
          </Button>
        </div>
      ) : null}

      <Card>
        <CardHeader className="pb-4">
          <CardTitle>Billing history</CardTitle>
        </CardHeader>
        <CardContent className="pt-1">
          {billingQuery.isLoading ? (
            <p className="text-muted-foreground text-sm">Loading billing history&hellip;</p>
          ) : billingQuery.isError ? (
            <Alert variant="warning">
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>Unable to load billing history.</span>
                <Button variant="outline" onClick={() => void billingQuery.refetch()}>
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <BillingHistoryTable
              variant="credits"
              entries={billing.entries}
              hasMore={billing.hasMore}
              onLoadMore={() => void billing.loadMore()}
              isLoading={billing.isLoadingMore}
              formatCredits={formatCodingPlanBillingAmount}
            />
          )}
        </CardContent>
      </Card>

      <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {subscription.planName} at period end?</AlertDialogTitle>
            <AlertDialogDescription>
              Your {subscription.providerName} Token Plan Plus subscription remains active through{' '}
              {periodEnd}. At that point, billing stops, Kilo deletes the installed MiniMax key if
              you have not replaced it, and revokes the credential issued for this subscription.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>
              Keep subscription
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => cancelMutation.mutate({ subscriptionId })}
              disabled={cancelMutation.isPending}
              aria-busy={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? 'Canceling...' : 'Cancel at period end'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
