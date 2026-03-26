import type { KiloClawEnv } from '../../types';
import type { GoogleCredentials, PersistedState, MachineSize } from '../../schemas/instance-config';
import type { FlyClientConfig } from '../../fly/client';

/**
 * Instance status derived from persisted state.
 */
export type InstanceStatus = PersistedState['status'];

/**
 * Result returned by destroy / finalizeDestroyIfComplete.
 */
export type DestroyResult = {
  finalized: boolean;
  destroyedUserId: string | null;
  destroyedSandboxId: string | null;
};

/**
 * Narrow runtime object passed to extracted helpers so they don't
 * reach into `this` on the DO class. Keeps behaviour explicit and
 * makes code easier to test in isolation.
 *
 * NOTE: helpers that only need a subset should accept Pick<InstanceRuntime, …>
 * or individual fields rather than the full object.
 */
export type InstanceRuntime = {
  env: KiloClawEnv;
  ctx: DurableObjectState;
  /** Mutable in-memory state mirroring DO SQLite. */
  state: InstanceMutableState;
  /** Persist a partial update to DO SQLite. */
  persist: (patch: Partial<PersistedState>) => Promise<void>;
};

/**
 * Mutable in-memory state — every field that the old class stored as
 * `private` instance variables, grouped for easy passing to helpers.
 */
export type InstanceMutableState = {
  loaded: boolean;
  userId: string | null;
  sandboxId: string | null;
  status: InstanceStatus | null;
  envVars: PersistedState['envVars'];
  encryptedSecrets: PersistedState['encryptedSecrets'];
  kilocodeApiKey: PersistedState['kilocodeApiKey'];
  kilocodeApiKeyExpiresAt: PersistedState['kilocodeApiKeyExpiresAt'];
  kilocodeDefaultModel: PersistedState['kilocodeDefaultModel'];
  channels: PersistedState['channels'];
  googleCredentials: GoogleCredentials | null;
  provisionedAt: number | null;
  startingAt: number | null;
  restartingAt: number | null;
  restartUpdateSent: boolean;
  lastStartedAt: number | null;
  lastStoppedAt: number | null;
  flyAppName: string | null;
  flyMachineId: string | null;
  flyVolumeId: string | null;
  flyRegion: string | null;
  machineSize: MachineSize | null;
  healthCheckFailCount: number;
  pendingDestroyMachineId: string | null;
  pendingDestroyVolumeId: string | null;
  pendingPostgresMarkOnFinalize: boolean;
  lastMetadataRecoveryAt: number | null;
  openclawVersion: string | null;
  imageVariant: string | null;
  trackedImageTag: string | null;
  trackedImageDigest: string | null;
  lastDestroyErrorOp: 'machine' | 'volume' | 'recover' | null;
  lastDestroyErrorStatus: number | null;
  lastDestroyErrorMessage: string | null;
  lastDestroyErrorAt: number | null;
  lastStartErrorMessage: string | null;
  lastStartErrorAt: number | null;
  lastRestartErrorMessage: string | null;
  lastRestartErrorAt: number | null;
  lastBoundMachineRecoveryAt: number | null;
  instanceFeatures: string[];
  gmailNotificationsEnabled: boolean;
  gmailLastHistoryId: string | null;
  gmailPushOidcEmail: string | null;
  execSecurity: string | null;
  execAsk: string | null;
  // Snapshot restore tracking
  previousVolumeId: string | null;
  restoreStartedAt: string | null;
  preRestoreStatus: InstanceStatus | null;
  pendingRestoreVolumeId: string | null;
  instanceReadyEmailSent: boolean;
  /** In-memory only — throttles live Fly checks in getStatus(). */
  lastLiveCheckAt: number | null;
};

/**
 * Build a FlyClientConfig from the instance runtime + state.
 */
export function getFlyConfig(env: KiloClawEnv, state: InstanceMutableState): FlyClientConfig {
  if (!env.FLY_API_TOKEN) {
    throw new Error('FLY_API_TOKEN is not configured');
  }
  const appName = state.flyAppName ?? env.FLY_APP_NAME;
  if (!appName) {
    throw new Error('No Fly app name: flyAppName not set and FLY_APP_NAME not configured');
  }
  return {
    apiToken: env.FLY_API_TOKEN,
    appName,
  };
}
