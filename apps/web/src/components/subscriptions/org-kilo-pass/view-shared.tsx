// React must be in scope for the classic JSX runtime used by the jest transform.
import React from 'react';
import { AlertCircle, AlertTriangle, CornerDownRight, Info, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatOrgPassMoney } from './formatters';
import type { OrgKiloPassAllocation, OrgKiloPassCondition } from './types';

export function getDirectChildTotal(allocations: OrgKiloPassAllocation[]): number {
  return allocations.reduce(
    (sum, allocation) => sum + (allocation.kind === 'child' ? allocation.passCount : 0),
    0
  );
}

export function ConditionAlert({ condition }: { condition: OrgKiloPassCondition }) {
  const isDestructive = condition.kind === 'failed' || condition.kind === 'payment_review';

  return (
    <Alert variant={isDestructive ? 'destructive' : 'warning'}>
      {isDestructive ? <AlertCircle /> : <AlertTriangle />}
      <AlertTitle>{condition.title}</AlertTitle>
      <AlertDescription>
        <p>{condition.description}</p>
        {condition.actionLabel && condition.onAction ? (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={condition.onAction}
            disabled={condition.actionBusy}
          >
            {condition.actionBusy ? (
              <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
            ) : null}
            {condition.actionLabel}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function SummaryValue({
  label,
  value,
  detail,
  icon,
  className,
}: {
  label: string;
  value: string;
  detail?: string;
  icon: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 items-start gap-3', className)}>
      <div
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-overlay text-muted-foreground [&>svg]:size-4"
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="type-label text-muted-foreground">{label}</p>
        <p className="mt-0.5 font-medium tabular-nums">{value}</p>
        {detail ? <p className="mt-0.5 type-label text-muted-foreground">{detail}</p> : null}
      </div>
    </div>
  );
}

export function InfoTooltip({ label, content }: { label: string; content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Info className="size-4" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">{content}</TooltipContent>
    </Tooltip>
  );
}

function AllocationIdentityRow({
  icon,
  name,
  detail,
  columnsClassName,
  children,
}: {
  icon?: React.ReactNode;
  name: string;
  detail?: string;
  columnsClassName: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'grid items-center gap-4 border-b border-border px-4 py-3 last:border-b-0',
        columnsClassName
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {icon}
        <span className="min-w-0">
          <span className="block truncate type-body font-medium text-foreground">{name}</span>
          {detail ? (
            <span className="block truncate type-label text-muted-foreground">{detail}</span>
          ) : null}
        </span>
      </div>
      <div className="flex items-center justify-end">{children}</div>
    </div>
  );
}

export function AllocationEditor({
  parentName,
  parentPasses,
  allocations,
  isInvalid = false,
  describedById,
  onChildAllocationChange,
}: {
  parentName: string;
  parentPasses: number;
  allocations: OrgKiloPassAllocation[];
  isInvalid?: boolean;
  describedById?: string;
  onChildAllocationChange: (organizationId: string, passCount: number) => void;
}) {
  const childAllocations = allocations.filter(allocation => allocation.kind === 'child');

  return (
    <fieldset className="min-w-0 overflow-hidden rounded-xl border border-border">
      <legend className="sr-only">Pass assignments</legend>
      <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-4 border-b border-border bg-surface-inset px-4 py-3 type-label text-muted-foreground">
        <span>Organization</span>
        <span className="text-right">Passes</span>
      </div>
      <AllocationIdentityRow name={parentName} columnsClassName="grid-cols-[minmax(0,1fr)_5.5rem]">
        <span className="flex items-center justify-end gap-1.5">
          <output
            aria-label={`${parentName} passes`}
            className="flex h-control-default w-16 items-center justify-end px-2 type-body font-medium tabular-nums"
          >
            {parentPasses}
          </output>
          <InfoTooltip
            label={`About the passes that stay with ${parentName}`}
            content={`Passes not assigned to child organizations stay with ${parentName}.`}
          />
        </span>
      </AllocationIdentityRow>
      {childAllocations.map(allocation => (
        <AllocationIdentityRow
          key={allocation.organizationId}
          icon={<CornerDownRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
          name={allocation.organizationName}
          detail="Child organization"
          columnsClassName="grid-cols-[minmax(0,1fr)_5.5rem]"
        >
          <Input
            aria-label={`${allocation.organizationName} passes`}
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={allocation.passCount}
            onChange={event => {
              const nextValue = Number(event.target.value);
              onChildAllocationChange(
                allocation.organizationId,
                Number.isInteger(nextValue) && nextValue >= 0 ? nextValue : 0
              );
            }}
            aria-invalid={isInvalid || undefined}
            aria-describedby={isInvalid ? describedById : undefined}
            className="w-16 px-2 text-right tabular-nums"
          />
        </AllocationIdentityRow>
      ))}
    </fieldset>
  );
}

export function AllocationSummary({
  parentName,
  parentPasses,
  allocations,
}: {
  parentName: string;
  parentPasses: number;
  allocations: OrgKiloPassAllocation[];
}) {
  const childAllocations = allocations.filter(allocation => allocation.kind === 'child');

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-4 border-b border-border bg-surface-inset px-4 py-3 type-label text-muted-foreground">
        <span>Organization</span>
        <span className="text-right">Passes</span>
      </div>
      <AllocationIdentityRow name={parentName} columnsClassName="grid-cols-[minmax(0,1fr)_7rem]">
        <span className="font-mono font-medium tabular-nums">{parentPasses}</span>
      </AllocationIdentityRow>
      {childAllocations.map(allocation => (
        <AllocationIdentityRow
          key={allocation.organizationId}
          icon={<CornerDownRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
          name={allocation.organizationName}
          detail="Child organization"
          columnsClassName="grid-cols-[minmax(0,1fr)_7rem]"
        >
          <span className="font-mono font-medium tabular-nums">{allocation.passCount}</span>
        </AllocationIdentityRow>
      ))}
    </div>
  );
}

export function CurrentAllocationTable({
  allocations,
  fullMonthlyCreditsPerPassUsd,
}: {
  allocations: OrgKiloPassAllocation[];
  fullMonthlyCreditsPerPassUsd: number;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="grid gap-4 border-b border-border bg-surface-inset px-4 py-3 type-label text-muted-foreground lg:grid-cols-[minmax(0,1fr)_22rem]">
        <span>Organization</span>
        <span className="hidden grid-cols-[minmax(0,1fr)_auto] gap-3 lg:grid">
          <span>Usage</span>
          <span>Bonus Credits</span>
        </span>
      </div>
      {allocations.map(allocation => {
        const hasCurrentAllocation = allocation.passCount > 0;
        const spend = allocation.qualifyingSpendUsd ?? 0;
        const unlockTarget = allocation.unlockTargetUsd ?? 0;
        const progress =
          unlockTarget > 0 ? Math.min(100, Math.round((spend / unlockTarget) * 100)) : 0;
        const state = allocation.bonusState ?? 'locked';
        const stateCopy = hasCurrentAllocation
          ? {
              locked: `${formatOrgPassMoney(spend)} of ${formatOrgPassMoney(unlockTarget)} spent`,
              unlocked: 'Bonus unlocked',
              upfront_granted: 'Bonus already added',
              expired: 'Bonus can no longer be earned',
              missed: "We're checking your bonus",
            }[state]
          : 'No passes assigned for this period';
        const isPositive = state === 'unlocked' || state === 'upfront_granted';

        return (
          <div
            key={allocation.organizationId}
            className="border-b border-border px-4 py-3 last:border-b-0"
          >
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {allocation.kind === 'child' ? (
                  <CornerDownRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : null}
                <div className="min-w-0">
                  <p className="truncate type-body font-medium">{allocation.organizationName}</p>
                  <p className="flex flex-wrap items-center gap-x-1 type-label text-muted-foreground">
                    <span>
                      {allocation.passCount} passes ·{' '}
                      {formatOrgPassMoney(allocation.baseCreditsUsd ?? 0)} monthly Credits
                    </span>
                    {allocation.hasProratedCredits ? (
                      <InfoTooltip
                        label={`About ${allocation.organizationName}'s prorated Credit amount`}
                        content={`This amount includes prorated Credits for passes added partway through the billing cycle. Prorated Credits are based on the days remaining in the current period. A full monthly period includes ${formatOrgPassMoney(fullMonthlyCreditsPerPassUsd)} in base Credits per pass.`}
                      />
                    ) : null}
                    {allocation.supplementCreditsUsd
                      ? ` + ${formatOrgPassMoney(allocation.supplementCreditsUsd)} additional Credits`
                      : ''}
                  </p>
                </div>
              </div>
              <div className="w-full lg:w-[22rem]">
                <div className="mb-2 flex items-center justify-between gap-3 type-label">
                  <span className={isPositive ? 'text-status-success' : 'text-muted-foreground'}>
                    {stateCopy}
                  </span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {formatOrgPassMoney(allocation.bonusCreditsUsd ?? 0)} bonus Credits
                  </span>
                </div>
                <Progress
                  value={hasCurrentAllocation && isPositive ? 100 : progress}
                  className="h-1.5 bg-surface-overlay"
                  indicatorClassName={isPositive ? 'bg-status-success-icon' : 'bg-primary'}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
