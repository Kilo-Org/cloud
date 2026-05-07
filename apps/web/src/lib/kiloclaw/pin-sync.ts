import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';

export type WorkerPinSync =
  | { ok: true; openclawVersion: string | null; imageTag: string | null }
  | { ok: false; error: string };

/**
 * Push a resolved admin/user/org pin (or clear) into the instance's
 * Durable Object state so the next redeploy boots the pinned image.
 *
 * The DB row in `kiloclaw_version_pins` is the intent of record; this
 * call keeps DO state (`trackedImageTag` etc.) in sync. Failures are
 * logged and returned as `{ ok: false }` — callers should not roll back
 * the DB write on worker-sync failure. A future reconciliation job can
 * handle drift if this ever fires in practice.
 *
 * `userId` is used for platform-API request attribution and as a
 * fallback DO key for legacy userId-keyed routing. For org instances
 * the DO is routed by `instanceId`, so `userId` can be any member of
 * the org (typically the actor performing the mutation).
 */
export async function pushPinToWorker(
  userId: string,
  instanceId: string,
  imageTag: string | null
): Promise<WorkerPinSync> {
  try {
    const client = new KiloClawInternalClient();
    const applied = await client.applyPinnedVersion(userId, instanceId, imageTag);
    return {
      ok: true,
      openclawVersion: applied.openclawVersion,
      imageTag: applied.imageTag,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[kiloclaw pin-sync] Failed to push pin to worker', {
      userId,
      instanceId,
      imageTag,
      error: message,
    });
    return { ok: false, error: message };
  }
}
