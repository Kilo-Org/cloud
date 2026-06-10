/**
 * Shared logic for the admin orphan-volume reaper.
 *
 * Lives in `@kilocode/db` so the web router (scan + classification +
 * destroy) and the kiloclaw worker's destroy endpoint import one
 * definition — both sides enforce these gates, so they must not drift.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { WorkerDb } from './client';
import { isAccessGrantingSubscription } from './kiloclaw-personal-subscription-collapse';
import { kiloclaw_instances, kiloclaw_subscriptions } from './schema';

/**
 * Minimum age, since its owning instance was destroyed, before a leftover
 * Fly volume becomes reaper-eligible. The grace period gives Fly's own
 * background reaping and the DO's `tryDeleteOrphanVolumes` sweep time to act
 * first — a week of volume cost is cheap; a wrongly-deleted volume is not.
 */
export const ORPHAN_VOLUME_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimal drizzle executor surface — satisfied by both web and worker DBs. */
type OrphanVolumeContextExecutor = Pick<WorkerDb, 'select'>;

/** The ownership context a leftover volume belongs to. */
export type OrphanVolumeSubscriptionContext = {
  user_id: string;
  organization_id: string | null;
};

/** Signals that withhold leftover volumes from the orphan reaper. */
export type OrphanVolumeContextProtections = {
  accessGrantingContextKeys: Set<string>;
  pendingDestructionContextKeys: Set<string>;
};

/** Stable string key for a volume ownership context. */
export function orphanVolumeSubscriptionContextKey(
  context: OrphanVolumeSubscriptionContext
): string {
  return JSON.stringify([context.user_id, context.organization_id]);
}

/**
 * For the given volume ownership contexts, resolve signals that withhold
 * leftover volumes from the orphan reaper.
 *
 * "Current" means `transferred_to_subscription_id IS NULL` — the head of
 * any reprovision transfer chain. Linked subscriptions protect only their
 * exact ownership context. A current subscription with no resolvable instance
 * context is ambiguous, so it fails closed across every requested context for
 * that user instead of silently making one of their leftover volumes reapable.
 */
export async function getOrphanVolumeContextProtections(
  executor: OrphanVolumeContextExecutor,
  contexts: OrphanVolumeSubscriptionContext[],
  now: Date
): Promise<OrphanVolumeContextProtections> {
  const requestedContextKeys = new Set(contexts.map(orphanVolumeSubscriptionContextKey));
  const contextKeysByUserId = new Map<string, Set<string>>();
  for (const context of contexts) {
    const contextKey = orphanVolumeSubscriptionContextKey(context);
    const userContextKeys = contextKeysByUserId.get(context.user_id) ?? new Set<string>();
    userContextKeys.add(contextKey);
    contextKeysByUserId.set(context.user_id, userContextKeys);
  }

  const userIds = [...contextKeysByUserId.keys()];
  if (userIds.length === 0) {
    return { accessGrantingContextKeys: new Set(), pendingDestructionContextKeys: new Set() };
  }

  const currentSubscriptions = await executor
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      instance_id: kiloclaw_subscriptions.instance_id,
      instance_user_id: kiloclaw_instances.user_id,
      organization_id: kiloclaw_instances.organization_id,
      status: kiloclaw_subscriptions.status,
      suspended_at: kiloclaw_subscriptions.suspended_at,
      trial_ends_at: kiloclaw_subscriptions.trial_ends_at,
      destruction_deadline: kiloclaw_subscriptions.destruction_deadline,
    })
    .from(kiloclaw_subscriptions)
    .leftJoin(
      kiloclaw_instances,
      and(
        eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id),
        eq(kiloclaw_instances.user_id, kiloclaw_subscriptions.user_id)
      )
    )
    .where(
      and(
        inArray(kiloclaw_subscriptions.user_id, userIds),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
      )
    );

  const accessGrantingContextKeys = new Set<string>();
  const pendingDestructionContextKeys = new Set<string>();

  function addProtectedContexts(
    subscription: (typeof currentSubscriptions)[number],
    target: Set<string>
  ) {
    if (subscription.instance_id === null || subscription.instance_user_id === null) {
      for (const contextKey of contextKeysByUserId.get(subscription.user_id) ?? []) {
        target.add(contextKey);
      }
      return;
    }

    const contextKey = orphanVolumeSubscriptionContextKey({
      user_id: subscription.user_id,
      organization_id: subscription.organization_id,
    });
    if (requestedContextKeys.has(contextKey)) {
      target.add(contextKey);
    }
  }

  for (const subscription of currentSubscriptions) {
    if (isAccessGrantingSubscription(subscription, now)) {
      addProtectedContexts(subscription, accessGrantingContextKeys);
    }
    if (
      subscription.destruction_deadline !== null &&
      new Date(subscription.destruction_deadline).getTime() > now.getTime()
    ) {
      addProtectedContexts(subscription, pendingDestructionContextKeys);
    }
  }

  return { accessGrantingContextKeys, pendingDestructionContextKeys };
}
