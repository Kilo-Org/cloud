import 'server-only';

import { TRPCError } from '@trpc/server';
import type { ActiveKiloClawInstance } from '@/lib/kiloclaw/instance-registry';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';

export function createNoInstanceStatus(userId: string, workerUrl: string): KiloClawDashboardStatus {
  return {
    userId,
    sandboxId: null,
    provider: null,
    runtimeId: null,
    storageId: null,
    region: null,
    status: null,
    provisionedAt: null,
    lastStartedAt: null,
    lastStoppedAt: null,
    envVarCount: 0,
    secretCount: 0,
    channelCount: 0,
    flyAppName: null,
    flyMachineId: null,
    flyVolumeId: null,
    flyRegion: null,
    machineSize: null,
    instanceType: null,
    volumeSizeGb: null,
    openclawVersion: null,
    imageVariant: null,
    trackedImageTag: null,
    trackedImageDigest: null,
    googleConnected: false,
    googleOAuthConnected: false,
    googleOAuthStatus: 'disconnected',
    googleOAuthAccountEmail: null,
    googleOAuthCapabilities: [],
    gmailNotificationsEnabled: false,
    execSecurity: null,
    execAsk: null,
    botName: null,
    botNature: null,
    botVibe: null,
    botEmoji: null,
    userLocation: null,
    userTimezone: null,
    workerUrl,
    controllerCapabilitiesVersion: null,
    name: null,
    instanceId: null,
    inboundEmailAddress: null,
    inboundEmailEnabled: false,
    scheduledAction: null,
  } satisfies KiloClawDashboardStatus;
}

export function isFakeSeedInstance(instance: ActiveKiloClawInstance): boolean {
  return instance.sandboxId.startsWith('ki_fake_');
}

export function createFakeSeedInstanceStatus(
  instance: ActiveKiloClawInstance,
  workerUrl: string
): KiloClawDashboardStatus {
  return {
    ...createNoInstanceStatus(instance.userId, workerUrl),
    sandboxId: instance.sandboxId,
    provider: 'docker-local',
    runtimeId: instance.sandboxId,
    storageId: instance.sandboxId,
    region: 'local',
    status: 'stopped',
    provisionedAt: Date.now(),
    trackedImageTag: 'fake-local-instance',
    workerUrl,
    name: instance.name ?? null,
    instanceId: instance.id,
    inboundEmailEnabled: instance.inboundEmailEnabled,
  } satisfies KiloClawDashboardStatus;
}

/**
 * An upstream abort does not prove that our caller disconnected. Only classify
 * it as a client cancellation when the incoming HTTP request was also aborted.
 */
export function isClientAbortError(error: unknown, requestSignal?: AbortSignal): boolean {
  if (!requestSignal?.aborted || !(error instanceof Error)) return false;
  const code = 'code' in error ? error.code : undefined;
  return (
    error.name === 'AbortError' ||
    code === 'ABORT_ERR' ||
    code === 'UND_ERR_ABORTED' ||
    error.message === 'aborted'
  );
}

/**
 * A canceled incoming request becomes 499; an upstream failure (including an
 * upstream abort while the caller is connected) becomes 502.
 */
export function statusUnavailableError(error: unknown, requestSignal?: AbortSignal): TRPCError {
  if (isClientAbortError(error, requestSignal)) {
    return new TRPCError({
      code: 'CLIENT_CLOSED_REQUEST',
      message: 'Client disconnected before the KiloClaw status could be read',
      cause: error,
    });
  }
  return new TRPCError({
    code: 'BAD_GATEWAY',
    message: 'KiloClaw instance status is unavailable',
    cause: error,
  });
}
