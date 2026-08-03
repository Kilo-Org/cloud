import 'server-only';

import type Stripe from 'stripe';
import { and, desc, eq, ne } from 'drizzle-orm';
import { kilo_pass_org_agreements, organization_seats_purchases } from '@kilocode/db/schema';
import {
  KiloPassOrgAgreementState,
  KiloPassOrgProcessingCondition,
} from '@kilocode/db/schema-types';
import type { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import { db } from '@/lib/drizzle';
import { client as stripe } from '@/lib/stripe-client';
import { getStripePriceIdForKiloPass } from '@/lib/kilo-pass/stripe-price-ids.server';
import { isSeatLineItem } from '@/lib/organizations/stripe-seat-line-items';
import {
  activatePaidAgreement,
  bindProviderSeatAddOnItem,
  createParentSupplement,
  createPendingAgreement,
  suspendAgreementForPaymentReview,
} from './service';
import {
  getOrganizationKiloPassMetadata,
  ORGANIZATION_KILO_PASS_METADATA_TYPE,
} from './stripe-metadata';
import { monthlyWindowContaining, type IssuanceWindow } from './calculations';

export {
  getOrganizationKiloPassMetadata,
  ORGANIZATION_KILO_PASS_METADATA_TYPE,
} from './stripe-metadata';

const ORGANIZATION_KILO_PASS_CANCELLATION_ORIGIN = 'kilo-pass-org-cancellation';

function intervalToCadence(
  interval: Stripe.Price.Recurring.Interval | undefined
): 'monthly' | 'yearly' {
  if (interval === 'year') return 'yearly';
  return 'monthly';
}

function subscriptionMetadata(subscription: Stripe.Subscription) {
  return getOrganizationKiloPassMetadata(subscription.metadata);
}

function periodForItem(item: Stripe.SubscriptionItem) {
  if (!item.current_period_start || !item.current_period_end)
    throw new Error(`Organization Kilo Pass item ${item.id} has no billing period`);
  return {
    start: new Date(item.current_period_start * 1000),
    end: new Date(item.current_period_end * 1000),
  };
}

function organizationPassItem(subscription: Stripe.Subscription) {
  const item = subscription.items.data.find(item => !isSeatLineItem(item));
  if (!item) throw new Error(`Subscription ${subscription.id} has no Kilo Pass organization item`);
  return item;
}

function scheduleItemsMatch(
  actual: Stripe.SubscriptionSchedule.Phase.Item[],
  expected: { price: string; quantity: number }[]
) {
  return (
    actual.length === expected.length &&
    actual.every(item =>
      expected.some(
        candidate => candidate.price === String(item.price) && candidate.quantity === item.quantity
      )
    )
  );
}

function paidSeatItem(subscription: Stripe.Subscription) {
  const item = subscription.items.data.find(isSeatLineItem);
  if (!item) throw new Error(`Subscription ${subscription.id} has no seat item`);
  return item;
}

export async function createOrganizationKiloPassCheckout(input: {
  organizationId: string;
  actorUserId: string;
  tier: 'tier_19' | 'tier_49' | 'tier_199';
  allocations: { childOrganizationId: string; passCount: number }[];
}): Promise<
  { kind: 'payment_action'; clientSecret: string } | { kind: 'completed' } | { kind: 'pending' }
> {
  const [purchase] = await db
    .select({ subscriptionId: organization_seats_purchases.subscription_stripe_id })
    .from(organization_seats_purchases)
    .where(
      and(
        eq(organization_seats_purchases.organization_id, input.organizationId),
        eq(organization_seats_purchases.subscription_status, 'active')
      )
    )
    .limit(1);
  if (!purchase) throw new Error('An active organization seat subscription is required');
  const subscription = await stripe.subscriptions.retrieve(purchase.subscriptionId);
  const existingPassItem = subscription.items.data.find(item => !isSeatLineItem(item));
  if (existingPassItem) throw new Error('KILO_PASS_ORG_ALREADY_EXISTS');
  const seatItem = paidSeatItem(subscription);
  const cadence = intervalToCadence(seatItem.price.recurring?.interval);
  const paidSeats = seatItem.quantity ?? 0;
  const period = periodForItem(seatItem);

  // Persist agreement and allocation intent before Stripe changes the subscription.
  const pending = await createPendingAgreement({
    parentOrganizationId: input.organizationId,
    actorUserId: input.actorUserId,
    tier: input.tier,
    cadence,
    paidSeatCount: paidSeats,
    issuanceAnchorAt: period.start,
    providerSubscriptionId: subscription.id,
    providerSeatAddOnItemId: `pending:${subscription.id}`,
    initialAllocations: input.allocations.map(allocation => ({
      organizationId: allocation.childOrganizationId,
      passCapacity: allocation.passCount,
    })),
  });
  if (!pending.created) throw new Error('KILO_PASS_ORG_ALREADY_EXISTS');
  const price = getStripePriceIdForKiloPass({
    tier: input.tier as KiloPassTier,
    cadence: cadence as KiloPassCadence,
  });
  const updated = await stripe.subscriptions.update(subscription.id, {
    payment_behavior: 'allow_incomplete',
    proration_behavior: 'always_invoice',
    items: [{ price, quantity: paidSeats }],
    metadata: {
      ...subscription.metadata,
      type: ORGANIZATION_KILO_PASS_METADATA_TYPE,
      organizationId: input.organizationId,
      kiloUserId: input.actorUserId,
      tier: input.tier,
      cadence,
    },
    expand: [
      'latest_invoice.confirmation_secret',
      'latest_invoice.payments.data.payment.payment_intent',
    ],
  });
  const passItem = organizationPassItem(updated);
  await bindProviderSeatAddOnItem({
    agreementId: pending.agreementId,
    providerSeatAddOnItemId: passItem.id,
  });
  const invoice = typeof updated.latest_invoice === 'object' ? updated.latest_invoice : null;
  if (invoice?.status === 'paid' || invoice?.amount_due === 0) {
    await handleOrganizationKiloPassInvoicePaid({ invoice });
    return { kind: 'completed' };
  }
  const paymentIntent = invoice?.payments?.data
    .map(payment => payment.payment.payment_intent)
    .find(reference => typeof reference === 'object');
  if (paymentIntent?.status === 'requires_action' && invoice?.confirmation_secret?.client_secret) {
    return { kind: 'payment_action', clientSecret: invoice.confirmation_secret.client_secret };
  }
  return { kind: 'pending' };
}

function invoiceLineForSubscriptionItem(invoice: Stripe.Invoice, itemId: string) {
  return (invoice.lines?.data ?? []).find(
    line => line.parent?.subscription_item_details?.subscription_item === itemId
  );
}

function linePeriod(line: Stripe.InvoiceLineItem) {
  if (!line.period?.start || !line.period?.end)
    throw new Error(`Invoice line ${line.id} has no service period`);
  return { start: new Date(line.period.start * 1000), end: new Date(line.period.end * 1000) };
}

function paidSeatSnapshotFromInvoice(
  invoice: Stripe.Invoice,
  itemId: string
): { quantity: number; period: IssuanceWindow } | null {
  const line = invoiceLineForSubscriptionItem(invoice, itemId);
  if (!line) return null;
  const quantity = line?.quantity;
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0) return null;
  return { quantity, period: linePeriod(line) };
}

function isBridgeWindow(window: IssuanceWindow, paid: IssuanceWindow) {
  return paid.start > window.start || paid.end < window.end;
}

export async function handleOrganizationKiloPassInvoicePaid(params: {
  invoice: Stripe.Invoice;
  paidSeatCount?: number;
}) {
  const reference = params.invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof reference === 'string' ? reference : reference?.id;
  if (!subscriptionId) return false;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const metadata = subscriptionMetadata(subscription);
  if (!metadata) return false;
  const [agreement] = await db
    .select()
    .from(kilo_pass_org_agreements)
    .where(
      and(
        eq(kilo_pass_org_agreements.provider_subscription_id, subscription.id),
        ne(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.Ended)
      )
    )
    .orderBy(desc(kilo_pass_org_agreements.created_at))
    .limit(1);
  if (!agreement) return false;
  const boundItem = subscription.items.data.find(
    item => item.id === agreement.provider_seat_add_on_item_id
  );
  const item = boundItem ?? subscription.items.data.find(item => !isSeatLineItem(item));
  if (!item) return false;
  if (!boundItem) {
    await bindProviderSeatAddOnItem({
      agreementId: agreement.id,
      providerSeatAddOnItemId: item.id,
    });
  }
  const line = invoiceLineForSubscriptionItem(params.invoice, item.id);
  if (!line) return false;
  const paidPeriod = linePeriod(line);
  const seatItem = subscription.items.data.find(isSeatLineItem);
  const seatSnapshot = seatItem ? paidSeatSnapshotFromInvoice(params.invoice, seatItem.id) : null;
  // Eager seat-change reconciliation supplies the paid post-update quantity because
  // proration invoices can omit the seat line. Webhooks otherwise use immutable lines.
  const subscriptionSeatCount = seatItem?.quantity;
  const seats =
    params.paidSeatCount ??
    seatSnapshot?.quantity ??
    (agreement.state === KiloPassOrgAgreementState.Active &&
    typeof subscriptionSeatCount === 'number' &&
    Number.isSafeInteger(subscriptionSeatCount) &&
    subscriptionSeatCount >= 0
      ? subscriptionSeatCount
      : agreement.purchased_pass_capacity);
  const firstWindow = monthlyWindowContaining(
    new Date(agreement.issuance_anchor_at),
    paidPeriod.start
  );
  const isBridge = isBridgeWindow(firstWindow, paidPeriod);
  const previousSeats = agreement.purchased_pass_capacity;
  const paidIncreaseSupersedesPendingCapacity =
    agreement.next_purchased_pass_capacity !== null &&
    seats > agreement.next_purchased_pass_capacity;
  await activatePaidAgreement({
    agreementId: agreement.id,
    recipientUserId: metadata.kiloUserId,
    paidFrom: paidPeriod.start,
    paidUntil: paidPeriod.end,
    paidSeatCount: seats,
    firstWindow,
    isBridge,
    paidBridgeInterval: isBridge ? paidPeriod : undefined,
  });
  if (
    agreement.state === KiloPassOrgAgreementState.Active &&
    agreement.processing_condition !== KiloPassOrgProcessingCondition.Manual &&
    agreement.processing_condition !== KiloPassOrgProcessingCondition.SuspendedForReview &&
    (seats > previousSeats || paidIncreaseSupersedesPendingCapacity)
  ) {
    await createParentSupplement({
      agreementId: agreement.id,
      recipientUserId: metadata.kiloUserId,
      window: firstWindow,
      paidSeatCount: seats,
      providerInvoiceLineId: line.id,
      now: new Date(),
    });
  }
  return true;
}

/** Repairs a pending agreement when Stripe has already finalized its add-on invoice. */
export async function reconcileOrganizationKiloPassPayment(organizationId: string) {
  const [agreement] = await db
    .select({ providerSubscriptionId: kilo_pass_org_agreements.provider_subscription_id })
    .from(kilo_pass_org_agreements)
    .where(
      and(
        eq(kilo_pass_org_agreements.parent_organization_id, organizationId),
        eq(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.PendingPayment)
      )
    )
    .orderBy(desc(kilo_pass_org_agreements.created_at))
    .limit(1);
  if (!agreement?.providerSubscriptionId) return false;

  const subscription = await stripe.subscriptions.retrieve(agreement.providerSubscriptionId, {
    expand: ['latest_invoice'],
  });
  const invoice = subscription.latest_invoice;
  if (!invoice || typeof invoice === 'string' || invoice.status !== 'paid') return false;
  return handleOrganizationKiloPassInvoicePaid({ invoice });
}

/** Keep the paid seat subscription alive while removing only its Kilo Pass add-on at renewal. */
export async function scheduleOrganizationKiloPassCancellation(input: {
  providerSubscriptionId: string;
  providerSeatAddOnItemId: string;
}) {
  const subscription = await stripe.subscriptions.retrieve(input.providerSubscriptionId);
  const passItem = subscription.items.data.find(item => item.id === input.providerSeatAddOnItemId);
  if (!passItem) return;
  const seatItem = paidSeatItem(subscription);
  const period = periodForItem(seatItem);
  const retainedItems = subscription.items.data
    .filter(item => item.id !== passItem.id)
    .map(item => ({ price: item.price.id, quantity: item.quantity ?? 1 }));
  const existingSchedule = subscription.schedule;
  const schedule =
    typeof existingSchedule === 'string'
      ? await stripe.subscriptionSchedules.retrieve(existingSchedule)
      : existingSchedule;
  const currentItems = subscription.items.data.map(item => ({
    price: item.price.id,
    quantity: item.quantity ?? 1,
  }));
  let target = schedule;
  if (schedule) {
    const currentPhase = schedule.phases[0];
    const removalPhase = schedule.phases[1];
    const isOwnedSchedule =
      schedule.metadata?.origin === ORGANIZATION_KILO_PASS_CANCELLATION_ORIGIN;
    const hasRemovalScheduled =
      isOwnedSchedule &&
      schedule.phases.length === 2 &&
      removalPhase !== undefined &&
      scheduleItemsMatch(removalPhase.items, retainedItems);
    if (hasRemovalScheduled) return;
    const isResumedSchedule =
      isOwnedSchedule &&
      schedule.phases.length === 2 &&
      removalPhase !== undefined &&
      scheduleItemsMatch(removalPhase.items, currentItems);
    const isOrphanedCreate =
      Object.keys(schedule.metadata ?? {}).length === 0 &&
      schedule.phases.length === 1 &&
      currentPhase !== undefined &&
      scheduleItemsMatch(currentPhase.items, currentItems);
    if (!isResumedSchedule && !isOrphanedCreate) throw new Error('SCHEDULE_REWRITE_UNSAFE');
  } else {
    target = await stripe.subscriptionSchedules.create({ from_subscription: subscription.id });
  }
  if (!target) throw new Error('SCHEDULE_REWRITE_UNSAFE');
  const periodStart = Math.floor(period.start.getTime() / 1000);
  const periodEnd = Math.floor(period.end.getTime() / 1000);
  const activePhase = schedule?.phases.find(
    phase => phase.start_date <= periodStart && phase.end_date >= periodEnd
  );
  const activeStart = activePhase?.start_date ?? schedule?.current_phase?.start_date ?? periodStart;
  const activeEnd = activePhase?.end_date ?? schedule?.current_phase?.end_date ?? periodEnd;
  await stripe.subscriptionSchedules.update(target.id, {
    metadata: { origin: ORGANIZATION_KILO_PASS_CANCELLATION_ORIGIN },
    end_behavior: 'release',
    phases: [
      {
        items: currentItems,
        start_date: activeStart,
        end_date: activeEnd,
      },
      { items: retainedItems },
    ],
  });
}

/** Restores only the Kilo Pass add-on. Shared schedules are never rewritten blindly. */
export async function resumeOrganizationKiloPassCancellation(input: {
  providerSubscriptionId: string;
  providerSeatAddOnItemId: string;
}) {
  const subscription = await stripe.subscriptions.retrieve(input.providerSubscriptionId);
  const passItem = subscription.items.data.find(item => item.id === input.providerSeatAddOnItemId);
  if (!passItem) throw new Error('KILO_PASS_ADD_ON_UNAVAILABLE');
  const scheduleReference = subscription.schedule;
  if (!scheduleReference) return;
  const schedule =
    typeof scheduleReference === 'string'
      ? await stripe.subscriptionSchedules.retrieve(scheduleReference)
      : scheduleReference;
  if (schedule.metadata?.origin !== ORGANIZATION_KILO_PASS_CANCELLATION_ORIGIN) {
    throw new Error('SCHEDULE_REWRITE_UNSAFE');
  }
  const expectedCurrentItems = subscription.items.data.map(item => ({
    price: item.price.id,
    quantity: item.quantity ?? 1,
  }));
  const expectedRetainedItems = expectedCurrentItems.filter(
    item => item.price !== passItem.price.id
  );
  const removalPhase = schedule.phases[1];
  if (
    schedule.phases.length !== 2 ||
    !removalPhase ||
    removalPhase.items.length !== expectedRetainedItems.length ||
    removalPhase.items.some(
      item =>
        !expectedRetainedItems.some(
          expected => expected.price === item.price && expected.quantity === item.quantity
        )
    )
  ) {
    throw new Error('SCHEDULE_REWRITE_UNSAFE');
  }
  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: 'release',
    phases: [
      {
        items: expectedCurrentItems,
        start_date: schedule.phases[0]?.start_date,
        end_date: schedule.phases[0]?.end_date,
      },
      { items: expectedCurrentItems },
    ],
  });
}

/** Subscription events reconcile identity and lifecycle only. Paid capacity is invoice-paid only. */
export async function handleOrganizationKiloPassSubscriptionEvent(
  subscription: Stripe.Subscription
) {
  const metadata = subscriptionMetadata(subscription);
  if (!metadata) return false;
  const [agreement] = await db
    .select()
    .from(kilo_pass_org_agreements)
    .where(
      and(
        eq(kilo_pass_org_agreements.provider_subscription_id, subscription.id),
        ne(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.Ended)
      )
    )
    .orderBy(desc(kilo_pass_org_agreements.created_at))
    .limit(1);
  if (!agreement) return false;
  const item = subscription.items.data.find(item => !isSeatLineItem(item));
  if (!item) {
    await db
      .update(kilo_pass_org_agreements)
      .set({ state: KiloPassOrgAgreementState.Ended })
      .where(eq(kilo_pass_org_agreements.id, agreement.id));
    return true;
  }
  if (agreement.provider_seat_add_on_item_id !== item.id)
    await bindProviderSeatAddOnItem({
      agreementId: agreement.id,
      providerSeatAddOnItemId: item.id,
    });
  if (subscription.ended_at || subscription.status === 'canceled') {
    await db
      .update(kilo_pass_org_agreements)
      .set({ state: KiloPassOrgAgreementState.Ended })
      .where(eq(kilo_pass_org_agreements.id, agreement.id));
    return true;
  }
  // Subscription events can reconcile cancellation only after invoice.paid has
  // activated the agreement. A pending checkout must remain pending even when
  // Stripe has already transitioned its subscription to active.
  if (
    agreement.state !== KiloPassOrgAgreementState.Active &&
    agreement.state !== KiloPassOrgAgreementState.CancelAtPeriodEnd
  ) {
    return true;
  }
  if (subscription.cancel_at_period_end) {
    await db
      .update(kilo_pass_org_agreements)
      .set({ state: KiloPassOrgAgreementState.CancelAtPeriodEnd })
      .where(eq(kilo_pass_org_agreements.id, agreement.id));
  } else {
    await db
      .update(kilo_pass_org_agreements)
      .set({ state: KiloPassOrgAgreementState.Active, cancellation_effective_at: null })
      .where(eq(kilo_pass_org_agreements.id, agreement.id));
  }
  return true;
}

export async function handleOrganizationKiloPassPaymentAdverse(subscriptionId: string) {
  await suspendAgreementForPaymentReview(subscriptionId);
}

export async function handleOrganizationKiloPassPaymentAdverseForInvoice(invoice: Stripe.Invoice) {
  const reference = invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof reference === 'string' ? reference : reference?.id;
  if (subscriptionId) await handleOrganizationKiloPassPaymentAdverse(subscriptionId);
}

/** Ends an unpaid checkout only after Stripe has made its invoice terminal. */
export async function endPendingOrganizationKiloPassForTerminalInvoice(invoice: Stripe.Invoice) {
  if (invoice.status !== 'void' && invoice.status !== 'uncollectible') return false;
  const reference = invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof reference === 'string' ? reference : reference?.id;
  if (!subscriptionId) return false;
  const [agreement] = await db
    .select()
    .from(kilo_pass_org_agreements)
    .where(
      and(
        eq(kilo_pass_org_agreements.provider_subscription_id, subscriptionId),
        eq(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.PendingPayment)
      )
    )
    .orderBy(desc(kilo_pass_org_agreements.created_at))
    .limit(1);
  if (!agreement) return false;
  if (!invoiceLineForSubscriptionItem(invoice, agreement.provider_seat_add_on_item_id ?? '')) {
    return false;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const passItem = subscription.items.data.find(
    item => item.id === agreement.provider_seat_add_on_item_id
  );
  if (passItem) {
    await stripe.subscriptions.update(subscriptionId, {
      proration_behavior: 'none',
      items: [{ id: passItem.id, deleted: true }],
    });
  }
  await db
    .update(kilo_pass_org_agreements)
    .set({ state: KiloPassOrgAgreementState.Ended })
    .where(
      and(
        eq(kilo_pass_org_agreements.id, agreement.id),
        eq(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.PendingPayment)
      )
    );
  return true;
}
