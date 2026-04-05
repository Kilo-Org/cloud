'use client';

import { Info } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { computeMonthlyCadenceBonusPercent } from '@/lib/kilo-pass/bonus';
import {
  KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT,
  KILO_PASS_TIER_CONFIG,
} from '@/lib/kilo-pass/constants';
import { formatDollars } from '@/lib/utils';

import { formatPercent, getTierName } from './utils';
import type { KiloPassTier } from '@/lib/kilo-pass/enums';

const clampMonth = (month: number) => Math.min(12, Math.max(1, Math.round(month)));

export function KiloPassBonusRampDialog(props: {
  tier: KiloPassTier;
  showFirstMonthPromo?: boolean;
  showSecondMonthPromo?: boolean;
  streakMonths?: number;
  showSlider?: boolean;
  subscriptionStartedAtIso?: string;
}) {
  const {
    tier,
    showFirstMonthPromo = false,
    showSecondMonthPromo = false,
    streakMonths,
    showSlider = true,
    subscriptionStartedAtIso,
  } = props;
  const [open, setOpen] = useState(false);

  const fallbackSubscriptionStartedAtIso = useMemo(() => {
    const now = new Date();
    now.setSeconds(0, 0);
    return now.toISOString();
  }, []);

  const resolvedSubscriptionStartedAtIso =
    subscriptionStartedAtIso ?? fallbackSubscriptionStartedAtIso;
  const resolvedMonth =
    typeof streakMonths === 'number' && !Number.isNaN(streakMonths) ? clampMonth(streakMonths) : 1;
  const [sliderMonth, setSliderMonth] = useState(resolvedMonth);
  const effectiveMonth = showSlider ? sliderMonth : resolvedMonth;
  const config = KILO_PASS_TIER_CONFIG[tier];

  const sliderPercent = computeMonthlyCadenceBonusPercent({
    tier,
    streakMonths: effectiveMonth,
    isFirstTimeSubscriberEver: showFirstMonthPromo,
    subscriptionStartedAtIso: resolvedSubscriptionStartedAtIso,
  });

  const totalBonusUsd = useMemo(
    () =>
      showSlider
        ? Array.from({ length: effectiveMonth }, (_, index) =>
            computeMonthlyCadenceBonusPercent({
              tier,
              streakMonths: index + 1,
              isFirstTimeSubscriberEver: showFirstMonthPromo,
              subscriptionStartedAtIso: resolvedSubscriptionStartedAtIso,
            })
          ).reduce((total, percent) => total + config.monthlyPriceUsd * percent, 0)
        : 0,
    [
      config.monthlyPriceUsd,
      effectiveMonth,
      showFirstMonthPromo,
      showSlider,
      resolvedSubscriptionStartedAtIso,
      tier,
    ]
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground hover:border-border inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded border border-transparent"
          aria-label="How the bonus ramp works"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="border-border/60 overflow-hidden rounded-xl p-0 shadow-sm sm:max-w-[560px]">
        <DialogHeader className="bg-muted/20 border-border/60 border-b px-6 py-3">
          <DialogTitle className="text-base">
            How bonus ramp works ({getTierName(tier)})
          </DialogTitle>
        </DialogHeader>
        <DialogDescription asChild>
          <div className="space-y-4 px-6 pb-6 text-sm">
            <div className="space-y-2">
              <div className="text-muted-foreground">Monthly free bonus % is computed as:</div>
              <div className="bg-muted/40 border-border/60 rounded-lg border px-3 py-2 text-xs">
                <span className="font-mono">min(cap, base + step × (streakMonths − 1))</span>
              </div>
            </div>

            <div className="bg-muted/20 border-border/60 space-y-1 rounded-lg border px-3 py-2 text-sm">
              <div>
                <strong>base</strong> = {formatPercent(config.monthlyBaseBonusPercent)}
              </div>
              <div>
                <strong>step</strong> = {formatPercent(config.monthlyStepBonusPercent)} per
                additional consecutive month
              </div>
              <div>
                <strong>cap</strong> = {formatPercent(config.monthlyCapBonusPercent)}
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-foreground text-sm font-medium">
                {showSlider ? 'Try the ramp' : 'Next bonus preview'}
              </div>
              <div className="bg-muted/20 border-border/60 grid gap-3 rounded-lg border px-3 py-3">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Streak month</span>
                  <span className="font-mono text-amber-300">{effectiveMonth}</span>
                </div>
                {showSlider && (
                  <input
                    type="range"
                    min={1}
                    max={12}
                    value={sliderMonth}
                    onChange={event => {
                      const nextMonth = Number(event.currentTarget.value);
                      if (Number.isNaN(nextMonth)) return;
                      const clampedMonth = Math.min(12, Math.max(1, nextMonth));
                      setSliderMonth(clampedMonth);
                    }}
                    className="accent-blue-500"
                    aria-label="Choose streak month"
                  />
                )}
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Bonus percent</span>
                  <span className="font-mono text-emerald-300">{formatPercent(sliderPercent)}</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Bonus credits</span>
                  <span className="font-mono text-emerald-300">
                    {formatDollars(config.monthlyPriceUsd * sliderPercent)}
                  </span>
                </div>
                {showSlider && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Total bonus credits</span>
                    <span className="font-mono text-emerald-300">
                      {formatDollars(totalBonusUsd)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {showSlider && showFirstMonthPromo && (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-emerald-100">
                As a new subscriber, your{' '}
                <strong>first {showSecondMonthPromo ? '2 paid months' : 'paid month'}</strong> get a
                one-time promo of{' '}
                <strong>
                  +{formatPercent(KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT)} free bonus credits
                </strong>{' '}
                (instead of the regular ramp).
              </div>
            )}

            <div className="text-muted-foreground text-xs">
              “Streak” means consecutive monthly invoices. If you cancel/end and later restart, the
              streak resets.
            </div>
          </div>
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}
