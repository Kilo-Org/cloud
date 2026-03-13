import type { KiloClawEnv } from '../../types';
import type { FlyClientConfig } from '../../fly/client';
import type { FlyMachineConfig } from '../../fly/types';
import * as fly from '../../fly/client';
import {
  DEFAULT_VOLUME_SIZE_GB,
  STARTUP_TIMEOUT_SECONDS,
  DEFAULT_FLY_REGION,
  STALE_PROVISION_THRESHOLD_MS,
} from '../../config';
import { parseRegions, shuffleRegions, deprioritizeRegion } from '../regions';
import { guestFromSize, volumeNameFromSandboxId } from '../machine-config';
import type { InstanceMutableState } from './types';
import { storageUpdate } from './state';
import { reconcileLog } from './log';

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

  const regions = shuffleRegions(
    parseRegions(state.flyRegion ?? env.FLY_REGION ?? DEFAULT_FLY_REGION)
  );
  const volume = await fly.createVolumeWithFallback(
    flyConfig,
    {
      name: volumeNameFromSandboxId(state.sandboxId),
      size_gb: DEFAULT_VOLUME_SIZE_GB,
      compute: guestFromSize(state.machineSize),
    },
    regions
  );

  state.flyVolumeId = volume.id;
  state.flyRegion = volume.region;
  await ctx.storage.put(storageUpdate({ flyVolumeId: volume.id, flyRegion: volume.region }));

  reconcileLog(reason, 'create_volume', {
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
  const allRegions = shuffleRegions(parseRegions(env.FLY_REGION ?? DEFAULT_FLY_REGION));
  const regions = deprioritizeRegion(allRegions, oldRegion);
  const compute = guestFromSize(state.machineSize);

  // Destroy existing machine if any — it's stuck on the constrained host.
  if (state.flyMachineId) {
    let machineGone = false;
    try {
      await fly.destroyMachine(flyConfig, state.flyMachineId);
      reconcileLog(reason, 'destroy_stranded_machine', { machine_id: state.flyMachineId });
      machineGone = true;
    } catch (err) {
      if (fly.isFlyNotFound(err)) {
        machineGone = true;
      } else {
        console.warn('[DO] Failed to destroy stranded machine:', err);
      }
    }
    if (machineGone) {
      state.flyMachineId = null;
      await ctx.storage.put(storageUpdate({ flyMachineId: null }));
    }
  }

  if (hasUserData) {
    const forkedVolume = await fly.createVolumeWithFallback(
      flyConfig,
      {
        name: volumeNameFromSandboxId(state.sandboxId),
        size_gb: DEFAULT_VOLUME_SIZE_GB,
        source_volume_id: oldVolumeId,
        compute,
      },
      regions
    );
    state.flyVolumeId = forkedVolume.id;
    state.flyRegion = forkedVolume.region;
    reconcileLog(reason, 'fork_stranded_volume', {
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
      regions
    );
    state.flyVolumeId = freshVolume.id;
    state.flyRegion = freshVolume.region;
    reconcileLog(reason, 'create_replacement_volume', {
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
    reconcileLog(reason, 'delete_stranded_volume', { volume_id: oldVolumeId });
  } catch (err) {
    if (!fly.isFlyNotFound(err)) {
      console.warn('[DO] Failed to delete stranded volume (will leak):', oldVolumeId, err);
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

    if (machine.state === 'stopped' || machine.state === 'created') {
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
      console.error('[DO] Transient error starting existing machine:', err);
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
