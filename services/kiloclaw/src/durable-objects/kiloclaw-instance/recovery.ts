import type { PersistedState } from '../../schemas/instance-config';
import type { KiloClawEnv } from '../../types';
import * as fly from '../../fly/client';
import { PREVIOUS_VOLUME_RETENTION_MS } from '../../config';
import * as regionHelpers from '../regions';
import { buildRuntimeSpec, guestFromSize, volumeNameFromSandboxId } from '../machine-config';
import type { InstanceMutableState } from './types';
import { getFlyConfig } from './types';
import {
  applyProviderState,
  getFlyProviderState,
  storageUpdate,
  syncProviderStateForStorage,
} from './state';
import { buildUserEnvVars, resolveRuntimeImageRef } from './config';
import * as gateway from './gateway';
import * as flyMachines from './fly-machines';
import { buildFlyMachineConfig } from './fly-machines';
import { doError, doWarn, toLoggable } from './log';
import type { KiloClawEventData, KiloClawEventName } from '../../utils/analytics';

export type InstanceEventInput = Omit<
  KiloClawEventData,
  | 'userId'
  | 'sandboxId'
  | 'delivery'
  | 'flyAppName'
  | 'flyMachineId'
  | 'openclawVersion'
  | 'imageTag'
  | 'flyRegion'
> & { event: KiloClawEventName };

export type RecoveryRuntime = {
  env: KiloClawEnv;
  ctx: DurableObjectState;
  state: InstanceMutableState;
  loadState: () => Promise<void>;
  persist: (patch: Partial<PersistedState>) => Promise<void>;
  scheduleAlarm: () => Promise<void>;
  emitEvent: (data: InstanceEventInput) => void;
};

export async function cleanupRecoveryPreviousVolume(
  runtime: RecoveryRuntime
): Promise<{ ok: true; deletedVolumeId: string | null }> {
  const { state } = runtime;
  const volumeId = state.recoveryPreviousVolumeId;
  if (!volumeId) {
    return { ok: true, deletedVolumeId: null };
  }

  const flyConfig = getFlyConfig(runtime.env, state);
  await flyMachines.deleteVolumeAndAttachedMachine(
    flyConfig,
    volumeId,
    'admin_recovery_previous_volume_cleanup',
    state.sandboxId ?? undefined
  );

  state.recoveryPreviousVolumeId = null;
  state.recoveryPreviousVolumeCleanupAfter = null;
  await runtime.persist({
    recoveryPreviousVolumeId: null,
    recoveryPreviousVolumeCleanupAfter: null,
  });

  return { ok: true, deletedVolumeId: volumeId };
}

export async function cleanupPendingRecoveryVolumeIfNeeded(
  runtime: RecoveryRuntime,
  reason: string
): Promise<void> {
  const { state } = runtime;
  if (!state.pendingRecoveryVolumeId) return;

  const volumeId = state.pendingRecoveryVolumeId;
  try {
    const flyConfig = getFlyConfig(runtime.env, state);
    await flyMachines.deleteVolumeAndAttachedMachine(
      flyConfig,
      volumeId,
      reason,
      state.sandboxId ?? undefined
    );
    if (state.pendingRecoveryVolumeId === volumeId) {
      state.pendingRecoveryVolumeId = null;
      await runtime.persist({ pendingRecoveryVolumeId: null });
    }
  } catch (err) {
    doWarn(state, 'pending recovery volume cleanup failed', {
      volumeId,
      error: toLoggable(err),
    });
  }
}

export async function cleanupRetainedRecoveryVolumeIfDue(
  runtime: RecoveryRuntime,
  reason: string
): Promise<void> {
  const { state } = runtime;
  if (!state.recoveryPreviousVolumeId || state.recoveryPreviousVolumeCleanupAfter === null) {
    return;
  }
  if (Date.now() < state.recoveryPreviousVolumeCleanupAfter) return;

  const volumeId = state.recoveryPreviousVolumeId;
  try {
    const flyConfig = getFlyConfig(runtime.env, state);
    await flyMachines.deleteVolumeAndAttachedMachine(
      flyConfig,
      volumeId,
      reason,
      state.sandboxId ?? undefined
    );
    if (state.recoveryPreviousVolumeId === volumeId) {
      state.recoveryPreviousVolumeId = null;
      state.recoveryPreviousVolumeCleanupAfter = null;
      await runtime.persist({
        recoveryPreviousVolumeId: null,
        recoveryPreviousVolumeCleanupAfter: null,
      });
    }
  } catch (err) {
    doWarn(state, 'retained recovery volume cleanup failed', {
      volumeId,
      error: toLoggable(err),
    });
  }
}

export async function beginUnexpectedStopRecovery(
  runtime: RecoveryRuntime,
  trigger: { flyState: 'stopped'; failCount: number }
): Promise<void> {
  const { state } = runtime;
  const recoveryStartedAt = Date.now();
  state.status = 'recovering';
  state.recoveryStartedAt = recoveryStartedAt;
  state.healthCheckFailCount = 0;
  state.pendingRecoveryVolumeId = null;
  state.lastRecoveryErrorMessage = null;
  state.lastRecoveryErrorAt = null;
  await runtime.persist({
    status: 'recovering',
    recoveryStartedAt,
    healthCheckFailCount: 0,
    pendingRecoveryVolumeId: null,
    lastRecoveryErrorMessage: null,
    lastRecoveryErrorAt: null,
  });
  await runtime.scheduleAlarm();
  runtime.emitEvent({
    event: 'instance.unexpected_stop_recovery_started',
    status: 'recovering',
    label: `alarm_${trigger.flyState}`,
    value: trigger.failCount,
  });
}

export async function failUnexpectedStopRecovery(
  runtime: RecoveryRuntime,
  message: string,
  label: string
): Promise<void> {
  const { state, ctx } = runtime;
  const currentStatus = await ctx.storage.get('status');
  if (currentStatus !== 'recovering') return;

  if (state.flyMachineId) {
    try {
      const flyConfig = getFlyConfig(runtime.env, state);
      await fly.destroyMachine(flyConfig, state.flyMachineId, true);
      state.flyMachineId = null;
      await runtime.persist({ flyMachineId: null });
    } catch (err) {
      if (!fly.isFlyNotFound(err)) {
        doWarn(state, 'failed to destroy in-progress recovery machine', {
          machineId: state.flyMachineId,
          error: toLoggable(err),
        });
      }
    }
  }

  await cleanupPendingRecoveryVolumeIfNeeded(runtime, 'unexpected_stop_recovery_failed_cleanup');

  const durationMs = state.recoveryStartedAt ? Date.now() - state.recoveryStartedAt : undefined;
  const now = Date.now();
  state.status = 'stopped';
  state.recoveryStartedAt = null;
  state.healthCheckFailCount = 0;
  state.lastStoppedAt = now;
  state.lastRecoveryErrorMessage = message;
  state.lastRecoveryErrorAt = now;
  await runtime.persist({
    status: 'stopped',
    recoveryStartedAt: null,
    healthCheckFailCount: 0,
    lastStoppedAt: now,
    lastRecoveryErrorMessage: message,
    lastRecoveryErrorAt: now,
  });

  runtime.emitEvent({
    event: 'instance.unexpected_stop_recovery_failed',
    status: 'stopped',
    label,
    error: message,
    durationMs,
  });
}

export async function completeUnexpectedStopRecovery(runtime: RecoveryRuntime): Promise<void> {
  const { state, ctx, env } = runtime;

  if (!state.flyMachineId) {
    throw new Error('Cannot complete unexpected stop recovery: missing replacement machine');
  }
  if (!state.flyVolumeId) {
    throw new Error('Cannot complete unexpected stop recovery: missing source volume');
  }
  if (!state.pendingRecoveryVolumeId) {
    throw new Error('Cannot complete unexpected stop recovery: missing replacement volume');
  }

  const flyConfig = getFlyConfig(env, state);
  const oldVolumeId = state.flyVolumeId;
  const recoveryVolumeId = state.pendingRecoveryVolumeId;

  const recoveryVolume = await fly.getVolume(flyConfig, recoveryVolumeId);
  const recoveryVolumeRegion = recoveryVolume.region;

  const healthy = await gateway.waitForHealthy(state, env);
  if (!healthy) {
    console.warn(
      '[DO] completeUnexpectedStopRecovery: gateway health probe timed out, proceeding with running status'
    );
  }

  let retainedRecoveryVolumeId: string | null = null;
  let retainedRecoveryVolumeCleanupAfter: number | null = null;
  try {
    const snapshots = await fly.listVolumeSnapshots(flyConfig, oldVolumeId);
    if (snapshots.length > 0) {
      retainedRecoveryVolumeId = oldVolumeId;
      retainedRecoveryVolumeCleanupAfter = Date.now() + PREVIOUS_VOLUME_RETENTION_MS;
    } else {
      try {
        await flyMachines.deleteVolumeAndAttachedMachine(
          flyConfig,
          oldVolumeId,
          'unexpected_stop_recovery_immediate_cleanup',
          state.sandboxId ?? undefined
        );
      } catch (cleanupErr) {
        doWarn(state, 'old recovery source volume cleanup failed; retrying via alarm', {
          volumeId: oldVolumeId,
          error: toLoggable(cleanupErr),
        });
        retainedRecoveryVolumeId = oldVolumeId;
        retainedRecoveryVolumeCleanupAfter = Date.now();
      }
    }
  } catch (snapshotErr) {
    doWarn(state, 'failed to inspect old volume snapshots; retaining for TTL cleanup', {
      volumeId: oldVolumeId,
      error: toLoggable(snapshotErr),
    });
    retainedRecoveryVolumeId = oldVolumeId;
    retainedRecoveryVolumeCleanupAfter = Date.now() + PREVIOUS_VOLUME_RETENTION_MS;
  }

  const postStatus = await ctx.storage.get('status');
  if (postStatus !== 'recovering') return;

  const now = Date.now();
  const durationMs = state.recoveryStartedAt ? now - state.recoveryStartedAt : undefined;
  state.status = 'running';
  state.flyVolumeId = recoveryVolumeId;
  state.flyRegion = recoveryVolumeRegion ?? state.flyRegion;
  state.recoveryStartedAt = null;
  state.pendingRecoveryVolumeId = null;
  state.recoveryPreviousVolumeId = retainedRecoveryVolumeId;
  state.recoveryPreviousVolumeCleanupAfter = retainedRecoveryVolumeCleanupAfter;
  state.healthCheckFailCount = 0;
  state.lastStartedAt = now;
  state.lastRecoveryErrorMessage = null;
  state.lastRecoveryErrorAt = null;
  await runtime.persist({
    status: 'running',
    flyMachineId: state.flyMachineId,
    flyVolumeId: recoveryVolumeId,
    flyRegion: state.flyRegion,
    recoveryStartedAt: null,
    pendingRecoveryVolumeId: null,
    recoveryPreviousVolumeId: retainedRecoveryVolumeId,
    recoveryPreviousVolumeCleanupAfter: retainedRecoveryVolumeCleanupAfter,
    healthCheckFailCount: 0,
    lastStartedAt: now,
    lastRecoveryErrorMessage: null,
    lastRecoveryErrorAt: null,
  });

  runtime.emitEvent({
    event: 'instance.unexpected_stop_recovery_succeeded',
    status: 'running',
    label: 'alarm_relocated',
    durationMs,
  });
  await runtime.scheduleAlarm();
}

export async function runUnexpectedStopRecoveryInBackground(
  runtime: RecoveryRuntime
): Promise<void> {
  const { state, ctx, env } = runtime;

  try {
    await runtime.loadState();

    const currentStatus = await ctx.storage.get('status');
    if (currentStatus !== 'recovering') return;

    if (!state.userId || !state.sandboxId || !state.flyVolumeId) {
      throw new Error('Cannot recover unexpected stop: missing user, sandbox, or volume');
    }

    const flyConfig = getFlyConfig(env, state);
    const oldVolumeId = state.flyVolumeId;
    let oldVolumeRegion = state.flyRegion;

    try {
      const sourceVolume = await fly.getVolume(flyConfig, oldVolumeId);
      oldVolumeRegion = sourceVolume.region;
    } catch (err) {
      if (fly.isFlyNotFound(err)) {
        throw new Error(`Cannot recover unexpected stop: source volume ${oldVolumeId} missing`);
      }
      throw err;
    }

    if (state.flyMachineId) {
      try {
        await fly.destroyMachine(flyConfig, state.flyMachineId, true);
      } catch (err) {
        if (!fly.isFlyNotFound(err)) throw err;
      }
      state.flyMachineId = null;
      await runtime.persist({ flyMachineId: null });
    }

    let recoveryVolumeId = state.pendingRecoveryVolumeId;
    let recoveryVolumeRegion: string | null = null;

    if (recoveryVolumeId) {
      try {
        const existingRecoveryVolume = await fly.getVolume(flyConfig, recoveryVolumeId);
        recoveryVolumeRegion = existingRecoveryVolume.region;
      } catch (err) {
        if (!fly.isFlyNotFound(err)) throw err;
        recoveryVolumeId = null;
        recoveryVolumeRegion = null;
        state.pendingRecoveryVolumeId = null;
        await runtime.persist({ pendingRecoveryVolumeId: null });
      }
    }

    if (!recoveryVolumeId) {
      const regions = regionHelpers.deprioritizeRegion(
        await regionHelpers.resolveRegions(env.KV_CLAW_CACHE, env.FLY_REGION),
        oldVolumeRegion
      );
      const recoveryVolume = await fly.createVolumeWithFallback(
        flyConfig,
        {
          name: volumeNameFromSandboxId(state.sandboxId),
          source_volume_id: oldVolumeId,
          compute: guestFromSize(state.machineSize),
        },
        regions,
        {
          onCapacityError: failedRegion => {
            void regionHelpers.evictCapacityRegionFromKV(env.KV_CLAW_CACHE, env, failedRegion);
          },
        }
      );
      recoveryVolumeId = recoveryVolume.id;
      recoveryVolumeRegion = recoveryVolume.region;
      state.pendingRecoveryVolumeId = recoveryVolumeId;
      await runtime.persist({ pendingRecoveryVolumeId: recoveryVolumeId });
    }

    const { envVars, bootstrapEnv, minSecretsVersion } = await buildUserEnvVars(env, ctx, state);
    const identity = {
      userId: state.userId,
      sandboxId: state.sandboxId,
      orgId: state.orgId,
      openclawVersion: state.openclawVersion,
      imageVariant: state.imageVariant,
      devCreator: env.WORKER_ENV === 'development' ? (env.DEV_CREATOR ?? null) : null,
    };
    const runtimeSpec = buildRuntimeSpec(
      resolveRuntimeImageRef(state, env),
      envVars,
      bootstrapEnv,
      state.machineSize,
      identity,
      state.provider
    );

    const previousRegion = state.flyRegion;
    state.flyRegion = recoveryVolumeRegion ?? oldVolumeRegion ?? previousRegion;
    try {
      const result = await flyMachines.createNewMachine(
        flyConfig,
        state,
        {
          ...getFlyProviderState(state),
          region: state.flyRegion,
        },
        buildFlyMachineConfig(runtimeSpec, recoveryVolumeId),
        minSecretsVersion,
        env.FLY_REGION,
        async providerResult => {
          applyProviderState(state, providerResult.providerState);
          await ctx.storage.put(
            storageUpdate(
              syncProviderStateForStorage(state, {
                provider: providerResult.providerState.provider,
                providerState: providerResult.providerState,
                ...(providerResult.corePatch ?? {}),
              })
            )
          );
        }
      );
      applyProviderState(state, result.providerState);
      await ctx.storage.put(
        storageUpdate(
          syncProviderStateForStorage(state, {
            provider: result.providerState.provider,
            providerState: result.providerState,
          })
        )
      );
    } catch (err) {
      const isStartupTimeout = err instanceof fly.FlyApiError && err.status === 408;
      if (!isStartupTimeout || !state.flyMachineId) {
        throw err;
      }

      doWarn(
        state,
        'unexpected stop recovery timed out waiting for replacement machine startup; reconcile will continue',
        {
          error: toLoggable(err),
          flyMachineId: state.flyMachineId,
          pendingRecoveryVolumeId: recoveryVolumeId,
        }
      );
      await runtime.scheduleAlarm();
      return;
    }
    if (!state.flyMachineId) {
      throw new Error('Unexpected stop recovery created no machine');
    }
    await completeUnexpectedStopRecovery(runtime);
  } catch (err) {
    doError(state, 'unexpected stop recovery failed', {
      error: toLoggable(err),
    });
    const errorMessage = err instanceof Error ? err.message : String(err);
    await failUnexpectedStopRecovery(runtime, errorMessage, 'alarm_relocated');
  }
}
