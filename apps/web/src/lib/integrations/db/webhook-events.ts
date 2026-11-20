import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { webhook_event_signatures, webhook_events, webhook_events_v2 } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { captureMessage } from '@sentry/nextjs';
import type { Owner } from '@/lib/integrations/core/types';
import { withWebhookEventPartitions } from '@/lib/integrations/db/webhook-event-partitions';

/**
 * Identifies a row of the partitioned `webhook_events_v2`. `createdAt` lets
 * updates touch one partition instead of probing all of them, so it must be
 * passed back exactly as it was written or read.
 */
export type WebhookEventRef = { id: string; createdAt: string };

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
 * Whether the pre-partitioning `webhook_events` table already holds this
 * delivery. Until its rows age out, a redelivery of an event accepted before
 * the switch is only recorded there. Remove once that table is dropped.
 */
export async function legacyWebhookEventIdForSignature(
  tx: DrizzleTransaction,
  eventSignature: string
): Promise<string | null> {
  const [row] = await tx
    .select({ id: webhook_events.id })
    .from(webhook_events)
    .where(eq(webhook_events.event_signature, eventSignature))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Claims a delivery signature for `event`. Returns false when another delivery
 * already holds it. A concurrent claim of the same signature waits for this
 * transaction, so if the event insert that follows fails and the transaction
 * rolls back, the delivery can be claimed again on retry.
 */
export async function claimWebhookEventSignature(
  tx: DrizzleTransaction,
  eventSignature: string,
  event: WebhookEventRef
): Promise<boolean> {
  const claimed = await tx
    .insert(webhook_event_signatures)
    .values({
      event_signature: eventSignature,
      webhook_event_id: event.id,
      webhook_event_created_at: event.createdAt,
    })
    .onConflictDoNothing({ target: webhook_event_signatures.event_signature })
    .returning({ eventSignature: webhook_event_signatures.event_signature });
  return claimed.length > 0;
}

/** A new event identity, generated in the app so the insert need not return it. */
export function newWebhookEventRef(): WebhookEventRef {
  return { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
}

/**
 * Logs a webhook event
 * Returns isDuplicate=true if the delivery signature was already accepted
 */
export async function logWebhookEvent(data: {
  owner: Owner;
  platform: string;
  event_type: string;
  event_action: string;
  payload: unknown;
  headers: unknown;
  event_signature: string;
}): Promise<{ event?: WebhookEventRef; isDuplicate: boolean }> {
  const event = newWebhookEventRef();

  return withWebhookEventPartitions(db, () =>
    db.transaction(async tx => {
      if (await legacyWebhookEventIdForSignature(tx, data.event_signature)) {
        console.log('Duplicate webhook event detected:', data.event_signature);
        return { isDuplicate: true };
      }
      if (!(await claimWebhookEventSignature(tx, data.event_signature, event))) {
        console.log('Duplicate webhook event detected:', data.event_signature);
        return { isDuplicate: true };
      }

      await tx.insert(webhook_events_v2).values({
        id: event.id,
        created_at: event.createdAt,
        owned_by_organization_id: data.owner.type === 'org' ? data.owner.id : null,
        owned_by_user_id: data.owner.type === 'user' ? data.owner.id : null,
        platform: data.platform,
        event_type: data.event_type,
        event_action: data.event_action,
        payload: stripNulBytes(data.payload),
        headers: stripNulBytes(data.headers),
        event_signature: data.event_signature,
      });

      return { event, isDuplicate: false };
    })
  );
}

/**
 * Updates webhook event processing status
 */
export async function updateWebhookEvent(
  event: WebhookEventRef,
  updates: {
    processed: boolean;
    processed_at: string;
    handlers_triggered: string[];
    errors: Array<{ message: string; handler: string; stack?: string }> | null;
  }
) {
  const updated = await db
    .update(webhook_events_v2)
    .set({
      processed: updates.processed,
      processed_at: updates.processed_at,
      handlers_triggered: updates.handlers_triggered,
      errors: updates.errors,
    })
    .where(
      and(eq(webhook_events_v2.id, event.id), eq(webhook_events_v2.created_at, event.createdAt))
    )
    .returning({ id: webhook_events_v2.id });

  // Callers only log a thrown error, so report a missed update here: it leaves
  // the event looking unprocessed, usually because createdAt was altered.
  if (updated.length === 0) {
    captureMessage('webhook event update matched no row', {
      level: 'error',
      tags: { source: 'updateWebhookEvent' },
      extra: { eventId: event.id, createdAt: event.createdAt },
    });
  }
}
