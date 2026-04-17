import 'server-only';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  IMPACT_ACTION_TRACKER_IDS,
  IMPACT_ORDER_ID_MACRO,
  type ImpactConversionPayload,
  type ImpactDispatchResult,
  buildSalePayload,
  buildSignUpPayload,
  buildTrialEndPayload,
  buildTrialStartPayload,
  hashEmailForImpact,
  isImpactConfigured,
  resolveImpactSubmissionUri,
  reverseImpactAction,
  sendImpactConversionPayload,
} from '@/lib/impact';
import { sentryLogger } from '@/lib/utils.server';
import {
  kilocode_users,
  type AffiliateEventPayloadJson,
  type UserAffiliateEvent,
  pending_impact_sale_reversals,
  user_affiliate_attributions,
  user_affiliate_events,
} from '@kilocode/db/schema';
import type {
  AffiliateEventDeliveryState,
  AffiliateEventType,
  AffiliateProvider,
} from '@kilocode/db/schema-types';
import { and, desc, eq, sql } from 'drizzle-orm';

const logInfo = sentryLogger('affiliate-events', 'info');
const logWarning = sentryLogger('affiliate-events', 'warning');
const logError = sentryLogger('affiliate-events', 'error');

const DEFAULT_CLAIM_LIMIT = 100;
const STALE_CLAIM_WINDOW_MS = 15 * 60 * 1000;
const MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;
const INITIAL_RETRY_BACKOFF_MS = 60 * 1000;
const IMPACT_PARENT_PROCESSING_DELAY_MS = 5 * 60 * 1000;

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
  failure_kind?: 'http_4xx' | 'http_5xx' | 'network' | 'submission_failed';
  status_code?: number;
  stripe_charge_id?: string | null;
  impact_action_id?: string | null;
  dispute_id?: string | null;
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
  | 'stripe_charge_id'
  | 'impact_action_id'
  | 'impact_submission_uri'
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
  eventType: Exclude<AffiliateEventType, 'signup' | 'sale_reversal'>;
  dedupeKey: string;
  eventDate: Date;
  orderId: string;
  amount?: number;
  currencyCode?: string;
  itemCategory?: string;
  itemName?: string;
  itemSku?: string;
  promoCode?: string;
  stripeChargeId?: string;
};

type EnqueueImpactSaleReversalForChargeParams = {
  database?: DatabaseClient;
  stripeChargeId: string;
  disputeId: string;
  amount: number;
  currency: string;
  eventDate: Date;
};

type ImpactResolutionFailureKind = 'http_4xx' | 'http_5xx' | 'network' | 'submission_failed';

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
    case 'sale_reversal':
      return undefined;
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
    stripe_charge_id: event.stripe_charge_id ?? event.payload_json.stripeChargeId ?? null,
    impact_action_id: event.impact_action_id ?? event.payload_json.impactActionId ?? null,
    dispute_id: event.payload_json.disputeId ?? null,
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
  stripeChargeId?: string;
  impactActionId?: string;
  impactSubmissionUri?: string;
  disputeId?: string;
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
    stripeChargeId: params.stripeChargeId ?? null,
    impactActionId: params.impactActionId ?? null,
    impactSubmissionUri: params.impactSubmissionUri ?? null,
    disputeId: params.disputeId ?? null,
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

function eventHasImpactMapping(event: AffiliateEventRow): boolean {
  return Boolean(event.impact_action_id || event.impact_submission_uri);
}

function getImpactActionId(event: AffiliateEventRow): string | null {
  return event.impact_action_id ?? event.payload_json.impactActionId ?? null;
}

function getImpactSubmissionUri(event: AffiliateEventRow): string | null {
  return event.impact_submission_uri ?? event.payload_json.impactSubmissionUri ?? null;
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
  event: AffiliateEventRow,
  params?: {
    clearClaimedAt?: boolean;
    impactMapping?: {
      impactActionId?: string | null;
      impactSubmissionUri?: string | null;
    };
  }
): Promise<AffiliateEventRow> {
  const mapping = params?.impactMapping;
  const nextPayload = mapping
    ? ({
        ...event.payload_json,
        impactActionId: mapping.impactActionId ?? event.payload_json.impactActionId ?? null,
        impactSubmissionUri:
          mapping.impactSubmissionUri ?? event.payload_json.impactSubmissionUri ?? null,
      } satisfies AffiliateEventPayloadJson)
    : event.payload_json;

  const updateValues: {
    delivery_state: 'delivered';
    next_retry_at: null;
    claimed_at?: null;
    impact_action_id?: string | null;
    impact_submission_uri?: string | null;
    payload_json?: AffiliateEventPayloadJson;
  } = {
    delivery_state: 'delivered',
    next_retry_at: null,
  };
  if (params?.clearClaimedAt) {
    updateValues.claimed_at = null;
  }
  if (mapping) {
    updateValues.impact_action_id = mapping.impactActionId ?? event.impact_action_id ?? null;
    updateValues.impact_submission_uri =
      mapping.impactSubmissionUri ?? event.impact_submission_uri ?? null;
    updateValues.payload_json = nextPayload;
  }

  const [updated] = await database
    .update(user_affiliate_events)
    .set(updateValues)
    .where(eq(user_affiliate_events.id, event.id))
    .returning({
      id: user_affiliate_events.id,
      user_id: user_affiliate_events.user_id,
      provider: user_affiliate_events.provider,
      event_type: user_affiliate_events.event_type,
      dedupe_key: user_affiliate_events.dedupe_key,
      parent_event_id: user_affiliate_events.parent_event_id,
      delivery_state: user_affiliate_events.delivery_state,
      payload_json: user_affiliate_events.payload_json,
      stripe_charge_id: user_affiliate_events.stripe_charge_id,
      impact_action_id: user_affiliate_events.impact_action_id,
      impact_submission_uri: user_affiliate_events.impact_submission_uri,
      attempt_count: user_affiliate_events.attempt_count,
      next_retry_at: user_affiliate_events.next_retry_at,
      claimed_at: user_affiliate_events.claimed_at,
      created_at: user_affiliate_events.created_at,
    });

  return (
    updated ?? {
      ...event,
      delivery_state: 'delivered',
      next_retry_at: null,
      claimed_at: params?.clearClaimedAt ? null : event.claimed_at,
      impact_action_id: mapping
        ? (mapping.impactActionId ?? event.impact_action_id ?? null)
        : event.impact_action_id,
      impact_submission_uri: mapping
        ? (mapping.impactSubmissionUri ?? event.impact_submission_uri ?? null)
        : event.impact_submission_uri,
      payload_json: nextPayload,
    }
  );
}

async function updateAffiliateEventImpactMapping(
  database: DatabaseClient,
  event: AffiliateEventRow,
  params: {
    impactActionId?: string | null;
    impactSubmissionUri?: string | null;
  }
): Promise<AffiliateEventRow> {
  const nextPayload = {
    ...event.payload_json,
    impactActionId: params.impactActionId ?? event.payload_json.impactActionId ?? null,
    impactSubmissionUri:
      params.impactSubmissionUri ?? event.payload_json.impactSubmissionUri ?? null,
  } satisfies AffiliateEventPayloadJson;

  const [updated] = await database
    .update(user_affiliate_events)
    .set({
      impact_action_id: params.impactActionId ?? event.impact_action_id ?? null,
      impact_submission_uri: params.impactSubmissionUri ?? event.impact_submission_uri ?? null,
      payload_json: nextPayload,
    })
    .where(eq(user_affiliate_events.id, event.id))
    .returning({
      id: user_affiliate_events.id,
      user_id: user_affiliate_events.user_id,
      provider: user_affiliate_events.provider,
      event_type: user_affiliate_events.event_type,
      dedupe_key: user_affiliate_events.dedupe_key,
      parent_event_id: user_affiliate_events.parent_event_id,
      delivery_state: user_affiliate_events.delivery_state,
      payload_json: user_affiliate_events.payload_json,
      stripe_charge_id: user_affiliate_events.stripe_charge_id,
      impact_action_id: user_affiliate_events.impact_action_id,
      impact_submission_uri: user_affiliate_events.impact_submission_uri,
      attempt_count: user_affiliate_events.attempt_count,
      next_retry_at: user_affiliate_events.next_retry_at,
      claimed_at: user_affiliate_events.claimed_at,
      created_at: user_affiliate_events.created_at,
    });

  return updated ?? { ...event, payload_json: nextPayload };
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
      AND (
        ${user_affiliate_events.event_type} <> 'sale_reversal'
        OR EXISTS (
          SELECT 1
          FROM ${user_affiliate_events} AS parent_event
          WHERE parent_event.id = ${parentEventId}::uuid
            AND (
              parent_event.impact_action_id IS NOT NULL
              OR parent_event.impact_submission_uri IS NOT NULL
            )
        )
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
      ${user_affiliate_events.stripe_charge_id},
      ${user_affiliate_events.impact_action_id},
      ${user_affiliate_events.impact_submission_uri},
      ${user_affiliate_events.attempt_count},
      ${user_affiliate_events.next_retry_at},
      ${user_affiliate_events.claimed_at},
      ${user_affiliate_events.created_at}
  `);

  return result.rows;
}

async function reconcileBlockedChildrenWithDeliveredParents(
  database: DatabaseClient
): Promise<AffiliateEventRow[]> {
  const result = await database.execute<AffiliateEventRow>(sql`
    UPDATE ${user_affiliate_events}
    SET
      ${sql.identifier(user_affiliate_events.delivery_state.name)} = 'queued',
      ${sql.identifier(user_affiliate_events.next_retry_at.name)} = NULL,
      ${sql.identifier(user_affiliate_events.claimed_at.name)} = NULL
    WHERE ${user_affiliate_events.delivery_state} = 'blocked'
      AND EXISTS (
        SELECT 1
        FROM ${user_affiliate_events} AS parent_event
        WHERE parent_event.id = ${user_affiliate_events.parent_event_id}
          AND parent_event.delivery_state = 'delivered'
          AND (
            ${user_affiliate_events.event_type} <> 'sale_reversal'
            OR parent_event.impact_action_id IS NOT NULL
            OR parent_event.impact_submission_uri IS NOT NULL
          )
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
      ${user_affiliate_events.stripe_charge_id},
      ${user_affiliate_events.impact_action_id},
      ${user_affiliate_events.impact_submission_uri},
      ${user_affiliate_events.attempt_count},
      ${user_affiliate_events.next_retry_at},
      ${user_affiliate_events.claimed_at},
      ${user_affiliate_events.created_at}
  `);

  return result.rows;
}

async function failBlockedSaleReversalChildrenWithFailedParents(
  database: DatabaseClient
): Promise<AffiliateEventRow[]> {
  const result = await database.execute<AffiliateEventRow>(sql`
    UPDATE ${user_affiliate_events}
    SET
      ${sql.identifier(user_affiliate_events.delivery_state.name)} = 'failed',
      ${sql.identifier(user_affiliate_events.attempt_count.name)} = ${user_affiliate_events.attempt_count} + 1,
      ${sql.identifier(user_affiliate_events.claimed_at.name)} = NULL
    WHERE ${user_affiliate_events.delivery_state} = 'blocked'
      AND ${user_affiliate_events.event_type} = 'sale_reversal'
      AND EXISTS (
        SELECT 1
        FROM ${user_affiliate_events} AS parent_event
        WHERE parent_event.id = ${user_affiliate_events.parent_event_id}
          AND parent_event.delivery_state = 'failed'
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
      ${user_affiliate_events.stripe_charge_id},
      ${user_affiliate_events.impact_action_id},
      ${user_affiliate_events.impact_submission_uri},
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
      ${user_affiliate_events.stripe_charge_id},
      ${user_affiliate_events.impact_action_id},
      ${user_affiliate_events.impact_submission_uri},
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
  const impactParentProcessedBefore = new Date(
    Date.now() - IMPACT_PARENT_PROCESSING_DELAY_MS
  ).toISOString();
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
        AND (
          ${user_affiliate_events.parent_event_id} IS NULL
          OR EXISTS (
            SELECT 1
            FROM ${user_affiliate_events} AS parent_event
            WHERE parent_event.id = ${user_affiliate_events.parent_event_id}
              AND parent_event.delivery_state = 'delivered'
              AND (
                ${user_affiliate_events.event_type} = 'sale_reversal'
                OR parent_event.provider <> 'impact'
                OR parent_event.event_type <> 'signup'
                OR parent_event.claimed_at IS NULL
                OR parent_event.claimed_at <= ${impactParentProcessedBefore}::timestamptz
              )
          )
        )
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
      ${user_affiliate_events.stripe_charge_id},
      ${user_affiliate_events.impact_action_id},
      ${user_affiliate_events.impact_submission_uri},
      ${user_affiliate_events.attempt_count},
      ${user_affiliate_events.next_retry_at},
      ${user_affiliate_events.claimed_at},
      ${user_affiliate_events.created_at}
  `);

  return result.rows;
}

function buildImpactConversionPayloadForEvent(event: AffiliateEventRow): ImpactConversionPayload {
  const eventDate = new Date(event.payload_json.eventDate);

  switch (event.provider) {
    case 'impact': {
      switch (event.event_type) {
        case 'signup':
          return buildSignUpPayload({
            trackingId: event.payload_json.trackingId,
            customerId: event.payload_json.customerId ?? event.user_id,
            customerEmailHash: event.payload_json.customerEmailHash ?? '',
            eventDate,
          });
        case 'trial_start':
          return buildTrialStartPayload({
            trackingId: event.payload_json.trackingId,
            customerId: event.payload_json.customerId ?? event.user_id,
            customerEmailHash: event.payload_json.customerEmailHash ?? '',
            eventDate,
          });
        case 'trial_end':
          return buildTrialEndPayload({
            trackingId: event.payload_json.trackingId,
            customerId: event.payload_json.customerId ?? event.user_id,
            customerEmailHash: event.payload_json.customerEmailHash ?? '',
            eventDate,
          });
        case 'sale':
          return buildSalePayload({
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
          });
        case 'sale_reversal':
          break;
      }
    }
  }

  throw new Error(
    `Unsupported affiliate provider/event combination: ${event.provider}/${event.event_type}`
  );
}

async function getAffiliateEventById(
  database: DatabaseClient,
  eventId: string
): Promise<AffiliateEventRow | null> {
  const event = await database.query.user_affiliate_events.findFirst({
    where: eq(user_affiliate_events.id, eventId),
  });

  return event ?? null;
}

async function getImpactSaleEventByChargeId(
  database: DatabaseClient,
  stripeChargeId: string
): Promise<AffiliateEventRow | null> {
  const [event] = await database
    .select()
    .from(user_affiliate_events)
    .where(
      and(
        eq(user_affiliate_events.provider, 'impact'),
        eq(user_affiliate_events.event_type, 'sale'),
        eq(user_affiliate_events.stripe_charge_id, stripeChargeId)
      )
    )
    .orderBy(desc(user_affiliate_events.created_at), desc(user_affiliate_events.id))
    .limit(1);

  return event ?? null;
}

async function failBlockedSaleReversalChildrenForParent(
  database: DatabaseClient,
  parentEventId: string
): Promise<AffiliateEventRow[]> {
  const result = await database.execute<AffiliateEventRow>(sql`
    UPDATE ${user_affiliate_events}
    SET
      ${sql.identifier(user_affiliate_events.delivery_state.name)} = 'failed',
      ${sql.identifier(user_affiliate_events.attempt_count.name)} = ${user_affiliate_events.attempt_count} + 1,
      ${sql.identifier(user_affiliate_events.claimed_at.name)} = NULL
    WHERE ${user_affiliate_events.delivery_state} = 'blocked'
      AND ${user_affiliate_events.event_type} = 'sale_reversal'
      AND ${user_affiliate_events.parent_event_id} = ${parentEventId}::uuid
    RETURNING
      ${user_affiliate_events.id},
      ${user_affiliate_events.user_id},
      ${user_affiliate_events.provider},
      ${user_affiliate_events.event_type},
      ${user_affiliate_events.dedupe_key},
      ${user_affiliate_events.parent_event_id},
      ${user_affiliate_events.delivery_state},
      ${user_affiliate_events.payload_json},
      ${user_affiliate_events.stripe_charge_id},
      ${user_affiliate_events.impact_action_id},
      ${user_affiliate_events.impact_submission_uri},
      ${user_affiliate_events.attempt_count},
      ${user_affiliate_events.next_retry_at},
      ${user_affiliate_events.claimed_at},
      ${user_affiliate_events.created_at}
  `);

  return result.rows;
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

  const [inserted] = await database
    .insert(user_affiliate_events)
    .values({
      user_id: params.userId,
      provider: params.provider,
      event_type: params.eventType,
      dedupe_key: params.dedupeKey,
      parent_event_id: parentEvent.id,
      delivery_state: sql<AffiliateEventDeliveryState>`
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM ${user_affiliate_events}
            WHERE ${user_affiliate_events.id} = ${parentEvent.id}::uuid
              AND ${user_affiliate_events.delivery_state} = 'delivered'
          )
          THEN 'queued'
          ELSE 'blocked'
        END
      `,
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
        stripeChargeId: params.stripeChargeId,
      }),
      stripe_charge_id: params.stripeChargeId ?? null,
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

export async function enqueueImpactSaleReversalForCharge(
  params: EnqueueImpactSaleReversalForChargeParams
): Promise<AffiliateEventRow | null> {
  const database = getDatabaseClient(params.database);
  const parentSaleEvent = await getImpactSaleEventByChargeId(database, params.stripeChargeId);

  if (!parentSaleEvent) {
    await persistPendingSaleReversal(database, params);
    logInfo(
      'Impact sale reversal deferred because sale row is not yet recorded; will reconcile on dispatch',
      {
        affiliate_provider: 'impact',
        affiliate_event_type: 'sale_reversal',
        stripe_charge_id: params.stripeChargeId,
        dispute_id: params.disputeId,
      }
    );
    return null;
  }

  const dedupeKey = `affiliate:impact:sale_reversal:${params.stripeChargeId}`;
  const mappingAvailable = eventHasImpactMapping(parentSaleEvent);

  if (parentSaleEvent.delivery_state === 'delivered' && !mappingAvailable) {
    logWarning(
      'Impact sale reversal requires manual follow-up because delivered sale mapping is missing',
      {
        ...buildAffiliateEventLogFields(parentSaleEvent),
        affiliate_event_type: 'sale_reversal',
        affiliate_dedupe_key: dedupeKey,
        stripe_charge_id: params.stripeChargeId,
        dispute_id: params.disputeId,
      }
    );
    return null;
  }

  const [inserted] = await database
    .insert(user_affiliate_events)
    .values({
      user_id: parentSaleEvent.user_id,
      provider: 'impact',
      event_type: 'sale_reversal',
      dedupe_key: dedupeKey,
      parent_event_id: parentSaleEvent.id,
      delivery_state: mappingAvailable ? 'queued' : 'blocked',
      payload_json: buildAffiliateEventPayload({
        trackingId: parentSaleEvent.payload_json.trackingId ?? '',
        customerId: parentSaleEvent.payload_json.customerId ?? parentSaleEvent.user_id,
        customerEmailHash: parentSaleEvent.payload_json.customerEmailHash ?? '',
        orderId: parentSaleEvent.payload_json.orderId,
        eventDate: params.eventDate,
        amount: params.amount,
        currencyCode: params.currency,
        stripeChargeId: params.stripeChargeId,
        impactActionId: getImpactActionId(parentSaleEvent) ?? undefined,
        disputeId: params.disputeId,
      }),
      stripe_charge_id: params.stripeChargeId,
      impact_action_id: getImpactActionId(parentSaleEvent),
    })
    .onConflictDoNothing({
      target: [user_affiliate_events.dedupe_key],
    })
    .returning();

  const event = inserted ?? (await getEventByDedupeKey(database, dedupeKey));
  logInfo(
    inserted ? 'Enqueued Impact sale reversal event' : 'Impact sale reversal event already exists',
    {
      ...buildAffiliateEventLogFields(event),
    }
  );
  return event;
}

async function persistPendingSaleReversal(
  database: DatabaseClient,
  params: EnqueueImpactSaleReversalForChargeParams
): Promise<void> {
  await database
    .insert(pending_impact_sale_reversals)
    .values({
      stripe_charge_id: params.stripeChargeId,
      dispute_id: params.disputeId,
      amount: params.amount,
      currency: params.currency,
      event_date: params.eventDate.toISOString(),
    })
    .onConflictDoNothing({
      target: [pending_impact_sale_reversals.stripe_charge_id],
    });
}

async function reconcilePendingSaleReversals(
  database: DatabaseClient
): Promise<{ materialized: number }> {
  const pendingRows = await database.query.pending_impact_sale_reversals.findMany();
  let materialized = 0;

  for (const pending of pendingRows) {
    const parentSaleEvent = await getImpactSaleEventByChargeId(database, pending.stripe_charge_id);

    await database
      .update(pending_impact_sale_reversals)
      .set({
        attempt_count: sql`${pending_impact_sale_reversals.attempt_count} + 1`,
        last_attempt_at: new Date().toISOString(),
      })
      .where(eq(pending_impact_sale_reversals.stripe_charge_id, pending.stripe_charge_id));

    if (!parentSaleEvent) {
      logWarning('Pending Impact sale reversal still waiting for sale row', {
        affiliate_provider: 'impact',
        affiliate_event_type: 'sale_reversal',
        stripe_charge_id: pending.stripe_charge_id,
        dispute_id: pending.dispute_id,
      });
      continue;
    }

    const reversal = await enqueueImpactSaleReversalForCharge({
      database,
      stripeChargeId: pending.stripe_charge_id,
      disputeId: pending.dispute_id,
      amount: pending.amount,
      currency: pending.currency,
      eventDate: new Date(pending.event_date),
    });

    if (reversal) {
      await database
        .delete(pending_impact_sale_reversals)
        .where(eq(pending_impact_sale_reversals.stripe_charge_id, pending.stripe_charge_id));
      materialized += 1;
    }
  }

  return { materialized };
}

async function handleRetryableFailure(
  database: DatabaseClient,
  event: AffiliateEventRow,
  failureKind: Exclude<ImpactResolutionFailureKind, 'http_4xx' | 'submission_failed'>,
  statusCode?: number
): Promise<{ attemptCount: number; nextRetryAt: string }> {
  const nextRetryAt = computeNextRetryAt(event.attempt_count);
  const nextAttemptCount = await requeueAffiliateEvent(database, event.id, nextRetryAt);

  logWarning('Affiliate event delivery scheduled for retry', {
    ...buildAffiliateEventLogFields({
      ...event,
      delivery_state: 'queued',
      attempt_count: nextAttemptCount,
      next_retry_at: nextRetryAt,
      claimed_at: null,
    }),
    dispatch_source: 'cron',
    failure_kind: failureKind,
    status_code: statusCode,
  });

  return {
    attemptCount: nextAttemptCount,
    nextRetryAt,
  };
}

async function handlePermanentFailure(
  database: DatabaseClient,
  event: AffiliateEventRow,
  failureKind: 'http_4xx' | 'submission_failed',
  params?: { statusCode?: number; error?: string }
): Promise<number> {
  const nextAttemptCount = await failAffiliateEvent(database, event.id);

  logError('Affiliate event delivery failed permanently', {
    ...buildAffiliateEventLogFields({
      ...event,
      delivery_state: 'failed',
      attempt_count: nextAttemptCount,
    }),
    dispatch_source: 'cron',
    failure_kind: failureKind,
    status_code: params?.statusCode,
    error: params?.error,
  });

  if (event.event_type === 'sale') {
    const failedChildren = await failBlockedSaleReversalChildrenForParent(database, event.id);
    for (const childEvent of failedChildren) {
      logWarning('Blocked Impact sale reversal failed because parent sale failed', {
        ...buildAffiliateEventLogFields(childEvent),
        dispatch_source: 'cron',
      });
    }
  }

  return nextAttemptCount;
}

async function dispatchSaleReversalEvent(
  database: DatabaseClient,
  event: AffiliateEventRow
): Promise<'delivered' | 'retried' | 'failed'> {
  const parentEvent = event.parent_event_id
    ? await getAffiliateEventById(database, event.parent_event_id)
    : null;

  if (!parentEvent) {
    await handlePermanentFailure(database, event, 'submission_failed', {
      error: 'Parent sale event missing for reversal',
    });
    return 'failed';
  }

  if (parentEvent.delivery_state === 'failed') {
    await handlePermanentFailure(database, event, 'submission_failed', {
      error: 'Parent sale event failed before reversal could dispatch',
    });
    return 'failed';
  }

  let hydratedParentEvent = parentEvent;
  let impactActionId = getImpactActionId(hydratedParentEvent);
  const parentSubmissionUri = getImpactSubmissionUri(hydratedParentEvent);

  if (!impactActionId && parentSubmissionUri) {
    logInfo('Resolving queued Impact sale submission before reversal dispatch', {
      ...buildAffiliateEventLogFields(event),
      affiliate_parent_event_id: hydratedParentEvent.id,
      impact_action_id: null,
    });

    const resolution = await resolveImpactSubmissionUri(parentSubmissionUri);
    if (resolution.ok && resolution.status === 'resolved') {
      hydratedParentEvent = await updateAffiliateEventImpactMapping(database, hydratedParentEvent, {
        impactActionId: resolution.actionId,
      });
      impactActionId = resolution.actionId;

      logInfo('Resolved queued Impact submission to sale action ID', {
        ...buildAffiliateEventLogFields(hydratedParentEvent),
        dispatch_source: 'cron',
      });
    } else if (resolution.ok && resolution.status === 'pending') {
      await handleRetryableFailure(database, event, 'network');
      logWarning('Impact sale reversal waiting for queued sale submission to finish', {
        ...buildAffiliateEventLogFields(event),
        dispatch_source: 'cron',
      });
      return 'retried';
    } else if (
      !resolution.ok &&
      (resolution.failureKind === 'http_5xx' || resolution.failureKind === 'network')
    ) {
      await handleRetryableFailure(database, event, resolution.failureKind, resolution.statusCode);
      return 'retried';
    } else {
      await handlePermanentFailure(database, event, 'submission_failed', {
        error: resolution.ok
          ? 'Impact submission resolved without action ID'
          : (resolution.error ?? resolution.responseBody),
        statusCode: resolution.ok ? undefined : resolution.statusCode,
      });
      logWarning('Impact sale reversal requires manual follow-up because action mapping failed', {
        ...buildAffiliateEventLogFields(event),
        dispatch_source: 'cron',
      });
      return 'failed';
    }
  }

  if (!impactActionId) {
    await handlePermanentFailure(database, event, 'submission_failed', {
      error: 'Impact sale reversal missing action mapping',
    });
    logWarning('Impact sale reversal requires manual follow-up because action mapping is missing', {
      ...buildAffiliateEventLogFields(event),
      dispatch_source: 'cron',
    });
    return 'failed';
  }

  const reversalResult = await reverseImpactAction({
    actionId: impactActionId,
  });

  if (reversalResult.ok) {
    const deliveredEvent = await markAffiliateEventDelivered(database, event, {
      clearClaimedAt: reversalResult.skipped === 'unconfigured',
      impactMapping: {
        impactActionId,
        impactSubmissionUri:
          reversalResult.delivery === 'queued' ? reversalResult.submissionUri : null,
      },
    });

    logInfo(
      reversalResult.skipped === 'unconfigured'
        ? 'Skipped Impact sale reversal because Impact is unconfigured'
        : 'Delivered Impact sale reversal',
      {
        ...buildAffiliateEventLogFields(deliveredEvent),
        dispatch_source: 'cron',
      }
    );
    return 'delivered';
  }

  if (
    reversalResult.failureKind === 'http_4xx' ||
    reversalResult.failureKind === 'submission_failed'
  ) {
    await handlePermanentFailure(database, event, reversalResult.failureKind, {
      statusCode: reversalResult.statusCode,
      error: reversalResult.error ?? reversalResult.responseBody,
    });
    logWarning('Impact sale reversal requires manual follow-up after permanent failure', {
      ...buildAffiliateEventLogFields(event),
      dispatch_source: 'cron',
    });
    return 'failed';
  }

  await handleRetryableFailure(
    database,
    event,
    reversalResult.failureKind,
    reversalResult.statusCode
  );
  return 'retried';
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

  const impactConfigured = isImpactConfigured();
  if (!impactConfigured) {
    logInfo(
      'Processing affiliate event dispatch as a no-op because Impact credentials are not configured',
      {
        dispatch_source: 'cron',
      }
    );
  }

  const reclaimed = await reclaimStaleSendingEvents(database);
  summary.reclaimed = reclaimed.length;
  for (const event of reclaimed) {
    logWarning('Reclaimed stale affiliate event claim', {
      ...buildAffiliateEventLogFields(event),
      dispatch_source: 'cron',
    });
  }

  const failedBlockedChildren = await failBlockedSaleReversalChildrenWithFailedParents(database);
  summary.failed += failedBlockedChildren.length;
  for (const childEvent of failedBlockedChildren) {
    logWarning('Blocked Impact sale reversal failed because parent sale is terminal', {
      ...buildAffiliateEventLogFields(childEvent),
      dispatch_source: 'cron',
    });
  }

  const reconciledChildren = await reconcileBlockedChildrenWithDeliveredParents(database);
  summary.unblocked += reconciledChildren.length;
  for (const childEvent of reconciledChildren) {
    logWarning('Recovered blocked affiliate child event after parent delivery', {
      ...buildAffiliateEventLogFields(childEvent),
      dispatch_source: 'cron',
    });
  }

  const { materialized: materializedReversals } = await reconcilePendingSaleReversals(database);
  if (materializedReversals > 0) {
    logInfo('Materialized deferred Impact sale reversals once sale rows appeared', {
      dispatch_source: 'cron',
      materialized_count: materializedReversals,
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

      if (event.event_type === 'sale_reversal') {
        const reversalOutcome = await dispatchSaleReversalEvent(database, event);
        if (reversalOutcome === 'delivered') {
          summary.delivered += 1;
        } else if (reversalOutcome === 'retried') {
          summary.retried += 1;
        } else {
          summary.failed += 1;
        }
        continue;
      }

      const impactPayload = buildImpactConversionPayloadForEvent(event);
      const result: ImpactDispatchResult = await sendImpactConversionPayload(impactPayload);
      if (result.ok) {
        const impactMapping =
          event.event_type === 'sale' && result.delivery === 'immediate'
            ? { impactActionId: result.actionId, impactSubmissionUri: null }
            : event.event_type === 'sale' && result.delivery === 'queued'
              ? { impactSubmissionUri: result.submissionUri }
              : undefined;

        const deliveredEvent = await markAffiliateEventDelivered(database, event, {
          clearClaimedAt: result.skipped === 'unconfigured',
          impactMapping,
        });
        summary.delivered += 1;

        logInfo(
          result.skipped === 'unconfigured'
            ? 'Skipped affiliate event delivery because Impact is unconfigured'
            : 'Delivered affiliate event',
          {
            ...buildAffiliateEventLogFields(deliveredEvent),
            dispatch_source: 'cron',
          }
        );

        if (
          event.event_type === getParentEventType(event.provider) ||
          event.event_type === 'sale'
        ) {
          const unblockedChildren = await promoteBlockedChildren(database, event.id);
          summary.unblocked += unblockedChildren.length;
          for (const childEvent of unblockedChildren) {
            logInfo('Unblocked affiliate child event', {
              ...buildAffiliateEventLogFields(childEvent),
              dispatch_source: 'cron',
            });
          }
        }

        continue;
      }

      if (result.failureKind === 'http_4xx' || result.failureKind === 'submission_failed') {
        await handlePermanentFailure(database, event, result.failureKind, {
          statusCode: result.statusCode,
          error: result.error ?? result.responseBody,
        });
        summary.failed += 1;
        continue;
      }

      await handleRetryableFailure(database, event, result.failureKind, result.statusCode);
      summary.retried += 1;
    }
  }

  return summary;
}
