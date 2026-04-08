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
import {
  storageUpdate,
  syncProviderStateForStorage,
} from '../../durable-objects/kiloclaw-instance/state';
import { type InstanceProviderAdapter } from '../types';

async function persistWithProviderState(
  ctx: DurableObjectState,
  state: InstanceMutableState,
  patch: Parameters<typeof storageUpdate>[0]
): Promise<void> {
  await ctx.storage.put(storageUpdate(syncProviderStateForStorage(state, patch)));
}

function registryAppKey(state: Pick<InstanceMutableState, 'userId' | 'sandboxId'>) {
  return getAppKey(state);
}

export const flyProviderAdapter: InstanceProviderAdapter = {
  id: 'fly',

  async getRoutingTarget({ env, state }) {
    if (!state.flyMachineId) {
      throw new Error('No Fly machine ID for this instance');
    }

    const appName = state.flyAppName ?? env.FLY_APP_NAME;
    if (!appName) {
      throw new Error('No Fly app name for this instance');
    }

    return {
      origin: `https://${appName}.fly.dev`,
      headers: {
        'fly-force-instance-id': state.flyMachineId,
      },
    };
  },

  async ensureProvisioningResources({ env, ctx, state, orgId, machineSize, region }) {
    const isNew = !state.status;

    if (isNew && !state.flyAppName) {
      state.orgId = orgId;
      const appKey = registryAppKey(state);
      const appStub = env.KILOCLAW_APP.get(env.KILOCLAW_APP.idFromName(appKey));
      const { appName } = await appStub.ensureApp(appKey);
      state.flyAppName = appName;
      await persistWithProviderState(ctx, state, { flyAppName: appName });
      console.log('[DO] Fly App ensured:', appName, 'key:', appKey);
    }

    if (isNew && !state.flyVolumeId && state.sandboxId) {
      const flyConfig = getFlyConfig(env, state);
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
      state.flyVolumeId = volume.id;
      state.flyRegion = volume.region;
      await persistWithProviderState(ctx, state, {
        flyVolumeId: volume.id,
        flyRegion: volume.region,
      });
      console.log('[DO] Created Fly Volume:', volume.id, 'region:', volume.region);
    }
  },

  async ensureStorage({ env, ctx, state, reason }) {
    const flyConfig = getFlyConfig(env, state);
    await flyMachines.ensureVolume(flyConfig, ctx, state, env, reason);
    await persistWithProviderState(ctx, state, {
      flyVolumeId: state.flyVolumeId,
      flyRegion: state.flyRegion,
    });
  },

  async startRuntime({
    env,
    ctx,
    state,
    machineConfig,
    minSecretsVersion,
    envRegion,
    onCapacityRecovery,
  }) {
    const flyConfig = getFlyConfig(env, state);

    try {
      if (state.flyMachineId) {
        await flyMachines.startExistingMachine(
          flyConfig,
          ctx,
          state,
          machineConfig,
          minSecretsVersion,
          envRegion
        );
      } else {
        await flyMachines.createNewMachine(
          flyConfig,
          ctx,
          state,
          machineConfig,
          minSecretsVersion,
          envRegion
        );
      }
      await persistWithProviderState(ctx, state, {
        flyMachineId: state.flyMachineId,
        flyVolumeId: state.flyVolumeId,
        flyRegion: state.flyRegion,
      });
    } catch (err) {
      if (!fly.isFlyInsufficientResources(err)) throw err;

      await onCapacityRecovery?.(err);

      await flyMachines.replaceStrandedVolume(
        flyConfig,
        ctx,
        state,
        env,
        'start_capacity_recovery'
      );
      await persistWithProviderState(ctx, state, {
        flyMachineId: state.flyMachineId,
        flyVolumeId: state.flyVolumeId,
        flyRegion: state.flyRegion,
      });

      await flyMachines.createNewMachine(
        flyConfig,
        ctx,
        state,
        machineConfig,
        minSecretsVersion,
        envRegion
      );
      await persistWithProviderState(ctx, state, {
        flyMachineId: state.flyMachineId,
        flyVolumeId: state.flyVolumeId,
        flyRegion: state.flyRegion,
      });
    }
  },

  async stopRuntime({ env, state }) {
    if (!state.flyMachineId) return;
    const flyConfig = getFlyConfig(env, state);
    await fly.stopMachineAndWait(flyConfig, state.flyMachineId);
  },

  async restartRuntime({ env, ctx, state, machineConfig, minSecretsVersion }) {
    if (!state.flyMachineId) {
      throw new Error('No machine exists');
    }

    const flyConfig = getFlyConfig(env, state);
    const updated = await fly.updateMachine(flyConfig, state.flyMachineId, machineConfig, {
      minSecretsVersion,
    });

    const currentStatus = await ctx.storage.get('status');
    if (currentStatus !== 'restarting') {
      return { aborted: true };
    }

    state.restartUpdateSent = true;
    await persistWithProviderState(ctx, state, {
      restartUpdateSent: true,
      flyMachineId: state.flyMachineId,
      flyVolumeId: state.flyVolumeId,
      flyRegion: state.flyRegion,
    });

    const machine = await fly.getMachine(flyConfig, state.flyMachineId);
    if (machine.state === 'stopped' || machine.state === 'created') {
      await fly.startMachine(flyConfig, state.flyMachineId);
    }

    await fly.waitForState(
      flyConfig,
      state.flyMachineId,
      'started',
      STARTUP_TIMEOUT_SECONDS,
      updated.instance_id
    );

    return { instanceId: updated.instance_id };
  },
};
