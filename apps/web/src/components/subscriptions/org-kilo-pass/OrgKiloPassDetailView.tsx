// React must be in scope for the classic JSX runtime used by the jest transform.
import React from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  CalendarDays,
  Check,
  Loader2,
  RefreshCw,
  RotateCcw,
  Users,
} from 'lucide-react';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DetailPageHeader } from '@/components/subscriptions/DetailPageHeader';
import { KiloPassIcon } from '@/components/icons/KiloPassIcon';
import { isPassAssignmentSaveDisabled } from './allocation-dialog-state';
import { formatOrgPassMoney } from './formatters';
import type {
  OrgKiloPassAllocation,
  OrgKiloPassCadence,
  OrgKiloPassCommercialState,
  OrgKiloPassCondition,
  OrgKiloPassTerms,
} from './types';
import {
  AllocationEditor,
  AllocationSummary,
  ConditionAlert,
  CurrentAllocationTable,
  getDirectChildTotal,
  SummaryValue,
} from './view-shared';

type OrgKiloPassPendingAction = 'save' | 'reset' | 'refresh' | 'cancel' | 'resume' | null;

function haveAssignmentChanges(
  currentAllocations: OrgKiloPassAllocation[],
  nextAllocations: OrgKiloPassAllocation[],
  totalPasses: number
): boolean {
  const currentPasses = new Map(
    currentAllocations.map(allocation => [allocation.organizationId, allocation.passCount])
  );
  const nextPasses = new Map(
    nextAllocations
      .filter(allocation => allocation.kind === 'child')
      .map(allocation => [allocation.organizationId, allocation.passCount])
  );
  const parentId =
    currentAllocations.find(allocation => allocation.kind === 'parent')?.organizationId ??
    nextAllocations.find(allocation => allocation.kind === 'parent')?.organizationId;
  if (parentId)
    nextPasses.set(parentId, Math.max(0, totalPasses - getDirectChildTotal(nextAllocations)));

  const organizationIds = new Set([...currentPasses.keys(), ...nextPasses.keys()]);
  return [...organizationIds].some(
    organizationId =>
      (currentPasses.get(organizationId) ?? 0) !== (nextPasses.get(organizationId) ?? 0)
  );
}

export function OrgKiloPassDetailView({
  organizationId,
  organizationName,
  commercialState,
  condition,
  terms,
  totalPasses,
  upcomingTotalPasses,
  cadence,
  paidThrough,
  currentWindow,
  currentAllocations,
  nextWindowStarts,
  nextAllocations,
  editingAllocations,
  cancellationEffectiveAt,
  restartHref,
  isEditing = false,
  stalePlanMessage,
  onChildAllocationChange,
  onSaveDistribution,
  onEditDistribution,
  onCancelDistribution,
  onResetDistribution,
  onRefreshPlan,
  onCancelSubscription,
  onResumeSubscription,
  pendingAction = null,
}: {
  organizationId: string;
  organizationName: string;
  commercialState: OrgKiloPassCommercialState;
  condition?: OrgKiloPassCondition;
  terms: OrgKiloPassTerms;
  totalPasses: number;
  upcomingTotalPasses?: number;
  cadence: OrgKiloPassCadence;
  paidThrough: string;
  currentWindow: string;
  currentAllocations: OrgKiloPassAllocation[];
  nextWindowStarts: string;
  nextAllocations: OrgKiloPassAllocation[];
  editingAllocations?: OrgKiloPassAllocation[];
  cancellationEffectiveAt?: string;
  restartHref?: string;
  isEditing?: boolean;
  stalePlanMessage?: string;
  onChildAllocationChange?: (organizationId: string, passCount: number) => void;
  onSaveDistribution?: () => void;
  onEditDistribution?: () => void;
  onCancelDistribution?: () => void;
  onResetDistribution?: () => void;
  onRefreshPlan?: () => void;
  onCancelSubscription?: () => void;
  onResumeSubscription?: () => void;
  /** The mutation currently in flight, if any; drives pending labels and disabled states. */
  pendingAction?: OrgKiloPassPendingAction;
}) {
  const [cancelDialogOpen, setCancelDialogOpen] = React.useState(false);
  const nextTotalPasses = upcomingTotalPasses ?? totalPasses;
  const directChildTotal = getDirectChildTotal(nextAllocations);
  const parentPasses = Math.max(0, nextTotalPasses - directChildTotal);
  const hasCurrentIssuance = commercialState !== 'pending_payment';
  const hasFutureDistribution = commercialState !== 'ended';
  const hasChildOrganizations = nextAllocations.some(allocation => allocation.kind === 'child');
  const hasUpcomingAssignmentChanges =
    hasCurrentIssuance &&
    hasFutureDistribution &&
    haveAssignmentChanges(currentAllocations, nextAllocations, nextTotalPasses);
  const dialogAllocations = editingAllocations ?? nextAllocations;
  const dialogChildTotal = getDirectChildTotal(dialogAllocations);
  const dialogParentPasses = Math.max(0, nextTotalPasses - dialogChildTotal);
  const dialogReductionRequired = Math.max(0, dialogChildTotal - nextTotalPasses);
  const isDialogOverallocated = dialogReductionRequired > 0;

  return (
    <div className="space-y-6">
      <DetailPageHeader
        backHref={`/organizations/${organizationId}/subscriptions`}
        backLabel="Back to subscriptions"
        title="Kilo Pass for Organizations"
        status={commercialState}
        icon={<KiloPassIcon className="size-5" />}
        actions={
          onCancelSubscription && commercialState === 'active' ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setCancelDialogOpen(true)}
              disabled={pendingAction === 'cancel'}
            >
              Cancel subscription
            </Button>
          ) : onResumeSubscription && commercialState === 'cancel_at_period_end' ? (
            <Button
              type="button"
              onClick={onResumeSubscription}
              disabled={pendingAction === 'resume'}
            >
              {pendingAction === 'resume' ? (
                <>
                  <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
                  Resuming subscription
                </>
              ) : (
                'Resume subscription'
              )}
            </Button>
          ) : undefined
        }
      />

      {condition ? <ConditionAlert condition={condition} /> : null}
      {cancellationEffectiveAt ? (
        <Alert variant="warning">
          <CalendarDays />
          <AlertTitle>Cancellation scheduled</AlertTitle>
          <AlertDescription>
            Kilo Pass for Organizations stays active through {cancellationEffectiveAt}. Monthly
            Credits continue until then, and Credits already added remain available.
          </AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent className="grid gap-6 p-6 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryValue
            label="Tier"
            value={terms.tierName}
            detail={`${formatOrgPassMoney(terms.baseCreditsPerPassUsd)} monthly Credits per pass`}
            icon={<KiloPassIcon />}
          />
          <SummaryValue label="Paid seats covered" value={String(totalPasses)} icon={<Users />} />
          <SummaryValue
            label="Billing schedule"
            value={cadence === 'annual' ? 'Annual' : 'Monthly'}
            detail="Billed with seats"
            icon={<CalendarDays />}
          />
          <SummaryValue label="Covered through" value={paidThrough} icon={<Check />} />
        </CardContent>
      </Card>

      {hasCurrentIssuance ? (
        <Card>
          <CardHeader className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Current Kilo Pass assignments</CardTitle>
              <p className="mt-1 type-body text-muted-foreground">{currentWindow}</p>
            </div>
            {hasFutureDistribution && hasChildOrganizations && onEditDistribution ? (
              <Button type="button" variant="outline" onClick={onEditDistribution}>
                Modify pass assignments
              </Button>
            ) : null}
          </CardHeader>
          <CardContent>
            <CurrentAllocationTable
              allocations={currentAllocations}
              fullMonthlyCreditsPerPassUsd={terms.baseCreditsPerPassUsd}
            />
            <p className="mt-4 type-label text-muted-foreground">
              Credits already added for this monthly period stay with the organizations that
              received them.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle>Payment pending</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="type-body text-muted-foreground">
              Kilo will add your first Credits after payment is confirmed.
            </p>
          </CardContent>
        </Card>
      )}

      {hasUpcomingAssignmentChanges ? (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle>Upcoming Kilo Pass assignments</CardTitle>
            <p className="mt-1 type-body text-muted-foreground">Starts: {nextWindowStarts}</p>
          </CardHeader>
          <CardContent className="space-y-5">
            <AllocationSummary
              parentName={organizationName}
              parentPasses={parentPasses}
              allocations={nextAllocations}
            />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="type-label text-muted-foreground">
                Changes apply at the next renewal. Current Credits and usage stay the same.
              </p>
              {onResetDistribution ? (
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={onResetDistribution}
                  disabled={pendingAction === 'reset'}
                >
                  {pendingAction === 'reset' ? (
                    <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
                  ) : (
                    <RotateCcw className="size-4" aria-hidden />
                  )}
                  {pendingAction === 'reset' ? 'Resetting assignments' : 'Reset pass assignments'}
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <PassAssignmentDialog
        open={isEditing}
        organizationName={organizationName}
        parentPasses={dialogParentPasses}
        totalPasses={nextTotalPasses}
        allocations={dialogAllocations}
        reductionRequired={dialogReductionRequired}
        isOverallocated={isDialogOverallocated}
        stalePlanMessage={stalePlanMessage}
        pendingAction={pendingAction}
        onChildAllocationChange={onChildAllocationChange}
        onSave={onSaveDistribution}
        onCancel={onCancelDistribution}
        onRefresh={onRefreshPlan}
      />

      <AlertDialog
        open={cancelDialogOpen && commercialState === 'active'}
        onOpenChange={open => {
          if (pendingAction !== 'cancel') setCancelDialogOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Kilo Pass for Organizations?</AlertDialogTitle>
            <AlertDialogDescription>
              Kilo Pass remains active through {paidThrough}. Monthly Credits continue until then,
              and Credits already added remain available. Billing stops after that date.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingAction === 'cancel'}>
              Keep subscription
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={onCancelSubscription}
              disabled={pendingAction === 'cancel'}
              aria-busy={pendingAction === 'cancel'}
            >
              {pendingAction === 'cancel' ? 'Scheduling cancellation' : 'Cancel subscription'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {commercialState === 'ended' && restartHref ? (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle>Kilo Pass for Organizations has ended</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="type-body text-muted-foreground">
              No new monthly Credits are scheduled. Credits already added remain available. Add Kilo
              Pass again to restart monthly Credits for your paid seats.
            </p>
            <Button asChild className="shrink-0">
              <Link href={restartHref}>
                Add Kilo Pass again
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function PassAssignmentDialog({
  open,
  organizationName,
  parentPasses,
  totalPasses,
  allocations,
  reductionRequired,
  isOverallocated,
  stalePlanMessage,
  pendingAction,
  onChildAllocationChange,
  onSave,
  onCancel,
  onRefresh,
}: {
  open: boolean;
  organizationName: string;
  parentPasses: number;
  totalPasses: number;
  allocations: OrgKiloPassAllocation[];
  reductionRequired: number;
  isOverallocated: boolean;
  stalePlanMessage?: string;
  pendingAction: OrgKiloPassPendingAction;
  onChildAllocationChange?: (organizationId: string, passCount: number) => void;
  onSave?: () => void;
  onCancel?: () => void;
  onRefresh?: () => void;
}) {
  const isBusy = pendingAction === 'save' || pendingAction === 'refresh';
  const titleRef = React.useRef<HTMLHeadingElement>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen && !isBusy) onCancel?.();
      }}
    >
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl"
        onOpenAutoFocus={event => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
            Modify pass assignments
          </DialogTitle>
          <DialogDescription>
            Redistribute passes between the parent and its child organizations.
          </DialogDescription>
        </DialogHeader>

        {onChildAllocationChange ? (
          <AllocationEditor
            parentName={organizationName}
            parentPasses={parentPasses}
            allocations={allocations}
            isInvalid={isOverallocated}
            describedById="next-allocation-validation"
            onChildAllocationChange={onChildAllocationChange}
          />
        ) : null}

        {isOverallocated ? (
          <p id="next-allocation-validation" className="type-body text-status-destructive">
            Remove {reductionRequired} passes from child organizations to fit the {totalPasses}{' '}
            available passes.
          </p>
        ) : null}

        {stalePlanMessage ? (
          <Alert variant="destructive">
            <RefreshCw />
            <AlertTitle>Pass assignments were changed elsewhere</AlertTitle>
            <AlertDescription>
              <p>{stalePlanMessage}</p>
              {onRefresh ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={onRefresh}
                  disabled={pendingAction === 'refresh'}
                >
                  {pendingAction === 'refresh' ? (
                    <>
                      <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
                      Refreshing assignments
                    </>
                  ) : (
                    'Refresh latest assignments'
                  )}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <p className="type-label text-muted-foreground">
          Changes apply at the next renewal. Current Credits and usage stay the same.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={isBusy}>
            Keep current assignments
          </Button>
          {onSave ? (
            <Button
              type="button"
              onClick={onSave}
              disabled={isPassAssignmentSaveDisabled({
                reductionRequired,
                stalePlanMessage,
                isBusy,
              })}
            >
              {pendingAction === 'save' ? 'Saving assignments' : 'Save pass assignments'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
