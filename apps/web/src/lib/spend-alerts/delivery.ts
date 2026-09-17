import 'server-only';

import { eq, sql } from 'drizzle-orm';
import { organizations } from '@kilocode/db/schema';
import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { sendSpendAlertEmail } from '@/lib/email';
import { dispatchSpendAlertPush } from '@/lib/notifications-worker-client';
import {
  parseSpendAlertScopeKey,
  type SpendAlertRecipients,
  type SpendAlertRuleKind,
  type SpendAlertScope,
} from './settings';
import type { SpendAlertChannel } from './sweep';
import type { db as defaultDb } from '@/lib/drizzle';

/**
 * The drain half of the spend-alert feature. The sweep (sweep.ts) writes one
 * durable outbox row per alert and channel; this module claims those rows with
 * `FOR UPDATE SKIP LOCKED`, hands each one to the existing email sender or push
 * client, and retries a transport failure with backoff.
 *
 * The claim lease rides `next_attempt_at` rather than a dedicated `claimed_at`
 * column: the outbox table has no claim columns, and pushing the schedule
 * forward by the lease is the same guarantee — a second concurrent drain cannot
 * see the row as a candidate.
 */

/**
 * How long a claimed row stays invisible to another drain. Long enough to cover
 * one send (the push client waits up to 30s), short enough that a crashed run
 * is retried within the same hour.
 */
const DELIVERY_CLAIM_LEASE_MINUTES = 5;

/** Retry backoff cap, in minutes. Mirrors the usage rollup repair drain. */
const DELIVERY_MAX_BACKOFF_MINUTES = 60;

/** Human label for a rule kind in the email body and the push copy. */
const KIND_LABELS: Record<SpendAlertRuleKind, string> = {
  threshold: 'Spend threshold',
  anomaly: 'Hourly spike',
};

type Db = typeof defaultDb;

/** The spend figures the outbox row carries, written by the sweep's decision. */
type SpendAlertDeliveryPayload = {
  valueMicrodollars: number;
  thresholdMicrodollars: number;
  windowHours: number | null;
  multiplierBasisPoints: number | null;
  baselineHourlyMicrodollars: number | null;
};

/** One claimed outbox row, as the drain reads it. */
type ClaimedSpendAlertDelivery = {
  id: string;
  scope_key: string;
  rule_id: string | null;
  kind: SpendAlertRuleKind | null;
  channel: SpendAlertChannel | null;
  recipients: SpendAlertRecipients | null;
  payload: SpendAlertDeliveryPayload | null;
  attempt_count: number;
};

export type SpendAlertDeliveryFailure = {
  deliveryId: string;
  channel: SpendAlertChannel | null;
  error: string;
};

export type SpendAlertDeliverySummary = {
  claimed: number;
  delivered: number;
  failed: SpendAlertDeliveryFailure[];
};

/**
 * The two existing senders, injected so the drain can be exercised without a
 * mail or push transport. The defaults are the real senders.
 */
export type SpendAlertDeliveryDeps = {
  sendEmail: typeof sendSpendAlertEmail;
  dispatchPush: typeof dispatchSpendAlertPush;
};

export const spendAlertDeliveryDeps: SpendAlertDeliveryDeps = {
  sendEmail: sendSpendAlertEmail,
  dispatchPush: dispatchSpendAlertPush,
};

/** Storage shape of a delivery payload column that was written by an older sweep. */
function isDeliveryPayload(value: unknown): value is SpendAlertDeliveryPayload {
  if (value === null || typeof value !== 'object') return false;
  const payload = value as Partial<SpendAlertDeliveryPayload>;
  return (
    typeof payload.valueMicrodollars === 'number' &&
    typeof payload.thresholdMicrodollars === 'number'
  );
}

function recipientsOf(value: unknown): SpendAlertRecipients {
  if (value === null || typeof value !== 'object') return { userIds: [], emails: [] };
  const recipients = value as Partial<SpendAlertRecipients>;
  return {
    userIds: Array.isArray(recipients.userIds) ? recipients.userIds : [],
    emails: Array.isArray(recipients.emails) ? recipients.emails : [],
  };
}

/** Dollars rounded to the cent, which is the precision both surfaces show. */
function usdFromMicrodollars(microdollars: number): number {
  return Number(fromMicrodollars(microdollars).toFixed(2));
}

/**
 * Redacts a transport error to a stable token before it reaches
 * `last_error_redacted`. Postgres SQLSTATE codes are the one detail worth
 * keeping; everything else collapses to a channel-specific constant, so an
 * upstream message that echoes a recipient address never lands in the column.
 */
function safeDeliveryErrorCode(error: string, channel: SpendAlertChannel | null): string {
  const postgresCode = error.match(/\b[0-9A-Z]{5}\b/)?.[0];
  if (postgresCode) return `postgres:${postgresCode}`;
  return channel === 'push'
    ? 'spend_alert_push_delivery_failed'
    : 'spend_alert_email_delivery_failed';
}

/** The display name of the owner a scope key names. */
async function resolveSpendAlertScopeName(database: Db, scope: SpendAlertScope): Promise<string> {
  if (scope.type === 'personal') return 'Your account';

  const [organization] = await database
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, scope.organizationId))
    .limit(1);
  return organization?.name ?? 'Your organization';
}

/**
 * Claims up to `limit` due rows. The candidate set is ordered by the pending
 * index and locked with `FOR UPDATE SKIP LOCKED`, so two drains running at once
 * take disjoint rows. The update is the lease: it records the attempt and moves
 * `next_attempt_at` past the claim window, and `RETURNING` hands back exactly
 * the rows this caller owns.
 */
async function claimPendingSpendAlertDeliveries(
  database: Db,
  limit: number
): Promise<ClaimedSpendAlertDelivery[]> {
  const result = await database.execute<ClaimedSpendAlertDelivery>(sql`
    WITH candidates AS MATERIALIZED (
      SELECT
        delivery.id,
        delivery.attempt_count,
        delivery.next_attempt_at
      FROM spend_alert_deliveries delivery
      WHERE delivery.status = 'pending'
        AND delivery.next_attempt_at <= CURRENT_TIMESTAMP
      ORDER BY delivery.attempt_count, delivery.next_attempt_at, delivery.id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE spend_alert_deliveries delivery
    SET
      attempt_count = delivery.attempt_count + 1,
      next_attempt_at = CURRENT_TIMESTAMP + make_interval(mins => ${DELIVERY_CLAIM_LEASE_MINUTES}),
      last_error_redacted = NULL,
      updated_at = CURRENT_TIMESTAMP
    FROM candidates candidate
    WHERE delivery.id = candidate.id
    RETURNING
      delivery.id,
      delivery.scope_key,
      delivery.rule_id,
      delivery.kind,
      delivery.channel,
      delivery.recipients,
      delivery.payload,
      delivery.attempt_count
  `);
  return result.rows;
}

/**
 * Marks a claimed row delivered. The `attempt_count` predicate is the fence: a
 * row whose lease expired and was re-claimed by another drain has a higher
 * count, so this update cannot overwrite that worker's outcome.
 */
async function markSpendAlertDeliverySent(
  database: Db,
  row: ClaimedSpendAlertDelivery
): Promise<void> {
  await database.execute(sql`
    UPDATE spend_alert_deliveries
    SET
      status = 'sent',
      last_error_redacted = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${row.id}::uuid
      AND status = 'pending'
      AND attempt_count = ${row.attempt_count}
  `);
}

/**
 * Returns a claimed row to the pending queue with a backoff keyed to its
 * attempt count, keeping the row for retry. Paired with the claim's
 * `attempt_count` predicate for the same fencing guarantee as
 * {@link markSpendAlertDeliverySent}.
 */
async function rescheduleSpendAlertDelivery(
  database: Db,
  row: ClaimedSpendAlertDelivery,
  error: string
): Promise<void> {
  await database.execute(sql`
    UPDATE spend_alert_deliveries
    SET
      status = 'pending',
      next_attempt_at = CURRENT_TIMESTAMP
        + make_interval(mins => LEAST(${DELIVERY_MAX_BACKOFF_MINUTES}, 5 * attempt_count)),
      last_error_redacted = ${safeDeliveryErrorCode(error, row.channel)},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${row.id}::uuid
      AND status = 'pending'
      AND attempt_count = ${row.attempt_count}
  `);
}

/**
 * Sends one claimed row on its channel. An email carries this scope's amount
 * and threshold; a push passes the same figures to the notifications worker,
 * whose lock-screen blob stays content-free (it names the scope only).
 */
async function deliverClaimedSpendAlertDelivery(
  database: Db,
  deps: SpendAlertDeliveryDeps,
  row: ClaimedSpendAlertDelivery
): Promise<void> {
  const scope = parseSpendAlertScopeKey(row.scope_key);
  if (scope === null) throw new Error('spend_alert_delivery_unknown_scope');
  if (row.kind === null) throw new Error('spend_alert_delivery_unknown_kind');
  if (!isDeliveryPayload(row.payload)) throw new Error('spend_alert_delivery_missing_payload');

  const recipients = recipientsOf(row.recipients);
  const scopeName = await resolveSpendAlertScopeName(database, scope);
  const amountUsd = usdFromMicrodollars(row.payload.valueMicrodollars);
  const thresholdUsd = usdFromMicrodollars(row.payload.thresholdMicrodollars);

  if (row.channel === 'email') {
    if (recipients.emails.length === 0) return;
    await deps.sendEmail({
      to: recipients.emails,
      scopeType: scope.type,
      scopeId: scope.type === 'organization' ? scope.organizationId : scope.userId,
      scopeName,
      kindLabel: KIND_LABELS[row.kind],
      amountUsd,
      thresholdUsd,
    });
    return;
  }

  if (row.channel === 'push') {
    if (recipients.userIds.length === 0) return;
    await deps.dispatchPush({
      recipientUserIds: recipients.userIds,
      scope: scope.type,
      ...(scope.type === 'organization' ? { organizationId: scope.organizationId } : {}),
      alertKind: row.kind,
      scopeName,
      amountUsd,
      thresholdUsd,
    });
    return;
  }

  throw new Error('spend_alert_delivery_unknown_channel');
}

/**
 * Drains due deliveries: claims a bounded batch, sends each row, marks a
 * success sent and reschedules a transport failure for retry. The returned
 * summary is the alert path's own retryable-unhappy signal — a failed row stays
 * in the outbox, so a later run sends it.
 */
export async function drainPendingSpendAlertDeliveries(
  database: Db,
  deps: SpendAlertDeliveryDeps,
  options: { limit: number }
): Promise<SpendAlertDeliverySummary> {
  const { limit } = options;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Spend alert delivery limit must be a positive safe integer.');
  }

  const rows = await claimPendingSpendAlertDeliveries(database, limit);
  const summary: SpendAlertDeliverySummary = { claimed: rows.length, delivered: 0, failed: [] };

  for (const row of rows) {
    try {
      await deliverClaimedSpendAlertDelivery(database, deps, row);
      await markSpendAlertDeliverySent(database, row);
      summary.delivered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await rescheduleSpendAlertDelivery(database, row, message);
      summary.failed.push({
        deliveryId: row.id,
        channel: row.channel,
        error: safeDeliveryErrorCode(message, row.channel),
      });
    }
  }

  return summary;
}
