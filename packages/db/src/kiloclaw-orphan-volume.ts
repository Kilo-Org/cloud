/**
 * Shared constants for the admin orphan-volume reaper.
 *
 * Lives in `@kilocode/db` so the web router (scan + classification) and the
 * kiloclaw worker's destroy endpoint import one definition — both sides
 * enforce the grace period, so they must not drift.
 */

/**
 * Minimum age, since its owning instance was destroyed, before a leftover
 * Fly volume becomes reaper-eligible. The grace period gives Fly's own
 * background reaping and the DO's `tryDeleteOrphanVolumes` sweep time to act
 * first — a week of volume cost is cheap; a wrongly-deleted volume is not.
 */
export const ORPHAN_VOLUME_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
