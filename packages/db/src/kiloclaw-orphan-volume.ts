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

/**
 * The ownership context a volume's data belongs to: a user, optionally
 * scoped to an organization. Subscription access is evaluated per context,
 * not per instance — a reprovision transfers the destroyed instance's
 * subscription row to a current successor row.
 */
export type OrphanVolumeSubscriptionContext = {
  user_id: string;
  organization_id: string | null;
};

/** Stable string key for an ownership context, for Set membership. */
export function orphanVolumeSubscriptionContextKey(
  context: OrphanVolumeSubscriptionContext
): string {
  return JSON.stringify([context.user_id, context.organization_id]);
}

/** Minimal drizzle executor surface — satisfied by both web and worker DBs. */
type OrphanVolumeContextExecutor = Pick<WorkerDb, 'select'>;

/**
 * Of the given ownership contexts, return the keys that still have a
 * **current** access-granting subscription.
 *
 * "Current" means `transferred_to_subscription_id IS NULL` — the head of
 * any reprovision transfer chain. This is why the check is context-based
 * rather than per-instance: when an instance is destroyed and reprovisioned,
 * its subscription row is transferred to the successor, so the destroyed
 * instance's own joined row no longer reflects whether the user has access.
 * Reaping a volume requires that the owning context has NO such current
 * access-granting subscription.
 */
export async function getAccessGrantingOrphanVolumeContexts(
  executor: OrphanVolumeContextExecutor,
  contexts: OrphanVolumeSubscriptionContext[],
  now: Date
): Promise<Set<string>> {
  const requestedContextKeys = new Set(contexts.map(orphanVolumeSubscriptionContextKey));
  const userIds = [...new Set(contexts.map(context => context.user_id))];
  if (userIds.length === 0) {
    return new Set();
  }

  const currentSubscriptions = await executor
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      organization_id: kiloclaw_instances.organization_id,
      status: kiloclaw_subscriptions.status,
      suspended_at: kiloclaw_subscriptions.suspended_at,
      trial_ends_at: kiloclaw_subscriptions.trial_ends_at,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        inArray(kiloclaw_subscriptions.user_id, userIds),
        eq(kiloclaw_instances.user_id, kiloclaw_subscriptions.user_id),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
      )
    );

  const accessGrantingContextKeys = new Set<string>();
  for (const subscription of currentSubscriptions) {
    const contextKey = orphanVolumeSubscriptionContextKey(subscription);
    if (requestedContextKeys.has(contextKey) && isAccessGrantingSubscription(subscription, now)) {
      accessGrantingContextKeys.add(contextKey);
    }
  }

  return accessGrantingContextKeys;
}
