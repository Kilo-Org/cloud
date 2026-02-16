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
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { FeedbackFor, FeedbackSource } from '@/lib/feedback/enums';

import { getTierName } from './utils';
import { CancelKiloPassSubscriptionModal } from './CancelKiloPassSubscriptionModal';
import { KiloPassCancellationFeedbackModal } from './KiloPassCancellationFeedbackModal';
import { useKiloPassSubscriptionInfo } from './useKiloPassSubscriptionInfo';
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
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();

  const scheduledChangeQuery = useQuery({
    ...trpc.kiloPass.getScheduledChange.queryOptions(),
    enabled: isOpen,
  });

  const scheduleChange = useMutation(trpc.kiloPass.scheduleChange.mutationOptions());
  const cancelScheduledChange = useMutation(trpc.kiloPass.cancelScheduledChange.mutationOptions());

  const [panel, setPanel] = useState<'main' | 'update'>('main');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancellationFeedbackOpen, setCancellationFeedbackOpen] = useState(false);
  const [selectedCancellationReasons, setSelectedCancellationReasons] = useState<string[]>([]);
  const [cancellationFreeformText, setCancellationFreeformText] = useState('');
  const [isCancelingSubscriptionWithFeedback, setIsCancelingSubscriptionWithFeedback] =
    useState(false);
  const [isCancelingPendingChangeUntilRefetch, setIsCancelingPendingChangeUntilRefetch] =
    useState(false);

  const scheduledChange = scheduledChangeQuery.data?.scheduledChange ?? null;

  const [targetTier, setTargetTier] = useState<KiloPassTier>(subscription.tier);
  const [targetCadence, setTargetCadence] = useState<KiloPassCadence>(subscription.cadence);

  useEffect(() => {
    if (isOpen && scheduledChange) {
      setTargetTier(scheduledChange.toTier);
      setTargetCadence(scheduledChange.toCadence);
      return;
    }

    if (isOpen) {
      setTargetTier(subscription.tier);
      setTargetCadence(subscription.cadence);
    }
  }, [
    isOpen,
    scheduledChange?.status,
    scheduledChange?.toTier,
    scheduledChange?.toCadence,
    subscription.tier,
    subscription.cadence,
  ]);

  const isCancelingPendingChange =
    cancelScheduledChange.isPending || isCancelingPendingChangeUntilRefetch;

  const isMutating =
    scheduleChange.isPending ||
    isCancelingPendingChange ||
    actions.isCancelingSubscription ||
    isCancelingSubscriptionWithFeedback;

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

    let message;

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
      await queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getState.queryKey() });
      await queryClient.invalidateQueries({
        queryKey: trpc.kiloPass.getScheduledChange.queryKey(),
      });
      setPanel('main');
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

  const isUpdateSubscriptionDisabled = view.status.isPendingCancellation;

  const pendingChange = Boolean(scheduledChange);
  const showUpdatePanel = panel === 'update';

  const cancellationReasons = useMemo(() => {
    const reasons = [
      'Too expensive',
      'Not using it enough',
      'Missing features',
      'Bugs / reliability issues',
      'Performance issues',
      'Using another tool',
    ];
    // Fisher-Yates shuffle
    for (let i = reasons.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [reasons[i], reasons[j]] = [reasons[j], reasons[i]];
    }
    return [...reasons, 'Other'];
  }, [isOpen]);

  const toggleCancellationReason = (reason: string) => {
    setSelectedCancellationReasons(current =>
      current.includes(reason) ? current.filter(r => r !== reason) : [...current, reason]
    );
  };

  const buildFeedbackText = (params: { selectedReasons: string[]; freeformText: string }) => {
    const lines: string[] = [];
    if (params.selectedReasons.length > 0) {
      lines.push('Reasons:');
      for (const r of params.selectedReasons) lines.push(r);
    }
    const trimmed = params.freeformText.trim();
    if (trimmed.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Feedback:');
      lines.push(trimmed);
    }
    return lines.join('\n');
  };

  const cancelSubscriptionWithFeedback = () => {
    if (isCancelingSubscriptionWithFeedback) return;
    setIsCancelingSubscriptionWithFeedback(true);

    const selectedReasons = selectedCancellationReasons;
    const freeformText = cancellationFreeformText;
    const hasReasons = selectedReasons.length > 0;
    const hasFreeform = freeformText.trim().length > 0;
    const shouldSubmitFeedback = hasReasons || hasFreeform;

    const feedback_text = buildFeedbackText({ selectedReasons, freeformText });

    const context_json = {
      subscription,
      ui: {
        selectedReasons,
        freeformText,
      },
    };

    const cancelPromise = trpcClient.kiloPass.cancelSubscription.mutate();
    const feedbackPromise = shouldSubmitFeedback
      ? trpcClient.userFeedback.create
          .mutate({
            feedback_text,
            feedback_for: FeedbackFor.KiloPass,
            feedback_batch: 'kilo_pass_cancellation_web',
            source: FeedbackSource.Web,
            context_json,
          })
          // Non-blocking: feedback errors should never interfere with cancellation.
          .catch(() => {})
      : Promise.resolve();

    void cancelPromise
      .then(async () => {
        toast('Cancellation scheduled');
        void queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getState.queryKey() });
        await queryClient.invalidateQueries({
          queryKey: trpc.kiloPass.getScheduledChange.queryKey(),
        });

        setCancellationFeedbackOpen(false);
        setSelectedCancellationReasons([]);
        setCancellationFreeformText('');
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : 'Failed to cancel subscription';
        toast.error(message);
      })
      .finally(() => {
        // Make sure we re-enable the modal button even if invalidations fail.
        setIsCancelingSubscriptionWithFeedback(false);
      });

    // Fire and forget, but keep it tied to this invocation.
    void feedbackPromise;
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={open => {
        if (!open) {
          setPanel('main');
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-blue-400" />
            Manage Kilo Pass
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
            cancelAction={cancelAction}
            onResumeSubscription={actions.resumeSubscription}
            onOpenCancelSubscription={() => setCancelOpen(true)}
            isResumingSubscription={actions.isResumingSubscription}
            isCancelingSubscription={actions.isCancelingSubscription}
          />
        )}

        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          {showUpdatePanel ? (
            <UpdateFooter
              onBack={() => setPanel('main')}
              onCancelPendingChange={handleCancelScheduledChange}
              onScheduleChange={handleScheduleChange}
              isMutating={isMutating}
              hasPendingChange={pendingChange}
              isCancelingPendingChange={isCancelingPendingChange}
              isSchedulingChange={scheduleChange.isPending}
              isSameSelection={isSameSelection}
            />
          ) : (
            <Button variant="outline" onClick={onClose} disabled={isMutating}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      <CancelKiloPassSubscriptionModal
        isOpen={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => {
          setCancelOpen(false);
          setCancellationFeedbackOpen(true);
        }}
        isLoading={actions.isCancelingSubscription}
        cadence={subscription.cadence}
        tier={subscription.tier}
        currentStreakMonths={subscription.currentStreakMonths}
        subscriptionActiveUntilLabel={view.dates.nextBillingDateLabel}
      />

      <KiloPassCancellationFeedbackModal
        isOpen={cancellationFeedbackOpen}
        onClose={() => setCancellationFeedbackOpen(false)}
        isCanceling={actions.isCancelingSubscription || isCancelingSubscriptionWithFeedback}
        reasons={cancellationReasons}
        selectedReasons={selectedCancellationReasons}
        onToggleReason={toggleCancellationReason}
        freeformText={cancellationFreeformText}
        onChangeFreeformText={setCancellationFreeformText}
        onKeepSubscription={() => {
          setCancellationFeedbackOpen(false);
          setSelectedCancellationReasons([]);
          setCancellationFreeformText('');
        }}
        onCancelSubscription={cancelSubscriptionWithFeedback}
      />
    </Dialog>
  );
}
