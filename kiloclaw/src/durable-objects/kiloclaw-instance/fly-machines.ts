import type { KiloClawEnv } from '../../types';
import type { FlyClientConfig } from '../../fly/client';
import type { FlyMachineConfig } from '../../fly/types';
import * as fly from '../../fly/client';
import {
  DEFAULT_VOLUME_SIZE_GB,
  STARTUP_TIMEOUT_SECONDS,
  STALE_PROVISION_THRESHOLD_MS,
} from '../../config';
import {
  parseRegions,
  deprioritizeRegion,
  resolveRegions,
  evictCapacityRegionFromKV,
} from '../regions';
import { guestFromSize, volumeNameFromSandboxId } from '../machine-config';
import type { InstanceMutableState } from './types';
import { storageUpdate } from './state';
import { reconcileLog, doError, doWarn, toLoggable } from './log';

/**
 * Ensure a Fly Volume exists. Creates one if flyVolumeId is null.
 */
export async function ensureVolume(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  env: KiloClawEnv,
  reason: string
): Promise<void> {
  if (state.flyVolumeId) return;
  if (!state.sandboxId) return;

  const regions = state.flyRegion
    ? parseRegions(state.flyRegion)
    : await resolveRegions(env.KV_CLAW_CACHE, env.FLY_REGION);
  const volume = await fly.createVolumeWithFallback(
    flyConfig,
    {
      name: volumeNameFromSandboxId(state.sandboxId),
      size_gb: DEFAULT_VOLUME_SIZE_GB,
      compute: guestFromSize(state.machineSize),
    },
    regions,
    {
      onCapacityError: failedRegion => {
        void evictCapacityRegionFromKV(env.KV_CLAW_CACHE, env, failedRegion);
      },
    }
  );

  state.flyVolumeId = volume.id;
  state.flyRegion = volume.region;
  await ctx.storage.put(storageUpdate({ flyVolumeId: volume.id, flyRegion: volume.region }));

  reconcileLog(reason, 'create_volume', {
    fly_app_name: flyConfig.appName,
    volume_id: volume.id,
    region: volume.region,
  });
}

/**
 * Replace a stranded volume whose host has no capacity.
 */
export async function replaceStrandedVolume(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  env: KiloClawEnv,
  reason: string
): Promise<void> {
  if (!state.sandboxId || !state.flyVolumeId) return;

  const oldVolumeId = state.flyVolumeId;
  const oldRegion = state.flyRegion;
  const hasUserData = state.lastStartedAt !== null;
  const allRegions = await resolveRegions(env.KV_CLAW_CACHE, env.FLY_REGION);
  const regions = deprioritizeRegion(allRegions, oldRegion);
  const compute = guestFromSize(state.machineSize);

  // Destroy existing machine if any — it's stuck on the constrained host.
  if (state.flyMachineId) {
    let machineGone = false;
    try {
      await fly.destroyMachine(flyConfig, state.flyMachineId);
      reconcileLog(reason, 'destroy_stranded_machine', {
        fly_app_name: flyConfig.appName,
        machine_id: state.flyMachineId,
      });
      machineGone = true;
    } catch (err) {
      if (fly.isFlyNotFound(err)) {
        machineGone = true;
      } else {
        doWarn(state, 'Failed to destroy stranded machine', {
          error: toLoggable(err),
        });
      }
    }
    if (machineGone) {
      state.flyMachineId = null;
      await ctx.storage.put(storageUpdate({ flyMachineId: null }));
    }
  }

  const capacityErrorCallback = {
    onCapacityError: (failedRegion: string) => {
      void evictCapacityRegionFromKV(env.KV_CLAW_CACHE, env, failedRegion);
    },
  };

  if (hasUserData) {
    const forkedVolume = await fly.createVolumeWithFallback(
      flyConfig,
      {
        name: volumeNameFromSandboxId(state.sandboxId),
        source_volume_id: oldVolumeId,
        compute,
      },
      regions,
      capacityErrorCallback
    );
    state.flyVolumeId = forkedVolume.id;
    state.flyRegion = forkedVolume.region;
    reconcileLog(reason, 'fork_stranded_volume', {
      fly_app_name: flyConfig.appName,
      old_volume_id: oldVolumeId,
      old_region: oldRegion,
      new_volume_id: forkedVolume.id,
      new_region: forkedVolume.region,
    });
  } else {
    state.flyVolumeId = null;
    state.flyRegion = null;
    await ctx.storage.put(storageUpdate({ flyVolumeId: null, flyRegion: null }));

    const freshVolume = await fly.createVolumeWithFallback(
      flyConfig,
      {
        name: volumeNameFromSandboxId(state.sandboxId),
        size_gb: DEFAULT_VOLUME_SIZE_GB,
        compute,
      },
      regions,
      capacityErrorCallback
    );
    state.flyVolumeId = freshVolume.id;
    state.flyRegion = freshVolume.region;
    reconcileLog(reason, 'create_replacement_volume', {
      fly_app_name: flyConfig.appName,
      old_volume_id: oldVolumeId,
      old_region: oldRegion,
      new_volume_id: freshVolume.id,
      new_region: freshVolume.region,
    });
  }

  await ctx.storage.put(
    storageUpdate({ flyVolumeId: state.flyVolumeId, flyRegion: state.flyRegion })
  );

  // Delete old volume (best-effort cleanup)
  try {
    await fly.deleteVolume(flyConfig, oldVolumeId);
    reconcileLog(reason, 'delete_stranded_volume', {
      fly_app_name: flyConfig.appName,
      volume_id: oldVolumeId,
    });
  } catch (err) {
    if (!fly.isFlyNotFound(err)) {
      doWarn(state, 'Failed to delete stranded volume (will leak)', {
        volumeId: oldVolumeId,
        error: toLoggable(err),
      });
    }
  }
}

/**
 * Try to start an existing machine. Falls back to creating a new one if
 * the existing machine is unusable (destroyed, corrupted).
 */
export async function startExistingMachine(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  initialMachineConfig: FlyMachineConfig,
  minSecretsVersion?: number,
  envFlyRegion?: string
): Promise<void> {
  if (!state.flyMachineId) return;

  try {
    const machine = await fly.getMachine(flyConfig, state.flyMachineId);

    // Backfill machineSize from live Fly machine config for legacy instances
    let machineConfig = initialMachineConfig;
    if (state.machineSize === null && machine.config?.guest) {
      const { cpus, memory_mb, cpu_kind } = machine.config.guest;
      state.machineSize = { cpus, memory_mb, cpu_kind };
      await ctx.storage.put(storageUpdate({ machineSize: state.machineSize }));
      machineConfig = { ...machineConfig, guest: guestFromSize(state.machineSize) };
    }

    // failed machines are restartable via updateMachine (Fly re-launches on the next available host)
    if (machine.state === 'stopped' || machine.state === 'created' || machine.state === 'failed') {
      await fly.updateMachine(flyConfig, state.flyMachineId, machineConfig, { minSecretsVersion });
      await fly.waitForState(flyConfig, state.flyMachineId, 'started', STARTUP_TIMEOUT_SECONDS);
      console.log('[DO] Machine updated and started:', state.flyMachineId);
    } else if (machine.state === 'started') {
      console.log('[DO] Machine already started');
    } else {
      await fly.waitForState(flyConfig, state.flyMachineId, 'started', STARTUP_TIMEOUT_SECONDS);
    }
  } catch (err) {
    if (fly.isFlyNotFound(err)) {
      console.log('[DO] Machine gone (404), creating new one');
      state.flyMachineId = null;
      await ctx.storage.put(storageUpdate({ flyMachineId: null }));
      await createNewMachine(
        flyConfig,
        ctx,
        state,
        initialMachineConfig,
        minSecretsVersion,
        envFlyRegion
      );
    } else {
      doError(state, 'Transient error starting existing machine', {
        error: toLoggable(err),
      });
      throw err;
    }
  }
}

/**
 * Create a new Fly Machine. Persists the machine ID immediately before
 * waiting for startup.
 *
 * @param envFlyRegion - The FLY_REGION env var fallback (from worker env).
 */
export async function createNewMachine(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  machineConfig: FlyMachineConfig,
  minSecretsVersion?: number,
  envFlyRegion?: string
): Promise<void> {
  const machine = await fly.createMachine(flyConfig, machineConfig, {
    name: state.sandboxId ?? undefined,
    region: state.flyRegion ?? envFlyRegion ?? undefined,
    minSecretsVersion,
  });
  state.flyMachineId = machine.id;

  await ctx.storage.put(storageUpdate({ flyMachineId: machine.id }));
  console.log('[DO] Created Fly Machine:', machine.id, 'region:', machine.region);

  await fly.waitForState(flyConfig, machine.id, 'started', STARTUP_TIMEOUT_SECONDS);
  console.log('[DO] Machine started');
}

/**
 * Returns the age in ms if this instance is a stale abandoned provision, or null.
 */
export function staleProvisionAgeMs(state: InstanceMutableState): number | null {
  if (
    state.status === 'provisioned' &&
    !state.flyMachineId &&
    !state.lastStartedAt &&
    state.provisionedAt
  ) {
    const age = Date.now() - state.provisionedAt;
    if (age > STALE_PROVISION_THRESHOLD_MS) return age;
  }
  return null;
}
