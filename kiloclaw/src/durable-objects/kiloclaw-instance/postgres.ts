import type { KiloClawEnv } from '../../types';
import type { EncryptedEnvelope } from '../../schemas/instance-config';
import {
  getWorkerDb,
  getActiveInstance,
  getInstanceBySandboxId,
  markInstanceDestroyed,
} from '../../db';
import { appNameFromUserId, appNameFromInstanceId } from '../../fly/apps';
import type { InstanceMutableState } from './types';
import { getAppKey, getFlyConfig } from './types';
import { storageUpdate } from './state';
import { attemptMetadataRecovery } from './reconcile';
import { doError, doWarn, toLoggable, createReconcileContext } from './log';

type RestoreOpts = {
  /** If the DO has a stored sandboxId, use it for precise lookup. */
  sandboxId?: string | null;
};

/**
 * Restore DO state from Postgres backup if SQLite was wiped.
 *
 * Lookup priority:
 * 1. If opts.sandboxId is provided, look up by sandbox_id (precise, multi-instance safe).
 * 2. Otherwise, fall back to getActiveInstance(db, userId) (legacy single-instance).
 */
export async function restoreFromPostgres(
  env: KiloClawEnv,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  userId: string,
  opts?: RestoreOpts
): Promise<void> {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    doWarn(state, 'HYPERDRIVE not configured, cannot restore from Postgres');
    return;
  }

  try {
    const db = getWorkerDb(connectionString);

    // Prefer sandboxId lookup (multi-instance safe) over userId lookup (ambiguous).
    const instance = opts?.sandboxId
      ? await getInstanceBySandboxId(db, opts.sandboxId)
      : await getActiveInstance(db, userId);

    if (!instance) {
      doWarn(state, 'No active instance found in Postgres', { userId });
      return;
    }

    console.log('[DO] Restoring state from Postgres backup for', userId);

    const envVars: Record<string, string> | null = null;
    const encryptedSecrets: Record<string, EncryptedEnvelope> | null = null;
    const channels = null;

    // Recover flyAppName from the App DO or derive deterministically.
    // Instance-keyed DOs (ki_ sandboxId) have per-instance apps (inst-{hash}),
    // legacy DOs have per-user apps (acct-{hash}).
    const appKey = getAppKey({ userId, sandboxId: instance.sandboxId });
    const appStub = env.KILOCLAW_APP.get(env.KILOCLAW_APP.idFromName(appKey));
    const prefix = env.WORKER_ENV === 'development' ? 'dev' : undefined;
    const isInstanceKeyed = appKey !== userId;
    const fallbackAppName = isInstanceKeyed
      ? await appNameFromInstanceId(appKey, prefix)
      : await appNameFromUserId(userId, prefix);
    const recoveredAppName = (await appStub.getAppName()) ?? fallbackAppName;

    await ctx.storage.put(
      storageUpdate({
        userId,
        sandboxId: instance.sandboxId,
        orgId: instance.orgId ?? null,
        status: 'provisioned',
        envVars,
        encryptedSecrets,
        channels,
        provisionedAt: Date.now(),
        lastStartedAt: null,
        lastStoppedAt: null,
        flyAppName: recoveredAppName,
        flyMachineId: null,
        flyVolumeId: null,
        flyRegion: null,
        machineSize: null,
        healthCheckFailCount: 0,
        pendingDestroyMachineId: null,
        pendingDestroyVolumeId: null,
        pendingPostgresMarkOnFinalize: false,
        openclawVersion: null,
        imageVariant: null,
        trackedImageTag: null,
        instanceFeatures: [],
      })
    );

    state.userId = userId;
    state.sandboxId = instance.sandboxId;
    state.orgId = instance.orgId ?? null;
    state.status = 'provisioned';
    state.envVars = envVars;
    state.encryptedSecrets = encryptedSecrets;
    state.channels = channels;
    state.provisionedAt = Date.now();
    state.lastStartedAt = null;
    state.lastStoppedAt = null;
    state.flyAppName = recoveredAppName;
    state.flyMachineId = null;
    state.flyVolumeId = null;
    state.flyRegion = null;
    state.machineSize = null;
    state.healthCheckFailCount = 0;
    state.pendingDestroyMachineId = null;
    state.pendingDestroyVolumeId = null;
    state.pendingPostgresMarkOnFinalize = false;
    state.lastMetadataRecoveryAt = null;
    state.openclawVersion = null;
    state.imageVariant = null;
    state.trackedImageTag = null;
    state.trackedImageDigest = null;
    state.instanceFeatures = [];
    state.loaded = true;

    console.log('[DO] Restored from Postgres: sandboxId =', instance.sandboxId);

    // Attempt to recover machine/volume IDs via Fly metadata.
    try {
      const flyConfig = getFlyConfig(env, state);
      await attemptMetadataRecovery(
        flyConfig,
        ctx,
        state,
        createReconcileContext(state, env, 'postgres_restore')
      );
    } catch (err) {
      doWarn(state, 'Metadata recovery after Postgres restore failed', {
        error: toLoggable(err),
      });
    }
  } catch (err) {
    doError(state, 'Postgres restore failed', { error: toLoggable(err) });
  }
}

/**
 * Mark the Postgres registry row as destroyed.
 */
export async function markDestroyedInPostgresHelper(
  env: KiloClawEnv,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  userId: string,
  sandboxId: string
): Promise<boolean> {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    doWarn(state, 'HYPERDRIVE not configured, skipping Postgres mark-destroyed');
    return true;
  }

  try {
    const db = getWorkerDb(connectionString);
    await markInstanceDestroyed(db, userId, sandboxId);
    state.pendingPostgresMarkOnFinalize = false;
    await ctx.storage.put(storageUpdate({ pendingPostgresMarkOnFinalize: false }));
    return true;
  } catch (err) {
    doError(state, 'Failed to mark instance destroyed in Postgres', {
      error: toLoggable(err),
    });
    return false;
  }
}
