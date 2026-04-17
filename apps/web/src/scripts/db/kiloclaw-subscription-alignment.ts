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
 *   pnpm script db kiloclaw-subscription-alignment apply-duplicates [--confirm-sandboxes-destroyed]
 *   pnpm script db kiloclaw-subscription-alignment preview-org
 *   pnpm script db kiloclaw-subscription-alignment apply-org
 *   pnpm script db kiloclaw-subscription-alignment preview-changelog-baseline
 *   pnpm script db kiloclaw-subscription-alignment apply-changelog-baseline
 *
 * Flags:
 *   --confirm-sandboxes-destroyed   Required for apply-duplicates to write
 *     destroyed_at. Operators MUST first tear down the underlying sandbox
 *     resource out-of-band (provider-level teardown that does NOT mutate
 *     kiloclaw_instances — the admin panel destroy flow writes destroyed_at
 *     itself and would hide the row from apply-duplicates). Without this
 *     flag, apply-duplicates prints a manifest of duplicate sandbox IDs and
 *     exits without writes.
 *
 * Admin-panel workflow (recommended): operators destroy duplicate sandboxes
 * via the admin panel, which sets destroyed_at and tears down the resource.
 * Then apply-missing-personal picks up the now-destroyed instances via the
 * backfill_destroyed_terminal_personal path and inserts canceled terminal
 * subscription rows — no --confirm-sandboxes-destroyed flag required.
 */

import { and, asc, desc, eq, inArray, isNull, notExists, or, sql } from 'drizzle-orm';

import { TRIAL_DURATION_DAYS } from '@/lib/constants';
import {
  KILOCLAW_EARLYBIRD_EXPIRY_DATE,
  KILOCLAW_TRIAL_DURATION_DAYS,
} from '@/lib/kiloclaw/constants';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
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

type DbOrTx = typeof db | DrizzleTransaction;

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
  | 'backfill_destroyed_terminal_personal'
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
  personalContextSubscriptionCount: number;
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

// Personal KiloClaw trials are 7 days (KILOCLAW_TRIAL_DURATION_DAYS, billing spec
// Trials rule 2). Organization trials are 14 days (TRIAL_DURATION_DAYS). These
// MUST NOT be unified — using 14 for personal rows grants extra free access.
function getPersonalTrialEndsAt(startedAt: string): string {
  return new Date(
    new Date(startedAt).getTime() + KILOCLAW_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
}

function getOrganizationTrialEndsAt(startedAt: string): string {
  return new Date(
    new Date(startedAt).getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
}

function getEarlybirdEndsAt(): string {
  return new Date(KILOCLAW_EARLYBIRD_EXPIRY_DATE).toISOString();
}

// Org billing has not rolled out yet. Every org instance gets managed-active
// access as a free trial until paid org billing ships. When billing rolls out,
// restore the spec-defined classifier (active seat purchase || !require_seats
// || oss_sponsorship_tier || suppress_trial_messaging) and keep this aligned
// with services/kiloclaw-billing/src/bootstrap.ts.
function getOrganizationManagedActiveAccess(_params: {
  organization: Pick<Organization, 'require_seats' | 'settings'>;
  latestPurchase: Pick<OrganizationSeatsPurchase, 'subscription_status'> | null;
}): boolean {
  return true;
}

function printSection<T>(label: string, rows: T[]) {
  console.log(`\n${label}: ${rows.length}`);
  if (rows.length === 0) return;
  console.table(rows.slice(0, 25));
  if (rows.length > 25) {
    console.log(`... truncated ${rows.length - 25} more row(s)`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function insertAlignmentChangeLog(
  writer: DbOrTx,
  params: {
    subscriptionId: string;
    action: 'backfilled' | 'reassigned';
    reason: string;
    before: KiloClawSubscription | null;
    after: KiloClawSubscription | null;
  }
) {
  if (!params.after) {
    return;
  }

  await insertKiloClawSubscriptionChangeLog(writer, {
    subscriptionId: params.subscriptionId,
    actor: ALIGNMENT_SCRIPT_ACTOR,
    action: params.action,
    reason: params.reason,
    before: params.before,
    after: params.after,
  });
}

async function personalContextSubscriptionExistsForUser(
  executor: DbOrTx,
  userId: string
): Promise<boolean> {
  // Personal-context = detached (no instance) or attached to a personal instance
  // (no organization). Excludes org-context subscriptions so they don't block
  // personal backfill decisions. Transferred-out predecessors are history and
  // MUST be excluded — a canceled/transferred row is not a current subscription.
  const rows = await executor
    .select({ id: kiloclaw_subscriptions.id })
    .from(kiloclaw_subscriptions)
    .leftJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, userId),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id),
        or(isNull(kiloclaw_subscriptions.instance_id), isNull(kiloclaw_instances.organization_id))
      )
    )
    .limit(1);
  return rows.length > 0;
}

async function liveCurrentPersonalSubscriptionExistsForUser(
  executor: DbOrTx,
  userId: string
): Promise<boolean> {
  // Live-current = non-transferred row attached to a non-destroyed personal
  // instance. Used to guard reassign-destroyed apply: if the user already has
  // a live personal subscription we MUST NOT create a successor on the missing
  // instance (would yield two current personal rows for one user).
  const rows = await executor
    .select({ id: kiloclaw_subscriptions.id })
    .from(kiloclaw_subscriptions)
    .innerJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, userId),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id),
        isNull(kiloclaw_instances.organization_id),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .limit(1);
  return rows.length > 0;
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
    // Transferred-out rows are history (predecessor of a successor chain). They
    // do not count against the "at most one current personal row per user" invariant
    // and MUST NOT be considered candidates for further reassignment.
    const userSubscriptions = (subscriptionsByUser.get(row.userId) ?? []).filter(
      subscription => subscription.transferred_to_subscription_id === null
    );
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
    // Live-current personal rows: on a non-destroyed instance and not transferred.
    // If any exist, the user already has a current personal subscription and we
    // MUST NOT insert a successor on the missing instance (would violate the
    // "at most one current personal row per user" invariant from the billing spec).
    const liveCurrentPersonalRows = linkedPersonalRows.filter(subscription => {
      const instanceId = subscription.instance_id;
      if (!instanceId) return false;
      const instance = personalInstancesById.get(instanceId);
      return !!instance && !instance.destroyedAt;
    });
    // Personal-context subscriptions: rows linked to a personal instance OR detached
    // (ambiguous, but treated as personal-intended by the adopt_detached path).
    // Org-context subs are intentionally excluded so they don't block personal backfill.
    const personalContextSubscriptionCount = linkedPersonalRows.length + detachedRows.length;

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
      liveCurrentPersonalRows.length === 0 &&
      linkedDestroyedRows.length === 1 &&
      linkedDestroyedAccessRows.length === 1
    ) {
      action = 'reassign_destroyed_access_row';
      targetSubscriptionId = linkedDestroyedAccessRows[0]?.id ?? null;
    } else if (
      !row.destroyedAt &&
      personalContextSubscriptionCount === 0 &&
      earlybirdPurchaseCreatedAt
    ) {
      action = 'backfill_earlybird_row';
    } else if (
      !row.destroyedAt &&
      personalContextSubscriptionCount === 0 &&
      !earlybirdPurchaseCreatedAt
    ) {
      action = 'bootstrap_trial_row';
    } else if (row.destroyedAt) {
      // Destroyed personal instance without a sub row. Insert a canceled
      // terminal trial row to satisfy the "every instance has a sub row"
      // invariant. Mirrors the org-side backfill_destroyed_trial path and
      // closes the admin-panel-destroy wedge where destroyed_at is written
      // before apply-duplicates sees the row.
      action = 'backfill_destroyed_terminal_personal';
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
      personalContextSubscriptionCount,
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

  const duplicateGroups = [...grouped.values()].filter(rows => rows.length > 1);
  const allDuplicateGroupInstanceIds = [
    ...new Set(duplicateGroups.flatMap(rows => rows.map(row => row.instanceId))),
  ];
  const orgIds = [
    ...new Set(
      duplicateGroups
        .flatMap(rows => rows.map(row => row.organizationId))
        .filter((organizationId): organizationId is string => typeof organizationId === 'string')
    ),
  ];

  const [subscriptions, orgRows, purchases] = await Promise.all([
    getSubscriptionsForInstances(allDuplicateGroupInstanceIds),
    getOrganizationsByIds(orgIds),
    getLatestSeatPurchases(orgIds),
  ]);

  // Transferred-out rows are history (predecessor in a successor chain).
  // Runtime resolvers in lib/kiloclaw/current-personal-subscription.ts ignore
  // them, so they MUST NOT count toward duplicate-instance sub counts nor be
  // eligible as a targetSubscriptionId for reassignment: moving a transferred
  // row onto the canonical instance would occupy the instance_id unique slot
  // without providing a live sub, wedging future repair.
  const subscriptionsByInstanceId = new Map<string, KiloClawSubscription[]>();
  for (const subscription of subscriptions) {
    const instanceId = subscription.instance_id;
    if (!instanceId || subscription.transferred_to_subscription_id !== null) {
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
  for (const rows of duplicateGroups) {
    // Canonical = instance with the most subscriptions. Tiebreak: oldest created_at.
    // Input rows are already ordered by created_at ASC, so stable sort preserves tiebreak.
    const sortedByPreference = [...rows].sort((a, b) => {
      const aCount = subscriptionsByInstanceId.get(a.instanceId)?.length ?? 0;
      const bCount = subscriptionsByInstanceId.get(b.instanceId)?.length ?? 0;
      return bCount - aCount;
    });

    const canonical = sortedByPreference[0];
    if (!canonical) {
      continue;
    }
    const canonicalSubscriptions = subscriptionsByInstanceId.get(canonical.instanceId) ?? [];

    for (const duplicate of sortedByPreference.slice(1)) {
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
        backfill_destroyed_terminal_personal: 0,
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

// A "baseline" entry is any change-log row with before_state IS NULL — i.e. an
// action=created/backfilled snapshot that establishes the subscription's initial
// state. A subscription is missing its baseline if no such entry exists, even if
// it has later mutation logs (which always carry a before_state).
async function listSubscriptionsMissingBaselineChangeLog(): Promise<MissingChangelogBaselineRow[]> {
  return await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(
      notExists(
        db
          .select({ id: kiloclaw_subscription_change_log.id })
          .from(kiloclaw_subscription_change_log)
          .where(
            and(
              eq(kiloclaw_subscription_change_log.subscription_id, kiloclaw_subscriptions.id),
              isNull(kiloclaw_subscription_change_log.before_state)
            )
          )
      )
    )
    .orderBy(desc(kiloclaw_subscriptions.created_at));
}

async function hasBaselineChangeLogEntry(
  executor: DbOrTx,
  subscriptionId: string
): Promise<boolean> {
  const rows = await executor
    .select({ id: kiloclaw_subscription_change_log.id })
    .from(kiloclaw_subscription_change_log)
    .where(
      and(
        eq(kiloclaw_subscription_change_log.subscription_id, subscriptionId),
        isNull(kiloclaw_subscription_change_log.before_state)
      )
    )
    .limit(1);
  return rows.length > 0;
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
  let insertedFromCurrent = 0;
  let insertedFromMutation = 0;
  const failures: Array<{ subscriptionId: string; userId: string; error: string }> = [];

  for (const row of rows) {
    try {
      const result = await db.transaction(async tx => {
        if (await hasBaselineChangeLogEntry(tx, row.id)) {
          return 'skipped' as const;
        }

        // When prior mutation logs exist, the oldest row's before_state holds
        // the subscription's true initial state (captured before the first
        // mutation was applied). Using it as the fabricated baseline's
        // after_state preserves audit-replay integrity: replaying
        // baseline -> mutation1 -> mutation2 ... reaches the current row.
        // Falling back to the current row would inject a no-op delta before
        // the first mutation and desync replay forever.
        const [earliestMutation] = await tx
          .select({
            beforeState: kiloclaw_subscription_change_log.before_state,
          })
          .from(kiloclaw_subscription_change_log)
          .where(eq(kiloclaw_subscription_change_log.subscription_id, row.id))
          .orderBy(asc(kiloclaw_subscription_change_log.created_at))
          .limit(1);

        const inheritedBaseline = earliestMutation?.beforeState ?? null;

        if (inheritedBaseline) {
          await tx.insert(kiloclaw_subscription_change_log).values({
            subscription_id: row.id,
            actor_type: ALIGNMENT_SCRIPT_ACTOR.actorType,
            actor_id: ALIGNMENT_SCRIPT_ACTOR.actorId,
            action: 'backfilled',
            reason: 'baseline_subscription_snapshot_from_earliest_mutation',
            before_state: null,
            after_state: inheritedBaseline,
          });
          return 'from_mutation' as const;
        }

        await insertAlignmentChangeLog(tx, {
          subscriptionId: row.id,
          action: 'backfilled',
          reason: 'baseline_subscription_snapshot',
          before: null,
          after: row,
        });
        return 'from_current' as const;
      });

      if (result === 'from_mutation') {
        insertedFromMutation += 1;
      } else if (result === 'from_current') {
        insertedFromCurrent += 1;
      }
    } catch (error) {
      console.error('Changelog baseline backfill row failed', {
        subscriptionId: row.id,
        userId: row.user_id,
        error: describeError(error),
      });
      failures.push({
        subscriptionId: row.id,
        userId: row.user_id,
        error: describeError(error),
      });
    }
  }

  console.log('\nChangelog baseline backfill results');
  console.table([
    { action: 'backfilled_from_current_state', count: insertedFromCurrent },
    { action: 'backfilled_from_earliest_mutation', count: insertedFromMutation },
    { action: 'failed', count: failures.length },
  ]);
  printSection('Changelog baseline rows that failed to backfill', failures);
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
        trialEndsAt: getPersonalTrialEndsAt(row.instanceCreatedAt),
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
    'Missing personal rows safe to backfill terminal canceled row (destroyed instance)',
    rows
      .filter(row => row.action === 'backfill_destroyed_terminal_personal')
      .map(row => ({
        instanceId: row.instanceId,
        userId: row.userId,
        sandboxId: row.sandboxId,
        instanceCreatedAt: row.instanceCreatedAt,
        instanceDestroyedAt: row.instanceDestroyedAt,
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
        personalContextSubscriptionCount: row.personalContextSubscriptionCount,
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
        trialEndsAt: row.freeTrialEndAt ?? getOrganizationTrialEndsAt(row.organizationCreatedAt),
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
        trialEndsAt: row.freeTrialEndAt ?? getOrganizationTrialEndsAt(row.organizationCreatedAt),
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
  tx: DbOrTx,
  row: DuplicateActiveInstanceCandidate
): Promise<KiloClawSubscription | null> {
  if (row.contextType === 'personal') {
    const [inserted] = await tx
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: row.userId,
        instance_id: row.duplicateInstanceId,
        plan: 'trial',
        status: 'canceled',
        payment_source: null,
        cancel_at_period_end: false,
        trial_started_at: row.duplicateCreatedAt,
        trial_ends_at: getPersonalTrialEndsAt(row.duplicateCreatedAt),
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

  const [inserted] = await tx
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
            trial_ends_at:
              row.freeTrialEndAt ?? getOrganizationTrialEndsAt(row.organizationCreatedAt),
            created_at: row.duplicateCreatedAt,
            updated_at: row.duplicateCreatedAt,
          }
    )
    .returning();

  return inserted ?? null;
}

async function markDuplicateInstanceDestroyed(tx: DbOrTx, instanceId: string): Promise<boolean> {
  const destroyedAt = new Date().toISOString();
  const rows = await tx
    .update(kiloclaw_instances)
    .set({ destroyed_at: destroyedAt })
    .where(and(eq(kiloclaw_instances.id, instanceId), isNull(kiloclaw_instances.destroyed_at)))
    .returning({ id: kiloclaw_instances.id });

  return rows.length > 0;
}

type DuplicateApplyOutcome = 'personal_destroyed' | 'org_destroyed' | 'reassigned' | 'skipped';

async function applyDuplicateActiveInstanceRow(
  row: DuplicateActiveInstanceCandidate
): Promise<DuplicateApplyOutcome> {
  return await db.transaction(async tx => {
    // Filter transferred-out predecessor rows to match the candidate builder
    // (subscriptionsByInstanceId at buildDuplicateActiveInstanceCandidates).
    // Otherwise a canonical instance holding only a historical transferred
    // predecessor would block reassignment forever: preview classifies the
    // duplicate as safe, apply sees the transferred row as a current sub and
    // skips. Same applies to duplicate counts.
    const [canonicalExisting, duplicateExisting] = await Promise.all([
      tx
        .select()
        .from(kiloclaw_subscriptions)
        .where(
          and(
            eq(kiloclaw_subscriptions.instance_id, row.canonicalInstanceId),
            isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
          )
        ),
      tx
        .select()
        .from(kiloclaw_subscriptions)
        .where(
          and(
            eq(kiloclaw_subscriptions.instance_id, row.duplicateInstanceId),
            isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
          )
        ),
    ]);

    if (
      row.action === 'reassign_to_canonical_and_destroy_duplicate' &&
      (!row.targetSubscriptionId || canonicalExisting.length > 0 || duplicateExisting.length !== 1)
    ) {
      return 'skipped';
    }

    if (
      (row.action === 'backfill_destroy_duplicate_personal' ||
        row.action === 'backfill_destroy_duplicate_org') &&
      duplicateExisting.length > 0
    ) {
      return 'skipped';
    }

    let didReassign = false;

    if (row.action === 'reassign_to_canonical_and_destroy_duplicate') {
      const before = duplicateExisting[0] ?? null;
      if (!before || before.id !== row.targetSubscriptionId) {
        return 'skipped';
      }

      const [updated] = await tx
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
        // UPDATE matched zero rows — no mutation, safe to skip.
        return 'skipped';
      }

      // ---- MUTATION BARRIER ----
      // Past this point the sub has been moved off the duplicate. Any later
      // failure MUST throw so drizzle rolls the tx back; returning 'skipped'
      // would leave the canonical instance with the sub but the duplicate
      // without its terminal replacement, violating one-row-per-instance.
      didReassign = true;

      await insertAlignmentChangeLog(tx, {
        subscriptionId: updated.id,
        action: 'reassigned',
        reason: 'apply_duplicate_active_reassign_to_canonical',
        before,
        after: updated,
      });
    }

    const destroyed = await markDuplicateInstanceDestroyed(tx, row.duplicateInstanceId);
    if (!destroyed) {
      if (didReassign) {
        throw new Error(
          `apply-duplicates: duplicate instance ${row.duplicateInstanceId} destroy marker lost race after reassigning sub to ${row.canonicalInstanceId}; rolling back`
        );
      }
      return 'skipped';
    }

    // If the duplicate's instance_id slot is already occupied (e.g. by a
    // transferred predecessor), the UQ_kiloclaw_subscriptions_instance partial
    // unique prevents inserting another row. A transferred predecessor
    // already satisfies the "every instance has a sub row" invariant, so
    // skip the terminal insert in that case.
    const anyRowOnDuplicate = await tx
      .select({ id: kiloclaw_subscriptions.id })
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, row.duplicateInstanceId))
      .limit(1);

    if (anyRowOnDuplicate.length === 0) {
      const replacement = await insertDuplicateTerminalSubscription(tx, row);
      if (!replacement) {
        throw new Error(
          `apply-duplicates: failed to insert terminal subscription for duplicate instance ${row.duplicateInstanceId} after marking destroyed; rolling back`
        );
      }

      await insertAlignmentChangeLog(tx, {
        subscriptionId: replacement.id,
        action: 'backfilled',
        reason:
          row.contextType === 'personal'
            ? 'apply_duplicate_active_backfill_personal_terminal'
            : 'apply_duplicate_active_backfill_org_terminal',
        before: null,
        after: replacement,
      });
    }

    if (row.action === 'reassign_to_canonical_and_destroy_duplicate') {
      return 'reassigned';
    }
    return row.contextType === 'personal' ? 'personal_destroyed' : 'org_destroyed';
  });
}

async function applyDuplicateActiveInstances(options: ApplyOptions) {
  const rows = await buildDuplicateActiveInstanceCandidates();
  let personalDestroyed = 0;
  let orgDestroyed = 0;
  let reassigned = 0;
  const skipped: Array<{
    duplicateInstanceId: string;
    canonicalInstanceId: string;
    userId: string;
    action: string;
    error?: string;
  }> = [];
  const manualTeardown: Array<{
    duplicateInstanceId: string;
    duplicateSandboxId: string;
    userId: string;
    action: string;
  }> = [];

  // Writing destroyed_at without destroying the underlying sandbox would make
  // an active sandbox invisible to lifecycle/access checks while it keeps
  // consuming resources. The canonical destroy flow (kiloclaw-router.ts
  // destroy procedure) always calls KiloClawInternalClient().destroy() and
  // rolls back on failure; we can't safely mirror that from a batch script.
  // Operators MUST confirm each duplicate sandbox has already been torn down
  // out-of-band before we mark its DB row destroyed.
  if (!options.confirmSandboxesDestroyed) {
    for (const row of rows) {
      if (
        row.action === 'backfill_destroy_duplicate_personal' ||
        row.action === 'backfill_destroy_duplicate_org' ||
        row.action === 'reassign_to_canonical_and_destroy_duplicate'
      ) {
        manualTeardown.push({
          duplicateInstanceId: row.duplicateInstanceId,
          duplicateSandboxId: row.duplicateSandboxId,
          userId: row.userId,
          action: row.action,
        });
      }
    }
    console.log(
      '\nRefusing to mark duplicate instances destroyed without external sandbox teardown confirmation.'
    );
    console.log(
      'Operators MUST destroy each sandbox below via the admin panel (or confirm it is already gone),'
    );
    console.log(
      'then re-run with --confirm-sandboxes-destroyed to write destroyed_at and insert terminal rows.'
    );
    printSection('Duplicate sandboxes requiring manual teardown first', manualTeardown);
    return;
  }

  for (const row of rows) {
    if (
      row.action !== 'backfill_destroy_duplicate_personal' &&
      row.action !== 'backfill_destroy_duplicate_org' &&
      row.action !== 'reassign_to_canonical_and_destroy_duplicate'
    ) {
      continue;
    }

    let outcome: DuplicateApplyOutcome;
    try {
      outcome = await applyDuplicateActiveInstanceRow(row);
    } catch (error) {
      console.error('Duplicate active instance apply row failed', {
        duplicateInstanceId: row.duplicateInstanceId,
        canonicalInstanceId: row.canonicalInstanceId,
        userId: row.userId,
        action: row.action,
        error: describeError(error),
      });
      skipped.push({
        duplicateInstanceId: row.duplicateInstanceId,
        canonicalInstanceId: row.canonicalInstanceId,
        userId: row.userId,
        action: row.action,
        error: describeError(error),
      });
      continue;
    }

    switch (outcome) {
      case 'personal_destroyed':
        personalDestroyed += 1;
        break;
      case 'org_destroyed':
        orgDestroyed += 1;
        break;
      case 'reassigned':
        reassigned += 1;
        break;
      case 'skipped':
        skipped.push({
          duplicateInstanceId: row.duplicateInstanceId,
          canonicalInstanceId: row.canonicalInstanceId,
          userId: row.userId,
          action: row.action,
        });
        break;
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

type MissingPersonalOutcome =
  | 'adopted'
  | 'reassigned'
  | 'bootstrapped'
  | 'earlybird_backfilled'
  | 'destroyed_terminal_backfilled'
  | 'skipped'
  | 'no_op';

async function applyMissingPersonalBackfillRow(
  row: MissingPersonalCandidate
): Promise<MissingPersonalOutcome> {
  if (row.action === 'manual_review') {
    return 'no_op';
  }
  return await db.transaction(async tx => {
    if (row.action === 'adopt_detached_access_row') {
      if (!row.targetSubscriptionId) {
        return 'skipped';
      }

      const result = await tx
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.id, row.targetSubscriptionId))
        .limit(1);
      const before = result[0] ?? null;
      const updated = await tx
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

      if (!before || !updatedRow) {
        return 'skipped';
      }

      await insertAlignmentChangeLog(tx, {
        subscriptionId: updatedRow.id,
        action: 'reassigned',
        reason: 'apply_missing_personal_adopt_detached',
        before,
        after: updatedRow,
      });
      return 'adopted';
    }

    if (row.action === 'reassign_destroyed_access_row') {
      if (!row.targetSubscriptionId) {
        return 'skipped';
      }

      // Only current (non-transferred) rows block reassignment. A transferred
      // predecessor on this instance is runtime-invisible and must not block
      // the successor insert.
      const [existing, hasLiveCurrent] = await Promise.all([
        tx
          .select({ id: kiloclaw_subscriptions.id })
          .from(kiloclaw_subscriptions)
          .where(
            and(
              eq(kiloclaw_subscriptions.instance_id, row.instanceId),
              isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
            )
          )
          .limit(1),
        liveCurrentPersonalSubscriptionExistsForUser(tx, row.userId),
      ]);

      if (existing.length > 0 || hasLiveCurrent) {
        return 'skipped';
      }

      const [before] = await tx
        .select()
        .from(kiloclaw_subscriptions)
        .where(
          and(
            eq(kiloclaw_subscriptions.id, row.targetSubscriptionId),
            isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
          )
        )
        .limit(1);

      if (!before) {
        return 'skipped';
      }

      // Successor pattern: mirror createSuccessorPersonalSubscription in
      // services/kiloclaw-billing/src/bootstrap.ts. Create new row on the active
      // instance, mark the destroyed-instance row canceled + transferred_to. This
      // preserves history on the destroyed instance and keeps future audits clean.
      const [insertedSuccessor] = await tx
        .insert(kiloclaw_subscriptions)
        .values({
          user_id: before.user_id,
          instance_id: row.instanceId,
          access_origin: before.access_origin,
          payment_source: before.payment_source,
          plan: before.plan,
          scheduled_plan: before.scheduled_plan,
          scheduled_by: before.scheduled_by,
          status: before.status,
          cancel_at_period_end: before.cancel_at_period_end,
          pending_conversion: before.pending_conversion,
          trial_started_at: before.trial_started_at,
          trial_ends_at: before.trial_ends_at,
          current_period_start: before.current_period_start,
          current_period_end: before.current_period_end,
          credit_renewal_at: before.credit_renewal_at,
          commit_ends_at: before.commit_ends_at,
          past_due_since: before.past_due_since,
          suspended_at: before.suspended_at,
          destruction_deadline: before.destruction_deadline,
          auto_resume_requested_at: before.auto_resume_requested_at,
          auto_resume_retry_after: before.auto_resume_retry_after,
          auto_resume_attempt_count: before.auto_resume_attempt_count,
          auto_top_up_triggered_for_period: before.auto_top_up_triggered_for_period,
        })
        .returning();

      if (!insertedSuccessor) {
        // INSERT returned nothing — no mutation, safe to skip.
        return 'skipped';
      }

      // ---- MUTATION BARRIER ----
      // Past this point the successor row exists in the tx. Any downstream
      // failure MUST throw so drizzle rolls the tx back; returning 'skipped'
      // would commit the orphan successor and violate the single-current-row
      // invariant.

      const [predecessor] = await tx
        .update(kiloclaw_subscriptions)
        .set({
          status: 'canceled',
          transferred_to_subscription_id: insertedSuccessor.id,
          payment_source: 'credits',
          stripe_subscription_id: null,
          stripe_schedule_id: null,
          credit_renewal_at: null,
          cancel_at_period_end: false,
          pending_conversion: false,
          scheduled_plan: null,
          scheduled_by: null,
          auto_resume_requested_at: null,
          auto_resume_retry_after: null,
          auto_resume_attempt_count: 0,
          auto_top_up_triggered_for_period: null,
          destruction_deadline: null,
        })
        .where(
          and(
            eq(kiloclaw_subscriptions.id, before.id),
            isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
          )
        )
        .returning();

      if (!predecessor) {
        throw new Error(
          `reassign_destroyed_access_row: predecessor ${before.id} was transferred concurrently after successor ${insertedSuccessor.id} was inserted; rolling back successor`
        );
      }

      const successor =
        before.stripe_subscription_id || before.stripe_schedule_id
          ? ((
              await tx
                .update(kiloclaw_subscriptions)
                .set({
                  stripe_subscription_id: before.stripe_subscription_id,
                  stripe_schedule_id: before.stripe_schedule_id,
                })
                .where(eq(kiloclaw_subscriptions.id, insertedSuccessor.id))
                .returning()
            )[0] ?? null)
          : insertedSuccessor;

      if (!successor) {
        throw new Error(
          `reassign_destroyed_access_row: successor ${insertedSuccessor.id} disappeared during stripe re-attach`
        );
      }

      await insertAlignmentChangeLog(tx, {
        subscriptionId: predecessor.id,
        action: 'reassigned',
        reason: 'apply_missing_personal_reassign_destroyed_predecessor',
        before,
        after: predecessor,
      });
      await insertAlignmentChangeLog(tx, {
        subscriptionId: successor.id,
        action: 'backfilled',
        reason: 'apply_missing_personal_reassign_destroyed_successor',
        before: null,
        after: successor,
      });
      return 'reassigned';
    }

    if (row.action === 'bootstrap_trial_row') {
      if (row.instanceDestroyedAt) {
        return 'skipped';
      }

      // Only current (non-transferred) rows block bootstrap. Transferred
      // predecessor on this instance is runtime-invisible.
      const [existingForInstance, hasPersonalForUser] = await Promise.all([
        tx
          .select({ id: kiloclaw_subscriptions.id })
          .from(kiloclaw_subscriptions)
          .where(
            and(
              eq(kiloclaw_subscriptions.instance_id, row.instanceId),
              isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
            )
          )
          .limit(1),
        personalContextSubscriptionExistsForUser(tx, row.userId),
      ]);

      if (existingForInstance.length > 0 || hasPersonalForUser) {
        return 'skipped';
      }

      const trialEndsAt = getPersonalTrialEndsAt(row.instanceCreatedAt);
      const [inserted] = await tx
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

      if (!inserted) {
        return 'skipped';
      }

      await insertAlignmentChangeLog(tx, {
        subscriptionId: inserted.id,
        action: 'backfilled',
        reason: 'apply_missing_personal_bootstrap_trial',
        before: null,
        after: inserted,
      });
      return 'bootstrapped';
    }

    if (row.action === 'backfill_earlybird_row') {
      if (row.instanceDestroyedAt) {
        return 'skipped';
      }

      // Only current (non-transferred) rows block earlybird backfill.
      // Transferred predecessor on this instance is runtime-invisible.
      const [existingForInstance, hasPersonalForUser, earlybirdPurchase] = await Promise.all([
        tx
          .select({ id: kiloclaw_subscriptions.id })
          .from(kiloclaw_subscriptions)
          .where(
            and(
              eq(kiloclaw_subscriptions.instance_id, row.instanceId),
              isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
            )
          )
          .limit(1),
        personalContextSubscriptionExistsForUser(tx, row.userId),
        tx
          .select({ createdAt: kiloclaw_earlybird_purchases.created_at })
          .from(kiloclaw_earlybird_purchases)
          .where(eq(kiloclaw_earlybird_purchases.user_id, row.userId))
          .limit(1),
      ]);

      if (existingForInstance.length > 0 || hasPersonalForUser || earlybirdPurchase.length === 0) {
        return 'skipped';
      }

      const purchase = earlybirdPurchase[0];
      if (!purchase) {
        return 'skipped';
      }
      const trialEndsAt = getEarlybirdEndsAt();
      const [inserted] = await tx
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

      if (!inserted) {
        return 'skipped';
      }

      await insertAlignmentChangeLog(tx, {
        subscriptionId: inserted.id,
        action: 'backfilled',
        reason: 'apply_missing_personal_backfill_earlybird',
        before: null,
        after: inserted,
      });
      return 'earlybird_backfilled';
    }

    if (row.action === 'backfill_destroyed_terminal_personal') {
      if (!row.instanceDestroyedAt) {
        // Candidate classification guarantees destroyedAt. If the instance
        // was un-destroyed between preview and apply, fall out; the next
        // audit run will reclassify.
        return 'skipped';
      }

      const existingForInstance = await tx
        .select({ id: kiloclaw_subscriptions.id })
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.instance_id, row.instanceId))
        .limit(1);

      if (existingForInstance.length > 0) {
        return 'skipped';
      }

      const trialEndsAt = getPersonalTrialEndsAt(row.instanceCreatedAt);
      const [inserted] = await tx
        .insert(kiloclaw_subscriptions)
        .values({
          user_id: row.userId,
          instance_id: row.instanceId,
          plan: 'trial',
          status: 'canceled',
          payment_source: null,
          cancel_at_period_end: false,
          trial_started_at: row.instanceCreatedAt,
          trial_ends_at: trialEndsAt,
          created_at: row.instanceCreatedAt,
          updated_at: row.instanceCreatedAt,
        })
        .returning();

      if (!inserted) {
        return 'skipped';
      }

      await insertAlignmentChangeLog(tx, {
        subscriptionId: inserted.id,
        action: 'backfilled',
        reason: 'apply_missing_personal_backfill_destroyed_terminal',
        before: null,
        after: inserted,
      });
      return 'destroyed_terminal_backfilled';
    }

    return 'no_op';
  });
}

async function applyMissingPersonalBackfill() {
  const rows = await buildMissingPersonalCandidates();
  let adopted = 0;
  let reassigned = 0;
  let bootstrapped = 0;
  let earlybirdBackfilled = 0;
  let destroyedTerminalBackfilled = 0;
  const skipped: Array<{
    instanceId: string;
    userId: string;
    action: string;
    error?: string;
  }> = [];

  for (const row of rows) {
    let outcome: MissingPersonalOutcome;
    try {
      outcome = await applyMissingPersonalBackfillRow(row);
    } catch (error) {
      console.error('Missing personal backfill row failed', {
        instanceId: row.instanceId,
        userId: row.userId,
        action: row.action,
        error: describeError(error),
      });
      skipped.push({
        instanceId: row.instanceId,
        userId: row.userId,
        action: row.action,
        error: describeError(error),
      });
      continue;
    }

    switch (outcome) {
      case 'adopted':
        adopted += 1;
        break;
      case 'reassigned':
        reassigned += 1;
        break;
      case 'bootstrapped':
        bootstrapped += 1;
        break;
      case 'earlybird_backfilled':
        earlybirdBackfilled += 1;
        break;
      case 'destroyed_terminal_backfilled':
        destroyedTerminalBackfilled += 1;
        break;
      case 'skipped':
        skipped.push({ instanceId: row.instanceId, userId: row.userId, action: row.action });
        break;
      case 'no_op':
        break;
    }
  }

  console.log('\nMissing personal backfill results');
  console.table([
    { action: 'adopt_detached_access_row', count: adopted },
    { action: 'reassign_destroyed_access_row', count: reassigned },
    { action: 'bootstrap_trial_row', count: bootstrapped },
    { action: 'backfill_earlybird_row', count: earlybirdBackfilled },
    { action: 'backfill_destroyed_terminal_personal', count: destroyedTerminalBackfilled },
    { action: 'skipped', count: skipped.length },
  ]);
  printSection('Missing personal rows skipped during apply', skipped);
}

type OrgApplyOutcome = OrgBackfillAction | 'skipped';

const ORG_BACKFILL_REASON: Record<OrgBackfillAction, string> = {
  backfill_active_standard_credits: 'apply_org_backfill_active_standard_credits',
  backfill_trial: 'apply_org_backfill_trial',
  backfill_destroyed_standard_credits: 'apply_org_backfill_destroyed_standard_credits',
  backfill_destroyed_trial: 'apply_org_backfill_destroyed_trial',
};

async function applyOrgBackfillRow(row: OrgBackfillCandidate): Promise<OrgApplyOutcome> {
  return await db.transaction(async tx => {
    const existing = await tx
      .select({ id: kiloclaw_subscriptions.id })
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, row.instanceId))
      .limit(1);
    if (existing.length > 0) {
      return 'skipped';
    }

    const trialEndsAt = row.freeTrialEndAt ?? getOrganizationTrialEndsAt(row.organizationCreatedAt);
    const trialStatus = new Date(trialEndsAt).getTime() > Date.now() ? 'trialing' : 'canceled';
    const [inserted] = await tx
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
      return 'skipped';
    }

    await insertAlignmentChangeLog(tx, {
      subscriptionId: inserted.id,
      action: 'backfilled',
      reason: ORG_BACKFILL_REASON[row.action],
      before: null,
      after: inserted,
    });
    return row.action;
  });
}

async function applyOrgBackfill() {
  const rows = await buildOrgBackfillCandidates();
  const counts: Record<OrgBackfillAction, number> = {
    backfill_active_standard_credits: 0,
    backfill_trial: 0,
    backfill_destroyed_standard_credits: 0,
    backfill_destroyed_trial: 0,
  };
  const skipped: Array<{
    instanceId: string;
    organizationId: string;
    userId: string;
    action: string;
    error?: string;
  }> = [];

  for (const row of rows) {
    let outcome: OrgApplyOutcome;
    try {
      outcome = await applyOrgBackfillRow(row);
    } catch (error) {
      console.error('Org backfill row failed', {
        instanceId: row.instanceId,
        organizationId: row.organizationId,
        userId: row.userId,
        action: row.action,
        error: describeError(error),
      });
      skipped.push({
        instanceId: row.instanceId,
        organizationId: row.organizationId,
        userId: row.userId,
        action: row.action,
        error: describeError(error),
      });
      continue;
    }

    if (outcome === 'skipped') {
      skipped.push({
        instanceId: row.instanceId,
        organizationId: row.organizationId,
        userId: row.userId,
        action: row.action,
      });
    } else {
      counts[outcome] += 1;
    }
  }

  console.log('\nOrg backfill results');
  console.table([
    { action: 'backfill_active_standard_credits', count: counts.backfill_active_standard_credits },
    { action: 'backfill_trial', count: counts.backfill_trial },
    {
      action: 'backfill_destroyed_standard_credits',
      count: counts.backfill_destroyed_standard_credits,
    },
    { action: 'backfill_destroyed_trial', count: counts.backfill_destroyed_trial },
    { action: 'skipped', count: skipped.length },
  ]);
  printSection('Org rows skipped during apply', skipped);
}

type ApplyOptions = {
  confirmSandboxesDestroyed: boolean;
};

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

function parseApplyOptions(args: string[]): ApplyOptions {
  return {
    confirmSandboxesDestroyed: args.includes('--confirm-sandboxes-destroyed'),
  };
}

type ModeHandler = (options: ApplyOptions) => Promise<void>;

const singleModeHandlers: Partial<Record<Mode, ModeHandler>> = {
  'preview-missing-personal': previewMissingPersonalBackfill,
  'apply-missing-personal': applyMissingPersonalBackfill,
  'preview-duplicates': previewDuplicateActiveInstances,
  'apply-duplicates': applyDuplicateActiveInstances,
  'preview-org': previewOrgBackfill,
  'apply-org': applyOrgBackfill,
  'preview-changelog-baseline': previewChangelogBaselineBackfill,
  'apply-changelog-baseline': applyChangelogBaselineBackfill,
};

export async function run(...args: string[]) {
  const inputMode = args[0];
  const mode = parseMode(inputMode);
  const options = parseApplyOptions(args.slice(1));

  const handler = singleModeHandlers[mode];
  if (handler) {
    console.log(`Mode: ${mode}`);
    await handler(options);
    return;
  }
  // Fall through: 'audit' and 'repair-detached' share the full summary output.

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
  const failures: Array<{ subscriptionId: string; userId: string; error: string }> = [];
  for (const row of repairable) {
    if (!row.targetInstanceId) continue;
    const targetInstanceId = row.targetInstanceId;
    try {
      const didRepair = await db.transaction(async tx => {
        const [before] = await tx
          .select()
          .from(kiloclaw_subscriptions)
          .where(eq(kiloclaw_subscriptions.id, row.subscriptionId))
          .limit(1);
        const updated = await tx
          .update(kiloclaw_subscriptions)
          .set({ instance_id: targetInstanceId })
          .where(
            and(
              eq(kiloclaw_subscriptions.id, row.subscriptionId),
              isNull(kiloclaw_subscriptions.instance_id)
            )
          )
          .returning();
        const updatedRow = updated[0] ?? null;
        if (!before || !updatedRow) {
          return false;
        }
        await insertAlignmentChangeLog(tx, {
          subscriptionId: updatedRow.id,
          action: 'reassigned',
          reason: 'repair_detached_subscription',
          before,
          after: updatedRow,
        });
        return true;
      });
      if (didRepair) {
        repaired += 1;
      }
    } catch (error) {
      console.error('Detached subscription repair row failed', {
        subscriptionId: row.subscriptionId,
        userId: row.userId,
        error: describeError(error),
      });
      failures.push({
        subscriptionId: row.subscriptionId,
        userId: row.userId,
        error: describeError(error),
      });
    }
  }

  console.log(`\nDetached subscriptions repaired: ${repaired}`);
  if (failures.length > 0) {
    printSection('Detached subscriptions that failed to repair', failures);
  }
}
