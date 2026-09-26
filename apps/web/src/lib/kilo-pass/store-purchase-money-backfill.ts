/**
 * Backfills `amount_charged_minor_units`, `currency`, and `tax_minor_units` on
 * Google Play purchases that were recorded before those columns existed.
 *
 * The stored receipt cannot supply the money: for Google Play,
 * `raw_payload_json` holds the `SubscriptionPurchaseV2` payload, which has no
 * price, tax, or currency field. The Play order behind the receipt's stored
 * `provider_transaction_id`, however, does carry `total` and `tax`, so this
 * module re-reads each purchase's order and maps it with
 * `googlePlayOrderMoneyForProduct`.
 *
 * Idempotent and resumable: only rows that are still unsettled (no
 * `money_backfill_attempted_at`) and have both amounts NULL are selected,
 * newest purchase first, at most `limit` per call, so a completed run leaves
 * nothing to do and an interrupted run continues where it stopped. A row whose
 * order carries no money is counted `skipped` and marked attempted, so it is
 * never re-read and a bounded run still converges past it; a fetch or parse
 * error counts `failed`, records its row/order id and error message in
 * `failures`, stays unmarked so the next run retries it, and never aborts the
 * batch. Every value is validated against the schema's check constraints before
 * the update, so a single unusable order can never abort the batch.
 */
import type { androidpublisher_v3 } from '@googleapis/androidpublisher';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';

import { kilo_pass_store_purchases } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';

import { getGooglePlaySubscriptionOrder } from './google-play-sdk';
import {
  googlePlayOrderMoneyForProduct,
  MAX_STORABLE_MINOR_UNITS,
  type StorePurchaseMoney,
} from './store-purchase-money';

export const DEFAULT_BACKFILL_GOOGLE_PLAY_PURCHASE_AMOUNTS_LIMIT = 500;

const ISO_4217_CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * Why one row's order lookup failed. Carries ids and a message only: an auth
 * failure's stack or payload can contain credential material, so the caller
 * must never log the thrown value itself.
 */
export type BackfillStorePurchaseAmountsFailure = {
  /** `kilo_pass_store_purchases.id` of the row whose order lookup failed. */
  rowId: string;
  /** The Play order id that was looked up (the stored `provider_transaction_id`). */
  orderId: string;
  /** `error.message` only. Never the stack, and never the thrown value. */
  reason: string;
};

export type BackfillStorePurchaseAmountsResult = {
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
  /**
   * One entry per `failed` row, in scan order, so `failed === failures.length`.
   * Without these the operator sees a bare `failed=N` and cannot tell a
   * credential misconfiguration from a quota rejection or one bad order.
   */
  failures: BackfillStorePurchaseAmountsFailure[];
};

/** Message only: the stack of an auth or parse failure can carry key material. */
function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns the value only when it is a non-negative integer no larger than the
 * `integer` columns accept, which is what the `amount_charged_minor_units` /
 * `tax_minor_units` columns and their non-negative check constraints require.
 * A larger value would fail the update, so it is treated as absent.
 */
function nonNegativeIntegerOrNull(value: number | null): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  if (value > MAX_STORABLE_MINOR_UNITS) return null;
  return value;
}

/**
 * Validates a mapped money value against the s1 check constraints. Returns null
 * for a row that carries no usable money: the update must not write a
 * partially-guessed value, and `kilo_pass_store_purchases_currency_required_check`
 * rejects an amount or tax without a currency.
 */
function sanitizedMoneyColumns(
  money: StorePurchaseMoney
): Pick<
  typeof kilo_pass_store_purchases.$inferInsert,
  'amount_charged_minor_units' | 'currency' | 'tax_minor_units'
> | null {
  const amountChargedMinorUnits = nonNegativeIntegerOrNull(money.amountChargedMinorUnits);
  const taxMinorUnits = nonNegativeIntegerOrNull(money.taxMinorUnits);
  const currency = ISO_4217_CURRENCY_CODE.test(money.currency ?? '') ? money.currency : null;

  const hasMinorUnits = amountChargedMinorUnits !== null || taxMinorUnits !== null;
  if (!hasMinorUnits && currency === null) return null;
  if (hasMinorUnits && currency === null) return null;

  return {
    amount_charged_minor_units: amountChargedMinorUnits,
    currency,
    tax_minor_units: taxMinorUnits,
  };
}

/**
 * Fetches the Play order of each eligible Google Play purchase, fills the three
 * money columns from it, and returns the batch counts. `scanned` is the number
 * of rows selected into the batch; `updated + skipped + failed === scanned`.
 * Each failure records its row/order id and the error message in `failures`.
 */
export async function backfillGooglePlayPurchaseAmounts(params?: {
  /** Maximum rows per call. Defaults to `DEFAULT_BACKFILL_GOOGLE_PLAY_PURCHASE_AMOUNTS_LIMIT`. */
  limit?: number;
  /** Order lookup, injectable for tests. Defaults to `getGooglePlaySubscriptionOrder`. */
  orderFetcher?: (orderId: string) => Promise<androidpublisher_v3.Schema$Order>;
  /** Counts the batch without writing any update. */
  dryRun?: boolean;
}): Promise<BackfillStorePurchaseAmountsResult> {
  const orderFetcher = params?.orderFetcher ?? getGooglePlaySubscriptionOrder;
  const dryRun = params?.dryRun ?? false;
  const requestedLimit = params?.limit ?? DEFAULT_BACKFILL_GOOGLE_PLAY_PURCHASE_AMOUNTS_LIMIT;
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit > 0
      ? requestedLimit
      : DEFAULT_BACKFILL_GOOGLE_PLAY_PURCHASE_AMOUNTS_LIMIT;

  const rows = await db
    .select({
      id: kilo_pass_store_purchases.id,
      productId: kilo_pass_store_purchases.product_id,
      providerTransactionId: kilo_pass_store_purchases.provider_transaction_id,
    })
    .from(kilo_pass_store_purchases)
    .where(
      and(
        eq(kilo_pass_store_purchases.payment_provider, KiloPassPaymentProvider.GooglePlay),
        isNotNull(kilo_pass_store_purchases.provider_transaction_id),
        // Settled rows are never looked at again. The money guards also keep
        // rows the purchase path already filled out of the batch: those carry
        // no marker but do have money.
        isNull(kilo_pass_store_purchases.money_backfill_attempted_at),
        isNull(kilo_pass_store_purchases.amount_charged_minor_units),
        isNull(kilo_pass_store_purchases.tax_minor_units)
      )
    )
    .orderBy(desc(kilo_pass_store_purchases.purchased_at), desc(kilo_pass_store_purchases.id))
    .limit(limit);

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const failures: BackfillStorePurchaseAmountsFailure[] = [];
  const attemptedAt = new Date().toISOString();

  for (const row of rows) {
    const orderId = row.providerTransactionId;
    if (orderId === null) {
      // The column is NOT NULL, but the query guards it so a future schema
      // change can never hand `null` to the Play API.
      skipped += 1;
      continue;
    }

    let money: StorePurchaseMoney;
    try {
      const order = await orderFetcher(orderId);
      money = googlePlayOrderMoneyForProduct(order, row.productId);
    } catch (error) {
      failed += 1;
      failures.push({ rowId: row.id, orderId, reason: failureReason(error) });
      continue;
    }

    const columns = sanitizedMoneyColumns(money);
    if (columns === null) {
      // Play has no money for this order. Mark the row attempted so later runs
      // skip it: leaving it NULL would re-select it in every bounded batch and
      // the backfill would never report completion.
      if (!dryRun) {
        await db
          .update(kilo_pass_store_purchases)
          .set({ money_backfill_attempted_at: attemptedAt })
          .where(eq(kilo_pass_store_purchases.id, row.id));
      }
      skipped += 1;
      continue;
    }

    if (!dryRun) {
      await db
        .update(kilo_pass_store_purchases)
        .set({ ...columns, money_backfill_attempted_at: attemptedAt })
        .where(eq(kilo_pass_store_purchases.id, row.id));
    }
    updated += 1;
  }

  return { scanned: rows.length, updated, skipped, failed, failures };
}
