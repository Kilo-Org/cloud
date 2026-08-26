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
import { sendMonthlySpendingAlertEmail } from '@/lib/email';
import {
  formatAlertUsd,
  formatOrganizationAlertPeriodOccurrence,
  MAX_ORGANIZATION_ALERT_RECIPIENTS,
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
 * provider call. Concurrent evaluators are safe two ways: the per-alert-period
 * advisory lock serializes admission so the 10-recipient cap is enforced against
 * a stable count, and the delivery identity uniqueness invariant makes a second
 * claim for the same recipient a no-op even across processes.
 *
 * Recipients beyond the cap are deliberately not claimed: the period has already
 * admitted its maximum, which the editor explains rather than silently widening.
 */
export async function claimAlertDeliveries(params: {
  alertId: string;
  occurrence: OrganizationAlertPeriodOccurrence;
  recipients: string[];
  configurationVersion: number;
  thresholdMicrodollars: number;
  measuredSpendMicrodollars: number;
}): Promise<OrganizationAlertDelivery[]> {
  return await db.transaction(async tx => {
    await tx.execute(sql`
      SELECT pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          ${`organization-alert-admission:${params.alertId}:${params.occurrence.occurrenceId}`},
          0
        )
      )
    `);

    const admitted = await tx
      .select({ recipientIdentityHmac: organization_alert_deliveries.recipient_identity_hmac })
      .from(organization_alert_deliveries)
      .where(
        and(
          eq(organization_alert_deliveries.alert_id, params.alertId),
          eq(organization_alert_deliveries.period_occurrence_id, params.occurrence.occurrenceId)
        )
      );

    const admittedIdentities = new Set(admitted.map(row => row.recipientIdentityHmac));
    const capacity = MAX_ORGANIZATION_ALERT_RECIPIENTS - admittedIdentities.size;
    const newIdentities = [...new Set(params.recipients.map(alertRecipientIdentityHmac))].filter(
      identity => !admittedIdentities.has(identity)
    );
    if (capacity <= 0 || newIdentities.length === 0) return [];

    return await tx
      .insert(organization_alert_deliveries)
      .values(
        newIdentities.slice(0, capacity).map(identity => ({
          alert_id: params.alertId,
          period_occurrence_id: params.occurrence.occurrenceId,
          recipient_identity_hmac: identity,
          channel: 'email' as const,
          claimed_configuration_version: params.configurationVersion,
          threshold_microdollars: params.thresholdMicrodollars,
          measured_spend_microdollars: params.measuredSpendMicrodollars,
        }))
      )
      .onConflictDoNothing()
      .returning();
  });
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
    const result = await sendMonthlySpendingAlertEmail({
      to: context.recipient,
      organizationId: context.organizationId,
      organizationName: context.organizationName,
      thresholdUsd: formatAlertUsd(delivery.threshold_microdollars),
      spendUsd: formatAlertUsd(delivery.measured_spend_microdollars),
      periodLabel: formatOrganizationAlertPeriodOccurrence(context.occurrence),
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

type DispatchContext = {
  organizationId: string;
  organizationName: string;
  recipient: string;
  occurrence: OrganizationAlertPeriodOccurrence;
};

/**
 * Re-reads the organization and alert and confirms every fact the claim was
 * created from still holds: the organization exists and is still Enterprise, the
 * alert is still enabled with the same type, threshold and period, the measured
 * spend still crosses the threshold, and the recipient is still configured.
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

  const { thresholdMicrodollars, period, recipients } = parsed.data.configuration;
  if (thresholdMicrodollars !== delivery.threshold_microdollars) return;
  if (delivery.measured_spend_microdollars < thresholdMicrodollars) return;

  const occurrence = resolveOrganizationAlertPeriodOccurrence(period, new Date());
  if (occurrence.occurrenceId !== delivery.period_occurrence_id) return;

  const recipient = recipients.find(
    candidate => alertRecipientIdentityHmac(candidate) === delivery.recipient_identity_hmac
  );
  if (!recipient) return;

  return {
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    recipient,
    occurrence,
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
