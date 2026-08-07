// React must be in scope for the classic JSX runtime used by the jest transform.
import React from 'react';
import { AlertCircle, ArrowRight, CalendarDays, Check, Loader2, Users } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DetailPageHeader } from '@/components/subscriptions/DetailPageHeader';
import { KiloPassIcon } from '@/components/icons/KiloPassIcon';
import { cn } from '@/lib/utils';
import { formatOrgPassMoney } from './formatters';
import type {
  OrgKiloPassAllocation,
  OrgKiloPassCadence,
  OrgKiloPassTerms,
  OrgKiloPassTier,
} from './types';
import { AllocationEditor, getDirectChildTotal, InfoTooltip, SummaryValue } from './view-shared';

export function OrgKiloPassSetupView({
  organizationId,
  organizationName,
  paidSeats,
  cadence,
  renewalDate,
  selectedTier,
  terms,
  allocations,
  quote,
  validationMessage,
  isSubmitting = false,
  onTierChange,
  onChildAllocationChange,
  onContinueToStripe,
}: {
  organizationId: string;
  organizationName: string;
  paidSeats: number;
  cadence: OrgKiloPassCadence;
  renewalDate: string;
  selectedTier: OrgKiloPassTier;
  terms: OrgKiloPassTerms[];
  allocations: OrgKiloPassAllocation[];
  quote: {
    recurringTotal: string;
    firstCharge: string;
  };
  validationMessage?: string;
  isSubmitting?: boolean;
  onTierChange: (tier: OrgKiloPassTier) => void;
  onChildAllocationChange: (organizationId: string, passCount: number) => void;
  onContinueToStripe: () => void;
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
        icon={<KiloPassIcon className="size-5" />}
      />

      <Card>
        <CardContent className="grid gap-6 p-6 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryValue
            label="Tier"
            value={selectedTerms?.tierName ?? ''}
            detail={
              selectedTerms
                ? `${formatOrgPassMoney(selectedTerms.baseCreditsPerPassUsd)} monthly Credits per pass`
                : undefined
            }
            icon={<KiloPassIcon />}
          />
          <SummaryValue label="Paid seats covered" value={String(paidSeats)} icon={<Users />} />
          <SummaryValue
            label="Billing schedule"
            value={cadence === 'annual' ? 'Annual' : 'Monthly'}
            detail="Billed with seats"
            icon={<CalendarDays />}
          />
          <SummaryValue label="Renews on" value={renewalDate} icon={<Check />} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
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
                        {formatOrgPassMoney(option.pricePerPassUsd)}
                      </span>
                      <span className="type-label text-muted-foreground">/pass/month</span>
                    </div>
                    <p className="mt-3 type-label text-muted-foreground">
                      {formatOrgPassMoney(option.baseCreditsPerPassUsd)} monthly Credits + up to{' '}
                      {formatOrgPassMoney(option.bonusCreditsPerPassUsd)} bonus Credits per pass
                    </p>
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
                    Assign passes to direct child organizations. Passes you don&apos;t assign stay
                    with {organizationName}.
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
                describedById="setup-allocation-validation"
                onChildAllocationChange={onChildAllocationChange}
              />

              {isInvalid ? (
                <Alert variant="destructive" id="setup-allocation-validation">
                  <AlertCircle />
                  <AlertTitle>Review pass assignments</AlertTitle>
                  <AlertDescription>
                    {validationMessage ??
                      `Remove ${directChildTotal - paidSeats} passes from child organizations.`}
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <OrderSummaryCard
          className="self-start lg:sticky lg:top-20"
          tierName={selectedTerms?.tierName ?? ''}
          paidSeats={paidSeats}
          recurringTotal={quote.recurringTotal}
          firstCharge={quote.firstCharge}
          renewsOn={renewalDate}
          isSubmitting={isSubmitting}
          isDisabled={isInvalid || !selectedTerms}
          onContinueToStripe={onContinueToStripe}
        />
      </div>
    </div>
  );
}

function OrderSummaryCard({
  tierName,
  paidSeats,
  recurringTotal,
  firstCharge,
  renewsOn,
  isSubmitting = false,
  isDisabled = false,
  className,
  onContinueToStripe,
}: {
  tierName: string;
  paidSeats: number;
  recurringTotal: string;
  firstCharge: string;
  renewsOn: string;
  isSubmitting?: boolean;
  isDisabled?: boolean;
  className?: string;
  onContinueToStripe: () => void;
}) {
  return (
    <Card className={cn('h-fit', className)}>
      <CardHeader>
        <CardTitle>Order summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-3 border-b border-border pb-5">
          <PriceRow label={`${tierName} × ${paidSeats} passes`} value={recurringTotal} />
          <PriceRow
            label="First charge"
            value={firstCharge}
            emphasized
            labelAccessory={
              <InfoTooltip
                label="About the first charge"
                content="Your first charge can be prorated to align Kilo Pass with your existing seat billing date. After that, you're charged the recurring amount on the same schedule."
              />
            }
          />
          <p className="type-label text-muted-foreground">Renews {renewsOn}</p>
        </div>
        <p className="type-label text-muted-foreground">
          After payment is confirmed, we check these pass assignments and add your first Credits.
        </p>
        <Button
          className="w-full"
          disabled={isSubmitting || isDisabled}
          onClick={onContinueToStripe}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
              Processing payment
            </>
          ) : (
            <>
              Purchase Kilo Pass
              <ArrowRight className="size-4" />
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

function PriceRow({
  label,
  value,
  emphasized = false,
  labelAccessory,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
  labelAccessory?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span
        className={cn(
          'inline-flex items-center gap-1.5',
          emphasized ? 'type-body font-medium' : 'type-body text-muted-foreground'
        )}
      >
        {label}
        {labelAccessory}
      </span>
      <span className={cn('font-mono tabular-nums', emphasized && 'type-heading')}>{value}</span>
    </div>
  );
}
