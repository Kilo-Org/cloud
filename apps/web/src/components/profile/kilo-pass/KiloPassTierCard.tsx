'use client';

import { ArrowRight, Check } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT,
  KILO_PASS_TIER_CONFIG,
} from '@/lib/kilo-pass/constants';
import { cn } from '@/lib/utils';

import { KiloPassBonusRampDialog } from './KiloPassBonusRampDialog';
import {
  formatPercent,
  getBaseCreditsLabel,
  getTierName,
  getYearlyMonthlyBonusLabel,
} from './utils';
import type { KiloPassTier } from '@/lib/kilo-pass/enums';
import { KiloPassCadence } from '@/lib/kilo-pass/enums';

export function KiloPassTierCard(props: {
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  pending: boolean;
  showFirstMonthPromo?: boolean;
  showSecondMonthPromo?: boolean;
  isRecommended: boolean;
  onSelect: (tier: KiloPassTier) => void;
}) {
  const {
    tier,
    cadence,
    pending,
    showFirstMonthPromo = false,
    showSecondMonthPromo = false,
    isRecommended,
    onSelect,
  } = props;
  const config = KILO_PASS_TIER_CONFIG[tier];
  const handleSelect = () => {
    if (pending) return;
    onSelect(tier);
  };
  const priceLabel =
    cadence === KiloPassCadence.Monthly
      ? `$${config.monthlyPriceUsd}`
      : `$${config.monthlyPriceUsd * 12}`;
  const cadenceLabel = cadence === KiloPassCadence.Monthly ? '/month' : '/year';

  return (
    <Card
      className={cn(
        'border-border/60 relative flex h-full flex-col p-4 text-left shadow-sm',
        pending ? 'cursor-not-allowed opacity-70' : 'cursor-default'
      )}
    >
      {isRecommended && (
        <Badge
          variant="secondary"
          className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full px-3"
        >
          Recommended
        </Badge>
      )}

      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{getTierName(tier)}</div>
        </div>
        <div className="text-muted-foreground mt-0.5 text-xs">
          {cadence === KiloPassCadence.Monthly ? 'Monthly' : 'Yearly'}
        </div>
      </div>

      <div className="mt-3 flex items-baseline gap-1">
        <div className="text-2xl font-semibold text-white">{priceLabel}</div>
        <div className="text-muted-foreground text-xs">{cadenceLabel}</div>
      </div>

      <div className="mt-4 flex-1 space-y-2">
        {cadence === KiloPassCadence.Monthly ? (
          <>
            <div className="text-muted-foreground flex items-start gap-2 text-xs leading-5">
              <Check className="mt-0.5 size-3.5 flex-none text-emerald-400" />
              <span>
                Includes <span className="text-amber-300">{getBaseCreditsLabel({ tier })}</span>{' '}
                paid credits
              </span>
            </div>

            <div className="text-muted-foreground flex items-start gap-2 text-xs leading-5">
              <Check className="mt-0.5 size-3.5 flex-none text-emerald-400" />
              <span className="flex-1">
                Up to{' '}
                <span className="text-emerald-300">
                  {formatPercent(config.monthlyCapBonusPercent)}
                </span>{' '}
                free bonus credits
              </span>
              <KiloPassBonusRampDialog
                tier={tier}
                showFirstMonthPromo={showFirstMonthPromo}
                showSecondMonthPromo={showSecondMonthPromo}
              />
            </div>

            {showFirstMonthPromo && (
              <div className="text-xs leading-5 text-emerald-300">
                {showSecondMonthPromo ? 'First 2 months:' : 'First month:'} +
                {formatPercent(KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT)} free bonus credits
              </div>
            )}
          </>
        ) : (
          <>
            <div className="text-muted-foreground flex items-start gap-2 text-xs leading-5">
              <Check className="mt-0.5 size-3.5 flex-none text-emerald-400" />
              <span>
                Includes <span className="text-amber-300">{getBaseCreditsLabel({ tier })}</span>{' '}
                pass credits
              </span>
            </div>
            <div className="text-muted-foreground flex items-start gap-2 text-xs leading-5">
              <Check className="mt-0.5 size-3.5 flex-none text-emerald-400" />
              <span>
                Includes{' '}
                <span className="text-emerald-300">{getYearlyMonthlyBonusLabel(tier)}</span> bonus
                credits
              </span>
            </div>
          </>
        )}
      </div>

      <div className="mt-4">
        <Button
          type="button"
          variant={isRecommended ? 'default' : 'secondary'}
          onClick={handleSelect}
          disabled={pending}
          className={cn(
            'h-11 w-full sm:h-9',
            isRecommended &&
              'bg-brand-primary text-primary-foreground hover:bg-brand-primary/90 focus-visible:ring-brand-primary/50'
          )}
        >
          Buy now
          <ArrowRight />
        </Button>
      </div>
    </Card>
  );
}
