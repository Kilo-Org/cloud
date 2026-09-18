import { db } from '@/lib/drizzle';
import { webhook_events } from '@kilocode/db/schema';
import { eq, desc } from 'drizzle-orm';
import type { Owner } from '@/lib/integrations/core/types';

/**
 * Unicode NUL (\u0000) is not representable in PostgreSQL text, so a payload or
 * header value that contains one makes the jsonb insert fail with 22P05. Webhook
 * bodies are external JSON, so strip NULs recursively before insert rather than
 * rejecting the whole event. NULs are replaced with the empty string so the rest
 * of the field is preserved.
 */
function stripNulBytes(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map(stripNulBytes);
  if (value !== null && typeof value === 'object') {
    // Object.fromEntries defines own properties, so a '__proto__' key survives
    // instead of being routed through the inherited setter and dropped.
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replaceAll('\u0000', ''),
        stripNulBytes(entry),
      ])
    );
  }
  return value;
}

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
        payload: stripNulBytes(data.payload),
        headers: stripNulBytes(data.headers),
        event_signature: data.event_signature,
      })
      .returning();

    return { id: event.id, isDuplicate: false };
  } catch (error) {
    // Drizzle wraps Postgres errors — the code/constraint may be on error itself or on error.cause
    const err = error as {
      code?: string;
      constraint?: string;
      cause?: { code?: string; constraint?: string };
    };
    const pgCode = err.code ?? err.cause?.code;
    const pgConstraint = err.constraint ?? err.cause?.constraint;
    // Unique constraint violation on event_signature = duplicate
    if (pgCode === '23505' && pgConstraint === 'UQ_webhook_events_signature') {
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
