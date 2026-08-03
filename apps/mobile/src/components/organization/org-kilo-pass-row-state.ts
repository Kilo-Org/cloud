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

const TIER_LABELS: Record<'tier_19' | 'tier_49' | 'tier_199', string> = {
  tier_19: '$19',
  tier_49: '$49',
  tier_199: '$199',
};

function paidSeatsLabel(count: number): string {
  return `${count} paid ${count === 1 ? 'seat' : 'seats'}`;
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
    ? `Ends ${ends} · ${activeSubtitle(agreement)}`
    : `Canceling · ${activeSubtitle(agreement)}`;
}

function manage(subtitle: string, attention = false): OrgKiloPassRowState {
  return {
    subtitle,
    attention,
    action: 'manage',
    actionLabel: null,
    accessibilityHint: 'Opens Kilo Pass management on web.',
    loading: false,
  };
}

/** Conditions needing admin attention, checked before commercial state (mirrors web `toCondition`). */
function conditionRow(
  condition: OrgKiloPassSummary['processingCondition']
): OrgKiloPassRowState | null {
  if (condition === 'suspended_for_review') {
    return manage('Payment needs attention', true);
  }
  if (condition === 'manual') {
    return manage('Processing needs review', true);
  }
  if (condition === 'blocked') {
    return manage('Processing blocked', true);
  }
  if (condition === 'overallocated') {
    return manage('Pass assignments exceed paid seats', true);
  }
  if (condition === 'failed') {
    return manage('Credit processing delayed · retrying automatically', true);
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
        subtitle: 'Could not load status',
        attention: true,
        action: 'retry',
        actionLabel: 'Retry',
        accessibilityHint: 'Retries loading Kilo Pass status.',
        loading: false,
      };
    }
    return {
      subtitle: 'Loading…',
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
      subtitle: 'Not subscribed',
      attention: false,
      action: 'setup',
      actionLabel: null,
      accessibilityHint: 'Opens Kilo Pass setup on web.',
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
    return manage('Payment pending');
  }
  if (data.state === 'requires_action') {
    return manage('Payment needs attention', true);
  }
  if (data.state === 'activating') {
    return manage('Activating');
  }
  if (data.commercialState === 'ended' || data.state === 'ended') {
    return manage('Ended');
  }
  if (data.state === 'blocked') {
    return manage('Processing blocked', true);
  }
  if (data.state === 'failed') {
    return manage('Credit processing delayed · retrying automatically', true);
  }
  // Remainder with an agreement row: safe to open detail.
  return manage('Not subscribed');
}
