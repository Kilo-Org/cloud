/**
 * Audit and backfill KiloClaw subscription drift.
 *
 * Usage:
 *   pnpm script db kiloclaw-subscription-alignment
 *   pnpm script db kiloclaw-subscription-alignment audit
 *   pnpm script db kiloclaw-subscription-alignment repair-detached
 *   pnpm script db kiloclaw-subscription-alignment preview-missing-personal
 *   pnpm script db kiloclaw-subscription-alignment apply-missing-personal
 *   pnpm script db kiloclaw-subscription-alignment preview-duplicates
 *   pnpm script db kiloclaw-subscription-alignment apply-duplicates
 *   pnpm script db kiloclaw-subscription-alignment preview-org
 *   pnpm script db kiloclaw-subscription-alignment apply-org
 *   pnpm script db kiloclaw-subscription-alignment preview-changelog-baseline
 *   pnpm script db kiloclaw-subscription-alignment apply-changelog-baseline
 */

import { and, desc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';

import { TRIAL_DURATION_DAYS } from '@/lib/constants';
import { KILOCLAW_EARLYBIRD_EXPIRY_DATE } from '@/lib/kiloclaw/constants';
import { db } from '@/lib/drizzle';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import {
  kiloclaw_earlybird_purchases,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
  organizations,
  organization_seats_purchases,
  type KiloClawSubscription,
  type Organization,
  type OrganizationSeatsPurchase,
} from '@kilocode/db/schema';

type Mode =
  | 'audit'
  | 'repair-detached'
  | 'preview-missing-personal'
  | 'apply-missing-personal'
  | 'preview-duplicates'
  | 'apply-duplicates'
  | 'preview-org'
  | 'apply-org'
  | 'preview-changelog-baseline'
  | 'apply-changelog-baseline';

type PersonalInstanceWithoutRow = {
  instanceId: string;
  userId: string;
  sandboxId: string;
  createdAt: string;
  destroyedAt: string | null;
};

type OrgInstanceWithoutRow = {
  instanceId: string;
  userId: string;
  organizationId: string | null;
  instanceCreatedAt: string;
  organizationCreatedAt: string;
  freeTrialEndAt: string | null;
  requireSeats: boolean;
  settings: Organization['settings'];
  destroyedAt: string | null;
};

type DetachedSubscriptionAuditRow = {
  subscriptionId: string;
  userId: string;
  status: string;
  plan: string;
  suspendedAt: string | null;
  trialEndsAt: string | null;
  createdAt: string;
  detachedRowCount: number;
  activePersonalInstanceCount: number;
  linkedPersonalSubscriptionCount: number;
  targetInstanceId: string | null;
};

type MissingPersonalBackfillAction =
  | 'adopt_detached_access_row'
  | 'reassign_destroyed_access_row'
  | 'bootstrap_trial_row'
  | 'backfill_earlybird_row'
  | 'manual_review';

type MissingPersonalCandidate = {
  action: MissingPersonalBackfillAction;
  instanceId: string;
  userId: string;
  sandboxId: string;
  instanceCreatedAt: string;
  instanceDestroyedAt: string | null;
  earlybirdPurchaseCreatedAt: string | null;
  hasEarlybird: boolean;
  totalSubscriptionCount: number;
  detachedTotalCount: number;
  detachedAccessCount: number;
  linkedPersonalTotalCount: number;
  linkedDestroyedTotalCount: number;
  linkedDestroyedAccessCount: number;
  targetSubscriptionId: string | null;
};

type OrgBackfillAction =
  | 'backfill_active_standard_credits'
  | 'backfill_trial'
  | 'backfill_destroyed_standard_credits'
  | 'backfill_destroyed_trial';

type OrgBackfillCandidate = {
  action: OrgBackfillAction;
  instanceId: string;
  userId: string;
  organizationId: string;
  instanceCreatedAt: string;
  organizationCreatedAt: string;
  freeTrialEndAt: string | null;
  requireSeats: boolean;
  latestPurchaseStatus: OrganizationSeatsPurchase['subscription_status'] | null;
  destroyedAt: string | null;
};

type ActiveInstanceContextRow = {
  instanceId: string;
  userId: string;
  organizationId: string | null;
  sandboxId: string;
  createdAt: string;
};

type DuplicateActiveInstanceAction =
  | 'backfill_destroy_duplicate_personal'
  | 'backfill_destroy_duplicate_org'
  | 'reassign_to_canonical_and_destroy_duplicate'
  | 'manual_review';

type DuplicateActiveInstanceCandidate = {
  action: DuplicateActiveInstanceAction;
  contextType: 'personal' | 'organization';
  userId: string;
  organizationId: string | null;
  canonicalInstanceId: string;
  canonicalCreatedAt: string;
  duplicateInstanceId: string;
  duplicateSandboxId: string;
  duplicateCreatedAt: string;
  canonicalSubscriptionCount: number;
  duplicateSubscriptionCount: number;
  targetSubscriptionId: string | null;
  organizationCreatedAt: string | null;
  freeTrialEndAt: string | null;
  requireSeats: boolean | null;
  organizationSettings: Organization['settings'] | null;
  latestPurchaseStatus: OrganizationSeatsPurchase['subscription_status'] | null;
};

type MissingChangelogBaselineRow = KiloClawSubscription;

const ALIGNMENT_SCRIPT_ACTOR = {
  actorType: 'system',
  actorId: 'kiloclaw-subscription-alignment',
} as const;

function isAccessGrantingSubscription(
  row: Pick<KiloClawSubscription, 'status' | 'suspended_at' | 'trial_ends_at'>,
  now: Date
): boolean {
  if (row.status === 'active') return true;
  if (row.status === 'past_due' && !row.suspended_at) return true;
  if (row.status === 'trialing' && row.trial_ends_at) {
    return new Date(row.trial_ends_at).getTime() > now.getTime();
  }
  return false;
}

function isAccessGrantingRow(row: DetachedSubscriptionAuditRow, now: Date): boolean {
  if (row.status === 'active') return true;
  if (row.status === 'past_due' && !row.suspendedAt) return true;
  if (row.status === 'trialing' && row.trialEndsAt) {
    return new Date(row.trialEndsAt).getTime() > now.getTime();
  }
  return false;
}

function getTrialEndsAt(startedAt: string): string {
  return new Date(
    new Date(startedAt).getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
}

function getEarlybirdEndsAt(): string {
  return new Date(KILOCLAW_EARLYBIRD_EXPIRY_DATE).toISOString();
}

function getOrganizationManagedActiveAccess(params: {
  organization: Pick<Organization, 'require_seats' | 'settings'>;
  latestPurchase: Pick<OrganizationSeatsPurchase, 'subscription_status'> | null;
}): boolean {
  return (
    params.latestPurchase?.subscription_status === 'active' ||
    !params.organization.require_seats ||
    params.organization.settings.oss_sponsorship_tier != null ||
    !!params.organization.settings.suppress_trial_messaging
  );
}

function printSection<T>(label: string, rows: T[]) {
  console.log(`\n${label}: ${rows.length}`);
  if (rows.length === 0) return;
  console.table(rows.slice(0, 25));
  if (rows.length > 25) {
    console.log(`... truncated ${rows.length - 25} more row(s)`);
  }
}

async function insertAlignmentChangeLog(params: {
  subscriptionId: string;
  action: 'backfilled' | 'reassigned';
  reason: string;
  before: KiloClawSubscription | null;
  after: KiloClawSubscription | null;
}) {
  if (!params.after) {
    return;
  }

  try {
    await insertKiloClawSubscriptionChangeLog(db, {
      subscriptionId: params.subscriptionId,
      actor: ALIGNMENT_SCRIPT_ACTOR,
      action: params.action,
      reason: params.reason,
      before: params.before,
      after: params.after,
    });
  } catch (error) {
    console.error('Failed to write alignment change log', {
      subscriptionId: params.subscriptionId,
      action: params.action,
      reason: params.reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function listPersonalInstancesWithoutRows(): Promise<PersonalInstanceWithoutRow[]> {
  return await db
    .select({
      instanceId: kiloclaw_instances.id,
      userId: kiloclaw_instances.user_id,
      sandboxId: kiloclaw_instances.sandbox_id,
      createdAt: kiloclaw_instances.created_at,
      destroyedAt: kiloclaw_instances.destroyed_at,
    })
    .from(kiloclaw_instances)
    .leftJoin(kiloclaw_subscriptions, eq(kiloclaw_subscriptions.instance_id, kiloclaw_instances.id))
    .where(and(isNull(kiloclaw_instances.organization_id), isNull(kiloclaw_subscriptions.id)))
    .orderBy(desc(kiloclaw_instances.created_at));
}

async function listOrgInstancesWithoutRows(): Promise<OrgInstanceWithoutRow[]> {
  return await db
    .select({
      instanceId: kiloclaw_instances.id,
      userId: kiloclaw_instances.user_id,
      organizationId: kiloclaw_instances.organization_id,
      instanceCreatedAt: kiloclaw_instances.created_at,
      organizationCreatedAt: organizations.created_at,
      freeTrialEndAt: organizations.free_trial_end_at,
      requireSeats: organizations.require_seats,
      settings: organizations.settings,
      destroyedAt: kiloclaw_instances.destroyed_at,
    })
    .from(kiloclaw_instances)
    .innerJoin(organizations, eq(organizations.id, kiloclaw_instances.organization_id))
    .leftJoin(kiloclaw_subscriptions, eq(kiloclaw_subscriptions.instance_id, kiloclaw_instances.id))
    .where(isNull(kiloclaw_subscriptions.id))
    .orderBy(desc(kiloclaw_instances.created_at));
}

async function listDetachedSubscriptions(): Promise<DetachedSubscriptionAuditRow[]> {
  return await db
    .select({
      subscriptionId: kiloclaw_subscriptions.id,
      userId: kiloclaw_subscriptions.user_id,
      status: kiloclaw_subscriptions.status,
      plan: kiloclaw_subscriptions.plan,
      suspendedAt: kiloclaw_subscriptions.suspended_at,
      trialEndsAt: kiloclaw_subscriptions.trial_ends_at,
      createdAt: kiloclaw_subscriptions.created_at,
      detachedRowCount: sql<number>`(
        SELECT count(*)::int
        FROM ${kiloclaw_subscriptions} AS detached
        WHERE detached.user_id = ${kiloclaw_subscriptions.user_id}
          AND detached.instance_id IS NULL
      )`,
      activePersonalInstanceCount: sql<number>`(
        SELECT count(*)::int
        FROM ${kiloclaw_instances} AS active_instance
        WHERE active_instance.user_id = ${kiloclaw_subscriptions.user_id}
          AND active_instance.organization_id IS NULL
          AND active_instance.destroyed_at IS NULL
      )`,
      linkedPersonalSubscriptionCount: sql<number>`(
        SELECT count(*)::int
        FROM ${kiloclaw_subscriptions} AS linked_sub
        INNER JOIN ${kiloclaw_instances} AS linked_instance
          ON linked_instance.id = linked_sub.instance_id
        WHERE linked_sub.user_id = ${kiloclaw_subscriptions.user_id}
          AND linked_instance.organization_id IS NULL
          AND linked_instance.destroyed_at IS NULL
      )`,
      targetInstanceId: sql<string | null>`(
        SELECT active_instance.id
        FROM ${kiloclaw_instances} AS active_instance
        WHERE active_instance.user_id = ${kiloclaw_subscriptions.user_id}
          AND active_instance.organization_id IS NULL
          AND active_instance.destroyed_at IS NULL
        ORDER BY active_instance.created_at DESC
        LIMIT 1
      )`,
    })
    .from(kiloclaw_subscriptions)
    .where(isNull(kiloclaw_subscriptions.instance_id))
    .orderBy(desc(kiloclaw_subscriptions.created_at));
}

function summarizeDetachedRows(rows: DetachedSubscriptionAuditRow[]) {
  const now = new Date();
  const repairable = rows.filter(
    row =>
      row.detachedRowCount === 1 &&
      row.activePersonalInstanceCount === 1 &&
      row.linkedPersonalSubscriptionCount === 0 &&
      !!row.targetInstanceId &&
      isAccessGrantingRow(row, now)
  );
  const quarantined = rows.filter(
    row => !repairable.some(candidate => candidate.subscriptionId === row.subscriptionId)
  );

  return { repairable, quarantined };
}

async function getSubscriptionsForUsers(userIds: string[]) {
  if (userIds.length === 0) return [];
  return await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(inArray(kiloclaw_subscriptions.user_id, userIds));
}

async function getSubscriptionsForInstances(instanceIds: string[]) {
  if (instanceIds.length === 0) return [];
  return await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(inArray(kiloclaw_subscriptions.instance_id, instanceIds));
}

async function getPersonalInstancesForUsers(userIds: string[]) {
  if (userIds.length === 0) return [];
  return await db
    .select({
      id: kiloclaw_instances.id,
      userId: kiloclaw_instances.user_id,
      destroyedAt: kiloclaw_instances.destroyed_at,
    })
    .from(kiloclaw_instances)
    .where(
      and(inArray(kiloclaw_instances.user_id, userIds), isNull(kiloclaw_instances.organization_id))
    );
}

async function getEarlybirdPurchases(userIds: string[]) {
  if (userIds.length === 0) return [];
  return await db
    .select({
      userId: kiloclaw_earlybird_purchases.user_id,
      createdAt: kiloclaw_earlybird_purchases.created_at,
    })
    .from(kiloclaw_earlybird_purchases)
    .where(inArray(kiloclaw_earlybird_purchases.user_id, userIds));
}

function groupByUser<T extends { user_id: string }>(rows: T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const existing = grouped.get(row.user_id);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.user_id, [row]);
    }
  }
  return grouped;
}

async function buildMissingPersonalCandidates(): Promise<MissingPersonalCandidate[]> {
  const missingRows = await listPersonalInstancesWithoutRows();
  const userIds = [...new Set(missingRows.map(row => row.userId))];
  const [subscriptions, personalInstances, earlybirdPurchases] = await Promise.all([
    getSubscriptionsForUsers(userIds),
    getPersonalInstancesForUsers(userIds),
    getEarlybirdPurchases(userIds),
  ]);

  const subscriptionsByUser = groupByUser(subscriptions);
  const personalInstancesById = new Map(personalInstances.map(row => [row.id, row]));
  const earlybirdPurchaseByUser = new Map(
    earlybirdPurchases.map(row => [row.userId, row.createdAt])
  );
  const now = new Date();

  return missingRows.map(row => {
    const userSubscriptions = subscriptionsByUser.get(row.userId) ?? [];
    const detachedRows = userSubscriptions.filter(
      subscription => subscription.instance_id === null
    );
    const detachedAccessRows = detachedRows.filter(subscription =>
      isAccessGrantingSubscription(subscription, now)
    );
    const linkedPersonalRows = userSubscriptions.filter(subscription => {
      if (!subscription.instance_id) return false;
      return personalInstancesById.has(subscription.instance_id);
    });
    const linkedDestroyedRows = linkedPersonalRows.filter(subscription => {
      const instanceId = subscription.instance_id;
      if (!instanceId) {
        return false;
      }
      const instance = personalInstancesById.get(instanceId);
      return !!instance?.destroyedAt;
    });
    const linkedDestroyedAccessRows = linkedDestroyedRows.filter(subscription =>
      isAccessGrantingSubscription(subscription, now)
    );

    let action: MissingPersonalBackfillAction = 'manual_review';
    let targetSubscriptionId: string | null = null;
    const earlybirdPurchaseCreatedAt = earlybirdPurchaseByUser.get(row.userId) ?? null;

    if (
      !row.destroyedAt &&
      detachedRows.length === 1 &&
      detachedAccessRows.length === 1 &&
      linkedPersonalRows.length === 0
    ) {
      action = 'adopt_detached_access_row';
      targetSubscriptionId = detachedAccessRows[0]?.id ?? null;
    } else if (
      !row.destroyedAt &&
      detachedRows.length === 0 &&
      linkedDestroyedRows.length === 1 &&
      linkedDestroyedAccessRows.length === 1
    ) {
      action = 'reassign_destroyed_access_row';
      targetSubscriptionId = linkedDestroyedAccessRows[0]?.id ?? null;
    } else if (userSubscriptions.length === 0 && earlybirdPurchaseCreatedAt) {
      action = 'backfill_earlybird_row';
    } else if (userSubscriptions.length === 0 && !earlybirdPurchaseCreatedAt) {
      action = 'bootstrap_trial_row';
    }

    return {
      action,
      instanceId: row.instanceId,
      userId: row.userId,
      sandboxId: row.sandboxId,
      instanceCreatedAt: row.createdAt,
      instanceDestroyedAt: row.destroyedAt,
      earlybirdPurchaseCreatedAt,
      hasEarlybird: !!earlybirdPurchaseCreatedAt,
      totalSubscriptionCount: userSubscriptions.length,
      detachedTotalCount: detachedRows.length,
      detachedAccessCount: detachedAccessRows.length,
      linkedPersonalTotalCount: linkedPersonalRows.length,
      linkedDestroyedTotalCount: linkedDestroyedRows.length,
      linkedDestroyedAccessCount: linkedDestroyedAccessRows.length,
      targetSubscriptionId,
    };
  });
}

async function getLatestSeatPurchases(orgIds: string[]) {
  if (orgIds.length === 0) return [];
  return await db
    .select({
      organizationId: organization_seats_purchases.organization_id,
      subscriptionStatus: organization_seats_purchases.subscription_status,
      createdAt: organization_seats_purchases.created_at,
    })
    .from(organization_seats_purchases)
    .where(inArray(organization_seats_purchases.organization_id, orgIds))
    .orderBy(
      organization_seats_purchases.organization_id,
      desc(organization_seats_purchases.created_at)
    );
}

async function getOrganizationsByIds(orgIds: string[]) {
  if (orgIds.length === 0) return [];
  return await db
    .select({
      id: organizations.id,
      createdAt: organizations.created_at,
      freeTrialEndAt: organizations.free_trial_end_at,
      requireSeats: organizations.require_seats,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(inArray(organizations.id, orgIds));
}

async function listActiveInstancesByContext(): Promise<ActiveInstanceContextRow[]> {
  return await db
    .select({
      instanceId: kiloclaw_instances.id,
      userId: kiloclaw_instances.user_id,
      organizationId: kiloclaw_instances.organization_id,
      sandboxId: kiloclaw_instances.sandbox_id,
      createdAt: kiloclaw_instances.created_at,
    })
    .from(kiloclaw_instances)
    .where(isNull(kiloclaw_instances.destroyed_at))
    .orderBy(
      kiloclaw_instances.user_id,
      sql`coalesce(${kiloclaw_instances.organization_id}::text, 'personal')`,
      kiloclaw_instances.created_at
    );
}

async function buildDuplicateActiveInstanceCandidates(): Promise<
  DuplicateActiveInstanceCandidate[]
> {
  const activeInstances = await listActiveInstancesByContext();
  const grouped = new Map<string, ActiveInstanceContextRow[]>();

  for (const row of activeInstances) {
    const key = `${row.userId}:${row.organizationId ?? 'personal'}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }

  const duplicateRows = [...grouped.values()].flatMap(rows =>
    rows.length > 1 ? rows.slice(1) : []
  );
  const canonicalRows = [...grouped.values()]
    .filter(rows => rows.length > 1)
    .map(rows => rows[0])
    .filter((row): row is ActiveInstanceContextRow => !!row);

  const instanceIds = [
    ...new Set([
      ...duplicateRows.map(row => row.instanceId),
      ...canonicalRows.map(row => row.instanceId),
    ]),
  ];
  const orgIds = [
    ...new Set(
      duplicateRows
        .map(row => row.organizationId)
        .filter((organizationId): organizationId is string => typeof organizationId === 'string')
    ),
  ];

  const [subscriptions, orgRows, purchases] = await Promise.all([
    getSubscriptionsForInstances(instanceIds),
    getOrganizationsByIds(orgIds),
    getLatestSeatPurchases(orgIds),
  ]);

  const subscriptionsByInstanceId = new Map<string, KiloClawSubscription[]>();
  for (const subscription of subscriptions) {
    const instanceId = subscription.instance_id;
    if (!instanceId) {
      continue;
    }
    const existing = subscriptionsByInstanceId.get(instanceId);
    if (existing) {
      existing.push(subscription);
    } else {
      subscriptionsByInstanceId.set(instanceId, [subscription]);
    }
  }

  const organizationById = new Map(orgRows.map(row => [row.id, row]));
  const latestPurchaseByOrgId = new Map<
    string,
    Pick<OrganizationSeatsPurchase, 'subscription_status'>
  >();
  for (const purchase of purchases) {
    if (!latestPurchaseByOrgId.has(purchase.organizationId)) {
      latestPurchaseByOrgId.set(purchase.organizationId, {
        subscription_status: purchase.subscriptionStatus,
      });
    }
  }

  const candidates: DuplicateActiveInstanceCandidate[] = [];
  for (const rows of grouped.values()) {
    if (rows.length <= 1) {
      continue;
    }

    const canonical = rows[0];
    if (!canonical) {
      continue;
    }
    const canonicalSubscriptions = subscriptionsByInstanceId.get(canonical.instanceId) ?? [];

    for (const duplicate of rows.slice(1)) {
      const duplicateSubscriptions = subscriptionsByInstanceId.get(duplicate.instanceId) ?? [];
      const organizationRow =
        typeof duplicate.organizationId === 'string'
          ? (organizationById.get(duplicate.organizationId) ?? null)
          : null;
      const latestPurchase =
        typeof duplicate.organizationId === 'string'
          ? (latestPurchaseByOrgId.get(duplicate.organizationId) ?? null)
          : null;

      let action: DuplicateActiveInstanceAction = 'manual_review';
      let targetSubscriptionId: string | null = null;

      if (duplicateSubscriptions.length === 0) {
        action =
          duplicate.organizationId === null
            ? 'backfill_destroy_duplicate_personal'
            : 'backfill_destroy_duplicate_org';
      } else if (duplicateSubscriptions.length === 1 && canonicalSubscriptions.length === 0) {
        action = 'reassign_to_canonical_and_destroy_duplicate';
        targetSubscriptionId = duplicateSubscriptions[0]?.id ?? null;
      }

      candidates.push({
        action,
        contextType: duplicate.organizationId === null ? 'personal' : 'organization',
        userId: duplicate.userId,
        organizationId: duplicate.organizationId,
        canonicalInstanceId: canonical.instanceId,
        canonicalCreatedAt: canonical.createdAt,
        duplicateInstanceId: duplicate.instanceId,
        duplicateSandboxId: duplicate.sandboxId,
        duplicateCreatedAt: duplicate.createdAt,
        canonicalSubscriptionCount: canonicalSubscriptions.length,
        duplicateSubscriptionCount: duplicateSubscriptions.length,
        targetSubscriptionId,
        organizationCreatedAt: organizationRow?.createdAt ?? null,
        freeTrialEndAt: organizationRow?.freeTrialEndAt ?? null,
        requireSeats: organizationRow?.requireSeats ?? null,
        organizationSettings: organizationRow?.settings ?? null,
        latestPurchaseStatus: latestPurchase?.subscription_status ?? null,
      });
    }
  }

  return candidates;
}

async function buildOrgBackfillCandidates(): Promise<OrgBackfillCandidate[]> {
  const missingRows = await listOrgInstancesWithoutRows();
  const orgIds = [
    ...new Set(
      missingRows
        .map(row => row.organizationId)
        .filter((organizationId): organizationId is string => !!organizationId)
    ),
  ];
  const purchases = await getLatestSeatPurchases(orgIds);
  const latestPurchaseByOrgId = new Map<
    string,
    Pick<OrganizationSeatsPurchase, 'subscription_status'>
  >();

  for (const purchase of purchases) {
    if (!latestPurchaseByOrgId.has(purchase.organizationId)) {
      latestPurchaseByOrgId.set(purchase.organizationId, {
        subscription_status: purchase.subscriptionStatus,
      });
    }
  }

  return missingRows
    .filter(
      (row): row is typeof row & { organizationId: string } =>
        typeof row.organizationId === 'string'
    )
    .map(row => {
      const latestPurchase = latestPurchaseByOrgId.get(row.organizationId) ?? null;
      const hasManagedActiveAccess = getOrganizationManagedActiveAccess({
        organization: {
          require_seats: row.requireSeats,
          settings: row.settings,
        },
        latestPurchase,
      });
      const action = row.destroyedAt
        ? hasManagedActiveAccess
          ? 'backfill_destroyed_standard_credits'
          : 'backfill_destroyed_trial'
        : hasManagedActiveAccess
          ? 'backfill_active_standard_credits'
          : 'backfill_trial';

      return {
        action,
        instanceId: row.instanceId,
        userId: row.userId,
        organizationId: row.organizationId,
        instanceCreatedAt: row.instanceCreatedAt,
        organizationCreatedAt: row.organizationCreatedAt,
        freeTrialEndAt: row.freeTrialEndAt,
        requireSeats: row.requireSeats,
        latestPurchaseStatus: latestPurchase?.subscription_status ?? null,
        destroyedAt: row.destroyedAt,
      };
    });
}

function summarizeMissingPersonalCandidates(rows: MissingPersonalCandidate[]) {
  return Object.entries(
    rows.reduce<Record<MissingPersonalBackfillAction, number>>(
      (acc, row) => {
        acc[row.action] += 1;
        return acc;
      },
      {
        adopt_detached_access_row: 0,
        reassign_destroyed_access_row: 0,
        bootstrap_trial_row: 0,
        backfill_earlybird_row: 0,
        manual_review: 0,
      }
    )
  ).map(([action, count]) => ({ action, count }));
}

function summarizeOrgBackfillCandidates(rows: OrgBackfillCandidate[]) {
  return Object.entries(
    rows.reduce<Record<OrgBackfillAction, number>>(
      (acc, row) => {
        acc[row.action] += 1;
        return acc;
      },
      {
        backfill_active_standard_credits: 0,
        backfill_trial: 0,
        backfill_destroyed_standard_credits: 0,
        backfill_destroyed_trial: 0,
      }
    )
  ).map(([action, count]) => ({ action, count }));
}

function summarizeDuplicateActiveInstanceCandidates(rows: DuplicateActiveInstanceCandidate[]) {
  return Object.entries(
    rows.reduce<Record<DuplicateActiveInstanceAction, number>>(
      (acc, row) => {
        acc[row.action] += 1;
        return acc;
      },
      {
        backfill_destroy_duplicate_personal: 0,
        backfill_destroy_duplicate_org: 0,
        reassign_to_canonical_and_destroy_duplicate: 0,
        manual_review: 0,
      }
    )
  ).map(([action, count]) => ({ action, count }));
}

async function listSubscriptionsMissingBaselineChangeLog(): Promise<MissingChangelogBaselineRow[]> {
  return await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(
      notExists(
        db
          .select({ id: kiloclaw_subscription_change_log.id })
          .from(kiloclaw_subscription_change_log)
          .where(eq(kiloclaw_subscription_change_log.subscription_id, kiloclaw_subscriptions.id))
      )
    )
    .orderBy(desc(kiloclaw_subscriptions.created_at));
}

async function previewChangelogBaselineBackfill() {
  const rows = await listSubscriptionsMissingBaselineChangeLog();
  printSection(
    'Subscriptions missing baseline change log',
    rows.map(row => ({
      subscriptionId: row.id,
      userId: row.user_id,
      instanceId: row.instance_id,
      plan: row.plan,
      status: row.status,
      accessOrigin: row.access_origin,
      createdAt: row.created_at,
    }))
  );
}

async function applyChangelogBaselineBackfill() {
  const rows = await listSubscriptionsMissingBaselineChangeLog();
  let inserted = 0;

  for (const row of rows) {
    const [existingLog] = await db
      .select({ id: kiloclaw_subscription_change_log.id })
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, row.id))
      .limit(1);

    if (existingLog) {
      continue;
    }

    await insertAlignmentChangeLog({
      subscriptionId: row.id,
      action: 'backfilled',
      reason: 'baseline_subscription_snapshot',
      before: null,
      after: row,
    });
    inserted += 1;
  }

  console.log('\nChangelog baseline backfill results');
  console.table([{ action: 'backfilled', count: inserted }]);
}

async function previewMissingPersonalBackfill() {
  const rows = await buildMissingPersonalCandidates();
  printSection('Missing personal backfill action counts', summarizeMissingPersonalCandidates(rows));
  printSection(
    'Missing personal rows safe to adopt detached access row',
    rows
      .filter(row => row.action === 'adopt_detached_access_row')
      .map(row => ({
        instanceId: row.instanceId,
        userId: row.userId,
        sandboxId: row.sandboxId,
        instanceDestroyedAt: row.instanceDestroyedAt,
        targetSubscriptionId: row.targetSubscriptionId,
        instanceCreatedAt: row.instanceCreatedAt,
      }))
  );
  printSection(
    'Missing personal rows safe to reassign destroyed access row',
    rows
      .filter(row => row.action === 'reassign_destroyed_access_row')
      .map(row => ({
        instanceId: row.instanceId,
        userId: row.userId,
        sandboxId: row.sandboxId,
        instanceDestroyedAt: row.instanceDestroyedAt,
        targetSubscriptionId: row.targetSubscriptionId,
        instanceCreatedAt: row.instanceCreatedAt,
      }))
  );
  printSection(
    'Missing personal rows safe to bootstrap trial row',
    rows
      .filter(row => row.action === 'bootstrap_trial_row')
      .map(row => ({
        instanceId: row.instanceId,
        userId: row.userId,
        sandboxId: row.sandboxId,
        instanceDestroyedAt: row.instanceDestroyedAt,
        trialEndsAt: getTrialEndsAt(row.instanceCreatedAt),
        instanceCreatedAt: row.instanceCreatedAt,
      }))
  );
  printSection(
    'Missing personal rows safe to backfill earlybird row',
    rows
      .filter(row => row.action === 'backfill_earlybird_row')
      .map(row => ({
        instanceId: row.instanceId,
        userId: row.userId,
        sandboxId: row.sandboxId,
        instanceDestroyedAt: row.instanceDestroyedAt,
        earlybirdPurchaseCreatedAt: row.earlybirdPurchaseCreatedAt,
        trialEndsAt: getEarlybirdEndsAt(),
        instanceCreatedAt: row.instanceCreatedAt,
      }))
  );
  printSection(
    'Missing personal rows left for manual review',
    rows
      .filter(row => row.action === 'manual_review')
      .map(row => ({
        instanceId: row.instanceId,
        userId: row.userId,
        sandboxId: row.sandboxId,
        instanceDestroyedAt: row.instanceDestroyedAt,
        earlybirdPurchaseCreatedAt: row.earlybirdPurchaseCreatedAt,
        totalSubscriptionCount: row.totalSubscriptionCount,
        detachedTotalCount: row.detachedTotalCount,
        detachedAccessCount: row.detachedAccessCount,
        linkedPersonalTotalCount: row.linkedPersonalTotalCount,
        linkedDestroyedTotalCount: row.linkedDestroyedTotalCount,
        linkedDestroyedAccessCount: row.linkedDestroyedAccessCount,
        hasEarlybird: row.hasEarlybird,
      }))
  );
}

async function previewOrgBackfill() {
  const rows = await buildOrgBackfillCandidates();
  printSection('Org backfill action counts', summarizeOrgBackfillCandidates(rows));
  printSection(
    'Org rows to backfill as active standard credits',
    rows
      .filter(row => row.action === 'backfill_active_standard_credits')
      .map(row => ({
        instanceId: row.instanceId,
        organizationId: row.organizationId,
        userId: row.userId,
        latestPurchaseStatus: row.latestPurchaseStatus,
        requireSeats: row.requireSeats,
        destroyedAt: row.destroyedAt,
        instanceCreatedAt: row.instanceCreatedAt,
      }))
  );
  printSection(
    'Org rows to backfill as active trial rows',
    rows
      .filter(row => row.action === 'backfill_trial')
      .map(row => ({
        instanceId: row.instanceId,
        organizationId: row.organizationId,
        userId: row.userId,
        latestPurchaseStatus: row.latestPurchaseStatus,
        requireSeats: row.requireSeats,
        destroyedAt: row.destroyedAt,
        trialStartedAt: row.organizationCreatedAt,
        trialEndsAt: row.freeTrialEndAt ?? getTrialEndsAt(row.organizationCreatedAt),
      }))
  );
  printSection(
    'Org rows to backfill as destroyed standard credits',
    rows
      .filter(row => row.action === 'backfill_destroyed_standard_credits')
      .map(row => ({
        instanceId: row.instanceId,
        organizationId: row.organizationId,
        userId: row.userId,
        latestPurchaseStatus: row.latestPurchaseStatus,
        requireSeats: row.requireSeats,
        destroyedAt: row.destroyedAt,
        instanceCreatedAt: row.instanceCreatedAt,
      }))
  );
  printSection(
    'Org rows to backfill as destroyed trial rows',
    rows
      .filter(row => row.action === 'backfill_destroyed_trial')
      .map(row => ({
        instanceId: row.instanceId,
        organizationId: row.organizationId,
        userId: row.userId,
        latestPurchaseStatus: row.latestPurchaseStatus,
        requireSeats: row.requireSeats,
        destroyedAt: row.destroyedAt,
        trialStartedAt: row.organizationCreatedAt,
        trialEndsAt: row.freeTrialEndAt ?? getTrialEndsAt(row.organizationCreatedAt),
      }))
  );
}

async function previewDuplicateActiveInstances() {
  const rows = await buildDuplicateActiveInstanceCandidates();
  printSection(
    'Duplicate active instance action counts',
    summarizeDuplicateActiveInstanceCandidates(rows)
  );
  printSection(
    'Duplicate active personal instances safe to backfill and destroy',
    rows
      .filter(row => row.action === 'backfill_destroy_duplicate_personal')
      .map(row => ({
        userId: row.userId,
        canonicalInstanceId: row.canonicalInstanceId,
        duplicateInstanceId: row.duplicateInstanceId,
        duplicateSandboxId: row.duplicateSandboxId,
        canonicalSubscriptionCount: row.canonicalSubscriptionCount,
        duplicateCreatedAt: row.duplicateCreatedAt,
      }))
  );
  printSection(
    'Duplicate active org instances safe to backfill and destroy',
    rows
      .filter(row => row.action === 'backfill_destroy_duplicate_org')
      .map(row => ({
        userId: row.userId,
        organizationId: row.organizationId,
        canonicalInstanceId: row.canonicalInstanceId,
        duplicateInstanceId: row.duplicateInstanceId,
        duplicateSandboxId: row.duplicateSandboxId,
        latestPurchaseStatus: row.latestPurchaseStatus,
        requireSeats: row.requireSeats,
        duplicateCreatedAt: row.duplicateCreatedAt,
      }))
  );
  printSection(
    'Duplicate active instances safe to reassign to canonical and destroy',
    rows
      .filter(row => row.action === 'reassign_to_canonical_and_destroy_duplicate')
      .map(row => ({
        userId: row.userId,
        organizationId: row.organizationId,
        canonicalInstanceId: row.canonicalInstanceId,
        duplicateInstanceId: row.duplicateInstanceId,
        targetSubscriptionId: row.targetSubscriptionId,
        canonicalSubscriptionCount: row.canonicalSubscriptionCount,
        duplicateSubscriptionCount: row.duplicateSubscriptionCount,
      }))
  );
  printSection(
    'Duplicate active instances left for manual review',
    rows
      .filter(row => row.action === 'manual_review')
      .map(row => ({
        userId: row.userId,
        organizationId: row.organizationId,
        canonicalInstanceId: row.canonicalInstanceId,
        duplicateInstanceId: row.duplicateInstanceId,
        canonicalSubscriptionCount: row.canonicalSubscriptionCount,
        duplicateSubscriptionCount: row.duplicateSubscriptionCount,
        targetSubscriptionId: row.targetSubscriptionId,
      }))
  );
}

async function insertDuplicateTerminalSubscription(
  row: DuplicateActiveInstanceCandidate
): Promise<KiloClawSubscription | null> {
  if (row.contextType === 'personal') {
    const [inserted] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: row.userId,
        instance_id: row.duplicateInstanceId,
        plan: 'trial',
        status: 'canceled',
        payment_source: null,
        cancel_at_period_end: false,
        trial_started_at: row.duplicateCreatedAt,
        trial_ends_at: getTrialEndsAt(row.duplicateCreatedAt),
        created_at: row.duplicateCreatedAt,
        updated_at: row.duplicateCreatedAt,
      })
      .returning();
    return inserted ?? null;
  }

  if (
    !row.organizationId ||
    row.organizationCreatedAt === null ||
    row.requireSeats === null ||
    row.organizationSettings === null
  ) {
    return null;
  }

  const hasManagedActiveAccess = getOrganizationManagedActiveAccess({
    organization: {
      require_seats: row.requireSeats,
      settings: row.organizationSettings,
    },
    latestPurchase: row.latestPurchaseStatus
      ? { subscription_status: row.latestPurchaseStatus }
      : null,
  });

  const [inserted] = await db
    .insert(kiloclaw_subscriptions)
    .values(
      hasManagedActiveAccess
        ? {
            user_id: row.userId,
            instance_id: row.duplicateInstanceId,
            plan: 'standard',
            status: 'canceled',
            payment_source: 'credits',
            cancel_at_period_end: false,
            created_at: row.duplicateCreatedAt,
            updated_at: row.duplicateCreatedAt,
          }
        : {
            user_id: row.userId,
            instance_id: row.duplicateInstanceId,
            plan: 'trial',
            status: 'canceled',
            payment_source: null,
            cancel_at_period_end: false,
            trial_started_at: row.organizationCreatedAt,
            trial_ends_at: row.freeTrialEndAt ?? getTrialEndsAt(row.organizationCreatedAt),
            created_at: row.duplicateCreatedAt,
            updated_at: row.duplicateCreatedAt,
          }
    )
    .returning();

  return inserted ?? null;
}

async function markDuplicateInstanceDestroyed(instanceId: string): Promise<boolean> {
  const destroyedAt = new Date().toISOString();
  const rows = await db
    .update(kiloclaw_instances)
    .set({ destroyed_at: destroyedAt })
    .where(and(eq(kiloclaw_instances.id, instanceId), isNull(kiloclaw_instances.destroyed_at)))
    .returning({ id: kiloclaw_instances.id });

  return rows.length > 0;
}

async function applyDuplicateActiveInstances() {
  const rows = await buildDuplicateActiveInstanceCandidates();
  let personalDestroyed = 0;
  let orgDestroyed = 0;
  let reassigned = 0;
  const skipped: Array<{
    duplicateInstanceId: string;
    canonicalInstanceId: string;
    userId: string;
    action: string;
  }> = [];

  for (const row of rows) {
    if (
      row.action !== 'backfill_destroy_duplicate_personal' &&
      row.action !== 'backfill_destroy_duplicate_org' &&
      row.action !== 'reassign_to_canonical_and_destroy_duplicate'
    ) {
      continue;
    }

    const [canonicalExisting, duplicateExisting] = await Promise.all([
      db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.instance_id, row.canonicalInstanceId)),
      db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.instance_id, row.duplicateInstanceId)),
    ]);

    if (
      row.action === 'reassign_to_canonical_and_destroy_duplicate' &&
      (!row.targetSubscriptionId || canonicalExisting.length > 0 || duplicateExisting.length !== 1)
    ) {
      skipped.push({
        duplicateInstanceId: row.duplicateInstanceId,
        canonicalInstanceId: row.canonicalInstanceId,
        userId: row.userId,
        action: row.action,
      });
      continue;
    }

    if (
      (row.action === 'backfill_destroy_duplicate_personal' ||
        row.action === 'backfill_destroy_duplicate_org') &&
      duplicateExisting.length > 0
    ) {
      skipped.push({
        duplicateInstanceId: row.duplicateInstanceId,
        canonicalInstanceId: row.canonicalInstanceId,
        userId: row.userId,
        action: row.action,
      });
      continue;
    }

    if (row.action === 'reassign_to_canonical_and_destroy_duplicate') {
      const before = duplicateExisting[0] ?? null;
      if (!before || before.id !== row.targetSubscriptionId) {
        skipped.push({
          duplicateInstanceId: row.duplicateInstanceId,
          canonicalInstanceId: row.canonicalInstanceId,
          userId: row.userId,
          action: row.action,
        });
        continue;
      }

      const [updated] = await db
        .update(kiloclaw_subscriptions)
        .set({ instance_id: row.canonicalInstanceId })
        .where(
          and(
            eq(kiloclaw_subscriptions.id, row.targetSubscriptionId),
            eq(kiloclaw_subscriptions.instance_id, row.duplicateInstanceId)
          )
        )
        .returning();

      if (!updated) {
        skipped.push({
          duplicateInstanceId: row.duplicateInstanceId,
          canonicalInstanceId: row.canonicalInstanceId,
          userId: row.userId,
          action: row.action,
        });
        continue;
      }

      await insertAlignmentChangeLog({
        subscriptionId: updated.id,
        action: 'reassigned',
        reason: 'apply_duplicate_active_reassign_to_canonical',
        before,
        after: updated,
      });
      reassigned += 1;
    }

    const replacement = await insertDuplicateTerminalSubscription(row);
    if (!replacement) {
      skipped.push({
        duplicateInstanceId: row.duplicateInstanceId,
        canonicalInstanceId: row.canonicalInstanceId,
        userId: row.userId,
        action: row.action,
      });
      continue;
    }

    await insertAlignmentChangeLog({
      subscriptionId: replacement.id,
      action: 'backfilled',
      reason:
        row.contextType === 'personal'
          ? 'apply_duplicate_active_backfill_personal_terminal'
          : 'apply_duplicate_active_backfill_org_terminal',
      before: null,
      after: replacement,
    });

    const destroyed = await markDuplicateInstanceDestroyed(row.duplicateInstanceId);
    if (!destroyed) {
      skipped.push({
        duplicateInstanceId: row.duplicateInstanceId,
        canonicalInstanceId: row.canonicalInstanceId,
        userId: row.userId,
        action: row.action,
      });
      continue;
    }

    if (row.contextType === 'personal') {
      personalDestroyed += 1;
    } else {
      orgDestroyed += 1;
    }
  }

  console.log('\nDuplicate active instance apply results');
  console.table([
    { action: 'backfill_destroy_duplicate_personal', count: personalDestroyed },
    { action: 'backfill_destroy_duplicate_org', count: orgDestroyed },
    { action: 'reassign_to_canonical_and_destroy_duplicate', count: reassigned },
    { action: 'skipped', count: skipped.length },
  ]);
  printSection('Duplicate active instances skipped during apply', skipped);
}

async function applyMissingPersonalBackfill() {
  const rows = await buildMissingPersonalCandidates();
  let adopted = 0;
  let reassigned = 0;
  let bootstrapped = 0;
  let earlybirdBackfilled = 0;
  const skipped: Array<{ instanceId: string; userId: string; action: string }> = [];

  for (const row of rows) {
    if (row.action === 'adopt_detached_access_row') {
      if (!row.targetSubscriptionId) {
        skipped.push({ instanceId: row.instanceId, userId: row.userId, action: row.action });
        continue;
      }

      const result = await db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.id, row.targetSubscriptionId))
        .limit(1);
      const before = result[0] ?? null;
      const updated = await db
        .update(kiloclaw_subscriptions)
        .set({ instance_id: row.instanceId })
        .where(
          and(
            eq(kiloclaw_subscriptions.id, row.targetSubscriptionId),
            isNull(kiloclaw_subscriptions.instance_id)
          )
        )
        .returning();
      const updatedRow = updated[0] ?? null;

      if (before && updatedRow) {
        await insertAlignmentChangeLog({
          subscriptionId: updatedRow.id,
          action: 'reassigned',
          reason: 'apply_missing_personal_adopt_detached',
          before,
          after: updatedRow,
        });
        adopted += 1;
      } else {
        skipped.push({ instanceId: row.instanceId, userId: row.userId, action: row.action });
      }
      continue;
    }

    if (row.action === 'reassign_destroyed_access_row') {
      if (!row.targetSubscriptionId) {
        skipped.push({ instanceId: row.instanceId, userId: row.userId, action: row.action });
        continue;
      }

      const existing = await db
        .select({ id: kiloclaw_subscriptions.id })
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.instance_id, row.instanceId))
        .limit(1);
      if (existing.length > 0) {
        skipped.push({ instanceId: row.instanceId, userId: row.userId, action: row.action });
        continue;
      }

      const [before] = await db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.id, row.targetSubscriptionId))
        .limit(1);
      const updated = await db
        .update(kiloclaw_subscriptions)
        .set({ instance_id: row.instanceId })
        .where(eq(kiloclaw_subscriptions.id, row.targetSubscriptionId))
        .returning();
      const updatedRow = updated[0] ?? null;

      if (before && updatedRow) {
        await insertAlignmentChangeLog({
          subscriptionId: updatedRow.id,
          action: 'reassigned',
          reason: 'apply_missing_personal_reassign_destroyed',
          before,
          after: updatedRow,
        });
        reassigned += 1;
      } else {
        skipped.push({ instanceId: row.instanceId, userId: row.userId, action: row.action });
      }
      continue;
    }

    if (row.action === 'bootstrap_trial_row') {
      const [existingForInstance, existingForUser] = await Promise.all([
        db
          .select({ id: kiloclaw_subscriptions.id })
          .from(kiloclaw_subscriptions)
          .where(eq(kiloclaw_subscriptions.instance_id, row.instanceId))
          .limit(1),
        db
          .select({ id: kiloclaw_subscriptions.id })
          .from(kiloclaw_subscriptions)
          .where(eq(kiloclaw_subscriptions.user_id, row.userId))
          .limit(1),
      ]);

      if (existingForInstance.length > 0 || existingForUser.length > 0) {
        skipped.push({ instanceId: row.instanceId, userId: row.userId, action: row.action });
        continue;
      }

      const trialEndsAt = getTrialEndsAt(row.instanceCreatedAt);
      const [inserted] = await db
        .insert(kiloclaw_subscriptions)
        .values({
          user_id: row.userId,
          instance_id: row.instanceId,
          plan: 'trial',
          status: new Date(trialEndsAt).getTime() > Date.now() ? 'trialing' : 'canceled',
          payment_source: null,
          cancel_at_period_end: false,
          trial_started_at: row.instanceCreatedAt,
          trial_ends_at: trialEndsAt,
          created_at: row.instanceCreatedAt,
          updated_at: row.instanceCreatedAt,
        })
        .returning();

      if (inserted) {
        await insertAlignmentChangeLog({
          subscriptionId: inserted.id,
          action: 'backfilled',
          reason: 'apply_missing_personal_bootstrap_trial',
          before: null,
          after: inserted,
        });
        bootstrapped += 1;
      } else {
        skipped.push({ instanceId: row.instanceId, userId: row.userId, action: row.action });
      }
      continue;
    }

    if (row.action === 'backfill_earlybird_row') {
      const [existingForInstance, existingForUser, earlybirdPurchase] = await Promise.all([
        db
          .select({ id: kiloclaw_subscriptions.id })
          .from(kiloclaw_subscriptions)
          .where(eq(kiloclaw_subscriptions.instance_id, row.instanceId))
          .limit(1),
        db
          .select({ id: kiloclaw_subscriptions.id })
          .from(kiloclaw_subscriptions)
          .where(eq(kiloclaw_subscriptions.user_id, row.userId))
          .limit(1),
        db
          .select({ createdAt: kiloclaw_earlybird_purchases.created_at })
          .from(kiloclaw_earlybird_purchases)
          .where(eq(kiloclaw_earlybird_purchases.user_id, row.userId))
          .limit(1),
      ]);

      if (
        existingForInstance.length > 0 ||
        existingForUser.length > 0 ||
        earlybirdPurchase.length === 0
      ) {
        skipped.push({ instanceId: row.instanceId, userId: row.userId, action: row.action });
        continue;
      }

      const trialEndsAt = getEarlybirdEndsAt();
      const purchase = earlybirdPurchase[0];
      if (!purchase) {
        skipped.push({ instanceId: row.instanceId, userId: row.userId, action: row.action });
        continue;
      }
      const [inserted] = await db
        .insert(kiloclaw_subscriptions)
        .values({
          user_id: row.userId,
          instance_id: row.instanceId,
          access_origin: 'earlybird',
          plan: 'trial',
          status: new Date(trialEndsAt).getTime() > Date.now() ? 'trialing' : 'canceled',
          payment_source: null,
          cancel_at_period_end: false,
          trial_started_at: purchase.createdAt,
          trial_ends_at: trialEndsAt,
          created_at: row.instanceCreatedAt,
          updated_at: row.instanceCreatedAt,
        })
        .returning();

      if (inserted) {
        await insertAlignmentChangeLog({
          subscriptionId: inserted.id,
          action: 'backfilled',
          reason: 'apply_missing_personal_backfill_earlybird',
          before: null,
          after: inserted,
        });
        earlybirdBackfilled += 1;
      } else {
        skipped.push({ instanceId: row.instanceId, userId: row.userId, action: row.action });
      }
    }
  }

  console.log('\nMissing personal backfill results');
  console.table([
    { action: 'adopt_detached_access_row', count: adopted },
    { action: 'reassign_destroyed_access_row', count: reassigned },
    { action: 'bootstrap_trial_row', count: bootstrapped },
    { action: 'backfill_earlybird_row', count: earlybirdBackfilled },
    { action: 'skipped', count: skipped.length },
  ]);
  printSection('Missing personal rows skipped during apply', skipped);
}

async function applyOrgBackfill() {
  const rows = await buildOrgBackfillCandidates();
  let activeStandardCredits = 0;
  let activeTrialRows = 0;
  let destroyedStandardCredits = 0;
  let destroyedTrialRows = 0;
  const skipped: Array<{
    instanceId: string;
    organizationId: string;
    userId: string;
    action: string;
  }> = [];

  for (const row of rows) {
    const existing = await db
      .select({ id: kiloclaw_subscriptions.id })
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, row.instanceId))
      .limit(1);
    if (existing.length > 0) {
      skipped.push({
        instanceId: row.instanceId,
        organizationId: row.organizationId,
        userId: row.userId,
        action: row.action,
      });
      continue;
    }

    const trialEndsAt = row.freeTrialEndAt ?? getTrialEndsAt(row.organizationCreatedAt);
    const trialStatus = new Date(trialEndsAt).getTime() > Date.now() ? 'trialing' : 'canceled';
    const [inserted] = await db
      .insert(kiloclaw_subscriptions)
      .values(
        row.action === 'backfill_active_standard_credits'
          ? {
              user_id: row.userId,
              instance_id: row.instanceId,
              plan: 'standard',
              status: 'active',
              payment_source: 'credits',
              cancel_at_period_end: false,
              created_at: row.instanceCreatedAt,
              updated_at: row.instanceCreatedAt,
            }
          : row.action === 'backfill_destroyed_standard_credits'
            ? {
                user_id: row.userId,
                instance_id: row.instanceId,
                plan: 'standard',
                status: 'canceled',
                payment_source: 'credits',
                cancel_at_period_end: false,
                created_at: row.instanceCreatedAt,
                updated_at: row.instanceCreatedAt,
              }
            : {
                user_id: row.userId,
                instance_id: row.instanceId,
                plan: 'trial',
                status: row.action === 'backfill_destroyed_trial' ? 'canceled' : trialStatus,
                payment_source: null,
                cancel_at_period_end: false,
                trial_started_at: row.organizationCreatedAt,
                trial_ends_at: trialEndsAt,
                created_at: row.instanceCreatedAt,
                updated_at: row.instanceCreatedAt,
              }
      )
      .returning();

    if (!inserted) {
      skipped.push({
        instanceId: row.instanceId,
        organizationId: row.organizationId,
        userId: row.userId,
        action: row.action,
      });
      continue;
    }

    if (row.action === 'backfill_active_standard_credits') {
      await insertAlignmentChangeLog({
        subscriptionId: inserted.id,
        action: 'backfilled',
        reason: 'apply_org_backfill_active_standard_credits',
        before: null,
        after: inserted,
      });
      activeStandardCredits += 1;
    } else if (row.action === 'backfill_trial') {
      await insertAlignmentChangeLog({
        subscriptionId: inserted.id,
        action: 'backfilled',
        reason: 'apply_org_backfill_trial',
        before: null,
        after: inserted,
      });
      activeTrialRows += 1;
    } else if (row.action === 'backfill_destroyed_standard_credits') {
      await insertAlignmentChangeLog({
        subscriptionId: inserted.id,
        action: 'backfilled',
        reason: 'apply_org_backfill_destroyed_standard_credits',
        before: null,
        after: inserted,
      });
      destroyedStandardCredits += 1;
    } else {
      await insertAlignmentChangeLog({
        subscriptionId: inserted.id,
        action: 'backfilled',
        reason: 'apply_org_backfill_destroyed_trial',
        before: null,
        after: inserted,
      });
      destroyedTrialRows += 1;
    }
  }

  console.log('\nOrg backfill results');
  console.table([
    { action: 'backfill_active_standard_credits', count: activeStandardCredits },
    { action: 'backfill_trial', count: activeTrialRows },
    { action: 'backfill_destroyed_standard_credits', count: destroyedStandardCredits },
    { action: 'backfill_destroyed_trial', count: destroyedTrialRows },
    { action: 'skipped', count: skipped.length },
  ]);
  printSection('Org rows skipped during apply', skipped);
}

function parseMode(inputMode?: string): Mode {
  const mode = inputMode ?? 'audit';
  switch (mode) {
    case 'audit':
    case 'repair-detached':
    case 'preview-missing-personal':
    case 'apply-missing-personal':
    case 'preview-duplicates':
    case 'apply-duplicates':
    case 'preview-org':
    case 'apply-org':
    case 'preview-changelog-baseline':
    case 'apply-changelog-baseline':
      return mode;
    default:
      throw new Error(`Unsupported mode: ${inputMode}`);
  }
}

export async function run(inputMode?: string) {
  const mode = parseMode(inputMode);

  if (mode === 'preview-missing-personal') {
    console.log(`Mode: ${mode}`);
    await previewMissingPersonalBackfill();
    return;
  }

  if (mode === 'apply-missing-personal') {
    console.log(`Mode: ${mode}`);
    await applyMissingPersonalBackfill();
    return;
  }

  if (mode === 'preview-duplicates') {
    console.log(`Mode: ${mode}`);
    await previewDuplicateActiveInstances();
    return;
  }

  if (mode === 'apply-duplicates') {
    console.log(`Mode: ${mode}`);
    await applyDuplicateActiveInstances();
    return;
  }

  if (mode === 'preview-org') {
    console.log(`Mode: ${mode}`);
    await previewOrgBackfill();
    return;
  }

  if (mode === 'apply-org') {
    console.log(`Mode: ${mode}`);
    await applyOrgBackfill();
    return;
  }

  if (mode === 'preview-changelog-baseline') {
    console.log(`Mode: ${mode}`);
    await previewChangelogBaselineBackfill();
    return;
  }

  if (mode === 'apply-changelog-baseline') {
    console.log(`Mode: ${mode}`);
    await applyChangelogBaselineBackfill();
    return;
  }

  const [
    personalRowsWithoutSubscriptions,
    personalCandidates,
    duplicateCandidates,
    orgCandidates,
    detachedRows,
    missingChangelogRows,
  ] = await Promise.all([
    listPersonalInstancesWithoutRows(),
    buildMissingPersonalCandidates(),
    buildDuplicateActiveInstanceCandidates(),
    buildOrgBackfillCandidates(),
    listDetachedSubscriptions(),
    listSubscriptionsMissingBaselineChangeLog(),
  ]);
  const { repairable, quarantined } = summarizeDetachedRows(detachedRows);

  console.log(`Mode: ${mode}`);
  printSection(
    'Active personal instances without linked subscription row',
    personalRowsWithoutSubscriptions.filter(row => !row.destroyedAt)
  );
  printSection(
    'Destroyed personal instances without linked subscription row',
    personalRowsWithoutSubscriptions.filter(row => !!row.destroyedAt)
  );
  printSection(
    'Personal missing-row backfill action counts',
    summarizeMissingPersonalCandidates(personalCandidates)
  );
  printSection(
    'Duplicate active instance action counts',
    summarizeDuplicateActiveInstanceCandidates(duplicateCandidates)
  );
  printSection(
    'Active org instances without linked subscription row',
    orgCandidates.filter(
      row => row.action === 'backfill_active_standard_credits' || row.action === 'backfill_trial'
    )
  );
  printSection(
    'Destroyed org instances without linked subscription row',
    orgCandidates.filter(
      row =>
        row.action === 'backfill_destroyed_standard_credits' ||
        row.action === 'backfill_destroyed_trial'
    )
  );
  printSection(
    'Org missing-row backfill action counts',
    summarizeOrgBackfillCandidates(orgCandidates)
  );
  printSection(
    'Detached subscriptions safe to adopt',
    repairable.map(row => ({
      subscriptionId: row.subscriptionId,
      userId: row.userId,
      status: row.status,
      plan: row.plan,
      targetInstanceId: row.targetInstanceId,
    }))
  );
  printSection(
    'Detached subscriptions quarantined',
    quarantined.map(row => ({
      subscriptionId: row.subscriptionId,
      userId: row.userId,
      status: row.status,
      plan: row.plan,
      detachedRowCount: row.detachedRowCount,
      activePersonalInstanceCount: row.activePersonalInstanceCount,
      linkedPersonalSubscriptionCount: row.linkedPersonalSubscriptionCount,
      targetInstanceId: row.targetInstanceId,
    }))
  );
  printSection(
    'Subscriptions missing baseline change log',
    missingChangelogRows.map(row => ({
      subscriptionId: row.id,
      userId: row.user_id,
      instanceId: row.instance_id,
      plan: row.plan,
      status: row.status,
      accessOrigin: row.access_origin,
    }))
  );

  if (mode !== 'repair-detached') {
    return;
  }

  let repaired = 0;
  for (const row of repairable) {
    if (!row.targetInstanceId) continue;
    const [before] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, row.subscriptionId))
      .limit(1);
    const updated = await db
      .update(kiloclaw_subscriptions)
      .set({ instance_id: row.targetInstanceId })
      .where(
        and(
          eq(kiloclaw_subscriptions.id, row.subscriptionId),
          isNull(kiloclaw_subscriptions.instance_id)
        )
      )
      .returning();
    const updatedRow = updated[0] ?? null;
    if (before && updatedRow) {
      await insertAlignmentChangeLog({
        subscriptionId: updatedRow.id,
        action: 'reassigned',
        reason: 'repair_detached_subscription',
        before,
        after: updatedRow,
      });
      repaired += 1;
    }
  }

  console.log(`\nDetached subscriptions repaired: ${repaired}`);
}
