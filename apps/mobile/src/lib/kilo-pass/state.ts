import { KILO_PASS_TITLE } from '@kilocode/app-shared/commerce';

import { i18n } from '@/i18n';
import { formatDate, formatUsd } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';

/**
 * The subscription fields this surface reads. The tRPC payload's enum members
 * are assignable to these literals, so the screen passes its data unchanged
 * while the mapper stays a pure function a node test can call.
 */
export type KiloPassSubscription = {
  tier: 'tier_19' | 'tier_49' | 'tier_199';
  cadence: 'monthly' | 'yearly';
  /** The provider reports statuses as an open set. */
  status: string;
  cancelAtPeriodEnd: boolean;
  resumesAt: string | null;
  nextBillingAt: string | null;
  refillAt: string | null;
  currentPeriodBaseCreditsUsd: number;
  currentPeriodUsageUsd: number;
  currentPeriodBonus: {
    status: 'available' | 'issued';
    kind: 'bonus' | 'referral_bonus' | 'promo_first_month_50pct' | null;
    actualAmountUsd: number | null;
    projectedAmountUsd: number | null;
  } | null;
};

/**
 * Provider statuses a pass can no longer bill from. The server reports the
 * provider's value unchanged, so the set is written here instead of trusting
 * a fixed count.
 */
const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired', 'unpaid']);

/** The plan's tier name, keyed by the tier the server stores. */
const TIER_LABEL_KEYS = {
  tier_19: 'kiloPass.tierStarter',
  tier_49: 'kiloPass.tierPro',
  tier_199: 'kiloPass.tierExpert',
} as const satisfies Record<KiloPassSubscription['tier'], string>;

const CADENCE_LABEL_KEYS = {
  monthly: 'kiloPass.cadenceMonthly',
  yearly: 'kiloPass.cadenceYearly',
} as const satisfies Record<KiloPassSubscription['cadence'], string>;

type KiloPassRow = {
  id: 'renewal' | 'usage' | 'bonus';
  label: string;
  value: string;
};

export type KiloPassDetail =
  | { kind: 'none' }
  | { kind: 'ended' }
  | {
      kind: 'active';
      planLabel: string;
      statusLabel: string;
      /** `danger` marks a pass whose payment needs the reader's attention. */
      statusTone: 'default' | 'danger';
      rows: readonly KiloPassRow[];
    };

type KiloPassDetailState = KiloPassDetail | { kind: 'loading' } | { kind: 'error' };

type KiloPassQueryFields = {
  subscription: KiloPassSubscription | null | undefined;
  isError: boolean;
  isPending: boolean;
};

function formatIsoDate(iso: string | null | undefined): string | null {
  if (!iso) {
    return null;
  }
  const date = parseTimestamp(iso);
  return Number.isNaN(date.getTime())
    ? null
    : formatDate(date, i18n.language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
}

function planLabel(subscription: KiloPassSubscription): string {
  return `${i18n.t(TIER_LABEL_KEYS[subscription.tier])} · ${i18n.t(CADENCE_LABEL_KEYS[subscription.cadence])}`;
}

function statusLabel(subscription: KiloPassSubscription): string {
  if (subscription.cancelAtPeriodEnd) {
    return i18n.t('organization.kiloPass.canceling');
  }
  switch (subscription.status) {
    case 'trialing': {
      return i18n.t('kiloPass.statusTrialing');
    }
    case 'past_due': {
      return i18n.t('kiloPass.statusPastDue');
    }
    case 'incomplete': {
      return i18n.t('kiloPass.statusIncomplete');
    }
    case 'paused': {
      return i18n.t('kiloPass.statusPaused');
    }
    default: {
      return i18n.t('kiloPass.statusActive');
    }
  }
}

function currentPeriodBonus(
  subscription: KiloPassSubscription
): { label: string; amountUsd: number } | null {
  const bonus = subscription.currentPeriodBonus;
  if (!bonus) {
    return null;
  }
  if (bonus.status === 'issued') {
    const amountUsd = bonus.actualAmountUsd;
    if (amountUsd === null || amountUsd <= 0) {
      return null;
    }
    return {
      amountUsd,
      label: i18n.t(
        bonus.kind === 'referral_bonus' ? 'kiloPass.bonusReferral' : 'kiloPass.bonusFree'
      ),
    };
  }
  const amountUsd = bonus.projectedAmountUsd;
  if (amountUsd === null || amountUsd <= 0) {
    return null;
  }
  return { amountUsd, label: i18n.t('kiloPass.bonusAvailable') };
}

function renewalRow(subscription: KiloPassSubscription): KiloPassRow | null {
  // A scheduled cancellation wins over a pause: the pass stops for good on the
  // paid-through date, so a resume date would contradict the status line.
  if (!subscription.cancelAtPeriodEnd && subscription.status === 'paused') {
    const resumedAt = formatIsoDate(subscription.resumesAt);
    return resumedAt
      ? { id: 'renewal', label: i18n.t('kiloPass.resumes'), value: resumedAt }
      : null;
  }

  const at = subscription.nextBillingAt ?? subscription.refillAt;
  const date = formatIsoDate(at);
  if (!date) {
    return null;
  }
  return {
    id: 'renewal',
    label: i18n.t(subscription.cancelAtPeriodEnd ? 'kiloPass.activeUntil' : 'kiloPass.renews'),
    value: date,
  };
}

function usageRow(subscription: KiloPassSubscription, bonusUsd: number): KiloPassRow | null {
  const baseUsd = subscription.currentPeriodBaseCreditsUsd;
  if (!(baseUsd > 0)) {
    return null;
  }
  const usedUsd = Math.max(0, subscription.currentPeriodUsageUsd);
  const totalUsd = baseUsd + bonusUsd;
  return {
    id: 'usage',
    label: i18n.t('kiloPass.usageThisMonth'),
    value: `${formatUsd(usedUsd, i18n.language)} / ${formatUsd(totalUsd, i18n.language)}`,
  };
}

function activeRows(subscription: KiloPassSubscription): KiloPassRow[] {
  const bonus = currentPeriodBonus(subscription);
  const rows: KiloPassRow[] = [];

  const renewal = renewalRow(subscription);
  if (renewal) {
    rows.push(renewal);
  }

  const usage = usageRow(subscription, bonus?.amountUsd ?? 0);
  if (usage) {
    rows.push(usage);
  }

  if (bonus) {
    rows.push({
      id: 'bonus',
      label: bonus.label,
      value: formatUsd(bonus.amountUsd, i18n.language),
    });
  }

  return rows;
}

/**
 * Derive the Kilo Pass surface from the account's own pass state. The app never
 * sells a pass, so only the pass details and the no-pass message can show.
 */
export function getKiloPassDetailState(params: KiloPassQueryFields): KiloPassDetailState {
  const subscription = params.subscription;
  // Cached data beats a background refetch failure: a pass already on screen
  // must not turn into an error row every time a foreground refetch fails.
  if (subscription) {
    if (ENDED_STATUSES.has(subscription.status)) {
      return { kind: 'ended' };
    }
    return {
      kind: 'active',
      planLabel: planLabel(subscription),
      statusLabel: statusLabel(subscription),
      statusTone:
        subscription.status === 'past_due' || subscription.status === 'incomplete'
          ? 'danger'
          : 'default',
      rows: activeRows(subscription),
    };
  }
  if (params.isError) {
    return { kind: 'error' };
  }
  if (params.isPending) {
    return { kind: 'loading' };
  }
  return { kind: 'none' };
}

export type KiloPassCardContentState =
  | { kind: 'loading' }
  | { kind: 'error'; title: string; description: string; actionLabel: string }
  | { kind: 'card'; title: string; description: string; accessibilityLabel: string };

/**
 * The profile card carries the same two user-visible states as the screen, in
 * one line under the plan title. Its press opens the modal, which owns the
 * details; the card never opens an external page.
 */
export function getKiloPassCardContentState(params: KiloPassQueryFields): KiloPassCardContentState {
  const state = getKiloPassDetailState(params);

  if (state.kind === 'loading') {
    return { kind: 'loading' };
  }
  if (state.kind === 'error') {
    return {
      kind: 'error',
      title: i18n.t('kiloPass.unavailable'),
      description: i18n.t('kiloPass.tryAgainFromProfile'),
      actionLabel: i18n.t('common.retry'),
    };
  }

  // The card states what the account has, in one line; the plan price and the
  // rest of the detail belong to the screen the press opens.
  if (state.kind === 'none') {
    return cardState(i18n.t('kiloPass.notAvailableInApp'));
  }
  if (state.kind === 'ended') {
    return cardState(i18n.t('kiloPass.purchaseUnavailableEnded'));
  }
  return cardState(state.statusLabel);
}

function cardState(description: string): KiloPassCardContentState {
  return {
    kind: 'card',
    title: KILO_PASS_TITLE,
    description,
    accessibilityLabel: [KILO_PASS_TITLE, description].join(i18n.t('common.sentenceJoiner')),
  };
}
