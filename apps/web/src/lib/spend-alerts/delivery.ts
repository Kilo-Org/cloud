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

/** Bounded retries of the narrowing+reschedule write; never a re-send. */
const DELIVERY_NARROW_ATTEMPTS = 3;

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
  dedupe_key: string;
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
 * mail or push transport. The defaults are the real senders. Both report the
 * outcome instead of throwing, so the drain can keep a permanent rejection out
 * of the retry queue and reschedule only a transient failure.
 */
export type SpendAlertDeliveryDeps = {
  sendEmail: typeof sendSpendAlertEmail;
  dispatchPush: typeof dispatchSpendAlertPush;
};

/** A failed send that a later drain should retry; `remainingEmails` narrows the retry set. */
class SpendAlertDeliveryRetryableError extends Error {
  readonly remainingEmails: string[] | undefined;

  constructor(message: string, remainingEmails?: string[]) {
    super(message);
    this.remainingEmails = remainingEmails;
  }
}

/** A send that cannot succeed for any remaining recipient: terminal, never retried. */
class SpendAlertDeliveryUndeliverableError extends Error {}

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
  // The drain's own stable tokens name the failure precisely and carry no
  // upstream text; any other message collapses to the channel constant.
  if (/^spend_alert_[a-z_]+$/.test(error)) return error;
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
      ORDER BY delivery.next_attempt_at, delivery.attempt_count, delivery.id
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
      delivery.dedupe_key,
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
 * Re-asserts this worker's lease on one claimed row immediately before it
 * sends that row. The batch claim stamped `next_attempt_at` once, when the whole
 * batch was claimed, but the rows are sent one at a time and up to `limit` of
 * them can sit behind the current one: a slow drain would let a later row's
 * lease expire while it waited, and a concurrent cron (the route's own
 * `maxDuration` is the lease) could claim and send it a second time. Renewing
 * per row keeps the lease measured from the send, and the `attempt_count`
 * predicate means a row another drain already re-claimed is not renewed: the
 * caller skips it rather than sending twice.
 */
async function renewSpendAlertDeliveryClaim(
  database: Db,
  row: ClaimedSpendAlertDelivery
): Promise<boolean> {
  const result = await database.execute(sql`
    UPDATE spend_alert_deliveries
    SET
      next_attempt_at = CURRENT_TIMESTAMP + make_interval(mins => ${DELIVERY_CLAIM_LEASE_MINUTES}),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${row.id}::uuid
      AND status = 'pending'
      AND attempt_count = ${row.attempt_count}
  `);
  return (result.rowCount ?? 0) > 0;
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
 * attempt count, keeping the row for retry. When `remainingEmails` is given the
 * same statement narrows the row to the addresses the failed attempt did not
 * reach, so a bookkeeping failure cannot leave the row claimable with the
 * recipients this attempt already delivered to. Paired with the claim's
 * `attempt_count` predicate for the same fencing guarantee as
 * {@link markSpendAlertDeliverySent}.
 */
async function rescheduleSpendAlertDelivery(
  database: Db,
  row: ClaimedSpendAlertDelivery,
  error: string,
  remainingEmails?: string[]
): Promise<void> {
  const narrowRecipients =
    remainingEmails === undefined
      ? sql``
      : sql`, recipients = jsonb_set(COALESCE(recipients, '{}'::jsonb), '{emails}', ${JSON.stringify(remainingEmails)}::jsonb, true)`;
  await database.execute(sql`
    UPDATE spend_alert_deliveries
    SET
      status = 'pending'
      ${narrowRecipients},
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
 * Marks a claimed row terminally failed. Used for a send that can never succeed
 * (a permanent recipient rejection, or a row nobody can receive) and for a
 * delivered row whose `sent` write could not be recorded: either way the row
 * must leave the pending queue rather than be resent on every run.
 */
async function markSpendAlertDeliveryFailed(
  database: Db,
  row: ClaimedSpendAlertDelivery,
  error: string
): Promise<void> {
  await database.execute(sql`
    UPDATE spend_alert_deliveries
    SET
      status = 'failed',
      last_error_redacted = ${safeDeliveryErrorCode(error, row.channel)},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${row.id}::uuid
      AND status = 'pending'
      AND attempt_count = ${row.attempt_count}
  `);
}

/**
 * Reschedules a retryable email row, narrowing it in the same write to the
 * addresses the failed attempt did not reach. The write is retried a bounded
 * number of times: returning the row to the queue without the narrowing would
 * email the recipients who already received the alert. If the narrowing cannot
 * be recorded at all the row is made terminal, so the alert is at-most-once
 * rather than re-sent to a recipient this attempt already reached.
 */
async function rescheduleRetryableSpendAlertDelivery(
  database: Db,
  row: ClaimedSpendAlertDelivery,
  error: string,
  remainingEmails: string[]
): Promise<void> {
  for (let attempt = 0; attempt < DELIVERY_NARROW_ATTEMPTS; attempt++) {
    try {
      await rescheduleSpendAlertDelivery(database, row, error, remainingEmails);
      return;
    } catch {
      // Retry the write; a plain reschedule would keep the full recipient list.
    }
  }
  try {
    await markSpendAlertDeliveryFailed(database, row, 'spend_alert_delivery_narrow_failed');
  } catch {
    // No write can record the outcome while the database rejects updates. The
    // row stays leased, and the run is reported as failed.
  }
}

/**
 * Sends one claimed row on its channel. An email carries this scope's amount
 * and threshold; a push passes the same figures to the notifications worker,
 * whose lock-screen blob stays content-free (it names the scope only). Throws a
 * {@link SpendAlertDeliveryUndeliverableError} for a send that cannot succeed
 * and a {@link SpendAlertDeliveryRetryableError} for one a later drain can.
 */
async function deliverClaimedSpendAlertDelivery(
  database: Db,
  deps: SpendAlertDeliveryDeps,
  row: ClaimedSpendAlertDelivery
): Promise<void> {
  const scope = parseSpendAlertScopeKey(row.scope_key);
  // A row whose shape cannot be interpreted is as undeliverable as one with no
  // recipient: the drain must end it, not reschedule it on every cron.
  if (scope === null) {
    throw new SpendAlertDeliveryUndeliverableError('spend_alert_delivery_unknown_scope');
  }
  if (row.kind === null) {
    throw new SpendAlertDeliveryUndeliverableError('spend_alert_delivery_unknown_kind');
  }
  if (!isDeliveryPayload(row.payload)) {
    throw new SpendAlertDeliveryUndeliverableError('spend_alert_delivery_missing_payload');
  }

  const recipients = recipientsOf(row.recipients);
  const scopeName = await resolveSpendAlertScopeName(database, scope);
  const amountUsd = usdFromMicrodollars(row.payload.valueMicrodollars);
  const thresholdUsd = usdFromMicrodollars(row.payload.thresholdMicrodollars);

  if (row.channel === 'email') {
    // No address on this channel will never become a delivery by waiting: the
    // row is terminal, not a silently-dropped alert or an endless retry.
    if (recipients.emails.length === 0) {
      throw new SpendAlertDeliveryUndeliverableError('spend_alert_delivery_no_recipients');
    }
    const outcome = await deps.sendEmail({
      to: recipients.emails,
      scopeType: scope.type,
      scopeId: scope.type === 'organization' ? scope.organizationId : scope.userId,
      scopeName,
      kindLabel: KIND_LABELS[row.kind],
      amountUsd,
      thresholdUsd,
    });
    // A transient transport failure is retryable; a permanent rejection is not.
    // Only the addresses the failed attempt did not reach are retried, so an
    // already-delivered recipient is not emailed again.
    if (outcome.retryable.length > 0) {
      throw new SpendAlertDeliveryRetryableError(
        'spend_alert_email_delivery_failed',
        outcome.retryable
      );
    }
    if (outcome.delivered.length === 0) {
      throw new SpendAlertDeliveryUndeliverableError('spend_alert_email_undeliverable');
    }
    return;
  }

  if (row.channel === 'push') {
    // A push nobody can receive cannot become deliverable by waiting.
    if (recipients.userIds.length === 0) {
      throw new SpendAlertDeliveryUndeliverableError('spend_alert_delivery_no_recipients');
    }
    const dispatched = await deps.dispatchPush({
      recipientUserIds: recipients.userIds,
      scope: scope.type,
      ...(scope.type === 'organization' ? { organizationId: scope.organizationId } : {}),
      alertKind: row.kind,
      scopeName,
      amountUsd,
      thresholdUsd,
      dedupeKey: row.dedupe_key,
    });
    // The dispatch client never rejects; its boolean is the only failure signal.
    if (!dispatched) throw new SpendAlertDeliveryRetryableError('spend_alert_push_delivery_failed');
    return;
  }

  throw new SpendAlertDeliveryUndeliverableError('spend_alert_delivery_unknown_channel');
}

/** Bounded retries of the `sent` write; never a re-send. */
const DELIVERY_MARK_ATTEMPTS = 3;

/**
 * Records a delivered row whose first `sent` write failed. The alert is already
 * out, so the row must never return to the queue for a second send: retry the
 * bookkeeping write a bounded number of times, then fall back to a terminal
 * status. Returns whether the `sent` write landed, so the drain can report the
 * bookkeeping failure without counting the row as delivered.
 */
async function recordDeliveredSpendAlertDelivery(
  database: Db,
  row: ClaimedSpendAlertDelivery
): Promise<boolean> {
  for (let attempt = 0; attempt < DELIVERY_MARK_ATTEMPTS; attempt++) {
    try {
      await markSpendAlertDeliverySent(database, row);
      return true;
    } catch {
      // Retry the mark itself; rescheduling would send the alert again.
    }
  }
  try {
    await markSpendAlertDeliveryFailed(database, row, 'spend_alert_delivery_mark_failed');
  } catch {
    // No write can record the outcome while the database rejects updates. The
    // row stays leased, and the run is reported as failed.
  }
  return false;
}

/**
 * Drains due deliveries: claims a bounded batch, sends each row, and records the
 * outcome. A transient failure is rescheduled (narrowed to the recipients this
 * attempt did not reach), a permanent one is terminal, and a delivered row whose
 * `sent` write failed has the write retried rather than the alert resent. The
 * returned summary is the alert path's own retryable-unhappy signal — a
 * rescheduled row stays in the outbox, so a later run sends it.
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
    // The batch claim's lease was stamped for the whole batch. Re-assert it for
    // this row before sending, and skip the row when another drain already owns
    // it, so an overlapping cron cannot produce a second send.
    const owned = await renewSpendAlertDeliveryClaim(database, row);
    if (!owned) continue;

    try {
      await deliverClaimedSpendAlertDelivery(database, deps, row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SpendAlertDeliveryUndeliverableError) {
        // A permanent rejection is terminal: retrying it would resend the alert
        // to everyone forever without ever reaching the failed recipient.
        await markSpendAlertDeliveryFailed(database, row, message);
        summary.failed.push({
          deliveryId: row.id,
          channel: row.channel,
          error: safeDeliveryErrorCode(message, row.channel),
        });
        continue;
      }
      if (error instanceof SpendAlertDeliveryRetryableError && error.remainingEmails) {
        // Narrow the row to the addresses this attempt did not reach and
        // reschedule it in one write, so a bookkeeping failure cannot return the
        // row to the queue with the recipients who already received the alert.
        await rescheduleRetryableSpendAlertDelivery(database, row, message, error.remainingEmails);
      } else {
        await rescheduleSpendAlertDelivery(database, row, message);
      }
      summary.failed.push({
        deliveryId: row.id,
        channel: row.channel,
        error: safeDeliveryErrorCode(message, row.channel),
      });
      continue;
    }

    // The send succeeded. Recording it is bookkeeping, not delivery: retry the
    // mark itself and, if it still fails, write a terminal status — never
    // reschedule the row, which would send the same alert a second time.
    const wasRecorded = await recordDeliveredSpendAlertDelivery(database, row);
    if (wasRecorded) {
      summary.delivered += 1;
    } else {
      summary.failed.push({
        deliveryId: row.id,
        channel: row.channel,
        error: 'spend_alert_delivery_mark_failed',
      });
    }
  }

  return summary;
}
