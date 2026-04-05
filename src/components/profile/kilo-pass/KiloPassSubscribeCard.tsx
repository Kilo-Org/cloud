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
  showFirstMonthPromo: boolean;
  showSecondMonthPromo: boolean;
  recommendedTier: KiloPassTier | null;
  onSelectTier: (tier: KiloPassTier) => void;
}) {
  const {
    cadence,
    setCadence,
    pending,
    showFirstMonthPromo,
    showSecondMonthPromo,
    recommendedTier,
    onSelectTier,
  } = props;

  const tiers = Object.keys(KILO_PASS_TIER_CONFIG) as KiloPassTier[];

  const promoCutoffLabel = formatIsoDateString_UsaDateOnlyFormat(
    KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.toISOString()
  );
  const cadenceOptions = [
    { value: KiloPassCadence.Monthly, label: 'Monthly' },
    { value: KiloPassCadence.Yearly, label: 'Yearly' },
  ] as const;

  return (
    <Card className="border-border/60 w-full overflow-hidden rounded-xl shadow-sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <span className="bg-muted/40 ring-border/60 grid h-9 w-9 place-items-center rounded-lg ring-1">
              <Crown className="h-5 w-5" />
            </span>

            <span className="leading-none">
              <span className="block text-base">Kilo Pass</span>
              <span className="text-muted-foreground block text-sm font-normal">
                Unlock up to <span className="text-emerald-300/90">50% free credits</span>. Checkout
                securely with Stripe.
              </span>
            </span>
          </CardTitle>

          {pending ? (
            <Badge variant="secondary" className="gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Processing
            </Badge>
          ) : (
            <Badge variant="secondary">Subscribe</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="grid gap-5 pt-4">
        <div className="bg-muted/20 border-border/60 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2">
          <div className="text-muted-foreground text-sm">Billing cadence</div>
          <div className="bg-muted/40 ring-border/60 flex w-full items-center gap-1 rounded-lg p-1 ring-1 sm:w-56">
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
                    ? 'bg-blue-500 text-white shadow hover:bg-blue-500'
                    : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
                )}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {tiers.map(tier => {
            return (
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
            );
          })}
        </div>

        <div className="space-y-2 text-xs">
          <div className="text-muted-foreground flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-400" />
            <span>Your payment converts 1:1 into paid credits that never expire</span>
          </div>
          <div className="text-muted-foreground flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-400" />
            <span>
              Earn free bonus credits after using your paid credits each month. Unused free bonus
              credits expire every month.
            </span>
          </div>
          {cadence === KiloPassCadence.Monthly && showSecondMonthPromo && (
            <div className="text-muted-foreground flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 flex-none text-emerald-400" />
              <span>
                First-time subscribers receive <span className="text-emerald-300">50%</span> free
                bonus credits for the first two months. Offer expires {promoCutoffLabel}.
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
