import { dayjs } from '@/lib/kilo-pass/dayjs';
import {
  computeMonthlyCadenceBonusPercent,
  computeYearlyCadenceMonthlyBonusUsd,
  getMonthlyPriceUsd,
} from '@/lib/kilo-pass/bonus';
import { KiloPassCadence } from '@/lib/kilo-pass/enums';
import type { KiloPassTier } from '@/lib/kilo-pass/enums';
import { getTierName } from './utils';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import type { KiloPassSubscription } from './kiloPassSubscription';

type RouterOutputs = inferRouterOutputs<RootRouter>;

export type KiloPassScheduledChange =
  RouterOutputs['kiloPass']['getScheduledChange']['scheduledChange'];

export type KiloPassActiveSubscriptionCardLogicSubscription = Pick<
  KiloPassSubscription,
  | 'cadence'
  | 'tier'
  | 'currentStreakMonths'
  | 'isFirstTimeSubscriberEver'
  | 'startedAt'
  | 'refillAt'
  | 'nextBillingAt'
  | 'currentPeriodBaseCreditsUsd'
  | 'currentPeriodUsageUsd'
  | 'currentPeriodBonusCreditsUsd'
  | 'isBonusUnlocked'
>;

export type RenewInfoRowModel =
  | {
      kind: 'active_until';
      refillAtIso: string;
      refillsInDays: number;
      changeSuffix: '';
    }
  | {
      kind: 'renews_and_adds_bonus';
      refillAtIso: string;
      refillsInDays: number;
      baseUsd: number;
      bonusUsd: number;
      changeSuffix: string;
      labelPrefix: string;
    };

function computeActiveUntilRowModel(params: {
  subscription: Pick<KiloPassSubscription, 'cadence' | 'refillAt' | 'nextBillingAt'>;
  now: ReturnType<typeof dayjs>;
}): Extract<RenewInfoRowModel, { kind: 'active_until' }> | null {
  const activeUntilIso =
    params.subscription.cadence === KiloPassCadence.Yearly
      ? (params.subscription.nextBillingAt ?? null)
      : (params.subscription.refillAt ?? params.subscription.nextBillingAt ?? null);
  if (!activeUntilIso) return null;

  const activeUntil = dayjs(activeUntilIso);
  if (!activeUntil.utc().isValid()) return null;

  const refillsInDays = Math.round(activeUntil.diff(params.now, 'days', true));

  return {
    kind: 'active_until',
    refillAtIso: activeUntilIso,
    refillsInDays,
    changeSuffix: '',
  };
}

function isRefillRowHiddenBecauseLastMonth(params: {
  isPendingCancellation: boolean;
  subscriptionCadence: KiloPassCadence;
  refillAtIso: string | null;
  nextBillingAtIso: string | null;
}): boolean {
  if (!params.isPendingCancellation) return false;
  if (params.subscriptionCadence !== KiloPassCadence.Yearly) return false;
  if (!params.refillAtIso || !params.nextBillingAtIso) return false;

  const refillAt = dayjs(params.refillAtIso);
  const nextBillingAt = dayjs(params.nextBillingAtIso);
  if (!refillAt.utc().isValid() || !nextBillingAt.utc().isValid()) return false;

  return refillAt.utc().isSame(nextBillingAt.utc()) || refillAt.utc().isAfter(nextBillingAt.utc());
}

function computeRefillRowModel(params: {
  subscription: KiloPassActiveSubscriptionCardLogicSubscription;
  scheduledChange: KiloPassScheduledChange;
  now: ReturnType<typeof dayjs>;
  refillAtIso: string;
}): Extract<RenewInfoRowModel, { kind: 'renews_and_adds_bonus' }> | null {
  const refillAt = dayjs(params.refillAtIso);
  if (!refillAt.utc().isValid()) return null;

  const refillsInDays = Math.round(refillAt.diff(params.now, 'days', true));

  const shouldApplyScheduledChangeToNextRenew =
    params.subscription.cadence === KiloPassCadence.Monthly ||
    (params.scheduledChange?.effectiveAt &&
      dayjs(params.scheduledChange.effectiveAt).utc().isValid() &&
      dayjs(params.scheduledChange.effectiveAt).utc().isSame(refillAt.utc()));

  const baseTier =
    shouldApplyScheduledChangeToNextRenew && params.scheduledChange?.toTier
      ? params.scheduledChange.toTier
      : params.subscription.tier;
  const baseCadence =
    shouldApplyScheduledChangeToNextRenew && params.scheduledChange?.toCadence
      ? params.scheduledChange.toCadence
      : params.subscription.cadence;

  const baseUsd = getMonthlyPriceUsd(baseTier);
  if (typeof baseUsd !== 'number' || baseUsd <= 0) return null;

  const bonusUsd =
    baseCadence === KiloPassCadence.Yearly
      ? computeYearlyCadenceMonthlyBonusUsd(baseTier)
      : baseCadence === KiloPassCadence.Monthly
        ? baseUsd *
          computeMonthlyCadenceBonusPercent({
            tier: baseTier,
            streakMonths: Math.max(1, params.subscription.currentStreakMonths + 1),
            isFirstTimeSubscriberEver: params.subscription.isFirstTimeSubscriberEver,
            subscriptionStartedAtIso: params.subscription.startedAt,
          })
        : null;
  if (typeof bonusUsd !== 'number' || bonusUsd <= 0) return null;

  const changeTierLabel = params.scheduledChange?.toTier
    ? getTierName(params.scheduledChange.toTier)
    : null;
  const changeCadenceLabel = params.scheduledChange?.toCadence
    ? params.scheduledChange.toCadence === KiloPassCadence.Monthly
      ? 'Monthly'
      : 'Yearly'
    : null;
  const changeSuffix =
    params.subscription.cadence === KiloPassCadence.Monthly && changeTierLabel && changeCadenceLabel
      ? ` (change to ${changeTierLabel} ${changeCadenceLabel})`
      : '';

  const refillVerb = params.subscription.cadence === KiloPassCadence.Monthly ? 'Renews' : 'Refills';
  const labelPrefix = `${refillVerb} in ${refillsInDays} day${refillsInDays === 1 ? '' : 's'}${changeSuffix}`;

  return {
    kind: 'renews_and_adds_bonus',
    refillAtIso: params.refillAtIso,
    refillsInDays,
    baseUsd,
    bonusUsd,
    changeSuffix,
    labelPrefix,
  };
}

export function computeRenewInfoRowModel(params: {
  subscription: KiloPassActiveSubscriptionCardLogicSubscription;
  isPendingCancellation: boolean;
  scheduledChange: KiloPassScheduledChange;
  nowIso?: string;
}): RenewInfoRowModel[] {
  const { subscription, scheduledChange } = params;
  const now = params.nowIso ? dayjs(params.nowIso) : dayjs();

  const refillAtIso = subscription.refillAt ?? subscription.nextBillingAt ?? null;
  const nextBillingAtIso = subscription.nextBillingAt ?? null;

  const activeUntilRow = params.isPendingCancellation
    ? computeActiveUntilRowModel({ subscription, now })
    : null;

  const shouldShowRefillRow =
    !params.isPendingCancellation ||
    // When cancelling yearly, we still show the upcoming monthly refill row (unless last month).
    subscription.cadence === KiloPassCadence.Yearly;

  const shouldHideRefillRow = isRefillRowHiddenBecauseLastMonth({
    isPendingCancellation: params.isPendingCancellation,
    subscriptionCadence: subscription.cadence,
    refillAtIso,
    nextBillingAtIso,
  });

  const refillRow =
    shouldShowRefillRow && !shouldHideRefillRow && refillAtIso
      ? computeRefillRowModel({ subscription, scheduledChange, now, refillAtIso })
      : null;

  const rows: RenewInfoRowModel[] = [];
  if (refillRow) rows.push(refillRow);
  if (activeUntilRow) rows.push(activeUntilRow);
  return rows;
}

export type UsageProgressModel = {
  baseUsd: number;
  bonusUsd: number;
  usageUsd: number;
  nonNegativeUsageUsd: number;
  totalAvailableUsd: number;
  usagePctOfTotal: number;
  pctOfBaseInTotal: number;
  paidFillPct: number;
  bonusFillPct: number;
  isOverAvailable: boolean;
  statusClass: 'text-red-400' | 'text-emerald-300' | 'text-amber-300';
};

export function computeUsageProgressModel(params: {
  baseUsd: number | null | undefined;
  usageUsd: number | null | undefined;
  bonusUsd: number | null | undefined;
  isBonusUnlocked: boolean | null | undefined;
}): UsageProgressModel | null {
  const baseUsd = params.baseUsd;
  const usageUsd = params.usageUsd ?? 0;
  const bonusUsd = params.bonusUsd;

  if (typeof baseUsd !== 'number' || baseUsd <= 0) return null;
  if (typeof bonusUsd !== 'number' || bonusUsd <= 0) return null;

  const totalAvailableUsd = baseUsd + bonusUsd;
  const nonNegativeUsageUsd = Math.max(0, usageUsd);
  const usagePctOfTotal = Math.max(
    0,
    Math.min(100, (nonNegativeUsageUsd / totalAvailableUsd) * 100)
  );
  const pctOfBaseInTotal = Math.max(0, Math.min(100, (baseUsd / totalAvailableUsd) * 100));

  const paidFillPct = Math.min(usagePctOfTotal, pctOfBaseInTotal);
  const bonusFillPct = Math.max(0, usagePctOfTotal - pctOfBaseInTotal);

  const isOverAvailable = usageUsd > totalAvailableUsd;
  const statusClass: UsageProgressModel['statusClass'] = isOverAvailable
    ? 'text-red-400'
    : params.isBonusUnlocked
      ? 'text-emerald-300'
      : 'text-amber-300';

  return {
    baseUsd,
    bonusUsd,
    usageUsd,
    nonNegativeUsageUsd,
    totalAvailableUsd,
    usagePctOfTotal,
    pctOfBaseInTotal,
    paidFillPct,
    bonusFillPct,
    isOverAvailable,
    statusClass,
  };
}

export function computeNextBillingDateRowDateLabel(params: {
  subscriptionCadence: KiloPassCadence;
  isPendingCancellation: boolean;
  nextBillingDateLabel: string | null | undefined;
  subscriptionTier: KiloPassTier;
  scheduledChange: KiloPassScheduledChange;
}): string | null {
  if (params.subscriptionCadence !== KiloPassCadence.Yearly) return null;
  if (!params.nextBillingDateLabel) return null;
  if (params.isPendingCancellation) return null;

  const scheduledChange = params.scheduledChange;
  const fromMonthlyUsd = getMonthlyPriceUsd(scheduledChange?.fromTier ?? params.subscriptionTier);
  const toMonthlyUsd = scheduledChange?.toTier ? getMonthlyPriceUsd(scheduledChange.toTier) : null;
  const isYearlyTierUpgrade =
    scheduledChange?.fromCadence === KiloPassCadence.Yearly &&
    scheduledChange.toCadence === KiloPassCadence.Yearly &&
    typeof toMonthlyUsd === 'number' &&
    toMonthlyUsd > fromMonthlyUsd;

  const effectiveAtIso = isYearlyTierUpgrade ? (scheduledChange?.effectiveAt ?? null) : null;
  if (!effectiveAtIso) return params.nextBillingDateLabel;
  if (!dayjs(effectiveAtIso).utc().isValid()) return params.nextBillingDateLabel;
  return effectiveAtIso;
}
