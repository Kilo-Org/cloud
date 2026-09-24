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
 * True when a rejection came from the client going away (the request was
 * aborted) rather than from an upstream fault. The dev-stack log for the
 * original finding showed `uncaughtException: Error: aborted` alongside the
 * tRPC 500, so `message === 'aborted'` is included explicitly.
 */
export function isClientAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    error.name === 'AbortError' ||
    code === 'ABORT_ERR' ||
    code === 'UND_ERR_ABORTED' ||
    error.message === 'aborted'
  );
}

/**
 * Map a KiloClaw worker status failure to a tRPC error that names the cause
 * instead of the opaque INTERNAL_SERVER_ERROR. A client disconnect becomes 499
 * (mirrors `apps/web/src/lib/ai-gateway/providers/upstream-request.ts`), which
 * is never a 5xx; every other worker failure becomes a 502 so the caller gets
 * a specific reason.
 */
export function statusUnavailableError(error: unknown): TRPCError {
  if (isClientAbortError(error)) {
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
