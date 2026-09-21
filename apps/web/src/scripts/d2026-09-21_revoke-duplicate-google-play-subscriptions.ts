/**
 * One-off reversal of Google Play subscriptions that were charged but never
 * admitted, because the user already held a Kilo Pass.
 *
 * A user holds at most one Kilo Pass, so the second paid subscription is a
 * duplicate. These orders were classified as a permanent provider/user mismatch
 * and retired without a purchase row, which left the charge invisible. This
 * script finds them from the purchase operation ledger, refunds each one through
 * Play, and records the reversal with the same code path the live notification
 * handler now uses.
 *
 * Targets are derived from `operation_ledgers` (domain `purchase`, intent
 * `complete_store_purchase`, status `failed`, outcome code = "You already have
 * an active Kilo Pass subscription"). An order that already has a purchase row,
 * or a recorded duplicate reversal, is skipped, so a re-run converges.
 *
 * Defaults to a listing; `--execute` performs the reversal.
 *
 * Requires GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON in the target environment.
 *
 * Usage:
 *   pnpm --filter web script src/scripts/d2026-09-21_revoke-duplicate-google-play-subscriptions.ts
 *   pnpm --filter web script src/scripts/d2026-09-21_revoke-duplicate-google-play-subscriptions.ts --execute
 */

import '../lib/load-env';

import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { closeAllDrizzleConnections, db } from '@/lib/drizzle';
import {
  kilo_pass_audit_log,
  kilo_pass_store_events,
  kilo_pass_store_purchases,
  operation_ledgers,
} from '@kilocode/db/schema';
import { KiloPassAuditLogAction, KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';
import { reverseDuplicateGooglePlaySubscription } from '@/lib/kilo-pass/google-play-duplicate-subscription';
import {
  assertGooglePlayServiceAccountConfigured,
  getGooglePlaySubscriptionOrder,
} from '@/lib/kilo-pass/google-play-sdk';
import { googlePlayOrderMoneyForProduct } from '@/lib/kilo-pass/store-purchase-money';
import { ACTIVE_KILO_PASS_SUBSCRIPTION_MESSAGE } from '@/lib/kilo-pass/store-subscription-completion';

const USAGE = [
  'Reverses charged Google Play subscriptions that were rejected as duplicate Kilo Pass purchases.',
  '',
  'Usage:',
  '  pnpm --filter web script src/scripts/d2026-09-21_revoke-duplicate-google-play-subscriptions.ts [--execute]',
  '',
  '  (default)   List the targets and the refund that --execute would issue.',
  '  --execute   Refund and revoke each target through Google Play, then record the reversal.',
  '  --help      Print this message.',
].join('\n');

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const unknown = argv.filter(arg => arg !== '--execute');
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(', ')}`);
  const execute = argv.includes('--execute');

  assertGooglePlayServiceAccountConfigured();
  console.log('GOOGLE_PLAY_PUBLISHER_SERVICE_ACCOUNT_JSON: set and valid');
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);

  const rejected = await db
    .select({
      orderId: operation_ledgers.operation_key,
      kiloUserId: operation_ledgers.kilo_user_id,
    })
    .from(operation_ledgers)
    .where(
      and(
        eq(operation_ledgers.domain, 'purchase'),
        eq(operation_ledgers.intent, 'complete_store_purchase'),
        eq(operation_ledgers.status, 'failed'),
        eq(operation_ledgers.outcome_code, ACTIVE_KILO_PASS_SUBSCRIPTION_MESSAGE)
      )
    )
    .orderBy(asc(operation_ledgers.admitted_at));

  let revoked = 0;
  let skipped = 0;

  for (const target of rejected) {
    const existingPurchase = await db.query.kilo_pass_store_purchases.findFirst({
      columns: { id: true },
      where: and(
        eq(kilo_pass_store_purchases.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_store_purchases.provider_transaction_id, target.orderId)
      ),
    });
    if (existingPurchase) {
      skipped += 1;
      console.log(`[SKIP] order=${target.orderId} reason=purchase-row-exists`);
      continue;
    }

    const alreadyReversed = await db
      .select({ id: kilo_pass_audit_log.id })
      .from(kilo_pass_audit_log)
      .where(
        and(
          eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.StoreSubscriptionRefunded),
          sql`${kilo_pass_audit_log.payload_json}->>'duplicateActiveSubscription' = 'true'`,
          sql`${kilo_pass_audit_log.payload_json}->>'providerTransactionId' = ${target.orderId}`
        )
      )
      .limit(1);
    if (alreadyReversed.length > 0) {
      skipped += 1;
      console.log(`[SKIP] order=${target.orderId} reason=already-reversed`);
      continue;
    }

    const event = await db.query.kilo_pass_store_events.findFirst({
      columns: { event_id: true, provider_subscription_id: true, payload_json: true },
      where: and(
        eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_store_events.provider_transaction_id, target.orderId)
      ),
      orderBy: desc(kilo_pass_store_events.created_at),
    });
    if (!event || !event.provider_subscription_id) {
      // The ledger row is the durable record of the rejected order. Without the
      // notification there is no purchase token, so the charge cannot be
      // reversed from here; surface it instead of guessing.
      skipped += 1;
      console.log(`[SKIP] order=${target.orderId} reason=no-store-event-token`);
      continue;
    }

    const productId = String(event.payload_json?.productId ?? '');
    const order = await getGooglePlaySubscriptionOrder(target.orderId);
    const money = googlePlayOrderMoneyForProduct(order, productId);

    if (!execute) {
      console.log(
        `[DRY RUN] order=${target.orderId} product=${productId} ` +
          `amount=${money.amountChargedMinorUnits} currency=${money.currency} tax=${money.taxMinorUnits}`
      );
      continue;
    }

    await reverseDuplicateGooglePlaySubscription({
      kiloUserId: target.kiloUserId,
      productId,
      purchaseToken: event.provider_subscription_id,
      providerSubscriptionId: event.provider_subscription_id,
      providerTransactionId: target.orderId,
      amountChargedMinorUnits: money.amountChargedMinorUnits,
      currency: money.currency,
      taxMinorUnits: money.taxMinorUnits,
      messageId: null,
      eventId: event.event_id,
    });
    revoked += 1;
    console.log(
      `[REVOKED] order=${target.orderId} product=${productId} ` +
        `amount=${money.amountChargedMinorUnits} currency=${money.currency}`
    );
  }

  console.log(
    `targets=${rejected.length} revoked=${revoked} skipped=${skipped} executed=${execute}`
  );
}

void main()
  .catch(error => {
    console.error('Fatal error:', error);
    process.exitCode = 1;
  })
  .finally(() => closeAllDrizzleConnections());
