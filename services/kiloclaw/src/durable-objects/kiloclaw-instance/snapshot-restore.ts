import type { PersistedState } from '../../schemas/instance-config';
import type { KiloClawEnv } from '../../types';
import * as fly from '../../fly/client';
import {
  isInstanceKeyedSandboxId,
  instanceIdFromSandboxId,
} from '@kilocode/worker-utils/instance-id';
import type { InstanceMutableState } from './types';
import { getFlyConfig } from './types';
import { doLog } from './log';
import type { KiloClawEventData, KiloClawEventName } from '../../utils/analytics';
import { writeEvent } from '../../utils/analytics';

export type SnapshotRestoreRuntime = {
  env: KiloClawEnv;
  ctx: DurableObjectState;
  state: InstanceMutableState;
  loadState: () => Promise<void>;
  persist: (patch: Partial<PersistedState>) => Promise<void>;
  scheduleAlarm: () => Promise<void>;
  emitEvent: (
    data: Omit<
      KiloClawEventData,
      | 'userId'
      | 'sandboxId'
      | 'delivery'
      | 'flyAppName'
      | 'flyMachineId'
      | 'openclawVersion'
      | 'imageTag'
      | 'flyRegion'
    > & { event: KiloClawEventName }
  ) => void;
};

function emitEvent(runtime: SnapshotRestoreRuntime, data: Parameters<SnapshotRestoreRuntime['emitEvent']>[0]): void {
  const { state } = runtime;
  doLog(state, data.event, {
    ...(data.status ? { status: data.status } : undefined),
    ...(data.label ? { label: data.label } : undefined),
    ...(data.error ? { error: data.error } : undefined),
    ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : undefined),
    ...(data.value !== undefined ? { value: data.value } : undefined),
  });
  writeEvent(runtime.env, {
    ...data,
    delivery: 'do',
    userId: state.userId ?? undefined,
    sandboxId: state.sandboxId ?? undefined,
    flyAppName: state.flyAppName ?? undefined,
    flyMachineId: state.flyMachineId ?? undefined,
    openclawVersion: state.openclawVersion ?? undefined,
    imageTag: state.trackedImageTag ?? undefined,
    flyRegion: state.flyRegion ?? undefined,
    status: data.status ?? state.status ?? undefined,
  });
}

export async function enqueueSnapshotRestore(
  runtime: SnapshotRestoreRuntime,
  snapshotId: string
): Promise<{ acknowledged: boolean; previousVolumeId: string }> {
  const { state, env, persist, scheduleAlarm } = runtime;

  if (!state.userId || !state.flyVolumeId || !state.flyRegion || !state.sandboxId) {
    throw new Error('Cannot restore: instance is not provisioned');
  }
  if (state.status === 'destroying') {
    throw new Error('Cannot restore: instance is being destroyed');
  }
  if (state.status === 'recovering') {
    throw new Error('Cannot restore: instance is recovering from an unexpected stop');
  }
  if (state.status === 'restoring') {
    throw new Error('Cannot restore: instance is already restoring');
  }
  if (state.status === 'starting' || state.status === 'restarting') {
    throw new Error('Cannot restore: instance is busy (' + state.status + ')');
  }

  const previousVolumeId = state.flyVolumeId;
  const previousStatus = state.status ?? 'stopped';

  const now = new Date().toISOString();
  state.status = 'restoring';
  state.restoreStartedAt = now;
  state.preRestoreStatus = previousStatus;
  await persist({
    status: 'restoring',
    restoreStartedAt: now,
    preRestoreStatus: previousStatus,
  });
  await scheduleAlarm();

  if (!env.SNAPSHOT_RESTORE_QUEUE) {
    state.status = previousStatus;
    state.restoreStartedAt = null;
    state.preRestoreStatus = null;
    await persist({
      status: previousStatus,
      restoreStartedAt: null,
      preRestoreStatus: null,
    });
    throw new Error('Cannot restore: SNAPSHOT_RESTORE_QUEUE binding not configured');
  }
  try {
    await env.SNAPSHOT_RESTORE_QUEUE.send({
      userId: state.userId,
      snapshotId,
      previousVolumeId,
      region: state.flyRegion,
      instanceId:
        state.sandboxId && isInstanceKeyedSandboxId(state.sandboxId)
          ? instanceIdFromSandboxId(state.sandboxId)
          : undefined,
    });
  } catch (err) {
    state.status = previousStatus;
    state.restoreStartedAt = null;
    state.preRestoreStatus = null;
    await persist({
      status: previousStatus,
      restoreStartedAt: null,
      preRestoreStatus: null,
    });
    throw err;
  }

  emitEvent(runtime, {
    event: 'instance.restore_enqueued',
    status: 'restoring',
    label: 'admin_snapshot_restore',
  });

  return { acknowledged: true, previousVolumeId };
}

export async function destroyMachineForRestore(runtime: SnapshotRestoreRuntime): Promise<void> {
  const { state, env, persist } = runtime;

  if (state.status !== 'restoring') {
    throw new Error('Cannot destroy machine: instance is not in restoring state');
  }
  if (state.flyMachineId) {
    const flyConfig = getFlyConfig(env, state);
    try {
      await fly.destroyMachine(flyConfig, state.flyMachineId, true);
      console.log(`[DO] Machine destroyed for restore: ${state.flyMachineId}`);
    } catch (err) {
      if (!fly.isFlyNotFound(err)) throw err;
      console.log('[DO] Machine already gone during restore destroy');
    }
    state.flyMachineId = null;
    state.preRestoreStatus = 'stopped';
    await persist({ flyMachineId: null, preRestoreStatus: 'stopped' });
  }
}

export async function setPendingRestoreVolumeId(
  runtime: SnapshotRestoreRuntime,
  volumeId: string
): Promise<void> {
  const { state, persist } = runtime;
  if (state.status !== 'restoring') return;
  state.pendingRestoreVolumeId = volumeId;
  await persist({ pendingRestoreVolumeId: volumeId });
}

export async function completeSnapshotRestore(
  runtime: SnapshotRestoreRuntime,
  newVolumeId: string,
  newRegion: string
): Promise<void> {
  const { state, persist, emitEvent: emit } = runtime;

  if (state.status !== 'restoring') {
    throw new Error('Cannot complete restore: instance is not in restoring state');
  }

  const previousVolumeId = state.flyVolumeId;
  const durationMs = state.restoreStartedAt
    ? Date.now() - new Date(state.restoreStartedAt).getTime()
    : undefined;
  state.previousVolumeId = previousVolumeId;
  state.flyVolumeId = newVolumeId;
  state.flyRegion = newRegion;
  state.status = 'stopped';
  state.restoreStartedAt = null;
  state.preRestoreStatus = null;
  state.pendingRestoreVolumeId = null;
  await persist({
    previousVolumeId,
    flyVolumeId: newVolumeId,
    flyRegion: newRegion,
    status: 'stopped',
    restoreStartedAt: null,
    preRestoreStatus: null,
    pendingRestoreVolumeId: null,
  });

  emit({
    event: 'instance.restore_completed',
    status: 'stopped',
    durationMs,
  });
}

export async function failSnapshotRestore(
  runtime: SnapshotRestoreRuntime,
  opts?: {
    emitFailedEvent?: boolean;
    failureDurationMs?: number;
    failureLabel?: string;
  }
): Promise<void> {
  const { state, persist, scheduleAlarm, emitEvent: emit } = runtime;

  if (state.status !== 'restoring') return;

  if (opts?.emitFailedEvent) {
    emit({
      event: 'instance.restore_failed',
      status: 'restoring',
      label: opts.failureLabel ?? 'alarm_timeout',
      durationMs: opts.failureDurationMs,
    });
  }

  const restoredStatus = state.preRestoreStatus ?? 'stopped';
  if (state.pendingRestoreVolumeId) {
    console.warn(
      `[DO] Orphaned restore volume: ${state.pendingRestoreVolumeId} (manual cleanup may be needed)`
    );
  }
  state.status = restoredStatus;
  state.restoreStartedAt = null;
  state.preRestoreStatus = null;
  state.pendingRestoreVolumeId = null;
  await persist({
    status: restoredStatus,
    restoreStartedAt: null,
    preRestoreStatus: null,
    pendingRestoreVolumeId: null,
  });
  await scheduleAlarm();

  console.log(`[DO] Snapshot restore failed, status restored to ${restoredStatus}`);
}
