import { i18n } from '@/i18n';
import { formatDate, parseTimestamp } from '@/lib/utils';

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
  /**
   * What pressing the row does. `manage` opens the web detail page, `setup`
   * opens the web setup flow, `retry` refetches the summary, `none` renders
   * an inert row. Loading and query-error states must not offer a web action:
   * loading has nothing to open yet, and an unresolved summary could send the
   * user somewhere misleading.
   */
  action: 'none' | 'retry' | 'setup' | 'manage';
  /** Trailing action label (only for `retry`). */
  actionLabel: string | null;
  /** Accessibility hint for the press action; null for inert rows. */
  accessibilityHint: string | null;
  /** True only while the summary loads — drives `accessibilityState.busy`. */
  loading: boolean;
};

const TIER_LABELS = {
  tier_19: '$19',
  tier_49: '$49',
  tier_199: '$199',
} satisfies Record<'tier_19' | 'tier_49' | 'tier_199', string>;

function paidSeatsLabel(count: number): string {
  return i18n.t(
    count === 1 ? 'organization.kiloPass.paidSeatOne' : 'organization.kiloPass.paidSeatOther',
    { count }
  );
}

function activeSubtitle(agreement: NonNullable<OrgKiloPassSummary['agreement']>): string {
  return `${TIER_LABELS[agreement.tier]} · ${paidSeatsLabel(agreement.paidSeatCount)}`;
}

/** `paidThrough` arrives as a PostgreSQL timestamp; Hermes needs `parseTimestamp`. */
function formatPeriodEnd(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const date = parseTimestamp(iso);
  return Number.isNaN(date.getTime()) ? null : formatDate(date);
}

function cancelingSubtitle(agreement: NonNullable<OrgKiloPassSummary['agreement']>): string {
  const ends = formatPeriodEnd(agreement.paidThrough);
  return ends
    ? `${i18n.t('organization.kiloPass.endsOn', { date: ends })} · ${activeSubtitle(agreement)}`
    : `${i18n.t('organization.kiloPass.canceling')} · ${activeSubtitle(agreement)}`;
}

function manage(subtitle: string, attention = false): OrgKiloPassRowState {
  return {
    subtitle,
    attention,
    action: 'manage',
    actionLabel: null,
    accessibilityHint: i18n.t('organization.kiloPass.manageHint'),
    loading: false,
  };
}

/** Conditions needing admin attention, checked before commercial state (mirrors web `toCondition`). */
function conditionRow(
  condition: OrgKiloPassSummary['processingCondition']
): OrgKiloPassRowState | null {
  if (condition === 'suspended_for_review') {
    return manage(i18n.t('organization.kiloPass.paymentNeedsAttention'), true);
  }
  if (condition === 'manual') {
    return manage(i18n.t('organization.kiloPass.processingNeedsReview'), true);
  }
  if (condition === 'blocked') {
    return manage(i18n.t('organization.kiloPass.processingBlocked'), true);
  }
  if (condition === 'overallocated') {
    return manage(i18n.t('organization.kiloPass.overallocated'), true);
  }
  if (condition === 'failed') {
    return manage(i18n.t('organization.kiloPass.creditProcessingDelayed'), true);
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
        actionLabel: i18n.t('organization.kiloPass.retry'),
        accessibilityHint: i18n.t('organization.kiloPass.retryHint'),
        loading: false,
      };
    }
    return {
      subtitle: i18n.t('organization.kiloPass.loading'),
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
    // `getSummary` returns a null agreement only when no agreement row exists
    // at all (`state: 'unavailable'`). The web detail page's `detail` query
    // throws for those orgs, so the setup flow is the only safe destination.
    return {
      subtitle: i18n.t('organization.kiloPass.notSubscribed'),
      attention: false,
      action: 'setup',
      actionLabel: null,
      accessibilityHint: i18n.t('organization.kiloPass.setupHint'),
      loading: false,
    };
  }

  const condition = conditionRow(data.processingCondition);
  if (condition) {
    return condition;
  }

  if (data.commercialState === 'active') {
    return manage(activeSubtitle(agreement));
  }
  if (data.commercialState === 'cancel_at_period_end') {
    return manage(cancelingSubtitle(agreement));
  }
  if (data.commercialState === 'pending_payment' || data.state === 'pending_payment') {
    return manage(i18n.t('organization.kiloPass.paymentPending'));
  }
  if (data.state === 'requires_action') {
    return manage(i18n.t('organization.kiloPass.paymentNeedsAttention'), true);
  }
  if (data.state === 'activating') {
    return manage(i18n.t('organization.kiloPass.activating'));
  }
  if (data.commercialState === 'ended' || data.state === 'ended') {
    return manage(i18n.t('organization.kiloPass.ended'));
  }
  if (data.state === 'blocked') {
    return manage(i18n.t('organization.kiloPass.processingBlocked'), true);
  }
  if (data.state === 'failed') {
    return manage(i18n.t('organization.kiloPass.creditProcessingDelayed'), true);
  }
  // Remainder with an agreement row: safe to open detail.
  return manage(i18n.t('organization.kiloPass.notSubscribed'));
}
