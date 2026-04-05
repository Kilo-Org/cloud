'use client';

import { Badge } from '@/components/ui/badge';
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
  showFirstMonthPromo: boolean;
  showSecondMonthPromo?: boolean;
  isRecommended: boolean;
  onSelect: (tier: KiloPassTier) => void;
}) {
  const {
    tier,
    cadence,
    pending,
    showFirstMonthPromo,
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
    <div
      className={cn(
        'group bg-background relative rounded-xl border p-4 text-left transition-colors',
        'hover:border-blue-400/70 hover:shadow-[0_0_0_1px_rgba(59,130,246,0.25)]',
        pending ? 'cursor-not-allowed opacity-70' : 'cursor-default',
        isRecommended
          ? 'border-blue-500/60 shadow-[0_0_0_1px_rgba(59,130,246,0.35)]'
          : 'border-border/70'
      )}
    >
      {isRecommended && (
        <Badge className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3">
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

      <div className="mt-4 space-y-1">
        {cadence === KiloPassCadence.Monthly ? (
          <>
            <div className="text-muted-foreground text-xs leading-5">
              Includes <span className="text-amber-300">{getBaseCreditsLabel({ tier })}</span> paid
              credits
            </div>

            <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs leading-5">
              <span className="leading-5">
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
            <div className="text-muted-foreground text-xs leading-5">
              Includes <span className="text-amber-300">{getBaseCreditsLabel({ tier })}</span> pass
              credits
            </div>
            <div className="text-muted-foreground text-xs leading-5">
              Includes <span className="text-emerald-300">{getYearlyMonthlyBonusLabel(tier)}</span>{' '}
              bonus credits
            </div>
          </>
        )}
      </div>

      <div className="mt-4 flex items-center justify-end">
        <button
          type="button"
          onClick={handleSelect}
          disabled={pending}
          className={cn(
            'inline-flex items-center gap-2 rounded-full border border-blue-500/40 bg-blue-500/10 px-4 py-1.5 text-sm font-semibold text-blue-100 transition',
            'hover:border-blue-400 hover:bg-blue-500/20 hover:text-white',
            'focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-blue-400/60 focus-visible:ring-offset-2 focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-blue-500/10',
            pending ? 'cursor-not-allowed' : 'cursor-pointer'
          )}
        >
          Buy now
          <span className="text-base">→</span>
        </button>
      </div>
    </div>
  );
}
