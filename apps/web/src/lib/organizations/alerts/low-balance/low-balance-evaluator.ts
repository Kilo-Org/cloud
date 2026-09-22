import 'server-only';

import {
  organization_alert_deliveries,
  organization_alerts,
  type OrganizationAlert,
} from '@kilocode/db/schema';
import { captureException } from '@sentry/nextjs';
import { and, eq, inArray, max } from 'drizzle-orm';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  claimAlertDeliveries,
  dispatchAlertDelivery,
  type AlertDeliveryOutcome,
} from '../alert-deliveries';
import { LOW_BALANCE_ALERT_TYPE, OrganizationAlertDefinitionSchema } from '../organization-alerts';

const CROSSING_OCCURRENCE_PREFIX = 'low_balance:crossing:v1';

/**
 * This alert has no calendar period, so its occurrence identity is minted from
 * the crossing event itself rather than resolved from a formula, at
 * millisecond precision so two genuinely separate crossings (for example a
 * top-up followed by a later re-drop) are never coalesced into one occurrence
 * even if they land close together. This is safe against double-claiming a
 * single crossing without any coarser bucketing: unlike `monthly_spending`,
 * which is evaluated by a periodic sweep that legitimately re-evaluates the
 * same period many times and relies on a shared, formula-derived occurrence id
 * to dedupe across those runs, a `low_balance` crossing is evaluated exactly
 * once, inline in the same mutation that changed the balance. The delivery
 * table's uniqueness invariant still guards the pathological case where that
 * mutation is somehow evaluated twice for the same instant.
 */
function crossingOccurrenceId(at: Date): string {
  return `${CROSSING_OCCURRENCE_PREFIX}:${at.toISOString()}`;
}

/**
 * The occurrence a `low_balance` alert is being read for right now, for
 * `organization-alerts.server.ts`'s list view. Unlike `monthly_spending` there
 * is no formula from `now` alone, so this looks up the most recent occurrence
 * this alert has ever claimed delivery for instead of computing one. Occurrence
 * IDs are fixed-width ISO instants, so `max()` is the most recent one.
 */
export async function currentLowBalanceOccurrenceIds(
  client: typeof db | DrizzleTransaction,
  alertIds: string[]
): Promise<Map<string, string>> {
  if (alertIds.length === 0) return new Map();
  const rows = await client
    .select({
      alertId: organization_alert_deliveries.alert_id,
      latestOccurrenceId: max(organization_alert_deliveries.period_occurrence_id),
    })
    .from(organization_alert_deliveries)
    .where(inArray(organization_alert_deliveries.alert_id, alertIds))
    .groupBy(organization_alert_deliveries.alert_id);
  return new Map(
    rows
      .filter((row): row is { alertId: string; latestOccurrenceId: string } =>
        Boolean(row.latestOccurrenceId)
      )
      .map(row => [row.alertId, row.latestOccurrenceId])
  );
}

export type LowBalanceEvaluationSummary = {
  evaluatedAlertCount: number;
  crossedAlertCount: number;
  claimedDeliveryCount: number;
  invalidAlertCount: number;
  dispatched: Record<AlertDeliveryOutcome, number>;
};

const EMPTY_SUMMARY: LowBalanceEvaluationSummary = {
  evaluatedAlertCount: 0,
  crossedAlertCount: 0,
  claimedDeliveryCount: 0,
  invalidAlertCount: 0,
  dispatched: { accepted: 0, ambiguous: 0, failed: 0, canceled: 0, skipped: 0 },
};

/**
 * Evaluates one organization's enabled `low_balance` alerts against a single
 * balance-changing mutation, then claims and immediately dispatches delivery
 * for every alert that crossed. Called just-in-time from the same mutation that
 * changes the balance (see `organization-usage.ts`), not from a periodic sweep:
 * a balance change has exactly one call site, unlike spend, which accumulates
 * from several, so there is no reason to wait for a scheduled evaluation.
 *
 * The crossing check is derived from `previousBalanceMicrodollars` and
 * `newBalanceMicrodollars` alone, mirroring the legacy low-balance setting's
 * own crossing check: no separate "already notified" state needs to be
 * persisted, because an alert can only cross while the balance is currently at
 * or above its threshold, which is exactly what "previous" already encodes.
 */
export async function evaluateLowBalanceAlerts(params: {
  organizationId: string;
  previousBalanceMicrodollars: number;
  newBalanceMicrodollars: number;
  now?: Date;
}): Promise<LowBalanceEvaluationSummary> {
  const { organizationId, previousBalanceMicrodollars, newBalanceMicrodollars } = params;
  // Only a decrease can cross a threshold from above to below.
  if (newBalanceMicrodollars >= previousBalanceMicrodollars) return EMPTY_SUMMARY;

  const now = params.now ?? new Date();
  const alerts = await db
    .select()
    .from(organization_alerts)
    .where(
      and(
        eq(organization_alerts.organization_id, organizationId),
        eq(organization_alerts.status, 'enabled'),
        eq(organization_alerts.type, LOW_BALANCE_ALERT_TYPE)
      )
    );
  if (alerts.length === 0) return EMPTY_SUMMARY;

  const summary: LowBalanceEvaluationSummary = {
    evaluatedAlertCount: 0,
    crossedAlertCount: 0,
    claimedDeliveryCount: 0,
    invalidAlertCount: 0,
    dispatched: { accepted: 0, ambiguous: 0, failed: 0, canceled: 0, skipped: 0 },
  };
  const claimedDeliveries: Awaited<ReturnType<typeof claimAlertDeliveries>> = [];

  for (const alert of alerts) {
    const claims = await evaluateOneLowBalanceAlert({
      alert,
      previousBalanceMicrodollars,
      newBalanceMicrodollars,
      now,
      summary,
    });
    claimedDeliveries.push(...claims);
  }

  for (const delivery of claimedDeliveries) {
    summary.dispatched[await dispatchAlertDelivery(delivery)]++;
  }

  return summary;
}

async function evaluateOneLowBalanceAlert(params: {
  alert: OrganizationAlert;
  previousBalanceMicrodollars: number;
  newBalanceMicrodollars: number;
  now: Date;
  summary: LowBalanceEvaluationSummary;
}): ReturnType<typeof claimAlertDeliveries> {
  const { alert, previousBalanceMicrodollars, newBalanceMicrodollars, now, summary } = params;
  const parsed = OrganizationAlertDefinitionSchema.safeParse({
    type: alert.type,
    configuration: alert.configuration,
  });
  if (!parsed.success || parsed.data.type !== LOW_BALANCE_ALERT_TYPE) {
    summary.invalidAlertCount++;
    captureException(parsed.success ? new Error('Alert type mismatch') : parsed.error, {
      tags: { domain: 'organization-alerts', job: 'low-balance-evaluation' },
      extra: { organizationId: alert.organization_id, alertId: alert.id },
    });
    return [];
  }

  const { thresholdMicrodollars, recipients } = parsed.data.configuration;
  summary.evaluatedAlertCount++;
  const crossed =
    previousBalanceMicrodollars >= thresholdMicrodollars &&
    newBalanceMicrodollars < thresholdMicrodollars;
  if (!crossed) return [];

  summary.crossedAlertCount++;
  const claims = await claimAlertDeliveries({
    alertId: alert.id,
    periodOccurrenceId: crossingOccurrenceId(now),
    recipients,
    configurationVersion: alert.configuration_version,
    thresholdMicrodollars,
    measuredValueMicrodollars: newBalanceMicrodollars,
  });
  summary.claimedDeliveryCount += claims.length;
  return claims;
}
