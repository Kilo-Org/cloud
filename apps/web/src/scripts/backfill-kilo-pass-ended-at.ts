/**
 * Backfills `kilo_pass_subscriptions.ended_at` for terminal Stripe subscriptions
 * whose row still has a null end date.
 *
 * The end date comes from the Stripe subscription's own `ended_at`/`canceled_at`
 * fields. `getStripeEndedAtIso()` is deliberately not used: it returns the
 * current time when Stripe has neither field, and inventing a date is worse than
 * leaving the column null, so such a row is skipped and counted as `undatable`.
 *
 * Dry run by default. Pass `--apply` to write, and `--resume=<row id>` to
 * continue after the `afterId` printed by an earlier run. Rows that failed are
 * not revisited by a resumed run; rerun without `--resume` to retry them.
 *
 *   pnpm --filter web script src/scripts/backfill-kilo-pass-ended-at.ts
 *   pnpm --filter web script src/scripts/backfill-kilo-pass-ended-at.ts --apply
 *   pnpm --filter web script src/scripts/backfill-kilo-pass-ended-at.ts --apply --resume=<id>
 */
import '@/lib/load-env';
import { kilo_pass_subscriptions } from '@kilocode/db/schema';
import { closeAllDrizzleConnections, db } from '@kilocode/web-shared/lib/drizzle';
import { dayjs } from '@kilocode/web-shared/lib/kilo-pass/dayjs';
import { KiloPassPaymentProvider } from '@kilocode/web-shared/lib/kilo-pass/enums';
import { client as stripe } from '@kilocode/web-shared/lib/stripe-client';
import { and, asc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';

const BATCH_SIZE = 100;

// Same set as `isKiloPassSubscriptionEndedStatus` in
// `@kilocode/worker-utils/kilo-pass-bonus-projection`; the SQL filter needs the
// literals, so keep both in sync.
const TERMINAL_STATUSES = ['canceled', 'unpaid', 'incomplete_expired'] as const;

const isDryRun = !process.argv.includes('--apply');
const resumeArg = process.argv.find(arg => arg.startsWith('--resume='));
const resumeAfterId = resumeArg ? resumeArg.slice('--resume='.length) || null : null;

type Summary = {
  scanned: number;
  dated: number;
  undatable: number;
  failed: number;
  written: number;
  afterId: string | null;
};

/**
 * Returns the end date the provider reports for a subscription, or null when
 * Stripe has neither `ended_at` nor `canceled_at`.
 */
async function providerEndedAtIso(stripeSubscriptionId: string): Promise<string | null> {
  const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const seconds = subscription.ended_at ?? subscription.canceled_at ?? null;
  if (seconds === null) {
    return null;
  }
  return dayjs.unix(seconds).utc().toISOString();
}

async function run(): Promise<Summary> {
  const summary: Summary = {
    scanned: 0,
    dated: 0,
    undatable: 0,
    failed: 0,
    written: 0,
    afterId: resumeAfterId,
  };

  for (;;) {
    const pendingWhere = and(
      eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.Stripe),
      inArray(kilo_pass_subscriptions.status, [...TERMINAL_STATUSES]),
      isNotNull(kilo_pass_subscriptions.stripe_subscription_id),
      isNull(kilo_pass_subscriptions.ended_at)
    );

    const rows = await db
      .select({
        id: kilo_pass_subscriptions.id,
        stripeSubscriptionId: kilo_pass_subscriptions.stripe_subscription_id,
      })
      .from(kilo_pass_subscriptions)
      .where(
        summary.afterId === null
          ? pendingWhere
          : and(pendingWhere, gt(kilo_pass_subscriptions.id, summary.afterId))
      )
      .orderBy(asc(kilo_pass_subscriptions.id))
      .limit(BATCH_SIZE);

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      summary.scanned += 1;
      summary.afterId = row.id;

      // `isNotNull` in the WHERE clause guarantees a value; the guard keeps the
      // type sound.
      if (row.stripeSubscriptionId === null) {
        continue;
      }

      try {
        const endedAt = await providerEndedAtIso(row.stripeSubscriptionId);
        if (endedAt === null) {
          summary.undatable += 1;
          continue;
        }

        summary.dated += 1;
        if (isDryRun) {
          continue;
        }

        const updated = await db
          .update(kilo_pass_subscriptions)
          .set({ ended_at: endedAt })
          .where(
            and(eq(kilo_pass_subscriptions.id, row.id), isNull(kilo_pass_subscriptions.ended_at))
          )
          .returning({ id: kilo_pass_subscriptions.id });
        summary.written += updated.length;
      } catch {
        // Deliberately not logged: Stripe errors can echo subscription or customer
        // identifiers, and one bad row must not abort the run.
        summary.failed += 1;
      }
    }

    console.log(JSON.stringify({ afterId: summary.afterId, scanned: summary.scanned }));
  }

  return summary;
}

async function main() {
  try {
    const summary = await run();
    console.log(JSON.stringify({ dryRun: isDryRun, ...summary }));
  } finally {
    await closeAllDrizzleConnections();
  }
}

main().catch(error => {
  console.error(
    'backfill-kilo-pass-ended-at failed:',
    error instanceof Error ? error.name : 'unknown error'
  );
  process.exitCode = 1;
});
