/**
 * Pure classification logic for the admin orphan-volume reaper.
 *
 * Kept free of server-only / DB imports so it can be unit-tested in
 * isolation and (if needed) shared with client components. The router
 * (`admin-kiloclaw-instances-router.ts`) owns the data-fetching; this
 * module owns the single safety decision: is a volume reapable?
 */

// The grace-period constant lives in `@kilocode/db` so the kiloclaw worker's
// destroy endpoint and this web router share one definition. Re-exported here
// so web callers still get all orphan-volume helpers from one module.
export { ORPHAN_VOLUME_GRACE_PERIOD_MS } from '@kilocode/db';

/**
 * Classification of a name-matched Fly volume found in a destroyed
 * instance's app. Only `safe_destroy` is actionable; every other value is
 * a refusal reason surfaced to the admin.
 */
export type OrphanVolumeClassification =
  | 'safe_destroy'
  | 'fly_reaping'
  | 'attached'
  | 'do_tracked'
  | 'do_alive'
  | 'do_check_failed'
  | 'subscription_active'
  | 'within_grace';

/**
 * Decide whether a volume that name-matches a destroyed instance is safe to
 * reap. The order of checks matters: the most-blocking / most-specific
 * reason wins, so the admin always sees the strongest reason a volume is
 * being withheld. Only the final fall-through is `safe_destroy`.
 */
export function classifyOrphanVolume(params: {
  volumeState: string;
  attachedMachineId: string | null;
  trackedByLiveDo: boolean;
  doStatus: string | null;
  doStatusError: string | null;
  hasAccessGrantingSubscription: boolean;
  graceElapsed: boolean;
}): OrphanVolumeClassification {
  // Cannot confirm DO state → cannot rule out a live reference. Fail closed.
  if (params.doStatusError !== null) return 'do_check_failed';
  // Fly is already removing it; leave it alone.
  if (
    params.volumeState === 'pending_destroy' ||
    params.volumeState === 'destroying' ||
    params.volumeState === 'destroyed'
  ) {
    return 'fly_reaping';
  }
  // Still backs a machine — needs the force-destroy flow, not this reaper.
  if (params.attachedMachineId !== null || params.volumeState === 'attached') return 'attached';
  // A live DO still tracks this exact volume ID.
  if (params.trackedByLiveDo) return 'do_tracked';
  // The instance is destroyed in the DB but its DO is still alive — drift.
  if (params.doStatus !== null) return 'do_alive';
  // The user still has product access; preserve their data.
  if (params.hasAccessGrantingSubscription) return 'subscription_active';
  // Destroyed too recently — let Fly / the DO sweep self-heal first.
  if (!params.graceElapsed) return 'within_grace';
  return 'safe_destroy';
}
