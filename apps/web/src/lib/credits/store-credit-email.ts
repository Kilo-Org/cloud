import { captureException } from '@sentry/nextjs';
import { and, eq, gt, isNull, lt, lte, notExists, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import {
  credit_transactions,
  kilo_pass_audit_log,
  kilo_pass_issuance_items,
  kilocode_users,
  transactional_email_log,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { sendStoreCreditWebTipEmail } from '@kilocode/web-shared/lib/store-credit-web-tip-email';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassPaymentProvider,
} from '@kilocode/web-shared/lib/kilo-pass/enums';

import { findEffectiveStoreCreditRefundEvent } from './store-refund';

const EMAIL_TYPE = 'store_credit_web_tip';
const DELAY_MS = 24 * 60 * 60 * 1000;
const MAX_BATCH_SIZE = 100;
const purchaseSchema = z.object({
  paymentProvider: z.enum([KiloPassPaymentProvider.AppStore, KiloPassPaymentProvider.GooglePlay]),
  providerTransactionId: z.string().min(1),
});

function eligiblePurchases(now: Date, condition: SQL) {
  const webPayment = alias(credit_transactions, 'web_payment');
  const clawback = alias(credit_transactions, 'store_clawback');
  const restoration = alias(credit_transactions, 'store_restoration');
  const refundPrefix = sql`'store-credit-refund:' || (${kilo_pass_audit_log.payload_json}->>'paymentProvider') || ':' || (${kilo_pass_audit_log.payload_json}->>'providerTransactionId')`;

  return db
    .select({
      auditId: kilo_pass_audit_log.id,
      userId: kilocode_users.id,
      email: kilocode_users.google_user_email,
      payload: kilo_pass_audit_log.payload_json,
    })
    .from(kilo_pass_audit_log)
    .innerJoin(kilocode_users, eq(kilocode_users.id, kilo_pass_audit_log.kilo_user_id))
    .innerJoin(
      credit_transactions,
      and(
        eq(credit_transactions.id, kilo_pass_audit_log.related_credit_transaction_id),
        eq(credit_transactions.kilo_user_id, kilocode_users.id)
      )
    )
    .where(
      and(
        condition,
        eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.StorePurchaseCompleted),
        eq(kilo_pass_audit_log.result, KiloPassAuditLogResult.Success),
        sql`${kilo_pass_audit_log.payload_json} @> '{"kind":"store_credit_pack","environment":"Production","firstCreditPackPurchase":true}'::jsonb`,
        eq(credit_transactions.is_free, false),
        gt(credit_transactions.amount_microdollars, 0),
        lte(credit_transactions.created_at, new Date(now.getTime() - DELAY_MS).toISOString()),
        isNull(kilocode_users.blocked_reason),
        eq(kilocode_users.is_bot, false),
        eq(kilocode_users.personal_account_disabled, false),
        isNull(kilocode_users.account_deletion_requested_at),
        notExists(
          db
            .select({ id: webPayment.id })
            .from(webPayment)
            .where(
              and(
                eq(webPayment.kilo_user_id, kilocode_users.id),
                isNull(webPayment.organization_id),
                eq(webPayment.is_free, false),
                gt(webPayment.amount_microdollars, 0),
                or(
                  sql`starts_with(${webPayment.stripe_payment_id}, 'ch_')`,
                  sql`starts_with(${webPayment.stripe_payment_id}, 'pi_')`,
                  sql`${webPayment.coinbase_credit_block_id} IS NOT NULL`
                ),
                notExists(
                  db
                    .select({ id: kilo_pass_issuance_items.id })
                    .from(kilo_pass_issuance_items)
                    .where(eq(kilo_pass_issuance_items.credit_transaction_id, webPayment.id))
                )
              )
            )
        ),
        // A Play grant may use a token digest while its event uses an order id.
        // The refund handler's ledger clawback still uses the grant's identity.
        notExists(
          db
            .select({ id: clawback.id })
            .from(clawback)
            .where(
              and(
                eq(clawback.kilo_user_id, kilocode_users.id),
                lt(clawback.amount_microdollars, 0),
                or(
                  eq(clawback.credit_category, refundPrefix),
                  sql`starts_with(${clawback.credit_category}, ${refundPrefix} || ':')`
                ),
                notExists(
                  db
                    .select({ id: restoration.id })
                    .from(restoration)
                    .where(
                      and(
                        eq(restoration.kilo_user_id, kilocode_users.id),
                        gt(restoration.amount_microdollars, 0),
                        sql`${restoration.credit_category} = 'store-credit-refund-reversal:' || substr(${clawback.credit_category}, length('store-credit-refund:') + 1)`
                      )
                    )
                )
              )
            )
        )
      )
    );
}

/** Delivers only newly scheduled first production grants; existing buyers are not backfilled. */
export async function dispatchStoreCreditWebTipEmails(
  options: {
    now?: Date;
    limit?: number;
    sendEmail?: typeof sendStoreCreditWebTipEmail;
  } = {}
) {
  const now = options.now ?? new Date();
  const sendEmail = options.sendEmail ?? sendStoreCreditWebTipEmail;
  const candidates = await eligiblePurchases(
    now,
    notExists(
      db
        .select({ id: transactional_email_log.id })
        .from(transactional_email_log)
        .where(
          and(
            eq(transactional_email_log.email_type, EMAIL_TYPE),
            eq(transactional_email_log.idempotency_key, kilocode_users.id)
          )
        )
    )
  )
    .orderBy(credit_transactions.created_at, kilo_pass_audit_log.id)
    .limit(Math.max(1, Math.min(options.limit ?? MAX_BATCH_SIZE, MAX_BATCH_SIZE)));
  const summary = {
    selected: candidates.length,
    claimed: 0,
    sent: 0,
    skipped: 0,
    providerNotConfigured: 0,
    errors: 0,
  };

  for (const candidate of candidates) {
    try {
      // Commit the unique claim before any external call. An overlapping cron
      // must never resend after a timeout that may have accepted the message.
      const claim = await db
        .insert(transactional_email_log)
        .values({
          user_id: candidate.userId,
          email_type: EMAIL_TYPE,
          idempotency_key: candidate.userId,
        })
        .onConflictDoNothing();
      if ((claim.rowCount ?? 0) === 0) {
        summary.skipped += 1;
        continue;
      }
      summary.claimed += 1;

      // Re-read the primary after claiming: account status, web purchases and
      // refund state can change while another recipient is being delivered.
      const [current] = await eligiblePurchases(now, eq(kilo_pass_audit_log.id, candidate.auditId));
      if (!current) {
        summary.skipped += 1;
        continue;
      }
      const purchase = purchaseSchema.parse(current.payload);
      const refunded = await findEffectiveStoreCreditRefundEvent(db, {
        paymentProvider: purchase.paymentProvider,
        providerTransactionIds: [purchase.providerTransactionId],
      });
      if (refunded) {
        summary.skipped += 1;
        continue;
      }

      const result = await sendEmail(current.email);
      if (result.sent) {
        summary.sent += 1;
      } else if (result.reason === 'provider_not_configured') {
        // The provider was never called. This is the only safe reason to
        // release a claim and let the next hourly run try again.
        await db
          .delete(transactional_email_log)
          .where(
            and(
              eq(transactional_email_log.email_type, EMAIL_TYPE),
              eq(transactional_email_log.idempotency_key, current.userId)
            )
          );
        summary.providerNotConfigured += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      summary.errors += 1;
      captureException(error, {
        tags: { source: EMAIL_TYPE },
        extra: { kilo_user_id: candidate.userId },
      });
      // Keep the committed claim on ambiguous delivery errors.
    }
  }

  return summary;
}
