import * as fly from '../../fly/client';
import { DEFAULT_VOLUME_SIZE_GB, STARTUP_TIMEOUT_SECONDS } from '../../config';
import { parseRegions, prepareRegions, resolveRegions } from '../../durable-objects/regions';
import * as regionHelpers from '../../durable-objects/regions';
import { guestFromSize, volumeNameFromSandboxId } from '../../durable-objects/machine-config';
import {
  getAppKey,
  getFlyConfig,
  type InstanceMutableState,
} from '../../durable-objects/kiloclaw-instance/types';
import * as flyMachines from '../../durable-objects/kiloclaw-instance/fly-machines';
import { buildFlyMachineConfig } from '../../durable-objects/kiloclaw-instance/fly-machines';
import { getFlyProviderState } from '../../durable-objects/kiloclaw-instance/state';
import { type InstanceProviderAdapter } from '../types';

function registryAppKey(state: Pick<InstanceMutableState, 'userId' | 'sandboxId'>) {
  return getAppKey(state);
}

export const flyProviderAdapter: InstanceProviderAdapter = {
  id: 'fly',
  capabilities: {
    volumeSnapshots: true,
    candidateVolumes: true,
    volumeReassociation: true,
    snapshotRestore: true,
    directMachineDestroy: true,
  },

  async getRoutingTarget({ env, state }) {
    const flyState = getFlyProviderState(state);

    if (!flyState.machineId) {
      throw new Error('No Fly machine ID for this instance');
    }

    const appName = flyState.appName ?? env.FLY_APP_NAME;
    if (!appName) {
      throw new Error('No Fly app name for this instance');
    }

    return {
      origin: `https://${appName}.fly.dev`,
      headers: {
        'fly-force-instance-id': flyState.machineId,
      },
    };
  },

  async ensureProvisioningResources({ env, state, machineSize, region }) {
    const isNew = !state.status;
    let providerState = getFlyProviderState(state);

    if (isNew && !providerState.appName) {
      const appKey = registryAppKey(state);
      const appStub = env.KILOCLAW_APP.get(env.KILOCLAW_APP.idFromName(appKey));
      const { appName } = await appStub.ensureApp(appKey);
      providerState = {
        ...providerState,
        appName,
      };
      console.log('[DO] Fly App ensured:', appName, 'key:', appKey);
    }

    if (isNew && !providerState.volumeId && state.sandboxId) {
      const flyConfig = getFlyConfig(env, {
        ...state,
        providerState,
      });
      const regions = region
        ? prepareRegions(parseRegions(region))
        : await resolveRegions(env.KV_CLAW_CACHE, env.FLY_REGION);
      const guest = guestFromSize(machineSize);
      const volume = await fly.createVolumeWithFallback(
        flyConfig,
        {
          name: volumeNameFromSandboxId(state.sandboxId),
          size_gb: DEFAULT_VOLUME_SIZE_GB,
          compute: guest,
        },
        regions,
        {
          onCapacityError: failedRegion => {
            void regionHelpers.evictCapacityRegionFromKV(env.KV_CLAW_CACHE, env, failedRegion);
          },
        }
      );
      providerState = {
        ...providerState,
        volumeId: volume.id,
        region: volume.region,
      };
      console.log('[DO] Created Fly Volume:', volume.id, 'region:', volume.region);
    }

    return {
      providerState,
    };
  },

  async ensureStorage({ env, state, reason }) {
    const flyConfig = getFlyConfig(env, state);
    const providerState = await flyMachines.ensureVolume(
      flyConfig,
      state,
      getFlyProviderState(state),
      env,
      reason
    );
    return {
      providerState,
    };
  },

  async startRuntime({
    env,
    state,
    runtimeSpec,
    minSecretsVersion,
    preferredRegion,
    onCapacityRecovery,
    onProviderResult,
  }) {
    if (!onProviderResult) {
      throw new Error('Fly startRuntime requires onProviderResult persistence callback');
    }

    const flyConfig = getFlyConfig(env, state);
    let providerState = getFlyProviderState(state);
    let machineSizePatch: InstanceMutableState['machineSize'] | undefined;

    try {
      if (providerState.machineId) {
        const machineConfig = buildFlyMachineConfig(runtimeSpec, providerState.volumeId);
        const result = await flyMachines.startExistingMachine(
          flyConfig,
          state,
          providerState,
          machineConfig,
          minSecretsVersion,
          preferredRegion,
          onProviderResult
        );
        providerState = result.providerState;
        machineSizePatch = result.machineSize;
      } else {
        const machineConfig = buildFlyMachineConfig(runtimeSpec, providerState.volumeId);
        const result = await flyMachines.createNewMachine(
          flyConfig,
          state,
          providerState,
          machineConfig,
          minSecretsVersion,
          preferredRegion,
          onProviderResult
        );
        providerState = result.providerState;
      }
    } catch (err) {
      if (!fly.isFlyInsufficientResources(err)) throw err;

      await onCapacityRecovery?.(err);

      providerState = await flyMachines.replaceStrandedVolume(
        flyConfig,
        {
          ...state,
          flyMachineId: providerState.machineId,
        },
        providerState,
        env,
        'start_capacity_recovery',
        onProviderResult
      );

      const result = await flyMachines.createNewMachine(
        flyConfig,
        state,
        providerState,
        buildFlyMachineConfig(runtimeSpec, providerState.volumeId),
        minSecretsVersion,
        preferredRegion,
        onProviderResult
      );
      providerState = result.providerState;
    }

    return {
      providerState,
      ...(machineSizePatch !== undefined ? { corePatch: { machineSize: machineSizePatch } } : {}),
      observation: {
        runtimeState: 'running',
      },
    };
  },

  async stopRuntime({ env, state }) {
    const providerState = getFlyProviderState(state);
    if (!providerState.machineId) {
      return { providerState };
    }
    const flyConfig = getFlyConfig(env, state);
    await fly.stopMachineAndWait(flyConfig, providerState.machineId);
    return {
      providerState,
      observation: {
        runtimeState: 'stopped',
      },
    };
  },

  async restartRuntime({ env, state, runtimeSpec, minSecretsVersion, onProviderResult }) {
    if (!onProviderResult) {
      throw new Error('Fly restartRuntime requires onProviderResult persistence callback');
    }

    const providerState = getFlyProviderState(state);
    if (!providerState.machineId) {
      throw new Error('No machine exists');
    }

    const flyConfig = getFlyConfig(env, state);
    const updated = await fly.updateMachine(
      flyConfig,
      providerState.machineId,
      buildFlyMachineConfig(runtimeSpec, providerState.volumeId),
      {
        minSecretsVersion,
      }
    );
    await onProviderResult({
      providerState,
      corePatch: {
        restartUpdateSent: true,
      },
    });

    const machine = await fly.getMachine(flyConfig, providerState.machineId);
    if (machine.state === 'stopped' || machine.state === 'created') {
      await fly.startMachine(flyConfig, providerState.machineId);
    }

    await fly.waitForState(
      flyConfig,
      providerState.machineId,
      'started',
      STARTUP_TIMEOUT_SECONDS,
      updated.instance_id
    );

    return {
      providerState,
      observation: {
        runtimeState: 'running',
      },
    };
  },

  async inspectRuntime({ env, state }) {
    const providerState = getFlyProviderState(state);
    if (!providerState.machineId) {
      return {
        providerState,
        observation: {
          runtimeState: 'missing',
        },
      };
    }

    const flyConfig = getFlyConfig(env, state);
    try {
      const machine = await fly.getMachine(flyConfig, providerState.machineId);
      const runtimeState =
        machine.state === 'started'
          ? 'running'
          : machine.state === 'starting'
            ? 'starting'
            : machine.state === 'stopped' || machine.state === 'suspended'
              ? 'stopped'
              : 'failed';
      return {
        providerState,
        observation: {
          runtimeState,
        },
      };
    } catch (err) {
      if (fly.isFlyNotFound(err)) {
        return {
          providerState,
          observation: {
            runtimeState: 'missing',
          },
        };
      }
      throw err;
    }
  },

  async destroyRuntime({ env, state }) {
    const providerState = getFlyProviderState(state);
    if (!providerState.machineId) {
      return { providerState };
    }

    const flyConfig = getFlyConfig(env, state);
    await fly.destroyMachine(flyConfig, providerState.machineId);
    return {
      providerState: {
        ...providerState,
        machineId: null,
      },
    };
  },

  async destroyStorage({ env, state }) {
    const providerState = getFlyProviderState(state);
    if (!providerState.volumeId) {
      return { providerState };
    }

    const flyConfig = getFlyConfig(env, state);
    await fly.deleteVolume(flyConfig, providerState.volumeId);
    return {
      providerState: {
        ...providerState,
        volumeId: null,
        region: null,
      },
    };
  },
};
