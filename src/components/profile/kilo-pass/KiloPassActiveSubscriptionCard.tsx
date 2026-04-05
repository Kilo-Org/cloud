'use client';

import { Calendar, Coins, Info, Settings } from 'lucide-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDollars, formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { dayjs } from '@/lib/kilo-pass/dayjs';
import { useTRPC } from '@/lib/trpc/utils';
import { getMonthlyPriceUsd } from '@/lib/kilo-pass/bonus';

import { KiloPassSubscriptionSettingsModal } from './KiloPassSubscriptionSettingsModal';
import type { KiloPassSubscription } from './kiloPassSubscription';
import {
  KiloPassSubscriptionInfoProvider,
  useKiloPassSubscriptionInfo,
} from './useKiloPassSubscriptionInfo';
import { KiloPassCadence } from '@/lib/kilo-pass/enums';
import { getTierName } from './utils';
import {
  computeNextBillingDateRowDateLabel,
  computeRenewInfoRowModel,
  computeUsageProgressModel,
} from './KiloPassActiveSubscriptionCard.logic';

export function KiloPassActiveSubscriptionCard(props: { subscription: KiloPassSubscription }) {
  return (
    <KiloPassSubscriptionInfoProvider subscription={props.subscription}>
      <Card className="border-border/60 w-full overflow-hidden rounded-xl shadow-sm">
        <CardHeader>
          <HeaderRow />
        </CardHeader>

        <CardContent className="grid gap-3 pt-4">
          <Alerts />
          <UsageProgressOrBonusUnlocked />
          <RenewInfoRow />
          <NextBillingDateRow />
          <BottomClarification />
        </CardContent>
      </Card>
    </KiloPassSubscriptionInfoProvider>
  );
}

function RenewInfoRow() {
  const { subscription, view } = useKiloPassSubscriptionInfo();
  const trpc = useTRPC();
  const scheduledChangeQuery = useQuery(trpc.kiloPass.getScheduledChange.queryOptions());
  const scheduledChange = scheduledChangeQuery.data?.scheduledChange;

  const rows = computeRenewInfoRowModel({
    subscription,
    isPendingCancellation: Boolean(view.pendingCancellation),
    scheduledChange: scheduledChange ?? null,
  });

  if (rows.length === 0) return null;

  return rows.map(row => {
    const dateLabel = formatIsoDateString_UsaDateOnlyFormat(row.refillAtIso);

    if (row.kind === 'active_until') {
      return (
        <div
          key={`active_until:${row.refillAtIso}`}
          className="bg-muted/20 border-border/60 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
        >
          <div className="flex items-start gap-2">
            <Calendar className="mt-0.5 h-4 w-4 text-white/40" />
            <div className="text-muted-foreground">Active until</div>
          </div>
          <span className="text-muted-foreground">{dateLabel}</span>
        </div>
      );
    }

    return (
      <div
        key={`renews_and_adds_bonus:${row.refillAtIso}`}
        className="bg-muted/20 border-border/60 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
      >
        <div className="flex items-start gap-2">
          <Calendar className="mt-0.5 h-4 w-4 text-white/40" />
          <div className="text-muted-foreground">
            {row.labelPrefix}: adds{' '}
            <span className="font-mono font-semibold text-amber-300">
              {formatDollars(row.baseUsd)}
            </span>{' '}
            paid +{' '}
            <span className="font-mono font-semibold text-emerald-300">
              {formatDollars(row.bonusUsd)}
            </span>{' '}
            free bonus credits
          </div>
        </div>
        <span className="text-muted-foreground">{dateLabel}</span>
      </div>
    );
  });
}

function HeaderRow() {
  const { view } = useKiloPassSubscriptionInfo();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="flex items-start justify-between gap-3">
      <CardTitle className="flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-linear-to-br from-amber-500/30 to-amber-300/10 ring-1 ring-amber-400/25">
          <Coins className="h-5 w-5 text-amber-300" />
        </span>
        <span className="leading-none">
          <span className="block text-base">Kilo Pass</span>
          <span className="text-muted-foreground block text-sm font-normal">
            {view.header.tierLabel} • {view.header.cadenceLabel}
          </span>
        </span>
      </CardTitle>

      <div className="flex items-center gap-2">
        <Badge variant={view.status.badgeVariant}>{view.status.label}</Badge>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>

      <KiloPassSubscriptionSettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

function Alerts() {
  const { view } = useKiloPassSubscriptionInfo();
  if (view.alerts.length === 0) return null;

  return (
    <>
      {view.alerts.map(alert => (
        <Alert key={alert.kind} variant={alert.variant}>
          <Info />
          <AlertTitle>{alert.title}</AlertTitle>
          <AlertDescription>
            <p>{alert.description}</p>
          </AlertDescription>
        </Alert>
      ))}
    </>
  );
}

function UsageProgressOrBonusUnlocked() {
  const { subscription } = useKiloPassSubscriptionInfo();

  const baseUsd = subscription.currentPeriodBaseCreditsUsd;
  const usageUsd = subscription.currentPeriodUsageUsd;
  // This is the bonus for the *current* period (unlocked after consuming the base credits).
  const bonusUsd = subscription.currentPeriodBonusCreditsUsd;

  const model = computeUsageProgressModel({
    baseUsd,
    usageUsd,
    bonusUsd,
    isBonusUnlocked: subscription.isBonusUnlocked,
  });
  if (!model) return null;

  return (
    <div className="bg-muted/20 border-border/60 grid gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">This month&apos;s usage</span>
        <span className={cn('font-mono font-semibold', model.statusClass)}>
          {formatDollars(model.nonNegativeUsageUsd)} / {formatDollars(model.totalAvailableUsd)}
        </span>
      </div>

      <div className="space-y-2">
        <div className="bg-muted/50 relative h-3 overflow-visible rounded-full">
          <div
            className="absolute inset-y-0 left-0 opacity-40"
            style={{
              width: `${model.pctOfBaseInTotal}%`,
              background: 'rgba(245,158,11,0.20)',
            }}
          />
          <div
            className="absolute inset-y-0 opacity-40"
            style={{
              left: `${model.pctOfBaseInTotal}%`,
              width: `${100 - model.pctOfBaseInTotal}%`,
              background: 'rgba(16,185,129,0.20)',
            }}
          />

          <div
            className="absolute inset-y-0 left-0 rounded-l-full bg-linear-to-r from-amber-500 to-amber-300 transition-[width]"
            style={{ width: `${model.paidFillPct}%` }}
          />

          <div
            className="absolute inset-y-0 rounded-r-full bg-linear-to-r from-emerald-500 to-emerald-300 transition-[width]"
            style={{ left: `${model.pctOfBaseInTotal}%`, width: `${model.bonusFillPct}%` }}
          />

          <div
            className="absolute top-full mt-0.5 h-1.5 w-0.5 rounded bg-white/40"
            style={{ left: `calc(${model.pctOfBaseInTotal}% - 1px)` }}
          />
        </div>

        <div className="relative h-4">
          <span
            className="absolute -translate-x-1/2 font-mono text-xs font-semibold text-amber-300"
            style={{ left: `${model.pctOfBaseInTotal}%` }}
          >
            {formatDollars(model.baseUsd)}
          </span>
          <span className="absolute right-0 font-mono text-xs font-semibold text-emerald-300">
            {formatDollars(model.bonusUsd)}
          </span>
        </div>

        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-sm bg-amber-400/80" />
            Paid
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-sm bg-emerald-400/80" />
            Free bonus
          </div>
        </div>
      </div>
    </div>
  );
}

function NextBillingDateRow() {
  const { subscription, view } = useKiloPassSubscriptionInfo();
  const trpc = useTRPC();
  const scheduledChangeQuery = useQuery(trpc.kiloPass.getScheduledChange.queryOptions());
  const scheduledChange = scheduledChangeQuery.data?.scheduledChange;
  const nextBillingDateLabel = view.dates.nextBillingDateLabel;

  if (subscription.cadence !== KiloPassCadence.Yearly || !nextBillingDateLabel) return null;
  if (view.pendingCancellation) return null;

  const changeTierLabel = scheduledChange?.toTier ? getTierName(scheduledChange.toTier) : null;
  const changeCadenceLabel = scheduledChange?.toCadence
    ? scheduledChange.toCadence === KiloPassCadence.Monthly
      ? 'Monthly'
      : 'Yearly'
    : null;
  const changeSuffix =
    scheduledChange && !view.pendingCancellation && changeTierLabel && changeCadenceLabel
      ? `(change to ${changeTierLabel} ${changeCadenceLabel})`
      : null;

  const fromMonthlyUsd = getMonthlyPriceUsd(scheduledChange?.fromTier ?? subscription.tier);
  const toMonthlyUsd = scheduledChange?.toTier ? getMonthlyPriceUsd(scheduledChange.toTier) : null;
  const isYearlyTierUpgrade =
    scheduledChange?.fromCadence === KiloPassCadence.Yearly &&
    scheduledChange.toCadence === KiloPassCadence.Yearly &&
    typeof toMonthlyUsd === 'number' &&
    toMonthlyUsd > fromMonthlyUsd;

  const effectiveAtLabel =
    isYearlyTierUpgrade && scheduledChange?.effectiveAt
      ? formatIsoDateString_UsaDateOnlyFormat(scheduledChange.effectiveAt)
      : null;
  const dateLabelIso = computeNextBillingDateRowDateLabel({
    subscriptionCadence: subscription.cadence,
    isPendingCancellation: Boolean(view.pendingCancellation),
    nextBillingDateLabel,
    subscriptionTier: subscription.tier,
    scheduledChange: scheduledChange ?? null,
  });
  const dateLabel =
    dateLabelIso && dayjs(dateLabelIso).utc().isValid()
      ? formatIsoDateString_UsaDateOnlyFormat(dateLabelIso)
      : (effectiveAtLabel ?? nextBillingDateLabel);

  return (
    <div className="bg-muted/20 border-border/60 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <Calendar className="h-4 w-4 text-white/40" />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-muted-foreground">Next billing date {changeSuffix}</span>
        </div>
      </div>
      <span className="text-muted-foreground">{dateLabel}</span>
    </div>
  );
}

function BottomClarification() {
  const { subscription, view } = useKiloPassSubscriptionInfo();

  if (view.status.isEnded) return null;

  const expiresAt = subscription.refillAt ?? subscription.nextBillingAt;
  const expiresAtLabel = expiresAt ? formatIsoDateString_UsaDateOnlyFormat(expiresAt) : null;

  if (subscription.cadence !== KiloPassCadence.Monthly) return null;

  return (
    <div className="text-muted-foreground text-xs">
      Unused paid credits never expire and roll over every month into your total. Free bonus credits
      are earned after using the month&apos;s paid credits. Unused free bonus credits do not roll
      over and will expire{expiresAtLabel ? ` on ${expiresAtLabel}.` : '.'}
    </div>
  );
}
