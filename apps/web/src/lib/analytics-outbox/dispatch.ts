/**
 * Cron drainer for the durable analytics outbox (P2-A-04).
 *
 * Walks the delivery state machine in one pass, in this order: reclaim, claim,
 * send, delivered/retry/fail, purge, and the expired-unsettled ledger
 * backstop. Row transitions themselves live in `@kilocode/db/analytics-outbox`;
 * this module only orchestrates them and performs the PostHog send.
 *
 * Delivery goes through `PostHogClient()`. Outside production that client is a
 * no-op, so rows still advance to `delivered`; the state machine is
 * environment-independent. Each send passes the deterministic `event_uuid` as
 * the PostHog event UUID (`posthog-node` 5.10.4 supports `EventMessage.uuid`),
 * which PostHog uses to dedupe replayed at-least-once deliveries. A
 * synchronous capture throw is a failed send and drives the DB-side backoff
 * retry or terminal failure.
 */
import 'server-only';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import PostHogClient from '@/lib/posthog';
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

type DatabaseClient = typeof db | DrizzleTransaction;

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
 * Drains the analytics outbox in one cron pass: reclaims stale `sending`
 * claims, claims due `pending` rows in bounded batches and sends each to
 * PostHog, then purges retained rows and settles expired non-terminal ledger
 * rows. Returns a per-step summary for the cron route.
 */
export async function dispatchQueuedAnalyticsEvents(params?: {
  database?: DatabaseClient;
  limit?: number;
}): Promise<AnalyticsOutboxDispatchSummary> {
  const database = params?.database ?? db;
  const limit = params?.limit ?? DEFAULT_CLAIM_LIMIT;
  const summary: AnalyticsOutboxDispatchSummary = {
    reclaimed: 0,
    claimed: 0,
    delivered: 0,
    retried: 0,
    failed: 0,
    outboxDeliveredPurged: 0,
    outboxFailedPurged: 0,
    expiredUnsettledLedgerSettled: 0,
  };

  // Reclaim `sending` claims left behind by crashed drainers.
  const reclaimed = await reclaimStaleSendingEvents(database);
  summary.reclaimed = reclaimed.length;
  for (const row of reclaimed) {
    logWarning('Reclaimed stale analytics outbox claim', {
      ...outboxLogFields(row),
      dispatch_source: 'cron',
    });
  }

  // Claim due `pending` rows in bounded batches and send each to PostHog.
  let remaining = limit;
  while (remaining > 0) {
    const claimed = await claimDueOutboxEvents(database, remaining);
    if (claimed.length === 0) {
      break;
    }
    summary.claimed += claimed.length;
    remaining -= claimed.length;

    for (const row of claimed) {
      const outcome = await dispatchOutboxEvent(database, row);
      if (outcome === 'delivered') {
        summary.delivered += 1;
      } else if (outcome === 'retried') {
        summary.retried += 1;
      } else {
        summary.failed += 1;
      }
    }
  }

  // DEC-01 retention purge and the expired-unsettled ledger backstop.
  const purge = await purgeExpired(database);
  summary.outboxDeliveredPurged = purge.outboxDeliveredPurged;
  summary.outboxFailedPurged = purge.outboxFailedPurged;
  summary.expiredUnsettledLedgerSettled = purge.expiredUnsettledLedgerSettled;

  return summary;
}

/**
 * Sends one claimed outbox event and drives its delivery mark. Marks are
 * claim-fenced on `claimed_at`, so a late mark from a reclaimed claim is a
 * no-op that leaves the row to the newer claim.
 */
async function dispatchOutboxEvent(
  database: DatabaseClient,
  row: AnalyticsEventOutboxRow
): Promise<OutboxDispatchOutcome> {
  const claimedAt = row.claimed_at;
  if (!claimedAt) {
    // Unreachable through `claimDueOutboxEvents` (it always stamps the claim);
    // guard so a malformed row cannot be sent without a fence token.
    logError('Analytics outbox row claimed without a claim token', {
      analytics_event_id: row.id,
      analytics_event_name: row.event_name,
      dispatch_source: 'cron',
    });
    return 'failed';
  }

  try {
    sendToPostHog(row);
  } catch (error) {
    const message = errorMessage(error);
    logError('Analytics outbox send failed', {
      ...outboxLogFields(row),
      error: message,
      dispatch_source: 'cron',
    });
    const result = await markOutboxRetry(database, {
      eventId: row.id,
      claimedAt,
      error: message,
    });
    if (!result) {
      // A stale sender: the claim was reclaimed or the row is already terminal.
      return 'retried';
    }
    return result.outcome === 'failed' ? 'failed' : 'retried';
  }

  const delivered = await markOutboxDelivered(database, { eventId: row.id, claimedAt });
  if (!delivered) {
    // The claim was reclaimed and re-claimed mid-flight; the event was sent
    // and the newer claim owns the row now.
    logWarning('Analytics outbox delivery mark skipped: claim already transitioned', {
      ...outboxLogFields(row),
      dispatch_source: 'cron',
    });
    return 'delivered';
  }
  logInfo('Delivered analytics outbox event', {
    ...outboxLogFields(delivered),
    dispatch_source: 'cron',
  });
  return 'delivered';
}

/**
 * Sends one event to PostHog. The deterministic `event_uuid` goes in the
 * PostHog event UUID field; if the installed client ever dropped that field,
 * the catalog fallback carries it as an `event_uuid` property instead.
 */
function sendToPostHog(row: AnalyticsEventOutboxRow): void {
  PostHogClient().capture({
    distinctId: row.distinct_id,
    event: row.event_name,
    properties: row.properties,
    uuid: row.event_uuid,
  });
}

function outboxLogFields(row: AnalyticsEventOutboxRow): Record<string, unknown> {
  return {
    analytics_event_id: row.id,
    analytics_event_uuid: row.event_uuid,
    analytics_event_name: row.event_name,
    distinct_id: row.distinct_id,
    status: row.status,
    attempts: row.attempts,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
