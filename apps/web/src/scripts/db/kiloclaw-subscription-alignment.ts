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
 *   pnpm script db kiloclaw-subscription-alignment preview-org-replacement
 *   pnpm script db kiloclaw-subscription-alignment apply-org-replacement
 *   pnpm script db kiloclaw-subscription-alignment preview-changelog-baseline
 *   pnpm script db kiloclaw-subscription-alignment apply-changelog-baseline
 *   pnpm script db kiloclaw-subscription-alignment preview-multi-row-all-destroyed
 *   pnpm script db kiloclaw-subscription-alignment apply-multi-row-all-destroyed
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
 *   --bulk   Enables chunked bulk write path for low-risk, high-volume
 *     backfills. Used by:
 *       - apply-missing-personal for backfill_destroyed_terminal_personal rows
 *         (chunked bulk INSERT).
 *       - apply-multi-row-all-destroyed for chain collapses (chunked bulk
 *         UPDATE via FROM VALUES + chunked bulk INSERT of change-log rows;
 *         falls back per-user if a chunk transaction rolls back so that a
 *         single UQ_kiloclaw_subscriptions_transferred_to race doesn't
 *         poison the whole chunk).
 *
 * Admin-panel workflow (recommended): operators destroy duplicate sandboxes
 * via the admin panel, which sets destroyed_at and tears down the resource.
 * Then apply-missing-personal picks up the now-destroyed instances via the
 * backfill_destroyed_terminal_personal path and inserts canceled terminal
 * subscription rows — no --confirm-sandboxes-destroyed flag required.
 *
 * multi-row-all-destroyed: collapses users whose `personalCurrentSubscriptionWhere`
 * rows all point at destroyed personal instances. The guard in
 * apps/web/src/lib/kiloclaw/current-personal-subscription.ts throws when
 * activeRows === 0 AND rows.length > 1 — getBillingStatus returns 409 CONFLICT
 * for the affected user. This mode is pure data: for each such user, pick the
 * newest matching row (created_at DESC, id DESC) as the authoritative current
 * row and point every older matching row's transferred_to_subscription_id at
 * it. No instances are touched. Safe to run without flags.
 */

import { and, asc, desc, eq, inArray, isNull, notExists, or, sql } from 'drizzle-orm';

import { TRIAL_DURATION_DAYS } from '@/lib/constants';
import {
  KILOCLAW_EARLYBIRD_EXPIRY_DATE,
  KILOCLAW_TRIAL_DURATION_DAYS,
} from '@/lib/kiloclaw/constants';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  insertKiloClawSubscriptionChangeLog,
  serializeKiloClawSubscriptionSnapshot,
} from '@kilocode/db';
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
  | 'preview-org-replacement'
  | 'apply-org-replacement'
  | 'preview-changelog-baseline'
  | 'apply-changelog-baseline'
  | 'preview-multi-row-all-destroyed'
  | 'apply-multi-row-all-destroyed';

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

type OrgReplacementJoinedRow = {
  subscription: KiloClawSubscription;
  instance: {
    id: string;
    destroyedAt: string | null;
    organizationId: string;
    organizationName: string;
  };
};

type OrgReplacementDestroyedPredecessor = {
  subscriptionId: string;
  instanceId: string;
  plan: string;
  status: string;
  destroyedAt: string;
};

type OrgReplacementTransferPlan = {
  sourceSubscriptionId: string;
  sourceInstanceId: string | null;
  targetSubscriptionId: string | null;
  targetInstanceId: string | null;
};

type OrgReplacementCandidate = {
  organizationId: string;
  organizationName: string;
  userId: string;
  liveSubscriptionId: string;
  liveInstanceId: string;
  destroyedPredecessors: OrgReplacementDestroyedPredecessor[];
  plannedTransfers: OrgReplacementTransferPlan[];
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

function logApplyProgress(params: {
  label: string;
  processed: number;
  total: number;
  startedAt: number;
  every?: number;
}) {
  const interval = params.every ?? 100;
  if (params.processed !== params.total && params.processed % interval !== 0) {
    return;
  }

  const elapsedSeconds = Math.round((Date.now() - params.startedAt) / 1000);
  console.log(
    `[progress] ${params.label}: ${params.processed}/${params.total} processed (${elapsedSeconds}s elapsed)`
  );
}

function chunkArray<T>(rows: T[], size: number): T[][] {
  if (size <= 0) {
    return [rows];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

type SubscriptionTransferUpdate = {
  before: KiloClawSubscription;
  transferredToSubscriptionId: string | null;
};

function compareSubscriptionsByCreatedAtAndId(
  left: KiloClawSubscription,
  right: KiloClawSubscription
): number {
  if (left.created_at === right.created_at) {
    return left.id.localeCompare(right.id);
  }
  return left.created_at.localeCompare(right.created_at);
}

function buildSubscriptionTransferUpdates(
  subscriptions: KiloClawSubscription[]
): SubscriptionTransferUpdate[] {
  const orderedSubscriptions = [...subscriptions].sort(compareSubscriptionsByCreatedAtAndId);
  const updates: SubscriptionTransferUpdate[] = [];

  for (const [index, subscription] of orderedSubscriptions.entries()) {
    const nextSubscription = orderedSubscriptions[index + 1];
    const desiredTransferredTo = nextSubscription?.id ?? null;
    if (subscription.transferred_to_subscription_id === desiredTransferredTo) {
      continue;
    }
    updates.push({
      before: subscription,
      transferredToSubscriptionId: desiredTransferredTo,
    });
  }

  return updates;
}

function transferredToUnchangedWhere(subscription: KiloClawSubscription) {
  return subscription.transferred_to_subscription_id === null
    ? isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
    : eq(
        kiloclaw_subscriptions.transferred_to_subscription_id,
        subscription.transferred_to_subscription_id
      );
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
  const startedAt = Date.now();

  const chunkSize = 500;
  let processedCount = 0;

  for (const chunk of chunkArray(rows, chunkSize)) {
    try {
      // Counts are returned from the transaction callback and accumulated
      // AFTER commit. Mutating the outer counters inside the callback would
      // over-report on rollback: e.g. if the `currentStateRows` INSERT ran
      // but the later `mutationStateRows` INSERT threw, the whole tx would
      // roll back while the outer counters stayed incremented.
      const chunkResult = await db.transaction(async tx => {
        const chunkIds = chunk.map(row => row.id);
        const existingBaselines = await tx
          .select({ subscriptionId: kiloclaw_subscription_change_log.subscription_id })
          .from(kiloclaw_subscription_change_log)
          .where(
            and(
              inArray(kiloclaw_subscription_change_log.subscription_id, chunkIds),
              isNull(kiloclaw_subscription_change_log.before_state)
            )
          );

        const existingBaselineIds = new Set(existingBaselines.map(row => row.subscriptionId));
        const candidateRows = chunk.filter(row => !existingBaselineIds.has(row.id));

        if (candidateRows.length === 0) {
          return { insertedFromCurrent: 0, insertedFromMutation: 0 };
        }

        const candidateIds = candidateRows.map(row => row.id);
        const earliestMutations = await tx
          .selectDistinctOn([kiloclaw_subscription_change_log.subscription_id], {
            subscriptionId: kiloclaw_subscription_change_log.subscription_id,
            beforeState: kiloclaw_subscription_change_log.before_state,
          })
          .from(kiloclaw_subscription_change_log)
          .where(inArray(kiloclaw_subscription_change_log.subscription_id, candidateIds))
          .orderBy(
            kiloclaw_subscription_change_log.subscription_id,
            asc(kiloclaw_subscription_change_log.created_at)
          );

        const earliestMutationMap = new Map(
          earliestMutations.map(row => [row.subscriptionId, row.beforeState ?? null])
        );

        const currentStateRows = candidateRows.filter(row => !earliestMutationMap.get(row.id));
        const mutationStateRows = candidateRows.filter(row =>
          Boolean(earliestMutationMap.get(row.id))
        );

        if (currentStateRows.length > 0) {
          await tx.insert(kiloclaw_subscription_change_log).values(
            currentStateRows.map(row => ({
              subscription_id: row.id,
              actor_type: ALIGNMENT_SCRIPT_ACTOR.actorType,
              actor_id: ALIGNMENT_SCRIPT_ACTOR.actorId,
              action: 'backfilled' as const,
              reason: 'baseline_subscription_snapshot',
              before_state: null,
              after_state: serializeKiloClawSubscriptionSnapshot(row),
            }))
          );
        }

        if (mutationStateRows.length > 0) {
          await tx.insert(kiloclaw_subscription_change_log).values(
            mutationStateRows.map(row => ({
              subscription_id: row.id,
              actor_type: ALIGNMENT_SCRIPT_ACTOR.actorType,
              actor_id: ALIGNMENT_SCRIPT_ACTOR.actorId,
              action: 'backfilled' as const,
              reason: 'baseline_subscription_snapshot_from_earliest_mutation',
              before_state: null,
              after_state: earliestMutationMap.get(row.id) ?? null,
            }))
          );
        }

        return {
          insertedFromCurrent: currentStateRows.length,
          insertedFromMutation: mutationStateRows.length,
        };
      });

      insertedFromCurrent += chunkResult.insertedFromCurrent;
      insertedFromMutation += chunkResult.insertedFromMutation;
    } catch (error) {
      const errorMessage = describeError(error);
      console.error('Changelog baseline backfill chunk failed', {
        subscriptionIds: chunk.map(row => row.id),
        error: errorMessage,
      });
      failures.push(
        ...chunk.map(row => ({
          subscriptionId: row.id,
          userId: row.user_id,
          error: errorMessage,
        }))
      );
    }

    processedCount += chunk.length;
    logApplyProgress({
      label: 'apply-changelog-baseline',
      processed: processedCount,
      total: rows.length,
      startedAt,
      every: 500,
    });
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

function buildOrgReplacementCandidateFromRows(
  rows: OrgReplacementJoinedRow[]
): OrgReplacementCandidate | null {
  const currentRows = rows.filter(row => row.subscription.transferred_to_subscription_id === null);
  const liveCurrentRows = currentRows.filter(row => row.instance.destroyedAt === null);
  const destroyedCurrentRows = currentRows.filter(row => row.instance.destroyedAt !== null);

  if (currentRows.length < 2 || liveCurrentRows.length !== 1 || destroyedCurrentRows.length === 0) {
    return null;
  }

  if (!destroyedCurrentRows.some(row => row.subscription.status === 'active')) {
    return null;
  }

  const liveRow = liveCurrentRows[0];
  if (!liveRow) {
    return null;
  }

  const orderedSubscriptions = [...rows.map(row => row.subscription)].sort(
    compareSubscriptionsByCreatedAtAndId
  );
  if (orderedSubscriptions.at(-1)?.id !== liveRow.subscription.id) {
    return null;
  }

  const rowsBySubscriptionId = new Map(rows.map(row => [row.subscription.id, row]));
  const plannedTransfers = buildSubscriptionTransferUpdates(orderedSubscriptions).map(update => ({
    sourceSubscriptionId: update.before.id,
    sourceInstanceId: update.before.instance_id,
    targetSubscriptionId: update.transferredToSubscriptionId,
    targetInstanceId: update.transferredToSubscriptionId
      ? (rowsBySubscriptionId.get(update.transferredToSubscriptionId)?.subscription.instance_id ??
        null)
      : null,
  }));

  if (plannedTransfers.length === 0) {
    return null;
  }

  return {
    organizationId: liveRow.instance.organizationId,
    organizationName: liveRow.instance.organizationName,
    userId: liveRow.subscription.user_id,
    liveSubscriptionId: liveRow.subscription.id,
    liveInstanceId: liveRow.instance.id,
    destroyedPredecessors: destroyedCurrentRows.flatMap(row =>
      row.instance.destroyedAt
        ? [
            {
              subscriptionId: row.subscription.id,
              instanceId: row.instance.id,
              plan: row.subscription.plan,
              status: row.subscription.status,
              destroyedAt: row.instance.destroyedAt,
            },
          ]
        : []
    ),
    plannedTransfers,
  };
}

async function buildOrgReplacementCandidates(): Promise<OrgReplacementCandidate[]> {
  const rows: OrgReplacementJoinedRow[] = await db
    .select({
      subscription: kiloclaw_subscriptions,
      instance: {
        id: kiloclaw_instances.id,
        destroyedAt: kiloclaw_instances.destroyed_at,
        organizationId: organizations.id,
        organizationName: organizations.name,
      },
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .innerJoin(organizations, eq(organizations.id, kiloclaw_instances.organization_id))
    .orderBy(
      asc(organizations.id),
      asc(kiloclaw_subscriptions.user_id),
      asc(kiloclaw_subscriptions.created_at),
      asc(kiloclaw_subscriptions.id)
    );

  const byContext = new Map<string, OrgReplacementJoinedRow[]>();
  for (const row of rows) {
    const key = `${row.subscription.user_id}:${row.instance.organizationId}`;
    const existing = byContext.get(key);
    if (existing) {
      existing.push(row);
    } else {
      byContext.set(key, [row]);
    }
  }

  const candidates: OrgReplacementCandidate[] = [];
  for (const groupRows of byContext.values()) {
    const candidate = buildOrgReplacementCandidateFromRows(groupRows);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

async function previewOrgReplacementRepair() {
  const rows = await buildOrgReplacementCandidates();
  printSection(
    'Org replacement drift candidates',
    rows.map(row => ({
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      userId: row.userId,
      liveSubscriptionId: row.liveSubscriptionId,
      liveInstanceId: row.liveInstanceId,
      destroyedPredecessorSubscriptions: row.destroyedPredecessors
        .map(
          predecessor =>
            `${predecessor.subscriptionId} (${predecessor.status}, ${predecessor.instanceId})`
        )
        .join(' | '),
      plannedTransferChain: row.plannedTransfers
        .map(
          transfer => `${transfer.sourceSubscriptionId}→${transfer.targetSubscriptionId ?? 'null'}`
        )
        .join(' | '),
    }))
  );
}

class OrgReplacementRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgReplacementRaceError';
  }
}

type OrgReplacementApplyOutcome = 'succeeded' | 'skipped_no_work' | 'skipped_race';

async function applyOrgReplacementCandidate(
  candidate: OrgReplacementCandidate
): Promise<OrgReplacementApplyOutcome> {
  try {
    return await db.transaction(async tx => {
      const rows: OrgReplacementJoinedRow[] = await tx
        .select({
          subscription: kiloclaw_subscriptions,
          instance: {
            id: kiloclaw_instances.id,
            destroyedAt: kiloclaw_instances.destroyed_at,
            organizationId: organizations.id,
            organizationName: organizations.name,
          },
        })
        .from(kiloclaw_subscriptions)
        .innerJoin(
          kiloclaw_instances,
          eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id)
        )
        .innerJoin(organizations, eq(organizations.id, kiloclaw_instances.organization_id))
        .where(
          and(
            eq(kiloclaw_subscriptions.user_id, candidate.userId),
            eq(kiloclaw_instances.organization_id, candidate.organizationId)
          )
        )
        .orderBy(asc(kiloclaw_subscriptions.created_at), asc(kiloclaw_subscriptions.id))
        .for('update');

      const currentCandidate = buildOrgReplacementCandidateFromRows(rows);
      if (!currentCandidate) {
        throw new OrgReplacementRaceError(
          `Org replacement candidate changed before apply for ${candidate.userId}/${candidate.organizationId}`
        );
      }

      const transferUpdates = buildSubscriptionTransferUpdates(rows.map(row => row.subscription));
      if (transferUpdates.length === 0) {
        return 'skipped_no_work';
      }

      for (const update of transferUpdates) {
        const [after] = await tx
          .update(kiloclaw_subscriptions)
          .set({
            transferred_to_subscription_id: update.transferredToSubscriptionId,
          })
          .where(
            and(
              eq(kiloclaw_subscriptions.id, update.before.id),
              transferredToUnchangedWhere(update.before)
            )
          )
          .returning();

        if (!after) {
          throw new OrgReplacementRaceError(
            `Org replacement transfer raced for subscription ${update.before.id}`
          );
        }

        await insertAlignmentChangeLog(tx, {
          subscriptionId: after.id,
          action: 'reassigned',
          reason: 'apply_org_replacement_transfer_destroyed_predecessor',
          before: update.before,
          after,
        });
      }

      return 'succeeded';
    });
  } catch (error) {
    if (error instanceof OrgReplacementRaceError) {
      return 'skipped_race';
    }
    throw error;
  }
}

async function applyOrgReplacementRepair() {
  const rows = await buildOrgReplacementCandidates();
  let orgsSucceeded = 0;
  let orgsSkippedNoWork = 0;
  let orgsSkippedRace = 0;
  const orgsError: Array<{
    organizationId: string;
    organizationName: string;
    userId: string;
    error: string;
  }> = [];
  const startedAt = Date.now();

  for (const [index, row] of rows.entries()) {
    try {
      const outcome = await applyOrgReplacementCandidate(row);
      switch (outcome) {
        case 'succeeded':
          orgsSucceeded += 1;
          break;
        case 'skipped_no_work':
          orgsSkippedNoWork += 1;
          break;
        case 'skipped_race':
          orgsSkippedRace += 1;
          break;
      }
    } catch (error) {
      orgsError.push({
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        userId: row.userId,
        error: describeError(error),
      });
    }

    logApplyProgress({
      label: 'apply-org-replacement',
      processed: index + 1,
      total: rows.length,
      startedAt,
      every: 25,
    });
  }

  console.log('\nOrg replacement repair results');
  console.table([
    { metric: 'orgs_succeeded', count: orgsSucceeded },
    { metric: 'orgs_skipped_no_work', count: orgsSkippedNoWork },
    { metric: 'orgs_skipped_race', count: orgsSkippedRace },
    { metric: 'orgs_error', count: orgsError.length },
  ]);
  printSection('Org replacement rows that failed to repair', orgsError);
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
    const canonicalExisting = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(
        and(
          eq(kiloclaw_subscriptions.instance_id, row.canonicalInstanceId),
          isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
        )
      );
    const duplicateExisting = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(
        and(
          eq(kiloclaw_subscriptions.instance_id, row.duplicateInstanceId),
          isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
        )
      );

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
  const startedAt = Date.now();

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

  for (const [index, row] of rows.entries()) {
    if (
      row.action !== 'backfill_destroy_duplicate_personal' &&
      row.action !== 'backfill_destroy_duplicate_org' &&
      row.action !== 'reassign_to_canonical_and_destroy_duplicate'
    ) {
      logApplyProgress({
        label: 'apply-duplicates',
        processed: index + 1,
        total: rows.length,
        startedAt,
        every: 25,
      });
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

    logApplyProgress({
      label: 'apply-duplicates',
      processed: index + 1,
      total: rows.length,
      startedAt,
      every: 25,
    });
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

async function applyMissingPersonalDestroyedTerminalBulk(params: {
  rows: MissingPersonalCandidate[];
  startedAt: number;
  processedOffset: number;
  totalRows: number;
  progressEvery?: number;
}): Promise<{
  processedCount: number;
  insertedCount: number;
  skipped: Array<{
    instanceId: string;
    userId: string;
    action: string;
    error?: string;
  }>;
}> {
  const chunkSize = 250;
  const skipped: Array<{
    instanceId: string;
    userId: string;
    action: string;
    error?: string;
  }> = [];
  let insertedCount = 0;
  let processedCount = 0;

  for (const chunk of chunkArray(params.rows, chunkSize)) {
    try {
      await db.transaction(async tx => {
        const rowsWithDestroyedAt = chunk.filter(row => Boolean(row.instanceDestroyedAt));
        const rowsWithoutDestroyedAt = chunk.filter(row => !row.instanceDestroyedAt);

        skipped.push(
          ...rowsWithoutDestroyedAt.map(row => ({
            instanceId: row.instanceId,
            userId: row.userId,
            action: row.action,
          }))
        );

        if (rowsWithDestroyedAt.length === 0) {
          return;
        }

        const instanceIds = rowsWithDestroyedAt.map(row => row.instanceId);
        const existingRows = await tx
          .select({ instanceId: kiloclaw_subscriptions.instance_id })
          .from(kiloclaw_subscriptions)
          .where(inArray(kiloclaw_subscriptions.instance_id, instanceIds));

        const existingInstanceIds = new Set(
          existingRows
            .map(row => row.instanceId)
            .filter((instanceId): instanceId is string => Boolean(instanceId))
        );

        const insertableRows = rowsWithDestroyedAt.filter(
          row => !existingInstanceIds.has(row.instanceId)
        );
        const skippedRows = rowsWithDestroyedAt.filter(row =>
          existingInstanceIds.has(row.instanceId)
        );

        skipped.push(
          ...skippedRows.map(row => ({
            instanceId: row.instanceId,
            userId: row.userId,
            action: row.action,
          }))
        );

        if (insertableRows.length === 0) {
          return;
        }

        const insertedRows = await tx
          .insert(kiloclaw_subscriptions)
          .values(
            insertableRows.map(row => ({
              user_id: row.userId,
              instance_id: row.instanceId,
              plan: 'trial' as const,
              status: 'canceled' as const,
              payment_source: null,
              cancel_at_period_end: false,
              trial_started_at: row.instanceCreatedAt,
              trial_ends_at: getPersonalTrialEndsAt(row.instanceCreatedAt),
              created_at: row.instanceCreatedAt,
              updated_at: row.instanceCreatedAt,
            }))
          )
          .returning();

        insertedCount += insertedRows.length;

        if (insertedRows.length === 0) {
          return;
        }

        await tx.insert(kiloclaw_subscription_change_log).values(
          insertedRows.map(insertedRow => ({
            subscription_id: insertedRow.id,
            actor_type: ALIGNMENT_SCRIPT_ACTOR.actorType,
            actor_id: ALIGNMENT_SCRIPT_ACTOR.actorId,
            action: 'backfilled' as const,
            reason: 'apply_missing_personal_backfill_destroyed_terminal',
            before_state: null,
            after_state: serializeKiloClawSubscriptionSnapshot(insertedRow),
          }))
        );
      });
    } catch (error) {
      const errorMessage = describeError(error);
      for (const row of chunk) {
        skipped.push({
          instanceId: row.instanceId,
          userId: row.userId,
          action: row.action,
          error: errorMessage,
        });
      }
    }

    processedCount += chunk.length;
    logApplyProgress({
      label: 'apply-missing-personal',
      processed: params.processedOffset + processedCount,
      total: params.totalRows,
      startedAt: params.startedAt,
      every: params.progressEvery ?? 25,
    });
  }

  return {
    processedCount,
    insertedCount,
    skipped,
  };
}

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
      const existing = await tx
        .select({ id: kiloclaw_subscriptions.id })
        .from(kiloclaw_subscriptions)
        .where(
          and(
            eq(kiloclaw_subscriptions.instance_id, row.instanceId),
            isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
          )
        )
        .limit(1);
      const hasLiveCurrent = await liveCurrentPersonalSubscriptionExistsForUser(tx, row.userId);

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
      const existingForInstance = await tx
        .select({ id: kiloclaw_subscriptions.id })
        .from(kiloclaw_subscriptions)
        .where(
          and(
            eq(kiloclaw_subscriptions.instance_id, row.instanceId),
            isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
          )
        )
        .limit(1);
      const hasPersonalForUser = await personalContextSubscriptionExistsForUser(tx, row.userId);

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
      const existingForInstance = await tx
        .select({ id: kiloclaw_subscriptions.id })
        .from(kiloclaw_subscriptions)
        .where(
          and(
            eq(kiloclaw_subscriptions.instance_id, row.instanceId),
            isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
          )
        )
        .limit(1);
      const hasPersonalForUser = await personalContextSubscriptionExistsForUser(tx, row.userId);
      const earlybirdPurchase = await tx
        .select({ createdAt: kiloclaw_earlybird_purchases.created_at })
        .from(kiloclaw_earlybird_purchases)
        .where(eq(kiloclaw_earlybird_purchases.user_id, row.userId))
        .limit(1);

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

async function applyMissingPersonalBackfill(options: ApplyOptions) {
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
  const startedAt = Date.now();
  let processedCount = 0;

  const bulkDestroyedRows = options.bulk
    ? rows.filter(row => row.action === 'backfill_destroyed_terminal_personal')
    : [];
  const rowByRowRows = options.bulk
    ? rows.filter(row => row.action !== 'backfill_destroyed_terminal_personal')
    : rows;

  if (bulkDestroyedRows.length > 0) {
    console.log(
      `[bulk] apply-missing-personal: processing ${bulkDestroyedRows.length} destroyed-terminal rows in chunked bulk mode`
    );
    const bulkResult = await applyMissingPersonalDestroyedTerminalBulk({
      rows: bulkDestroyedRows,
      startedAt,
      processedOffset: processedCount,
      totalRows: rows.length,
      progressEvery: 25,
    });
    processedCount += bulkResult.processedCount;
    destroyedTerminalBackfilled += bulkResult.insertedCount;
    skipped.push(...bulkResult.skipped);
  }

  for (const row of rowByRowRows) {
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
      processedCount += 1;
      logApplyProgress({
        label: 'apply-missing-personal',
        processed: processedCount,
        total: rows.length,
        startedAt,
        every: 25,
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

    processedCount += 1;
    logApplyProgress({
      label: 'apply-missing-personal',
      processed: processedCount,
      total: rows.length,
      startedAt,
      every: 25,
    });
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

type MultiRowAllDestroyedPair = {
  sourceId: string;
  targetId: string;
  sourceCreatedAt: string;
  targetCreatedAt: string;
};

type MultiRowAllDestroyedCandidate = {
  userId: string;
  tailSubscriptionId: string;
  tailCreatedAt: string;
  currentAmbiguousRowCount: number;
  pairs: MultiRowAllDestroyedPair[];
  // A candidate is `fullyCollapsible` when the planned pair set reduces the
  // user's current ambiguous row count to exactly one. When a pre-existing
  // partial chain (e.g. D→B in a history of [D, A, B, C]) claims an
  // intermediate row's predecessor slot, the UQ_kiloclaw_subscriptions_transferred_to
  // guard forces us to drop a pair, leaving more than one row ambiguous.
  // Apply paths must skip these users — partial collapse would replace one
  // `CurrentPersonalSubscriptionResolutionError`-firing shape with another
  // and mask the problem in the change log.
  fullyCollapsible: boolean;
};

type MultiRowAllDestroyedOutcome =
  | 'collapsed'
  | 'skipped_no_longer_ambiguous'
  | 'skipped_race'
  | 'skipped_not_collapsible';

// ---------------------------------------------------------------------------
// Multi-row-all-destroyed collapse
//
// Scope: users whose `personalCurrentSubscriptionWhere` predicate returns >1 rows
// AND NONE of the joined instances have `destroyed_at IS NULL`. The guard in
// apps/web/src/lib/kiloclaw/current-personal-subscription.ts filters rows to
// activeRows first; with zero alive rows and rows.length > 1 it throws at
// line 114 ("Expected at most one current personal subscription row").
//
// Why this is separate from reassign_destroyed_access_row: that path requires
// a new live target instance to insert a successor onto and move the Stripe
// funding/schedule to. These users have no live personal instance at all —
// either they've moved to an org-owned instance (whose rows the guard filters
// via i.organization_id IS NULL) or they've fully destroyed their personal
// claw. There's nowhere to create a successor, so we just collapse the chain
// down to one tail row and let getBillingStatus return it.
//
// How the chain is formed: `kiloclaw_subscriptions` has a partial unique index
// UQ_kiloclaw_subscriptions_transferred_to on transferred_to_subscription_id,
// so each subscription can have at most ONE predecessor. We therefore cannot
// fan in all older rows onto the newest; we have to build a linked chain of
// (row_i → row_{i+1}) pairs within each user's personal-row history ordered
// oldest-to-newest. For every pair where the older row currently has
// transferred_to_subscription_id IS NULL, we set it to the immediately-next
// row's id. We skip any pair whose target already has a predecessor (to avoid
// UQ violations from pre-existing partial chains), so re-runs are idempotent.
// ---------------------------------------------------------------------------

type MultiRowAllDestroyedSourceRow = {
  subscriptionId: string;
  userId: string;
  subscriptionCreatedAt: string;
  instanceDestroyedAt: string | null;
  transferredToSubscriptionId: string | null;
};

async function buildMultiRowAllDestroyedCandidates(): Promise<MultiRowAllDestroyedCandidate[]> {
  // Pulls ALL personal-instance subscription rows across the fleet, including
  // rows that have already been transferred. We need the complete personal
  // history per user to form a correct LEAD-chain (otherwise an older
  // un-transferred row would be paired with a newer row whose predecessor
  // slot is already occupied by some other row, violating
  // UQ_kiloclaw_subscriptions_transferred_to).
  const rows: MultiRowAllDestroyedSourceRow[] = await db
    .select({
      subscriptionId: kiloclaw_subscriptions.id,
      userId: kiloclaw_subscriptions.user_id,
      subscriptionCreatedAt: kiloclaw_subscriptions.created_at,
      instanceDestroyedAt: kiloclaw_instances.destroyed_at,
      transferredToSubscriptionId: kiloclaw_subscriptions.transferred_to_subscription_id,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        eq(kiloclaw_instances.user_id, kiloclaw_subscriptions.user_id),
        isNull(kiloclaw_instances.organization_id)
      )
    )
    .orderBy(
      asc(kiloclaw_subscriptions.user_id),
      asc(kiloclaw_subscriptions.created_at),
      asc(kiloclaw_subscriptions.id)
    );

  const byUser = new Map<string, MultiRowAllDestroyedSourceRow[]>();
  for (const row of rows) {
    const existing = byUser.get(row.userId);
    if (existing) {
      existing.push(row);
    } else {
      byUser.set(row.userId, [row]);
    }
  }

  const candidates: MultiRowAllDestroyedCandidate[] = [];
  for (const [userId, userRows] of byUser) {
    // `firing_all_destroyed_multi` per the 2026-04-18 incident analysis:
    // >1 rows currently match personalCurrentSubscriptionWhere (transferred_to
    // IS NULL, org-less) AND none of them are alive. If any current ambiguous
    // row points at a live instance the guard picks it and returns safely, so
    // there's nothing for us to collapse.
    const currentAmbiguous = userRows.filter(row => row.transferredToSubscriptionId === null);
    if (currentAmbiguous.length < 2) continue;
    if (currentAmbiguous.some(row => row.instanceDestroyedAt === null)) continue;

    const pairs = planMultiRowAllDestroyedPairsFromSourceRows(userRows);
    // `fullyCollapsible` === true means applying the plan reduces the
    // ambiguous set to exactly one tail row. If every candidate target is
    // already someone else's predecessor, the plan is empty and
    // `fullyCollapsible` will be false — we still surface the user so
    // operators and apply can count them as requiring manual review.
    const fullyCollapsible = currentAmbiguous.length - pairs.length === 1;

    const tail = userRows[userRows.length - 1];
    if (!tail) continue;

    candidates.push({
      userId,
      tailSubscriptionId: tail.subscriptionId,
      tailCreatedAt: tail.subscriptionCreatedAt,
      currentAmbiguousRowCount: currentAmbiguous.length,
      pairs,
      fullyCollapsible,
    });
  }

  return candidates;
}

// Sequential-chain pair planner shared by preview and both apply paths.
// Walks rows oldest-to-newest, pairing each non-transferred row with its
// immediately-next row as successor, skipping pairs whose target is already
// someone else's predecessor (UQ_kiloclaw_subscriptions_transferred_to).
// The plan collapses the user's ambiguous set when
// `currentAmbiguousCount - pairs.length === 1`. Callers must check that
// condition before applying — partial plans leave the user still ambiguous.
function planMultiRowAllDestroyedPairsFromSourceRows(
  userRows: MultiRowAllDestroyedSourceRow[]
): MultiRowAllDestroyedPair[] {
  const existingPredecessorTargets = new Set(
    userRows.map(row => row.transferredToSubscriptionId).filter((id): id is string => id !== null)
  );

  const pairs: MultiRowAllDestroyedPair[] = [];
  for (let index = 0; index < userRows.length - 1; index += 1) {
    const source = userRows[index];
    const next = userRows[index + 1];
    if (!source || !next) continue;
    if (source.transferredToSubscriptionId !== null) continue;
    if (existingPredecessorTargets.has(next.subscriptionId)) continue;
    pairs.push({
      sourceId: source.subscriptionId,
      targetId: next.subscriptionId,
      sourceCreatedAt: source.subscriptionCreatedAt,
      targetCreatedAt: next.subscriptionCreatedAt,
    });
    existingPredecessorTargets.add(next.subscriptionId);
  }
  return pairs;
}

type MultiRowJoinedRow = {
  subscription: KiloClawSubscription;
  instanceDestroyedAt: string | null;
};

// Variant of the planner that works on full joined rows (subscription +
// instance destroyed_at) so apply paths can reuse each `before` row object
// directly for change-log snapshots without a per-pair SELECT. The
// collapsibility rule is the same: `ambiguous - pairs === 1` to fully
// collapse.
function planMultiRowAllDestroyedPairsFromJoinedRows(
  joinedRows: MultiRowJoinedRow[]
): Array<{ before: KiloClawSubscription; targetId: string }> {
  const existingPredecessorTargets = new Set(
    joinedRows
      .map(row => row.subscription.transferred_to_subscription_id)
      .filter((id): id is string => id !== null)
  );

  const pairs: Array<{ before: KiloClawSubscription; targetId: string }> = [];
  for (let index = 0; index < joinedRows.length - 1; index += 1) {
    const source = joinedRows[index]?.subscription;
    const next = joinedRows[index + 1]?.subscription;
    if (!source || !next) continue;
    if (source.transferred_to_subscription_id !== null) continue;
    if (existingPredecessorTargets.has(next.id)) continue;
    pairs.push({ before: source, targetId: next.id });
    existingPredecessorTargets.add(next.id);
  }
  return pairs;
}

function summarizeMultiRowAllDestroyedCandidates(candidates: MultiRowAllDestroyedCandidate[]) {
  const collapsible = candidates.filter(candidate => candidate.fullyCollapsible);
  const nonCollapsible = candidates.filter(candidate => !candidate.fullyCollapsible);
  const totalPairsToWrite = collapsible.reduce((acc, row) => acc + row.pairs.length, 0);
  const buckets = new Map<number, number>();
  for (const candidate of collapsible) {
    const userRowCount = candidate.currentAmbiguousRowCount;
    buckets.set(userRowCount, (buckets.get(userRowCount) ?? 0) + 1);
  }
  return {
    collapsibleUsers: collapsible.length,
    nonCollapsibleUsers: nonCollapsible.length,
    totalPairsToWrite,
    distribution: [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([currentAmbiguousRowCount, users]) => ({
        currentAmbiguousRowCount,
        users,
      })),
  };
}

async function previewMultiRowAllDestroyedCollapse() {
  const candidates = await buildMultiRowAllDestroyedCandidates();
  const summary = summarizeMultiRowAllDestroyedCandidates(candidates);
  const nonCollapsible = candidates.filter(candidate => !candidate.fullyCollapsible);

  console.log('\nmulti-row-all-destroyed preview');
  console.table([
    { metric: 'users_collapsible', count: summary.collapsibleUsers },
    { metric: 'users_non_collapsible', count: summary.nonCollapsibleUsers },
    { metric: 'pairs_to_write', count: summary.totalPairsToWrite },
  ]);
  printSection(
    'Collapsible user ambiguous-row-count distribution (rows matching the guard before collapse)',
    summary.distribution
  );
  printSection(
    'Sample collapsible candidates (top 25 by pair count desc)',
    candidates
      .filter(candidate => candidate.fullyCollapsible)
      .sort((a, b) => b.pairs.length - a.pairs.length)
      .slice(0, 25)
      .map(candidate => ({
        userId: candidate.userId,
        tailSubscriptionId: candidate.tailSubscriptionId,
        tailCreatedAt: candidate.tailCreatedAt,
        currentAmbiguousRows: candidate.currentAmbiguousRowCount,
        pairsToWrite: candidate.pairs.length,
        oldestSourceCreatedAt: candidate.pairs[0]?.sourceCreatedAt ?? null,
      }))
  );
  if (nonCollapsible.length > 0) {
    printSection(
      'Non-collapsible users (pre-existing partial chain blocks full collapse; require manual review)',
      nonCollapsible.slice(0, 25).map(candidate => ({
        userId: candidate.userId,
        currentAmbiguousRows: candidate.currentAmbiguousRowCount,
        pairsPlanned: candidate.pairs.length,
        ambiguousRowsRemainingAfterPlan:
          candidate.currentAmbiguousRowCount - candidate.pairs.length,
      }))
    );
  }
}

async function applyMultiRowAllDestroyedCollapseRow(
  candidate: MultiRowAllDestroyedCandidate
): Promise<{ outcome: MultiRowAllDestroyedOutcome; pairsWritten: number }> {
  return await db.transaction(async tx => {
    // Re-read the user's full personal history inside the tx and rebuild the
    // pair plan from scratch. This keeps us safe under reprovision/transfer
    // races between preview and apply (new rows arrived, some rows got
    // transferred out of band, etc.) without needing explicit row locks. The
    // cost is a small duplication of the builder logic on a single user.
    //
    // The SELECT pulls all columns (not a narrow projection) so the same row
    // objects serve both as the re-verification dataset and as the `before`
    // snapshots for the change-log — no per-pair SELECT roundtrip needed.
    const joinedRows = await tx
      .select({
        subscription: kiloclaw_subscriptions,
        instanceDestroyedAt: kiloclaw_instances.destroyed_at,
      })
      .from(kiloclaw_subscriptions)
      .innerJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
      .where(
        and(
          eq(kiloclaw_subscriptions.user_id, candidate.userId),
          eq(kiloclaw_instances.user_id, kiloclaw_subscriptions.user_id),
          isNull(kiloclaw_instances.organization_id)
        )
      )
      .orderBy(asc(kiloclaw_subscriptions.created_at), asc(kiloclaw_subscriptions.id));

    const currentAmbiguous = joinedRows.filter(
      row => row.subscription.transferred_to_subscription_id === null
    );
    if (currentAmbiguous.length < 2) {
      return { outcome: 'skipped_no_longer_ambiguous' as const, pairsWritten: 0 };
    }
    if (currentAmbiguous.some(row => row.instanceDestroyedAt === null)) {
      // A new live instance was provisioned between preview and apply — guard
      // will pick that row at runtime. No collapse needed.
      return { outcome: 'skipped_no_longer_ambiguous' as const, pairsWritten: 0 };
    }

    const plannedPairs = planMultiRowAllDestroyedPairsFromJoinedRows(joinedRows);

    // A partial plan would replace the guard-firing shape with a different
    // guard-firing shape and obscure the broken state in the change log.
    // Require that applying the plan reduces the ambiguous set to exactly one
    // tail row before writing anything. This also covers the degenerate
    // `plannedPairs.length === 0` case: `currentAmbiguous.length >= 2` by
    // guard above, so zero pairs cannot satisfy `- plannedPairs.length === 1`.
    if (currentAmbiguous.length - plannedPairs.length !== 1) {
      return { outcome: 'skipped_not_collapsible' as const, pairsWritten: 0 };
    }

    // Apply each UPDATE individually but capture the after-row for batched
    // change-log writes at the end of the user. Doing the UPDATEs in a
    // single bulk-statement (UPDATE ... FROM VALUES) would save another
    // N-1 roundtrips per user but would require raw SQL and a driver-
    // specific RETURNING-row shape; the per-pair update is easy to reason
    // about, keeps drizzle's types intact, and the big win here is already
    // the dropped per-pair before-SELECT plus the batched change-log INSERT.
    //
    // `updated_at` is auto-updated by the schema's $onUpdateFn, so we never
    // need to stamp it manually.
    const appliedPairs: Array<{ before: KiloClawSubscription; after: KiloClawSubscription }> = [];
    for (const pair of plannedPairs) {
      const [after] = await tx
        .update(kiloclaw_subscriptions)
        .set({ transferred_to_subscription_id: pair.targetId })
        .where(
          and(
            eq(kiloclaw_subscriptions.id, pair.before.id),
            isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
          )
        )
        .returning();

      if (!after) {
        // Source was concurrently transferred by another process. Fine — the
        // row is no longer ambiguous. Move on.
        continue;
      }

      appliedPairs.push({ before: pair.before, after });
    }

    if (appliedPairs.length === 0) {
      return { outcome: 'skipped_race' as const, pairsWritten: 0 };
    }

    // Single bulk INSERT for the whole user's change-log rows instead of
    // one INSERT per pair. This mirrors the pattern in
    // applyMissingPersonalDestroyedTerminalBulk.
    await tx.insert(kiloclaw_subscription_change_log).values(
      appliedPairs.map(({ before, after }) => ({
        subscription_id: after.id,
        actor_type: ALIGNMENT_SCRIPT_ACTOR.actorType,
        actor_id: ALIGNMENT_SCRIPT_ACTOR.actorId,
        action: 'reassigned' as const,
        reason: 'apply_multi_row_all_destroyed_collapse',
        before_state: serializeKiloClawSubscriptionSnapshot(before),
        after_state: serializeKiloClawSubscriptionSnapshot(after),
      }))
    );

    return { outcome: 'collapsed' as const, pairsWritten: appliedPairs.length };
  });
}

async function applyMultiRowAllDestroyedCollapseChunkBulk(params: {
  chunk: MultiRowAllDestroyedCandidate[];
}): Promise<{
  usersCollapsed: number;
  pairsWritten: number;
  usersWithNoWork: number;
  usersNotCollapsible: number;
}> {
  return await db.transaction(async tx => {
    const userIds = params.chunk.map(candidate => candidate.userId);

    // 1. Single multi-user SELECT: every personal-instance row for every user
    //    in the chunk. Grouped in memory below so pair-planning is identical
    //    to the per-user path.
    const joinedRows = await tx
      .select({
        subscription: kiloclaw_subscriptions,
        instanceDestroyedAt: kiloclaw_instances.destroyed_at,
      })
      .from(kiloclaw_subscriptions)
      .innerJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
      .where(
        and(
          inArray(kiloclaw_subscriptions.user_id, userIds),
          eq(kiloclaw_instances.user_id, kiloclaw_subscriptions.user_id),
          isNull(kiloclaw_instances.organization_id)
        )
      )
      .orderBy(
        asc(kiloclaw_subscriptions.user_id),
        asc(kiloclaw_subscriptions.created_at),
        asc(kiloclaw_subscriptions.id)
      );

    const byUser = new Map<string, typeof joinedRows>();
    for (const row of joinedRows) {
      const uid = row.subscription.user_id;
      const existing = byUser.get(uid);
      if (existing) {
        existing.push(row);
      } else {
        byUser.set(uid, [row]);
      }
    }

    // 2. Build every user's pair plan. Re-verifies the guard-firing invariant
    //    inside the tx (just like the per-user path). `allPlannedPairs` keeps
    //    the user id alongside each pair so we can tally per-user outcomes
    //    after the RETURNING set comes back.
    type PlannedPair = {
      userId: string;
      before: KiloClawSubscription;
      targetId: string;
    };
    const allPlannedPairs: PlannedPair[] = [];
    let usersWithNoWork = 0;
    let usersNotCollapsible = 0;

    for (const candidate of params.chunk) {
      const userRows = byUser.get(candidate.userId);
      if (!userRows || userRows.length < 2) {
        usersWithNoWork += 1;
        continue;
      }
      const currentAmbiguous = userRows.filter(
        row => row.subscription.transferred_to_subscription_id === null
      );
      if (currentAmbiguous.length < 2) {
        usersWithNoWork += 1;
        continue;
      }
      if (currentAmbiguous.some(row => row.instanceDestroyedAt === null)) {
        usersWithNoWork += 1;
        continue;
      }

      const plannedPairs = planMultiRowAllDestroyedPairsFromJoinedRows(userRows);

      // Skip non-collapsible users: writing their partial chain would replace
      // one guard-firing shape with another and still leave the user broken.
      // `plannedPairs.length === 0` is also caught here because
      // `currentAmbiguous.length >= 2` above (zero pairs would leave `!== 1`).
      if (currentAmbiguous.length - plannedPairs.length !== 1) {
        usersNotCollapsible += 1;
        continue;
      }

      for (const pair of plannedPairs) {
        allPlannedPairs.push({
          userId: candidate.userId,
          before: pair.before,
          targetId: pair.targetId,
        });
      }
    }

    if (allPlannedPairs.length === 0) {
      return { usersCollapsed: 0, pairsWritten: 0, usersWithNoWork, usersNotCollapsible };
    }

    // 3. One raw-SQL bulk UPDATE for every pair in the chunk. FROM VALUES is
    //    the cleanest Postgres pattern for this — each `(source_id, target_id)`
    //    tuple drives one UPDATE row. The `transferred_to_subscription_id IS NULL`
    //    guard in the WHERE clause provides optimistic-concurrency against
    //    external writes; rows that raced are silently dropped from the
    //    RETURNING set. `updated_at` is auto-stamped by the schema's
    //    $onUpdateFn.
    const valuesFragments = allPlannedPairs.map(
      pair => sql`(${pair.before.id}::uuid, ${pair.targetId}::uuid)`
    );

    const { rows: updatedRows } = await tx.execute<{
      id: string;
      updated_at: string;
    }>(sql`
      UPDATE ${kiloclaw_subscriptions} AS s
      SET transferred_to_subscription_id = v.target_id
      FROM (VALUES ${sql.join(valuesFragments, sql`, `)}) AS v(source_id, target_id)
      WHERE s.id = v.source_id
        AND s.transferred_to_subscription_id IS NULL
      RETURNING s.id AS id, s.updated_at AS updated_at
    `);

    if (updatedRows.length === 0) {
      return { usersCollapsed: 0, pairsWritten: 0, usersWithNoWork, usersNotCollapsible };
    }

    // 4. Reconstruct the `after` snapshot for each updated row from the
    //    in-memory before + planned target id + fresh updated_at stamp.
    //    Cheaper than returning every column from Postgres.
    const plannedById = new Map(allPlannedPairs.map(pair => [pair.before.id, pair]));

    const changeLogRows = updatedRows.flatMap(updated => {
      const planned = plannedById.get(updated.id);
      if (!planned) return [];
      const after: KiloClawSubscription = {
        ...planned.before,
        transferred_to_subscription_id: planned.targetId,
        updated_at: updated.updated_at,
      };
      return [
        {
          subscription_id: updated.id,
          actor_type: ALIGNMENT_SCRIPT_ACTOR.actorType,
          actor_id: ALIGNMENT_SCRIPT_ACTOR.actorId,
          action: 'reassigned' as const,
          reason: 'apply_multi_row_all_destroyed_collapse',
          before_state: serializeKiloClawSubscriptionSnapshot(planned.before),
          after_state: serializeKiloClawSubscriptionSnapshot(after),
        },
      ];
    });

    // 5. One bulk INSERT for every change-log row in the chunk.
    if (changeLogRows.length > 0) {
      await tx.insert(kiloclaw_subscription_change_log).values(changeLogRows);
    }

    // A user counts as collapsed if at least one of their planned pairs
    // actually landed in the RETURNING set. Users whose planned pairs all
    // raced (should be vanishingly rare at this scale) are left uncounted
    // here and will be re-checked by the final preview step.
    const touchedSourceIds = new Set(updatedRows.map(row => row.id));
    const collapsedUserIds = new Set<string>();
    for (const pair of allPlannedPairs) {
      if (touchedSourceIds.has(pair.before.id)) {
        collapsedUserIds.add(pair.userId);
      }
    }

    return {
      usersCollapsed: collapsedUserIds.size,
      pairsWritten: updatedRows.length,
      usersWithNoWork,
      usersNotCollapsible,
    };
  });
}

async function applyMultiRowAllDestroyedCollapse(options: ApplyOptions) {
  const allCandidates = await buildMultiRowAllDestroyedCandidates();
  const candidates = allCandidates.filter(candidate => candidate.fullyCollapsible);
  const nonCollapsibleCandidates = allCandidates.filter(candidate => !candidate.fullyCollapsible);
  const totalPairs = candidates.reduce((acc, row) => acc + row.pairs.length, 0);

  console.log(
    `\nmulti-row-all-destroyed apply: ${candidates.length} collapsible users, ${totalPairs} pairs to write`
  );
  if (nonCollapsibleCandidates.length > 0) {
    console.log(
      `[skip] ${nonCollapsibleCandidates.length} user(s) non-collapsible (pre-existing partial chain); require manual review`
    );
  }
  if (options.bulk) {
    console.log(
      '[bulk] enabled; processing ~250 users per transaction, per-user fallback on chunk failure'
    );
  }

  let usersCollapsed = 0;
  let pairsWritten = 0;
  let usersWithNoWork = 0;
  const skipped: Array<{ userId: string; reason: string; error?: string }> = [
    ...nonCollapsibleCandidates.map(candidate => ({
      userId: candidate.userId,
      reason: 'skipped_not_collapsible',
    })),
  ];
  const perUserFallback: MultiRowAllDestroyedCandidate[] = [];
  const startedAt = Date.now();

  if (options.bulk) {
    const bulkChunkSize = 250;
    let processed = 0;

    for (const chunk of chunkArray(candidates, bulkChunkSize)) {
      try {
        const result = await applyMultiRowAllDestroyedCollapseChunkBulk({ chunk });
        usersCollapsed += result.usersCollapsed;
        pairsWritten += result.pairsWritten;
        usersWithNoWork += result.usersWithNoWork;
        // `usersNotCollapsible` from the bulk result counts users whose
        // apply-time re-plan came back non-collapsible after the preview
        // showed them as collapsible (race with a concurrent chain write).
        // Surface them as skipped without an individual user id, since the
        // bulk path doesn't carry per-user identity out of the tx.
        for (let i = 0; i < result.usersNotCollapsible; i += 1) {
          skipped.push({ userId: '(bulk chunk)', reason: 'skipped_not_collapsible' });
        }
      } catch (error) {
        // One bad row (e.g. a UQ_kiloclaw_subscriptions_transferred_to race
        // from a concurrent webhook / reprovision) poisons the entire chunk
        // tx. Fall back to per-user for the chunk so the rest of the fleet
        // isn't held hostage by one user.
        console.error('[bulk-chunk-fail] falling back to per-user for chunk', {
          chunkSize: chunk.length,
          firstUserId: chunk[0]?.userId,
          lastUserId: chunk[chunk.length - 1]?.userId,
          error: describeError(error),
        });
        perUserFallback.push(...chunk);
      }

      processed += chunk.length;
      logApplyProgress({
        label: 'apply-multi-row-all-destroyed-bulk',
        processed,
        total: candidates.length,
        startedAt,
        every: 1,
      });
    }
  }

  const perUserQueue = options.bulk ? perUserFallback : candidates;
  if (options.bulk && perUserFallback.length > 0) {
    console.log(
      `[bulk] ${perUserFallback.length} user(s) routed to per-user fallback after chunk failure`
    );
  }

  for (const [index, candidate] of perUserQueue.entries()) {
    try {
      const result = await applyMultiRowAllDestroyedCollapseRow(candidate);
      if (result.outcome === 'collapsed') {
        usersCollapsed += 1;
        pairsWritten += result.pairsWritten;
      } else {
        skipped.push({ userId: candidate.userId, reason: result.outcome });
      }
    } catch (error) {
      console.error('multi-row-all-destroyed apply row failed', {
        userId: candidate.userId,
        tailSubscriptionId: candidate.tailSubscriptionId,
        plannedPairs: candidate.pairs.length,
        error: describeError(error),
      });
      skipped.push({
        userId: candidate.userId,
        reason: 'error',
        error: describeError(error),
      });
    }

    logApplyProgress({
      label: options.bulk
        ? 'apply-multi-row-all-destroyed-per-user-fallback'
        : 'apply-multi-row-all-destroyed',
      processed: index + 1,
      total: perUserQueue.length,
      startedAt,
      every: 50,
    });
  }

  // Derive the non-collapsible metric from the skipped set so it includes
  // preview-time detection, bulk in-tx re-plan races, and per-user in-tx
  // re-plan races. Counting only `nonCollapsibleCandidates.length` would
  // hide users whose plan was valid at preview but raced with a concurrent
  // chain write during apply.
  const usersSkippedNotCollapsible = skipped.filter(
    row => row.reason === 'skipped_not_collapsible'
  ).length;

  console.log('\nmulti-row-all-destroyed apply results');
  console.table([
    { metric: 'users_collapsed', count: usersCollapsed },
    { metric: 'pairs_written', count: pairsWritten },
    { metric: 'users_skipped_no_work', count: usersWithNoWork },
    { metric: 'users_skipped_not_collapsible', count: usersSkippedNotCollapsible },
    { metric: 'users_skipped_total', count: skipped.length },
  ]);
  printSection('Users skipped during multi-row-all-destroyed apply', skipped.slice(0, 50));
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
  const startedAt = Date.now();

  for (const [index, row] of rows.entries()) {
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
      logApplyProgress({
        label: 'apply-org',
        processed: index + 1,
        total: rows.length,
        startedAt,
        every: 50,
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

    logApplyProgress({
      label: 'apply-org',
      processed: index + 1,
      total: rows.length,
      startedAt,
      every: 50,
    });
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
  bulk: boolean;
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
    case 'preview-org-replacement':
    case 'apply-org-replacement':
    case 'preview-changelog-baseline':
    case 'apply-changelog-baseline':
    case 'preview-multi-row-all-destroyed':
    case 'apply-multi-row-all-destroyed':
      return mode;
    default:
      throw new Error(`Unsupported mode: ${inputMode}`);
  }
}

function parseApplyOptions(args: string[]): ApplyOptions {
  return {
    confirmSandboxesDestroyed: args.includes('--confirm-sandboxes-destroyed'),
    bulk: args.includes('--bulk'),
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
  'preview-org-replacement': previewOrgReplacementRepair,
  'apply-org-replacement': applyOrgReplacementRepair,
  'preview-changelog-baseline': previewChangelogBaselineBackfill,
  'apply-changelog-baseline': applyChangelogBaselineBackfill,
  'preview-multi-row-all-destroyed': previewMultiRowAllDestroyedCollapse,
  'apply-multi-row-all-destroyed': applyMultiRowAllDestroyedCollapse,
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
  const startedAt = Date.now();
  for (const [index, row] of repairable.entries()) {
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

    logApplyProgress({
      label: 'repair-detached',
      processed: index + 1,
      total: repairable.length,
      startedAt,
      every: 25,
    });
  }

  console.log(`\nDetached subscriptions repaired: ${repaired}`);
  if (failures.length > 0) {
    printSection('Detached subscriptions that failed to repair', failures);
  }
}
