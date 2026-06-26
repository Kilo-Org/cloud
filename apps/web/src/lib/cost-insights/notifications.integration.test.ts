import { afterEach, describe, expect, test } from '@jest/globals';
import {
  cost_insight_events,
  cost_insight_notification_deliveries,
  kilocode_users,
} from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import {
  claimPendingCostInsightNotificationDeliveries,
  dispatchPendingCostInsightNotifications,
} from './notifications';

const testUserIds = new Set<string>();

async function createDelivery(): Promise<{ deliveryId: string; eventId: string; userId: string }> {
  const userId = `cost-insights-notification-${crypto.randomUUID()}`;
  testUserIds.add(userId);
  await db.insert(kilocode_users).values({
    id: userId,
    google_user_email: `${userId}@example.com`,
    google_user_name: 'Cost Insights Notification Test',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `cus_${crypto.randomUUID()}`,
  });
  const [event] = await db
    .insert(cost_insight_events)
    .values({
      owned_by_user_id: userId,
      event_type: 'anomaly_alert',
      alert_kind: 'anomaly',
      title: 'Spend Anomaly Alert',
      description: 'Test alert',
      snapshot: {},
    })
    .returning({ id: cost_insight_events.id });
  if (!event) throw new Error('Test event insert returned no row.');
  const [delivery] = await db
    .insert(cost_insight_notification_deliveries)
    .values({ event_id: event.id, recipient_user_id: userId })
    .returning({ id: cost_insight_notification_deliveries.id });
  if (!delivery) throw new Error('Test delivery insert returned no row.');
  return { deliveryId: delivery.id, eventId: event.id, userId };
}

afterEach(async () => {
  for (const userId of testUserIds) {
    await db.delete(cost_insight_events).where(eq(cost_insight_events.owned_by_user_id, userId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  }
  testUserIds.clear();
});

describe('Cost Insights notification claims', () => {
  test('reclaims a stale sending row after interruption', async () => {
    const { deliveryId } = await createDelivery();

    const firstClaim = await claimPendingCostInsightNotificationDeliveries(db, 1);
    expect(firstClaim.rows).toHaveLength(1);
    expect(firstClaim.rows[0]?.attempt_count).toBe(1);

    await db
      .update(cost_insight_notification_deliveries)
      .set({ claimed_at: '2026-01-01T00:00:00.000Z' })
      .where(eq(cost_insight_notification_deliveries.id, deliveryId));

    const reclaimed = await claimPendingCostInsightNotificationDeliveries(db, 1);
    expect(reclaimed.terminalized).toBe(0);
    expect(reclaimed.rows).toHaveLength(1);
    expect(reclaimed.rows[0]).toMatchObject({ delivery_id: deliveryId, attempt_count: 2 });
  });

  test('terminalizes a stale sending row after attempt exhaustion', async () => {
    const { deliveryId } = await createDelivery();
    await db
      .update(cost_insight_notification_deliveries)
      .set({
        status: 'sending',
        attempt_count: 5,
        claimed_at: '2026-01-01T00:00:00.000Z',
      })
      .where(eq(cost_insight_notification_deliveries.id, deliveryId));

    const claim = await claimPendingCostInsightNotificationDeliveries(db, 1);
    const [delivery] = await db
      .select()
      .from(cost_insight_notification_deliveries)
      .where(eq(cost_insight_notification_deliveries.id, deliveryId));

    expect(claim).toMatchObject({ rows: [], terminalized: 1 });
    expect(delivery).toMatchObject({
      status: 'skipped',
      attempt_count: 5,
      claimed_at: null,
      last_error_redacted: 'stale_claim_attempts_exhausted',
    });
  });

  test('skips malformed event snapshots without retrying delivery', async () => {
    const { deliveryId, eventId } = await createDelivery();
    await db.execute(sql`
      UPDATE ${cost_insight_events}
      SET snapshot = '"malformed"'::jsonb
      WHERE id = ${eventId}
    `);

    await expect(dispatchPendingCostInsightNotifications(db, 1)).resolves.toMatchObject({
      claimed: 1,
      sent: 0,
      skipped: 1,
      failed: 0,
    });
    const [delivery] = await db
      .select()
      .from(cost_insight_notification_deliveries)
      .where(eq(cost_insight_notification_deliveries.id, deliveryId));

    expect(delivery).toMatchObject({
      status: 'skipped',
      last_error_redacted: 'invalid_event_snapshot',
    });
  });
});
