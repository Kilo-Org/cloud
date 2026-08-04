import { cost_insight_notification_deliveries } from '@kilocode/db/schema';
import type { CostInsightAlertKind } from '@kilocode/db/schema-types';
import { eq, sql } from 'drizzle-orm';

import type { CostInsightDatabase } from './repository';

const COST_INSIGHT_NOTIFICATION_MAX_ATTEMPTS = 5;
const COST_INSIGHT_NOTIFICATION_LEASE_MINUTES = 15;

export type CostInsightClaimedDeliveryRow = {
  delivery_id: string;
  recipient_user_id: string;
  recipient_email: string;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  title: string;
  description: string;
  alert_kind: CostInsightAlertKind | null;
  attempt_count: number;
  snapshot: unknown;
};

export type CostInsightNotificationDispatchSummary = {
  claimed: number;
  sent: number;
  skipped: number;
  terminalized: number;
  failed: number;
};

async function terminalizeExhaustedDeliveryClaims(database: CostInsightDatabase): Promise<number> {
  const result = await database.execute<{ id: string }>(sql`
    UPDATE cost_insight_notification_deliveries delivery
    SET
      status = 'skipped',
      claimed_at = NULL,
      failed_at = NULL,
      sent_at = NULL,
      last_error_redacted = 'stale_claim_attempts_exhausted',
      updated_at = CURRENT_TIMESTAMP
    WHERE delivery.status = 'sending'
      AND delivery.attempt_count >= ${COST_INSIGHT_NOTIFICATION_MAX_ATTEMPTS}
      AND delivery.claimed_at <= CURRENT_TIMESTAMP - make_interval(
        mins => ${COST_INSIGHT_NOTIFICATION_LEASE_MINUTES}
      )
    RETURNING delivery.id
  `);
  return result.rows.length;
}

export async function claimPendingCostInsightNotificationDeliveries(
  database: CostInsightDatabase,
  limit: number
): Promise<{ rows: CostInsightClaimedDeliveryRow[]; terminalized: number }> {
  const terminalized = await terminalizeExhaustedDeliveryClaims(database);
  const result = await database.execute<CostInsightClaimedDeliveryRow>(sql`
    WITH claimed AS (
      SELECT delivery.id
      FROM cost_insight_notification_deliveries delivery
      WHERE delivery.attempt_count < ${COST_INSIGHT_NOTIFICATION_MAX_ATTEMPTS}
        AND (
          (
            delivery.status IN ('pending', 'failed')
            AND delivery.next_attempt_at <= CURRENT_TIMESTAMP
          )
          OR (
            delivery.status = 'sending'
            AND delivery.claimed_at <= CURRENT_TIMESTAMP - make_interval(
              mins => ${COST_INSIGHT_NOTIFICATION_LEASE_MINUTES}
            )
          )
        )
      ORDER BY delivery.next_attempt_at ASC, delivery.id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ), updated AS (
      UPDATE cost_insight_notification_deliveries delivery
      SET
        status = 'sending',
        claimed_at = CURRENT_TIMESTAMP,
        failed_at = NULL,
        sent_at = NULL,
        last_error_redacted = NULL,
        attempt_count = delivery.attempt_count + 1,
        updated_at = CURRENT_TIMESTAMP
      FROM claimed
      WHERE delivery.id = claimed.id
      RETURNING delivery.id, delivery.recipient_user_id, delivery.attempt_count
    )
    SELECT
      updated.id AS delivery_id,
      updated.recipient_user_id,
      updated.attempt_count,
      recipient.google_user_email AS recipient_email,
      event.owned_by_user_id,
      event.owned_by_organization_id,
      event.title,
      event.description,
      event.alert_kind,
      event.snapshot
    FROM updated
    INNER JOIN cost_insight_events event ON event.id = (
      SELECT delivery.event_id
      FROM cost_insight_notification_deliveries delivery
      WHERE delivery.id = updated.id
    )
    INNER JOIN kilocode_users recipient ON recipient.id = updated.recipient_user_id
    ORDER BY updated.id ASC
  `);
  return { rows: result.rows, terminalized };
}

async function markDeliverySkipped(
  database: CostInsightDatabase,
  deliveryId: string,
  reason: string
): Promise<void> {
  await database
    .update(cost_insight_notification_deliveries)
    .set({
      status: 'skipped',
      last_error_redacted: reason,
      failed_at: null,
      sent_at: null,
      updated_at: sql`now()`,
    })
    .where(eq(cost_insight_notification_deliveries.id, deliveryId));
}

export async function dispatchPendingCostInsightNotifications(
  database: CostInsightDatabase,
  limit = 25
): Promise<CostInsightNotificationDispatchSummary> {
  const claim = await claimPendingCostInsightNotificationDeliveries(database, limit);
  const rows = claim.rows;
  const summary: CostInsightNotificationDispatchSummary = {
    claimed: rows.length,
    sent: 0,
    skipped: 0,
    terminalized: claim.terminalized,
    failed: 0,
  };

  // Cost Insights is discontinued, so nothing is delivered. Claimed rows are
  // drained to 'skipped' instead of being retried until attempts run out.
  for (const row of rows) {
    await markDeliverySkipped(database, row.delivery_id, 'feature_discontinued');
    summary.skipped += 1;
  }

  return summary;
}
