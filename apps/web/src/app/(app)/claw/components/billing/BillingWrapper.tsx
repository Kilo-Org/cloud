'use client';

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { BillingBanner } from './BillingBanner';
import { AccessLockedDialog } from './AccessLockedDialog';
import { PlanSelectionDialog } from './PlanSelectionDialog';

import { deriveBannerState, deriveLockReason, formatBillingDate } from './billing-types';

function EarlybirdActiveCard({
  expiresAt,
  onSubscribeClick,
}: {
  expiresAt: string;
  onSubscribeClick: () => void;
}) {
  return (
    <div className="border-brand-primary/30 bg-brand-primary/5 flex items-center gap-3 rounded-xl border p-4">
      <span className="text-xl">🦀</span>
      <div className="flex-1">
        <span className="text-brand-primary text-sm font-semibold">
          Thanks for being an early KiloClaw subscriber.
        </span>
        <span className="text-muted-foreground ml-2 text-sm">
          Your earlybird hosting expires {formatBillingDate(expiresAt)}.
        </span>
      </div>
      <Button variant="outline" size="sm" onClick={onSubscribeClick} className="shrink-0">
        Subscribe
      </Button>
    </div>
  );
}

type BillingWrapperProps = {
  children: ReactNode;
  hideBanners?: boolean;
};

export function BillingWrapper({ children, hideBanners }: BillingWrapperProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: billing } = useQuery(trpc.kiloclaw.getActivePersonalBillingStatus.queryOptions());
  const instanceId = billing?.instance?.id ?? null;

  const [showPlanDialog, setShowPlanDialog] = useState(false);

  const reactivate = useMutation(trpc.kiloclaw.reactivateSubscriptionAtInstance.mutationOptions());
  const billingPortal = useMutation(trpc.kiloclaw.getCustomerPortalUrl.mutationOptions());
  const destroy = useMutation(
    trpc.kiloclaw.destroy.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.getStatus.queryKey() });
        void queryClient.invalidateQueries({
          queryKey: trpc.kiloclaw.getActivePersonalBillingStatus.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.kiloclaw.getPersonalBillingSummary.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.kiloclaw.listPersonalSubscriptions.queryKey(),
        });
      },
    })
  );

  if (!billing) {
    return <>{children}</>;
  }

  const lockReason = deriveLockReason(billing);
  const bannerState = deriveBannerState(billing);

  function handleSubscribe() {
    setShowPlanDialog(true);
  }

  function handleReactivate() {
    if (!instanceId || reactivate.isPending) return;
    reactivate.mutate(
      { instanceId },
      {
        onSuccess: () => {
          void Promise.all([
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
        },
      }
    );
  }

  function handleUpdatePayment() {
    if (!instanceId) return;
    billingPortal.mutate(
      { instanceId, returnUrl: `${window.location.origin}/claw` },
      {
        onSuccess: result => {
          window.location.href = result.url;
        },
      }
    );
  }

  return (
    <>
      {/* Banner — or earlybird card in the banner position */}
      {!hideBanners &&
        (bannerState === 'earlybird_active' && billing.earlybird ? (
          <EarlybirdActiveCard
            expiresAt={billing.earlybird.expiresAt}
            onSubscribeClick={handleSubscribe}
          />
        ) : (
          <BillingBanner
            billing={billing}
            onSubscribeClick={handleSubscribe}
            onReactivateClick={handleReactivate}
            onUpdatePaymentClick={handleUpdatePayment}
            isReactivating={reactivate.isPending}
          />
        ))}

      {/* Lock dialog — blocks interaction when access is revoked */}
      <AccessLockedDialog
        reason={lockReason}
        billing={billing}
        onSubscribeClick={handleSubscribe}
        onUpdatePaymentClick={handleUpdatePayment}
        onDestroyClick={() =>
          destroy.mutate(undefined, {
            onSuccess: () => toast.success('Instance destroyed'),
            onError: err => toast.error(err.message),
          })
        }
        isDestroying={destroy.isPending}
      />

      {/* Dashboard content */}
      {children}

      {/* Plan selection dialog */}
      <PlanSelectionDialog open={showPlanDialog} onOpenChange={setShowPlanDialog} />
    </>
  );
}
