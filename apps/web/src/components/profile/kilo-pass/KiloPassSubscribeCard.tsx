'use client';

import { Check, Crown, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { KiloPassCadence } from '@/lib/kilo-pass/enums';
import type { KiloPassTier } from '@/lib/kilo-pass/enums';
import {
  KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF,
  KILO_PASS_TIER_CONFIG,
} from '@/lib/kilo-pass/constants';
import { cn } from '@/lib/utils';
import { formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';

import { KiloPassTierCard } from './KiloPassTierCard';

export function KiloPassSubscribeCard(props: {
  cadence: KiloPassCadence;
  setCadence: (cadence: KiloPassCadence) => void;
  pending: boolean;
  showFirstMonthPromo?: boolean;
  showSecondMonthPromo: boolean;
  showHeader?: boolean;
  unframed?: boolean;
  className?: string;
  contentClassName?: string;
  recommendedTier: KiloPassTier | null;
  onSelectTier: (tier: KiloPassTier) => void;
}) {
  const {
    cadence,
    setCadence,
    pending,
    showFirstMonthPromo = false,
    showSecondMonthPromo,
    showHeader = true,
    unframed = false,
    className,
    contentClassName,
    recommendedTier,
    onSelectTier,
  } = props;

  const tiers = Object.keys(KILO_PASS_TIER_CONFIG) as KiloPassTier[];

  const promoCutoffLabel = formatIsoDateString_UsaDateOnlyFormat(
    KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.toISOString()
  );
  const monthlyPromoDescription =
    cadence === KiloPassCadence.Monthly && showFirstMonthPromo
      ? showSecondMonthPromo
        ? `First-time subscribers receive 50% free bonus credits for the first two months when they start before ${promoCutoffLabel}.`
        : 'First-time subscribers receive 50% free bonus credits for the first month.'
      : null;
  const cadenceOptions = [
    { value: KiloPassCadence.Monthly, label: 'Monthly' },
    { value: KiloPassCadence.Yearly, label: 'Yearly' },
  ] as const;

  const content = (
    <div className={cn('grid gap-5', contentClassName)}>
      <div className="bg-muted/20 border-border/60 flex flex-wrap items-center justify-between gap-3 overflow-hidden rounded-lg border px-3 py-2">
        <div className="text-muted-foreground text-sm">Billing cadence</div>
        <div className="bg-white/[0.04] flex w-full items-center gap-1 rounded-lg p-1 sm:w-56">
          {cadenceOptions.map(option => (
            <Button
              key={option.value}
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setCadence(option.value)}
              className={cn(
                'h-8 flex-1 rounded-md px-3 text-xs font-semibold transition',
                cadence === option.value
                  ? 'bg-foreground text-background shadow-sm hover:bg-foreground/90 hover:text-background'
                  : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
              )}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3 lg:gap-5">
        {tiers.map(tier => (
          <KiloPassTierCard
            key={tier}
            tier={tier}
            cadence={cadence}
            pending={pending}
            showFirstMonthPromo={showFirstMonthPromo}
            showSecondMonthPromo={showSecondMonthPromo}
            isRecommended={recommendedTier != null && tier === recommendedTier}
            onSelect={onSelectTier}
          />
        ))}
      </div>

      <div className="space-y-2 text-xs">
        <div className="text-muted-foreground flex items-start gap-2">
          <Check className="mt-0.5 size-4 flex-none text-emerald-400" />
          <span>Your payment converts 1:1 into credits that are added to your balance</span>
        </div>
        <div className="text-muted-foreground flex items-start gap-2">
          <Check className="mt-0.5 size-4 flex-none text-emerald-400" />
          <span>
            Earn free bonus credits after using your paid credits each month. Unused free bonus
            credits expire every month.
          </span>
        </div>
        {monthlyPromoDescription && (
          <div className="text-muted-foreground flex items-start gap-2">
            <Check className="mt-0.5 size-4 flex-none text-emerald-400" />
            <span>{monthlyPromoDescription}</span>
          </div>
        )}
      </div>
    </div>
  );

  if (unframed) {
    return content;
  }

  return (
    <Card className={cn('border-border/60 w-full overflow-hidden rounded-xl shadow-sm', className)}>
      {showHeader ? (
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <span className="bg-muted/40 ring-border/60 grid size-9 place-items-center rounded-lg ring-1">
                <Crown className="size-5" />
              </span>

              <span className="leading-none">
                <span className="block text-base">Kilo Pass</span>
                <span className="text-muted-foreground block text-sm font-normal">
                  Unlock up to <span className="text-emerald-300/90">50% free credits</span>.
                  Checkout securely with Stripe.
                </span>
              </span>
            </CardTitle>

            {pending ? (
              <Badge variant="secondary" className="gap-1.5">
                <Loader2 className="size-3.5 animate-spin" />
                Processing
              </Badge>
            ) : (
              <Badge variant="secondary">Subscribe</Badge>
            )}
          </div>
        </CardHeader>
      ) : null}
      <CardContent className={cn('pt-4', !showHeader && 'p-0 pt-0')}>{content}</CardContent>
    </Card>
  );
}
