import type { KiloClawEnv } from '../../types';
import type {
  GoogleCredentials,
  PersistedState,
  MachineSize,
  ProviderId,
  ProviderState,
} from '../../schemas/instance-config';
import type { FlyClientConfig } from '../../fly/client';
import { userIdFromSandboxId } from '../../auth/sandbox-id';
import {
  isInstanceKeyedSandboxId,
  instanceIdFromSandboxId,
} from '@kilocode/worker-utils/instance-id';

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
  orgId: string | null;
  provider: ProviderId;
  providerState: ProviderState | null;
  status: InstanceStatus | null;
  envVars: PersistedState['envVars'];
  encryptedSecrets: PersistedState['encryptedSecrets'];
  kilocodeApiKey: PersistedState['kilocodeApiKey'];
  kilocodeApiKeyExpiresAt: PersistedState['kilocodeApiKeyExpiresAt'];
  kilocodeDefaultModel: PersistedState['kilocodeDefaultModel'];
  kiloExaSearchMode: PersistedState['kiloExaSearchMode'];
  channels: PersistedState['channels'];
  googleCredentials: GoogleCredentials | null;
  provisionedAt: number | null;
  startingAt: number | null;
  restartingAt: number | null;
  recoveryStartedAt: number | null;
  restartUpdateSent: boolean;
  lastStartedAt: number | null;
  lastStoppedAt: number | null;
  // Legacy Fly compatibility mirrors. `providerState` is the canonical
  // provider record; direct writes here must be followed by `persist()` so the
  // storage sync helper can keep both representations aligned.
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
  pendingRecoveryVolumeId: string | null;
  recoveryPreviousVolumeId: string | null;
  recoveryPreviousVolumeCleanupAfter: number | null;
  lastRecoveryErrorMessage: string | null;
  lastRecoveryErrorAt: number | null;
  lastBoundMachineRecoveryAt: number | null;
  instanceFeatures: string[];
  gmailNotificationsEnabled: boolean;
  gmailLastHistoryId: string | null;
  gmailPushOidcEmail: string | null;
  execSecurity: string | null;
  execAsk: string | null;
  botName: string | null;
  botNature: string | null;
  botVibe: string | null;
  botEmoji: string | null;
  // Snapshot restore tracking
  previousVolumeId: string | null;
  restoreStartedAt: string | null;
  preRestoreStatus: InstanceStatus | null;
  pendingRestoreVolumeId: string | null;
  instanceReadyEmailSent: boolean;
  customSecretMeta: PersistedState['customSecretMeta'];
  // Stream Chat default channel (auto-provisioned)
  streamChatApiKey: string | null;
  streamChatBotUserId: string | null;
  streamChatBotUserToken: string | null;
  streamChatChannelId: string | null;
  /** In-memory only — throttles live Fly checks in getStatus(). */
  lastLiveCheckAt: number | null;
};

/**
 * Build a FlyClientConfig from the instance runtime + state.
 */
/**
 * Derive the App DO key for this instance.
 *
 * Instance-keyed DOs (sandboxId starts with `ki_`) get their own Fly app
 * (`inst-{hash(instanceId)}`). The instanceId is recovered from the sandboxId.
 *
 * Legacy DOs (userId-keyed, non-`ki_` sandboxId) keep their existing
 * user-scoped app (`acct-{hash(userId)}`).
 *
 * Used to resolve `env.KILOCLAW_APP.idFromName(appKey)` everywhere
 * the Instance DO needs the App DO stub.
 */
export function getAppKey(state: { userId: string | null; sandboxId: string | null }): string {
  if (state.sandboxId && isInstanceKeyedSandboxId(state.sandboxId)) {
    return instanceIdFromSandboxId(state.sandboxId);
  }
  if (state.sandboxId) {
    try {
      return userIdFromSandboxId(state.sandboxId);
    } catch {
      // Older tests and malformed legacy state can still carry placeholder
      // sandboxIds that are not reversible base64url encodings.
    }
  }
  if (state.userId) return state.userId;
  throw new Error('Cannot derive app key: no sandboxId or userId');
}

export function getFlyConfig(env: KiloClawEnv, state: InstanceMutableState): FlyClientConfig {
  if (!env.FLY_API_TOKEN) {
    throw new Error('FLY_API_TOKEN is not configured');
  }
  const appName =
    (state.providerState?.provider === 'fly' ? state.providerState.appName : null) ??
    state.flyAppName ??
    env.FLY_APP_NAME;
  if (!appName) {
    throw new Error('No Fly app name: flyAppName not set and FLY_APP_NAME not configured');
  }
  return {
    apiToken: env.FLY_API_TOKEN,
    appName,
  };
}
