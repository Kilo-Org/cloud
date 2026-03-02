import { db } from '@/lib/drizzle';
import { webhook_events } from '@kilocode/db/schema';
import { eq, desc } from 'drizzle-orm';
import type { Owner } from '@/lib/integrations/core/types';

/**
 * Logs a webhook event
 * Returns isDuplicate=true if event signature already exists
 */
export async function logWebhookEvent(data: {
  owner: Owner;
  platform: string;
  event_type: string;
  event_action: string;
  payload: unknown;
  headers: unknown;
  event_signature: string;
}): Promise<{ id?: string; isDuplicate: boolean }> {
  try {
    const [event] = await db
      .insert(webhook_events)
      .values({
        owned_by_organization_id: data.owner.type === 'org' ? data.owner.id : null,
        owned_by_user_id: data.owner.type === 'user' ? data.owner.id : null,
        platform: data.platform,
        event_type: data.event_type,
        event_action: data.event_action,
        payload: data.payload,
        headers: data.headers,
        event_signature: data.event_signature,
      })
      .returning();

    return { id: event.id, isDuplicate: false };
  } catch (error) {
    const err = error as { code?: string; constraint?: string };
    // Unique constraint violation on event_signature = duplicate
    if (err.code === '23505' && err.constraint === 'UQ_webhook_events_signature') {
      console.log('Duplicate webhook event detected:', data.event_signature);
      return { isDuplicate: true };
    }
    throw error;
  }
}

/**
 * Updates webhook event processing status
 */
export async function updateWebhookEvent(
  eventId: string,
  updates: {
    processed: boolean;
    processed_at: string;
    handlers_triggered: string[];
    errors: Array<{ message: string; handler: string; stack?: string }> | null;
  }
) {
  await db
    .update(webhook_events)
    .set({
      processed: updates.processed,
      processed_at: updates.processed_at,
      handlers_triggered: updates.handlers_triggered,
      errors: updates.errors,
    })
    .where(eq(webhook_events.id, eventId));
}

/**
 * Gets recent webhook events for an owner (organization or user)
 */
export async function getRecentWebhookEvents(owner: Owner, limit: number = 100) {
  const ownerCondition =
    owner.type === 'user'
      ? eq(webhook_events.owned_by_user_id, owner.id)
      : eq(webhook_events.owned_by_organization_id, owner.id);

  return await db
    .select()
    .from(webhook_events)
    .where(ownerCondition)
    .orderBy(desc(webhook_events.created_at))
    .limit(limit);
}

/**
 * Gets unprocessed webhook events
 */
export async function getUnprocessedWebhookEvents(limit: number = 100) {
  return await db
    .select()
    .from(webhook_events)
    .where(eq(webhook_events.processed, false))
    .orderBy(webhook_events.created_at)
    .limit(limit);
}
