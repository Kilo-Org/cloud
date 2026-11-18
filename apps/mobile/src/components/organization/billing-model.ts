import { i18n } from '@/i18n';
import { isolateLtrBidiText } from '@/lib/bidi';
import { isRunningTrialStage } from '@kilocode/app-shared/organizations';
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

/**
 * `default` paints the readout in the row's ordinary ink, for a state that is
 * a fact rather than a verdict — a running trial that ends, not a success.
 */
type BillingStateTone = 'default' | 'good' | 'warn' | 'danger' | 'muted';

export type BillingState = Readonly<{ label: string; tone: BillingStateTone }>;

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
 * function, so the copy and the criteria cannot drift between them. The
 * running-stage set is the server's own predicate
 * (`isRunningTrialStage` in `@kilocode/app-shared/organizations`, defined in
 * `@kilocode/organization-entitlement` beside the day-boundary classifier), so
 * a renamed stage fails there at type time, and the entitlement suite ties the
 * set to the classifier's output day by day, which fails if a new stage is
 * added without joining the set.
 *
 * The date is parsed with `parseTimestamp`: `new Date()` throws on the
 * PostgreSQL timestamps Hermes cannot read, and the server sends the trial end
 * as an ISO instant either way.
 */
export function getOrgTrialStatusPill(trial: OrgTrialState): BillingState | null {
  if (!isRunningTrialStage(trial.trialStatus)) {
    return null;
  }
  const endsAt = trial.trialEndsAt;
  const date = endsAt == null ? null : parseTimestamp(endsAt);
  // Neutral ink: the end date is a fact the reader schedules around, not a
  // success badge — the only saturated green value on a screen of facts pulled
  // the eye off the plan.
  if (date == null || Number.isNaN(date.getTime())) {
    return { label: i18n.t('organization.billing.stateTrialing'), tone: 'default' };
  }
  return {
    label: i18n.t('organization.billing.stateTrialEndsOn', {
      date: formatDate(date, i18n.language, { year: 'numeric', month: 'short', day: 'numeric' }),
    }),
    tone: 'default',
  };
}

/**
 * What the subscription is doing, in the words the reader needs: whether it
 * renews, when it stops, or that it is past due. Nothing here re-derives the
 * plan gate — `isTrialExpiredForEnforcement` owns that.
 *
 * `trial` is the boundary row's trial readout, and it speaks first: the server
 * publishes a running trial only when no paying seat subscription exists, so a
 * Stripe row that has stopped paying (`canceled`, `unpaid`, `paused`) can sit
 * beside a trial that still governs the organization, and the server's verdict
 * outranks a record that exists but does not pay. A `null` readout leaves the
 * subscription to own the row exactly as before, including its own `trialing`
 * status.
 */
export function getOrgSubscriptionState(
  input: OrgSeatSubscription,
  trial?: OrgTrialState
): BillingState {
  const trialState = trial == null ? null : getOrgTrialStatusPill(trial);
  if (trialState != null) {
    return trialState;
  }
  const subscription = input.subscription;
  if (subscription == null) {
    return { label: i18n.t('organization.billing.stateNone'), tone: 'muted' };
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
      // Same words as the trial-without-subscription branch above, so the same
      // neutral ink: one screen must not paint one state two colours.
      tone: 'default',
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

/** What the seats row paints: the fraction only for seats its org bought. */
export type SeatCountReadoutInput = Readonly<{
  /** The enforcement switch; a row with no seats bought prints the used count. */
  seatsEnforced: boolean;
  used: number;
  total: number;
}>;

/**
 * The seats row's value, shared by the hub and the billing screen. A total is
 * printed only when the organization enforces seats and actually bought some:
 * `getOrganizationSeatUsage` answers `seat_count || 0`, so a legacy
 * organization would read `3 / 0` — a row that reads as over capacity on the
 * day it was created. Otherwise the row states the used count alone, and the
 * row keeps its shape on the frame the seats read lands. The fraction runs
 * in a left-to-right isolate, so an interface direction cannot mirror either
 * number.
 */
export function seatCountReadout({ seatsEnforced, used, total }: SeatCountReadoutInput): string {
  return seatsEnforced && total > 0
    ? isolateLtrBidiText(formatSeatCount(used, total))
    : formatNumber(used, i18n.language);
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
