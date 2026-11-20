'use client';

import { useState, type ReactNode } from 'react';
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
  formatStandardContinuationPrice,
  getKiloClawRetirementDisplay,
  planLabel,
  type ClawBillingStatus,
} from './billing-types';

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

  const portalMutation = useMutation(trpc.kiloclaw.getCustomerPortalUrl.mutationOptions());
  const cancelSwitchMutation = useMutation(
    trpc.kiloclaw.cancelPlanSwitchAtInstance.mutationOptions()
  );
  const [confirmingCancelSwitch, setConfirmingCancelSwitch] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const sub = billing.subscription;

  if (!sub) return null;

  const isCommit = sub.plan === 'commit';
  const retirement = getKiloClawRetirementDisplay(sub);
  const finalCommitEndsAt = retirement.finalCommitEndsAt ?? sub.currentPeriodEnd;
  const hasUserRequestedSwitch = sub.scheduledBy === 'user';
  const isCreditFunded = !sub.hasStripeFunding && sub.paymentSource === 'credits';
  const renewalDate =
    isCreditFunded && sub.creditRenewalAt ? sub.creditRenewalAt : sub.currentPeriodEnd;
  async function handleManageBilling() {
    if (!instanceId) return;
    const result = await portalMutation.mutateAsync({
      instanceId,
      returnUrl: `${window.location.origin}/claw`,
    });
    window.location.href = result.url;
  }

  const cancelSwitchCopy = retirement.standardContinuationScheduled
    ? {
        title: 'Cancel month-to-month continuation?',
        description: `Standard will no longer start on ${formatBillingDate(finalCommitEndsAt)}. Hosting ends when your final Commit term ends.`,
        confirmLabel: 'Cancel month-to-month continuation',
        pendingLabel: 'Canceling continuation',
      }
    : {
        title: 'Cancel scheduled plan switch?',
        description:
          'Keeps your KiloClaw subscription on its current plan and removes the pending change.',
        confirmLabel: 'Cancel plan switch',
        pendingLabel: 'Canceling plan switch',
      };

  function confirmCancelSwitch() {
    if (!instanceId) return;
    setIsPending(true);
    void (async () => {
      try {
        await cancelSwitchMutation.mutateAsync({ instanceId });
        setConfirmingCancelSwitch(false);
        try {
          await invalidate();
        } catch (error) {
          console.error('[kiloclaw-billing] failed to refresh after confirmation action', error);
          toast.error('Action completed, but billing did not refresh. Refresh the page.');
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Action failed. Try again.');
      } finally {
        setIsPending(false);
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
                ? `Standard starts on ${formatBillingDate(finalCommitEndsAt)} at ${formatStandardContinuationPrice(retirement.standardContinuationPriceMicrodollars)} using ${formatKiloClawFundingSource(retirement.futureFundingSource)}.`
                : `Your final Commit term ends on ${formatBillingDate(finalCommitEndsAt)}. Hosting ends then.`}
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

      <div className="flex flex-wrap gap-2 pt-1">
        {!retirement.needsSupportReview &&
        (retirement.isFinalCommitTerm
          ? retirement.standardContinuationScheduled
          : hasUserRequestedSwitch) ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmingCancelSwitch(true)}
            disabled={!instanceId}
          >
            {cancelSwitchCopy.confirmLabel}
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
        open={confirmingCancelSwitch}
        onOpenChange={open => {
          if (!open && !isPending) setConfirmingCancelSwitch(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{cancelSwitchCopy.title}</AlertDialogTitle>
            <AlertDialogDescription>{cancelSwitchCopy.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCancelSwitch}
              disabled={isPending}
              aria-busy={isPending}
            >
              {isPending ? cancelSwitchCopy.pendingLabel : cancelSwitchCopy.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </KiloClawCardShell>
  );
}

function ConvertingSubscriptionCard({ billing }: { billing: ClawBillingStatus }) {
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
    </KiloClawCardShell>
  );
}

function CancelingSubscriptionCard({ billing }: { billing: ClawBillingStatus }) {
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
          </p>
        </AlertDescription>
      </Alert>
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

  const portalMutation = useMutation(trpc.kiloclaw.getCustomerPortalUrl.mutationOptions());

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
      return <ConvertingSubscriptionCard billing={billing} />;
    }
    if (billing.subscription.cancelAtPeriodEnd) {
      return <CancelingSubscriptionCard billing={billing} />;
    }
    if (billing.subscription.status === 'active') {
      return <ActiveSubscriptionCard billing={billing} onCancelClick={onCancelClick} />;
    }
  }

  return null;
}
