import 'server-only';

import {
  organization_alert_deliveries,
  organization_alerts,
  organization_groups,
  type MonthlySpendingAlertScope,
  type OrganizationAlert,
  type OrganizationAlertStatus,
} from '@kilocode/db/schema';
import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import { and, count, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import * as z from 'zod';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import type { AuditLogAction } from '@/lib/organizations/organization-audit-logs';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import { cancelPendingDeliveriesForAlerts } from './alert-deliveries';
import { currentLowBalanceOccurrenceIds } from './low-balance/low-balance-evaluator';
import {
  EnabledOrganizationAlertDefinitionSchema,
  LOW_BALANCE_ALERT_TYPE,
  MONTHLY_SPENDING_ALERT_TYPE,
  OrganizationAlertDefinitionSchema,
  RECIPIENT_DISCLOSURE_REQUIRED_MESSAGE,
  resolveOrganizationAlertPeriodOccurrence,
  type OrganizationAlertDefinition,
} from './organization-alerts';

type AlertClient = typeof db | DrizzleTransaction;

export type OrganizationAlertActor = { id: string; email: string; name: string };

/**
 * One alert as the Alerts surface reads it. Recipient addresses are part of the
 * configuration and are only ever returned to callers the alert router has
 * authorized for organization billing.
 *
 * Intersected with `OrganizationAlertDefinition` (rather than declaring its own
 * separate `type`/`configuration` fields) so `type` keeps discriminating
 * `configuration` for every consumer, the same as everywhere else in this
 * feature: switching on `view.type` narrows `view.configuration` without a
 * cast.
 */
export type OrganizationAlertView = OrganizationAlertDefinition & {
  id: string;
  organizationId: string;
  status: OrganizationAlertStatus;
  configurationVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Occurrence of this alert's period that contains the read time. */
  periodOccurrenceId: string;
  /**
   * Distinct recipients already admitted to delivery for `periodOccurrenceId`,
   * including addresses since removed. The editor compares it with
   * `MAX_ORGANIZATION_ALERT_RECIPIENTS` to explain that a newly added address
   * cannot receive this alert until the next period once the cap is reached; it
   * never blocks the edit itself. It is a report, not an enforcement point:
   * admission is enforced by the delivery claim's uniqueness invariant and the
   * counting done inside the claim-insert transaction.
   */
  admittedRecipientCount: number;
  /**
   * The current name of the group a `monthly_spending` alert's `scope`
   * references, resolved fresh on every read since a group can be renamed.
   * `null` for an organization-wide alert, and for a group-scoped alert whose
   * group has been deleted (the alert keeps its stored `groupId`; the
   * evaluator treats a missing group as invalid rather than as zero spend).
   */
  groupName: string | null;
};

export type OrganizationAlertPage = {
  alerts: OrganizationAlertView[];
  nextCursor: string | null;
};

const DEFAULT_ORGANIZATION_ALERT_PAGE_SIZE = 20;
export const MAX_ORGANIZATION_ALERT_PAGE_SIZE = 50;

/** Lifecycle states in the default list: archived alerts are hidden. */
const UNARCHIVED_ALERT_STATUSES = [
  'enabled',
  'disabled',
] as const satisfies readonly OrganizationAlertStatus[];

/**
 * Validates a persisted alert row against the type's schema. Invalid stored
 * configuration is a server-side defect, not a client error, so it is reported
 * rather than silently reinterpreted.
 */
function parseStoredAlert(alert: OrganizationAlert): OrganizationAlertDefinition {
  const parsed = OrganizationAlertDefinitionSchema.safeParse({
    type: alert.type,
    configuration: alert.configuration,
  });
  if (!parsed.success) {
    captureException(parsed.error, {
      tags: { domain: 'organization-alerts' },
      extra: { organizationId: alert.organization_id, alertId: alert.id },
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Organization alert configuration is invalid',
    });
  }
  return parsed.data;
}

/** Validates a definition for the lifecycle state it is being saved into. */
function parseAlertDefinition(
  definition: OrganizationAlertDefinition,
  enabled: boolean
): OrganizationAlertDefinition {
  const schema = enabled
    ? EnabledOrganizationAlertDefinitionSchema
    : OrganizationAlertDefinitionSchema;
  const parsed = schema.safeParse(definition);
  if (!parsed.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: parsed.error.issues[0]?.message ?? 'Alert configuration is invalid',
    });
  }
  return parsed.data;
}

/**
 * Sentinel occurrence for a `low_balance` alert that has never claimed a
 * delivery. It matches no real delivery row, so it always reports zero admitted
 * recipients, which is the correct count for an alert that has never crossed.
 */
const NO_LOW_BALANCE_OCCURRENCE_YET = 'low_balance:crossing:v1:none';

/**
 * Resolves the occurrence identity each alert is being read for, so
 * `admittedRecipientCounts` can scope its count the same way a claim would.
 * `monthly_spending` resolves this from `now` alone, the same as a claim
 * always will. `low_balance` has no such formula: its occurrence is minted only
 * when a crossing is detected (see `low-balance-evaluator.ts`), so reading it
 * back means looking up the most recent one instead of computing it.
 */
async function currentOccurrenceIds(
  client: AlertClient,
  alerts: OrganizationAlert[],
  definitions: OrganizationAlertDefinition[],
  now: Date
): Promise<string[]> {
  const lowBalanceAlertIds = alerts
    .filter((_, index) => definitions[index].type === LOW_BALANCE_ALERT_TYPE)
    .map(alert => alert.id);
  const lowBalanceOccurrenceIds = await currentLowBalanceOccurrenceIds(client, lowBalanceAlertIds);
  return alerts.map((alert, index) => {
    const definition = definitions[index];
    if (definition.type === MONTHLY_SPENDING_ALERT_TYPE) {
      return resolveOrganizationAlertPeriodOccurrence(definition.configuration.period, now)
        .occurrenceId;
    }
    return lowBalanceOccurrenceIds.get(alert.id) ?? NO_LOW_BALANCE_OCCURRENCE_YET;
  });
}

/**
 * Current names of every group a `monthly_spending` alert's `scope`
 * references, in one query. Omitted from the result when the group no longer
 * exists, so the caller can distinguish "no such group" from "named an empty
 * string".
 */
async function currentGroupNames(
  client: AlertClient,
  definitions: OrganizationAlertDefinition[]
): Promise<Map<string, string>> {
  const groupIds = [
    ...new Set(
      definitions
        .filter(definition => definition.type === MONTHLY_SPENDING_ALERT_TYPE)
        .map(definition => definition.configuration.scope)
        .filter(scope => scope.type === 'group')
        .map(scope => scope.groupId)
    ),
  ];
  if (groupIds.length === 0) return new Map();
  const rows = await client
    .select({ id: organization_groups.id, name: organization_groups.name })
    .from(organization_groups)
    .where(inArray(organization_groups.id, groupIds));
  return new Map(rows.map(row => [row.id, row.name]));
}

/**
 * Reads a batch of alerts as the Alerts surface sees them, resolving each
 * alert's own period occurrence and its admitted recipient count. Reads and
 * writes share this so a mutation result is shaped exactly like a list row.
 */
async function toAlertViews(
  client: AlertClient,
  alerts: OrganizationAlert[]
): Promise<OrganizationAlertView[]> {
  const now = new Date();
  const definitions = alerts.map(alert => parseStoredAlert(alert));
  const occurrenceIds = await currentOccurrenceIds(client, alerts, definitions, now);
  const admitted = await admittedRecipientCounts(client, alerts, occurrenceIds);
  const groupNames = await currentGroupNames(client, definitions);
  return alerts.map((alert, index) => {
    const definition = definitions[index];
    const groupName =
      definition.type === MONTHLY_SPENDING_ALERT_TYPE &&
      definition.configuration.scope.type === 'group'
        ? (groupNames.get(definition.configuration.scope.groupId) ?? null)
        : null;
    return {
      // Spread of a validated `OrganizationAlertDefinition` rather than the raw
      // row's independently-typed `type`/`configuration`, so `type` keeps
      // discriminating `configuration` on the returned view.
      ...definition,
      id: alert.id,
      organizationId: alert.organization_id,
      status: alert.status,
      configurationVersion: alert.configuration_version,
      createdAt: alert.created_at,
      updatedAt: alert.updated_at,
      archivedAt: alert.archived_at,
      periodOccurrenceId: occurrenceIds[index],
      admittedRecipientCount: admitted.get(alert.id) ?? 0,
      groupName,
    };
  });
}

async function toAlertView(
  client: AlertClient,
  alert: OrganizationAlert
): Promise<OrganizationAlertView> {
  const [view] = await toAlertViews(client, [alert]);
  return view;
}

/**
 * Admitted recipient counts for a batch of alerts in one grouped query, scoped
 * to the period occurrence each alert is being read for so accumulated
 * prior-period claims are never scanned or counted.
 */
async function admittedRecipientCounts(
  client: AlertClient,
  alerts: OrganizationAlert[],
  occurrenceIds: string[]
): Promise<Map<string, number>> {
  if (alerts.length === 0) return new Map();
  const rows = await client
    .select({
      alertId: organization_alert_deliveries.alert_id,
      periodOccurrenceId: organization_alert_deliveries.period_occurrence_id,
      value: count(),
    })
    .from(organization_alert_deliveries)
    .where(
      and(
        inArray(
          organization_alert_deliveries.alert_id,
          alerts.map(alert => alert.id)
        ),
        inArray(organization_alert_deliveries.period_occurrence_id, [...new Set(occurrenceIds)])
      )
    )
    .groupBy(
      organization_alert_deliveries.alert_id,
      organization_alert_deliveries.period_occurrence_id
    );

  // Alert IDs are UUIDs and occurrence identities contain no NUL, so this join
  // is collision-free.
  const key = (alertId: string, occurrenceId: string) => `${alertId}\0${occurrenceId}`;
  const byAlertPeriod = new Map(
    rows.map(row => [key(row.alertId, row.periodOccurrenceId), row.value])
  );
  return new Map(
    alerts.map((alert, index) => [
      alert.id,
      byAlertPeriod.get(key(alert.id, occurrenceIds[index])) ?? 0,
    ])
  );
}

const ALERT_CURSOR_SEPARATOR = '|';
const AlertCursorIdSchema = z.uuid();

// Keyset cursor for the alert list, which orders by `created_at` desc with `id`
// desc as the deterministic tie-breaker. The raw timestamptz text is carried
// verbatim because the cursor is only ever compared against the column;
// normalizing it would truncate microseconds and skip rows.
function encodeAlertCursor(alert: OrganizationAlert): string {
  return `${alert.created_at}${ALERT_CURSOR_SEPARATOR}${alert.id}`;
}

function decodeAlertCursor(cursor: string): { createdAt: string; id: string } {
  const separatorIndex = cursor.indexOf(ALERT_CURSOR_SEPARATOR);
  const createdAt = separatorIndex > 0 ? cursor.slice(0, separatorIndex) : '';
  const id = cursor.slice(separatorIndex + 1);
  // The ID is validated as a UUID because it is compared against a `uuid`
  // column: a tampered cursor must be a recoverable client error, not a
  // PostgreSQL cast failure. Restarting pagination without a cursor is always
  // safe because listing mutates nothing.
  const usable =
    Boolean(createdAt) &&
    !Number.isNaN(new Date(createdAt).getTime()) &&
    AlertCursorIdSchema.safeParse(id).success;
  if (!usable) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid organization alert cursor.' });
  }
  return { createdAt, id };
}

/**
 * One bounded page of an organization's alerts, newest first. There is no
 * product limit on alert count, so this is the only way to read the collection.
 */
export async function listOrganizationAlerts(params: {
  organizationId: string;
  limit?: number;
  cursor?: string;
  includeArchived?: boolean;
}): Promise<OrganizationAlertPage> {
  // Clamped at both ends so a caller bypassing the router's input schema still
  // gets a page that can carry a cursor.
  const limit = Math.min(
    Math.max(params.limit ?? DEFAULT_ORGANIZATION_ALERT_PAGE_SIZE, 1),
    MAX_ORGANIZATION_ALERT_PAGE_SIZE
  );
  const conditions = [eq(organization_alerts.organization_id, params.organizationId)];
  if (!params.includeArchived) {
    conditions.push(inArray(organization_alerts.status, [...UNARCHIVED_ALERT_STATUSES]));
  }
  if (params.cursor) {
    const cursor = decodeAlertCursor(params.cursor);
    const afterCursor = or(
      lt(organization_alerts.created_at, cursor.createdAt),
      and(
        eq(organization_alerts.created_at, cursor.createdAt),
        lt(organization_alerts.id, cursor.id)
      )
    );
    if (afterCursor) conditions.push(afterCursor);
  }

  const rows = await db
    .select()
    .from(organization_alerts)
    .where(and(...conditions))
    .orderBy(desc(organization_alerts.created_at), desc(organization_alerts.id))
    .limit(limit + 1);

  // `limit` is at least 1, so a full page always has a last row to encode.
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    alerts: await toAlertViews(db, page),
    nextCursor: hasMore ? encodeAlertCursor(page[page.length - 1]) : null,
  };
}

/**
 * Creating an alert, enabling one, adding a recipient, or changing threshold or
 * period requires an Enterprise organization with the effective
 * subscription/trial eligibility other billing mutations require. Disabling,
 * archiving, and removing recipients deliberately skip this check so losing
 * entitlement cannot trap a disclosure configuration.
 */
async function requireOrganizationAlertEntitlement(organizationId: string): Promise<void> {
  const organization = await getOrganizationById(organizationId);
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  if (organization.plan !== 'enterprise') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Organization alerts are available to Enterprise organizations.',
    });
  }
  await requireActiveSubscriptionOrTrial(organizationId);
}

function requireDisclosureConfirmation(confirmed: boolean): void {
  if (!confirmed) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: RECIPIENT_DISCLOSURE_REQUIRED_MESSAGE });
  }
}

async function loadAlert(
  client: AlertClient,
  organizationId: string,
  alertId: string,
  forUpdate = false
): Promise<OrganizationAlert> {
  // Scoped by organization even though the ID is globally unique, so an
  // authorized caller can never reach another organization's alert.
  const query = client
    .select()
    .from(organization_alerts)
    .where(
      and(
        eq(organization_alerts.organization_id, organizationId),
        eq(organization_alerts.id, alertId)
      )
    )
    .limit(1);
  const [alert] = await (forUpdate ? query.for('update') : query);
  if (!alert) throw new TRPCError({ code: 'NOT_FOUND', message: 'Alert not found' });
  return alert;
}

/** Archived is terminal: the alert can neither be edited nor re-enabled. */
function assertNotArchived(alert: OrganizationAlert): void {
  if (alert.status === 'archived') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This alert is archived. Create a new alert instead.',
    });
  }
}

function assertExpectedConfigurationVersion(
  alert: OrganizationAlert,
  expectedConfigurationVersion: number
): void {
  if (alert.configuration_version !== expectedConfigurationVersion) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This alert was changed by someone else. Reload it and try again.',
    });
  }
}

type AlertConfigurationChange = {
  changed: ('threshold' | 'period' | 'scope' | 'recipients')[];
  addedRecipientCount: number;
  recipientCount: number;
  previousRecipientCount: number;
};

/** Structural equality for a scope discriminated union of plain values. */
function scopeChanged(
  previous: MonthlySpendingAlertScope,
  next: MonthlySpendingAlertScope
): boolean {
  if (previous.type !== next.type) return true;
  return previous.type === 'group' && next.type === 'group' && previous.groupId !== next.groupId;
}

function describeConfigurationChange(
  previous: OrganizationAlertDefinition,
  next: OrganizationAlertDefinition
): AlertConfigurationChange {
  const previousRecipients = new Set(previous.configuration.recipients);
  const recipients = next.configuration.recipients;
  const addedRecipients = recipients.filter(recipient => !previousRecipients.has(recipient));
  const changed: AlertConfigurationChange['changed'] = [];
  if (previous.configuration.thresholdMicrodollars !== next.configuration.thresholdMicrodollars) {
    changed.push('threshold');
  }
  // `period` and `scope` only exist on `monthly_spending`. The caller already
  // rejects a changed type before this runs, so `previous.type === next.type`
  // always holds; the check below is what lets TypeScript narrow both sides.
  if (previous.type === MONTHLY_SPENDING_ALERT_TYPE && next.type === MONTHLY_SPENDING_ALERT_TYPE) {
    if (
      previous.configuration.period.type !== next.configuration.period.type ||
      previous.configuration.period.version !== next.configuration.period.version
    ) {
      changed.push('period');
    }
    if (scopeChanged(previous.configuration.scope, next.configuration.scope)) {
      changed.push('scope');
    }
  }
  if (addedRecipients.length > 0 || recipients.length !== previousRecipients.size) {
    changed.push('recipients');
  }
  return {
    changed,
    addedRecipientCount: addedRecipients.length,
    recipientCount: recipients.length,
    previousRecipientCount: previousRecipients.size,
  };
}

/**
 * Audit messages identify the alert and the material change and carry recipient
 * counts and disclosure confirmation. They never carry recipient addresses.
 */
async function recordAlertAudit(params: {
  tx: DrizzleTransaction;
  action: AuditLogAction;
  actor: OrganizationAlertActor;
  alert: OrganizationAlert;
  summary: string;
}): Promise<void> {
  await createAuditLog({
    action: params.action,
    actor_id: params.actor.id,
    actor_email: params.actor.email,
    actor_name: params.actor.name,
    organization_id: params.alert.organization_id,
    message: `${params.alert.type} alert ${params.alert.id} v${params.alert.configuration_version}: ${params.summary}`,
    tx: params.tx,
  });
}

function recipientSummary(recipients: number): string {
  return `${recipients} recipient${recipients === 1 ? '' : 's'}`;
}

export async function createOrganizationAlert(params: {
  organizationId: string;
  actor: OrganizationAlertActor;
  definition: OrganizationAlertDefinition;
  enabled: boolean;
  recipientDisclosureConfirmed: boolean;
}): Promise<OrganizationAlertView> {
  // Saving a new alert always configures a disclosure, so it always needs both
  // confirmation and the entitlement.
  requireDisclosureConfirmation(params.recipientDisclosureConfirmed);
  const definition = parseAlertDefinition(params.definition, params.enabled);
  await requireOrganizationAlertEntitlement(params.organizationId);

  return await db.transaction(async tx => {
    const [alert] = await tx
      .insert(organization_alerts)
      .values({
        organization_id: params.organizationId,
        type: definition.type,
        status: params.enabled ? 'enabled' : 'disabled',
        configuration: definition.configuration,
      })
      .returning();
    await recordAlertAudit({
      tx,
      action: 'organization.alert.create',
      actor: params.actor,
      alert,
      summary: `created ${alert.status} with ${recipientSummary(definition.configuration.recipients.length)}, disclosure confirmed`,
    });
    return await toAlertView(tx, alert);
  });
}

export async function updateOrganizationAlert(params: {
  organizationId: string;
  alertId: string;
  actor: OrganizationAlertActor;
  definition: OrganizationAlertDefinition;
  expectedConfigurationVersion: number;
  recipientDisclosureConfirmed: boolean;
}): Promise<OrganizationAlertView> {
  // Entitlement depends on what the edit changes, so the stored configuration is
  // read first. The transaction below re-reads it under the expected version, so
  // a concurrent edit produces a conflict rather than an unentitled write.
  const current = await loadAlert(db, params.organizationId, params.alertId);
  assertNotArchived(current);
  if (params.definition.type !== current.type) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'An alert type cannot be changed. Create a new alert instead.',
    });
  }
  const definition = parseAlertDefinition(params.definition, current.status === 'enabled');
  const change = describeConfigurationChange(parseStoredAlert(current), definition);
  if (change.addedRecipientCount > 0) {
    requireDisclosureConfirmation(params.recipientDisclosureConfirmed);
  }
  // Adding an address, or changing threshold, period, or scope, is gated.
  // Removing addresses is not, so losing entitlement cannot trap a
  // disclosure. A threshold reduction is gated too: the spec gates any
  // threshold, period, or scope change, not only ones that widen the
  // disclosure.
  const requiresEntitlement =
    change.addedRecipientCount > 0 ||
    change.changed.includes('threshold') ||
    change.changed.includes('period') ||
    change.changed.includes('scope');
  if (requiresEntitlement) {
    await requireOrganizationAlertEntitlement(params.organizationId);
  }

  return await db.transaction(async tx => {
    // Re-read under a row lock. Every material change increments the version, so
    // an unchanged version means `change` above still describes this row exactly
    // and a concurrent edit becomes a conflict rather than an unentitled write.
    const alert = await loadAlert(tx, params.organizationId, params.alertId, true);
    assertNotArchived(alert);
    assertExpectedConfigurationVersion(alert, params.expectedConfigurationVersion);
    // No material change: keep the version and write no audit row, so a retried
    // save is idempotent.
    if (change.changed.length === 0) {
      return await toAlertView(tx, alert);
    }

    const [updated] = await tx
      .update(organization_alerts)
      .set({
        configuration: definition.configuration,
        configuration_version: sql`${organization_alerts.configuration_version} + 1`,
      })
      .where(eq(organization_alerts.id, alert.id))
      .returning();
    await recordAlertAudit({
      tx,
      action: 'organization.alert.update',
      actor: params.actor,
      alert: updated,
      summary: `changed ${change.changed.join(', ')}; ${recipientSummary(change.previousRecipientCount)} -> ${recipientSummary(change.recipientCount)}, ${change.addedRecipientCount} added, disclosure ${params.recipientDisclosureConfirmed ? 'confirmed' : 'not required'}`,
    });
    return await toAlertView(tx, updated);
  });
}

export async function setOrganizationAlertEnabled(params: {
  organizationId: string;
  alertId: string;
  actor: OrganizationAlertActor;
  enabled: boolean;
  expectedConfigurationVersion: number;
}): Promise<OrganizationAlertView> {
  const current = await loadAlert(db, params.organizationId, params.alertId);
  assertNotArchived(current);
  if (params.enabled && current.status !== 'enabled') {
    // An enabled alert must be able to notify someone, and enabling is an
    // expansion of the disclosure configuration.
    parseAlertDefinition(parseStoredAlert(current), true);
    await requireOrganizationAlertEntitlement(params.organizationId);
  }

  return await db.transaction(async tx => {
    const alert = await loadAlert(tx, params.organizationId, params.alertId, true);
    assertNotArchived(alert);
    assertExpectedConfigurationVersion(alert, params.expectedConfigurationVersion);
    const status: OrganizationAlertStatus = params.enabled ? 'enabled' : 'disabled';
    if (alert.status === status) {
      return await toAlertView(tx, alert);
    }

    const [updated] = await tx
      .update(organization_alerts)
      .set({
        status,
        configuration_version: sql`${organization_alerts.configuration_version} + 1`,
      })
      .where(eq(organization_alerts.id, alert.id))
      .returning();
    // Work claimed by an earlier sweep is dropped in the same transaction, so a
    // disable takes effect immediately instead of relying on dispatch to
    // re-read the alert and cancel it later.
    if (!params.enabled) await cancelPendingDeliveriesForAlerts(tx, [alert.id]);
    await recordAlertAudit({
      tx,
      action: params.enabled ? 'organization.alert.enable' : 'organization.alert.disable',
      actor: params.actor,
      alert: updated,
      summary: `${status} with ${recipientSummary(updated.configuration.recipients.length)} retained`,
    });
    return await toAlertView(tx, updated);
  });
}

/**
 * Archive is terminal and idempotent, and is deliberately not gated on
 * entitlement or an expected configuration version: it always ends evaluation
 * and a stale version cannot change that outcome.
 */
export async function archiveOrganizationAlert(params: {
  organizationId: string;
  alertId: string;
  actor: OrganizationAlertActor;
}): Promise<OrganizationAlertView> {
  return await db.transaction(async tx => {
    const alert = await loadAlert(tx, params.organizationId, params.alertId, true);
    if (alert.status === 'archived') {
      return await toAlertView(tx, alert);
    }

    const [archived] = await tx
      .update(organization_alerts)
      .set({
        status: 'archived',
        archived_at: sql`now()`,
        configuration_version: sql`${organization_alerts.configuration_version} + 1`,
      })
      .where(eq(organization_alerts.id, alert.id))
      .returning();
    await cancelPendingDeliveriesForAlerts(tx, [alert.id]);
    await recordAlertAudit({
      tx,
      action: 'organization.alert.archive',
      actor: params.actor,
      alert: archived,
      summary: `archived from ${alert.status} with ${recipientSummary(archived.configuration.recipients.length)} retained`,
    });
    return await toAlertView(tx, archived);
  });
}
