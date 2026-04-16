import 'server-only';

import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { kiloclaw_instances, kiloclaw_subscriptions } from '@kilocode/db/schema';

export type PersonalSubscriptionResolverDb = typeof db | DrizzleTransaction;

export class CurrentPersonalSubscriptionResolutionError extends Error {
  readonly userId: string;
  readonly instanceId: string | null;

  constructor(params: { userId: string; instanceId?: string; count: number }) {
    super(
      `Expected at most one current personal subscription row for user ${params.userId}, found ${params.count}`
    );
    this.name = 'CurrentPersonalSubscriptionResolutionError';
    this.userId = params.userId;
    this.instanceId = params.instanceId ?? null;
  }
}

export type CurrentPersonalSubscriptionRow = {
  subscription: typeof kiloclaw_subscriptions.$inferSelect;
  instance: {
    id: string;
    userId: string;
    sandboxId: string;
    name: string | null;
    destroyedAt: string | null;
    organizationId: string | null;
  } | null;
};

function personalCurrentSubscriptionWhere(params: { userId: string; instanceId?: string }) {
  return and(
    eq(kiloclaw_subscriptions.user_id, params.userId),
    isNotNull(kiloclaw_subscriptions.instance_id),
    isNull(kiloclaw_subscriptions.transferred_to_subscription_id),
    and(
      isNotNull(kiloclaw_instances.id),
      eq(kiloclaw_instances.user_id, params.userId),
      isNull(kiloclaw_instances.organization_id)
    ),
    params.instanceId ? eq(kiloclaw_subscriptions.instance_id, params.instanceId) : undefined
  );
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function destroyedSubscriptionPriority(
  subscription: typeof kiloclaw_subscriptions.$inferSelect,
  now: Date
): number {
  if (subscription.status === 'active') return 0;
  if (subscription.status === 'past_due' && !subscription.suspended_at) return 1;
  if (
    subscription.status === 'trialing' &&
    subscription.trial_ends_at &&
    new Date(subscription.trial_ends_at) > now
  ) {
    return 2;
  }
  return 3;
}

function destroyedSubscriptionRecency(
  subscription: typeof kiloclaw_subscriptions.$inferSelect
): number {
  return Math.max(
    parseTimestamp(subscription.current_period_end),
    parseTimestamp(subscription.credit_renewal_at),
    parseTimestamp(subscription.trial_ends_at),
    parseTimestamp(subscription.updated_at),
    parseTimestamp(subscription.created_at)
  );
}

export async function listCurrentPersonalSubscriptionRows(params: {
  userId: string;
  dbOrTx?: PersonalSubscriptionResolverDb;
}): Promise<CurrentPersonalSubscriptionRow[]> {
  const executor = params.dbOrTx ?? db;

  return await executor
    .select({
      subscription: kiloclaw_subscriptions,
      instance: {
        id: kiloclaw_instances.id,
        userId: kiloclaw_instances.user_id,
        sandboxId: kiloclaw_instances.sandbox_id,
        name: kiloclaw_instances.name,
        destroyedAt: kiloclaw_instances.destroyed_at,
        organizationId: kiloclaw_instances.organization_id,
      },
    })
    .from(kiloclaw_subscriptions)
    .leftJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(personalCurrentSubscriptionWhere({ userId: params.userId }));
}

export async function resolveCurrentPersonalSubscriptionRow(params: {
  userId: string;
  instanceId?: string;
  dbOrTx?: PersonalSubscriptionResolverDb;
}): Promise<CurrentPersonalSubscriptionRow | null> {
  const now = new Date();
  const executor = params.dbOrTx ?? db;
  const rows = await executor
    .select({
      subscription: kiloclaw_subscriptions,
      instance: {
        id: kiloclaw_instances.id,
        userId: kiloclaw_instances.user_id,
        sandboxId: kiloclaw_instances.sandbox_id,
        name: kiloclaw_instances.name,
        destroyedAt: kiloclaw_instances.destroyed_at,
        organizationId: kiloclaw_instances.organization_id,
      },
    })
    .from(kiloclaw_subscriptions)
    .leftJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      personalCurrentSubscriptionWhere({
        userId: params.userId,
        instanceId: params.instanceId,
      })
    );

  const activeRows = rows.filter(row => row.instance?.destroyedAt === null);
  if (activeRows.length > 1) {
    throw new CurrentPersonalSubscriptionResolutionError({
      userId: params.userId,
      instanceId: params.instanceId,
      count: activeRows.length,
    });
  }
  if (activeRows[0]) {
    return activeRows[0];
  }
  if (rows.length <= 1) {
    return rows[0] ?? null;
  }

  return (
    [...rows].sort((left, right) => {
      const priorityDiff =
        destroyedSubscriptionPriority(left.subscription, now) -
        destroyedSubscriptionPriority(right.subscription, now);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      const recencyDiff =
        destroyedSubscriptionRecency(right.subscription) -
        destroyedSubscriptionRecency(left.subscription);
      if (recencyDiff !== 0) {
        return recencyDiff;
      }

      return right.subscription.id.localeCompare(left.subscription.id);
    })[0] ?? null
  );
}
