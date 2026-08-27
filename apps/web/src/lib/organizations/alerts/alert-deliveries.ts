import 'server-only';

import { createHmac } from 'node:crypto';
import {
  organization_alert_deliveries,
  organization_alerts,
  organizations,
  type OrganizationAlertDelivery,
} from '@kilocode/db/schema';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { sendLowBalanceAlertEmail, sendMonthlySpendingAlertEmail } from '@/lib/email';
import {
  formatAlertUsd,
  formatOrganizationAlertPeriodOccurrence,
  LOW_BALANCE_ALERT_TYPE,
  MAX_ORGANIZATION_ALERT_RECIPIENTS,
  MONTHLY_SPENDING_ALERT_TYPE,
  normalizeOrganizationAlertRecipient,
  OrganizationAlertDefinitionSchema,
  resolveOrganizationAlertPeriodOccurrence,
  type OrganizationAlertPeriodOccurrence,
} from './organization-alerts';

/**
 * How long a claim may stay `submitting` before it is treated as an ambiguous
 * outcome. A worker that dies after marking `submitting` may or may not have
 * reached the provider, so the lease only bounds observability; it never
 * authorizes an automatic retry.
 */
const DELIVERY_LEASE = sql`now() + interval '5 minutes'`;

/**
 * Recipient identity in delivery rows is a keyed digest, so the delivery table
 * never stores an address and the digest cannot be recomputed from a guessed
 * email without the server key. The prefix domain-separates it from every other
 * `NEXTAUTH_SECRET` digest in the app.
 */
export function alertRecipientIdentityHmac(recipient: string): string {
  return createHmac('sha256', NEXTAUTH_SECRET)
    .update(`organization-alert-recipient:${normalizeOrganizationAlertRecipient(recipient)}`)
    .digest('hex');
}

/**
 * Durably claims delivery for each recipient of one crossed alert, before any
 * provider call.
 *
 * This is deliberately lock-free. The guarantee that matters — one recipient is
 * never emailed twice for the same alert and period — comes from the unique
 * index on delivery identity, so a concurrent evaluator's duplicate insert is
 * skipped by `ON CONFLICT` rather than prevented by serialization.
 *
 * The 10-recipient admission cap is a fanout bound rather than a safety
 * invariant, so it is enforced with a plain count instead of a lock. Recipients
 * are already capped at 10 by the configuration schema, so one sweep can never
 * exceed the bound on its own; exceeding it requires recipients to be replaced
 * mid-period while two evaluators overlap, and the only consequence is a couple
 * of extra admitted addresses for that period. Duplicate email remains
 * impossible either way.
 */
export async function claimAlertDeliveries(params: {
  alertId: string;
  periodOccurrenceId: string;
  recipients: string[];
  configurationVersion: number;
  thresholdMicrodollars: number;
  measuredValueMicrodollars: number;
}): Promise<OrganizationAlertDelivery[]> {
  const admitted = await db
    .select({ recipientIdentityHmac: organization_alert_deliveries.recipient_identity_hmac })
    .from(organization_alert_deliveries)
    .where(
      and(
        eq(organization_alert_deliveries.alert_id, params.alertId),
        eq(organization_alert_deliveries.period_occurrence_id, params.periodOccurrenceId)
      )
    );

  const admittedIdentities = new Set(admitted.map(row => row.recipientIdentityHmac));
  const capacity = MAX_ORGANIZATION_ALERT_RECIPIENTS - admittedIdentities.size;
  const newIdentities = [...new Set(params.recipients.map(alertRecipientIdentityHmac))].filter(
    identity => !admittedIdentities.has(identity)
  );
  if (capacity <= 0 || newIdentities.length === 0) return [];

  // One statement, so a partial claim cannot be left behind by a failure part
  // way through the batch.
  return await db
    .insert(organization_alert_deliveries)
    .values(
      newIdentities.slice(0, capacity).map(identity => ({
        alert_id: params.alertId,
        period_occurrence_id: params.periodOccurrenceId,
        recipient_identity_hmac: identity,
        channel: 'email' as const,
        claimed_configuration_version: params.configurationVersion,
        threshold_microdollars: params.thresholdMicrodollars,
        measured_value_microdollars: params.measuredValueMicrodollars,
      }))
    )
    .onConflictDoNothing()
    .returning();
}

/** Claims still owed a provider call, oldest first, including earlier runs. */
export async function listDeliveriesDueForDispatch(
  limit: number
): Promise<OrganizationAlertDelivery[]> {
  return await db
    .select()
    .from(organization_alert_deliveries)
    .where(
      and(
        eq(organization_alert_deliveries.status, 'pending'),
        lt(organization_alert_deliveries.next_attempt_at, sql`now()`)
      )
    )
    .orderBy(
      asc(organization_alert_deliveries.next_attempt_at),
      asc(organization_alert_deliveries.id)
    )
    .limit(limit);
}

export type AlertDeliveryOutcome = 'accepted' | 'ambiguous' | 'failed' | 'canceled' | 'skipped';

/**
 * Sends one claimed delivery, re-reading the organization and alert from the
 * primary first. Work that no longer matches the claim is canceled instead of
 * sent, and the claim is retained in every terminal case so the same delivery
 * identity can never be submitted twice.
 */
export async function dispatchAlertDelivery(
  delivery: OrganizationAlertDelivery
): Promise<AlertDeliveryOutcome> {
  const context = await loadDispatchContext(delivery);
  if (!context) {
    await cancelDelivery(delivery.id);
    return 'canceled';
  }

  // Claiming the attempt marks it `submitting` under a lease and bumps
  // `claim_version`, which fences a stale worker holding the same row: its
  // conditional update no longer matches, so it cannot submit as well.
  const [claimed] = await db
    .update(organization_alert_deliveries)
    .set({
      status: 'submitting',
      submitting_at: sql`now()`,
      lease_expires_at: DELIVERY_LEASE,
      claim_version: sql`${organization_alert_deliveries.claim_version} + 1`,
      attempt_count: sql`${organization_alert_deliveries.attempt_count} + 1`,
    })
    .where(
      and(
        eq(organization_alert_deliveries.id, delivery.id),
        eq(organization_alert_deliveries.status, 'pending'),
        eq(organization_alert_deliveries.claim_version, delivery.claim_version)
      )
    )
    .returning();
  if (!claimed) return 'skipped';

  try {
    const result =
      context.type === MONTHLY_SPENDING_ALERT_TYPE
        ? await sendMonthlySpendingAlertEmail({
            to: context.recipient,
            organizationId: context.organizationId,
            organizationName: context.organizationName,
            thresholdUsd: formatAlertUsd(delivery.threshold_microdollars),
            spendUsd: formatAlertUsd(delivery.measured_value_microdollars),
            periodLabel: formatOrganizationAlertPeriodOccurrence(context.occurrence),
          })
        : await sendLowBalanceAlertEmail({
            to: context.recipient,
            organizationId: context.organizationId,
            organizationName: context.organizationName,
            thresholdUsd: formatAlertUsd(delivery.threshold_microdollars),
            balanceUsd: formatAlertUsd(delivery.measured_value_microdollars),
          });
    if (result.sent) {
      await finishDelivery(delivery.id, { status: 'accepted' });
      return 'accepted';
    }
    // Rejected before the provider could accept it, so retrying cannot
    // duplicate an email.
    await finishDelivery(delivery.id, { status: 'pending', errorCode: result.reason });
    return 'failed';
  } catch (error) {
    // The request may have been accepted before the failure, so this outcome is
    // ambiguous and is never retried automatically.
    await finishDelivery(delivery.id, {
      status: 'ambiguous',
      errorCode: error instanceof Error ? error.name : 'unknown_error',
    });
    return 'ambiguous';
  }
}

type DispatchContext =
  | {
      type: typeof MONTHLY_SPENDING_ALERT_TYPE;
      organizationId: string;
      organizationName: string;
      recipient: string;
      occurrence: OrganizationAlertPeriodOccurrence;
    }
  | {
      type: typeof LOW_BALANCE_ALERT_TYPE;
      organizationId: string;
      organizationName: string;
      recipient: string;
    };

/**
 * Re-reads the organization and alert and confirms every fact the claim was
 * created from still holds: the organization exists and is still Enterprise and
 * the alert is still enabled with the same type, threshold, and recipient.
 * `monthly_spending` additionally requires the measured spend to still cross the
 * threshold within the same period; `low_balance` requires the organization's
 * current balance to still be below the threshold, re-read fresh so a top-up
 * between claim and dispatch cancels the send instead of emailing stale state.
 * Seat-subscription state is deliberately not required here, only Enterprise.
 */
async function loadDispatchContext(
  delivery: OrganizationAlertDelivery
): Promise<DispatchContext | undefined> {
  const [row] = await db
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      plan: organizations.plan,
      deletedAt: organizations.deleted_at,
      totalMicrodollarsAcquired: organizations.total_microdollars_acquired,
      microdollarsUsed: organizations.microdollars_used,
      type: organization_alerts.type,
      status: organization_alerts.status,
      configuration: organization_alerts.configuration,
    })
    .from(organization_alerts)
    .innerJoin(organizations, eq(organizations.id, organization_alerts.organization_id))
    .where(eq(organization_alerts.id, delivery.alert_id))
    .limit(1);

  if (!row || row.deletedAt || row.plan !== 'enterprise' || row.status !== 'enabled') return;

  const parsed = OrganizationAlertDefinitionSchema.safeParse({
    type: row.type,
    configuration: row.configuration,
  });
  if (!parsed.success) return;
  if (parsed.data.configuration.thresholdMicrodollars !== delivery.threshold_microdollars) return;

  const recipient = parsed.data.configuration.recipients.find(
    candidate => alertRecipientIdentityHmac(candidate) === delivery.recipient_identity_hmac
  );
  if (!recipient) return;

  if (parsed.data.type === MONTHLY_SPENDING_ALERT_TYPE) {
    if (delivery.measured_value_microdollars < parsed.data.configuration.thresholdMicrodollars) {
      return;
    }
    const occurrence = resolveOrganizationAlertPeriodOccurrence(
      parsed.data.configuration.period,
      new Date()
    );
    if (occurrence.occurrenceId !== delivery.period_occurrence_id) return;
    return {
      type: MONTHLY_SPENDING_ALERT_TYPE,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      recipient,
      occurrence,
    };
  }

  const currentBalance = row.totalMicrodollarsAcquired - row.microdollarsUsed;
  if (currentBalance >= parsed.data.configuration.thresholdMicrodollars) return;
  return {
    type: LOW_BALANCE_ALERT_TYPE,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    recipient,
  };
}

async function cancelDelivery(deliveryId: string): Promise<void> {
  await db
    .update(organization_alert_deliveries)
    .set({ status: 'canceled', lease_expires_at: null })
    .where(
      and(
        eq(organization_alert_deliveries.id, deliveryId),
        eq(organization_alert_deliveries.status, 'pending')
      )
    );
}

/**
 * Records a terminal or retryable outcome. `submitting_at` is deliberately left
 * in place: once a provider call has begun, that evidence is retained even when
 * the attempt is returned to `pending` for a definitive pre-submission failure.
 */
async function finishDelivery(
  deliveryId: string,
  outcome: { status: 'accepted' | 'ambiguous' | 'pending'; errorCode?: string }
): Promise<void> {
  await db
    .update(organization_alert_deliveries)
    .set({
      status: outcome.status,
      lease_expires_at: null,
      last_error_code: outcome.errorCode ?? null,
      // A definitive pre-submission failure backs off until the next sweep.
      ...(outcome.status === 'pending' ? { next_attempt_at: sql`now() + interval '1 hour'` } : {}),
    })
    .where(eq(organization_alert_deliveries.id, deliveryId));
}

/**
 * Marks leases that expired while `submitting` as ambiguous. Their outcome is
 * unknown, so they are recorded rather than retried.
 */
export async function expireAmbiguousDeliveries(): Promise<number> {
  const result = await db
    .update(organization_alert_deliveries)
    .set({ status: 'ambiguous', lease_expires_at: null })
    .where(
      and(
        eq(organization_alert_deliveries.status, 'submitting'),
        lt(organization_alert_deliveries.lease_expires_at, sql`now()`)
      )
    );
  return result.rowCount ?? 0;
}

/**
 * Retention window for delivery history. Claims are the deduplication record for
 * their own period, so the window must comfortably exceed the longest period an
 * alert can use.
 */
const DELIVERY_RETENTION_MONTHS = 13;
const MAX_PRUNE_PER_RUN = 1_000;

/** Prunes delivery history past the retention window, in a bounded batch. */
export async function pruneExpiredAlertDeliveries(): Promise<number> {
  const expired = db
    .select({ id: organization_alert_deliveries.id })
    .from(organization_alert_deliveries)
    .where(
      lt(
        organization_alert_deliveries.created_at,
        sql`now() - make_interval(months => ${DELIVERY_RETENTION_MONTHS})`
      )
    )
    .orderBy(asc(organization_alert_deliveries.created_at))
    .limit(MAX_PRUNE_PER_RUN);

  const result = await db
    .delete(organization_alert_deliveries)
    .where(inArray(organization_alert_deliveries.id, expired));
  return result.rowCount ?? 0;
}

/**
 * Cancels not-yet-submitted claims for alerts that are no longer eligible, so
 * work created before a disable, archive, or downgrade is never sent. Claims
 * already submitting are left alone: their provider outcome is unknown and the
 * lease sweep records them as ambiguous.
 */
export async function cancelPendingDeliveriesForAlerts(
  tx: DrizzleTransaction,
  alertIds: string[]
): Promise<void> {
  if (alertIds.length === 0) return;
  await tx
    .update(organization_alert_deliveries)
    .set({ status: 'canceled', lease_expires_at: null })
    .where(
      and(
        inArray(organization_alert_deliveries.alert_id, alertIds),
        eq(organization_alert_deliveries.status, 'pending')
      )
    );
}
