/**
 * Finds the Stripe event IDs for affected Kilo Pass invoices and resends them
 * via the Stripe CLI to re-trigger the webhook handler.
 *
 * Background:
 *   getInvoiceIssueMonth used invoice.period_start, which Stripe documents as
 *   looking back one period for subscription invoices. This caused renewal
 *   invoices to compute the wrong issue_month, colliding with the previous
 *   month's issuance and skipping credit issuance.
 *
 * The script queries the database directly for affected users:
 *   - Monthly subscriptions where base_credits_issued was skipped_idempotent
 *   - The audit log created_at month is later than the issuance issue_month
 *     (indicating the issue month was computed incorrectly)
 *
 * Prerequisites:
 *   - The fix for getInvoiceIssueMonth must be deployed first.
 *   - STRIPE_SECRET_KEY must be set in the environment (production key for prod invoices).
 *   - STRIPE_WEBHOOK_ENDPOINT_ID must be set (e.g. we_xxxxx — the webhook endpoint to deliver to).
 *   - POSTGRES_SCRIPT_URL must be set (used when IS_SCRIPT=true).
 *   - The `stripe` CLI must be installed and available on PATH.
 *
 * Usage:
 *   STRIPE_WEBHOOK_ENDPOINT_ID=we_xxxxx pnpm script src/scripts/d2026-02-15_backfill-kilo-pass-feb-credits.ts
 */

import Stripe from 'stripe';
import { execFileSync } from 'node:child_process';
import { getEnvVariable } from '@/lib/dotenvx';
import { db } from '@/lib/drizzle';
import { kilo_pass_audit_log, kilo_pass_issuances, kilo_pass_subscriptions } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassCadence,
} from '@/lib/kilo-pass/enums';

type AffectedRow = {
  stripe_invoice_id: string;
  created_at: string;
};

async function fetchAffectedInvoices(): Promise<AffectedRow[]> {
  const rows = await db
    .select({
      stripe_invoice_id: kilo_pass_audit_log.stripe_invoice_id,
      created_at: kilo_pass_audit_log.created_at,
    })
    .from(kilo_pass_audit_log)
    .innerJoin(
      kilo_pass_issuances,
      eq(kilo_pass_issuances.id, kilo_pass_audit_log.related_monthly_issuance_id)
    )
    .innerJoin(
      kilo_pass_subscriptions,
      eq(kilo_pass_subscriptions.id, kilo_pass_issuances.kilo_pass_subscription_id)
    )
    .where(
      and(
        eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.BaseCreditsIssued),
        eq(kilo_pass_audit_log.result, KiloPassAuditLogResult.SkippedIdempotent),
        sql`${kilo_pass_audit_log.payload_json}->>'reason' = 'issuance_item_already_exists'`,
        eq(kilo_pass_subscriptions.cadence, KiloPassCadence.Monthly),
        sql`date_trunc('month', ${kilo_pass_audit_log.created_at} AT TIME ZONE 'UTC') > ${kilo_pass_issuances.issue_month}::timestamp`
      )
    )
    .orderBy(sql`${kilo_pass_audit_log.created_at} DESC`);

  return rows.filter((r): r is AffectedRow => r.stripe_invoice_id != null && r.created_at != null);
}

function resendEvent(params: { eventId: string; apiKey: string; webhookEndpoint: string }): {
  ok: boolean;
  output: string;
} {
  const { eventId, apiKey, webhookEndpoint } = params;
  try {
    const output = execFileSync(
      'stripe',
      [
        'events',
        'resend',
        '--live',
        eventId,
        '--api-key',
        apiKey,
        '--webhook-endpoint',
        webhookEndpoint,
      ],
      { encoding: 'utf-8', timeout: 30_000 }
    );
    return { ok: true, output: output.trim() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: message };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const apiKey = getEnvVariable('STRIPE_SECRET_KEY');
  if (!apiKey) {
    console.error('Error: STRIPE_SECRET_KEY is not set');
    process.exit(1);
  }

  const webhookEndpoint = getEnvVariable('STRIPE_WEBHOOK_ENDPOINT_ID');
  if (!webhookEndpoint) {
    console.error('Error: STRIPE_WEBHOOK_ENDPOINT_ID is not set');
    process.exit(1);
  }

  const stripe = new Stripe(apiKey);

  console.log('Querying database for affected invoices...\n');
  const affectedRows = await fetchAffectedInvoices();

  if (affectedRows.length === 0) {
    console.log('No affected invoices found.');
    process.exit(0);
  }

  console.log(`Found ${affectedRows.length} affected invoices.\n`);
  console.log('Phase 1: Looking up Stripe event IDs...\n');

  const eventMap: Array<{ invoiceId: string; eventId: string }> = [];
  const lookupFailures: Array<{ invoiceId: string; reason: string }> = [];

  for (const row of affectedRows) {
    const invoiceId = row.stripe_invoice_id;

    // Narrow the event search to a window around the audit log timestamp.
    const auditTime = new Date(row.created_at).getTime() / 1000;
    const searchStart = Math.floor(auditTime - 3600);
    const searchEnd = Math.ceil(auditTime + 60);

    try {
      let foundEventId: string | null = null;

      for await (const event of stripe.events.list({
        type: 'invoice.paid',
        created: { gte: searchStart, lte: searchEnd },
        limit: 100,
      })) {
        const eventInvoice = event.data.object as Stripe.Invoice;
        if (eventInvoice.id === invoiceId) {
          foundEventId = event.id;
          break;
        }
      }

      if (foundEventId) {
        eventMap.push({ invoiceId, eventId: foundEventId });
        console.log(`  [OK] ${invoiceId} -> ${foundEventId}`);
      } else {
        lookupFailures.push({ invoiceId, reason: 'event not found in time window' });
        console.log(`  [MISS] ${invoiceId}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lookupFailures.push({ invoiceId, reason: message });
      console.log(`  [ERR] ${invoiceId} — ${message}`);
    }
  }

  console.log(
    `\nPhase 1 complete: ${eventMap.length} events found, ${lookupFailures.length} failed.\n`
  );

  if (lookupFailures.length > 0) {
    console.log('Lookup failures:');
    for (const f of lookupFailures) {
      console.log(`  ${f.invoiceId}: ${f.reason}`);
    }
    console.log('');
  }

  if (eventMap.length === 0) {
    console.log('No events to resend.');
    process.exit(0);
  }

  console.log(`Phase 2: Resending ${eventMap.length} events via Stripe CLI...\n`);

  let resendOk = 0;
  let resendFail = 0;

  for (const { invoiceId, eventId } of eventMap) {
    const result = resendEvent({ eventId, apiKey, webhookEndpoint });
    if (result.ok) {
      resendOk++;
      console.log(`  [RESENT] ${eventId} (${invoiceId})`);
    } else {
      resendFail++;
      console.log(`  [FAIL]   ${eventId} (${invoiceId}) — ${result.output}`);
    }

    await sleep(500);
  }

  console.log(`\nPhase 2 complete: ${resendOk} resent, ${resendFail} failed.`);

  if (lookupFailures.length > 0 || resendFail > 0) {
    process.exit(1);
  }

  process.exit(0);
}

void main();
