'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, CreditCard, Coins } from 'lucide-react';
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
  const switchPlanMutation = useMutation(trpc.kiloclaw.switchPlan.mutationOptions());
  const portalMutation = useMutation(trpc.kiloclaw.createBillingPortalSession.mutationOptions());
  const cancelSwitchMutation = useMutation(trpc.kiloclaw.cancelPlanSwitch.mutationOptions());
  const acceptConversionMutation = useMutation(trpc.kiloclaw.acceptConversion.mutationOptions());
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

  async function handleSwitchPlan() {
    const toPlan = isCommit ? 'standard' : 'commit';
    await switchPlanMutation.mutateAsync({ toPlan });
    void queryClient.invalidateQueries({
      queryKey: trpc.kiloclaw.getBillingStatus.queryKey(),
    });
  }

  async function handleManageBilling() {
    const result = await portalMutation.mutateAsync();
    window.location.href = result.url;
  }

  async function handleCancelSwitch() {
    await cancelSwitchMutation.mutateAsync();
    void queryClient.invalidateQueries({
      queryKey: trpc.kiloclaw.getBillingStatus.queryKey(),
    });
  }

  async function handleAcceptConversion() {
    await acceptConversionMutation.mutateAsync();
    void queryClient.invalidateQueries({
      queryKey: trpc.kiloclaw.getBillingStatus.queryKey(),
    });
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
              disabled={acceptConversionMutation.isPending}
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
            disabled={cancelSwitchMutation.isPending}
          >
            Cancel Switch
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={handleSwitchPlan}
            disabled={switchPlanMutation.isPending}
          >
            Switch to {otherPlanLabel}
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
}: {
  billing: ClawBillingStatus;
  onReactivateClick: () => void;
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
        <Button variant="outline" size="sm" onClick={onReactivateClick}>
          Keep Stripe Billing
        </Button>
      </div>
    </div>
  );
}

function CancelingSubscriptionCard({
  billing,
  onReactivateClick,
}: {
  billing: ClawBillingStatus;
  onReactivateClick: () => void;
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
        <Button variant="outline" onClick={onReactivateClick}>
          Reactivate
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
  const reactivateMutation = useMutation(trpc.kiloclaw.reactivateSubscription.mutationOptions());
  const portalMutation = useMutation(trpc.kiloclaw.createBillingPortalSession.mutationOptions());

  function handleReactivate() {
    reactivateMutation.mutate(undefined, {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.kiloclaw.getBillingStatus.queryKey(),
        });
      },
    });
  }

  async function handleUpdatePayment() {
    const result = await portalMutation.mutateAsync();
    window.location.href = result.url;
  }

  if (billing.subscription) {
    if (billing.subscription.status === 'past_due' || billing.subscription.status === 'unpaid') {
      return (
        <PastDueSubscriptionCard billing={billing} onUpdatePaymentClick={handleUpdatePayment} />
      );
    }
    if (billing.subscription.cancelAtPeriodEnd && billing.subscription.pendingConversion) {
      return <ConvertingSubscriptionCard billing={billing} onReactivateClick={handleReactivate} />;
    }
    if (billing.subscription.cancelAtPeriodEnd) {
      return <CancelingSubscriptionCard billing={billing} onReactivateClick={handleReactivate} />;
    }
    if (billing.subscription.status === 'active') {
      return <ActiveSubscriptionCard billing={billing} onCancelClick={onCancelClick} />;
    }
  }

  return null;
}
