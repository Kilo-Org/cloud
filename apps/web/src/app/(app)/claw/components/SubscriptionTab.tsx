'use client';

import { useState } from 'react';
import { CreditCard } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { SubscriptionCard } from './billing/SubscriptionCard';
import { CancelDialog } from './billing/CancelDialog';

export function SubscriptionTab() {
  const trpc = useTRPC();
  const { data: billing } = useQuery(trpc.kiloclaw.getActivePersonalBillingStatus.queryOptions());
  const [showCancelDialog, setShowCancelDialog] = useState(false);

  if (!billing) return null;

  const subscription = billing.subscription;
  if (!subscription || subscription.status === 'canceled') {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <CreditCard className="text-muted-foreground h-8 w-8" aria-hidden="true" />
        <div>
          <p className="text-foreground text-sm font-medium">No active subscription</p>
          <p className="text-muted-foreground mt-1 text-sm">
            KiloClaw hosting can no longer be started or renewed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <SubscriptionCard billing={billing} onCancelClick={() => setShowCancelDialog(true)} />
      <CancelDialog open={showCancelDialog} onOpenChange={setShowCancelDialog} billing={billing} />
    </>
  );
}
