/**
 * Queue consumer for snapshot restore orchestration.
 *
 * Processes one restore job at a time (max_batch_size: 1). Each job:
 * 1. Checks idempotency (volume already swapped → ack and skip)
 * 2. Marks restore as started (UI transitions from "Queued" to "Restoring...")
 * 3. Stops the machine if running
 * 4. Creates a new volume from the snapshot via Fly API
 * 5. Swaps the volume reference in DO state
 * 6. Starts the machine with the restored volume
 *
 * The old volume is NOT deleted — it's retained for admin revert via Volume Reassociation.
 *
 * Idempotency: If the message is delivered more than once (at-least-once guarantee),
 * the worker checks if flyVolumeId still matches previousVolumeId. If not, the
 * restore already completed — ack and skip.
 */

import type { KiloClawEnv } from '../types';
import type { SnapshotRestoreMessage } from '../schemas/snapshot-restore';
import { SnapshotRestoreMessageSchema } from '../schemas/snapshot-restore';
import { writeEvent } from '../utils/analytics';
import * as fly from '../fly/client';

async function createRestoreVolume(
  flyConfig: { apiToken: string; appName: string },
  previousVolumeId: string,
  snapshotId: string,
  region: string
) {
  const existingVolume = await fly.getVolume(flyConfig, previousVolumeId);
  const newVolume = await fly.createVolume(flyConfig, {
    name: existingVolume.name,
    region,
    snapshot_id: snapshotId,
    size_gb: existingVolume.size_gb,
    snapshot_retention: 5,
  });
  console.log(
    `[queue] New volume created: id=${newVolume.id} region=${newVolume.region} from snapshot=${snapshotId}`
  );
  return newVolume;
}

export async function handleSnapshotRestoreQueue(
  batch: MessageBatch<SnapshotRestoreMessage>,
  env: KiloClawEnv
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = SnapshotRestoreMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error('[queue] Invalid snapshot restore message, acking to discard:', parsed.error);
      message.ack();
      continue;
    }

    const { userId, snapshotId, previousVolumeId, region, instanceId } = parsed.data;
    const doKey = instanceId ?? userId;
    const stub = env.KILOCLAW_INSTANCE.get(env.KILOCLAW_INSTANCE.idFromName(doKey));

    try {
      // Step 0: Idempotency check — has the volume already been swapped?
      const status = await stub.getStatus();
      if (status.flyVolumeId !== previousVolumeId) {
        console.log(
          `[queue] Restore already completed for user=${userId} (volume already swapped from ${previousVolumeId} to ${status.flyVolumeId}), acking`
        );
        message.ack();
        continue;
      }

      console.log(
        JSON.stringify({
          tag: 'kiloclaw_queue',
          level: 'info',
          message: 'instance.restore_started',
          userId,
          snapshotId,
          attempt: message.attempts,
        })
      );
      writeEvent(env, {
        event: 'instance.restore_started',
        delivery: 'queue',
        userId,
        status: 'restoring',
        label: `attempt_${message.attempts}`,
        value: message.attempts,
      });

      // Step 1: Stop the machine if running
      try {
        await stub.stop();
      } catch (err) {
        // stop() no-ops for non-running statuses, but may throw for unprovisioned
        console.warn('[queue] Stop during restore (non-fatal):', err);
      }

      // Step 2: Destroy the machine to release the old volume's attachment.
      // Fly only clears attached_machine_id when the machine is destroyed.
      // start() will create a fresh machine with the new volume mount.
      await stub.destroyMachineForRestore();

      // Step 3: Create new volume from snapshot via Fly API (or reuse from a prior failed attempt)
      const flyAppName = status.flyAppName ?? env.FLY_APP_NAME;
      if (!flyAppName || !env.FLY_API_TOKEN) {
        throw new Error('Missing Fly app name or API token');
      }

      const flyConfig = { apiToken: env.FLY_API_TOKEN, appName: flyAppName };

      // Check if a prior attempt already created a volume (persisted in DO state).
      // If so, reuse it to avoid orphaned billable volumes on retry.
      const debugState = await stub.getDebugState();
      let newVolume: Awaited<ReturnType<typeof fly.createVolume>>;

      if (debugState.pendingRestoreVolumeId) {
        try {
          newVolume = await fly.getVolume(flyConfig, debugState.pendingRestoreVolumeId);
          console.log(`[queue] Reusing volume from prior attempt: ${newVolume.id}`);
        } catch (volErr) {
          if (fly.isFlyNotFound(volErr)) {
            // Volume from prior attempt was deleted — create a new one
            console.warn(
              `[queue] Prior pending volume ${debugState.pendingRestoreVolumeId} not found, creating new`
            );
            newVolume = await createRestoreVolume(flyConfig, previousVolumeId, snapshotId, region);
          } else {
            // Transient error (5xx, timeout) — rethrow to retry without creating a duplicate
            throw volErr;
          }
        }
      } else {
        newVolume = await createRestoreVolume(flyConfig, previousVolumeId, snapshotId, region);
      }

      // Persist the new volume ID before swapping so retries can find it
      await stub.setPendingRestoreVolumeId(newVolume.id);

      // Step 4: Swap volume in DO state (also persists previousVolumeId for revert path)
      await stub.completeSnapshotRestore(newVolume.id, newVolume.region);

      // Step 5: Start the machine with the restored volume (creates a fresh machine)
      try {
        await stub.start(userId);
        console.log(`[queue] Machine started after restore for user=${userId}`);
      } catch (startErr) {
        // Restore succeeded even if start fails — the volume is swapped.
        // Instance is in 'stopped' state; admin can start manually.
        console.error('[queue] Failed to start machine after restore (non-fatal):', startErr);
      }

      message.ack();
      console.log(
        `[queue] Snapshot restore completed: user=${userId} snapshot=${snapshotId} oldVolume=${previousVolumeId} newVolume=${newVolume.id}`
      );
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          tag: 'kiloclaw_queue',
          level: 'error',
          message: 'instance.restore_failed',
          userId,
          snapshotId,
          attempt: message.attempts,
          error: errMessage,
        })
      );

      // If this is the last retry, reset status so the instance isn't stuck.
      // CF Queues: message.attempts starts at 1 and increments. max_retries=2 means
      // up to 3 total attempts (1 initial + 2 retries).
      if (message.attempts >= 3) {
        writeEvent(env, {
          event: 'instance.restore_failed',
          delivery: 'queue',
          userId,
          status: 'restoring',
          label: 'queue_retries_exhausted',
          error: errMessage,
          value: message.attempts,
        });
        try {
          await stub.failSnapshotRestore();
        } catch (failErr) {
          console.error('[queue] Failed to reset restore status:', failErr);
        }
      } else {
        writeEvent(env, {
          event: 'instance.restore_retry_scheduled',
          delivery: 'queue',
          userId,
          status: 'restoring',
          label: errMessage,
          value: message.attempts,
        });
      }

      message.retry();
    }
  }
}
