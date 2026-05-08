import type { KiloClawEnv } from '../../types';
import type {
  EncryptedEnvelope,
  FlyProviderState,
  NorthflankProviderState,
} from '../../schemas/instance-config';
import { getTier, InstanceTypeSchema } from '@kilocode/kiloclaw-instance-tiers';
import {
  getWorkerDb,
  getActivePersonalInstance,
  getInstanceById,
  getInstanceBySandboxId,
  markInstanceDestroyed,
  syncAdminSizeOverride,
  syncInstanceType,
  syncTrackedImageTag,
} from '../../db';
import type { AdminSizeOverridePayload } from '../../db';
import { appNameFromUserId, appNameFromInstanceId } from '../../fly/apps';
import type { InstanceMutableState } from './types';
import { getAppKey, getFlyConfig } from './types';
import { applyProviderState, storageUpdate } from './state';
import { attemptMetadataRecovery } from './reconcile';
import { doError, doWarn, toLoggable, createReconcileContext } from './log';
import {
  isInstanceKeyedSandboxId,
  instanceIdFromSandboxId,
} from '@kilocode/worker-utils/instance-id';
import { northflankClientConfig } from '../../northflank/config';
import {
  findProjectByName,
  findProjectSecretByName,
  findServiceByName,
  findVolumeByName,
} from '../../northflank/client';
import { northflankResourceNames } from '../../providers/northflank/names';

type RestoreOpts = {
  /** If the DO has a stored sandboxId, use it for precise lookup. */
  sandboxId?: string | null;
};

type RestoredInstance = NonNullable<Awaited<ReturnType<typeof getInstanceBySandboxId>>>;

function firstNorthflankIngressHost(service: {
  ports?: Array<{ dns?: string | null }>;
}): string | null {
  return service.ports?.find(port => port.dns)?.dns ?? null;
}

async function getRestoreInstance(
  db: ReturnType<typeof getWorkerDb>,
  userId: string,
  opts?: RestoreOpts
): Promise<RestoredInstance | null> {
  if (opts?.sandboxId && isInstanceKeyedSandboxId(opts.sandboxId)) {
    const byId = await getInstanceById(db, instanceIdFromSandboxId(opts.sandboxId));
    if (byId) return byId;
  }
  if (opts?.sandboxId) {
    return await getInstanceBySandboxId(db, opts.sandboxId);
  }
  const personal = await getActivePersonalInstance(db, userId);
  return personal ? await getInstanceBySandboxId(db, personal.sandboxId) : null;
}

async function recoverNorthflankProviderState(
  env: KiloClawEnv,
  sandboxId: string
): Promise<NorthflankProviderState> {
  const config = northflankClientConfig(env);
  const names = await northflankResourceNames(sandboxId);
  const project = await findProjectByName(config, names.projectName);
  const [volume, service, secret] = await Promise.all([
    project ? findVolumeByName(config, project.id, names.volumeName) : Promise.resolve(null),
    project ? findServiceByName(config, project.id, names.serviceName) : Promise.resolve(null),
    project ? findProjectSecretByName(config, project.id, names.secretName) : Promise.resolve(null),
  ]);

  return {
    provider: 'northflank',
    projectId: project?.id ?? null,
    projectName: project?.name ?? names.projectName,
    serviceId: service?.id ?? null,
    serviceName: service?.name ?? names.serviceName,
    volumeId: volume?.id ?? null,
    volumeName: volume?.name ?? names.volumeName,
    secretId: secret?.id ?? null,
    secretName: secret?.name ?? names.secretName,
    // Recovery path: we can't derive the content hash from Northflank (secret
    // values aren't returned on find), so leave it null. The next ensureSecret
    // call will write and persist a fresh hash, treating it as a cold start.
    secretContentHash: null,
    ingressHost: service ? firstNorthflankIngressHost(service) : null,
    region: config.region,
  };
}

export async function fallbackAppNameForRestore(
  userId: string,
  sandboxId: string,
  prefix?: string
): Promise<string> {
  const appKey = getAppKey({ userId, sandboxId });
  return isInstanceKeyedSandboxId(sandboxId)
    ? appNameFromInstanceId(appKey, prefix)
    : appNameFromUserId(appKey, prefix);
}

async function recoverFlyProviderState(
  env: KiloClawEnv,
  userId: string,
  sandboxId: string
): Promise<FlyProviderState> {
  const appKey = getAppKey({ userId, sandboxId });
  const appStub = env.KILOCLAW_APP.get(env.KILOCLAW_APP.idFromName(appKey));
  const prefix = env.WORKER_ENV === 'development' ? 'dev' : undefined;
  const fallbackAppName = await fallbackAppNameForRestore(userId, sandboxId, prefix);
  const recoveredAppName = (await appStub.getAppName()) ?? fallbackAppName;
  return {
    provider: 'fly',
    appName: recoveredAppName,
    machineId: null,
    volumeId: null,
    region: null,
  };
}

/**
 * Restore DO state from Postgres backup if SQLite was wiped.
 *
 * Lookup priority:
 * 1. If opts.sandboxId is provided, look up by sandbox_id (precise, multi-instance safe).
 * 2. Otherwise, fall back to getActivePersonalInstance(db, userId) (legacy personal instance).
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

    const instance = await getRestoreInstance(db, userId, opts);

    if (!instance) {
      doWarn(state, 'No active instance found in Postgres', { userId });
      return;
    }

    const restoredUserId = instance.userId ?? userId;
    console.log('[DO] Restoring state from Postgres backup for', restoredUserId);

    const envVars: Record<string, string> | null = null;
    const encryptedSecrets: Record<string, EncryptedEnvelope> | null = null;
    const channels = null;

    // docker-local is development-only and should not be restored from Postgres.
    // Treat any non-Northflank persisted provider as Fly for legacy safety.
    const provider = instance.provider === 'northflank' ? 'northflank' : 'fly';
    const providerState =
      provider === 'northflank'
        ? await recoverNorthflankProviderState(env, instance.sandboxId)
        : await recoverFlyProviderState(env, restoredUserId, instance.sandboxId);
    const recoveredAppName = providerState.provider === 'fly' ? providerState.appName : null;
    const restoredInstanceType = InstanceTypeSchema.nullable().parse(instance.instanceType ?? null);
    // Derive hardware/storage from the catalog when the persisted tier is a
    // known offered/legacy key. Without this, a restored instance starts with
    // null `machineSize`/`volumeSizeGb` despite a non-null tier label —
    // the next live-check observes whatever Fly reports and could relabel
    // the instance incorrectly (e.g. mark a `perf-4-16` as `'custom'` if the
    // Fly machine hasn't yet been re-created with the right guest). For
    // 'custom' or null tier, leave hardware nulls; the existing live-check
    // backfill handles those.
    const restoredTier =
      restoredInstanceType && restoredInstanceType !== 'custom'
        ? getTier(restoredInstanceType)
        : null;
    const restoredMachineSize = restoredTier?.machineSize ?? null;
    const restoredVolumeSizeGb = restoredTier?.volumeSizeGb ?? null;

    await ctx.storage.put(
      storageUpdate({
        userId: restoredUserId,
        sandboxId: instance.sandboxId,
        orgId: instance.orgId ?? null,
        provider,
        providerState,
        status: 'provisioned',
        envVars,
        encryptedSecrets,
        kiloExaSearchMode: null,
        channels,
        provisionedAt: Date.now(),
        lastStartedAt: null,
        lastStoppedAt: null,
        flyAppName: recoveredAppName,
        flyMachineId: null,
        flyVolumeId: null,
        flyRegion: null,
        machineSize: restoredMachineSize,
        instanceType: restoredInstanceType,
        volumeSizeGb: restoredVolumeSizeGb,
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

    state.userId = restoredUserId;
    state.sandboxId = instance.sandboxId;
    state.orgId = instance.orgId ?? null;
    applyProviderState(state, providerState);
    state.status = 'provisioned';
    state.envVars = envVars;
    state.encryptedSecrets = encryptedSecrets;
    state.kiloExaSearchMode = null;
    state.channels = channels;
    state.provisionedAt = Date.now();
    state.lastStartedAt = null;
    state.lastStoppedAt = null;
    state.machineSize = restoredMachineSize;
    state.instanceType = restoredInstanceType;
    state.volumeSizeGb = restoredVolumeSizeGb;
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

    if (provider === 'fly') {
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
    }
  } catch (err) {
    doError(state, 'Postgres restore failed', { error: toLoggable(err) });
  }
}

/**
 * Best-effort sync of the DO's trackedImageTag to the Postgres registry row.
 *
 * This is one of the two Worker-side Postgres write carve-outs documented in
 * services/kiloclaw/AGENTS.md ("Next.js owns the Postgres registry; the Worker
 * writes only narrow operational metadata"). The DO remains the source of truth
 * for trackedImageTag; the Postgres column is a denormalized read cache that
 * exists so admin tooling can filter populations of instances by current
 * running version via SQL (Phase 1.5+ bulk version change).
 *
 * Postgres failures are logged and swallowed so they cannot break the alarm
 * reconciler. The UPDATE is a no-op at the SQL level when the value already
 * matches (IS DISTINCT FROM), keeping vacuum pressure low on idle fleets.
 */
export async function syncTrackedImageTagToPostgresHelper(
  env: KiloClawEnv,
  state: InstanceMutableState,
  userId: string,
  sandboxId: string
): Promise<void> {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) return;

  try {
    const db = getWorkerDb(connectionString);
    await syncTrackedImageTag(db, userId, sandboxId, state.trackedImageTag ?? null);
  } catch (err) {
    doWarn(state, 'Failed to sync tracked_image_tag to Postgres', {
      error: toLoggable(err),
    });
  }
}

/**
 * Best-effort sync of `state.instanceType` to the `kiloclaw_instances` row.
 *
 * Only call this from sites that have just *changed* the DO's `instanceType`
 * (resize, alarm-driven backfill from live Fly guest). Do not call from the
 * alarm tick unconditionally — that paid a Hyperdrive round trip per running
 * instance per tick for a SQL no-op once the column was populated.
 *
 * No-op when:
 * - HYPERDRIVE is not configured (dev/test),
 * - `instanceType` is null (we don't have anything authoritative to write),
 * - the column already matches (`syncInstanceType` uses `IS DISTINCT FROM`).
 */
export async function syncInstanceTypeToPostgresHelper(
  env: KiloClawEnv,
  state: InstanceMutableState,
  userId: string,
  sandboxId: string
): Promise<void> {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) return;
  if (state.instanceType === null) return;

  try {
    const db = getWorkerDb(connectionString);
    await syncInstanceType(db, userId, sandboxId, state.instanceType);
  } catch (err) {
    doWarn(state, 'Failed to sync instance_type to Postgres', {
      error: toLoggable(err),
    });
  }
}

/**
 * Best-effort sync of `state.adminMachineSizeOverride` (+ metadata) to the
 * `kiloclaw_instances.admin_size_override` JSONB column.
 *
 * Called only from sites that explicitly mutate the override
 * (`setAdminMachineSizeOverride` / `clearAdminMachineSizeOverride` / tier-resize
 * auto-clear). Not part of the alarm tick — there's no observation path; the
 * override is admin-set state, not derived state.
 *
 * Failures are logged and swallowed; the DO state is authoritative and the
 * column is a denormalized read cache for the admin "outstanding overrides"
 * list. If the write fails, the next admin set/clear/resize will try again.
 */
export async function syncAdminSizeOverrideToPostgresHelper(
  env: KiloClawEnv,
  state: InstanceMutableState,
  userId: string,
  sandboxId: string
): Promise<void> {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) return;

  const override = state.adminMachineSizeOverride;
  const metadata = state.adminMachineSizeOverrideMetadata;
  const payload: AdminSizeOverridePayload | null =
    override && metadata
      ? {
          size: override,
          reason: metadata.reason,
          actorId: metadata.actorId,
          actorEmail: metadata.actorEmail,
          setAt: metadata.setAt,
        }
      : null;

  try {
    const db = getWorkerDb(connectionString);
    await syncAdminSizeOverride(db, userId, sandboxId, payload);
  } catch (err) {
    doWarn(state, 'Failed to sync admin_size_override to Postgres', {
      error: toLoggable(err),
    });
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
