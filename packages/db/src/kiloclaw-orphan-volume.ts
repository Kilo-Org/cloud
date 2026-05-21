/**
 * Shared logic for the admin orphan-volume reaper.
 *
 * Lives in `@kilocode/db` so the web router (scan + classification +
 * destroy) and the kiloclaw worker's destroy endpoint import one
 * definition — both sides enforce these gates, so they must not drift.
 */

import { and, inArray, isNull } from 'drizzle-orm';

import type { WorkerDb } from './client';
import { isAccessGrantingSubscription } from './kiloclaw-personal-subscription-collapse';
import { kiloclaw_subscriptions } from './schema';

/**
 * Minimum age, since its owning instance was destroyed, before a leftover
 * Fly volume becomes reaper-eligible. The grace period gives Fly's own
 * background reaping and the DO's `tryDeleteOrphanVolumes` sweep time to act
 * first — a week of volume cost is cheap; a wrongly-deleted volume is not.
 */
export const ORPHAN_VOLUME_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimal drizzle executor surface — satisfied by both web and worker DBs. */
type OrphanVolumeContextExecutor = Pick<WorkerDb, 'select'>;

/**
 * Per-user signals that withhold a leftover volume from the orphan reaper.
 * A volume is reaper-eligible only when its owning user appears in NEITHER
 * set.
 */
export type OrphanVolumeUserProtections = {
  /**
   * Users with a current access-granting subscription — an `active` one, an
   * unsuspended `past_due` one, or a `trialing` one whose `trial_ends_at`
   * has not passed. Their data must be preserved.
   */
  accessGrantingUserIds: Set<string>;
  /**
   * Users with a current subscription whose billing `destruction_deadline`
   * is still in the future. The kiloclaw-billing lifecycle reaper is already
   * scheduled to destroy that subscription's instance (and, with it, the
   * volume) once the deadline passes — so a leftover volume is not a true
   * orphan yet. It only becomes one if that reaper later fails, i.e. once
   * the deadline is in the past and the volume is still present.
   */
  pendingDestructionUserIds: Set<string>;
};

/**
 * For the given users, resolve the per-user signals that withhold their
 * leftover volumes from the orphan reaper.
 *
 * "Current" means `transferred_to_subscription_id IS NULL` — the head of
 * any reprovision transfer chain.
 *
 * The check is per-user and deliberately ignores which instance a
 * subscription is linked to. `kiloclaw_subscriptions.instance_id` is
 * nullable, so an instance-joined version silently dropped any subscription
 * whose `instance_id` was absent — treating an active or trialing user as
 * having no access and making their leftover volumes look reapable (a
 * data-loss false positive). Keying purely on the user removes that hole.
 */
export async function getOrphanVolumeUserProtections(
  executor: OrphanVolumeContextExecutor,
  userIds: string[],
  now: Date
): Promise<OrphanVolumeUserProtections> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) {
    return { accessGrantingUserIds: new Set(), pendingDestructionUserIds: new Set() };
  }

  const currentSubscriptions = await executor
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      status: kiloclaw_subscriptions.status,
      suspended_at: kiloclaw_subscriptions.suspended_at,
      trial_ends_at: kiloclaw_subscriptions.trial_ends_at,
      destruction_deadline: kiloclaw_subscriptions.destruction_deadline,
    })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        inArray(kiloclaw_subscriptions.user_id, uniqueUserIds),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
      )
    );

  const accessGrantingUserIds = new Set<string>();
  const pendingDestructionUserIds = new Set<string>();
  for (const subscription of currentSubscriptions) {
    if (isAccessGrantingSubscription(subscription, now)) {
      accessGrantingUserIds.add(subscription.user_id);
    }
    if (
      subscription.destruction_deadline !== null &&
      new Date(subscription.destruction_deadline).getTime() > now.getTime()
    ) {
      pendingDestructionUserIds.add(subscription.user_id);
    }
  }

  return { accessGrantingUserIds, pendingDestructionUserIds };
}
