import 'server-only';

import {
  microdollar_usage,
  organization_alerts,
  organizations,
  type OrganizationAlert,
} from '@kilocode/db/schema';
import { captureException } from '@sentry/nextjs';
import { and, asc, eq, gte, isNull, lt, sql, sum } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  claimAlertDeliveries,
  dispatchAlertDelivery,
  expireAmbiguousDeliveries,
  listDeliveriesDueForDispatch,
  type AlertDeliveryOutcome,
} from '../alert-deliveries';
import {
  OrganizationAlertDefinitionSchema,
  resolveOrganizationAlertPeriodOccurrence,
  type OrganizationAlertPeriodOccurrence,
} from '../organization-alerts';

/** Bounds on one sweep, so a run cannot outgrow the platform's limits. */
const ALERT_PAGE_SIZE = 200;
const MAX_ALERT_PAGES = 25;
const MAX_DISPATCH_PER_RUN = 200;

export type MonthlySpendingEvaluationSummary = {
  evaluatedAlertCount: number;
  crossedAlertCount: number;
  claimedDeliveryCount: number;
  invalidAlertCount: number;
  failedOrganizationCount: number;
  dispatched: Record<AlertDeliveryOutcome, number>;
  ambiguousLeaseCount: number;
  hasMoreAlerts: boolean;
};

/**
 * Evaluates every enabled alert of a live Enterprise organization against that
 * organization's direct AI usage spend for the alert's own current period, then
 * claims and dispatches delivery for the alerts that have crossed.
 *
 * Alerts are read in bounded keyset pages ordered by `(organization_id, id)`, so
 * the alerts of one organization arrive together and its spend is aggregated once
 * however many alerts it has. A failure for one organization is recorded and the
 * sweep continues with the next.
 */
export async function evaluateMonthlySpendingAlerts(
  now = new Date()
): Promise<MonthlySpendingEvaluationSummary> {
  const summary: MonthlySpendingEvaluationSummary = {
    evaluatedAlertCount: 0,
    crossedAlertCount: 0,
    claimedDeliveryCount: 0,
    invalidAlertCount: 0,
    failedOrganizationCount: 0,
    dispatched: { accepted: 0, ambiguous: 0, failed: 0, canceled: 0, skipped: 0 },
    ambiguousLeaseCount: 0,
    hasMoreAlerts: false,
  };

  let cursor: { organizationId: string; id: string } | undefined;
  for (let page = 0; page < MAX_ALERT_PAGES; page++) {
    const alerts = await listEnabledAlertPage(cursor);
    if (alerts.length === 0) break;

    for (const [organizationId, group] of groupByOrganization(alerts)) {
      try {
        await evaluateOrganizationAlerts(group, now, summary);
      } catch (error) {
        summary.failedOrganizationCount++;
        captureException(error, {
          tags: { domain: 'organization-alerts', job: 'monthly-spending-evaluation' },
          extra: { organizationId },
        });
      }
    }

    const last = alerts[alerts.length - 1];
    cursor = { organizationId: last.organization_id, id: last.id };
    // A short page is the end of the scan. A full final page means the page
    // budget, not the data, ended the sweep, which the next run continues.
    if (alerts.length < ALERT_PAGE_SIZE) break;
    if (page === MAX_ALERT_PAGES - 1) summary.hasMoreAlerts = true;
  }

  summary.ambiguousLeaseCount = await expireAmbiguousDeliveries();

  for (const delivery of await listDeliveriesDueForDispatch(MAX_DISPATCH_PER_RUN)) {
    summary.dispatched[await dispatchAlertDelivery(delivery)]++;
  }

  return summary;
}

/**
 * One bounded page of enabled alerts belonging to live Enterprise organizations,
 * ordered so each organization's alerts are contiguous. Every run starts a
 * complete new scan, so alerts created or re-enabled mid-sweep are picked up by
 * the next run rather than skipped indefinitely.
 */
async function listEnabledAlertPage(cursor?: {
  organizationId: string;
  id: string;
}): Promise<OrganizationAlert[]> {
  const conditions = [
    eq(organization_alerts.status, 'enabled'),
    eq(organizations.plan, 'enterprise'),
    isNull(organizations.deleted_at),
  ];
  if (cursor) {
    const afterCursor = sql`(${organization_alerts.organization_id}, ${organization_alerts.id}) > (${cursor.organizationId}::uuid, ${cursor.id}::uuid)`;
    conditions.push(afterCursor);
  }

  const rows = await db
    .select({ alert: organization_alerts })
    .from(organization_alerts)
    .innerJoin(organizations, eq(organizations.id, organization_alerts.organization_id))
    .where(and(...conditions))
    .orderBy(asc(organization_alerts.organization_id), asc(organization_alerts.id))
    .limit(ALERT_PAGE_SIZE);

  return rows.map(row => row.alert);
}

function groupByOrganization(alerts: OrganizationAlert[]): Map<string, OrganizationAlert[]> {
  const groups = new Map<string, OrganizationAlert[]>();
  for (const alert of alerts) {
    const group = groups.get(alert.organization_id);
    if (group) group.push(alert);
    else groups.set(alert.organization_id, [alert]);
  }
  return groups;
}

/**
 * Evaluates one organization's alerts. Spend is aggregated once per distinct
 * period occurrence rather than once per alert, and each alert is compared
 * independently so two alerts with the same threshold never merge.
 */
async function evaluateOrganizationAlerts(
  alerts: OrganizationAlert[],
  now: Date,
  summary: MonthlySpendingEvaluationSummary
): Promise<void> {
  const spendByOccurrence = new Map<string, number>();

  for (const alert of alerts) {
    const parsed = OrganizationAlertDefinitionSchema.safeParse({
      type: alert.type,
      configuration: alert.configuration,
    });
    if (!parsed.success) {
      // Unsupported stored configuration is skipped and reported rather than
      // reinterpreted under a different meaning.
      summary.invalidAlertCount++;
      captureException(parsed.error, {
        tags: { domain: 'organization-alerts', job: 'monthly-spending-evaluation' },
        extra: { organizationId: alert.organization_id, alertId: alert.id },
      });
      continue;
    }

    const { thresholdMicrodollars, period, recipients } = parsed.data.configuration;
    const occurrence = resolveOrganizationAlertPeriodOccurrence(period, now);
    summary.evaluatedAlertCount++;

    let spend = spendByOccurrence.get(occurrence.occurrenceId);
    if (spend === undefined) {
      spend = await sumOrganizationSpend(alert.organization_id, occurrence);
      spendByOccurrence.set(occurrence.occurrenceId, spend);
    }
    if (spend < thresholdMicrodollars) continue;

    summary.crossedAlertCount++;
    const claims = await claimAlertDeliveries({
      alertId: alert.id,
      occurrence,
      recipients,
      configurationVersion: alert.configuration_version,
      thresholdMicrodollars,
      measuredSpendMicrodollars: spend,
    });
    summary.claimedDeliveryCount += claims.length;
  }
}

/**
 * Direct AI usage spend for one organization over the occurrence's half-open
 * interval, read from canonical usage rather than the eventually consistent daily
 * rollup. Signed corrective rows are included because they are part of what the
 * organization was charged. Consolidated parent/child spend is deliberately not
 * summed: an alert measures its own organization only.
 */
async function sumOrganizationSpend(
  organizationId: string,
  occurrence: OrganizationAlertPeriodOccurrence
): Promise<number> {
  const [row] = await db
    .select({ total: sum(microdollar_usage.cost) })
    .from(microdollar_usage)
    .where(
      and(
        eq(microdollar_usage.organization_id, organizationId),
        gte(microdollar_usage.created_at, occurrence.startInclusive.toISOString()),
        lt(microdollar_usage.created_at, occurrence.endExclusive.toISOString())
      )
    );
  return Number(row?.total ?? 0);
}
