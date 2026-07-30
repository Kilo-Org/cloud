'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTRPC } from '@/lib/trpc/utils';
import { formatDateLabel } from '../helpers';
import { toCondition, toCurrentAllocations, toDetailPresentation } from './mappers';
import { OrgKiloPassDetailView } from './OrgKiloPassDetailView';
import { childAllocationInput } from './selection';
import type { OrgKiloPassCondition } from './types';
import { useOpenBillingPortal } from './useOpenBillingPortal';

export function OrgKiloPassDetail({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const detailQuery = useQuery(trpc.organizations.kiloPass.detail.queryOptions({ organizationId }));
  const [isEditing, setIsEditing] = useState(false);
  const [stalePlanMessage, setStalePlanMessage] = useState<string>();
  const [isRefreshingPlan, setIsRefreshingPlan] = useState(false);
  const { openBillingPortal, isOpeningPortal } = useOpenBillingPortal(organizationId);
  const hasReconciledPayment = useRef(false);
  const [draftAllocations, setDraftAllocations] = useState<ReturnType<
    typeof getAllocations
  > | null>(null);

  const invalidateKiloPass = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.organizations.kiloPass.pathKey() });
  };

  const updateAllocation = useMutation(
    trpc.organizations.kiloPass.updateAllocation.mutationOptions({
      onSuccess: async () => {
        setIsEditing(false);
        setDraftAllocations(null);
        setStalePlanMessage(undefined);
        await invalidateKiloPass();
      },
      onError: error => {
        if (error.data?.code === 'CONFLICT') setStalePlanMessage(error.message);
        else toast.error(error.message || 'Could not save pass assignments.');
      },
    })
  );
  const cancel = useMutation(
    trpc.organizations.kiloPass.cancel.mutationOptions({
      onSuccess: async () => {
        toast.success('Kilo Pass will cancel at the end of the paid period.');
        await invalidateKiloPass();
      },
      onError: error => toast.error(error.message || 'Could not schedule cancellation.'),
    })
  );
  const resume = useMutation(
    trpc.organizations.kiloPass.resume.mutationOptions({
      onSuccess: async () => {
        toast.success('Kilo Pass subscription resumed.');
        await invalidateKiloPass();
      },
      onError: error => toast.error(error.message || 'Could not resume the subscription.'),
    })
  );
  const retryRun = useMutation(
    trpc.organizations.kiloPass.retryRun.mutationOptions({
      onSuccess: async () => {
        toast.success('Credit run queued for retry.');
        await invalidateKiloPass();
      },
      onError: error => toast.error(error.message || 'Could not retry the Credit run.'),
    })
  );
  const reconcilePayment = useMutation(
    trpc.organizations.kiloPass.reconcilePayment.mutationOptions({
      onSuccess: async result => {
        if (result.activated) await invalidateKiloPass();
      },
    })
  );
  const reconcilePendingPayment = reconcilePayment.mutate;

  useEffect(() => {
    if (detailQuery.data?.commercialState !== 'pending_payment' || hasReconciledPayment.current)
      return;
    hasReconciledPayment.current = true;
    reconcilePendingPayment({ organizationId });
  }, [detailQuery.data?.commercialState, organizationId, reconcilePendingPayment]);

  if (detailQuery.isError) {
    return (
      <div className="space-y-3 p-6">
        <p className="type-body">Kilo Pass details could not be loaded.</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void detailQuery.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (detailQuery.isPending) {
    return (
      <p className="p-6 type-body text-muted-foreground" aria-busy="true">
        Loading Kilo Pass…
      </p>
    );
  }

  const detail = detailQuery.data;
  const presentation = toDetailPresentation(detail);
  const nextAllocations = getAllocations(detail.nextAllocations);
  const editingAllocations = draftAllocations ?? nextAllocations;
  const latestRun = detail.latestRun;

  const onEditDistribution = () => {
    setDraftAllocations(getAllocations(detail.nextAllocations));
    setStalePlanMessage(undefined);
    setIsEditing(true);
  };
  const onCancelDistribution = () => {
    setDraftAllocations(null);
    setStalePlanMessage(undefined);
    setIsEditing(false);
  };
  const onRefreshPlan = () => {
    if (isRefreshingPlan) return;
    setIsRefreshingPlan(true);
    void (async () => {
      try {
        const fresh = await detailQuery.refetch();
        if (fresh.data) {
          setDraftAllocations(getAllocations(fresh.data.nextAllocations));
          setStalePlanMessage(undefined);
        } else {
          toast.error('Could not refresh pass assignments. Try again.');
        }
      } finally {
        setIsRefreshingPlan(false);
      }
    })();
  };
  const onResetDistribution = () => {
    const currentChildPasses = new Map(
      detail.currentAllocations
        .filter(allocation => allocation.kind === 'child')
        .map(allocation => [allocation.organizationId, allocation.passCount])
    );
    const resetAllocations = getAllocations(detail.nextAllocations).map(allocation =>
      allocation.kind === 'child'
        ? { ...allocation, passCount: currentChildPasses.get(allocation.organizationId) ?? 0 }
        : allocation
    );
    updateAllocation.mutate({
      organizationId,
      expectedPlanVersion: detail.planVersion,
      allocations: childAllocationInput(resetAllocations),
    });
  };
  const canRetryLatestRun =
    latestRun !== null && (latestRun.state === 'failed' || latestRun.state === 'blocked');
  const onRetryLatestRun = canRetryLatestRun
    ? () => retryRun.mutate({ organizationId, runId: latestRun.id })
    : undefined;

  const baseCondition = toCondition(detail.processingCondition);
  const condition: OrgKiloPassCondition | undefined = baseCondition
    ? withConditionAction(baseCondition, {
        onEditDistribution,
        onRetryLatestRun,
        isRetryingRun: retryRun.isPending,
        openBillingPortal,
        isOpeningPortal,
      })
    : undefined;

  return (
    <OrgKiloPassDetailView
      organizationId={organizationId}
      organizationName={organizationName}
      commercialState={detail.commercialState}
      condition={condition}
      terms={presentation.terms}
      totalPasses={detail.paidSeatCount}
      upcomingTotalPasses={detail.nextPaidSeatCount}
      cadence={presentation.cadence}
      paidThrough={formatDateLabel(detail.paidThrough, '—')}
      currentWindow={
        detail.currentWindow
          ? `${formatDateLabel(detail.currentWindow.startsAt)} – ${formatDateLabel(detail.currentWindow.endsAt)}`
          : 'No current Credit period'
      }
      currentAllocations={toCurrentAllocations(detail.currentAllocations)}
      nextWindowStarts={formatDateLabel(detail.nextWindowStartsAt, 'Not scheduled')}
      nextAllocations={nextAllocations}
      editingAllocations={editingAllocations}
      cancellationEffectiveAt={
        detail.commercialState === 'cancel_at_period_end'
          ? formatDateLabel(detail.paidThrough)
          : undefined
      }
      restartHref={`/organizations/${organizationId}/subscriptions/kilo-pass/setup`}
      isEditing={isEditing}
      stalePlanMessage={stalePlanMessage}
      onEditDistribution={onEditDistribution}
      onCancelDistribution={onCancelDistribution}
      onResetDistribution={onResetDistribution}
      onChildAllocationChange={(childOrganizationId, passCount) =>
        setDraftAllocations(current =>
          (current ?? getAllocations(detail.nextAllocations)).map(allocation =>
            allocation.organizationId === childOrganizationId
              ? { ...allocation, passCount }
              : allocation
          )
        )
      }
      onSaveDistribution={() =>
        updateAllocation.mutate({
          organizationId,
          expectedPlanVersion: detail.planVersion,
          allocations: childAllocationInput(editingAllocations),
        })
      }
      onRefreshPlan={onRefreshPlan}
      onCancelSubscription={() => cancel.mutate({ organizationId })}
      onResumeSubscription={() => resume.mutate({ organizationId })}
      pendingAction={
        updateAllocation.isPending
          ? isEditing
            ? 'save'
            : 'reset'
          : isRefreshingPlan
            ? 'refresh'
            : cancel.isPending
              ? 'cancel'
              : resume.isPending
                ? 'resume'
                : null
      }
    />
  );
}

function withConditionAction(
  condition: OrgKiloPassCondition,
  actions: {
    onEditDistribution: () => void;
    onRetryLatestRun?: () => void;
    isRetryingRun: boolean;
    openBillingPortal: () => void;
    isOpeningPortal: boolean;
  }
): OrgKiloPassCondition {
  if (condition.kind === 'overallocated' || condition.kind === 'blocked') {
    return {
      ...condition,
      actionLabel: 'Review pass assignments',
      onAction: actions.onEditDistribution,
    };
  }
  if (condition.kind === 'failed' && actions.onRetryLatestRun) {
    return {
      ...condition,
      actionLabel: 'Retry now',
      onAction: actions.onRetryLatestRun,
      actionBusy: actions.isRetryingRun,
    };
  }
  if (condition.kind === 'payment_review') {
    return {
      ...condition,
      actionLabel: 'View billing',
      onAction: actions.openBillingPortal,
      actionBusy: actions.isOpeningPortal,
    };
  }
  return condition;
}

function getAllocations(
  allocations: Parameters<typeof OrgKiloPassDetailView>[0]['nextAllocations']
) {
  return allocations.map(allocation => ({ ...allocation }));
}
