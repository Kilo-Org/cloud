'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, CreditCard, Coins, Loader2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import {
  COMMIT_PERIOD_MONTHS,
  formatBillingDate,
  formatMicrodollars,
  PLAN_DISPLAY,
  planLabel,
  type ClawBillingStatus,
} from './billing-types';

type SubscriptionCardProps = {
  billing: ClawBillingStatus;
  onCancelClick: () => void;
};

function PaymentSourceBadge({
  subscription,
}: {
  subscription: NonNullable<ClawBillingStatus['subscription']>;
}) {
  if (subscription.hasStripeFunding) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/15 px-2 py-0.5 text-xs font-medium text-indigo-400">
        <CreditCard className="h-3 w-3" />
        Stripe
      </span>
    );
  }
  if (subscription.paymentSource === 'credits') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-400">
        <Coins className="h-3 w-3" />
        Credits
      </span>
    );
  }
  return null;
}

function ActiveSubscriptionCard({
  billing,
  onCancelClick,
}: {
  billing: ClawBillingStatus;
  onCancelClick: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const instanceId = billing.instance?.id ?? null;
  const switchPlanMutation = useMutation(trpc.kiloclaw.switchPlanAtInstance.mutationOptions());
  const portalMutation = useMutation(trpc.kiloclaw.getCustomerPortalUrl.mutationOptions());
  const cancelSwitchMutation = useMutation(
    trpc.kiloclaw.cancelPlanSwitchAtInstance.mutationOptions()
  );
  const acceptConversionMutation = useMutation(
    trpc.kiloclaw.acceptConversionAtInstance.mutationOptions()
  );
  const CONVERSION_DISMISSED_KEY = 'kiloclaw-conversion-dismissed';
  const [conversionDismissed, setConversionDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(CONVERSION_DISMISSED_KEY) === '1';
  });

  const sub = billing.subscription;
  if (!sub) return null;

  const isCommit = sub.plan === 'commit';
  const currentPlanLabel = planLabel(sub.plan);
  const otherPlanLabel = isCommit
    ? `Standard ($${PLAN_DISPLAY.standard.monthlyDollars}/mo)`
    : `Commit ($${PLAN_DISPLAY.commit.monthlyDollars}/mo · ${COMMIT_PERIOD_MONTHS}-mo term)`;

  const hasUserRequestedSwitch = sub.scheduledBy === 'user';

  async function invalidateBillingQueries() {
    if (!instanceId) return;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.getActivePersonalBillingStatus.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.getPersonalBillingSummary.queryKey(),
      }),
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

  async function handleSwitchPlan() {
    if (!instanceId) return;
    const toPlan = isCommit ? 'standard' : 'commit';
    await switchPlanMutation.mutateAsync({ instanceId, toPlan });
    await invalidateBillingQueries();
  }

  async function handleManageBilling() {
    if (!instanceId) return;
    const result = await portalMutation.mutateAsync({
      instanceId,
      returnUrl: `${window.location.origin}/claw`,
    });
    window.location.href = result.url;
  }

  async function handleCancelSwitch() {
    if (!instanceId) return;
    await cancelSwitchMutation.mutateAsync({ instanceId });
    await invalidateBillingQueries();
  }

  async function handleAcceptConversion() {
    if (!instanceId) return;
    await acceptConversionMutation.mutateAsync({ instanceId });
    await invalidateBillingQueries();
  }

  // Clear the persisted dismiss when the prompt is no longer relevant
  // (e.g. user converted, subscription changed) so it doesn't stay hidden forever.
  useEffect(() => {
    if (!sub.showConversionPrompt && conversionDismissed) {
      localStorage.removeItem(CONVERSION_DISMISSED_KEY);
      setConversionDismissed(false);
    }
  }, [sub.showConversionPrompt, conversionDismissed]);

  const showConversion = sub.showConversionPrompt && !conversionDismissed;

  // Credit-funded renewal info
  const isCreditFunded = !sub.hasStripeFunding && sub.paymentSource === 'credits';
  const renewalDate =
    isCreditFunded && sub.creditRenewalAt ? sub.creditRenewalAt : sub.currentPeriodEnd;

  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">🦀</span>
          <span className="text-foreground text-sm font-semibold">KiloClaw Subscription</span>
        </div>
        <PaymentSourceBadge subscription={sub} />
      </div>

      <div className="text-muted-foreground space-y-1 text-sm">
        <div>
          <span>Plan:</span> <span className="text-foreground">{currentPlanLabel}</span>
        </div>
        <div>
          <span>Status:</span> <span className="text-emerald-400">Active</span>
        </div>
        {isCommit && sub.commitEndsAt ? (
          <>
            <div>
              <span>Commit period ends:</span>{' '}
              <span className="text-foreground">{formatBillingDate(sub.commitEndsAt)}</span>
            </div>
            <div className="text-xs">(Auto-renews for another {COMMIT_PERIOD_MONTHS} months)</div>
          </>
        ) : (
          <div>
            <span>Next billing:</span>{' '}
            <span className="text-foreground">{formatBillingDate(renewalDate)}</span>
          </div>
        )}
        {isCreditFunded && sub.renewalCostMicrodollars != null && (
          <div>
            <span>Renewal cost:</span>{' '}
            <span className="text-foreground">
              {formatMicrodollars(sub.renewalCostMicrodollars)} from credit balance
            </span>
          </div>
        )}
        {hasUserRequestedSwitch && (
          <div className="mt-1 text-amber-400">
            Switching to {isCommit ? 'Standard' : 'Commit'} on{' '}
            {formatBillingDate(sub.currentPeriodEnd)}
          </div>
        )}
      </div>

      {showConversion && (
        <div className="mt-3 rounded-lg border border-blue-500/30 bg-blue-500/10 p-3">
          <p className="text-sm text-blue-300">
            You have an active Kilo Pass. Switch hosting to credit-funded billing to stop the
            separate Stripe charge — your current period continues as-is.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleAcceptConversion}
              disabled={acceptConversionMutation.isPending || !instanceId}
            >
              Switch to Credits
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                localStorage.setItem(CONVERSION_DISMISSED_KEY, '1');
                setConversionDismissed(true);
              }}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {hasUserRequestedSwitch ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancelSwitch}
            disabled={cancelSwitchMutation.isPending || !instanceId}
          >
            {cancelSwitchMutation.isPending ? (
              <>
                <Loader2 className="animate-spin" />
                Canceling...
              </>
            ) : (
              'Cancel Switch'
            )}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={handleSwitchPlan}
            disabled={switchPlanMutation.isPending || !instanceId}
          >
            {switchPlanMutation.isPending ? (
              <>
                <Loader2 className="animate-spin" />
                Switching...
              </>
            ) : (
              `Switch to ${otherPlanLabel}`
            )}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onCancelClick}>
          Cancel
        </Button>
        {sub.hasStripeFunding && (
          <Button variant="ghost" size="sm" onClick={handleManageBilling}>
            Manage Payment <ExternalLink className="ml-1 h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

function ConvertingSubscriptionCard({
  billing,
  onReactivateClick,
  isReactivating,
}: {
  billing: ClawBillingStatus;
  onReactivateClick: () => void;
  isReactivating: boolean;
}) {
  const sub = billing.subscription;
  if (!sub) return null;

  return (
    <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">🦀</span>
          <span className="text-foreground text-sm font-semibold">KiloClaw Subscription</span>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-400">
          <Coins className="h-3 w-3" />
          Switching to Credits
        </span>
      </div>

      <div className="text-muted-foreground space-y-1 text-sm">
        <div>
          <span>Plan:</span> <span className="text-foreground">{planLabel(sub.plan)}</span>
        </div>
        <div>
          <span>Status:</span>{' '}
          <span className="text-blue-400">
            Switches to credit billing on {formatBillingDate(sub.currentPeriodEnd)}
          </span>
        </div>
        <p className="text-muted-foreground text-xs">
          Your Stripe charge ends at the current period. After that, hosting renews from your credit
          balance.
        </p>
      </div>

      <div className="mt-4">
        <Button variant="outline" size="sm" onClick={onReactivateClick} disabled={isReactivating}>
          {isReactivating ? (
            <>
              <Loader2 className="animate-spin" />
              Reactivating...
            </>
          ) : (
            'Keep Stripe Billing'
          )}
        </Button>
      </div>
    </div>
  );
}

function CancelingSubscriptionCard({
  billing,
  onReactivateClick,
  isReactivating,
}: {
  billing: ClawBillingStatus;
  onReactivateClick: () => void;
  isReactivating: boolean;
}) {
  const sub = billing.subscription;
  if (!sub) return null;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">🦀</span>
          <span className="text-foreground text-sm font-semibold">KiloClaw Subscription</span>
        </div>
        <PaymentSourceBadge subscription={sub} />
      </div>

      <div className="text-muted-foreground space-y-1 text-sm">
        <div>
          <span>Plan:</span> <span className="text-foreground">{planLabel(sub.plan)}</span>
        </div>
        <div>
          <span>Status:</span>{' '}
          <span className="text-amber-400">
            Cancels on {formatBillingDate(sub.currentPeriodEnd)}
          </span>
        </div>
      </div>

      <div className="mt-4">
        <Button variant="outline" onClick={onReactivateClick} disabled={isReactivating}>
          {isReactivating ? (
            <>
              <Loader2 className="animate-spin" />
              Reactivating...
            </>
          ) : (
            'Reactivate'
          )}
        </Button>
      </div>
    </div>
  );
}

function PastDueSubscriptionCard({
  billing,
  onUpdatePaymentClick,
}: {
  billing: ClawBillingStatus;
  onUpdatePaymentClick: () => void;
}) {
  const sub = billing.subscription;
  if (!sub) return null;

  const isCreditFunded = !sub.hasStripeFunding && sub.paymentSource === 'credits';

  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">🦀</span>
          <span className="text-foreground text-sm font-semibold">KiloClaw Subscription</span>
        </div>
        <PaymentSourceBadge subscription={sub} />
      </div>

      <div className="text-muted-foreground space-y-1 text-sm">
        <div>
          <span>Status:</span> <span className="text-red-400">Payment Failed</span>
        </div>
        <p className="text-red-400">
          {isCreditFunded
            ? 'Your credit balance is insufficient for the next renewal. Add credits to avoid service interruption.'
            : 'Your last payment failed. Update your payment method to avoid service interruption.'}
        </p>
      </div>

      <div className="mt-4">
        {isCreditFunded ? (
          <Button variant="destructive" asChild>
            <Link href="/credits">Add Credits</Link>
          </Button>
        ) : (
          <Button variant="destructive" onClick={onUpdatePaymentClick}>
            Update Payment Method
          </Button>
        )}
      </div>
    </div>
  );
}

export function SubscriptionCard({ billing, onCancelClick }: SubscriptionCardProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const instanceId = billing.instance?.id ?? null;
  const reactivateMutation = useMutation(
    trpc.kiloclaw.reactivateSubscriptionAtInstance.mutationOptions()
  );
  const portalMutation = useMutation(trpc.kiloclaw.getCustomerPortalUrl.mutationOptions());

  async function invalidateBillingQueries() {
    if (!instanceId) return;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.getActivePersonalBillingStatus.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.getPersonalBillingSummary.queryKey(),
      }),
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

  function handleReactivate() {
    if (!instanceId || reactivateMutation.isPending) return;
    reactivateMutation.mutate(
      { instanceId },
      {
        onSuccess: () => {
          void invalidateBillingQueries();
        },
      }
    );
  }

  async function handleUpdatePayment() {
    if (!instanceId) return;
    const result = await portalMutation.mutateAsync({
      instanceId,
      returnUrl: `${window.location.origin}/claw`,
    });
    window.location.href = result.url;
  }

  if (billing.subscription) {
    if (billing.subscription.status === 'past_due' || billing.subscription.status === 'unpaid') {
      return (
        <PastDueSubscriptionCard billing={billing} onUpdatePaymentClick={handleUpdatePayment} />
      );
    }
    if (billing.subscription.cancelAtPeriodEnd && billing.subscription.pendingConversion) {
      return (
        <ConvertingSubscriptionCard
          billing={billing}
          onReactivateClick={handleReactivate}
          isReactivating={reactivateMutation.isPending}
        />
      );
    }
    if (billing.subscription.cancelAtPeriodEnd) {
      return (
        <CancelingSubscriptionCard
          billing={billing}
          onReactivateClick={handleReactivate}
          isReactivating={reactivateMutation.isPending}
        />
      );
    }
    if (billing.subscription.status === 'active') {
      return <ActiveSubscriptionCard billing={billing} onCancelClick={onCancelClick} />;
    }
  }

  return null;
}
