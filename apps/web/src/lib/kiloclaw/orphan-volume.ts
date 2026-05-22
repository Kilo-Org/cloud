/**
 * Pure classification logic for the admin orphan-volume reaper.
 *
 * ── What counts as an "orphaned volume" ──────────────────────────────────
 *
 * An orphaned volume is a Fly volume left behind by a destroyed KiloClaw
 * instance that nothing will ever clean up on its own. A volume is only
 * REAPER-ELIGIBLE (`safe_destroy`) when EVERY one of these holds:
 *
 *   1. Destroyed instance — it belongs to a `kiloclaw_instances` row whose
 *      `destroyed_at` is set. Live instances are never scanned.
 *   2. Exact name attribution — `volume.name` equals
 *      `volumeNameFromSandboxId(sandbox_id)` for that instance. A volume is
 *      attributed to ONE specific destroyed instance, never "any volume in
 *      the app".
 *   3. Quiescent + unattached — volume state is `created` or `detached`
 *      with no `attached_machine_id`. `attached` means a machine still
 *      backs it; `pending_destroy`/`destroying`/`destroyed` mean Fly is
 *      already reaping it.
 *   4. No live Durable Object — `getDebugState()` reports `status: null`
 *      (the DO was finalized) AND the volume ID appears in none of the
 *      DO's volume-tracking fields. A DO that is alive, or that still
 *      references the volume, blocks reaping.
 *   5. No access-granting subscription — the owning (user, organization)
 *      context has no current access-granting subscription. This is
 *      evaluated per ownership context, not per instance, because a
 *      reprovision transfers the destroyed instance's subscription to a
 *      successor row.
 *   6. Past the grace period — destroyed more than
 *      `ORPHAN_VOLUME_GRACE_PERIOD_MS` ago, so Fly's own reaper and the
 *      DO's `tryDeleteOrphanVolumes` sweep have had time to act first.
 *   7. DO state was confirmable — if `getDebugState()` failed, the volume
 *      is `do_check_failed`, never `safe_destroy` (fail closed).
 *
 * Anything failing one of these is surfaced with a refusal reason (see
 * `OrphanVolumeClassification`) and is NOT destroyable from the UI. The
 * worker re-verifies all of the above server-side before deleting.
 *
 * Known coverage gap: detection is anchored on the `kiloclaw_instances`
 * row, so a volume whose instance row was never inserted (provision
 * crashed after volume creation) has no anchor and is not found here.
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
  | 'destruction_scheduled'
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
  destructionScheduled: boolean;
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
  // A billing destruction deadline is still pending — the kiloclaw-billing
  // lifecycle reaper is already scheduled to destroy this user's instance
  // and its volume. Not a true orphan yet; only one if that reaper fails.
  if (params.destructionScheduled) return 'destruction_scheduled';
  // Destroyed too recently — let Fly / the DO sweep self-heal first.
  if (!params.graceElapsed) return 'within_grace';
  return 'safe_destroy';
}
