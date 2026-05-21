/**
 * Pure classification logic for the admin orphan-volume reaper.
 *
 * Kept free of server-only / DB imports so it can be unit-tested in
 * isolation and (if needed) shared with client components. The router
 * (`admin-kiloclaw-instances-router.ts`) owns the data-fetching; this
 * module owns the single safety decision: is a volume reapable?
 */

/**
 * A Fly volume is only reaper-eligible once its owning instance has been
 * destroyed for at least this long. The grace period gives Fly's own
 * background reaping and the DO's `tryDeleteOrphanVolumes` sweep time to
 * act first — a week of volume cost is cheap; a wrongly-deleted volume is
 * not.
 */
export const ORPHAN_VOLUME_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

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
