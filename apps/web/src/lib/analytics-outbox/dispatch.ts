/**
 * Cron drainer for the durable analytics outbox (P2-A-04).
 *
 * One pass, in this order: reclaim stale claims, claim due rows, send, mark
 * delivered/retry/fail, purge, ledger backstop. The row transitions live in
 * `@kilocode/db/analytics-outbox`; this module orchestrates them and sends to
 * PostHog. Each send carries the deterministic `event_uuid` as the PostHog
 * event UUID so PostHog dedupes replayed at-least-once deliveries, and waits
 * for the client flush so a row is never marked delivered before PostHog has
 * it. Outside production the client is a no-op, so rows still advance.
 */
import 'server-only';

import { db } from '@/lib/drizzle';
import PostHogClient, { flushPostHog } from '@/lib/posthog';
import { sentryLogger } from '@/lib/utils.server';
import {
  claimDueOutboxEvents,
  markOutboxDelivered,
  markOutboxRetry,
  purgeExpired,
  reclaimStaleSendingEvents,
} from '@kilocode/db/analytics-outbox';
import type { AnalyticsEventOutboxRow } from '@kilocode/db/schema';

const logInfo = sentryLogger('analytics-outbox', 'info');
const logWarning = sentryLogger('analytics-outbox', 'warning');
const logError = sentryLogger('analytics-outbox', 'error');

const DEFAULT_CLAIM_LIMIT = 100;

export type AnalyticsOutboxDispatchSummary = {
  reclaimed: number;
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
  outboxDeliveredPurged: number;
  outboxFailedPurged: number;
  expiredUnsettledLedgerSettled: number;
};

type OutboxDispatchOutcome = 'delivered' | 'retried' | 'failed';

/**
 * Drains the analytics outbox in one cron pass and returns a per-step summary
 * for the cron route.
 */
export async function dispatchQueuedAnalyticsEvents(params?: {
  limit?: number;
}): Promise<AnalyticsOutboxDispatchSummary> {
  // Reclaim `sending` claims left behind by crashed drainers.
  const reclaimed = await reclaimStaleSendingEvents(db);
  for (const row of reclaimed) {
    logWarning('Reclaimed stale analytics outbox claim', outboxLogFields(row));
  }

  // Claim due `pending` rows in bounded batches and send each to PostHog.
  const counts: Record<OutboxDispatchOutcome, number> = { delivered: 0, retried: 0, failed: 0 };
  let claimedTotal = 0;
  let remaining = params?.limit ?? DEFAULT_CLAIM_LIMIT;
  while (remaining > 0) {
    const claimed = await claimDueOutboxEvents(db, remaining);
    if (claimed.length === 0) {
      break;
    }
    claimedTotal += claimed.length;
    remaining -= claimed.length;
    for (const row of claimed) {
      counts[await dispatchOutboxEvent(row)] += 1;
    }
  }

  // DEC-01 retention purge and the expired-unsettled ledger backstop.
  const purge = await purgeExpired(db);

  return { reclaimed: reclaimed.length, claimed: claimedTotal, ...counts, ...purge };
}

/**
 * Sends one claimed outbox event and drives its delivery mark. Marks are
 * claim-fenced on `claimed_at`, so a late mark from a reclaimed claim is a
 * no-op that leaves the row to the newer claim.
 */
async function dispatchOutboxEvent(row: AnalyticsEventOutboxRow): Promise<OutboxDispatchOutcome> {
  const claimedAt = row.claimed_at;
  if (!claimedAt) {
    // Unreachable through `claimDueOutboxEvents`, which always stamps the claim.
    logError('Analytics outbox row claimed without a claim token', outboxLogFields(row));
    return 'failed';
  }

  try {
    PostHogClient().capture({
      distinctId: row.distinct_id,
      event: row.event_name,
      properties: row.properties,
      uuid: row.event_uuid,
    });
    await flushPostHog();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError('Analytics outbox send failed', { ...outboxLogFields(row), error: message });
    const result = await markOutboxRetry(db, { eventId: row.id, claimedAt, error: message });
    // A null result means a stale sender: the claim was reclaimed or the row is
    // already terminal, so the newer claim owns the retry.
    return result?.outcome === 'failed' ? 'failed' : 'retried';
  }

  const delivered = await markOutboxDelivered(db, { eventId: row.id, claimedAt });
  if (!delivered) {
    // The claim was reclaimed and re-claimed mid-flight; the event was sent
    // and the newer claim owns the row now.
    logWarning(
      'Analytics outbox delivery mark skipped: claim already transitioned',
      outboxLogFields(row)
    );
    return 'delivered';
  }
  logInfo('Delivered analytics outbox event', outboxLogFields(delivered));
  return 'delivered';
}

function outboxLogFields(row: AnalyticsEventOutboxRow): Record<string, unknown> {
  return {
    analytics_event_id: row.id,
    analytics_event_uuid: row.event_uuid,
    analytics_event_name: row.event_name,
    status: row.status,
    attempts: row.attempts,
    dispatch_source: 'cron',
  };
}
