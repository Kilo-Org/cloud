import { NotificationTypeV2 } from '@apple/app-store-server-library';
import { and, desc, eq, or, sql } from 'drizzle-orm';

import { credit_transactions, kilocode_users, kilo_pass_store_events } from '@kilocode/db/schema';
import type { db, DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { KiloPassPaymentProvider } from '@kilocode/web-shared/lib/kilo-pass/enums';

import { storeCreditPaymentId } from './store-products';

export type StoreCreditReversalResult = {
  reversed: boolean;
  creditTransactionId: string | null;
  amountMicrodollars: number;
};

export type StoreCreditRestorationResult = {
  restored: boolean;
  creditTransactionId: string | null;
  amountMicrodollars: number;
};

/**
 * The backend contract string for a completion of a store transaction the
 * store has already refunded. Kilo refused to grant the pack, so the client
 * must not treat the purchase as completed; the mobile error mapping matches
 * this exact message.
 */
export const STORE_PURCHASE_REFUNDED_MESSAGE =
  'This store purchase has been refunded, so Kilo cannot credit it.';

export type StoreCreditRefundEvent = {
  eventId: string;
  notificationType: string | null;
};

/**
 * The `kilo_pass_store_events` notification types that mean the store refunded
 * or revoked a purchase. Both handlers store the decoded type verbatim in
 * `payload_json`, so a processed event with one of these types is the durable
 * record that a purchase was refunded — including a refund that arrived before
 * Kilo granted anything. Stripe never delivers a store refund event.
 */
const STORE_REFUND_NOTIFICATION_TYPES: Record<KiloPassPaymentProvider, readonly string[]> = {
  [KiloPassPaymentProvider.Stripe]: [],
  [KiloPassPaymentProvider.AppStore]: [NotificationTypeV2.REFUND, NotificationTypeV2.REVOKE],
  // Play reports a one-time product refund as a voided purchase, for both a
  // full refund and a quantity-based partial refund.
  [KiloPassPaymentProvider.GooglePlay]: ['voided_purchase'],
};

/**
 * The notification types that mean the store reinstated a refund it had
 * reversed. Apple requires the reversed purchase's content back, consumables
 * included, so a reversal undoes the clawback of the refund it reverses and
 * stops that refund from blocking a later grant. Neither Stripe nor Play
 * reports a refund reversal.
 */
const STORE_REFUND_REVERSED_NOTIFICATION_TYPES: Record<KiloPassPaymentProvider, readonly string[]> =
  {
    [KiloPassPaymentProvider.Stripe]: [],
    [KiloPassPaymentProvider.AppStore]: [NotificationTypeV2.REFUND_REVERSED],
    [KiloPassPaymentProvider.GooglePlay]: [],
  };

/**
 * The order key of a processed store event: the store's own signed date, in
 * milliseconds, when the event carries one, and when Kilo processed it
 * otherwise.
 *
 * Notifications arrive out of order, so Kilo's processing order says nothing
 * about the store's chronology: a reversal delivered before the refund it
 * reverses must not be overwritten by that older refund. The signed date is the
 * chronology the store itself asserts, and every App Store notification
 * payload carries one.
 */
const storeEventOrderKeyMs = sql<number>`COALESCE(
  (${kilo_pass_store_events.payload_json}->>'signedDate')::double precision,
  EXTRACT(EPOCH FROM ${kilo_pass_store_events.processed_at}) * 1000
)::double precision`;

type ProcessedStoreRefundDelivery = StoreCreditRefundEvent & { orderKeyMs: number };

/**
 * The refund or reinstatement delivery the store sent last for a store credit
 * pack, or null when the store never sent one. A refund and a reversal signed
 * in the same millisecond keep the refund, which can only refuse a grant, never
 * grant twice.
 *
 * A store credit pack is one purchase, but Play names it by two ids: the order
 * id and the purchase token. A completion keys the grant by whichever the Play
 * API returned first, and a voided-purchase notification always carries an
 * order id, so every id the purchase is known by is matched here.
 */
async function findLatestProcessedStoreRefundDelivery(
  dbOrTx: DrizzleTransaction | typeof db,
  params: { paymentProvider: KiloPassPaymentProvider; providerTransactionIds: string[] }
): Promise<ProcessedStoreRefundDelivery | null> {
  const refundTypes = STORE_REFUND_NOTIFICATION_TYPES[params.paymentProvider];
  const reversedTypes = STORE_REFUND_REVERSED_NOTIFICATION_TYPES[params.paymentProvider];
  const keys = [...new Set(params.providerTransactionIds)].sort();
  if (refundTypes.length === 0 || keys.length === 0) return null;

  const notificationType = sql`(${kilo_pass_store_events.payload_json}->>'notificationType')`;
  const typeList = (types: readonly string[]) =>
    sql`(${sql.join(
      types.map(type => sql`${type}`),
      sql`, `
    )})`;
  const refundTypeFilter = sql`${notificationType} IN ${typeList(refundTypes)}`;
  const keyFilter = keys.flatMap(key => [
    eq(kilo_pass_store_events.provider_transaction_id, key),
    // Only Play keys a purchase by a token; an App Store `provider_subscription_id`
    // is the original transaction id of a subscription, never a credit pack.
    ...(params.paymentProvider === KiloPassPaymentProvider.GooglePlay
      ? [eq(kilo_pass_store_events.provider_subscription_id, key)]
      : []),
  ]);

  const events = await dbOrTx
    .select({
      eventId: kilo_pass_store_events.event_id,
      notificationType: sql<
        string | null
      >`${kilo_pass_store_events.payload_json}->>'notificationType'`,
      orderKeyMs: storeEventOrderKeyMs,
    })
    .from(kilo_pass_store_events)
    .where(
      and(
        eq(kilo_pass_store_events.payment_provider, params.paymentProvider),
        sql`${kilo_pass_store_events.processed_at} IS NOT NULL`,
        sql`${notificationType} IN ${typeList([...refundTypes, ...reversedTypes])}`,
        keyFilter.length === 1 ? keyFilter[0] : or(...keyFilter)
      )
    )
    .orderBy(desc(storeEventOrderKeyMs), sql`${refundTypeFilter} DESC`)
    .limit(1);

  return events[0] ?? null;
}

/**
 * The effective refund event for a store credit pack, or null when the store
 * never refunded it or has since reinstated the refund.
 *
 * A refund the store later reversed is no longer effective, so the refunds and
 * their reversals are read together and the one the store signed last decides.
 * The refund handler asks the same question before it claws credits back: a
 * refund the store already reversed must not be applied over the reversal, and
 * a reversal must not undo a refund the store signed after it.
 */
export async function findEffectiveStoreCreditRefundEvent(
  dbOrTx: DrizzleTransaction | typeof db,
  params: { paymentProvider: KiloPassPaymentProvider; providerTransactionIds: string[] }
): Promise<StoreCreditRefundEvent | null> {
  const latestEvent = await findLatestProcessedStoreRefundDelivery(dbOrTx, params);
  const refundTypes = STORE_REFUND_NOTIFICATION_TYPES[params.paymentProvider];
  if (!latestEvent?.notificationType) return null;
  if (!refundTypes.includes(latestEvent.notificationType)) return null;
  return { eventId: latestEvent.eventId, notificationType: latestEvent.notificationType };
}

/**
 * Whether a delivery the store signed earlier than one Kilo has already
 * processed is superseded, and must therefore be applied without touching
 * credits.
 *
 * A notification with no store signed date is treated as arriving now, which is
 * what an unprocessed event row means.
 */
export async function isStoreRefundDeliverySuperseded(
  dbOrTx: DrizzleTransaction | typeof db,
  params: {
    paymentProvider: KiloPassPaymentProvider;
    providerTransactionIds: string[];
    signedDateMs: number | null;
  }
): Promise<boolean> {
  const latestEvent = await findLatestProcessedStoreRefundDelivery(dbOrTx, params);
  if (!latestEvent) return false;
  return latestEvent.orderKeyMs > (params.signedDateMs ?? Date.now());
}

/**
 * Serialize the grant of a store credit pack with the refund of the same
 * purchase, in either arrival order.
 *
 * Both the completion and the refund handlers take this transaction-scoped
 * advisory lock, keyed by the store payment id, before they read anything, so
 * the two can never interleave: a completion that runs first is clawed back by
 * the refund that follows, and a refund that runs first is visible to the
 * completion, which then refuses to grant at all. A plain read-then-write check
 * on either side would let both read "nothing happened yet" and leave the
 * credits granted. Keys are locked in sorted order so two refunds sharing one
 * purchase cannot deadlock.
 */
export async function lockStoreCreditPurchase(
  tx: DrizzleTransaction,
  params: { paymentProvider: KiloPassPaymentProvider; providerTransactionIds: string[] }
): Promise<void> {
  for (const key of [...new Set(params.providerTransactionIds)].sort()) {
    const paymentId = storeCreditPaymentId(params.paymentProvider, key);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${paymentId}, 0))`);
  }
}

/**
 * Store proportions are milliunits, as Apple's `consumptionPercentage` and
 * `revocationPercentage` are: 100000 is 100%.
 */
export const STORE_FULL_MILLIUNITS = 100_000;

function creditPackReversalDescription(provider: KiloPassPaymentProvider): string {
  return provider === KiloPassPaymentProvider.AppStore
    ? 'App Store credit pack refund clawback'
    : 'Google Play credit pack refund clawback';
}

function creditPackRestorationDescription(provider: KiloPassPaymentProvider): string {
  return provider === KiloPassPaymentProvider.AppStore
    ? 'App Store credit pack refund restoration'
    : 'Google Play credit pack refund restoration';
}

/**
 * The uniqueness key of a refund clawback on a store credit pack, scoped to the
 * purchase (`<provider>:<providerTransactionId>`), since one pack is one
 * purchase. A purchase the store refunds, reverses, and refunds again gets one
 * clawback per refund cycle, numbered from the first.
 */
function storeCreditRefundCategory(params: {
  paymentProvider: KiloPassPaymentProvider;
  providerTransactionId: string;
  cycle: number;
}): string {
  const base = `store-credit-refund:${params.paymentProvider}:${params.providerTransactionId}`;
  return params.cycle <= 1 ? base : `${base}:${params.cycle}`;
}

/** The mirror key of the compensating grant that reinstates such a clawback. */
function storeCreditRefundReversalCategory(params: {
  paymentProvider: KiloPassPaymentProvider;
  providerTransactionId: string;
  cycle: number;
}): string {
  const base = `store-credit-refund-reversal:${params.paymentProvider}:${params.providerTransactionId}`;
  return params.cycle <= 1 ? base : `${base}:${params.cycle}`;
}

type StoreCreditRefundCycle = {
  creditTransactionId: string;
  amountMicrodollars: number;
  isFree: boolean;
  kiloUserId: string;
  microdollarsUsed: number;
};

/**
 * The refund cycles a store credit pack has been through, oldest first: every
 * clawback a refund wrote and every restoration a reversal wrote, each keyed by
 * the purchase and numbered from one.
 *
 * A clawback without its restoration is the refund currently in force, so the
 * handlers read this state before they write: a redelivered refund finds its
 * clawback already in force and does nothing, and a refund the store issued
 * *after* a reversal finds the pair settled and claws the pack back again under
 * the next cycle. The cycle suffix never splits the purchase's state: a cycle
 * key is matched exactly, or by its own `:<cycle>` suffix, so a purchase whose
 * store id happens to be a prefix of another's never absorbs its rows.
 */
async function findStoreCreditRefundCycles(
  dbOrTx: DrizzleTransaction | typeof db,
  params: {
    paymentProvider: KiloPassPaymentProvider;
    providerTransactionId: string;
    kiloUserId: string;
  }
): Promise<{ clawbacks: StoreCreditRefundCycle[]; restorations: StoreCreditRefundCycle[] }> {
  const clawbackPrefix = storeCreditRefundCategory({ ...params, cycle: 1 });
  const restorationPrefix = storeCreditRefundReversalCategory({ ...params, cycle: 1 });
  const purchaseCycles = (prefix: string) => [
    sql`${credit_transactions.credit_category} = ${prefix}`,
    sql`starts_with(${credit_transactions.credit_category}, ${`${prefix}:`})`,
  ];
  const rows = await dbOrTx
    .select({
      creditTransactionId: credit_transactions.id,
      amountMicrodollars: credit_transactions.amount_microdollars,
      creditCategory: credit_transactions.credit_category,
      isFree: credit_transactions.is_free,
      kiloUserId: credit_transactions.kilo_user_id,
      microdollarsUsed: kilocode_users.microdollars_used,
    })
    .from(credit_transactions)
    .innerJoin(kilocode_users, eq(credit_transactions.kilo_user_id, kilocode_users.id))
    .where(
      and(
        // A purchase has one owner and its clawback and restoration rows are
        // written for that owner, so this narrows the scan to the only rows that
        // can hold the purchase's cycles.
        eq(credit_transactions.kilo_user_id, params.kiloUserId),
        or(...purchaseCycles(clawbackPrefix), ...purchaseCycles(restorationPrefix))
      )
    )
    .orderBy(credit_transactions.created_at);

  const clawbacks: StoreCreditRefundCycle[] = [];
  const restorations: StoreCreditRefundCycle[] = [];
  for (const row of rows) {
    const cycle = {
      creditTransactionId: row.creditTransactionId,
      amountMicrodollars: row.amountMicrodollars,
      isFree: row.isFree,
      kiloUserId: row.kiloUserId,
      microdollarsUsed: row.microdollarsUsed,
    };
    const isClawback =
      row.creditCategory === clawbackPrefix ||
      (row.creditCategory?.startsWith(`${clawbackPrefix}:`) ?? false);
    if (isClawback) clawbacks.push(cycle);
    else restorations.push(cycle);
  }

  return { clawbacks, restorations };
}

async function findStoreCreditGrant(
  dbOrTx: DrizzleTransaction | typeof db,
  params: { paymentProvider: KiloPassPaymentProvider; providerTransactionId: string }
) {
  const grantedRows = await dbOrTx
    .select({
      kiloUserId: credit_transactions.kilo_user_id,
      amountMicrodollars: credit_transactions.amount_microdollars,
      microdollarsUsed: kilocode_users.microdollars_used,
      totalMicrodollarsAcquired: kilocode_users.total_microdollars_acquired,
    })
    .from(credit_transactions)
    .innerJoin(kilocode_users, eq(credit_transactions.kilo_user_id, kilocode_users.id))
    .where(
      eq(
        credit_transactions.stripe_payment_id,
        storeCreditPaymentId(params.paymentProvider, params.providerTransactionId)
      )
    )
    .limit(1);
  return grantedRows[0] ?? null;
}

/**
 * How much of a granted store credit pack the user has consumed, in milliunits
 * (0 untouched, 100000 fully used), or null when Kilo never granted it.
 *
 * A pack's credits are fungible with the rest of the balance, and
 * `microdollars_used` is lifetime and account-wide, so it says nothing about
 * spend from this pack. The unspent part is instead defined against the
 * balance at refund time: `unspent = min(granted, max(0, balance))` and
 * `spent = granted - unspent`, where balance is `total_microdollars_acquired -
 * microdollars_used`. A user with $100 of earlier spend who buys a $10 pack and
 * uses none of it therefore reports 0. Other credits count as spent before the
 * pack's, which favors the customer, and the unspent part never exceeds the
 * balance, so a refund prorated by it cannot claw back more than the user
 * still holds.
 */
export async function getStoreCreditConsumptionMilliunits(
  dbOrTx: DrizzleTransaction | typeof db,
  params: { paymentProvider: KiloPassPaymentProvider; providerTransactionId: string }
): Promise<number | null> {
  const granted = await findStoreCreditGrant(dbOrTx, params);
  if (!granted || granted.amountMicrodollars <= 0) return null;

  const balance = granted.totalMicrodollarsAcquired - granted.microdollarsUsed;
  const unspent = Math.min(granted.amountMicrodollars, Math.max(0, balance));
  const spent = granted.amountMicrodollars - unspent;
  return Math.min(
    STORE_FULL_MILLIUNITS,
    Math.max(0, Math.round((spent * STORE_FULL_MILLIUNITS) / granted.amountMicrodollars))
  );
}

/**
 * Reverse the refunded share of a store credit pack, exactly once per refund
 * cycle.
 *
 * A credit pack is granted by `completeStoreCreditPurchase` under the
 * `store-credit:<provider>:<providerTransactionId>` payment id. The reversal is
 * `granted * refundedMilliunits / 100000` (refunded over paid), with the share
 * clamped to 0..100000 so the reversal stays within 0..granted, rounded to the
 * nearest microdollar, and is written as one negative row keyed by the store
 * transaction id. The amount depends only on the grant and the store's refund
 * share, never on the balance, and a clawback already in force makes a replayed
 * refund notification a no-op, so the stored amount can never change.
 *
 * The store refunded a purchase Kilo never granted against (no grant row) is a
 * no-op, not an error. A refund the store issues *after* a reversal settled the
 * previous one claws the pack back again under the next numbered cycle: the
 * refund is in force again and the credits must not stay granted.
 */
export async function reverseStoreCreditPurchase(
  tx: DrizzleTransaction,
  params: {
    paymentProvider: KiloPassPaymentProvider;
    providerTransactionId: string;
    /** Refunded share of the amount paid; `STORE_FULL_MILLIUNITS` for a full refund. */
    refundedMilliunits: number;
  }
): Promise<StoreCreditReversalResult> {
  const granted = await findStoreCreditGrant(tx, params);
  if (!granted) {
    return { reversed: false, creditTransactionId: null, amountMicrodollars: 0 };
  }

  const refundedMilliunits = Math.min(
    STORE_FULL_MILLIUNITS,
    Math.max(0, Math.round(params.refundedMilliunits))
  );
  const reversalMicrodollars = Math.round(
    (granted.amountMicrodollars * refundedMilliunits) / STORE_FULL_MILLIUNITS
  );
  if (reversalMicrodollars <= 0) {
    return { reversed: false, creditTransactionId: null, amountMicrodollars: 0 };
  }

  const { clawbacks, restorations } = await findStoreCreditRefundCycles(tx, {
    ...params,
    kiloUserId: granted.kiloUserId,
  });
  const clawbackInForce = clawbacks[restorations.length];
  if (clawbacks.length > restorations.length) {
    // A refund is already in force, so this delivery is a replay: return the
    // clawback that stands without touching the balance again.
    return {
      reversed: false,
      creditTransactionId: clawbackInForce?.creditTransactionId ?? null,
      amountMicrodollars: 0,
    };
  }

  const creditTransactionId = crypto.randomUUID();
  const creditCategory = storeCreditRefundCategory({
    ...params,
    cycle: clawbacks.length + 1,
  });
  const insertResult = await tx
    .insert(credit_transactions)
    .values({
      id: creditTransactionId,
      kilo_user_id: granted.kiloUserId,
      amount_microdollars: -reversalMicrodollars,
      is_free: false,
      description: creditPackReversalDescription(params.paymentProvider),
      credit_category: creditCategory,
      check_category_uniqueness: true,
      original_baseline_microdollars_used: granted.microdollarsUsed,
    })
    .onConflictDoNothing();

  if ((insertResult.rowCount ?? 0) === 0) {
    // Another delivery of this cycle won the insert. Return its clawback so the
    // caller can record it without touching the balance.
    const existingRows = await tx
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, granted.kiloUserId),
          eq(credit_transactions.credit_category, creditCategory)
        )
      )
      .limit(1);
    return {
      reversed: false,
      creditTransactionId: existingRows[0]?.id ?? null,
      amountMicrodollars: 0,
    };
  }

  await tx
    .update(kilocode_users)
    .set({
      total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} - ${reversalMicrodollars}`,
    })
    .where(eq(kilocode_users.id, granted.kiloUserId));

  return {
    reversed: true,
    creditTransactionId,
    amountMicrodollars: reversalMicrodollars,
  };
}

/**
 * Restore the credits a refund clawed back from a store credit pack, exactly
 * once per refund cycle.
 *
 * The App Store reinstates a refund it reversed with `REFUND_REVERSED`, and
 * Apple requires the reversed purchase's content back, consumables included, so
 * the credits the refund took are owed again. The restore is the exact inverse
 * of the clawback: it reads the clawback still in force and writes the positive
 * mirror under the same cycle, keyed
 * `store-credit-refund-reversal:<provider>:<providerTransactionId>`. The first
 * delivery credits the balance back, and a redelivered reversal finds the pair
 * settled and does nothing, so it can never restore twice.
 *
 * The amount is the clawback's stored amount, never a recomputed share, so a
 * prorated refund restores exactly the share it took. A purchase Kilo never
 * clawed back — never granted, or refunded without a grant — restores nothing:
 * the reversal has nothing to undo. This mirrors `reverseStoreCreditPurchase`;
 * both handlers hold the same per-purchase lock, so the pair is ordered rather
 * than racing.
 */
export async function restoreStoreCreditPurchase(
  tx: DrizzleTransaction,
  params: { paymentProvider: KiloPassPaymentProvider; providerTransactionId: string }
): Promise<StoreCreditRestorationResult> {
  const granted = await findStoreCreditGrant(tx, params);
  if (!granted) {
    // Only a granted pack is ever clawed back, so there is nothing to restore.
    return { restored: false, creditTransactionId: null, amountMicrodollars: 0 };
  }

  const { clawbacks, restorations } = await findStoreCreditRefundCycles(tx, {
    ...params,
    kiloUserId: granted.kiloUserId,
  });
  const clawback = clawbacks[restorations.length] ?? null;
  if (!clawback || clawback.amountMicrodollars >= 0) {
    // Nothing is clawed back: the pack was never granted, or this reversal
    // already settled the cycle. Return the restoration that stands, if any, so
    // the caller records the delivery without crediting the balance again.
    return {
      restored: false,
      creditTransactionId: restorations.at(-1)?.creditTransactionId ?? null,
      amountMicrodollars: 0,
    };
  }

  const amountMicrodollars = -clawback.amountMicrodollars;
  const creditTransactionId = crypto.randomUUID();
  const creditCategory = storeCreditRefundReversalCategory({
    ...params,
    cycle: restorations.length + 1,
  });
  const insertResult = await tx
    .insert(credit_transactions)
    .values({
      id: creditTransactionId,
      kilo_user_id: clawback.kiloUserId,
      amount_microdollars: amountMicrodollars,
      is_free: clawback.isFree,
      description: creditPackRestorationDescription(params.paymentProvider),
      credit_category: creditCategory,
      check_category_uniqueness: true,
      original_baseline_microdollars_used: clawback.microdollarsUsed,
    })
    .onConflictDoNothing();

  if ((insertResult.rowCount ?? 0) === 0) {
    // Another delivery of this cycle won the insert. Return its restoration
    // without touching the balance again.
    const existingRows = await tx
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, clawback.kiloUserId),
          eq(credit_transactions.credit_category, creditCategory)
        )
      )
      .limit(1);
    return {
      restored: false,
      creditTransactionId: existingRows[0]?.id ?? null,
      amountMicrodollars: 0,
    };
  }

  await tx
    .update(kilocode_users)
    .set({
      total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${amountMicrodollars}`,
    })
    .where(eq(kilocode_users.id, clawback.kiloUserId));

  return {
    restored: true,
    creditTransactionId,
    amountMicrodollars,
  };
}
