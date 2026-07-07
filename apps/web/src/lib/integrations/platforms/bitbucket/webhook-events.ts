import 'server-only';

import { webhook_events, type WebhookEvent } from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type DrizzleTransaction } from '@/lib/drizzle';

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

function eventMatchesInput(event: WebhookEvent, input: InsertBitbucketWebhookEventInput): boolean {
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

export async function insertOrLoadBitbucketWebhookEvent(
  input: InsertBitbucketWebhookEventInput
): Promise<WebhookEvent> {
  const [inserted] = await db
    .insert(webhook_events)
    .values({
      owned_by_organization_id: input.organizationId,
      owned_by_user_id: null,
      platform: 'bitbucket',
      event_type: 'pullrequest',
      event_action: input.eventAction,
      payload: input.identity,
      headers: {},
      event_signature: input.eventSignature,
    })
    .onConflictDoNothing({ target: webhook_events.event_signature })
    .returning();

  const event =
    inserted ??
    (
      await db
        .select()
        .from(webhook_events)
        .where(eq(webhook_events.event_signature, input.eventSignature))
        .limit(1)
    )[0];
  if (!event || !eventMatchesInput(event, input)) {
    throw new Error('Bitbucket webhook delivery identity conflict');
  }
  return event;
}

export async function recordBitbucketWebhookFailure(
  eventId: string,
  safeCode: string
): Promise<void> {
  await db
    .update(webhook_events)
    .set({
      errors: [{ handler: 'code_review', message: safeCode.slice(0, 64) }],
    })
    .where(and(eq(webhook_events.id, eventId), eq(webhook_events.processed, false)));
}

export async function loadBitbucketWebhookEventInTransaction(
  tx: DrizzleTransaction,
  eventId: string
): Promise<WebhookEvent | null> {
  const [event] = await tx
    .select()
    .from(webhook_events)
    .where(and(eq(webhook_events.id, eventId), eq(webhook_events.platform, 'bitbucket')))
    .limit(1);
  return event ?? null;
}

export async function getGreatestProcessedBitbucketObservation(
  tx: DrizzleTransaction,
  organizationId: string,
  identity: BitbucketWebhookIdentity
): Promise<string | null> {
  const result = await tx.execute<{ updated_on: string | null }>(sql`
    SELECT MAX(${webhook_events.payload}->>'updatedOn') AS updated_on
    FROM ${webhook_events}
    WHERE ${webhook_events.owned_by_organization_id} = ${organizationId}
      AND ${webhook_events.platform} = 'bitbucket'
      AND ${webhook_events.processed} = true
      AND ${webhook_events.payload}->>'integrationId' = ${identity.integrationId}
      AND ${webhook_events.payload}->>'workspaceUuid' = ${identity.workspaceUuid}
      AND ${webhook_events.payload}->>'repositoryUuid' = ${identity.repositoryUuid}
      AND ${webhook_events.payload}->>'pullRequestNumber' = ${String(identity.pullRequestNumber)}
  `);
  return result.rows[0]?.updated_on ?? null;
}

export async function completeBitbucketWebhookEventInTransaction(
  tx: DrizzleTransaction,
  eventId: string,
  observation: BitbucketAuthoritativeObservation
): Promise<void> {
  const [completed] = await tx
    .update(webhook_events)
    .set({
      payload: observation,
      processed: true,
      processed_at: new Date().toISOString(),
      handlers_triggered: ['code_review'],
      errors: null,
    })
    .where(and(eq(webhook_events.id, eventId), eq(webhook_events.processed, false)))
    .returning({ id: webhook_events.id });
  if (!completed) throw new Error('Bitbucket webhook event could not be completed');
}
