'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { toast } from 'sonner';
import { useInvalidateKiloClawBilling } from './useKiloClawBillingQueries';
import KiloCrabIcon from '@/components/KiloCrabIcon';
import { SubscriptionCard } from '@/components/subscriptions/SubscriptionCard';
import { SubscriptionGroup } from '@/components/subscriptions/SubscriptionGroup';
import { KiloClawSignupUnavailable } from './KiloClawSignupUnavailable';
import {
  formatDateLabel,
  formatKiloclawPrice,
  formatPaymentSummary,
  getKiloclawDisplayStatus,
  getKiloclawStatusNote,
  isInfoStatus,
  isKiloclawTerminal,
  isWarningStatus,
} from '@/components/subscriptions/helpers';
import {
  formatKiloClawFundingSource,
  formatStandardContinuationPrice,
  getKiloClawRetirementDisplay,
} from '@/app/(app)/claw/components/billing/billing-types';

export function KiloClawGroup({
  showTerminal,
  accordionValue,
  hideHeader = false,
}: {
  showTerminal: boolean;
  accordionValue?: string;
  hideHeader?: boolean;
}) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const [continuationInstanceId, setContinuationInstanceId] = useState<string | null>(null);
  const [pendingContinuation, setPendingContinuation] = useState(false);
  const query = useQuery(trpc.kiloclaw.listPersonalSubscriptions.queryOptions());
  const subscriptions = query.data?.subscriptions ?? [];

  const visibleSubscriptions = subscriptions.filter(
    subscription => !isKiloclawTerminal(subscription.status) || showTerminal
  );
  const nonTerminalSubscriptions = subscriptions.filter(
    subscription => !isKiloclawTerminal(subscription.status)
  );
  const invalidateContinuation = useInvalidateKiloClawBilling(continuationInstanceId);

  function cancelMonthToMonthContinuation() {
    if (!continuationInstanceId) return;
    setPendingContinuation(true);
    void trpcClient.kiloclaw.cancelPlanSwitchAtInstance
      .mutate({ instanceId: continuationInstanceId })
      .then(async () => {
        toast.success('Month-to-month continuation canceled');
        await invalidateContinuation();
        setContinuationInstanceId(null);
      })
      .catch(error => {
        toast.error(error instanceof Error ? error.message : 'Unable to update continuation');
      })
      .finally(() => setPendingContinuation(false));
  }

  return (
    <SubscriptionGroup
      title="KiloClaw"
      description="View hosting subscriptions for your personal KiloClaw instances."
      headerIcon={<KiloCrabIcon className="size-5" />}
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      onRetry={() => {
        void query.refetch();
      }}
      accordionValue={accordionValue}
      hideHeader={hideHeader}
      unframed={hideHeader}
    >
      {visibleSubscriptions.length > 0 ? (
        <div className="grid gap-3">
          {visibleSubscriptions.map(subscription => {
            const retirement = getKiloClawRetirementDisplay(subscription);
            const finalDate = formatDateLabel(retirement.finalCommitEndsAt, 'the final boundary');
            const retirementNote = retirement.needsSupportReview
              ? 'Your current access continues while support reviews your Commit plan.'
              : retirement.isFinalCommitTerm
                ? retirement.standardContinuationScheduled
                  ? `Standard starts ${finalDate} at ${formatStandardContinuationPrice(retirement.standardContinuationPriceMicrodollars)} using ${formatKiloClawFundingSource(retirement.futureFundingSource)}.`
                  : `Final Commit term ends ${finalDate}. Hosting ends then.`
                : getKiloclawStatusNote(subscription);

            return (
              <div key={subscription.instanceId} className="space-y-2">
                {retirement.isFinalCommitTerm || retirement.needsSupportReview ? (
                  <Alert variant={retirement.needsSupportReview ? 'notice' : 'warning'}>
                    <CalendarClock aria-hidden="true" />
                    <AlertTitle>
                      {retirement.needsSupportReview
                        ? 'Commit plan needs support review'
                        : retirement.standardContinuationScheduled
                          ? 'Month-to-month continuation scheduled'
                          : 'Final Commit term'}
                    </AlertTitle>
                    <AlertDescription>{retirementNote}</AlertDescription>
                  </Alert>
                ) : null}
                <SubscriptionCard
                  icon={<KiloCrabIcon className="size-5" />}
                  title={subscription.instanceName ?? 'KiloClaw instance'}
                  subtitle={subscription.instanceName || subscription.instanceId}
                  status={getKiloclawDisplayStatus(subscription)}
                  price={formatKiloclawPrice({
                    plan: subscription.plan,
                    priceVersion: subscription.priceVersion,
                    renewalCostMicrodollars: subscription.renewalCostMicrodollars,
                  })}
                  billingDate={formatDateLabel(
                    retirement.isFinalCommitTerm
                      ? retirement.finalCommitEndsAt
                      : (subscription.creditRenewalAt ??
                          subscription.currentPeriodEnd ??
                          subscription.trialEndsAt),
                    '—'
                  )}
                  billingDateLabel={retirement.isFinalCommitTerm ? 'Final term ends' : 'Renews at'}
                  paymentMethod={formatPaymentSummary({
                    paymentSource: subscription.paymentSource,
                    hasStripeFunding: subscription.hasStripeFunding,
                  })}
                  href={`/subscriptions/kiloclaw/${subscription.instanceId}`}
                  isTerminal={isKiloclawTerminal(subscription.status)}
                  statusNote={retirementNote}
                  warningTone={
                    retirement.isFinalCommitTerm || retirement.needsSupportReview
                      ? 'warning'
                      : subscription.activationState === 'pending_settlement'
                        ? 'info'
                        : isWarningStatus(subscription.status)
                          ? 'warning'
                          : isInfoStatus(subscription.status)
                            ? 'info'
                            : undefined
                  }
                  action={
                    retirement.isFinalCommitTerm &&
                    !retirement.needsSupportReview &&
                    retirement.standardContinuationScheduled ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setContinuationInstanceId(subscription.instanceId)}
                      >
                        Cancel month-to-month continuation
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            );
          })}
        </div>
      ) : nonTerminalSubscriptions.length === 0 ? (
        <KiloClawSignupUnavailable />
      ) : null}
      <AlertDialog
        open={continuationInstanceId !== null}
        onOpenChange={open => {
          if (!open && !pendingContinuation) setContinuationInstanceId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel month-to-month continuation?</AlertDialogTitle>
            <AlertDialogDescription>
              Standard will no longer start when your final Commit term ends. Hosting ends at the
              final boundary.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingContinuation}>
              Keep current choice
            </AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              onClick={cancelMonthToMonthContinuation}
              disabled={pendingContinuation}
              aria-busy={pendingContinuation}
            >
              {pendingContinuation
                ? 'Canceling continuation'
                : 'Cancel month-to-month continuation'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SubscriptionGroup>
  );
}
