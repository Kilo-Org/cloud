import { and, eq, isNotNull, isNull } from 'drizzle-orm';

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
  };
};

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

function byCreatedAtAndId(left: PersonalSubscriptionRow, right: PersonalSubscriptionRow): number {
  if (left.subscription.created_at === right.subscription.created_at) {
    return left.subscription.id.localeCompare(right.subscription.id);
  }
  return left.subscription.created_at.localeCompare(right.subscription.created_at);
}

async function listPersonalSubscriptionRows(
  executor: PersonalSubscriptionCollapseWriter,
  userId: string
): Promise<PersonalSubscriptionRow[]> {
  return await executor
    .select({
      subscription: kiloclaw_subscriptions,
      instance: {
        id: kiloclaw_instances.id,
        destroyedAt: kiloclaw_instances.destroyed_at,
      },
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, userId),
        isNotNull(kiloclaw_subscriptions.instance_id),
        eq(kiloclaw_instances.user_id, userId),
        isNull(kiloclaw_instances.organization_id)
      )
    )
    .orderBy(kiloclaw_subscriptions.created_at, kiloclaw_subscriptions.id);
}

function getCurrentRows(rows: PersonalSubscriptionRow[]): PersonalSubscriptionRow[] {
  return rows.filter(row => row.subscription.transferred_to_subscription_id === null);
}

function getAliveCurrentRows(rows: PersonalSubscriptionRow[]): PersonalSubscriptionRow[] {
  return getCurrentRows(rows).filter(row => row.instance.destroyedAt === null);
}

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

function shouldCancelSingleDestroyedCurrentAccessRow(row: KiloClawSubscription): boolean {
  if (row.stripe_subscription_id !== null) {
    return false;
  }
  if (row.plan === 'trial' && row.status === 'trialing' && row.payment_source === null) {
    return true;
  }
  return (
    (row.plan === 'standard' || row.plan === 'commit') &&
    row.status === 'active' &&
    row.payment_source === 'credits'
  );
}

type TransferUpdate = {
  before: KiloClawSubscription;
  transferredToSubscriptionId: string | null;
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
  cancelSingleCurrentAccessRow?: boolean;
  onChangeLogFailure?: (context: ChangeLogFailureContext) => Promise<void> | void;
};

function buildTransferUpdates(rows: PersonalSubscriptionRow[]): TransferUpdate[] {
  const orderedRows = [...rows].sort(byCreatedAtAndId);
  const updates: TransferUpdate[] = [];

  for (const [index, row] of orderedRows.entries()) {
    const nextRow = orderedRows[index + 1];
    const desiredTransferredTo = nextRow?.subscription.id ?? null;
    if (row.subscription.transferred_to_subscription_id === desiredTransferredTo) {
      continue;
    }
    updates.push({
      before: row.subscription,
      transferredToSubscriptionId: desiredTransferredTo,
    });
  }

  return updates;
}

async function cancelSingleDestroyedCurrentAccessRow(params: {
  actor: KiloClawSubscriptionChangeActor;
  executor: PersonalSubscriptionCollapseWriter;
  reason: string;
  row: KiloClawSubscription;
}): Promise<string | null> {
  if (!isAccessGrantingSubscription(params.row, new Date())) {
    return null;
  }
  if (!shouldCancelSingleDestroyedCurrentAccessRow(params.row)) {
    return null;
  }

  const [after] = await params.executor
    .update(kiloclaw_subscriptions)
    .set({
      status: 'canceled',
      suspended_at: null,
      destruction_deadline: null,
      auto_resume_requested_at: null,
      auto_resume_retry_after: null,
      auto_resume_attempt_count: 0,
      auto_top_up_triggered_for_period: null,
      cancel_at_period_end: false,
      pending_conversion: false,
      scheduled_plan: null,
      scheduled_by: null,
    })
    .where(eq(kiloclaw_subscriptions.id, params.row.id))
    .returning();

  if (!after) {
    throw new Error(`Failed to cancel destroyed current subscription ${params.row.id}`);
  }

  await insertKiloClawSubscriptionChangeLog(params.executor, {
    subscriptionId: after.id,
    actor: params.actor,
    action: 'canceled',
    reason: params.reason,
    before: params.row,
    after,
  });

  return after.id;
}

async function applyTransferUpdates(
  executor: PersonalSubscriptionCollapseWriter,
  updates: TransferUpdate[],
  actor: KiloClawSubscriptionChangeActor,
  reason: string,
  options: CollapseOptions
): Promise<string[]> {
  const updatedSubscriptionIds: string[] = [];

  for (const update of updates) {
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

export async function collapseOrphanPersonalSubscriptionsOnDestroy(params: {
  actor: KiloClawSubscriptionChangeActor;
  changeLogFailurePolicy?: ChangeLogFailurePolicy;
  destroyedInstanceId: string;
  executor: PersonalSubscriptionCollapseWriter;
  onChangeLogFailure?: (context: ChangeLogFailureContext) => Promise<void> | void;
  cancelSingleCurrentAccessRow?: boolean;
  reason: string;
  userId: string;
}): Promise<{ updatedSubscriptionIds: string[] }> {
  const personalRows = await listPersonalSubscriptionRows(params.executor, params.userId);
  const currentRows = getCurrentRows(personalRows);
  const aliveCurrentRows = getAliveCurrentRows(personalRows);

  if (aliveCurrentRows.length > 1) {
    throw new PersonalSubscriptionDestroyConflictError({
      userId: params.userId,
      instanceId: params.destroyedInstanceId,
      aliveCount: aliveCurrentRows.length,
    });
  }

  const aliveRowsAfterDestroy = aliveCurrentRows.filter(
    row => row.instance.id !== params.destroyedInstanceId
  );

  if (aliveRowsAfterDestroy.length > 0) {
    return { updatedSubscriptionIds: [] };
  }

  if (currentRows.length === 1) {
    if (!params.cancelSingleCurrentAccessRow) {
      return { updatedSubscriptionIds: [] };
    }

    const [currentRow] = currentRows;
    if (currentRow?.instance.id !== params.destroyedInstanceId) {
      return { updatedSubscriptionIds: [] };
    }

    const canceledSubscriptionId = await cancelSingleDestroyedCurrentAccessRow({
      actor: params.actor,
      executor: params.executor,
      reason: 'destroy_path_cancel_single_current_access_row',
      row: currentRow.subscription,
    });
    return { updatedSubscriptionIds: canceledSubscriptionId ? [canceledSubscriptionId] : [] };
  }

  const updates = buildTransferUpdates(personalRows);
  if (updates.length === 0) {
    return { updatedSubscriptionIds: [] };
  }

  return {
    updatedSubscriptionIds: await applyTransferUpdates(
      params.executor,
      updates,
      params.actor,
      params.reason,
      {
        changeLogFailurePolicy: params.changeLogFailurePolicy,
        onChangeLogFailure: params.onChangeLogFailure,
      }
    ),
  };
}

export async function markInstanceDestroyedWithPersonalSubscriptionCollapse(params: {
  actor: KiloClawSubscriptionChangeActor;
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
      changeLogFailurePolicy: params.changeLogFailurePolicy,
      destroyedInstanceId: destroyedInstance.id,
      executor: params.executor,
      cancelSingleCurrentAccessRow: true,
      onChangeLogFailure: params.onChangeLogFailure,
      reason: params.reason,
      userId: params.userId,
    });
  }

  return destroyedInstance;
}
