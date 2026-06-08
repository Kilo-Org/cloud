'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { CalendarClock, ExternalLink, Loader2 } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/lib/trpc/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import KiloCrabIcon from '@/components/KiloCrabIcon';
import { DetailRow } from '@/components/subscriptions/DetailRow';
import { formatPaymentSummary } from '@/components/subscriptions/helpers';
import { SubscriptionStatusBadge } from '@/components/subscriptions/SubscriptionStatusBadge';
import { useInvalidateKiloClawBilling } from '@/components/subscriptions/kiloclaw/useKiloClawBillingQueries';
import { cn } from '@/lib/utils';

import {
  formatBillingDate,
  formatKiloClawFundingSource,
  formatMicrodollars,
  formatKiloClawPlanPrice,
  formatStandardContinuationPrice,
  getKiloClawRetirementDisplay,
  planLabel,
  type ClawBillingStatus,
} from './billing-types';
import { ReferralRewardsSummary } from './ReferralRewardsSummary';

type SubscriptionCardProps = {
  billing: ClawBillingStatus;
  onCancelClick: () => void;
};

type ShellStatus = 'active' | 'pending_settlement' | 'past_due' | 'unpaid' | 'pending_cancellation';

function KiloClawCardShell({ status, children }: { status: ShellStatus; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <KiloCrabIcon className="size-5" />
          KiloClaw subscription
        </CardTitle>
        <SubscriptionStatusBadge status={status} />
      </CardHeader>
      <CardContent className="space-y-6">{children}</CardContent>
    </Card>
  );
}

function PendingSettlementSubscriptionCard({ billing }: { billing: ClawBillingStatus }) {
  const sub = billing.subscription;
  if (!sub) return null;

  return (
    <KiloClawCardShell status="pending_settlement">
      <Alert variant="notice">
        <Loader2 className="animate-spin" aria-hidden="true" />
        <AlertTitle>Processing payment</AlertTitle>
        <AlertDescription>
          Hosting activates after invoice settlement. This usually takes just a moment.
        </AlertDescription>
      </Alert>
    </KiloClawCardShell>
  );
}

type ActiveConfirmationAction =
  | 'switchPlan'
  | 'continueMonthToMonth'
  | 'cancelPlanSwitch'
  | 'switchToCredits';

type ActiveConfirmation = {
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  run: () => Promise<unknown>;
};

function ActiveSubscriptionCard({
  billing,
  onCancelClick,
}: {
  billing: ClawBillingStatus;
  onCancelClick: () => void;
}) {
  const trpc = useTRPC();
  const instanceId = billing.instance?.id ?? null;
  const invalidate = useInvalidateKiloClawBilling(instanceId);

  const switchPlanMutation = useMutation(trpc.kiloclaw.switchPlanAtInstance.mutationOptions());
  const continueCommitMutation = useMutation(
    trpc.kiloclaw.continueCommitAsStandard.mutationOptions()
  );
  const portalMutation = useMutation(trpc.kiloclaw.getCustomerPortalUrl.mutationOptions());
  const cancelSwitchMutation = useMutation(
    trpc.kiloclaw.cancelPlanSwitchAtInstance.mutationOptions()
  );
  const acceptConversionMutation = useMutation(
    trpc.kiloclaw.acceptConversionAtInstance.mutationOptions()
  );

  const [confirmationAction, setConfirmationAction] = useState<ActiveConfirmationAction | null>(
    null
  );
  const [pendingAction, setPendingAction] = useState<ActiveConfirmationAction | null>(null);

  const CONVERSION_DISMISSED_KEY = 'kiloclaw-conversion-dismissed';
  const [conversionDismissed, setConversionDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(CONVERSION_DISMISSED_KEY) === '1';
  });

  const sub = billing.subscription;

  useEffect(() => {
    if (sub && !sub.showConversionPrompt && conversionDismissed) {
      localStorage.removeItem(CONVERSION_DISMISSED_KEY);
      setConversionDismissed(false);
    }
  }, [sub, conversionDismissed]);

  if (!sub) return null;

  const isCommit = sub.plan === 'commit';
  const retirement = getKiloClawRetirementDisplay(sub);
  const finalCommitEndsAt = retirement.finalCommitEndsAt ?? sub.currentPeriodEnd;
  const standardContinuationPrice = formatStandardContinuationPrice(
    retirement.standardContinuationPriceMicrodollars
  );
  const futureFundingSource = formatKiloClawFundingSource(retirement.futureFundingSource);
  const otherPlan = isCommit ? 'standard' : 'commit';
  const otherPlanLabel = formatKiloClawPlanPrice({
    plan: otherPlan,
    priceVersion: sub.priceVersion,
  });
  const canSwitchPlan = otherPlan !== 'commit' || billing.commitPlanAvailable === true;

  const hasUserRequestedSwitch = sub.scheduledBy === 'user';
  const isCreditFunded = !sub.hasStripeFunding && sub.paymentSource === 'credits';
  const renewalDate =
    isCreditFunded && sub.creditRenewalAt ? sub.creditRenewalAt : sub.currentPeriodEnd;
  const showConversion = sub.showConversionPrompt && !conversionDismissed;

  async function handleManageBilling() {
    if (!instanceId) return;
    const result = await portalMutation.mutateAsync({
      instanceId,
      returnUrl: `${window.location.origin}/claw`,
    });
    window.location.href = result.url;
  }

  const confirmations: Record<ActiveConfirmationAction, ActiveConfirmation> = {
    switchPlan: {
      title: `Switch to ${isCommit ? 'Standard' : 'Commit'}?`,
      description: `Schedules your KiloClaw subscription to switch plans at the next renewal. Your current plan stays active until then.`,
      confirmLabel: `Switch to ${otherPlan}`,
      pendingLabel: `Switching to ${otherPlan}`,
      run: async () => {
        if (!instanceId) return;
        await switchPlanMutation.mutateAsync({ instanceId, toPlan: otherPlan });
      },
    },
    continueMonthToMonth: {
      title: 'Continue month-to-month?',
      description: `Standard starts on ${formatBillingDate(finalCommitEndsAt)} at ${standardContinuationPrice} using ${futureFundingSource}. Your final Commit term stays active until then.`,
      confirmLabel: 'Continue month-to-month',
      pendingLabel: 'Scheduling continuation',
      run: async () => {
        if (!instanceId) return;
        await continueCommitMutation.mutateAsync({ instanceId });
      },
    },
    cancelPlanSwitch: {
      title: retirement.standardContinuationScheduled
        ? 'Cancel month-to-month continuation?'
        : 'Cancel scheduled plan switch?',
      description: retirement.standardContinuationScheduled
        ? `Standard will no longer start on ${formatBillingDate(finalCommitEndsAt)}. Hosting ends when your final Commit term ends.`
        : 'Keeps your KiloClaw subscription on its current plan and removes the pending change.',
      confirmLabel: retirement.standardContinuationScheduled
        ? 'Cancel month-to-month continuation'
        : 'Cancel plan switch',
      pendingLabel: retirement.standardContinuationScheduled
        ? 'Canceling continuation'
        : 'Canceling plan switch',
      run: async () => {
        if (!instanceId) return;
        await cancelSwitchMutation.mutateAsync({ instanceId });
      },
    },
    switchToCredits: {
      title: 'Switch hosting billing to credits?',
      description: retirement.isFinalCommitTerm
        ? `Stripe billing stays active through the final Commit term. Then Standard starts at ${standardContinuationPrice} and renews from your credit balance.`
        : 'Stripe billing stays active through the current period, then this subscription renews against your credit balance.',
      confirmLabel: 'Switch to credits',
      pendingLabel: 'Switching to credits',
      run: async () => {
        if (!instanceId) return;
        await acceptConversionMutation.mutateAsync({ instanceId });
      },
    },
  };

  const activeConfirmation = confirmationAction ? confirmations[confirmationAction] : null;
  const isPending = pendingAction !== null;

  function confirmCurrentAction() {
    if (!confirmationAction || !activeConfirmation) return;
    setPendingAction(confirmationAction);
    void (async () => {
      try {
        await activeConfirmation.run();
        setConfirmationAction(null);
        try {
          await invalidate();
        } catch (error) {
          console.error('[kiloclaw-billing] failed to refresh after confirmation action', error);
          toast.error('Action completed, but billing did not refresh. Refresh the page.');
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Action failed. Try again.');
      } finally {
        setPendingAction(null);
      }
    })();
  }

  return (
    <KiloClawCardShell status="active">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <DetailRow label="Plan" value={planLabel(sub.plan, sub.priceVersion)} numeric />
        <DetailRow
          label={isCommit ? 'Commit period ends' : 'Next billing'}
          value={formatBillingDate(renewalDate)}
          numeric
        />
        <DetailRow
          label="Payment source"
          value={formatPaymentSummary({
            paymentSource: sub.paymentSource,
            hasStripeFunding: sub.hasStripeFunding,
          })}
        />
        {retirement.isFinalCommitTerm ? (
          <DetailRow
            label="After final term"
            value={
              retirement.standardContinuationScheduled ? 'Standard month-to-month' : 'Hosting ends'
            }
          />
        ) : null}
        {isCreditFunded && sub.renewalCostMicrodollars != null ? (
          <DetailRow
            label="Renewal cost"
            value={`${formatMicrodollars(sub.renewalCostMicrodollars)} from credits`}
            numeric
          />
        ) : null}
      </div>

      {retirement.needsSupportReview ? (
        <Alert variant="notice">
          <CalendarClock aria-hidden="true" />
          <AlertTitle>Commit plan needs support review</AlertTitle>
          <AlertDescription>
            <p>Your current access continues while support reviews your Commit plan.</p>
            <Button asChild variant="outline" size="sm">
              <Link href="https://kilo.ai/support">Contact support</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : retirement.isFinalCommitTerm ? (
        <Alert variant="warning">
          <CalendarClock aria-hidden="true" />
          <AlertTitle>
            {retirement.standardContinuationScheduled
              ? 'Month-to-month continuation scheduled'
              : 'Final Commit term'}
          </AlertTitle>
          <AlertDescription>
            <p>
              {retirement.standardContinuationScheduled
                ? `Standard starts on ${formatBillingDate(finalCommitEndsAt)} at ${standardContinuationPrice} using ${futureFundingSource}.`
                : `Your final Commit term ends on ${formatBillingDate(finalCommitEndsAt)}. Hosting ends unless you continue month-to-month at ${standardContinuationPrice} using ${futureFundingSource}.`}
            </p>
          </AlertDescription>
        </Alert>
      ) : hasUserRequestedSwitch ? (
        <Alert variant="warning">
          <AlertDescription>
            <p>
              Switching to {isCommit ? 'Standard' : 'Commit'} on{' '}
              <span className="tabular-nums">{formatBillingDate(sub.currentPeriodEnd)}</span>.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {showConversion ? (
        <Alert variant="notice">
          <AlertDescription>
            <p>
              {retirement.isFinalCommitTerm
                ? `You have an active Kilo Pass. Switching to credits also continues hosting as pure-credit Standard at ${standardContinuationPrice} after the final Commit term.`
                : 'You have an active Kilo Pass. Switch hosting to credit-funded billing to stop the separate Stripe charge — your current period continues as-is.'}
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                onClick={() => setConfirmationAction('switchToCredits')}
                disabled={!instanceId}
              >
                Switch to credits
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
          </AlertDescription>
        </Alert>
      ) : null}

      <ReferralRewardsSummary rewards={sub.referralRewards} variant="section" />

      <div className="flex flex-wrap gap-2 pt-1">
        {retirement.needsSupportReview ? null : retirement.isFinalCommitTerm ? (
          retirement.standardContinuationScheduled ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmationAction('cancelPlanSwitch')}
              disabled={!instanceId}
            >
              Cancel month-to-month continuation
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => setConfirmationAction('continueMonthToMonth')}
              disabled={!instanceId}
            >
              Continue month-to-month
            </Button>
          )
        ) : hasUserRequestedSwitch ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmationAction('cancelPlanSwitch')}
            disabled={!instanceId}
          >
            Cancel plan switch
          </Button>
        ) : canSwitchPlan ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmationAction('switchPlan')}
            disabled={!instanceId}
          >
            Switch to {otherPlanLabel}
          </Button>
        ) : null}
        {!retirement.needsSupportReview && sub.hasStripeFunding ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleManageBilling}
            disabled={portalMutation.isPending}
            aria-busy={portalMutation.isPending}
          >
            {portalMutation.isPending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : null}
            Manage payment <ExternalLink className="ml-1 size-3" aria-hidden="true" />
          </Button>
        ) : null}
        {!retirement.needsSupportReview ? (
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'text-destructive hover:bg-destructive/10 hover:text-destructive',
              'ml-auto'
            )}
            onClick={onCancelClick}
          >
            Cancel subscription
          </Button>
        ) : null}
      </div>

      <AlertDialog
        open={confirmationAction !== null}
        onOpenChange={open => {
          if (!open && !isPending) setConfirmationAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{activeConfirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{activeConfirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCurrentAction}
              disabled={isPending}
              aria-busy={isPending}
            >
              {isPending ? activeConfirmation?.pendingLabel : activeConfirmation?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </KiloClawCardShell>
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
    <KiloClawCardShell status="pending_cancellation">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <DetailRow label="Plan" value={planLabel(sub.plan, sub.priceVersion)} numeric />
        <DetailRow
          label="Switches to credits on"
          value={formatBillingDate(sub.currentPeriodEnd)}
          numeric
        />
        <DetailRow label="Payment source" value="Stripe" />
      </div>

      <Alert variant="notice">
        <AlertDescription>
          Your Stripe charge ends at the current period. After that, hosting renews from your credit
          balance.
        </AlertDescription>
      </Alert>

      <ReferralRewardsSummary rewards={sub.referralRewards} variant="section" />

      <div className="flex flex-wrap gap-2 pt-1">
        <Button onClick={onReactivateClick} disabled={isReactivating} aria-busy={isReactivating}>
          {isReactivating ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Reactivating…
            </>
          ) : (
            'Keep Stripe billing'
          )}
        </Button>
      </div>
    </KiloClawCardShell>
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
    <KiloClawCardShell status="pending_cancellation">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <DetailRow label="Plan" value={planLabel(sub.plan, sub.priceVersion)} numeric />
        <DetailRow label="Cancels on" value={formatBillingDate(sub.currentPeriodEnd)} numeric />
        <DetailRow
          label="Payment source"
          value={formatPaymentSummary({
            paymentSource: sub.paymentSource,
            hasStripeFunding: sub.hasStripeFunding,
          })}
        />
      </div>

      <Alert variant="warning">
        <AlertDescription>
          <p>
            Your subscription cancels on{' '}
            <span className="tabular-nums">{formatBillingDate(sub.currentPeriodEnd)}</span>.
            Reactivate to keep it renewing.
          </p>
        </AlertDescription>
      </Alert>

      <ReferralRewardsSummary rewards={sub.referralRewards} variant="section" />

      <div className="flex flex-wrap gap-2 pt-1">
        <Button onClick={onReactivateClick} disabled={isReactivating} aria-busy={isReactivating}>
          {isReactivating ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Reactivating…
            </>
          ) : (
            'Reactivate'
          )}
        </Button>
      </div>
    </KiloClawCardShell>
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
  const status: ShellStatus = sub.status === 'unpaid' ? 'unpaid' : 'past_due';

  return (
    <KiloClawCardShell status={status}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <DetailRow label="Plan" value={planLabel(sub.plan, sub.priceVersion)} numeric />
        <DetailRow
          label="Payment source"
          value={formatPaymentSummary({
            paymentSource: sub.paymentSource,
            hasStripeFunding: sub.hasStripeFunding,
          })}
        />
      </div>

      <Alert variant="destructive">
        <AlertTitle>Payment failed</AlertTitle>
        <AlertDescription>
          {isCreditFunded
            ? 'Your credit balance is insufficient for the next renewal. Add credits to avoid service interruption.'
            : 'Your last payment failed. Update your payment method to avoid service interruption.'}
        </AlertDescription>
      </Alert>

      <ReferralRewardsSummary rewards={sub.referralRewards} variant="section" />

      <div className="flex flex-wrap gap-2 pt-1">
        {isCreditFunded ? (
          <Button variant="destructive" asChild>
            <Link href="/credits">Add credits</Link>
          </Button>
        ) : (
          <Button variant="destructive" onClick={onUpdatePaymentClick}>
            Update payment method
          </Button>
        )}
      </div>
    </KiloClawCardShell>
  );
}

export function SubscriptionCard({ billing, onCancelClick }: SubscriptionCardProps) {
  const trpc = useTRPC();
  const instanceId = billing.instance?.id ?? null;
  const invalidate = useInvalidateKiloClawBilling(instanceId);

  const reactivateMutation = useMutation(
    trpc.kiloclaw.reactivateSubscriptionAtInstance.mutationOptions()
  );
  const portalMutation = useMutation(trpc.kiloclaw.getCustomerPortalUrl.mutationOptions());

  function handleReactivate() {
    if (!instanceId || reactivateMutation.isPending) return;
    reactivateMutation.mutate(
      { instanceId },
      {
        onSuccess: () => {
          void invalidate();
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
    if (billing.subscription.activationState === 'pending_settlement') {
      return <PendingSettlementSubscriptionCard billing={billing} />;
    }
    if (billing.subscription.status === 'past_due' || billing.subscription.status === 'unpaid') {
      return (
        <PastDueSubscriptionCard billing={billing} onUpdatePaymentClick={handleUpdatePayment} />
      );
    }
    const retirement = getKiloClawRetirementDisplay(billing.subscription);
    if (retirement.isFinalCommitTerm || retirement.needsSupportReview) {
      return <ActiveSubscriptionCard billing={billing} onCancelClick={onCancelClick} />;
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
