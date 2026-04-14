'use client';

import { useState } from 'react';
import { CreditCard } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { EarlybirdCard } from './billing/EarlybirdCard';
import { SubscriptionCard } from './billing/SubscriptionCard';
import { CancelDialog } from './billing/CancelDialog';
import { PlanSelectionDialog } from './billing/PlanSelectionDialog';

export function SubscriptionTab() {
  const trpc = useTRPC();
  const { data: billing } = useQuery(trpc.kiloclaw.getBillingStatus.queryOptions());
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showPlanDialog, setShowPlanDialog] = useState(false);

  if (!billing) return null;

  const subscription = billing.subscription;
  const showInactiveSubscriptionState = !subscription || subscription.status === 'canceled';

  if (showInactiveSubscriptionState) {
    if (billing.earlybird && billing.earlybird.daysRemaining > 0) {
      return (
        <>
          <EarlybirdCard
            earlybird={billing.earlybird}
            onSubscribeClick={() => setShowPlanDialog(true)}
          />
          <PlanSelectionDialog open={showPlanDialog} onOpenChange={setShowPlanDialog} />
        </>
      );
    }

    const trialDays = billing.trial && !billing.trial.expired ? billing.trial.daysRemaining : null;

    return (
      <>
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <CreditCard className="text-muted-foreground h-8 w-8" />
          <div>
            <p className="text-foreground text-sm font-medium">No active subscription</p>
            <p className="text-muted-foreground mt-1 text-sm">
              {trialDays != null
                ? `Your free trial has ${trialDays} ${trialDays === 1 ? 'day' : 'days'} remaining. You won't be charged automatically — subscribe to keep your instance running.`
                : "Subscribe to a hosting plan to keep your instance running. You won't be charged automatically."}
            </p>
          </div>
          <Button variant="primary" onClick={() => setShowPlanDialog(true)}>
            Subscribe Now
          </Button>
        </div>
        <PlanSelectionDialog open={showPlanDialog} onOpenChange={setShowPlanDialog} />
      </>
    );
  }

  return (
    <>
      <SubscriptionCard billing={billing} onCancelClick={() => setShowCancelDialog(true)} />
      <CancelDialog open={showCancelDialog} onOpenChange={setShowCancelDialog} billing={billing} />
    </>
  );
}
