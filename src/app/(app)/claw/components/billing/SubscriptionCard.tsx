'use client';

import { ExternalLink } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { formatBillingDate } from './billing-types';
import type { ClawBillingStatus } from './billing-types';

type SubscriptionCardProps = {
  billing: ClawBillingStatus;
  onCancelClick: () => void;
};

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

  const sub = billing.subscription;
  if (!sub) return null;

  const isCommit = sub.plan === 'commit';
  const planLabel = isCommit ? 'Commit ($8/mo)' : 'Standard ($9/mo)';
  const otherPlan = isCommit ? 'Standard ($9/mo)' : 'Commit ($8/mo)';

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

  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xl">🦀</span>
        <span className="text-foreground text-sm font-semibold">KiloClaw Subscription</span>
      </div>

      <div className="text-muted-foreground space-y-1 text-sm">
        <div>
          <span>Plan:</span> <span className="text-foreground">{planLabel}</span>
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
            <div className="text-xs">(Auto-renews for another 6 months)</div>
          </>
        ) : (
          <div>
            <span>Next billing:</span>{' '}
            <span className="text-foreground">{formatBillingDate(sub.currentPeriodEnd)}</span>
          </div>
        )}
        {hasUserRequestedSwitch && (
          <div className="mt-1 text-amber-400">
            Switching to {isCommit ? 'Standard' : 'Commit'} on{' '}
            {formatBillingDate(sub.currentPeriodEnd)}
          </div>
        )}
      </div>

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
            Switch to {otherPlan}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onCancelClick}>
          Cancel
        </Button>
        <Button variant="ghost" size="sm" onClick={handleManageBilling}>
          Manage <ExternalLink className="ml-1 h-3 w-3" />
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

  const planLabel = sub.plan === 'commit' ? 'Commit ($8/mo)' : 'Standard ($9/mo)';

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xl">🦀</span>
        <span className="text-foreground text-sm font-semibold">KiloClaw Subscription</span>
      </div>

      <div className="text-muted-foreground space-y-1 text-sm">
        <div>
          <span>Plan:</span> <span className="text-foreground">{planLabel}</span>
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

  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xl">🦀</span>
        <span className="text-foreground text-sm font-semibold">KiloClaw Subscription</span>
      </div>

      <div className="text-muted-foreground space-y-1 text-sm">
        <div>
          <span>Status:</span> <span className="text-red-400">Payment Failed</span>
        </div>
        <p className="text-red-400">
          Your last payment failed. Update your payment method to avoid service interruption.
        </p>
      </div>

      <div className="mt-4">
        <Button variant="destructive" onClick={onUpdatePaymentClick}>
          Update Payment Method
        </Button>
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
    if (billing.subscription.cancelAtPeriodEnd) {
      return <CancelingSubscriptionCard billing={billing} onReactivateClick={handleReactivate} />;
    }
    if (billing.subscription.status === 'active') {
      return <ActiveSubscriptionCard billing={billing} onCancelClick={onCancelClick} />;
    }
  }

  return null;
}
