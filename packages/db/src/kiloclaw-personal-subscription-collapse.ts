import { and, eq, isNull, ne, or } from 'drizzle-orm';

import type { WorkerDb } from './client';
import {
  insertKiloClawSubscriptionChangeLog,
  type KiloClawSubscriptionChangeActor,
} from './kiloclaw-subscription-change-log';
import { kiloclaw_instances, kiloclaw_subscriptions, type KiloClawSubscription } from './schema';

type PersonalSubscriptionCollapseWriter = Pick<WorkerDb, 'insert' | 'select' | 'update'>;

type PersonalSubscriptionRow = {
  subscription: KiloClawSubscription;
  instance: {
    id: string;
    destroyedAt: string | null;
  } | null;
};

type TransferUpdate = {
  before: KiloClawSubscription;
  transferredToSubscriptionId: string | null;
};

type TransferPlan = {
  headRow: PersonalSubscriptionRow;
  updates: TransferUpdate[];
};

type ChangeLogFailurePolicy = 'fail' | 'log';

type ChangeLogFailureContext = {
  error: unknown;
  reason: string;
  subscriptionId: string;
  userId: string;
};

type CollapseOptions = {
  changeLogFailurePolicy?: ChangeLogFailurePolicy;
  onChangeLogFailure?: (context: ChangeLogFailureContext) => Promise<void> | void;
};

type BuildTransferUpdatesOverride = (params: {
  rows: PersonalSubscriptionRow[];
  now: Date;
}) => TransferUpdate[];

export type DestroyedInstanceRow = {
  id: string;
  userId: string;
  sandboxId: string;
  organizationId: string | null;
  name: string | null;
  inboundEmailEnabled: boolean;
};

export class PersonalSubscriptionDestroyConflictError extends Error {
  readonly userId: string;
  readonly instanceId: string;
  readonly aliveCount: number;

  constructor(params: { userId: string; instanceId: string; aliveCount: number }) {
    super(
      `Refusing to collapse personal subscription chain for user ${params.userId}: found ${params.aliveCount} alive current personal rows`
    );
    this.name = 'PersonalSubscriptionDestroyConflictError';
    this.userId = params.userId;
    this.instanceId = params.instanceId;
    this.aliveCount = params.aliveCount;
  }
}

export class FundedRowDemotionRefusedError extends Error {
  readonly userId: string;
  readonly destroyedInstanceId: string;
  readonly demotionCandidateSubscriptionId: string;

  constructor(params: {
    userId: string;
    destroyedInstanceId: string;
    demotionCandidateSubscriptionId: string;
  }) {
    super(
      `Refusing to demote funded or access-granting personal subscription ${params.demotionCandidateSubscriptionId} for user ${params.userId} while destroying instance ${params.destroyedInstanceId}`
    );
    this.name = 'FundedRowDemotionRefusedError';
    this.userId = params.userId;
    this.destroyedInstanceId = params.destroyedInstanceId;
    this.demotionCandidateSubscriptionId = params.demotionCandidateSubscriptionId;
  }
}

export class PersonalSubscriptionCollapseUQConflictError extends Error {
  readonly userId: string;
  readonly selfSubscriptionId: string;
  readonly targetSubscriptionId: string;
  readonly conflictingOccupantId: string;

  constructor(params: {
    userId: string;
    selfSubscriptionId: string;
    targetSubscriptionId: string;
    conflictingOccupantId: string;
  }) {
    super(
      `Refusing to update personal subscription ${params.selfSubscriptionId} for user ${params.userId}: target ${params.targetSubscriptionId} is already occupied by ${params.conflictingOccupantId} under UQ_kiloclaw_subscriptions_transferred_to`
    );
    this.name = 'PersonalSubscriptionCollapseUQConflictError';
    this.userId = params.userId;
    this.selfSubscriptionId = params.selfSubscriptionId;
    this.targetSubscriptionId = params.targetSubscriptionId;
    this.conflictingOccupantId = params.conflictingOccupantId;
  }
}

function compareRowsByCreatedAtAndIdAscending(
  left: PersonalSubscriptionRow,
  right: PersonalSubscriptionRow
): number {
  if (left.subscription.created_at === right.subscription.created_at) {
    return left.subscription.id.localeCompare(right.subscription.id);
  }
  return left.subscription.created_at.localeCompare(right.subscription.created_at);
}

function compareRowsByCreatedAtAndIdDescending(
  left: PersonalSubscriptionRow,
  right: PersonalSubscriptionRow
): number {
  return compareRowsByCreatedAtAndIdAscending(right, left);
}

async function listPersonalSubscriptionRows(
  executor: PersonalSubscriptionCollapseWriter,
  userId: string
): Promise<PersonalSubscriptionRow[]> {
  const rows = await executor
    .select({
      subscription: kiloclaw_subscriptions,
      instance: {
        id: kiloclaw_instances.id,
        destroyedAt: kiloclaw_instances.destroyed_at,
      },
    })
    .from(kiloclaw_subscriptions)
    .leftJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, userId),
        or(
          isNull(kiloclaw_subscriptions.instance_id),
          and(eq(kiloclaw_instances.user_id, userId), isNull(kiloclaw_instances.organization_id))
        )
      )
    )
    .orderBy(kiloclaw_subscriptions.created_at, kiloclaw_subscriptions.id);

  return rows.map(row => ({
    subscription: row.subscription,
    instance: row.instance?.id
      ? {
          id: row.instance.id,
          destroyedAt: row.instance.destroyedAt,
        }
      : null,
  }));
}

function getAttachedPersonalRows(rows: PersonalSubscriptionRow[]): PersonalSubscriptionRow[] {
  return rows.filter(row => row.instance !== null);
}

function getCurrentRows(rows: PersonalSubscriptionRow[]): PersonalSubscriptionRow[] {
  return rows.filter(row => row.subscription.transferred_to_subscription_id === null);
}

function getAliveCurrentRows(rows: PersonalSubscriptionRow[]): PersonalSubscriptionRow[] {
  return getCurrentRows(rows).filter(row => row.instance?.destroyedAt === null);
}

/**
 * Whether a subscription row currently grants the user product access.
 *
 * `active` always grants; `past_due` grants until suspended; `trialing`
 * grants until the trial end passes. `canceled` / `unpaid` never grant.
 * Exported so callers that must preserve user data for paying/trialing
 * users (e.g. the orphan-volume reaper) share one definition of "active".
 */
export function isAccessGrantingSubscription(
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

function getHeadSelectionPriority(
  row: Pick<
    KiloClawSubscription,
    'plan' | 'status' | 'stripe_subscription_id' | 'suspended_at' | 'trial_ends_at'
  >,
  now: Date
): number {
  if (row.stripe_subscription_id !== null) {
    return 4;
  }
  if (row.plan === 'commit' && row.status === 'active') {
    return 3;
  }
  if (row.plan === 'standard' && row.status === 'active') {
    return 2;
  }
  if (
    (row.status === 'trialing' && row.suspended_at === null && row.trial_ends_at === null) ||
    (row.status !== 'active' && isAccessGrantingSubscription(row, now))
  ) {
    return 1;
  }
  return 0;
}

function compareRowsByHeadSelectionPriority(
  left: PersonalSubscriptionRow,
  right: PersonalSubscriptionRow,
  now: Date
): number {
  const priorityDifference =
    getHeadSelectionPriority(right.subscription, now) -
    getHeadSelectionPriority(left.subscription, now);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }
  return compareRowsByCreatedAtAndIdDescending(left, right);
}

function selectTransferHeadRow(
  rows: PersonalSubscriptionRow[],
  now: Date
): PersonalSubscriptionRow {
  const [headRow] = [...rows].sort((left, right) =>
    compareRowsByHeadSelectionPriority(left, right, now)
  );
  if (!headRow) {
    throw new Error('Cannot select a personal subscription collapse head from an empty row set');
  }
  return headRow;
}

function buildDesiredTransferUpdates(params: {
  rows: PersonalSubscriptionRow[];
  headCandidateRows: PersonalSubscriptionRow[];
  now: Date;
}): TransferPlan {
  const { rows, headCandidateRows, now } = params;
  const headRow = selectTransferHeadRow(headCandidateRows, now);
  const nonHeadRowsDescending = rows
    .filter(row => row.subscription.id !== headRow.subscription.id)
    .sort(compareRowsByCreatedAtAndIdDescending);
  const desiredChainTailToHead = [...nonHeadRowsDescending].reverse();
  desiredChainTailToHead.push(headRow);

  const updates: TransferUpdate[] = [];

  for (const [index, row] of desiredChainTailToHead.entries()) {
    const nextRow = desiredChainTailToHead[index + 1];
    const desiredTransferredTo = nextRow?.subscription.id ?? null;
    if (row.subscription.transferred_to_subscription_id === desiredTransferredTo) {
      continue;
    }
    updates.push({
      before: row.subscription,
      transferredToSubscriptionId: desiredTransferredTo,
    });
  }

  return { headRow, updates };
}

function orderTransferUpdatesForUniqueIndex(
  rows: PersonalSubscriptionRow[],
  updates: TransferUpdate[]
): TransferUpdate[] {
  if (updates.length <= 1) {
    return updates;
  }

  const remainingUpdates = new Map(updates.map(update => [update.before.id, update]));
  const currentOccupantByTarget = new Map<string, string>();

  for (const row of rows) {
    if (row.subscription.transferred_to_subscription_id !== null) {
      currentOccupantByTarget.set(
        row.subscription.transferred_to_subscription_id,
        row.subscription.id
      );
    }
  }

  const orderedUpdates: TransferUpdate[] = [];

  while (remainingUpdates.size > 0) {
    let appliedAtLeastOneUpdate = false;

    for (const update of updates) {
      if (!remainingUpdates.has(update.before.id)) {
        continue;
      }

      const targetId = update.transferredToSubscriptionId;
      const targetOccupantId = targetId ? currentOccupantByTarget.get(targetId) : undefined;
      const targetIsBlockedByPendingUpdate =
        targetId !== null &&
        targetOccupantId !== undefined &&
        targetOccupantId !== update.before.id &&
        remainingUpdates.has(targetOccupantId);

      if (targetIsBlockedByPendingUpdate) {
        continue;
      }

      orderedUpdates.push(update);
      remainingUpdates.delete(update.before.id);
      appliedAtLeastOneUpdate = true;

      if (
        update.before.transferred_to_subscription_id !== null &&
        currentOccupantByTarget.get(update.before.transferred_to_subscription_id) ===
          update.before.id
      ) {
        currentOccupantByTarget.delete(update.before.transferred_to_subscription_id);
      }

      if (targetId !== null) {
        currentOccupantByTarget.set(targetId, update.before.id);
      }
    }

    if (appliedAtLeastOneUpdate) {
      continue;
    }

    throw new Error(
      'Unable to order personal subscription collapse updates without violating UQ_kiloclaw_subscriptions_transferred_to'
    );
  }

  return orderedUpdates;
}

function buildTransferPlan(params: {
  rows: PersonalSubscriptionRow[];
  headCandidateRows: PersonalSubscriptionRow[];
  now: Date;
}): TransferPlan {
  const desiredPlan = buildDesiredTransferUpdates(params);
  return {
    headRow: desiredPlan.headRow,
    updates: orderTransferUpdatesForUniqueIndex(params.rows, desiredPlan.updates),
  };
}

async function assertTransferTargetSlotAvailable(params: {
  executor: PersonalSubscriptionCollapseWriter;
  update: TransferUpdate;
  userId: string;
}): Promise<void> {
  const targetSubscriptionId = params.update.transferredToSubscriptionId;
  if (targetSubscriptionId === null) {
    return;
  }

  const [conflictingOccupant] = await params.executor
    .select({ id: kiloclaw_subscriptions.id })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.transferred_to_subscription_id, targetSubscriptionId),
        ne(kiloclaw_subscriptions.id, params.update.before.id)
      )
    )
    .limit(1);

  if (!conflictingOccupant) {
    return;
  }

  throw new PersonalSubscriptionCollapseUQConflictError({
    userId: params.userId,
    selfSubscriptionId: params.update.before.id,
    targetSubscriptionId,
    conflictingOccupantId: conflictingOccupant.id,
  });
}

async function applyTransferUpdates(
  executor: PersonalSubscriptionCollapseWriter,
  updates: TransferUpdate[],
  actor: KiloClawSubscriptionChangeActor,
  reason: string,
  options: CollapseOptions,
  userId: string
): Promise<string[]> {
  const updatedSubscriptionIds: string[] = [];

  for (const update of updates) {
    await assertTransferTargetSlotAvailable({ executor, update, userId });

    const [after] = await executor
      .update(kiloclaw_subscriptions)
      .set({
        transferred_to_subscription_id: update.transferredToSubscriptionId,
      })
      .where(eq(kiloclaw_subscriptions.id, update.before.id))
      .returning();

    if (!after) {
      throw new Error(
        `Failed to update transferred_to_subscription_id for subscription ${update.before.id}`
      );
    }

    try {
      await insertKiloClawSubscriptionChangeLog(executor, {
        subscriptionId: after.id,
        actor,
        action: 'reassigned',
        reason,
        before: update.before,
        after,
      });
    } catch (error) {
      if (options.changeLogFailurePolicy !== 'log') {
        throw error;
      }

      const context = {
        error,
        reason,
        subscriptionId: after.id,
        userId: after.user_id,
      } satisfies ChangeLogFailureContext;

      if (options.onChangeLogFailure) {
        await options.onChangeLogFailure(context);
      } else {
        console.error('Failed to write personal subscription collapse change log', context);
      }
    }
    updatedSubscriptionIds.push(after.id);
  }

  return updatedSubscriptionIds;
}

/**
 * Repairs historical multi-row personal subscription drift after a personal
 * instance is destroyed. Destroying a user's only current personal instance is
 * not a billing cancellation: if its current subscription still grants access,
 * the row remains current and keeps its entitlement. A later reprovision creates
 * a successor row via the provision-bootstrap transfer path, preserving the
 * remaining trial or paid billing period without a second charge.
 */
export async function collapseOrphanPersonalSubscriptionsOnDestroy(params: {
  actor: KiloClawSubscriptionChangeActor;
  buildTransferUpdatesOverride?: BuildTransferUpdatesOverride;
  changeLogFailurePolicy?: ChangeLogFailurePolicy;
  destroyedInstanceId: string;
  executor: PersonalSubscriptionCollapseWriter;
  onChangeLogFailure?: (context: ChangeLogFailureContext) => Promise<void> | void;
  reason: string;
  userId: string;
}): Promise<{ updatedSubscriptionIds: string[] }> {
  const personalRows = await listPersonalSubscriptionRows(params.executor, params.userId);
  const attachedPersonalRows = getAttachedPersonalRows(personalRows);
  const currentRows = getCurrentRows(attachedPersonalRows);
  const aliveCurrentRows = getAliveCurrentRows(attachedPersonalRows);

  if (aliveCurrentRows.length > 1) {
    throw new PersonalSubscriptionDestroyConflictError({
      userId: params.userId,
      instanceId: params.destroyedInstanceId,
      aliveCount: aliveCurrentRows.length,
    });
  }

  const aliveRowsAfterDestroy = aliveCurrentRows.filter(
    row => row.instance?.id !== params.destroyedInstanceId
  );

  if (aliveRowsAfterDestroy.length > 0) {
    return { updatedSubscriptionIds: [] };
  }

  if (currentRows.length <= 1) {
    return { updatedSubscriptionIds: [] };
  }

  const now = new Date();
  const transferPlan = buildTransferPlan({
    rows: personalRows,
    headCandidateRows: attachedPersonalRows,
    now,
  });
  const updates =
    params.buildTransferUpdatesOverride?.({ rows: personalRows, now }) ?? transferPlan.updates;

  const attachedPersonalSubscriptionIds = new Set(
    attachedPersonalRows.map(row => row.subscription.id)
  );
  const demotionCandidate = updates.find(
    update =>
      attachedPersonalSubscriptionIds.has(update.before.id) &&
      update.transferredToSubscriptionId !== null &&
      getHeadSelectionPriority(update.before, now) > 0
  );

  if (demotionCandidate) {
    throw new FundedRowDemotionRefusedError({
      userId: params.userId,
      destroyedInstanceId: params.destroyedInstanceId,
      demotionCandidateSubscriptionId: demotionCandidate.before.id,
    });
  }

  if (updates.length === 0) {
    return { updatedSubscriptionIds: [] };
  }

  const updatedSubscriptionIds = await applyTransferUpdates(
    params.executor,
    updates,
    params.actor,
    params.reason,
    {
      changeLogFailurePolicy: params.changeLogFailurePolicy,
      onChangeLogFailure: params.onChangeLogFailure,
    },
    params.userId
  );

  console.log('personal_subscription_destroy_collapse_applied', {
    userId: params.userId,
    destroyedInstanceId: params.destroyedInstanceId,
    rowCountTotal: personalRows.length,
    rowCountAlive: personalRows.filter(row => row.instance?.destroyedAt === null).length,
    headSubscriptionId: transferPlan.headRow.subscription.id,
    headPlan: transferPlan.headRow.subscription.plan,
    headStatus: transferPlan.headRow.subscription.status,
    headStripeSubscriptionId: transferPlan.headRow.subscription.stripe_subscription_id,
    updateCount: updatedSubscriptionIds.length,
  });

  return {
    updatedSubscriptionIds,
  };
}

/**
 * Marks a personal instance destroyed without revoking any still-valid personal
 * subscription attached to it. Access-granting trial/active/past-due rows remain
 * current so the user can immediately reprovision and transfer the remaining
 * entitlement to the new instance.
 */
export async function markInstanceDestroyedWithPersonalSubscriptionCollapse(params: {
  actor: KiloClawSubscriptionChangeActor;
  buildTransferUpdatesOverride?: BuildTransferUpdatesOverride;
  changeLogFailurePolicy?: ChangeLogFailurePolicy;
  destroyedAt?: string;
  executor: PersonalSubscriptionCollapseWriter;
  instanceId: string;
  onChangeLogFailure?: (context: ChangeLogFailureContext) => Promise<void> | void;
  reason: string;
  userId: string;
}): Promise<DestroyedInstanceRow | null> {
  const [instanceBefore] = await params.executor
    .select({
      id: kiloclaw_instances.id,
      userId: kiloclaw_instances.user_id,
      sandboxId: kiloclaw_instances.sandbox_id,
      organizationId: kiloclaw_instances.organization_id,
      name: kiloclaw_instances.name,
      inboundEmailEnabled: kiloclaw_instances.inbound_email_enabled,
      destroyedAt: kiloclaw_instances.destroyed_at,
    })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.id, params.instanceId),
        eq(kiloclaw_instances.user_id, params.userId)
      )
    )
    .limit(1);

  if (!instanceBefore || instanceBefore.destroyedAt !== null) {
    return null;
  }

  if (instanceBefore.organizationId === null) {
    const aliveCurrentRows = getAliveCurrentRows(
      await listPersonalSubscriptionRows(params.executor, params.userId)
    );
    if (aliveCurrentRows.length > 1) {
      throw new PersonalSubscriptionDestroyConflictError({
        userId: params.userId,
        instanceId: params.instanceId,
        aliveCount: aliveCurrentRows.length,
      });
    }
  }

  const [destroyedInstance] = await params.executor
    .update(kiloclaw_instances)
    .set({ destroyed_at: params.destroyedAt ?? new Date().toISOString() })
    .where(
      and(
        eq(kiloclaw_instances.id, params.instanceId),
        eq(kiloclaw_instances.user_id, params.userId),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .returning({
      id: kiloclaw_instances.id,
      userId: kiloclaw_instances.user_id,
      sandboxId: kiloclaw_instances.sandbox_id,
      organizationId: kiloclaw_instances.organization_id,
      name: kiloclaw_instances.name,
      inboundEmailEnabled: kiloclaw_instances.inbound_email_enabled,
    });

  if (!destroyedInstance) {
    return null;
  }

  if (destroyedInstance.organizationId === null) {
    await collapseOrphanPersonalSubscriptionsOnDestroy({
      actor: params.actor,
      buildTransferUpdatesOverride: params.buildTransferUpdatesOverride,
      changeLogFailurePolicy: params.changeLogFailurePolicy,
      destroyedInstanceId: destroyedInstance.id,
      executor: params.executor,
      onChangeLogFailure: params.onChangeLogFailure,
      reason: params.reason,
      userId: params.userId,
    });
  }

  return destroyedInstance;
}
