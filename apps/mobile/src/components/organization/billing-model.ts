import { i18n } from '@/i18n';
import { formatDate, formatNumber, formatPrefixedMoney } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';

/**
 * The seat line item this screen reads. Stripe's own object is far wider; a
 * narrow structural input keeps the pure mapper free of tRPC/Stripe imports
 * and testable in a node environment, the pattern
 * `org-kilo-pass-row-state.ts` follows for the pass summary.
 */
type BillingSeatItem = Readonly<{
  id: string;
  current_period_end?: number | null;
}>;

type BillingSubscription = Readonly<{
  status: string;
  cancel_at_period_end?: boolean | null;
  current_period_end?: number | null;
  items: Readonly<{ data: readonly BillingSeatItem[] }>;
}>;

/** The `organizations.subscription.get` payload, as far as this screen reads it. */
export type OrgSeatSubscription = Readonly<{
  subscription: BillingSubscription | null;
  seatsUsed: number;
  totalSeats: number;
  nextSeatCount: number | null;
  nextSeatCountEffectiveAt: string | null;
  paidSeatItemId: string | null;
}>;

/** The `organizations.autoTopUp.getConfig` payload, as far as this screen reads it. */
export type OrgAutoTopUpConfig = Readonly<{
  enabled: boolean;
  amountCents: number;
  thresholdCents: number;
}>;

/**
 * The trial readout `organizations.list` carries for the active organization,
 * as far as these screens read it. Both fields are optional in practice on a
 * device that cached the list before they existed, so a missing value means
 * "no running trial" rather than an error.
 */
export type OrgTrialState = Readonly<{
  trialStatus: string | null | undefined;
  trialEndsAt: string | null | undefined;
}>;

type BillingStateTone = 'good' | 'warn' | 'danger' | 'muted';

export type BillingState = Readonly<{ label: string; tone: BillingStateTone }>;

/**
 * The four stages in which the trial is still running, mirroring the server's
 * `isRunningTrialStage`. The server publishes only these, so a device reads the
 * same predicate over the payload rather than re-deriving dates.
 */
const RUNNING_TRIAL_STATUSES = {
  trial_active: true,
  trial_ending_soon: true,
  trial_ending_very_soon: true,
  trial_expires_today: true,
} as const satisfies Record<string, true>;

/**
 * Statuses Stripe reports after it stops billing: the subscription exists in
 * the record, so the row states that it ended instead of pretending none was
 * ever bought. `unpaid` is not one of them: Stripe keeps the unpaid invoice
 * open and collectible, so that subscription is a payment failure the reader
 * can still fix rather than a plan that ended.
 */
const TERMINAL_STATUSES = {
  canceled: true,
  incomplete_expired: true,
} as const satisfies Record<string, true>;

/** The date the paid period ends, in whole seconds, from the seat line item. */
function periodEndSeconds(input: OrgSeatSubscription): number | null {
  const subscription = input.subscription;
  if (subscription == null) {
    return null;
  }
  const seatItem =
    subscription.items.data.find(entry => entry.id === input.paidSeatItemId) ??
    subscription.items.data[0];
  return seatItem?.current_period_end ?? subscription.current_period_end ?? null;
}

function formattedPeriodEnd(input: OrgSeatSubscription): string | null {
  const seconds = periodEndSeconds(input);
  if (seconds == null) {
    return null;
  }
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return formatDate(date, i18n.language, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The trial readout as a state pill, or `null` when the organization is not on
 * a running trial. Both surfaces that name the plan state read this one
 * function, so the copy and the criteria cannot drift between them.
 *
 * The date is parsed with `parseTimestamp`: `new Date()` throws on the
 * PostgreSQL timestamps Hermes cannot read, and the server sends the trial end
 * as an ISO instant either way.
 */
export function getOrgTrialStatusPill(trial: OrgTrialState): BillingState | null {
  const status = trial.trialStatus;
  if (status == null || !Object.hasOwn(RUNNING_TRIAL_STATUSES, status)) {
    return null;
  }
  const endsAt = trial.trialEndsAt;
  const date = endsAt == null ? null : parseTimestamp(endsAt);
  if (date == null || Number.isNaN(date.getTime())) {
    return { label: i18n.t('organization.billing.stateTrialing'), tone: 'good' };
  }
  return {
    label: i18n.t('organization.billing.stateTrialEndsOn', {
      date: formatDate(date, i18n.language, { year: 'numeric', month: 'short', day: 'numeric' }),
    }),
    tone: 'good',
  };
}

/**
 * What the subscription is doing, in the words the reader needs: whether it
 * renews, when it stops, or that it is past due. Nothing here re-derives the
 * plan gate — `isTrialExpiredForEnforcement` owns that.
 *
 * `trial` is the boundary row's trial readout. An organization inside its
 * Enterprise trial has bought no seats, so Stripe answers `null` and the row
 * would claim there is no subscription while the trial is running; the trial
 * branch speaks first in exactly that case. A subscription that does exist owns
 * the row, including its own `trialing` status.
 */
export function getOrgSubscriptionState(
  input: OrgSeatSubscription,
  trial?: OrgTrialState
): BillingState {
  const subscription = input.subscription;
  if (subscription == null) {
    const trialState = trial == null ? null : getOrgTrialStatusPill(trial);
    return trialState ?? { label: i18n.t('organization.billing.stateNone'), tone: 'muted' };
  }
  const { status } = subscription;
  const periodEnd = formattedPeriodEnd(input);
  // `unpaid` is the same money problem one step further on — Stripe stopped
  // retrying the card and left the invoice open — so it carries the past-due
  // row, as the web's `subscriptionStatusConfig` paints both red.
  if (status === 'past_due' || status === 'unpaid') {
    return { label: i18n.t('organization.billing.statePastDue'), tone: 'danger' };
  }
  if (status === 'incomplete') {
    return { label: i18n.t('kiloPass.statusIncomplete'), tone: 'warn' };
  }
  if (status === 'paused') {
    return { label: i18n.t('kiloPass.statusPaused'), tone: 'warn' };
  }
  if (Object.hasOwn(TERMINAL_STATUSES, status)) {
    return { label: i18n.t('organization.kiloPass.ended'), tone: 'muted' };
  }
  if (subscription.cancel_at_period_end === true) {
    return {
      label: periodEnd
        ? i18n.t('kiloPass.manage.cancelScheduled', { date: periodEnd })
        : i18n.t('organization.billing.stateCancelsAtPeriodEnd'),
      tone: 'warn',
    };
  }
  if (status === 'trialing') {
    return {
      label: periodEnd
        ? i18n.t('organization.billing.stateTrialEndsOn', { date: periodEnd })
        : i18n.t('organization.billing.stateTrialing'),
      tone: 'good',
    };
  }
  if (status === 'active') {
    return {
      label: periodEnd
        ? i18n.t('organization.billing.stateRenewsOn', { date: periodEnd })
        : i18n.t('kiloPass.statusActive'),
      tone: 'good',
    };
  }
  return { label: i18n.t('common.unknown'), tone: 'muted' };
}

/**
 * The scheduled seat decrease the plan carries into its next period, or null
 * when no decrease is pending. Stripe keeps the current quantity until the
 * period ends, so the row states both the target and the date.
 */
export function getScheduledSeatChange(input: OrgSeatSubscription): string | null {
  if (input.nextSeatCount == null || input.nextSeatCountEffectiveAt == null) {
    return null;
  }
  const date = parseTimestamp(input.nextSeatCountEffectiveAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return i18n.t('organization.billing.seatsDropTo', {
    seats: formatNumber(input.nextSeatCount, i18n.language),
    date: formatDate(date, i18n.language, { year: 'numeric', month: 'short', day: 'numeric' }),
  });
}

/** The used/total seat count, written once so both billing surfaces agree. */
export function formatSeatCount(used: number, total: number): string {
  return `${formatNumber(used, i18n.language)} / ${formatNumber(total, i18n.language)}`;
}

/** The auto top-up readout: whether it is on, and the two amounts it uses. */
export function getAutoTopUpReadout(config: OrgAutoTopUpConfig) {
  return {
    enabled: config.enabled,
    status: config.enabled ? i18n.t('common.enabled') : i18n.t('common.disabled'),
    amount: formatPrefixedMoney(config.amountCents / 100, i18n.language),
    threshold: formatPrefixedMoney(config.thresholdCents / 100, i18n.language),
  };
}

/** The manage-on-web link's wording, which follows the auto top-up config above it. */
export function getAutoTopUpLinkLabel(enabled: boolean | undefined): string {
  return enabled === true
    ? i18n.t('organization.billing.manageAutoTopUp')
    : i18n.t('organization.billing.setupAutoTopUp');
}
