import 'server-only';

import {
  webhook_event_signatures,
  webhook_events,
  webhook_events_v2,
  type WebhookEventV2,
} from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  claimWebhookEventSignature,
  legacyWebhookEventIdForSignature,
  newWebhookEventRef,
} from '@/lib/integrations/db/webhook-events';
import { withWebhookEventPartitions } from '@/lib/integrations/db/webhook-event-partitions';

const BitbucketWebhookIdentitySchema = z
  .object({
    integrationId: z.string().uuid(),
    workspaceUuid: z.string().uuid(),
    repositoryUuid: z.string().uuid(),
    pullRequestNumber: z.number().int().positive(),
  })
  .passthrough();

export type BitbucketWebhookIdentity = {
  integrationId: string;
  workspaceUuid: string;
  repositoryUuid: string;
  pullRequestNumber: number;
};

export type BitbucketAuthoritativeObservation = BitbucketWebhookIdentity & {
  eventKey: string;
  updatedOn: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  draft: boolean;
  headSha: string;
};

type InsertBitbucketWebhookEventInput = {
  organizationId: string;
  eventAction: string;
  eventSignature: string;
  identity: BitbucketWebhookIdentity;
};

/**
 * A Bitbucket delivery's stored event. Rows read from the pre-partitioning
 * `webhook_events` table have the same shape.
 */
export type BitbucketWebhookEvent = WebhookEventV2;

/** Identifies the stored event; created_at selects its partition. */
export type BitbucketWebhookEventKey = Pick<BitbucketWebhookEvent, 'id' | 'created_at'>;

function eventMatchesInput(
  event: BitbucketWebhookEvent,
  input: InsertBitbucketWebhookEventInput
): boolean {
  const identity = BitbucketWebhookIdentitySchema.safeParse(event.payload);
  return (
    identity.success &&
    event.owned_by_organization_id === input.organizationId &&
    event.owned_by_user_id === null &&
    event.platform === 'bitbucket' &&
    event.event_type === 'pullrequest' &&
    event.event_action === input.eventAction &&
    identity.data.integrationId === input.identity.integrationId &&
    identity.data.workspaceUuid === input.identity.workspaceUuid &&
    identity.data.repositoryUuid === input.identity.repositoryUuid &&
    identity.data.pullRequestNumber === input.identity.pullRequestNumber
  );
}

function v2EventCondition(event: BitbucketWebhookEventKey) {
  return and(
    eq(webhook_events_v2.id, event.id),
    eq(webhook_events_v2.created_at, event.created_at),
    eq(webhook_events_v2.platform, 'bitbucket')
  );
}

// Until the pre-partitioning table ages out, an event accepted before the
// switch is only stored there. Its id is unique in that table, so created_at
// is not needed to find it. Remove these fallbacks once that table is dropped.
function legacyEventCondition(event: BitbucketWebhookEventKey) {
  return and(eq(webhook_events.id, event.id), eq(webhook_events.platform, 'bitbucket'));
}

async function loadEvent(
  executor: DrizzleTransaction,
  event: BitbucketWebhookEventKey
): Promise<BitbucketWebhookEvent | null> {
  const [current] = await executor
    .select()
    .from(webhook_events_v2)
    .where(v2EventCondition(event))
    .limit(1);
  if (current) return current;
  const [legacy] = await executor
    .select()
    .from(webhook_events)
    .where(legacyEventCondition(event))
    .limit(1);
  return legacy ?? null;
}

/**
 * Stores a new delivery, or loads the event an earlier delivery of the same
 * signature stored. Throws when the stored event describes a different pull
 * request, or when its signature is held but the event is gone.
 */
export async function insertOrLoadBitbucketWebhookEvent(
  input: InsertBitbucketWebhookEventInput
): Promise<BitbucketWebhookEvent> {
  const ref = newWebhookEventRef();

  const event = await withWebhookEventPartitions(db, () =>
    db.transaction(async tx => {
      const legacyId = await legacyWebhookEventIdForSignature(tx, input.eventSignature);
      if (legacyId) {
        const [legacy] = await tx
          .select()
          .from(webhook_events)
          .where(eq(webhook_events.id, legacyId))
          .limit(1);
        return legacy ?? null;
      }

      if (await claimWebhookEventSignature(tx, input.eventSignature, ref)) {
        const [inserted] = await tx
          .insert(webhook_events_v2)
          .values({
            id: ref.id,
            created_at: ref.createdAt,
            owned_by_organization_id: input.organizationId,
            owned_by_user_id: null,
            platform: 'bitbucket',
            event_type: 'pullrequest',
            event_action: input.eventAction,
            payload: input.identity,
            headers: {},
            event_signature: input.eventSignature,
          })
          .returning();
        return inserted ?? null;
      }

      const [claim] = await tx
        .select({
          id: webhook_event_signatures.webhook_event_id,
          created_at: webhook_event_signatures.webhook_event_created_at,
        })
        .from(webhook_event_signatures)
        .where(eq(webhook_event_signatures.event_signature, input.eventSignature))
        .limit(1);
      return claim ? await loadEvent(tx, claim) : null;
    })
  );

  if (!event || !eventMatchesInput(event, input)) {
    throw new Error('Bitbucket webhook delivery identity conflict');
  }
  return event;
}

export async function recordBitbucketWebhookFailure(
  event: BitbucketWebhookEventKey,
  safeCode: string
): Promise<void> {
  const errors = [{ handler: 'code_review', message: safeCode.slice(0, 64) }];
  const updated = await db
    .update(webhook_events_v2)
    .set({ errors })
    .where(and(v2EventCondition(event), eq(webhook_events_v2.processed, false)))
    .returning({ id: webhook_events_v2.id });
  if (updated.length > 0) return;
  await db
    .update(webhook_events)
    .set({ errors })
    .where(and(legacyEventCondition(event), eq(webhook_events.processed, false)));
}

export async function loadBitbucketWebhookEventInTransaction(
  tx: DrizzleTransaction,
  event: BitbucketWebhookEventKey
): Promise<BitbucketWebhookEvent | null> {
  return loadEvent(tx, event);
}

export async function getGreatestProcessedBitbucketObservation(
  tx: DrizzleTransaction,
  organizationId: string,
  identity: BitbucketWebhookIdentity
): Promise<string | null> {
  const matches = (table: typeof webhook_events | typeof webhook_events_v2) => sql`
    ${table.owned_by_organization_id} = ${organizationId}
      AND ${table.platform} = 'bitbucket'
      AND ${table.processed} = true
      AND ${table.payload}->>'integrationId' = ${identity.integrationId}
      AND ${table.payload}->>'workspaceUuid' = ${identity.workspaceUuid}
      AND ${table.payload}->>'repositoryUuid' = ${identity.repositoryUuid}
      AND ${table.payload}->>'pullRequestNumber' = ${String(identity.pullRequestNumber)}
  `;
  // GREATEST ignores NULLs, so either table may have no match.
  const result = await tx.execute<{ updated_on: string | null }>(sql`
    SELECT GREATEST(
      (SELECT MAX(${webhook_events_v2.payload}->>'updatedOn') FROM ${webhook_events_v2}
        WHERE ${matches(webhook_events_v2)}),
      (SELECT MAX(${webhook_events.payload}->>'updatedOn') FROM ${webhook_events}
        WHERE ${matches(webhook_events)})
    ) AS updated_on
  `);
  return result.rows[0]?.updated_on ?? null;
}

export async function completeBitbucketWebhookEventInTransaction(
  tx: DrizzleTransaction,
  event: BitbucketWebhookEventKey,
  observation: BitbucketAuthoritativeObservation
): Promise<void> {
  const completion = {
    payload: observation,
    processed: true,
    processed_at: new Date().toISOString(),
    handlers_triggered: ['code_review'],
    errors: null,
  };
  const [completed] = await tx
    .update(webhook_events_v2)
    .set(completion)
    .where(and(v2EventCondition(event), eq(webhook_events_v2.processed, false)))
    .returning({ id: webhook_events_v2.id });
  if (completed) return;
  const [legacyCompleted] = await tx
    .update(webhook_events)
    .set(completion)
    .where(and(legacyEventCondition(event), eq(webhook_events.processed, false)))
    .returning({ id: webhook_events.id });
  if (!legacyCompleted) throw new Error('Bitbucket webhook event could not be completed');
}
