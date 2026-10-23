/**
 * Owner access revocation for a town.
 *
 * User routes check the `gastown-access` claim, but the TownDO alarm restarts
 * containers without any user request. The alarm re-checks the owner's
 * PostHog flag on a throttle and revokes container starts when it is off.
 */

import { logger } from '../../util/log.util';
import type { GastownAccessVerdict } from '../../util/gastown-access-flag.util';

export const OWNER_ACCESS_STORAGE_KEY = 'access:owner';
export const OWNER_ACCESS_CHECK_INTERVAL_MS = 10 * 60_000;

export type OwnerAccessState = {
  revoked: boolean;
  checkedAt: number;
};

export type OwnerAccessDeps = {
  getOwnerUserId: () => Promise<string | undefined>;
  evaluateAccess: (userId: string) => Promise<GastownAccessVerdict>;
  getState: () => Promise<OwnerAccessState | undefined>;
  setState: (state: OwnerAccessState) => Promise<void>;
  /** Idempotent: stores the revocation in the container DO and stops a running container. */
  applyToContainer: (revoked: boolean) => Promise<void>;
  now: () => number;
};

/** Returns whether container starts are revoked for the town owner. */
export async function refreshOwnerAccess(deps: OwnerAccessDeps): Promise<boolean> {
  const state = await deps.getState();
  const now = deps.now();
  const previous = state?.revoked ?? false;
  if (state && now - state.checkedAt < OWNER_ACCESS_CHECK_INTERVAL_MS) return previous;

  const ownerUserId = await deps.getOwnerUserId();
  if (!ownerUserId) {
    logger.warn('owner access: town has no owner user, leaving container starts unchanged');
  }
  const verdict = ownerUserId ? await deps.evaluateAccess(ownerUserId) : 'unknown';
  const revoked = verdict === 'unknown' ? previous : verdict === 'denied';
  await deps.setState({ revoked, checkedAt: now });
  if (verdict === 'unknown') return revoked;

  if (revoked !== previous) {
    logger.warn('owner access: container starts changed', { ownerUserId, revoked });
  }
  // The container call repeats on every check, so a failure heals on the next one.
  try {
    await deps.applyToContainer(revoked);
  } catch (error) {
    logger.warn('owner access: container update failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return revoked;
}
