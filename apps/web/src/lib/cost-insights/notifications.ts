import type { CostInsightSpendOwner } from '@kilocode/db/cost-insights-rollups';
import { cost_insight_notification_deliveries } from '@kilocode/db/schema';
import type { CostInsightAlertKind } from '@kilocode/db/schema-types';
import { eq, sql } from 'drizzle-orm';

import { NEXTAUTH_URL } from '@/lib/config.server';
import { sendCostInsightSpendAlertEmail } from '@/lib/email';
import {
  getCostInsightOwnerName,
  hasCurrentCostInsightAccess,
  type CostInsightDatabase,
} from './repository';
import { costInsightOwnerBasePath } from './owner';
import { MICRODOLLARS_PER_USD, microdollarsToUsd } from './policy';

type CostInsightClaimedDeliveryRow = {
  delivery_id: string;
  recipient_user_id: string;
  recipient_email: string;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  title: string;
  description: string;
  alert_kind: CostInsightAlertKind | null;
  snapshot: {
    thresholdMicrodollars?: number | null;
    rolling24HourMicrodollars?: number | null;
    rolling7DayMicrodollars?: number | null;
    rolling30DayMicrodollars?: number | null;
    currentHourVariableMicrodollars?: number | null;
    anomalyThresholdMicrodollars?: number | null;
  };
};

export type CostInsightNotificationDispatchSummary = {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
};

function ownerFromDelivery(row: CostInsightClaimedDeliveryRow): CostInsightSpendOwner {
  if (row.owned_by_user_id) return { type: 'user', id: row.owned_by_user_id };
  if (row.owned_by_organization_id) {
    return { type: 'organization', id: row.owned_by_organization_id };
  }
  throw new Error('Cost Insights notification delivery event has no owner.');
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 100 * MICRODOLLARS_PER_USD ? 0 : 2,
  }).format(microdollarsToUsd(value));
}

function amountLabels(row: CostInsightClaimedDeliveryRow): {
  primaryAmountLabel: string;
  secondaryAmountLabel: string;
} {
  if (
    row.alert_kind === 'threshold' ||
    row.alert_kind === 'threshold_7d' ||
    row.alert_kind === 'threshold_30d'
  ) {
    const windowLabel =
      row.alert_kind === 'threshold_7d'
        ? '7-day'
        : row.alert_kind === 'threshold_30d'
          ? '30-day'
          : '24-hour';
    const rollingMicrodollars =
      row.alert_kind === 'threshold_7d'
        ? row.snapshot.rolling7DayMicrodollars
        : row.alert_kind === 'threshold_30d'
          ? row.snapshot.rolling30DayMicrodollars
          : row.snapshot.rolling24HourMicrodollars;
    return {
      primaryAmountLabel: `Rolling ${windowLabel} spend: ${money(rollingMicrodollars)}`,
      secondaryAmountLabel: `Spend threshold: ${money(row.snapshot.thresholdMicrodollars)}`,
    };
  }
  return {
    primaryAmountLabel: `Current-hour usage-based spend: ${money(
      row.snapshot.currentHourVariableMicrodollars
    )}`,
    secondaryAmountLabel: `Alert level: ${money(row.snapshot.anomalyThresholdMicrodollars)}`,
  };
}

async function claimPendingDeliveries(
  database: CostInsightDatabase,
  limit: number
): Promise<CostInsightClaimedDeliveryRow[]> {
  const result = await database.execute<CostInsightClaimedDeliveryRow>(sql`
    WITH claimed AS (
      SELECT delivery.id
      FROM cost_insight_notification_deliveries delivery
      WHERE delivery.status IN ('pending', 'failed')
        AND delivery.next_attempt_at <= now()
        AND delivery.attempt_count < 5
      ORDER BY delivery.next_attempt_at ASC, delivery.id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ), updated AS (
      UPDATE cost_insight_notification_deliveries delivery
      SET
        status = 'sending',
        claimed_at = now(),
        failed_at = NULL,
        sent_at = NULL,
        last_error_redacted = NULL,
        attempt_count = delivery.attempt_count + 1,
        updated_at = now()
      FROM claimed
      WHERE delivery.id = claimed.id
      RETURNING delivery.id, delivery.recipient_user_id
    )
    SELECT
      updated.id AS delivery_id,
      updated.recipient_user_id,
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
  return result.rows;
}

async function markDeliverySent(database: CostInsightDatabase, deliveryId: string): Promise<void> {
  await database
    .update(cost_insight_notification_deliveries)
    .set({
      status: 'sent',
      sent_at: sql`now()`,
      failed_at: null,
      updated_at: sql`now()`,
    })
    .where(eq(cost_insight_notification_deliveries.id, deliveryId));
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

async function markDeliveryFailed(
  database: CostInsightDatabase,
  deliveryId: string,
  reason: string
): Promise<void> {
  await database
    .update(cost_insight_notification_deliveries)
    .set({
      status: 'failed',
      failed_at: sql`now()`,
      sent_at: null,
      last_error_redacted: reason.slice(0, 500),
      next_attempt_at: sql`now() + INTERVAL '15 minutes'`,
      updated_at: sql`now()`,
    })
    .where(eq(cost_insight_notification_deliveries.id, deliveryId));
}

export async function dispatchPendingCostInsightNotifications(
  database: CostInsightDatabase,
  limit = 25
): Promise<CostInsightNotificationDispatchSummary> {
  const rows = await claimPendingDeliveries(database, limit);
  const summary: CostInsightNotificationDispatchSummary = {
    claimed: rows.length,
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  for (const row of rows) {
    const owner = ownerFromDelivery(row);
    const hasAccess = await hasCurrentCostInsightAccess(database, owner, row.recipient_user_id);
    if (!hasAccess) {
      await markDeliverySkipped(database, row.delivery_id, 'recipient_not_authorized');
      summary.skipped += 1;
      continue;
    }

    try {
      const labels = amountLabels(row);
      const result = await sendCostInsightSpendAlertEmail(row.recipient_email, {
        ownerLabel: await getCostInsightOwnerName(database, owner),
        alertTitle: row.title,
        alertDescription: row.description,
        primaryAmountLabel: labels.primaryAmountLabel,
        secondaryAmountLabel: labels.secondaryAmountLabel,
        reviewUrl: `${NEXTAUTH_URL}${costInsightOwnerBasePath(owner)}`,
      });
      if (!result.sent) {
        await markDeliveryFailed(database, row.delivery_id, result.reason);
        summary.failed += 1;
        continue;
      }
      await markDeliverySent(database, row.delivery_id);
      summary.sent += 1;
    } catch (error) {
      await markDeliveryFailed(
        database,
        row.delivery_id,
        error instanceof Error ? error.message : String(error)
      );
      summary.failed += 1;
    }
  }

  return summary;
}
