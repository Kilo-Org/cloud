'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import KiloCrabIcon from '@/components/KiloCrabIcon';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { DetailPageHeader } from '@/components/subscriptions/DetailPageHeader';
import { StripePortalLink } from '@/components/subscriptions/StripePortalLink';
import { BillingHistoryTable } from '@/components/subscriptions/BillingHistoryTable';
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
import {
  formatDateLabel,
  formatKiloclawPrice,
  formatPaymentSummary,
  isKiloclawTerminal,
} from '@/components/subscriptions/helpers';
import { useCursorPagination } from '@/components/subscriptions/useCursorPagination';
import { capitalize } from '@/lib/utils';

type SubscriptionConfirmationAction =
  | 'cancelPlanSwitch'
  | 'switchPlan'
  | 'switchToCredits'
  | 'reactivate'
  | 'cancelSubscription';

type ConfirmationDetails = {
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  action: () => Promise<unknown>;
  successMessage: string;
  confirmVariant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  extraContent?: ReactNode;
};

export function KiloClawDetail({ instanceId }: { instanceId: string }) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const [confirmationAction, setConfirmationAction] =
    useState<SubscriptionConfirmationAction | null>(null);
  const [pendingConfirmationAction, setPendingConfirmationAction] =
    useState<SubscriptionConfirmationAction | null>(null);

  const detailQuery = useQuery(trpc.kiloclaw.getSubscriptionDetail.queryOptions({ instanceId }));
  const billingQuery = useQuery(trpc.kiloclaw.getBillingHistory.queryOptions({ instanceId }));

  const fetchMoreBilling = useCallback(
    (cursor: string) => trpcClient.kiloclaw.getBillingHistory.query({ instanceId, cursor }),
    [trpcClient, instanceId]
  );
  const billing = useCursorPagination({
    initialData: billingQuery.data,
    fetchMore: fetchMoreBilling,
    resetKey: instanceId,
  });

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
  const nextRenewalLabel = formatDateLabel(
    subscription.creditRenewalAt ?? subscription.currentPeriodEnd ?? subscription.trialEndsAt,
    'At your next renewal'
  );
  const hasUserRequestedSwitch = subscription.scheduledBy === 'user';
  const targetPlanLabel = capitalize(otherPlan);
  const targetPlanDetails =
    otherPlan === 'commit'
      ? {
          price: formatKiloclawPrice(otherPlan),
          cadence: 'Renews every 6 months',
          summary:
            'Lower effective rate at $8.00/month, billed $48.00 upfront for each 6-month term.',
        }
      : {
          price: formatKiloclawPrice(otherPlan),
          cadence: 'Renews monthly',
          summary: 'Flexible month-to-month billing with no long-term commitment.',
        };

  const confirmationDetails: ConfirmationDetails | null =
    confirmationAction === 'cancelPlanSwitch'
      ? {
          title: 'Cancel scheduled plan switch?',
          description:
            'This keeps your KiloClaw subscription on its current plan and removes the pending change.',
          confirmLabel: 'Cancel plan switch',
          pendingLabel: 'Canceling plan switch',
          action: () => trpcClient.kiloclaw.cancelPlanSwitchAtInstance.mutate({ instanceId }),
          successMessage: 'Plan switch canceled',
        }
      : confirmationAction === 'switchPlan'
        ? {
            title: `Switch to ${targetPlanLabel}?`,
            description: `This schedules your KiloClaw subscription to switch plans at the next renewal while keeping your current plan active until then.`,
            confirmLabel: `Switch to ${otherPlan}`,
            pendingLabel: `Switching to ${otherPlan}`,
            action: () =>
              trpcClient.kiloclaw.switchPlanAtInstance.mutate({
                instanceId,
                toPlan: otherPlan,
              }),
            successMessage: 'Plan switch scheduled',
            extraContent: (
              <div className="space-y-3 rounded-lg border px-4 py-3 text-left text-sm">
                <div className="flex items-center justify-center gap-4">
                  <div className="flex-1 rounded-md bg-muted/40 px-3 py-2 text-center">
                    <div className="text-muted-foreground text-xs">Current plan</div>
                    <div className="font-medium">{capitalize(subscription.plan)}</div>
                    <div className="text-muted-foreground text-xs">
                      {formatKiloclawPrice(subscription.plan)}
                    </div>
                  </div>
                  <ArrowRight className="text-muted-foreground h-4 w-4 shrink-0" />
                  <div className="flex-1 rounded-md bg-muted/40 px-3 py-2 text-center">
                    <div className="text-muted-foreground text-xs">New plan</div>
                    <div className="font-medium">{targetPlanLabel}</div>
                    <div className="text-muted-foreground text-xs">{targetPlanDetails.price}</div>
                  </div>
                </div>
                <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  <ConfirmationDetailRow label="Takes effect" value={nextRenewalLabel} />
                  <ConfirmationDetailRow label="Cadence" value={targetPlanDetails.cadence} />
                </div>
                <p className="text-muted-foreground leading-relaxed">{targetPlanDetails.summary}</p>
              </div>
            ),
          }
        : confirmationAction === 'switchToCredits'
          ? {
              title: 'Switch hosting billing to credits?',
              description:
                'Stripe billing stays active through the current period, then this subscription renews against your credit balance.',
              confirmLabel: 'Switch to Credits',
              pendingLabel: 'Switching to credits',
              action: () => trpcClient.kiloclaw.acceptConversionAtInstance.mutate({ instanceId }),
              successMessage: 'Stripe billing will switch to credits at period end',
            }
          : confirmationAction === 'reactivate'
            ? {
                title: 'Reactivate subscription?',
                description:
                  'This removes the pending cancellation so the subscription keeps renewing automatically.',
                confirmLabel: 'Reactivate',
                pendingLabel: 'Reactivating subscription',
                action: () =>
                  trpcClient.kiloclaw.reactivateSubscriptionAtInstance.mutate({ instanceId }),
                successMessage: 'Subscription reactivated',
              }
            : confirmationAction === 'cancelSubscription'
              ? {
                  title: 'Cancel subscription at period end?',
                  description:
                    'Your KiloClaw instance stays active through the current billing period, then the subscription ends.',
                  confirmLabel: 'Cancel Subscription',
                  pendingLabel: 'Canceling subscription',
                  action: () =>
                    trpcClient.kiloclaw.cancelSubscriptionAtInstance.mutate({ instanceId }),
                  successMessage: 'Subscription will cancel at period end',
                  confirmVariant: 'destructive' as const,
                }
              : null;

  function confirmSubscriptionAction() {
    if (!confirmationAction || !confirmationDetails) {
      return;
    }

    setPendingConfirmationAction(confirmationAction);

    void runAction(confirmationDetails.action, confirmationDetails.successMessage)
      .then(() => {
        setConfirmationAction(null);
      })
      .catch(() => {
        toast.error('Unable to update subscription');
      })
      .finally(() => {
        setPendingConfirmationAction(null);
      });
  }

  const primaryDetailRows: Array<{ label: string; value: string }> = [
    { label: 'Plan', value: capitalize(subscription.plan) },
    { label: 'Price', value: formatKiloclawPrice(subscription.plan) },
    {
      label: 'Payment source',
      value: formatPaymentSummary({
        paymentSource: subscription.paymentSource,
        hasStripeFunding: subscription.hasStripeFunding,
      }),
    },
    {
      label: 'Next renewal',
      value: nextRenewalLabel === 'At your next renewal' ? '—' : nextRenewalLabel,
    },
  ];
  const secondaryDetailRows: Array<{ label: string; value: string }> = [
    subscription.commitEndsAt
      ? { label: 'Commit ends', value: formatDateLabel(subscription.commitEndsAt) }
      : null,
    subscription.status === 'trialing' && subscription.trialEndsAt
      ? { label: 'Trial ends', value: formatDateLabel(subscription.trialEndsAt) }
      : null,
    subscription.suspendedAt
      ? { label: 'Suspended at', value: formatDateLabel(subscription.suspendedAt) }
      : null,
    subscription.destructionDeadline
      ? {
          label: 'Destruction deadline',
          value: formatDateLabel(subscription.destructionDeadline),
        }
      : null,
  ].filter((row): row is { label: string; value: string } => row !== null);

  return (
    <div className="space-y-6">
      <DetailPageHeader
        backHref="/subscriptions"
        backLabel="Back to subscriptions"
        title={subscription.instanceName ?? 'KiloClaw'}
        status={subscription.status}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KiloCrabIcon className="h-5 w-5" />
            Subscription details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-5">
            <DetailRow
              label="Instance"
              value={subscription.instanceName || subscription.instanceId}
            />

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {primaryDetailRows.map(row => (
                <DetailRow key={row.label} label={row.label} value={row.value} />
              ))}
            </div>

            {secondaryDetailRows.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {secondaryDetailRows.map(row => (
                  <DetailRow key={row.label} label={row.label} value={row.value} />
                ))}
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {isKiloclawTerminal(subscription.status) ? null : (
        <div className="flex flex-wrap gap-2">
          {subscription.plan !== 'trial' ? (
            hasUserRequestedSwitch ? (
              <Button variant="outline" onClick={() => setConfirmationAction('cancelPlanSwitch')}>
                Cancel Plan Switch
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setConfirmationAction('switchPlan')}>
                Switch to {capitalize(otherPlan)} Plan
              </Button>
            )
          ) : null}

          {subscription.cancelAtPeriodEnd ? (
            <Button variant="outline" onClick={() => setConfirmationAction('reactivate')}>
              Reactivate
            </Button>
          ) : (
            <Button
              variant="outline"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setConfirmationAction('cancelSubscription')}
            >
              Cancel Subscription
            </Button>
          )}

          {subscription.showConversionPrompt ? (
            <Button variant="outline" onClick={() => setConfirmationAction('switchToCredits')}>
              Switch to Credits
            </Button>
          ) : null}

          {subscription.hasStripeFunding ? (
            <StripePortalLink
              onOpenPortal={async () => {
                const result = await trpcClient.kiloclaw.getCustomerPortalUrl.mutate({
                  instanceId,
                  returnUrl: window.location.href,
                });
                return result.url;
              }}
            />
          ) : null}
        </div>
      )}

      <Card>
        <CardHeader className="pb-4">
          <CardTitle>Billing history</CardTitle>
        </CardHeader>
        <CardContent className="pt-1">
          <BillingHistoryTable
            variant={subscription.hasStripeFunding ? 'stripe' : 'credits'}
            entries={billing.entries}
            hasMore={billing.hasMore}
            onLoadMore={() => void billing.loadMore()}
            isLoading={billing.isLoadingMore}
          />
        </CardContent>
      </Card>

      <AlertDialog
        open={confirmationAction !== null}
        onOpenChange={open => {
          if (!open && pendingConfirmationAction === null) {
            setConfirmationAction(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmationDetails?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmationDetails?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          {confirmationDetails?.extraContent ?? null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingConfirmationAction !== null}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant={confirmationDetails?.confirmVariant ?? 'default'}
              onClick={confirmSubscriptionAction}
              disabled={pendingConfirmationAction !== null}
            >
              {pendingConfirmationAction !== null
                ? confirmationDetails?.pendingLabel
                : confirmationDetails?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ConfirmationDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="font-medium">{value}</div>
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
