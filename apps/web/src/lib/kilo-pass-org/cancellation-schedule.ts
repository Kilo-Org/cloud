import 'server-only';

import type Stripe from 'stripe';
import { captureMessage } from '@sentry/nextjs';
import { client as stripe } from '@/lib/stripe-client';
import { warnExceptInTest } from '@/lib/utils.server';

export const ORGANIZATION_KILO_PASS_CANCELLATION_ORIGIN = 'kilo-pass-org-cancellation';
export const SCHEDULE_REWRITE_UNSAFE = 'SCHEDULE_REWRITE_UNSAFE';

type Phase = Stripe.SubscriptionSchedule.Phase;
type PhaseItem = Stripe.SubscriptionSchedule.Phase.Item;
type PhaseParams = Stripe.SubscriptionScheduleUpdateParams.Phase;
type PhaseItemParams = Stripe.SubscriptionScheduleUpdateParams.Phase.Item;

export type ScheduleItem = { price: string; quantity: number };

export type OrganizationKiloPassScheduleShape =
  | { kind: 'idle'; activePhase: Phase | null }
  | { kind: 'removal_pending'; activePhase: Phase; removalPhase: Phase }
  | { kind: 'unsafe'; reason: string };

export type OrganizationKiloPassScheduleEvent =
  | 'cancel'
  | 'resume'
  | 'checkout'
  | 'seat_update'
  | 'pass_item_removed';

export type OrganizationKiloPassCheckoutScheduleErrorReason =
  | 'schedule_conflict'
  | 'schedule_release_failed'
  | 'schedule_inspection_failed';

export class OrganizationKiloPassCheckoutScheduleError extends Error {
  readonly reason: OrganizationKiloPassCheckoutScheduleErrorReason;

  constructor(reason: OrganizationKiloPassCheckoutScheduleErrorReason) {
    super(`KILO_PASS_ORG_CHECKOUT_${reason.toUpperCase()}`);
    this.name = 'OrganizationKiloPassCheckoutScheduleError';
    this.reason = reason;
  }
}

const TERMINAL_SCHEDULE_STATUSES: ReadonlySet<Stripe.SubscriptionSchedule.Status> = new Set([
  'released',
  'completed',
  'canceled',
]);

export function isTerminalScheduleStatus(status: Stripe.SubscriptionSchedule.Status): boolean {
  return TERMINAL_SCHEDULE_STATUSES.has(status);
}

export function isOwnedCancellationSchedule(schedule: Stripe.SubscriptionSchedule): boolean {
  return schedule.metadata?.origin === ORGANIZATION_KILO_PASS_CANCELLATION_ORIGIN;
}

function referenceId(reference: string | { id: string }): string {
  return typeof reference === 'string' ? reference : reference.id;
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

export function phaseItemPriceId(item: Pick<PhaseItem, 'price'>): string {
  return referenceId(item.price);
}

export function subscriptionScheduleItems(
  subscription: Stripe.Subscription,
  quantities: ReadonlyMap<string, number> = new Map()
): ScheduleItem[] {
  return subscription.items.data.map(item => ({
    price: item.price.id,
    quantity: quantities.get(item.id) ?? item.quantity ?? 1,
  }));
}

export function subscriptionScheduleItemsWithout(
  subscription: Stripe.Subscription,
  removedItemId: string,
  quantities: ReadonlyMap<string, number> = new Map()
): ScheduleItem[] {
  return subscriptionScheduleItems(
    {
      ...subscription,
      items: {
        ...subscription.items,
        data: subscription.items.data.filter(item => item.id !== removedItemId),
      },
    },
    quantities
  );
}

function itemKeys(items: readonly ScheduleItem[]): string[] {
  return items.map(item => `${item.price}\u0000${item.quantity}`).sort();
}

function phaseItemsMatch(phase: Phase, expected: readonly ScheduleItem[]): boolean {
  const actual = itemKeys(
    phase.items.map(item => ({ price: phaseItemPriceId(item), quantity: item.quantity ?? 1 }))
  );
  const wanted = itemKeys(expected);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export async function retrieveAttachedSchedule(
  subscription: Pick<Stripe.Subscription, 'schedule'>
): Promise<Stripe.SubscriptionSchedule | null> {
  const reference = subscription.schedule;
  if (!reference) return null;
  const schedule =
    typeof reference === 'string'
      ? await stripe.subscriptionSchedules.retrieve(reference)
      : reference;
  return isTerminalScheduleStatus(schedule.status) ? null : schedule;
}

/**
 * Stripe keeps ended phases in `phases`; only the current phase and later
 * phases constrain what a rewrite or release can change.
 */
export function activeAndFuturePhases(
  schedule: Stripe.SubscriptionSchedule,
  now: Date = new Date()
): { activePhase: Phase | null; futurePhases: Phase[] } {
  const current = schedule.current_phase;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const activePhase =
    (current
      ? (schedule.phases.find(
          phase => phase.start_date === current.start_date && phase.end_date === current.end_date
        ) ??
        schedule.phases.find(
          phase => phase.start_date <= current.start_date && current.start_date < phase.end_date
        ))
      : schedule.phases.find(
          phase => phase.start_date <= nowSeconds && nowSeconds < phase.end_date
        )) ?? null;
  const boundary = activePhase?.end_date ?? current?.end_date ?? nowSeconds;
  const futurePhases = schedule.phases.filter(
    phase => phase !== activePhase && phase.start_date >= boundary
  );
  return { activePhase, futurePhases };
}

function unsupportedPhaseSetting(phase: Phase): string | null {
  if ((phase.add_invoice_items ?? []).length > 0) return 'phase_add_invoice_items';
  if (isPresent(phase.application_fee_percent)) return 'phase_application_fee_percent';
  if (isPresent(phase.billing_thresholds)) return 'phase_billing_thresholds';
  if (isPresent(phase.on_behalf_of)) return 'phase_on_behalf_of';
  if (isPresent(phase.transfer_data)) return 'phase_transfer_data';
  if (isPresent(phase.trial_end)) return 'phase_trial_end';
  if (phase.billing_cycle_anchor === 'phase_start') return 'phase_billing_cycle_anchor';
  if ((phase.discounts ?? []).some(discount => !discount.discount)) {
    return 'phase_unreusable_discount';
  }
  for (const item of phase.items) {
    if (isPresent(item.billing_thresholds)) return 'item_billing_thresholds';
    if ((item.discounts ?? []).some(discount => !discount.discount)) {
      return 'item_unreusable_discount';
    }
  }
  return null;
}

/**
 * Classifies an owned cancellation schedule against the live subscription.
 * Only exact price and quantity matches are accepted: `idle` phases all keep
 * the current items, and `removal_pending` keeps them until `periodEnd` and
 * then removes only the pass item.
 */
export function classifyCancellationSchedule(input: {
  schedule: Stripe.SubscriptionSchedule;
  currentItems: readonly ScheduleItem[];
  retainedItems: readonly ScheduleItem[];
  periodEnd: number;
  now?: Date;
}): OrganizationKiloPassScheduleShape {
  if (input.schedule.default_settings?.billing_cycle_anchor === 'phase_start') {
    return { kind: 'unsafe', reason: 'default_billing_cycle_anchor' };
  }
  const { activePhase, futurePhases } = activeAndFuturePhases(input.schedule, input.now);
  const relevant = activePhase ? [activePhase, ...futurePhases] : futurePhases;
  if (relevant.length === 0) return { kind: 'unsafe', reason: 'no_active_or_future_phase' };
  const labels: ('current' | 'retained')[] = [];
  for (const phase of relevant) {
    const unsupported = unsupportedPhaseSetting(phase);
    if (unsupported) return { kind: 'unsafe', reason: unsupported };
    if (phaseItemsMatch(phase, input.currentItems)) labels.push('current');
    else if (phaseItemsMatch(phase, input.retainedItems)) labels.push('retained');
    else return { kind: 'unsafe', reason: 'phase_items_mismatch' };
  }
  if (labels.every(label => label === 'current')) return { kind: 'idle', activePhase };
  const [removalPhase] = futurePhases;
  if (
    activePhase &&
    removalPhase &&
    futurePhases.length === 1 &&
    labels[0] === 'current' &&
    labels[1] === 'retained'
  ) {
    if (activePhase.end_date !== input.periodEnd) {
      return { kind: 'unsafe', reason: 'removal_boundary_not_period_end' };
    }
    return { kind: 'removal_pending', activePhase, removalPhase };
  }
  return { kind: 'unsafe', reason: 'unexpected_phase_sequence' };
}

/**
 * An omitted phase `discounts` inherits the customer's discount, so a phase
 * that explicitly has none is re-sent as Stripe's empty-string clear value.
 * Empty tax rate lists are sent the same way so a rewrite cannot pick up
 * subscription defaults the retrieved phase did not have.
 */
function reusableDiscounts(
  discounts: readonly { discount: string | Stripe.Discount | null }[] | null | undefined
): { discount: string }[] | '' | undefined {
  if (!discounts) return undefined;
  if (discounts.length === 0) return '';
  const ids = discounts.map(discount => discount.discount).filter(isPresent);
  return ids.length ? ids.map(discount => ({ discount: referenceId(discount) })) : undefined;
}

function taxRateIds(
  rates: readonly Stripe.TaxRate[] | null | undefined
): string[] | '' | undefined {
  if (!rates) return undefined;
  return rates.length ? rates.map(rate => rate.id) : '';
}

function itemParams(item: ScheduleItem, source: PhaseItem | undefined): PhaseItemParams {
  const discounts = reusableDiscounts(source?.discounts);
  const taxRates = taxRateIds(source?.tax_rates);
  return {
    price: item.price,
    quantity: item.quantity,
    ...(discounts !== undefined ? { discounts } : {}),
    ...(source?.metadata ? { metadata: source.metadata } : {}),
    ...(taxRates !== undefined ? { tax_rates: taxRates } : {}),
  };
}

function automaticTaxParams(
  automaticTax: Phase['automatic_tax']
): PhaseParams['automatic_tax'] | undefined {
  if (!automaticTax) return undefined;
  const liability = automaticTax.liability;
  return {
    enabled: automaticTax.enabled,
    ...(liability
      ? {
          liability: {
            type: liability.type,
            ...(liability.account ? { account: referenceId(liability.account) } : {}),
          },
        }
      : {}),
  };
}

function invoiceSettingsParams(
  settings: Phase['invoice_settings']
): PhaseParams['invoice_settings'] | undefined {
  if (!settings) return undefined;
  const accountTaxIds = (settings.account_tax_ids ?? []).map(referenceId);
  const issuer = settings.issuer;
  return {
    ...(accountTaxIds.length ? { account_tax_ids: accountTaxIds } : {}),
    ...(isPresent(settings.days_until_due) ? { days_until_due: settings.days_until_due } : {}),
    ...(issuer
      ? {
          issuer: {
            type: issuer.type,
            ...(issuer.account ? { account: referenceId(issuer.account) } : {}),
          },
        }
      : {}),
  };
}

/**
 * Schedule updates replace every phase field that is omitted. Re-send the
 * supported settings from the retrieved phase so a rewrite only changes items.
 * Unsupported settings are rejected earlier by `classifyCancellationSchedule`.
 */
export function phaseUpdateParams(
  source: Phase | null,
  items: readonly ScheduleItem[],
  dates: { start_date?: number; end_date?: number } = {}
): PhaseParams {
  const discounts = reusableDiscounts(source?.discounts);
  const defaultTaxRates = taxRateIds(source?.default_tax_rates);
  const automaticTax = automaticTaxParams(source?.automatic_tax);
  const invoiceSettings = invoiceSettingsParams(source?.invoice_settings ?? null);
  return {
    items: items.map(item =>
      itemParams(
        item,
        source?.items.find(candidate => phaseItemPriceId(candidate) === item.price)
      )
    ),
    ...dates,
    ...(automaticTax ? { automatic_tax: automaticTax } : {}),
    ...(source?.billing_cycle_anchor === 'automatic' ? { billing_cycle_anchor: 'automatic' } : {}),
    ...(source?.collection_method ? { collection_method: source.collection_method } : {}),
    ...(source?.currency ? { currency: source.currency } : {}),
    ...(source?.default_payment_method
      ? { default_payment_method: referenceId(source.default_payment_method) }
      : {}),
    ...(defaultTaxRates !== undefined ? { default_tax_rates: defaultTaxRates } : {}),
    ...(source?.description ? { description: source.description } : {}),
    ...(discounts !== undefined ? { discounts } : {}),
    ...(invoiceSettings ? { invoice_settings: invoiceSettings } : {}),
    ...(source?.metadata ? { metadata: source.metadata } : {}),
    ...(source?.proration_behavior ? { proration_behavior: source.proration_behavior } : {}),
  };
}

function scheduleDiagnostics(schedule: Stripe.SubscriptionSchedule | null, scheduleId?: string) {
  if (!schedule) return { scheduleId: scheduleId ?? null };
  return {
    scheduleId: schedule.id,
    scheduleStatus: schedule.status,
    origin: schedule.metadata?.origin ?? null,
    currentPhase: schedule.current_phase
      ? {
          start_date: schedule.current_phase.start_date,
          end_date: schedule.current_phase.end_date,
        }
      : null,
    phases: schedule.phases.map(phase => ({
      start_date: phase.start_date,
      end_date: phase.end_date,
      items: phase.items.map(item => ({
        price: phaseItemPriceId(item),
        quantity: item.quantity ?? null,
      })),
    })),
  };
}

/** Only classification fields; Stripe error messages can echo request data. */
function safeFailureDetails(error: unknown) {
  if (!(error instanceof Error)) return { name: typeof error };
  const { type, code, statusCode, requestId } = error as Error & {
    type?: unknown;
    code?: unknown;
    statusCode?: unknown;
    requestId?: unknown;
  };
  return {
    name: error.name,
    ...(typeof type === 'string' ? { type } : {}),
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    ...(typeof requestId === 'string' ? { requestId } : {}),
  };
}

export function reportOrganizationKiloPassScheduleProblem(input: {
  event: OrganizationKiloPassScheduleEvent;
  reason: string;
  organizationId: string | null;
  subscriptionId: string;
  schedule: Stripe.SubscriptionSchedule | null;
  scheduleId?: string;
  error?: unknown;
}): void {
  const message = 'Organization Kilo Pass subscription schedule cannot be changed safely';
  const details = {
    event: input.event,
    reason: input.reason,
    organizationId: input.organizationId,
    subscriptionId: input.subscriptionId,
    ...scheduleDiagnostics(input.schedule, input.scheduleId),
    ...(input.error === undefined ? {} : { failure: safeFailureDetails(input.error) }),
  };
  warnExceptInTest(message, details);
  captureMessage(message, {
    level: 'warning',
    tags: {
      source: 'kilo_pass_org_schedule',
      event: input.event,
      reason: input.reason,
    },
    extra: details,
  });
}

export function throwUnsafeOrganizationKiloPassSchedule(
  input: Parameters<typeof reportOrganizationKiloPassScheduleProblem>[0]
): never {
  reportOrganizationKiloPassScheduleProblem(input);
  throw new Error(SCHEDULE_REWRITE_UNSAFE);
}

export type SeatUpdateSchedulePlan =
  | { kind: 'subscription_update' }
  | { kind: 'release_then_subscription_update'; scheduleId: string }
  | { kind: 'schedule_update'; scheduleId: string; phases: PhaseParams[] };

/**
 * Seat changes on a subscription attached to an owned cancellation schedule
 * go through the schedule so the pending pass removal keeps its boundary and
 * the new seat quantity. Subscriptions without a pass keep their existing
 * behavior unless the attached schedule is ours.
 */
export async function planSeatUpdateForCancellationSchedule(input: {
  subscription: Stripe.Subscription;
  paidSeatItem: Stripe.SubscriptionItem;
  passItem: Stripe.SubscriptionItem | undefined;
  paidSeatQuantity: number;
}): Promise<SeatUpdateSchedulePlan> {
  const { subscription, paidSeatItem, passItem } = input;
  const schedule = await retrieveAttachedSchedule(subscription);
  if (!schedule) return { kind: 'subscription_update' };
  const owned = isOwnedCancellationSchedule(schedule);
  if (!owned && !passItem) return { kind: 'subscription_update' };
  const organizationId = subscription.metadata?.organizationId;
  const unsafe = (reason: string): never =>
    throwUnsafeOrganizationKiloPassSchedule({
      event: 'seat_update',
      reason,
      organizationId: typeof organizationId === 'string' ? organizationId : null,
      subscriptionId: subscription.id,
      schedule,
    });
  if (!owned) return unsafe('unowned_schedule');
  const currentItems = subscriptionScheduleItems(subscription);
  const shape = classifyCancellationSchedule({
    schedule,
    currentItems,
    retainedItems: passItem
      ? subscriptionScheduleItemsWithout(subscription, passItem.id)
      : currentItems,
    periodEnd: paidSeatItem.current_period_end,
  });
  if (shape.kind === 'unsafe') return unsafe(shape.reason);
  if (shape.kind === 'idle') {
    return { kind: 'release_then_subscription_update', scheduleId: schedule.id };
  }
  if (!passItem) return unsafe('removal_without_pass_item');
  const quantities = new Map([
    [paidSeatItem.id, input.paidSeatQuantity],
    [passItem.id, input.paidSeatQuantity],
  ]);
  return {
    kind: 'schedule_update',
    scheduleId: schedule.id,
    phases: [
      phaseUpdateParams(shape.activePhase, subscriptionScheduleItems(subscription, quantities), {
        start_date: shape.activePhase.start_date,
        end_date: shape.activePhase.end_date,
      }),
      phaseUpdateParams(
        shape.removalPhase,
        subscriptionScheduleItemsWithout(subscription, passItem.id, quantities),
        { end_date: shape.removalPhase.end_date }
      ),
    ],
  };
}

export type ScheduleReleaseResult = {
  scheduleId: string;
  status: Stripe.SubscriptionSchedule.Status;
  alreadyTerminal: boolean;
};

/**
 * Stripe rejects releasing a schedule that is already released, completed, or
 * canceled. Those terminal states are the desired outcome, so they succeed.
 */
export async function releaseCancellationSchedule(
  scheduleId: string
): Promise<ScheduleReleaseResult> {
  try {
    const released = await stripe.subscriptionSchedules.release(scheduleId);
    return { scheduleId, status: released.status, alreadyTerminal: false };
  } catch (error) {
    let current: Stripe.SubscriptionSchedule;
    try {
      current = await stripe.subscriptionSchedules.retrieve(scheduleId);
    } catch {
      throw error;
    }
    if (isTerminalScheduleStatus(current.status)) {
      return { scheduleId, status: current.status, alreadyTerminal: true };
    }
    throw error;
  }
}
