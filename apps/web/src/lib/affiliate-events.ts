import 'server-only';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  IMPACT_ACTION_TRACKER_IDS,
  IMPACT_ORDER_ID_MACRO,
  type ImpactDispatchResult,
  buildSalePayload,
  buildSignUpPayload,
  buildTrialEndPayload,
  buildTrialStartPayload,
  hashEmailForImpact,
  sendImpactConversionPayload,
} from '@/lib/impact';
import { sentryLogger } from '@/lib/utils.server';
import {
  kilocode_users,
  type AffiliateEventPayloadJson,
  type UserAffiliateEvent,
  user_affiliate_attributions,
  user_affiliate_events,
} from '@kilocode/db/schema';
import type {
  AffiliateEventDeliveryState,
  AffiliateEventType,
  AffiliateProvider,
} from '@kilocode/db/schema-types';
import { and, eq, sql } from 'drizzle-orm';

const logInfo = sentryLogger('affiliate-events', 'info');
const logWarning = sentryLogger('affiliate-events', 'warning');
const logError = sentryLogger('affiliate-events', 'error');

const DEFAULT_CLAIM_LIMIT = 100;
const STALE_CLAIM_WINDOW_MS = 15 * 60 * 1000;
const MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;
const INITIAL_RETRY_BACKOFF_MS = 60 * 1000;

type DatabaseClient = typeof db | DrizzleTransaction;

type AffiliateEventDispatchSummary = {
  reclaimed: number;
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
  unblocked: number;
};

type AffiliateEventLogFields = {
  affiliate_event_id: string;
  affiliate_parent_event_id: string | null;
  affiliate_provider: AffiliateProvider;
  affiliate_event_type: AffiliateEventType;
  affiliate_dedupe_key: string;
  user_id: string;
  delivery_state: AffiliateEventDeliveryState;
  attempt_count: number;
  dispatch_source?: 'cron';
  action_tracker_id?: number;
  order_id?: string;
  tracking_id_present?: boolean;
  failure_kind?: 'http_4xx' | 'http_5xx' | 'network';
  status_code?: number;
};

type AffiliateEventRow = Pick<
  UserAffiliateEvent,
  | 'id'
  | 'user_id'
  | 'provider'
  | 'event_type'
  | 'dedupe_key'
  | 'parent_event_id'
  | 'delivery_state'
  | 'payload_json'
  | 'attempt_count'
  | 'next_retry_at'
  | 'claimed_at'
  | 'created_at'
>;

type RecordAffiliateAttributionAndQueueParentParams = {
  database?: DatabaseClient;
  userId: string;
  provider: AffiliateProvider;
  trackingId: string;
  customerEmail: string;
  eventDate: Date;
};

type FindOrCreateParentEventParams = {
  database?: DatabaseClient;
  userId: string;
  provider: AffiliateProvider;
  trackingId: string;
  customerEmailHash: string;
  eventDate: Date;
};

type EnqueueAffiliateEventForUserParams = {
  database?: DatabaseClient;
  userId: string;
  provider: AffiliateProvider;
  eventType: Exclude<AffiliateEventType, 'signup'>;
  dedupeKey: string;
  eventDate: Date;
  orderId: string;
  amount?: number;
  currencyCode?: string;
  itemCategory?: string;
  itemName?: string;
  itemSku?: string;
  promoCode?: string;
};

function getDatabaseClient(database?: DatabaseClient): DatabaseClient {
  return database ?? db;
}

function getParentEventType(provider: AffiliateProvider): AffiliateEventType {
  switch (provider) {
    case 'impact':
      return 'signup';
  }
}

function getActionTrackerId(
  provider: AffiliateProvider,
  eventType: AffiliateEventType
): number | undefined {
  if (provider !== 'impact') return undefined;

  switch (eventType) {
    case 'signup':
      return IMPACT_ACTION_TRACKER_IDS.signUp;
    case 'trial_start':
      return IMPACT_ACTION_TRACKER_IDS.trialStart;
    case 'trial_end':
      return IMPACT_ACTION_TRACKER_IDS.trialEnd;
    case 'sale':
      return IMPACT_ACTION_TRACKER_IDS.sale;
  }
}

function buildAffiliateEventLogFields(event: AffiliateEventRow): AffiliateEventLogFields {
  const trackingId = event.payload_json.trackingId?.trim();

  return {
    affiliate_event_id: event.id,
    affiliate_parent_event_id: event.parent_event_id,
    affiliate_provider: event.provider,
    affiliate_event_type: event.event_type,
    affiliate_dedupe_key: event.dedupe_key,
    user_id: event.user_id,
    delivery_state: event.delivery_state,
    attempt_count: event.attempt_count,
    action_tracker_id: getActionTrackerId(event.provider, event.event_type),
    order_id: event.payload_json.orderId,
    tracking_id_present: Boolean(trackingId),
  };
}

function buildAffiliateEventPayload(params: {
  trackingId: string;
  customerId: string;
  customerEmailHash: string;
  eventDate: Date;
  orderId: string;
  amount?: number;
  currencyCode?: string;
  itemCategory?: string;
  itemName?: string;
  itemSku?: string;
  promoCode?: string;
}): AffiliateEventPayloadJson {
  return {
    trackingId: params.trackingId,
    customerId: params.customerId,
    customerEmailHash: params.customerEmailHash,
    orderId: params.orderId,
    eventDate: params.eventDate.toISOString(),
    amount: params.amount ?? null,
    currencyCode: params.currencyCode ?? null,
    itemCategory: params.itemCategory ?? null,
    itemName: params.itemName ?? null,
    itemSku: params.itemSku ?? null,
    promoCode: params.promoCode ?? null,
  };
}

function buildParentEventDedupeKey(userId: string, provider: AffiliateProvider): string {
  return `affiliate:${provider}:${getParentEventType(provider)}:${userId}`;
}

export function buildAffiliateEventDedupeKey(params: {
  provider: AffiliateProvider;
  eventType: Exclude<AffiliateEventType, 'signup'>;
  entityId: string;
}): string {
  return `affiliate:${params.provider}:${params.eventType}:${params.entityId}`;
}

function computeNextRetryAt(attemptCount: number): string {
  const nextBackoffMs = Math.min(
    INITIAL_RETRY_BACKOFF_MS * 2 ** attemptCount,
    MAX_RETRY_BACKOFF_MS
  );
  return new Date(Date.now() + nextBackoffMs).toISOString();
}

async function getEventByDedupeKey(
  database: DatabaseClient,
  dedupeKey: string
): Promise<AffiliateEventRow> {
  const event = await database.query.user_affiliate_events.findFirst({
    where: eq(user_affiliate_events.dedupe_key, dedupeKey),
  });

  if (!event) {
    throw new Error(`Affiliate event missing after upsert: ${dedupeKey}`);
  }

  return event;
}

async function markAffiliateEventDelivered(
  database: DatabaseClient,
  eventId: string
): Promise<void> {
  await database
    .update(user_affiliate_events)
    .set({
      delivery_state: 'delivered',
      next_retry_at: null,
    })
    .where(eq(user_affiliate_events.id, eventId));
}

async function requeueAffiliateEvent(
  database: DatabaseClient,
  eventId: string,
  nextRetryAt: string
): Promise<number> {
  const [updated] = await database
    .update(user_affiliate_events)
    .set({
      delivery_state: 'queued',
      attempt_count: sql`${user_affiliate_events.attempt_count} + 1`,
      next_retry_at: nextRetryAt,
      claimed_at: null,
    })
    .where(eq(user_affiliate_events.id, eventId))
    .returning({ attempt_count: user_affiliate_events.attempt_count });

  return updated?.attempt_count ?? 0;
}

async function failAffiliateEvent(database: DatabaseClient, eventId: string): Promise<number> {
  const [updated] = await database
    .update(user_affiliate_events)
    .set({
      delivery_state: 'failed',
      attempt_count: sql`${user_affiliate_events.attempt_count} + 1`,
      claimed_at: null,
    })
    .where(eq(user_affiliate_events.id, eventId))
    .returning({ attempt_count: user_affiliate_events.attempt_count });

  return updated?.attempt_count ?? 0;
}

async function promoteBlockedChildren(
  database: DatabaseClient,
  parentEventId: string
): Promise<AffiliateEventRow[]> {
  const result = await database.execute<AffiliateEventRow>(sql`
    UPDATE ${user_affiliate_events}
    SET
      ${sql.identifier(user_affiliate_events.delivery_state.name)} = 'queued',
      ${sql.identifier(user_affiliate_events.next_retry_at.name)} = NULL,
      ${sql.identifier(user_affiliate_events.claimed_at.name)} = NULL
    WHERE ${user_affiliate_events.parent_event_id} = ${parentEventId}::uuid
      AND ${user_affiliate_events.delivery_state} = 'blocked'
    RETURNING
      ${user_affiliate_events.id},
      ${user_affiliate_events.user_id},
      ${user_affiliate_events.provider},
      ${user_affiliate_events.event_type},
      ${user_affiliate_events.dedupe_key},
      ${user_affiliate_events.parent_event_id},
      ${user_affiliate_events.delivery_state},
      ${user_affiliate_events.payload_json},
      ${user_affiliate_events.attempt_count},
      ${user_affiliate_events.next_retry_at},
      ${user_affiliate_events.claimed_at},
      ${user_affiliate_events.created_at}
  `);

  return result.rows;
}

async function reclaimStaleSendingEvents(database: DatabaseClient): Promise<AffiliateEventRow[]> {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_WINDOW_MS).toISOString();
  const result = await database.execute<AffiliateEventRow>(sql`
    UPDATE ${user_affiliate_events}
    SET
      ${sql.identifier(user_affiliate_events.delivery_state.name)} = 'queued',
      ${sql.identifier(user_affiliate_events.claimed_at.name)} = NULL
    WHERE ${user_affiliate_events.delivery_state} = 'sending'
      AND ${user_affiliate_events.claimed_at} <= ${staleBefore}::timestamptz
    RETURNING
      ${user_affiliate_events.id},
      ${user_affiliate_events.user_id},
      ${user_affiliate_events.provider},
      ${user_affiliate_events.event_type},
      ${user_affiliate_events.dedupe_key},
      ${user_affiliate_events.parent_event_id},
      ${user_affiliate_events.delivery_state},
      ${user_affiliate_events.payload_json},
      ${user_affiliate_events.attempt_count},
      ${user_affiliate_events.next_retry_at},
      ${user_affiliate_events.claimed_at},
      ${user_affiliate_events.created_at}
  `);

  return result.rows;
}

async function claimQueuedEvents(
  database: DatabaseClient,
  limit: number
): Promise<AffiliateEventRow[]> {
  const result = await database.execute<AffiliateEventRow>(sql`
    UPDATE ${user_affiliate_events}
    SET
      ${sql.identifier(user_affiliate_events.delivery_state.name)} = 'sending',
      ${sql.identifier(user_affiliate_events.claimed_at.name)} = now()
    WHERE ${user_affiliate_events.id} IN (
      SELECT ${user_affiliate_events.id}
      FROM ${user_affiliate_events}
      WHERE ${user_affiliate_events.delivery_state} = 'queued'
        AND coalesce(${user_affiliate_events.next_retry_at}, '-infinity'::timestamptz) <= now()
      ORDER BY ${user_affiliate_events.created_at} ASC, ${user_affiliate_events.id} ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING
      ${user_affiliate_events.id},
      ${user_affiliate_events.user_id},
      ${user_affiliate_events.provider},
      ${user_affiliate_events.event_type},
      ${user_affiliate_events.dedupe_key},
      ${user_affiliate_events.parent_event_id},
      ${user_affiliate_events.delivery_state},
      ${user_affiliate_events.payload_json},
      ${user_affiliate_events.attempt_count},
      ${user_affiliate_events.next_retry_at},
      ${user_affiliate_events.claimed_at},
      ${user_affiliate_events.created_at}
  `);

  return result.rows;
}

async function dispatchAffiliateEvent(event: AffiliateEventRow): Promise<ImpactDispatchResult> {
  const eventDate = new Date(event.payload_json.eventDate);

  switch (event.provider) {
    case 'impact': {
      switch (event.event_type) {
        case 'signup':
          return await sendImpactConversionPayload(
            buildSignUpPayload({
              trackingId: event.payload_json.trackingId,
              customerId: event.payload_json.customerId ?? event.user_id,
              customerEmailHash: event.payload_json.customerEmailHash ?? '',
              eventDate,
            })
          );
        case 'trial_start':
          return await sendImpactConversionPayload(
            buildTrialStartPayload({
              trackingId: event.payload_json.trackingId,
              customerId: event.payload_json.customerId ?? event.user_id,
              customerEmailHash: event.payload_json.customerEmailHash ?? '',
              eventDate,
            })
          );
        case 'trial_end':
          return await sendImpactConversionPayload(
            buildTrialEndPayload({
              trackingId: event.payload_json.trackingId,
              customerId: event.payload_json.customerId ?? event.user_id,
              customerEmailHash: event.payload_json.customerEmailHash ?? '',
              eventDate,
            })
          );
        case 'sale':
          return await sendImpactConversionPayload(
            buildSalePayload({
              trackingId: event.payload_json.trackingId,
              customerId: event.payload_json.customerId ?? event.user_id,
              customerEmailHash: event.payload_json.customerEmailHash ?? '',
              orderId: event.payload_json.orderId,
              amount: event.payload_json.amount ?? 0,
              currencyCode: event.payload_json.currencyCode ?? 'usd',
              eventDate,
              itemCategory: event.payload_json.itemCategory ?? '',
              itemName: event.payload_json.itemName ?? '',
              itemSku: event.payload_json.itemSku ?? undefined,
              promoCode: event.payload_json.promoCode ?? undefined,
            })
          );
      }
    }
  }

  throw new Error(
    `Unsupported affiliate provider/event combination: ${event.provider}/${event.event_type}`
  );
}

export async function findOrCreateParentEvent(
  params: FindOrCreateParentEventParams
): Promise<AffiliateEventRow> {
  const database = getDatabaseClient(params.database);
  const dedupeKey = buildParentEventDedupeKey(params.userId, params.provider);

  const [inserted] = await database
    .insert(user_affiliate_events)
    .values({
      user_id: params.userId,
      provider: params.provider,
      event_type: getParentEventType(params.provider),
      dedupe_key: dedupeKey,
      delivery_state: 'queued',
      payload_json: buildAffiliateEventPayload({
        trackingId: params.trackingId,
        customerId: params.userId,
        customerEmailHash: params.customerEmailHash,
        eventDate: params.eventDate,
        orderId: IMPACT_ORDER_ID_MACRO,
      }),
    })
    .onConflictDoNothing({
      target: [user_affiliate_events.dedupe_key],
    })
    .returning();

  const event = inserted ?? (await getEventByDedupeKey(database, dedupeKey));
  logInfo(inserted ? 'Enqueued affiliate parent event' : 'Affiliate parent event already exists', {
    ...buildAffiliateEventLogFields(event),
  });
  return event;
}

export async function recordAffiliateAttributionAndQueueParentEvent(
  params: RecordAffiliateAttributionAndQueueParentParams
): Promise<AffiliateEventRow | null> {
  const database = getDatabaseClient(params.database);
  const trackingId = params.trackingId.trim();

  if (!trackingId) {
    logWarning('Skipped affiliate attribution enqueue because tracking ID was empty', {
      user_id: params.userId,
      affiliate_provider: params.provider,
    });
    return null;
  }

  await database
    .insert(user_affiliate_attributions)
    .values({
      user_id: params.userId,
      provider: params.provider,
      tracking_id: trackingId,
    })
    .onConflictDoNothing({
      target: [user_affiliate_attributions.user_id, user_affiliate_attributions.provider],
    });

  return await findOrCreateParentEvent({
    database,
    userId: params.userId,
    provider: params.provider,
    trackingId,
    customerEmailHash: hashEmailForImpact(params.customerEmail),
    eventDate: params.eventDate,
  });
}

export async function enqueueAffiliateEventForUser(
  params: EnqueueAffiliateEventForUserParams
): Promise<AffiliateEventRow | null> {
  const database = getDatabaseClient(params.database);
  const [userRow] = await database
    .select({ google_user_email: kilocode_users.google_user_email })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, params.userId))
    .limit(1);

  if (!userRow) {
    logWarning('Skipped affiliate child enqueue because user was missing', {
      user_id: params.userId,
      affiliate_provider: params.provider,
      affiliate_event_type: params.eventType,
      affiliate_dedupe_key: params.dedupeKey,
    });
    return null;
  }

  const [attribution] = await database
    .select({
      tracking_id: user_affiliate_attributions.tracking_id,
      created_at: user_affiliate_attributions.created_at,
    })
    .from(user_affiliate_attributions)
    .where(
      and(
        eq(user_affiliate_attributions.user_id, params.userId),
        eq(user_affiliate_attributions.provider, params.provider)
      )
    )
    .limit(1);

  if (!attribution) {
    return null;
  }

  const parentEvent = await findOrCreateParentEvent({
    database,
    userId: params.userId,
    provider: params.provider,
    trackingId: attribution.tracking_id,
    customerEmailHash: hashEmailForImpact(userRow.google_user_email),
    eventDate: new Date(attribution.created_at),
  });
  const deliveryState = parentEvent.delivery_state === 'delivered' ? 'queued' : 'blocked';

  const [inserted] = await database
    .insert(user_affiliate_events)
    .values({
      user_id: params.userId,
      provider: params.provider,
      event_type: params.eventType,
      dedupe_key: params.dedupeKey,
      parent_event_id: parentEvent.id,
      delivery_state: deliveryState,
      payload_json: buildAffiliateEventPayload({
        trackingId: attribution.tracking_id,
        customerId: params.userId,
        customerEmailHash: hashEmailForImpact(userRow.google_user_email),
        eventDate: params.eventDate,
        orderId: params.orderId,
        amount: params.amount,
        currencyCode: params.currencyCode,
        itemCategory: params.itemCategory,
        itemName: params.itemName,
        itemSku: params.itemSku,
        promoCode: params.promoCode,
      }),
    })
    .onConflictDoNothing({
      target: [user_affiliate_events.dedupe_key],
    })
    .returning();

  const event = inserted ?? (await getEventByDedupeKey(database, params.dedupeKey));
  logInfo(inserted ? 'Enqueued affiliate child event' : 'Affiliate child event already exists', {
    ...buildAffiliateEventLogFields(event),
  });
  return event;
}

export async function dispatchQueuedAffiliateEvents(params?: {
  database?: DatabaseClient;
  limit?: number;
}): Promise<AffiliateEventDispatchSummary> {
  const database = getDatabaseClient(params?.database);
  const limit = params?.limit ?? DEFAULT_CLAIM_LIMIT;
  const summary: AffiliateEventDispatchSummary = {
    reclaimed: 0,
    claimed: 0,
    delivered: 0,
    retried: 0,
    failed: 0,
    unblocked: 0,
  };

  const reclaimed = await reclaimStaleSendingEvents(database);
  summary.reclaimed = reclaimed.length;
  for (const event of reclaimed) {
    logWarning('Reclaimed stale affiliate event claim', {
      ...buildAffiliateEventLogFields(event),
      dispatch_source: 'cron',
    });
  }

  let remaining = limit;
  while (remaining > 0) {
    const claimedEvents = await claimQueuedEvents(database, remaining);
    if (claimedEvents.length === 0) {
      break;
    }

    summary.claimed += claimedEvents.length;
    remaining -= claimedEvents.length;

    for (const event of claimedEvents) {
      logInfo('Claimed affiliate event for dispatch', {
        ...buildAffiliateEventLogFields(event),
        dispatch_source: 'cron',
      });

      const result = await dispatchAffiliateEvent(event);
      if (result.ok) {
        await markAffiliateEventDelivered(database, event.id);
        summary.delivered += 1;

        const deliveredEvent = {
          ...event,
          delivery_state: 'delivered',
        } satisfies AffiliateEventRow;
        logInfo('Delivered affiliate event', {
          ...buildAffiliateEventLogFields(deliveredEvent),
          dispatch_source: 'cron',
        });

        if (event.event_type === getParentEventType(event.provider)) {
          const unblockedChildren = await promoteBlockedChildren(database, event.id);
          summary.unblocked += unblockedChildren.length;
          for (const childEvent of unblockedChildren) {
            logInfo('Unblocked affiliate child event', {
              ...buildAffiliateEventLogFields(childEvent),
            });
          }
        }

        continue;
      }

      if (result.failureKind === 'http_4xx') {
        const nextAttemptCount = await failAffiliateEvent(database, event.id);
        summary.failed += 1;

        logError('Affiliate event delivery failed permanently', {
          ...buildAffiliateEventLogFields({
            ...event,
            delivery_state: 'failed',
            attempt_count: nextAttemptCount,
          }),
          dispatch_source: 'cron',
          failure_kind: result.failureKind,
          status_code: result.statusCode,
        });
        continue;
      }

      const nextRetryAt = computeNextRetryAt(event.attempt_count);
      const nextAttemptCount = await requeueAffiliateEvent(database, event.id, nextRetryAt);
      summary.retried += 1;

      logWarning('Affiliate event delivery scheduled for retry', {
        ...buildAffiliateEventLogFields({
          ...event,
          delivery_state: 'queued',
          attempt_count: nextAttemptCount,
          next_retry_at: nextRetryAt,
          claimed_at: null,
        }),
        dispatch_source: 'cron',
        failure_kind: result.failureKind,
        status_code: result.statusCode,
      });
    }
  }

  return summary;
}
