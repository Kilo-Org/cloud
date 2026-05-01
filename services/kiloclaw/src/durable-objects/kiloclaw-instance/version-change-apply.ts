/**
 * Apply path for `action_type='version_change'` scheduled actions.
 *
 * Mirrors the per-instance behavior `bulkChangeVersion.applyOne` (in the
 * web router) uses: optional pin override with the same three-predicate
 * CAS, then trigger a worker restart on the new tag. Living inside the
 * DO means we can call `restartMachine` directly instead of round-trip
 * through the worker's HTTP API the way the web layer does.
 *
 * Failure modes mirror `bulkChangeVersion`'s `ApplyOutcome`:
 *   - applied   — pin removed (if needed) + worker restart kicked off
 *   - skipped:pinned                — pin exists, override_pins=false
 *   - skipped:pin_changed_in_flight — pin row replaced/updated between
 *                                     our read and the CAS delete
 *   - failed (thrown)               — worker restart returned !success
 *                                     or any unexpected error
 */
import type { WorkerDb } from '../../db';
import { selectVersionPinForInstance, deleteVersionPinWithCAS, type VersionPinRow } from '../../db';
import type { InstanceMutableState } from './types';
import { doLog, doWarn, toLoggable } from './log';
import type { DueScheduledActionTarget } from '../../db';

export type VersionChangeOutcome =
  | { kind: 'applied' }
  | { kind: 'skipped'; reason: 'pinned' | 'pin_changed_in_flight' };

export async function applyVersionChangeForTarget(args: {
  db: WorkerDb;
  state: InstanceMutableState;
  target: DueScheduledActionTarget;
  /**
   * Triggers the DO's existing redeploy machinery on the chosen
   * imageTag. Wired by the caller to `this.restartMachine({ imageTag })`
   * inside the DO. Throws if the underlying restart returns !success.
   */
  restartCurrentInstance: (imageTag: string) => Promise<void>;
}): Promise<VersionChangeOutcome> {
  const { db, state, target, restartCurrentInstance } = args;

  if (!target.target_image_tag) {
    // Data integrity: a version_change target should always have a
    // non-null target_image_tag (stamped at schedule time). Treat as
    // failed so the row records the issue clearly.
    throw new Error('version_change target missing target_image_tag');
  }

  // 1. Look up the pin row. If override_pins is false and a pin exists,
  // we skip — same behavior as bulkChangeVersion's pinned-skip path.
  let pin: VersionPinRow | null = null;
  try {
    pin = await selectVersionPinForInstance(db, target.instance_id);
  } catch (err) {
    doWarn(state, 'version_change apply: pin lookup failed', {
      error: toLoggable(err),
      instanceId: target.instance_id,
    });
    throw err;
  }

  if (pin && !target.override_pins) {
    doLog(state, 'version_change apply: pin present, override off, skipping', {
      instanceId: target.instance_id,
      pinTag: pin.image_tag,
    });
    return { kind: 'skipped', reason: 'pinned' };
  }

  // 2. If override is on and pin exists, delete with three-predicate
  // CAS. A miss (different id or updated_at) means the user replaced
  // their pin between our SELECT and the DELETE — record skipped so
  // the admin can reschedule with fresh information rather than
  // silently overriding the user's new write.
  let pinWasDeleted = false;
  if (pin && target.override_pins) {
    const result = await deleteVersionPinWithCAS(db, {
      instance_id: pin.instance_id,
      id: pin.id,
      updated_at: pin.updated_at,
    });
    if (!result.deleted) {
      doLog(state, 'version_change apply: pin CAS missed, skipping', {
        instanceId: target.instance_id,
      });
      return { kind: 'skipped', reason: 'pin_changed_in_flight' };
    }
    pinWasDeleted = true;
    doLog(state, 'version_change apply: pin overridden', {
      instanceId: target.instance_id,
      previousPinTag: pin.image_tag,
    });
  }

  // 3. Trigger the worker restart on the target tag. The DO's
  // restartMachine entry point flips status to 'restarting' and
  // dispatches the actual redeploy via waitUntil. If we already
  // deleted the pin and the restart fails, surface that in the
  // error message — otherwise the failed-target row will look like
  // a clean retry candidate when in fact the pin has already been
  // consumed and a retry would silently take effect with no override
  // confirmation.
  try {
    await restartCurrentInstance(target.target_image_tag);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `restart failed${pinWasDeleted ? ' (pin was already removed during this apply)' : ''}: ${detail}`
    );
  }

  return { kind: 'applied' };
}
