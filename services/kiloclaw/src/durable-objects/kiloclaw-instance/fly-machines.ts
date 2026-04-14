import type { KiloClawEnv } from '../../types';
import type { FlyClientConfig } from '../../fly/client';
import type { FlyMachineConfig } from '../../fly/types';
import type { FlyProviderState } from '../../schemas/instance-config';
import type { RuntimeSpec } from '../../providers/types';
import * as fly from '../../fly/client';
import type { ProviderResult } from '../../providers/types';
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
import { guestFromSize, volumeNameFromSandboxId, METADATA_KEY_SANDBOX_ID } from '../machine-config';
import type { InstanceMutableState } from './types';
import { reconcileLog, doError, doWarn, toLoggable } from './log';

type FlyRuntimeState = Pick<
  InstanceMutableState,
  | 'userId'
  | 'sandboxId'
  | 'machineSize'
  | 'lastStartedAt'
  | 'flyAppName'
  | 'flyMachineId'
  | 'flyRegion'
>;

export function buildFlyMachineConfig(
  runtimeSpec: RuntimeSpec,
  volumeId: string | null
): FlyMachineConfig {
  return {
    image: runtimeSpec.imageRef,
    env: runtimeSpec.env,
    guest: guestFromSize(runtimeSpec.machineSize),
    services: [
      {
        ports: [{ port: 443, handlers: ['tls', 'http'] }],
        internal_port: runtimeSpec.controllerPort,
        protocol: 'tcp',
        autostart: false,
        autostop: 'off',
      },
    ],
    checks: {
      controller: {
        type: 'http',
        port: runtimeSpec.controllerPort,
        method: 'GET',
        path: runtimeSpec.controllerHealthCheckPath,
        interval: '30s',
        timeout: '5s',
        grace_period: '120s',
      },
    },
    mounts: volumeId ? [{ volume: volumeId, path: runtimeSpec.rootMountPath }] : [],
    metadata: runtimeSpec.metadata,
  };
}

/**
 * Ensure a Fly Volume exists. Creates one if flyVolumeId is null.
 */
export async function ensureVolume(
  flyConfig: FlyClientConfig,
  state: FlyRuntimeState,
  providerState: FlyProviderState,
  env: KiloClawEnv,
  reason: string
): Promise<FlyProviderState> {
  if (providerState.volumeId) return providerState;
  if (!state.sandboxId) return providerState;

  const regions = providerState.region
    ? parseRegions(providerState.region)
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

  reconcileLog(reason, 'create_volume', {
    fly_app_name: flyConfig.appName,
    volume_id: volume.id,
    region: volume.region,
  });

  return {
    ...providerState,
    volumeId: volume.id,
    region: volume.region,
  };
}

/**
 * Replace a stranded volume whose host has no capacity.
 */
export async function replaceStrandedVolume(
  flyConfig: FlyClientConfig,
  state: FlyRuntimeState & Pick<InstanceMutableState, 'flyMachineId'>,
  providerState: FlyProviderState,
  env: KiloClawEnv,
  reason: string,
  onProviderResult?: (result: ProviderResult<FlyProviderState>) => Promise<void>
): Promise<FlyProviderState> {
  if (!state.sandboxId || !providerState.volumeId) return providerState;
  if (!onProviderResult) {
    throw new Error('replaceStrandedVolume requires a persistence callback');
  }

  const oldVolumeId = providerState.volumeId;
  const oldRegion = providerState.region;
  const hasUserData = state.lastStartedAt !== null;
  const allRegions = await resolveRegions(env.KV_CLAW_CACHE, env.FLY_REGION);
  const regions = deprioritizeRegion(allRegions, oldRegion);
  const compute = guestFromSize(state.machineSize);
  let machineGone = false;

  // Destroy existing machine if any — it's stuck on the constrained host.
  if (state.flyMachineId) {
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
  }

  if (machineGone) {
    providerState = {
      ...providerState,
      machineId: null,
    };
    await onProviderResult({
      providerState,
    });
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
    reconcileLog(reason, 'fork_stranded_volume', {
      fly_app_name: flyConfig.appName,
      old_volume_id: oldVolumeId,
      old_region: oldRegion,
      new_volume_id: forkedVolume.id,
      new_region: forkedVolume.region,
    });
    providerState = {
      ...providerState,
      volumeId: forkedVolume.id,
      region: forkedVolume.region,
    };
  } else {
    providerState = {
      ...providerState,
      volumeId: null,
      region: null,
    };
    await onProviderResult({
      providerState,
    });

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
    reconcileLog(reason, 'create_replacement_volume', {
      fly_app_name: flyConfig.appName,
      old_volume_id: oldVolumeId,
      old_region: oldRegion,
      new_volume_id: freshVolume.id,
      new_region: freshVolume.region,
    });
    providerState = {
      ...providerState,
      volumeId: freshVolume.id,
      region: freshVolume.region,
    };
  }

  await onProviderResult({
    providerState,
  });

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

  return providerState;
}

/**
 * Try to start an existing machine. Falls back to creating a new one if
 * the existing machine is unusable (destroyed, corrupted).
 */
export async function startExistingMachine(
  flyConfig: FlyClientConfig,
  state: FlyRuntimeState,
  providerState: FlyProviderState,
  initialMachineConfig: FlyMachineConfig,
  minSecretsVersion?: number,
  envFlyRegion?: string,
  onProviderResult?: (result: ProviderResult<FlyProviderState>) => Promise<void>
): Promise<{ providerState: FlyProviderState; machineSize?: InstanceMutableState['machineSize'] }> {
  if (!providerState.machineId) {
    return { providerState };
  }
  if (!onProviderResult) {
    throw new Error('startExistingMachine requires a persistence callback');
  }

  try {
    const machine = await fly.getMachine(flyConfig, providerState.machineId);

    // Backfill machineSize from live Fly machine config for legacy instances
    let machineConfig = initialMachineConfig;
    let machineSizePatch: InstanceMutableState['machineSize'] | undefined;
    if (state.machineSize === null && machine.config?.guest) {
      const { cpus, memory_mb, cpu_kind } = machine.config.guest;
      machineSizePatch = { cpus, memory_mb, cpu_kind };
      machineConfig = { ...machineConfig, guest: guestFromSize(machineSizePatch) };
      await onProviderResult({
        providerState,
        corePatch: {
          machineSize: machineSizePatch,
        },
      });
    }

    // failed machines are restartable via updateMachine (Fly re-launches on the next available host)
    if (machine.state === 'stopped' || machine.state === 'created' || machine.state === 'failed') {
      await fly.updateMachine(flyConfig, providerState.machineId, machineConfig, {
        minSecretsVersion,
      });
      await fly.waitForState(
        flyConfig,
        providerState.machineId,
        'started',
        STARTUP_TIMEOUT_SECONDS
      );
      console.log('[DO] Machine updated and started:', providerState.machineId);
    } else if (machine.state === 'started') {
      console.log('[DO] Machine already started');
    } else {
      await fly.waitForState(
        flyConfig,
        providerState.machineId,
        'started',
        STARTUP_TIMEOUT_SECONDS
      );
    }
    return {
      providerState,
      ...(machineSizePatch !== undefined ? { machineSize: machineSizePatch } : {}),
    };
  } catch (err) {
    if (fly.isFlyNotFound(err)) {
      console.log('[DO] Machine gone (404), creating new one');
      const clearedProviderState = {
        ...providerState,
        machineId: null,
      } satisfies FlyProviderState;
      await onProviderResult({
        providerState: clearedProviderState,
      });
      return createNewMachine(
        flyConfig,
        state,
        clearedProviderState,
        initialMachineConfig,
        minSecretsVersion,
        envFlyRegion,
        onProviderResult
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
  state: Pick<InstanceMutableState, 'sandboxId'>,
  providerState: FlyProviderState,
  machineConfig: FlyMachineConfig,
  minSecretsVersion?: number,
  envFlyRegion?: string,
  onProviderResult?: (result: ProviderResult<FlyProviderState>) => Promise<void>
): Promise<{ providerState: FlyProviderState }> {
  if (!onProviderResult) {
    throw new Error('createNewMachine requires a persistence callback');
  }
  const machine = await fly.createMachine(flyConfig, machineConfig, {
    name: state.sandboxId ?? undefined,
    region: providerState.region ?? envFlyRegion ?? undefined,
    minSecretsVersion,
  });
  const nextProviderState = {
    ...providerState,
    machineId: machine.id,
  } satisfies FlyProviderState;
  await onProviderResult({
    providerState: nextProviderState,
  });
  console.log('[DO] Created Fly Machine:', machine.id, 'region:', machine.region);

  await fly.waitForState(flyConfig, machine.id, 'started', STARTUP_TIMEOUT_SECONDS);
  console.log('[DO] Machine started');

  return {
    providerState: nextProviderState,
  };
}

/**
 * Delete a volume, force-destroying any attached machine first.
 */
export async function deleteVolumeAndAttachedMachine(
  flyConfig: FlyClientConfig,
  volumeId: string,
  reason: string,
  expectedSandboxId?: string
): Promise<void> {
  let attachedMachineId: string | null = null;

  try {
    const volume = await fly.getVolume(flyConfig, volumeId);
    attachedMachineId = volume.attached_machine_id;
  } catch (err) {
    if (fly.isFlyNotFound(err)) return;
    throw err;
  }

  if (attachedMachineId) {
    if (expectedSandboxId) {
      try {
        const attachedMachine = await fly.getMachine(flyConfig, attachedMachineId);
        const attachedSandboxId = attachedMachine.config.metadata?.[METADATA_KEY_SANDBOX_ID];
        if (attachedSandboxId !== expectedSandboxId) {
          throw new Error(
            `Refusing to destroy attached machine ${attachedMachineId} for volume ${volumeId}: expected sandbox ${expectedSandboxId}, found ${attachedSandboxId ?? 'unknown'}`
          );
        }
      } catch (err) {
        if (!fly.isFlyNotFound(err)) throw err;
      }
    }

    try {
      await fly.destroyMachine(flyConfig, attachedMachineId, true);
      reconcileLog(reason, 'destroy_machine_for_volume_cleanup', {
        fly_app_name: flyConfig.appName,
        machine_id: attachedMachineId,
        volume_id: volumeId,
      });
    } catch (err) {
      if (!fly.isFlyNotFound(err)) throw err;
    }
  }

  try {
    await fly.deleteVolume(flyConfig, volumeId);
    reconcileLog(reason, 'delete_volume', {
      fly_app_name: flyConfig.appName,
      volume_id: volumeId,
    });
  } catch (err) {
    if (fly.isFlyNotFound(err)) return;
    throw err;
  }
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
