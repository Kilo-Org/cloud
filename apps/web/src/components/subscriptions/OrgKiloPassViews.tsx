'use client';

import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  Coins,
  FileClock,
  GitBranch,
  History,
  Loader2,
  LockKeyhole,
  Play,
  ReceiptText,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Label } from '@/components/ui/label';
import { PageLayout } from '@/components/PageLayout';
import { AvailableProductCard } from '@/components/subscriptions/AvailableProductCard';
import { DetailPageHeader } from '@/components/subscriptions/DetailPageHeader';
import { SubscriptionCard } from '@/components/subscriptions/SubscriptionCard';
import { SubscriptionGroup } from '@/components/subscriptions/SubscriptionGroup';
import { SubscriptionStatusBadge } from '@/components/subscriptions/SubscriptionStatusBadge';
import { cn } from '@/lib/utils';

export type OrgKiloPassTier = 'tier_19' | 'tier_49' | 'tier_199';
export type OrgKiloPassCadence = 'monthly' | 'annual';
export type OrgKiloPassCommercialState =
  | 'pending_payment'
  | 'active'
  | 'cancel_at_period_end'
  | 'ended';
export type OrgKiloPassBonusState =
  | 'locked'
  | 'unlocked'
  | 'upfront_granted'
  | 'expired'
  | 'missed';

export type OrgKiloPassTerms = {
  tier: OrgKiloPassTier;
  tierName: string;
  pricePerPassUsd: number;
  baseCreditsPerPassUsd: number;
  bonusCreditsPerPassUsd: number;
  unlockSpendPerPassUsd: number;
  bonusMode: 'after_base' | 'upfront';
  isCustom?: boolean;
};

export type OrgKiloPassAllocation = {
  organizationId: string;
  organizationName: string;
  kind: 'parent' | 'child';
  passCount: number;
  baseCreditsUsd?: number;
  supplementCreditsUsd?: number;
  qualifyingSpendUsd?: number;
  unlockTargetUsd?: number;
  bonusCreditsUsd?: number;
  bonusState?: OrgKiloPassBonusState;
};

export type OrgKiloPassCondition = {
  kind: 'manual' | 'blocked' | 'overallocated' | 'failed' | 'payment_review';
  title: string;
  description: string;
  actionLabel?: string;
};

export type OrgKiloPassInvoice = {
  id: string;
  date: string;
  description: string;
  amount: string;
  status: 'Paid' | 'Open' | 'Refunded';
};

const STANDARD_TERMS: Record<OrgKiloPassTier, OrgKiloPassTerms> = {
  tier_19: {
    tier: 'tier_19',
    tierName: 'Starter',
    pricePerPassUsd: 19,
    baseCreditsPerPassUsd: 19,
    bonusCreditsPerPassUsd: 4,
    unlockSpendPerPassUsd: 19,
    bonusMode: 'after_base',
  },
  tier_49: {
    tier: 'tier_49',
    tierName: 'Pro',
    pricePerPassUsd: 49,
    baseCreditsPerPassUsd: 49,
    bonusCreditsPerPassUsd: 12,
    unlockSpendPerPassUsd: 49,
    bonusMode: 'after_base',
  },
  tier_199: {
    tier: 'tier_199',
    tierName: 'Expert',
    pricePerPassUsd: 199,
    baseCreditsPerPassUsd: 199,
    bonusCreditsPerPassUsd: 50,
    unlockSpendPerPassUsd: 199,
    bonusMode: 'after_base',
  },
};

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function getDirectChildTotal(allocations: OrgKiloPassAllocation[]): number {
  return allocations.reduce(
    (sum, allocation) => sum + (allocation.kind === 'child' ? allocation.passCount : 0),
    0
  );
}

function statusLabel(status: OrgKiloPassCommercialState): string {
  switch (status) {
    case 'pending_payment':
      return 'Awaiting payment';
    case 'cancel_at_period_end':
      return 'Cancellation scheduled';
    case 'ended':
      return 'Ended';
    case 'active':
      return 'Active';
  }
}

function billingDateLabel(status: OrgKiloPassCommercialState): string {
  switch (status) {
    case 'active':
      return 'Covered through';
    case 'pending_payment':
      return 'Payment';
    case 'cancel_at_period_end':
      return 'Ends';
    case 'ended':
      return 'Ended';
  }
}

function conditionVariant(condition: OrgKiloPassCondition) {
  return condition.kind === 'failed' || condition.kind === 'payment_review'
    ? ('destructive' as const)
    : ('warning' as const);
}

export function OrgKiloPassSubscriptionCenterView({
  organizationId,
  organizationName,
  seatsUsed,
  paidSeats,
  seatPrice,
  renewalDate,
  agreement,
  eligibilityMessage,
}: {
  organizationId: string;
  organizationName: string;
  seatsUsed: number;
  paidSeats: number;
  seatPrice: string;
  renewalDate: string;
  agreement?: {
    status: OrgKiloPassCommercialState;
    tierName: string;
    price: string;
    paidThrough: string;
    condition?: OrgKiloPassCondition;
  };
  eligibilityMessage?: string;
}) {
  return (
    <PageLayout title="Subscriptions" subtitle={`Manage subscriptions for ${organizationName}.`}>
      <SubscriptionGroup
        title="Teams / Enterprise Seats"
        description="Manage your seat subscription and optional add-ons."
        headerIcon={<Users className="size-5" />}
      >
        <div className="space-y-6">
          <SubscriptionCard
            icon={<Users className="size-5" />}
            title="Teams / Enterprise Seats"
            subtitle={`${seatsUsed} of ${paidSeats} seats in use`}
            status="active"
            price={seatPrice}
            billingDate={renewalDate}
            paymentMethod="Stripe"
            href={`/organizations/${organizationId}/subscriptions/seats`}
          />

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Coins className="text-muted-foreground size-4" aria-hidden />
              <p className="text-muted-foreground text-sm font-medium">
                {agreement || eligibilityMessage ? 'Add-on' : 'Available add-on'}
              </p>
            </div>
            {eligibilityMessage ? (
              <Alert>
                <LockKeyhole />
                <AlertTitle>Switch organizations to manage Kilo Pass for Organizations</AlertTitle>
                <AlertDescription>{eligibilityMessage}</AlertDescription>
              </Alert>
            ) : agreement ? (
              <div className="space-y-3">
                {agreement.condition ? <ConditionAlert condition={agreement.condition} /> : null}
                <SubscriptionCard
                  icon={<Coins className="size-5" />}
                  title="Kilo Pass for Organizations"
                  subtitle={`${agreement.tierName} add-on · ${paidSeats} paid seats covered`}
                  status={agreement.status}
                  price={agreement.price}
                  billingDate={agreement.paidThrough}
                  billingDateLabel={billingDateLabel(agreement.status)}
                  paymentMethod="Stripe"
                  href={`/organizations/${organizationId}/subscriptions/kilo-pass`}
                  isTerminal={agreement.status === 'ended'}
                  warningTone={
                    agreement.status === 'pending_payment' ||
                    agreement.status === 'cancel_at_period_end' ||
                    agreement.condition
                      ? 'warning'
                      : undefined
                  }
                />
              </div>
            ) : (
              <AvailableProductCard
                icon={<Coins className="size-4" />}
                title="Kilo Pass for Organizations"
                price={{
                  qualifier: 'From',
                  amount: '$19',
                  cadenceLabel: 'per paid seat/month, billed with seats',
                }}
                status="Available"
                features={[
                  `Get monthly Credits for all ${paidSeats} paid seats`,
                  'Choose the monthly Credit amount that fits your usage',
                  'Unlock bonus Credits as your organization uses Kilo',
                  'See seat and Kilo Pass charges on one invoice',
                ]}
                cta={{
                  label: 'Add Kilo Pass',
                  href: `/organizations/${organizationId}/subscriptions/kilo-pass/setup`,
                }}
              />
            )}
          </div>
        </div>
      </SubscriptionGroup>
    </PageLayout>
  );
}

export function OrgKiloPassSetupView({
  organizationId,
  organizationName,
  paidSeats,
  cadence,
  renewalDate,
  selectedTier,
  terms = Object.values(STANDARD_TERMS),
  allocations,
  quote,
  validationMessage,
  onTierChange,
  onChildAllocationChange,
  onReviewPurchase,
}: {
  organizationId: string;
  organizationName: string;
  paidSeats: number;
  cadence: OrgKiloPassCadence;
  renewalDate: string;
  selectedTier: OrgKiloPassTier;
  terms?: OrgKiloPassTerms[];
  allocations: OrgKiloPassAllocation[];
  quote: {
    recurringTotal: string;
    firstCharge: string;
    firstServiceInterval: string;
    firstIssuance: string;
  };
  validationMessage?: string;
  onTierChange: (tier: OrgKiloPassTier) => void;
  onChildAllocationChange: (organizationId: string, passCount: number) => void;
  onReviewPurchase: () => void;
}) {
  const selectedTerms = terms.find(option => option.tier === selectedTier) ?? terms[0];
  const directChildTotal = getDirectChildTotal(allocations);
  const parentPasses = Math.max(0, paidSeats - directChildTotal);
  const isInvalid = directChildTotal > paidSeats || Boolean(validationMessage);

  return (
    <div className="space-y-6">
      <DetailPageHeader
        backHref={`/organizations/${organizationId}/subscriptions`}
        backLabel="Back to subscriptions"
        title="Set up Kilo Pass for Organizations"
        status="setup"
        icon={<Coins className="size-5" />}
      />

      <Card>
        <CardHeader className="pb-4">
          <CardTitle>Coverage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <SummaryValue label="Paid seats" value={String(paidSeats)} icon={<Users />} />
            <SummaryValue label="Passes included" value={String(paidSeats)} icon={<Coins />} />
            <SummaryValue
              label="Billing"
              value={cadence === 'annual' ? 'Annual' : 'Monthly'}
              detail={`Billed with seats · renews ${renewalDate}`}
              icon={<CalendarDays />}
            />
          </div>
          <p className="mt-4 type-body text-muted-foreground">
            Kilo Pass for Organizations includes one pass for every paid seat in {organizationName}.
            It is billed on the same schedule as your seat subscription.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle>Choose one tier for all paid seats</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          {terms.map(option => {
            const selected = option.tier === selectedTier;
            return (
              <button
                key={option.tier}
                type="button"
                aria-pressed={selected}
                onClick={() => onTierChange(option.tier)}
                className={cn(
                  'rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  selected
                    ? 'border-primary/60 bg-primary/5'
                    : 'border-border bg-surface-inset/25 hover:bg-surface-hover/40'
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold">{option.tierName}</span>
                  {selected ? <Badge variant="new">Selected</Badge> : null}
                </div>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="type-title tabular-nums">
                    {formatUsd(option.pricePerPassUsd)}
                  </span>
                  <span className="type-label text-muted-foreground">/pass/month</span>
                </div>
                <p className="mt-3 type-label text-muted-foreground">
                  {formatUsd(option.baseCreditsPerPassUsd)} monthly Credits + up to{' '}
                  {formatUsd(option.bonusCreditsPerPassUsd)} bonus Credits per pass
                </p>
                {option.isCustom ? (
                  <Badge variant="secondary-outline" className="mt-3">
                    Custom plan
                  </Badge>
                ) : null}
              </button>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Choose where your first Credits go</CardTitle>
              <p className="mt-1 type-body text-muted-foreground">
                Assign passes to child organizations. Unassigned passes stay with {organizationName}
                .
              </p>
            </div>
            <Badge variant="secondary-outline" className="tabular-nums">
              {paidSeats} passes total
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <AllocationEditor
            parentName={organizationName}
            parentPasses={parentPasses}
            allocations={allocations}
            isInvalid={isInvalid}
            onChildAllocationChange={onChildAllocationChange}
          />

          {isInvalid ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Review pass assignments</AlertTitle>
              <AlertDescription>
                {validationMessage ??
                  `Remove ${directChildTotal - paidSeats} passes from child organizations.`}
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2 lg:grid-cols-4">
            <QuoteValue label="Recurring total" value={quote.recurringTotal} />
            <QuoteValue label="First charge" value={quote.firstCharge} />
            <QuoteValue label="First billing period" value={quote.firstServiceInterval} />
            <QuoteValue label="First Credits" value={quote.firstIssuance} />
          </div>

          <div className="flex justify-end">
            <Button onClick={onReviewPurchase} disabled={isInvalid || !selectedTerms}>
              Review purchase
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function OrgKiloPassCheckoutReviewView({
  organizationId,
  organizationName,
  terms,
  paidSeats,
  cadence,
  allocations,
  quote,
  bridgeExplanation,
  isSubmitting = false,
}: {
  organizationId: string;
  organizationName: string;
  terms: OrgKiloPassTerms;
  paidSeats: number;
  cadence: OrgKiloPassCadence;
  allocations: OrgKiloPassAllocation[];
  quote: {
    firstCharge: string;
    recurringTotal: string;
    renewsOn: string;
  };
  bridgeExplanation: string;
  isSubmitting?: boolean;
}) {
  const directChildTotal = getDirectChildTotal(allocations);
  const parentPasses = paidSeats - directChildTotal;

  return (
    <div className="space-y-6">
      <DetailPageHeader
        backHref={`/organizations/${organizationId}/subscriptions/kilo-pass/setup`}
        backLabel="Back to setup"
        title="Review Kilo Pass for Organizations"
        status="review"
        icon={<ReceiptText className="size-5" />}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Plan details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <DetailValue label="Tier" value={terms.tierName} />
              <DetailValue label="Coverage" value={`${paidSeats} paid seats`} />
              <DetailValue
                label="Billing schedule"
                value={
                  cadence === 'annual' ? 'Annual, billed with seats' : 'Monthly, billed with seats'
                }
              />
              <DetailValue
                label="Credits per pass"
                value={`${formatUsd(terms.baseCreditsPerPassUsd)} monthly Credits + up to ${formatUsd(terms.bonusCreditsPerPassUsd)} bonus Credits`}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Where your first Credits go</CardTitle>
            </CardHeader>
            <CardContent>
              <AllocationSummary
                parentName={organizationName}
                parentPasses={parentPasses}
                allocations={allocations}
              />
            </CardContent>
          </Card>
          <Alert>
            <FileClock />
            <AlertTitle>Your first Credits follow your seat billing date</AlertTitle>
            <AlertDescription>{bridgeExplanation}</AlertDescription>
          </Alert>
        </div>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Order summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-3 border-b border-border pb-5">
              <PriceRow
                label={`${terms.tierName} × ${paidSeats} passes`}
                value={quote.recurringTotal}
              />
              <PriceRow label="First charge" value={quote.firstCharge} emphasized />
              <p className="type-label text-muted-foreground">Renews {quote.renewsOn}</p>
            </div>
            <p className="type-label text-muted-foreground">
              After payment is confirmed, we check these pass assignments and add your first
              Credits.
            </p>
            <Button className="w-full" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Opening Stripe
                </>
              ) : (
                <>
                  Continue to Stripe
                  <ArrowRight className="size-4" />
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function OrgKiloPassActivationView({
  state,
  title,
  description,
  actionLabel,
}: {
  state: 'awaiting_payment' | 'requires_action' | 'activating' | 'blocked' | 'succeeded';
  title: string;
  description: string;
  actionLabel?: string;
}) {
  const isLoading = state === 'awaiting_payment' || state === 'activating';
  const isSuccess = state === 'succeeded';
  const isBlocked = state === 'blocked' || state === 'requires_action';
  const Icon = isLoading ? Loader2 : isSuccess ? CheckCircle2 : AlertTriangle;

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardContent className="flex flex-col items-center p-8 text-center">
          <span
            className={cn(
              'mb-5 flex size-12 items-center justify-center rounded-full border',
              isSuccess &&
                'border-status-success-border bg-status-success-surface text-status-success',
              isBlocked &&
                'border-status-warning-border bg-status-warning-surface text-status-warning',
              isLoading && 'border-border bg-surface-inset text-muted-foreground'
            )}
          >
            <Icon className={cn('size-5', isLoading && 'animate-spin')} />
          </span>
          <h1 className="type-title">{title}</h1>
          <p className="mt-3 max-w-md type-body text-muted-foreground">{description}</p>
          {isLoading ? (
            <p className="mt-5 type-label text-muted-foreground">
              This usually completes within 30 seconds. You can leave this page safely.
            </p>
          ) : null}
          {actionLabel ? <Button className="mt-6">{actionLabel}</Button> : null}
        </CardContent>
      </Card>
    </div>
  );
}

export function OrgKiloPassDetailView({
  organizationId,
  organizationName,
  commercialState,
  condition,
  terms,
  totalPasses,
  cadence,
  paidThrough,
  currentWindow,
  currentAllocations,
  nextWindowStarts,
  nextAllocations,
  pendingTransition,
  cancellationEffectiveAt,
  isEditing = false,
  stalePlanMessage,
  onChildAllocationChange,
  onSaveDistribution,
}: {
  organizationId: string;
  organizationName: string;
  commercialState: OrgKiloPassCommercialState;
  condition?: OrgKiloPassCondition;
  terms: OrgKiloPassTerms;
  totalPasses: number;
  cadence: OrgKiloPassCadence;
  paidThrough: string;
  currentWindow: string;
  currentAllocations: OrgKiloPassAllocation[];
  nextWindowStarts: string;
  nextAllocations: OrgKiloPassAllocation[];
  pendingTransition?: { tierName: string; effectiveAt: string };
  cancellationEffectiveAt?: string;
  isEditing?: boolean;
  stalePlanMessage?: string;
  onChildAllocationChange?: (organizationId: string, passCount: number) => void;
  onSaveDistribution?: () => void;
}) {
  const directChildTotal = getDirectChildTotal(nextAllocations);
  const parentPasses = Math.max(0, totalPasses - directChildTotal);
  const reductionRequired = Math.max(0, directChildTotal - totalPasses);
  const isOverallocated = reductionRequired > 0 || condition?.kind === 'overallocated';
  const hasCurrentIssuance = commercialState !== 'pending_payment';
  const hasFutureDistribution = commercialState !== 'ended';

  return (
    <div className="space-y-6">
      <DetailPageHeader
        backHref={`/organizations/${organizationId}/subscriptions`}
        backLabel="Back to subscriptions"
        title="Kilo Pass for Organizations"
        status={commercialState}
        icon={<Coins className="size-5" />}
        actions={<Button variant="outline">Manage subscription</Button>}
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
      {pendingTransition ? (
        <Alert>
          <FileClock />
          <AlertTitle>Tier change scheduled</AlertTitle>
          <AlertDescription>
            {pendingTransition.tierName} starts when your subscription renews on{' '}
            {pendingTransition.effectiveAt}. Your current Credits and bonus rules stay the same
            until then.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="grid gap-6 p-6 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryValue
            label="Tier"
            value={terms.tierName}
            detail={terms.isCustom ? 'Custom plan' : undefined}
            icon={<Coins />}
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
          <CardHeader className="pb-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>Current monthly Credit period</CardTitle>
                <p className="mt-1 type-body text-muted-foreground">{currentWindow}</p>
              </div>
              <Badge variant="secondary-outline">Final for this period</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <CurrentAllocationTable allocations={currentAllocations} />
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

      {hasFutureDistribution ? (
        <Card>
          <CardHeader className="pb-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>Next pass assignments</CardTitle>
                <p className="mt-1 type-body text-muted-foreground">Starts: {nextWindowStarts}</p>
              </div>
              <Badge
                variant={isOverallocated ? 'destructive' : 'secondary-outline'}
                className="tabular-nums"
              >
                {directChildTotal} for child organizations · {parentPasses} for {organizationName}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {isEditing && onChildAllocationChange ? (
              <AllocationEditor
                parentName={organizationName}
                parentPasses={parentPasses}
                allocations={nextAllocations}
                isInvalid={isOverallocated}
                onChildAllocationChange={onChildAllocationChange}
              />
            ) : (
              <AllocationSummary
                parentName={organizationName}
                parentPasses={parentPasses}
                allocations={nextAllocations}
              />
            )}

            {stalePlanMessage ? (
              <Alert variant="destructive">
                <RefreshCw />
                <AlertTitle>Pass assignments were changed elsewhere</AlertTitle>
                <AlertDescription>{stalePlanMessage}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="type-label text-muted-foreground">
                Changes apply next month. Current Credits and usage stay the same.
              </p>
              {isEditing && onSaveDistribution ? (
                <Button
                  onClick={onSaveDistribution}
                  disabled={isOverallocated || Boolean(stalePlanMessage)}
                >
                  Save pass assignments
                </Button>
              ) : (
                <Button variant="outline">Edit pass assignments</Button>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export function OrgKiloPassSeatChangeView({
  kind,
  currentSeats,
  newSeats,
  details,
  requiresReconciliation = false,
}: {
  kind: 'increase' | 'decrease' | 'cadence' | 'cancel';
  currentSeats: number;
  newSeats: number;
  details: Array<{ label: string; value: string }>;
  requiresReconciliation?: boolean;
}) {
  const copy = {
    increase: {
      title: 'Increase paid seats',
      description:
        'Kilo Pass for Organizations adds one pass for each new paid seat. Credits for those passes are added for the rest of this monthly period.',
      action: 'Confirm seat increase',
    },
    decrease: {
      title: 'Decrease paid seats',
      description:
        'Kilo Pass for Organizations removes one pass for each removed paid seat. Credits already added stay the same, and next month uses the new pass total.',
      action: 'Confirm seat decrease',
    },
    cadence: {
      title: 'Change billing schedule',
      description: 'Your seats and Kilo Pass for Organizations will use the same billing schedule.',
      action: 'Schedule billing change',
    },
    cancel: {
      title: 'Cancel seat subscription',
      description:
        'Your seats and Kilo Pass for Organizations will end after your current billing period.',
      action: 'Schedule cancellation',
    },
  }[kind];

  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <p className="type-body text-muted-foreground">{copy.description}</p>
      </CardHeader>
      <CardContent className="space-y-5">
        {kind === 'increase' || kind === 'decrease' ? (
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 rounded-xl border border-border bg-surface-inset p-4 text-center">
            <DetailValue label="Current" value={`${currentSeats} seats and passes`} />
            <ArrowRight className="size-4 text-muted-foreground" />
            <DetailValue label="New" value={`${newSeats} seats and passes`} />
          </div>
        ) : null}
        {requiresReconciliation ? (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertTitle>Update pass assignments before next month's Credits</AlertTitle>
            <AlertDescription>
              Pass assignments to child organizations exceed the new total. The seat decrease will
              still complete, but monthly Credits will pause until you update the pass assignments.
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {details.map(detail => (
            <DetailValue key={detail.label} label={detail.label} value={detail.value} />
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-border pt-5">
          <Button variant="outline">Keep current settings</Button>
          <Button variant={kind === 'cancel' ? 'destructive' : 'default'}>{copy.action}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function OrgKiloPassBillingView({ invoices }: { invoices: OrgKiloPassInvoice[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ReceiptText className="size-5" />
          Billing history
        </CardTitle>
      </CardHeader>
      <CardContent>
        {invoices.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-surface-inset/40 p-6 type-body text-muted-foreground">
            No invoices yet. Seat and Kilo Pass for Organizations charges will appear here after
            billing begins.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            {invoices.map(invoice => (
              <div
                key={invoice.id}
                className="grid gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[8rem_minmax(0,1fr)_7rem_6rem] sm:items-center"
              >
                <span className="type-label text-muted-foreground">{invoice.date}</span>
                <div className="min-w-0">
                  <p className="truncate type-body font-medium">{invoice.description}</p>
                  <p className="type-label text-muted-foreground">{invoice.id}</p>
                </div>
                <span className="font-mono type-body tabular-nums sm:text-right">
                  {invoice.amount}
                </span>
                <Badge variant={invoice.status === 'Paid' ? 'new' : 'secondary-outline'}>
                  {invoice.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
        <p className="mt-4 type-label text-muted-foreground">
          Seat and Kilo Pass for Organizations charges appear on the same invoice.
        </p>
      </CardContent>
    </Card>
  );
}

export function OrgKiloPassHierarchyGuardView({
  organizationName,
  allocatedPasses,
  action,
}: {
  organizationName: string;
  allocatedPasses: number;
  action: 'detach' | 'reparent' | 'archive' | 'delete';
}) {
  const actionCopy = {
    detach: {
      description: 'remove it from this organization group',
      label: 'Remove from organization group',
    },
    reparent: {
      description: 'move it to another parent organization',
      label: 'Move to another parent',
    },
    archive: { description: 'archive it', label: 'Archive organization' },
    delete: { description: 'delete it', label: 'Delete organization' },
  }[action];

  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="size-5" />
          Child organization
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border p-4">
          <div>
            <p className="type-body font-medium">{organizationName}</p>
            <p className="type-label text-muted-foreground">
              {allocatedPasses} passes assigned for next month's Credits
            </p>
          </div>
          <Badge variant="secondary-outline">
            <LockKeyhole /> Pass assignment must be removed first
          </Badge>
        </div>
        <Alert variant="warning">
          <ShieldAlert />
          <AlertTitle>
            Remove this organization's pass assignment before you {actionCopy.description}
          </AlertTitle>
          <AlertDescription>
            Remove its pass assignment first. Credits already added to this organization remain
            available.
          </AlertDescription>
        </Alert>
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled>
            {actionCopy.label}
          </Button>
          <Button>Manage pass assignments</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function OrgKiloPassMemberCreditView({
  organizationName,
  balance,
  transactions,
}: {
  organizationName: string;
  balance: string;
  transactions: Array<{ date: string; description: string; amount: string }>;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Credit balance</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-3xl font-semibold tabular-nums">{balance}</p>
          <p className="mt-2 type-body text-muted-foreground">Available to {organizationName}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent Credit activity</CardTitle>
        </CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border bg-surface-inset/40 p-6 type-body text-muted-foreground">
              No Credit activity yet.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {transactions.map(transaction => (
                <div
                  key={`${transaction.date}-${transaction.description}`}
                  className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[7rem_1fr_7rem]"
                >
                  <span className="type-label text-muted-foreground">{transaction.date}</span>
                  <span className="type-body">{transaction.description}</span>
                  <span className="font-mono type-body tabular-nums sm:text-right">
                    {transaction.amount}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function OrgKiloPassAdminView({
  terms,
  state,
  condition,
  processingMode,
  latestRun,
}: {
  terms: OrgKiloPassTerms;
  state: OrgKiloPassCommercialState;
  condition?: OrgKiloPassCondition;
  processingMode: 'automated' | 'manual_legacy';
  latestRun: { window: string; status: 'pending' | 'running' | 'succeeded' | 'blocked' | 'failed' };
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Kilo Pass agreement</CardTitle>
              <p className="mt-1 type-body text-muted-foreground">Northstar Labs · org-northstar</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <SubscriptionStatusBadge status={state} />
              <Badge variant="secondary-outline">{processingMode.replace('_', ' ')}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {condition ? <ConditionAlert condition={condition} /> : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <DetailValue label="Tier" value={terms.tierName} />
            <DetailValue
              label="Price / base"
              value={`${formatUsd(terms.pricePerPassUsd)} / ${formatUsd(terms.baseCreditsPerPassUsd)}`}
            />
            <DetailValue
              label="Bonus / threshold"
              value={`${formatUsd(terms.bonusCreditsPerPassUsd)} / ${formatUsd(terms.unlockSpendPerPassUsd)}`}
            />
            <DetailValue label="Paid through" value="Jul 1, 2027" />
          </div>
          <div className="rounded-xl border border-border bg-surface-inset p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="type-label text-muted-foreground">Latest processing run</p>
                <p className="mt-1 type-body font-medium">{latestRun.window}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    latestRun.status === 'failed' || latestRun.status === 'blocked'
                      ? 'destructive'
                      : 'secondary-outline'
                  }
                >
                  {latestRun.status}
                </Badge>
                <Button variant="outline" size="sm">
                  <Play className="size-4" /> Retry run
                </Button>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-border pt-5">
            <Button variant="outline">
              <Settings2 className="size-4" /> Edit agreement
            </Button>
            <Button variant="outline">
              <FileClock className="size-4" /> Schedule transition
            </Button>
            <Button variant="outline">
              <Coins className="size-4" /> Issue compensation
            </Button>
            <Button variant="outline">
              <History className="size-4" /> View audit history
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Required audit details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="admin-reason">Reason</Label>
            <Input
              id="admin-reason"
              value="Restore missed bonus after delayed processing"
              readOnly
            />
          </div>
          <DetailValue label="Before" value="Missed bonus: $1,440" />
          <DetailValue label="After" value="Compensation grant: $1,440" />
        </CardContent>
      </Card>
    </div>
  );
}

export function OrgKiloPassStatusReferenceView() {
  const commercialStates: OrgKiloPassCommercialState[] = [
    'pending_payment',
    'active',
    'cancel_at_period_end',
    'ended',
  ];
  const runStates = ['pending', 'running', 'succeeded', 'blocked', 'failed'];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Commercial states</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {commercialStates.map(state => (
            <div key={state} className="flex items-center justify-between rounded-lg border p-3">
              <span className="type-body">{statusLabel(state)}</span>
              <SubscriptionStatusBadge status={state} />
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Processing states</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {runStates.map(state => (
            <div key={state} className="flex items-center justify-between rounded-lg border p-3">
              <span className="type-body capitalize">{state}</span>
              <Badge
                variant={
                  state === 'failed' || state === 'blocked' ? 'destructive' : 'secondary-outline'
                }
              >
                {state}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function OrgKiloPassGroupStateView({ state }: { state: 'loading' | 'error' }) {
  return (
    <PageLayout title="Subscriptions" subtitle="Manage subscriptions for Northstar Labs.">
      <SubscriptionGroup
        title="Kilo Pass for Organizations"
        description="Add shared organization Credits for every paid seat."
        headerIcon={<Coins className="size-5" />}
        isLoading={state === 'loading'}
        isError={state === 'error'}
        error={
          state === 'error'
            ? new Error("Kilo Pass for Organizations status couldn't be loaded. Try again.")
            : undefined
        }
        onRetry={() => undefined}
      >
        <div />
      </SubscriptionGroup>
    </PageLayout>
  );
}

function ConditionAlert({ condition }: { condition: OrgKiloPassCondition }) {
  return (
    <Alert variant={conditionVariant(condition)}>
      {condition.kind === 'failed' || condition.kind === 'payment_review' ? (
        <AlertCircle />
      ) : (
        <AlertTriangle />
      )}
      <AlertTitle>{condition.title}</AlertTitle>
      <AlertDescription>
        <p>{condition.description}</p>
        {condition.actionLabel ? (
          <Button variant="outline" size="sm" className="mt-2">
            {condition.actionLabel}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function SummaryValue({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail?: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&>svg]:size-4">
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

function QuoteValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="type-label text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono type-body font-medium tabular-nums">{value}</p>
    </div>
  );
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-inset/40 p-3">
      <p className="type-label text-muted-foreground">{label}</p>
      <p className="mt-1 type-body font-medium tabular-nums">{value}</p>
    </div>
  );
}

function PriceRow({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={emphasized ? 'type-body font-medium' : 'type-body text-muted-foreground'}>
        {label}
      </span>
      <span className={cn('font-mono tabular-nums', emphasized && 'type-heading')}>{value}</span>
    </div>
  );
}

function AllocationEditor({
  parentName,
  parentPasses,
  allocations,
  isInvalid = false,
  onChildAllocationChange,
}: {
  parentName: string;
  parentPasses: number;
  allocations: OrgKiloPassAllocation[];
  isInvalid?: boolean;
  onChildAllocationChange: (organizationId: string, passCount: number) => void;
}) {
  const childAllocations = allocations.filter(allocation => allocation.kind === 'child');

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-4 border-b border-border bg-surface-inset px-4 py-3 type-label text-muted-foreground">
        <span>Organization</span>
        <span className="text-right">Passes</span>
      </div>
      <AllocationIdentityRow
        icon={<Building2 />}
        name={parentName}
        detail={`${parentName} gets unassigned passes`}
      >
        <Input
          aria-label={`${parentName} passes`}
          type="number"
          inputMode="numeric"
          value={parentPasses}
          readOnly
          className={cn('w-24 text-right tabular-nums', isInvalid && 'border-destructive')}
        />
      </AllocationIdentityRow>
      {childAllocations.map(allocation => (
        <AllocationIdentityRow
          key={allocation.organizationId}
          icon={<GitBranch />}
          name={allocation.organizationName}
          detail="Child organization"
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
            aria-invalid={isInvalid}
            className="w-24 text-right tabular-nums"
          />
        </AllocationIdentityRow>
      ))}
    </div>
  );
}

function AllocationSummary({
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
      <AllocationIdentityRow
        icon={<Building2 />}
        name={parentName}
        detail={`${parentName} gets unassigned passes`}
      >
        <span className="font-mono font-medium tabular-nums">{parentPasses}</span>
      </AllocationIdentityRow>
      {childAllocations.map(allocation => (
        <AllocationIdentityRow
          key={allocation.organizationId}
          icon={<GitBranch />}
          name={allocation.organizationName}
          detail="Child organization"
        >
          <span className="font-mono font-medium tabular-nums">{allocation.passCount}</span>
        </AllocationIdentityRow>
      ))}
    </div>
  );
}

function AllocationIdentityRow({
  icon,
  name,
  detail,
  children,
}: {
  icon: React.ReactNode;
  name: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&>svg]:size-4">
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block truncate type-body font-medium text-foreground">{name}</span>
          <span className="block truncate type-label text-muted-foreground">{detail}</span>
        </span>
      </div>
      <div className="flex justify-center">{children}</div>
    </div>
  );
}

function CurrentAllocationTable({ allocations }: { allocations: OrgKiloPassAllocation[] }) {
  return (
    <div className="space-y-3">
      {allocations.map(allocation => {
        const spend = allocation.qualifyingSpendUsd ?? 0;
        const unlockTarget = allocation.unlockTargetUsd ?? 0;
        const progress =
          unlockTarget > 0 ? Math.min(100, Math.round((spend / unlockTarget) * 100)) : 100;
        const state = allocation.bonusState ?? 'locked';
        const stateCopy = {
          locked: `${formatUsd(spend)} of ${formatUsd(unlockTarget)} spent`,
          unlocked: 'Bonus unlocked',
          upfront_granted: 'Bonus already added',
          expired: 'Bonus can no longer be earned',
          missed: "We're checking your bonus",
        }[state];
        const isPositive = state === 'unlocked' || state === 'upfront_granted';

        return (
          <div key={allocation.organizationId} className="rounded-xl border border-border p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  {allocation.kind === 'parent' ? (
                    <Building2 className="size-4" />
                  ) : (
                    <GitBranch className="size-4" />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="truncate type-body font-medium">{allocation.organizationName}</p>
                  <p className="type-label text-muted-foreground">
                    {allocation.passCount} passes · {formatUsd(allocation.baseCreditsUsd ?? 0)}{' '}
                    monthly
                    {' Credits'}
                    {allocation.supplementCreditsUsd
                      ? ` + ${formatUsd(allocation.supplementCreditsUsd)} additional Credits`
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
                    {formatUsd(allocation.bonusCreditsUsd ?? 0)} bonus Credits
                  </span>
                </div>
                <Progress
                  value={isPositive ? 100 : progress}
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
