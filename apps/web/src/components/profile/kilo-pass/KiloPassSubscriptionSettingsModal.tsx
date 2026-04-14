'use client';

import { Settings } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { KiloPassTier } from '@/lib/kilo-pass/enums';
import { KiloPassCadence } from '@/lib/kilo-pass/enums';
import { getMonthlyPriceUsd } from '@/lib/kilo-pass/bonus';
import { formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

import { getTierName } from './utils';
import { useKiloPassSubscriptionInfo } from './useKiloPassSubscriptionInfo';
import { useKiloPassChurnkeyCancelFlow } from './useKiloPassChurnkeyCancelFlow';
import {
  getCadenceLabel,
  UpdateFooter,
  UpdatePanel,
} from '@/components/profile/kilo-pass/KiloPassSubscriptionSettingsUpdatePanel';
import { MainPanel } from '@/components/profile/kilo-pass/KiloPassSubscriptionSettingsMainPanel';

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function KiloPassSubscriptionSettingsModal(props: SettingsModalProps) {
  const { isOpen, onClose } = props;
  const { subscription, view, actions } = useKiloPassSubscriptionInfo();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { openCancelFlow, isOpeningCancelFlow } = useKiloPassChurnkeyCancelFlow({
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    fallbackCancelSubscription: actions.cancelSubscription,
    onBeforeOpen: onClose,
  });

  const scheduledChangeQuery = useQuery({
    ...trpc.kiloPass.getScheduledChange.queryOptions(),
    enabled: isOpen,
  });

  const scheduleChange = useMutation(trpc.kiloPass.scheduleChange.mutationOptions());
  const cancelScheduledChange = useMutation(trpc.kiloPass.cancelScheduledChange.mutationOptions());

  const [panel, setPanel] = useState<'main' | 'update'>('update');
  const [isCancelingPendingChangeUntilRefetch, setIsCancelingPendingChangeUntilRefetch] =
    useState(false);

  const scheduledChange = scheduledChangeQuery.data?.scheduledChange ?? null;

  const closeModal = () => {
    setPanel('update');
    onClose();
  };

  const [targetTier, setTargetTier] = useState<KiloPassTier>(subscription.tier);
  const [targetCadence, setTargetCadence] = useState<KiloPassCadence>(subscription.cadence);

  useEffect(() => {
    if (isOpen) {
      setTargetTier(subscription.tier);
      setTargetCadence(subscription.cadence);
    }
  }, [isOpen, subscription.tier, subscription.cadence]);

  useEffect(() => {
    if (isOpen && scheduledChange) {
      setTargetTier(scheduledChange.toTier);
      setTargetCadence(scheduledChange.toCadence);
    }
  }, [isOpen, scheduledChange]);

  const isCancelingPendingChange =
    cancelScheduledChange.isPending || isCancelingPendingChangeUntilRefetch;

  const isMutating =
    scheduleChange.isPending ||
    isCancelingPendingChange ||
    actions.isCancelingSubscription ||
    isOpeningCancelFlow;

  const isSameSelection =
    targetTier === subscription.tier && targetCadence === subscription.cadence;

  const computedEffectiveAt = useMemo(() => {
    if (scheduledChange?.effectiveAt) {
      return scheduledChange.effectiveAt;
    }

    const isCadenceChange = targetCadence !== subscription.cadence;
    if (isCadenceChange) {
      return subscription.nextBillingAt ?? null;
    }

    const currentMonthly = getMonthlyPriceUsd(subscription.tier);
    const nextMonthly = getMonthlyPriceUsd(targetTier);
    const isUptier = nextMonthly > currentMonthly;

    if (isUptier && subscription.cadence === KiloPassCadence.Yearly) {
      return subscription.nextYearlyIssueAt ?? null;
    }

    return subscription.nextBillingAt ?? null;
  }, [
    scheduledChange?.effectiveAt,
    subscription.cadence,
    subscription.nextBillingAt,
    subscription.nextYearlyIssueAt,
    subscription.tier,
    targetCadence,
    targetTier,
  ]);

  const effectiveAtLabel = computedEffectiveAt
    ? formatIsoDateString_UsaDateOnlyFormat(computedEffectiveAt)
    : null;

  const updateSummary = useMemo(() => {
    const toTierLabel = getTierName(targetTier);
    const toCadenceLabel = getCadenceLabel(targetCadence);

    if (scheduledChange && effectiveAtLabel) {
      const scheduledTierLabel = getTierName(scheduledChange.toTier);
      const scheduledCadenceLabel = getCadenceLabel(scheduledChange.toCadence);
      return {
        title: `Change scheduled → ${scheduledTierLabel} · ${scheduledCadenceLabel}`,
        body: `Your subscription will switch on ${effectiveAtLabel}. You can cancel the change anytime before then.`,
      };
    }

    const isTierChange = targetTier !== subscription.tier;
    const isCadenceChange = targetCadence !== subscription.cadence;
    const currentMonthly = getMonthlyPriceUsd(subscription.tier);
    const nextMonthly = getMonthlyPriceUsd(targetTier);
    const isUptier = nextMonthly > currentMonthly;
    const isDowntier = nextMonthly < currentMonthly;

    if (!effectiveAtLabel) {
      return isTierChange || isCadenceChange
        ? {
            title: `Switch to ${toTierLabel} · ${toCadenceLabel}`,
            body: 'Changes take effect on your next billing boundary.',
          }
        : {
            title: `Switch to ${toTierLabel} · ${toCadenceLabel}`,
            body: 'This is your current plan.',
          };
    }

    let message: string;

    if (isCadenceChange) {
      message = `Cadence changes take effect on ${effectiveAtLabel}.`;
    } else if (isDowntier) {
      message = `Downgrades take effect on ${effectiveAtLabel}.`;
    } else if (isUptier) {
      if (subscription.cadence === KiloPassCadence.Yearly) {
        message = `Upgrades take effect on ${effectiveAtLabel}, which is also when unused base credits will be issued.`;
      } else {
        message = `Upgrades take effect on ${effectiveAtLabel}.`;
      }
    } else if (isTierChange) {
      message = `Changes take effect on ${effectiveAtLabel}.`;
    } else {
      message = 'This is your current plan.';
    }

    const body =
      message === 'This is your current plan.'
        ? message
        : `${message} We’ll keep your current plan until then.`;

    return {
      title: `Switch to ${toTierLabel} · ${toCadenceLabel}`,
      body,
    };
  }, [
    subscription.cadence,
    subscription.tier,
    effectiveAtLabel,
    scheduledChange,
    targetTier,
    targetCadence,
  ]);

  const currentPriceLabel = useMemo(() => {
    const monthly = getMonthlyPriceUsd(subscription.tier);
    const amount = subscription.cadence === KiloPassCadence.Monthly ? monthly : monthly * 12;
    const cadenceLabel = subscription.cadence === KiloPassCadence.Monthly ? '/month' : '/year';
    return `$${amount}${cadenceLabel}`;
  }, [subscription.cadence, subscription.tier]);

  const newPriceLabel = useMemo(() => {
    const monthly = getMonthlyPriceUsd(targetTier);
    const amount = targetCadence === KiloPassCadence.Monthly ? monthly : monthly * 12;
    const cadenceLabel = targetCadence === KiloPassCadence.Monthly ? '/month' : '/year';
    return `$${amount}${cadenceLabel}`;
  }, [targetCadence, targetTier]);

  const handleScheduleChange = async () => {
    if (isSameSelection) return;

    try {
      const result = await scheduleChange.mutateAsync({
        targetTier,
        targetCadence,
      });
      toast(`Change scheduled for ${formatIsoDateString_UsaDateOnlyFormat(result.effectiveAt)}`);
      closeModal();
      await queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getState.queryKey() });
      await queryClient.invalidateQueries({
        queryKey: trpc.kiloPass.getScheduledChange.queryKey(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to schedule change';
      toast.error(message);
    }
  };

  const handleCancelScheduledChange = async () => {
    if (isCancelingPendingChange) return;
    setIsCancelingPendingChangeUntilRefetch(true);

    try {
      await cancelScheduledChange.mutateAsync();
      toast('Scheduled change canceled');
      await queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getState.queryKey() });
      await queryClient.invalidateQueries({
        queryKey: trpc.kiloPass.getScheduledChange.queryKey(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to cancel scheduled change';
      toast.error(message);
    } finally {
      setIsCancelingPendingChangeUntilRefetch(false);
    }
  };

  const cancelAction = view.actions.cancel;
  const resumeAction = view.actions.resume;
  const resumePausedAction = view.actions.resumePaused;

  const isUpdateSubscriptionDisabled = view.status.isPendingCancellation;

  const pendingChange = Boolean(scheduledChange);
  const showUpdatePanel = panel === 'update' && !pendingChange;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={open => {
        if (!open) {
          setPanel('update');
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-blue-400" />
            {showUpdatePanel ? 'Update Kilo Pass' : 'Manage Kilo Pass'}
          </DialogTitle>
          {showUpdatePanel ? null : (
            <DialogDescription className="text-muted-foreground">
              Update your subscription, payment method, or cancellation status.
            </DialogDescription>
          )}
        </DialogHeader>

        {showUpdatePanel ? (
          <UpdatePanel
            currentTierLabel={view.header.tierLabel}
            currentCadenceLabel={view.header.cadenceLabel}
            currentPriceLabel={currentPriceLabel}
            newPriceLabel={newPriceLabel}
            targetTier={targetTier}
            targetCadence={targetCadence}
            isMutating={isMutating}
            updateSummary={updateSummary}
            hasScheduledChange={Boolean(scheduledChange)}
            effectiveAtLabel={effectiveAtLabel}
            onSelectTier={setTargetTier}
            onSelectCadence={setTargetCadence}
          />
        ) : (
          <MainPanel
            hasScheduledChange={Boolean(scheduledChange)}
            onCancelPendingChange={handleCancelScheduledChange}
            isCancelingPendingChange={isCancelingPendingChange}
            onUpdateSubscription={() => setPanel('update')}
            isUpdateSubscriptionDisabled={isUpdateSubscriptionDisabled}
            onManagePaymentMethod={actions.openCustomerPortal}
            isOpeningCustomerPortal={actions.isOpeningCustomerPortal}
            resumeAction={resumeAction}
            resumePausedAction={resumePausedAction}
            cancelAction={cancelAction}
            onResumeSubscription={actions.resumeCancelledSubscription}
            onResumePausedSubscription={actions.resumePausedSubscription}
            onOpenCancelSubscription={openCancelFlow}
            isResumingSubscription={actions.isResumingSubscription}
            isCancelingSubscription={actions.isCancelingSubscription}
            isOpeningCancelFlow={isOpeningCancelFlow}
          />
        )}

        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          {showUpdatePanel ? (
            <UpdateFooter
              onBack={() => closeModal()}
              onCancelPendingChange={handleCancelScheduledChange}
              onScheduleChange={handleScheduleChange}
              isMutating={isMutating}
              hasPendingChange={pendingChange}
              isCancelingPendingChange={isCancelingPendingChange}
              isSchedulingChange={scheduleChange.isPending}
              isSameSelection={isSameSelection}
            />
          ) : (
            <Button variant="outline" onClick={closeModal} disabled={isMutating}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
