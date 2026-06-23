import '@/lib/load-env';

import { closeAllDrizzleConnections, db } from '@/lib/drizzle';
import { client as stripe } from '@/lib/stripe-client';
import { KILOCLAW_COMMIT_SALES_CUTOFF, isBeforeKiloClawCommitSalesCutoff } from '@kilocode/db';
import { getClawPlanForStripePriceId } from '@/lib/kiloclaw/stripe-price-ids.server';
import { sql } from 'drizzle-orm';

const isDryRun = !process.argv.includes('--run-actually');

type SessionKind = 'direct_commit' | 'kilo_pass_commit_intent' | 'other';

function getSessionKind(
  session: Awaited<ReturnType<typeof stripe.checkout.sessions.retrieve>>
): SessionKind {
  if (session.status !== 'open') return 'other';

  if (session.metadata?.type === 'kiloclaw') {
    const priceId = session.line_items?.data[0]?.price?.id;
    if (session.metadata.plan === 'commit' || getClawPlanForStripePriceId(priceId) === 'commit') {
      return 'direct_commit';
    }
  }

  if (
    session.metadata?.type === 'kilo-pass' &&
    (session.metadata.clawHostingPlan === 'commit' ||
      session.metadata.kiloclawHostingPlan === 'commit')
  ) {
    return 'kilo_pass_commit_intent';
  }

  return 'other';
}

async function main() {
  const { rows } = await db.execute<{ now: string }>(sql`SELECT now() AS now`);
  const databaseNow = rows[0]?.now ? new Date(rows[0].now).toISOString() : null;
  if (!databaseNow) throw new Error('database_now_unavailable');
  if (!isDryRun && isBeforeKiloClawCommitSalesCutoff(databaseNow)) {
    throw new Error('checkout_expiration_apply_must_run_at_or_after_cutoff');
  }

  console.log(
    JSON.stringify({
      event: 'kiloclaw_commit_checkout_expiration_started',
      mode: isDryRun ? 'dry_run' : 'apply',
      databaseNow,
      cutoff: KILOCLAW_COMMIT_SALES_CUTOFF,
    })
  );

  let openSessions = 0;
  let directCommitSessions = 0;
  let kiloPassCommitIntents = 0;
  let expired = 0;
  let failed = 0;

  for await (const summary of stripe.checkout.sessions.list({ status: 'open', limit: 100 })) {
    openSessions++;
    const session = await stripe.checkout.sessions.retrieve(summary.id, {
      expand: ['line_items'],
    });
    const kind = getSessionKind(session);

    if (kind === 'kilo_pass_commit_intent') {
      kiloPassCommitIntents++;
      console.log(
        JSON.stringify({
          event: 'kiloclaw_kilo_pass_commit_intent_reported',
          checkoutSessionId: session.id,
          createdAt: new Date(session.created * 1000).toISOString(),
          action: 'reported_only',
        })
      );
      continue;
    }

    if (kind !== 'direct_commit') continue;
    directCommitSessions++;

    if (isDryRun) {
      console.log(
        JSON.stringify({
          event: 'kiloclaw_direct_commit_checkout_would_expire',
          checkoutSessionId: session.id,
          createdAt: new Date(session.created * 1000).toISOString(),
        })
      );
      continue;
    }

    try {
      await stripe.checkout.sessions.expire(session.id);
      expired++;
      console.log(
        JSON.stringify({
          event: 'kiloclaw_direct_commit_checkout_expired',
          checkoutSessionId: session.id,
        })
      );
    } catch (error) {
      failed++;
      console.log(
        JSON.stringify({
          event: 'kiloclaw_direct_commit_checkout_expiration_failed',
          checkoutSessionId: session.id,
          error: error instanceof Error ? error.name : 'UnknownError',
        })
      );
    }
  }

  console.log(
    JSON.stringify({
      event: 'kiloclaw_commit_checkout_expiration_completed',
      mode: isDryRun ? 'dry_run' : 'apply',
      openSessionsScanned: openSessions,
      directCommitSessions,
      kiloPassCommitIntents,
      expired,
      failed,
    })
  );

  if (failed > 0) process.exitCode = 1;
}

void main()
  .catch(error => {
    console.error(
      JSON.stringify({
        event: 'kiloclaw_commit_checkout_expiration_failed',
        error: error instanceof Error ? error.name : 'UnknownError',
      })
    );
    process.exitCode = 1;
  })
  .finally(() => closeAllDrizzleConnections());
