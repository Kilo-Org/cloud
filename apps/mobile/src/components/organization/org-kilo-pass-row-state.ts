import { i18n } from '@/i18n';
import { formatDate, formatNumber, formatUsd } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';

/**
 * Minimal structural shape of the `trpc.organizations.kiloPass.summary`
 * output needed here (mirrors `subscription-card-state.ts`, which also takes
 * a narrow local input type so the pure mapper stays free of tRPC/RN imports
 * and testable in a node environment). The screen passes the real tRPC
 * result; structural typing keeps the two in lockstep.
 */
export type OrgKiloPassSummary = {
  state:
    | 'unavailable'
    | 'pending_payment'
    | 'requires_action'
    | 'activating'
    | 'active'
    | 'cancel_at_period_end'
    | 'ended'
    | 'blocked'
    | 'failed';
  commercialState: 'pending_payment' | 'active' | 'cancel_at_period_end' | 'ended' | null;
  processingCondition:
    | 'ready'
    | 'manual'
    | 'blocked'
    | 'overallocated'
    | 'failed'
    | 'suspended_for_review'
    | null;
  agreement: {
    tier: 'tier_19' | 'tier_49' | 'tier_199';
    paidSeatCount: number;
    planVersion: number;
    paidThrough: string | null;
  } | null;
};

export type OrgKiloPassRowState = {
  /** One-line state summary under the "Kilo Pass" title. */
  subtitle: string;
  /** Warn-tint the icon tile for states needing org-admin attention or action. */
  attention: boolean;
  /** Only query failures offer an action. Subscription state stays read-only. */
  action: 'none' | 'retry';
  /** Trailing action label (only for `retry`). */
  actionLabel: string | null;
  /** Accessibility hint for the press action; null for inert rows. */
  accessibilityHint: string | null;
  /** True only while the summary loads — drives `accessibilityState.busy`. */
  loading: boolean;
};

const TIER_PRICES = { tier_19: 19, tier_49: 49, tier_199: 199 } as const;

function paidSeatsLabel(count: number): string {
  return i18n.t('organization.kiloPass.paidSeat', {
    count,
    displayCount: formatNumber(count, i18n.language),
  });
}

function activeSubtitle(agreement: NonNullable<OrgKiloPassSummary['agreement']>): string {
  const tierPrice = formatUsd(TIER_PRICES[agreement.tier], i18n.language, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `${tierPrice} · ${paidSeatsLabel(agreement.paidSeatCount)}`;
}

/** `paidThrough` arrives as a PostgreSQL timestamp; Hermes needs `parseTimestamp`. */
function formatPeriodEnd(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const date = parseTimestamp(iso);
  return Number.isNaN(date.getTime()) ? null : formatDate(date, i18n.language);
}

function cancelingSubtitle(agreement: NonNullable<OrgKiloPassSummary['agreement']>): string {
  const ends = formatPeriodEnd(agreement.paidThrough);
  return ends
    ? `${i18n.t('common.ends', { date: ends })} · ${activeSubtitle(agreement)}`
    : `${i18n.t('organization.kiloPass.canceling')} · ${activeSubtitle(agreement)}`;
}

function statusRow(subtitle: string, attention = false): OrgKiloPassRowState {
  return {
    subtitle,
    attention,
    action: 'none',
    actionLabel: null,
    accessibilityHint: null,
    loading: false,
  };
}

/** Conditions needing admin attention, checked before commercial state (mirrors web `toCondition`). */
function conditionRow(
  condition: OrgKiloPassSummary['processingCondition']
): OrgKiloPassRowState | null {
  if (condition === 'suspended_for_review') {
    return statusRow(i18n.t('organization.kiloPass.paymentNeedsAttention'), true);
  }
  if (condition === 'manual') {
    return statusRow(i18n.t('organization.kiloPass.processingNeedsReview'), true);
  }
  if (condition === 'blocked') {
    return statusRow(i18n.t('organization.kiloPass.processingBlocked'), true);
  }
  if (condition === 'overallocated') {
    return statusRow(i18n.t('organization.kiloPass.overallocated'), true);
  }
  if (condition === 'failed') {
    return statusRow(i18n.t('organization.kiloPass.creditProcessingDelayed'), true);
  }
  return null;
}

export function getOrgKiloPassRowState(params: {
  data: OrgKiloPassSummary | undefined;
  isError: boolean;
}): OrgKiloPassRowState {
  const { data } = params;
  if (data == null) {
    if (params.isError) {
      return {
        subtitle: i18n.t('organization.kiloPass.couldNotLoadStatus'),
        attention: true,
        action: 'retry',
        actionLabel: i18n.t('common.retry'),
        accessibilityHint: i18n.t('organization.kiloPass.retryHint'),
        loading: false,
      };
    }
    return {
      subtitle: i18n.t('common.loading'),
      attention: false,
      action: 'none',
      actionLabel: null,
      accessibilityHint: null,
      loading: true,
    };
  }

  // Stale data beats a background refetch error: only the no-data case above
  // surfaces the retryable error row.
  const { agreement } = data;
  if (agreement == null) {
    return {
      subtitle: i18n.t('organization.kiloPass.notSubscribed'),
      attention: false,
      action: 'none',
      actionLabel: null,
      accessibilityHint: null,
      loading: false,
    };
  }

  const condition = conditionRow(data.processingCondition);
  if (condition) {
    return condition;
  }

  if (data.commercialState === 'active') {
    return statusRow(activeSubtitle(agreement));
  }
  if (data.commercialState === 'cancel_at_period_end') {
    return statusRow(cancelingSubtitle(agreement));
  }
  if (data.commercialState === 'pending_payment' || data.state === 'pending_payment') {
    return statusRow(i18n.t('organization.kiloPass.paymentPending'));
  }
  if (data.state === 'requires_action') {
    return statusRow(i18n.t('organization.kiloPass.paymentNeedsAttention'), true);
  }
  if (data.state === 'activating') {
    return statusRow(i18n.t('organization.kiloPass.activating'));
  }
  if (data.commercialState === 'ended' || data.state === 'ended') {
    return statusRow(i18n.t('organization.kiloPass.ended'));
  }
  if (data.state === 'blocked') {
    return statusRow(i18n.t('organization.kiloPass.processingBlocked'), true);
  }
  if (data.state === 'failed') {
    return statusRow(i18n.t('organization.kiloPass.creditProcessingDelayed'), true);
  }
  return statusRow(i18n.t('organization.kiloPass.notSubscribed'));
}
