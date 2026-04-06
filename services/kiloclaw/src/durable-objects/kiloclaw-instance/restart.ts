import type { PersistedState } from '../../schemas/instance-config';
import type { KiloClawEnv } from '../../types';
import * as fly from '../../fly/client';
import { STARTUP_TIMEOUT_SECONDS } from '../../config';
import { buildMachineConfig, guestFromSize } from '../machine-config';
import {
  getRegistryApp,
  ensureStreamChatChannel,
  resolveImageTag,
  buildUserEnvVars,
  resolveAndPersistImageVersion,
} from './config';
import type { InstanceMutableState } from './types';
import { getFlyConfig } from './types';
import { storageUpdate } from './state';
import { doLog, doWarn, doError, toLoggable, createReconcileContext } from './log';
import * as gateway from './gateway';
import { markRestartSuccessful } from './reconcile';

export type RestartRuntime = {
  env: KiloClawEnv;
  ctx: DurableObjectState;
  state: InstanceMutableState;
  loadState: () => Promise<void>;
  persist: (patch: Partial<PersistedState>) => Promise<void>;
  scheduleAlarm: () => Promise<void>;
  emitEvent: (data: {
    event: string;
    status?: string;
    label?: string;
    error?: string;
    durationMs?: number;
  }) => void;
};

export async function runRestartMachine(
  runtime: RestartRuntime
): Promise<{ success: boolean; error?: string }> {
  const { state, env, ctx, persist, scheduleAlarm, emitEvent } = runtime;

  if (!state.flyMachineId) {
    return { success: false, error: 'No machine exists' };
  }

  const action = 'redeploy-same-image';
  doLog(state, 'restartMachine: initiating async restart', {
    action,
    currentStatus: state.status,
    trackedImageTag: state.trackedImageTag,
    flyMachineId: state.flyMachineId,
  });

  const flyConfig = getFlyConfig(env, state);

  if (state.machineSize === null && state.flyMachineId) {
    const machine = await fly.getMachine(flyConfig, state.flyMachineId);
    if (machine.config?.guest) {
      const { cpus, memory_mb, cpu_kind } = machine.config.guest;
      state.machineSize = { cpus, memory_mb, cpu_kind };
      await persist({ machineSize: state.machineSize });
    }
  }

  state.status = 'restarting';
  state.restartingAt = Date.now();
  state.restartUpdateSent = false;
  state.lastRestartErrorMessage = null;
  state.lastRestartErrorAt = null;
  await ctx.storage.put(
    storageUpdate({
      status: 'restarting',
      restartingAt: state.restartingAt,
      restartUpdateSent: false,
      lastRestartErrorMessage: null,
      lastRestartErrorAt: null,
    })
  );
  await scheduleAlarm();

  emitEvent({ event: 'instance.restarting', status: 'restarting', label: action });

  return { success: true };
}

export async function runRestartMachineInBackground(runtime: RestartRuntime): Promise<void> {
  const { state, env, ctx, loadState, persist, scheduleAlarm } = runtime;

  try {
    await loadState();

    const currentStatus = await ctx.storage.get('status');
    if (currentStatus !== 'restarting') {
      console.log('[DO] restartMachine: aborting background restart, status is now', currentStatus);
      return;
    }

    if (!state.flyMachineId) {
      throw new Error('No machine exists');
    }

    if (!state.streamChatApiKey && state.sandboxId) {
      await ensureStreamChatChannel(
        {
          env,
          state,
          persist,
          logLabel: 'Stream Chat backfilled on restart',
        },
        state.sandboxId
      );
    }

    const flyConfig = getFlyConfig(env, state);

    const { envVars, minSecretsVersion } = await buildUserEnvVars(env, ctx, state);
    const guest = guestFromSize(state.machineSize);
    const imageTag = resolveImageTag(state, env);
    doLog(state, 'restartMachine: deploying update', {
      imageTag,
      flyMachineId: state.flyMachineId,
    });
    const identity = {
      userId: state.userId ?? '',
      sandboxId: state.sandboxId ?? '',
      orgId: state.orgId,
      openclawVersion: state.openclawVersion,
      imageVariant: state.imageVariant,
    };
    const machineConfig = buildMachineConfig(
      getRegistryApp(env),
      imageTag,
      envVars,
      guest,
      state.flyVolumeId,
      identity
    );

    const updated = await fly.updateMachine(flyConfig, state.flyMachineId, machineConfig, {
      minSecretsVersion,
    });

    const midStatus = await ctx.storage.get('status');
    if (midStatus !== 'restarting') return;

    state.restartUpdateSent = true;
    await ctx.storage.put(storageUpdate({ restartUpdateSent: true }));

    const machine = await fly.getMachine(flyConfig, state.flyMachineId);
    if (machine.state === 'stopped' || machine.state === 'created') {
      doLog(state, 'restartMachine: machine not running after update, starting explicitly', {
        flyState: machine.state,
      });
      await fly.startMachine(flyConfig, state.flyMachineId);
    }

    await fly.waitForState(
      flyConfig,
      state.flyMachineId,
      'started',
      STARTUP_TIMEOUT_SECONDS,
      updated.instance_id
    );
    await gateway.waitForHealthy(state, env, flyConfig.appName, state.flyMachineId);

    const preSuccessStatus = await ctx.storage.get('status');
    if (preSuccessStatus !== 'restarting') return;

    await markRestartSuccessful(ctx, state, createReconcileContext(state, env, 'restart'));
    doLog(state, 'restartMachine: background restart completed successfully');
    await scheduleAlarm();
  } catch (err) {
    const isExpectedTimeout =
      state.restartUpdateSent && err instanceof fly.FlyApiError && err.status === 408;

    if (isExpectedTimeout) {
      doWarn(
        state,
        'restartMachine: waitForState timed out after update, reconciliation will handle',
        {
          error: toLoggable(err),
        }
      );
    } else {
      doError(state, 'restartMachine: background restart failed', {
        error: toLoggable(err),
      });
    }

    const postStatus = await ctx.storage.get('status');
    if (postStatus === 'restarting') {
      const errorMessage = err instanceof Error ? err.message : String(err);
      state.lastRestartErrorMessage = errorMessage;
      state.lastRestartErrorAt = Date.now();
      await ctx.storage.put(
        storageUpdate({
          lastRestartErrorMessage: errorMessage,
          lastRestartErrorAt: state.lastRestartErrorAt,
        })
      );
    }
  }
}

export async function runRestartMachineWithImageTag(
  runtime: RestartRuntime,
  imageTag: string
): Promise<void> {
  const { state, env, loadState, persist } = runtime;

  await loadState();

  if (imageTag === 'latest') {
    await resolveAndPersistImageVersion(env, state, { latest: true }, persist);
  } else {
    await resolveAndPersistImageVersion(env, state, { imageTag }, persist);
  }
}
