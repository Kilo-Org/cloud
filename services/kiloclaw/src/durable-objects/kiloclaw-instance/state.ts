import {
  PersistedStateSchema,
  type PersistedState,
  type ProviderState,
  type FlyProviderState,
  type DockerLocalProviderState,
} from '../../schemas/instance-config';
import type { InstanceMutableState } from './types';

/**
 * Derived from PersistedStateSchema — single source of truth for DO KV keys.
 */
export const STORAGE_KEYS = Object.keys(PersistedStateSchema.shape);

/**
 * Type-checked wrapper for ctx.storage.put().
 * Narrows the caller to only valid PersistedState fields.
 */
export function storageUpdate(update: Partial<PersistedState>): Partial<PersistedState> {
  return update;
}

export function buildFlyProviderState(
  source: Pick<InstanceMutableState, 'flyAppName' | 'flyMachineId' | 'flyVolumeId' | 'flyRegion'>
): FlyProviderState {
  return {
    provider: 'fly',
    appName: source.flyAppName,
    machineId: source.flyMachineId,
    volumeId: source.flyVolumeId,
    region: source.flyRegion,
  };
}

export function getFlyProviderState(
  source: Pick<
    InstanceMutableState,
    'providerState' | 'flyAppName' | 'flyMachineId' | 'flyVolumeId' | 'flyRegion'
  >
): FlyProviderState {
  if (
    source.providerState?.provider === 'fly' &&
    source.providerState.appName === source.flyAppName &&
    source.providerState.machineId === source.flyMachineId &&
    source.providerState.volumeId === source.flyVolumeId &&
    source.providerState.region === source.flyRegion
  ) {
    return source.providerState;
  }
  return buildFlyProviderState(source);
}

export function hydrateFlyLegacyFieldsFromProviderState(
  s: Pick<
    InstanceMutableState,
    'flyAppName' | 'flyMachineId' | 'flyVolumeId' | 'flyRegion' | 'providerState'
  >
): void {
  if (s.providerState?.provider !== 'fly') return;
  s.flyAppName = s.providerState.appName;
  s.flyMachineId = s.providerState.machineId;
  s.flyVolumeId = s.providerState.volumeId;
  s.flyRegion = s.providerState.region;
}

export function applyProviderState(
  s: Pick<
    InstanceMutableState,
    'provider' | 'providerState' | 'flyAppName' | 'flyMachineId' | 'flyVolumeId' | 'flyRegion'
  >,
  providerState: ProviderState
): void {
  s.provider = providerState.provider;
  s.providerState = providerState;

  if (providerState.provider === 'fly') {
    hydrateFlyLegacyFieldsFromProviderState(s);
    return;
  }

  s.flyAppName = null;
  s.flyMachineId = null;
  s.flyVolumeId = null;
  s.flyRegion = null;
}

export function getDockerLocalProviderState(
  source: Pick<InstanceMutableState, 'providerState'>
): DockerLocalProviderState {
  if (source.providerState?.provider === 'docker-local') {
    return source.providerState;
  }
  return {
    provider: 'docker-local',
    containerName: null,
    volumeName: null,
    hostPort: null,
  };
}

export function getRuntimeId(
  source: Pick<InstanceMutableState, 'providerState' | 'flyMachineId'>
): string | null {
  if (source.providerState?.provider === 'fly') {
    return source.providerState.machineId;
  }
  if (source.providerState?.provider === 'docker-local') {
    return source.providerState.containerName;
  }
  return source.flyMachineId;
}

export function getStorageId(
  source: Pick<InstanceMutableState, 'providerState' | 'flyVolumeId'>
): string | null {
  if (source.providerState?.provider === 'fly') {
    return source.providerState.volumeId;
  }
  if (source.providerState?.provider === 'docker-local') {
    return source.providerState.volumeName;
  }
  return source.flyVolumeId;
}

export function getProviderRegion(
  source: Pick<InstanceMutableState, 'providerState' | 'flyRegion'>
): string | null {
  if (source.providerState?.provider === 'fly') {
    return source.providerState.region;
  }
  if (source.providerState?.provider === 'docker-local') {
    return null;
  }
  return source.flyRegion;
}

export function syncProviderStateForStorage(
  s: Pick<
    InstanceMutableState,
    'provider' | 'providerState' | 'flyAppName' | 'flyMachineId' | 'flyVolumeId' | 'flyRegion'
  >,
  patch: Partial<PersistedState>
): Partial<PersistedState> {
  // Intentionally mutates `s` as well as returning a storage patch.
  // Callers must use both effects together: the in-memory state stays aligned
  // with legacy/provider field mirroring, and the returned patch is what gets
  // persisted to storage.
  // Temporary compatibility bridge while legacy Fly fields still exist in the
  // persisted schema. New provider-aware code should prefer writing
  // `providerState`; writes to legacy Fly fields should only happen alongside a
  // follow-up `persist()` call so this helper can mirror them.
  const nextProvider = patch.provider ?? s.provider;
  const explicitProviderState = patch.providerState;
  if (explicitProviderState) {
    applyProviderState(s, explicitProviderState);
    if (explicitProviderState.provider === 'fly') {
      return {
        ...patch,
        provider: 'fly',
        flyAppName: explicitProviderState.appName,
        flyMachineId: explicitProviderState.machineId,
        flyVolumeId: explicitProviderState.volumeId,
        flyRegion: explicitProviderState.region,
      };
    }
    return {
      ...patch,
      provider: explicitProviderState.provider,
      flyAppName: null,
      flyMachineId: null,
      flyVolumeId: null,
      flyRegion: null,
    };
  }

  if (nextProvider !== 'fly') return patch;

  const touchesFlyLegacyFields =
    'flyAppName' in patch ||
    'flyMachineId' in patch ||
    'flyVolumeId' in patch ||
    'flyRegion' in patch ||
    'provider' in patch;

  if (!touchesFlyLegacyFields) return patch;

  const nextState: ProviderState = {
    provider: 'fly',
    appName: 'flyAppName' in patch ? (patch.flyAppName ?? null) : s.flyAppName,
    machineId: 'flyMachineId' in patch ? (patch.flyMachineId ?? null) : s.flyMachineId,
    volumeId: 'flyVolumeId' in patch ? (patch.flyVolumeId ?? null) : s.flyVolumeId,
    region: 'flyRegion' in patch ? (patch.flyRegion ?? null) : s.flyRegion,
  };

  applyProviderState(s, nextState);

  return {
    ...patch,
    provider: 'fly',
    providerState: nextState,
  };
}

/**
 * Load persisted state from DO SQLite into the mutable state object.
 * No-ops if already loaded.
 */
export async function loadState(ctx: DurableObjectState, s: InstanceMutableState): Promise<void> {
  if (s.loaded) return;

  const entries = await ctx.storage.get(STORAGE_KEYS);
  const raw = Object.fromEntries(entries.entries());
  const parsed = PersistedStateSchema.safeParse(raw);

  if (parsed.success) {
    const d = parsed.data;
    s.userId = d.userId || null;
    s.sandboxId = d.sandboxId || null;
    s.orgId = d.orgId;
    s.provider = d.provider;
    s.providerState = d.providerState;
    s.status = d.userId ? d.status : null;
    s.envVars = d.envVars;
    s.encryptedSecrets = d.encryptedSecrets;
    s.kilocodeApiKey = d.kilocodeApiKey;
    s.kilocodeApiKeyExpiresAt = d.kilocodeApiKeyExpiresAt;
    s.kilocodeDefaultModel = d.kilocodeDefaultModel;
    s.userTimezone = d.userTimezone;
    s.userLocation = d.userLocation;
    s.kiloExaSearchMode = d.kiloExaSearchMode;
    s.channels = d.channels;
    s.googleCredentials = d.googleCredentials;
    s.googleOAuthConnection = d.googleOAuthConnection;
    s.googleWorkspaceToolsEnabled = d.googleWorkspaceToolsEnabled;
    s.googleWorkspaceConfigSyncPending = d.googleWorkspaceConfigSyncPending;
    s.googleWorkspaceConfigSyncError = d.googleWorkspaceConfigSyncError;
    s.googleWorkspaceConfigSyncedAt = d.googleWorkspaceConfigSyncedAt;
    s.provisionedAt = d.provisionedAt;
    s.startingAt = d.startingAt;
    s.restartingAt = d.restartingAt;
    s.recoveryStartedAt = d.recoveryStartedAt;
    s.restartUpdateSent = d.restartUpdateSent;
    s.lastStartedAt = d.lastStartedAt;
    s.lastStoppedAt = d.lastStoppedAt;
    s.flyAppName = d.flyAppName;
    s.flyMachineId = d.flyMachineId;
    s.flyVolumeId = d.flyVolumeId;
    s.flyRegion = d.flyRegion;
    if (s.provider === 'fly') {
      if (s.providerState?.provider === 'fly') {
        hydrateFlyLegacyFieldsFromProviderState(s);
      } else {
        s.providerState = buildFlyProviderState(s);
      }
    } else if (s.providerState) {
      applyProviderState(s, s.providerState);
    }
    s.machineSize = d.machineSize;
    s.healthCheckFailCount = d.healthCheckFailCount;
    s.pendingDestroyMachineId = d.pendingDestroyMachineId;
    s.pendingDestroyVolumeId = d.pendingDestroyVolumeId;
    s.pendingPostgresMarkOnFinalize = d.pendingPostgresMarkOnFinalize;
    s.lastMetadataRecoveryAt = d.lastMetadataRecoveryAt;
    s.openclawVersion = d.openclawVersion;
    s.imageVariant = d.imageVariant;
    s.trackedImageTag = d.trackedImageTag;
    s.trackedImageDigest = d.trackedImageDigest;
    s.lastDestroyErrorOp = d.lastDestroyErrorOp;
    s.lastDestroyErrorStatus = d.lastDestroyErrorStatus;
    s.lastDestroyErrorMessage = d.lastDestroyErrorMessage;
    s.lastDestroyErrorAt = d.lastDestroyErrorAt;
    s.lastStartErrorMessage = d.lastStartErrorMessage;
    s.lastStartErrorAt = d.lastStartErrorAt;
    s.lastRestartErrorMessage = d.lastRestartErrorMessage;
    s.lastRestartErrorAt = d.lastRestartErrorAt;
    s.pendingRecoveryVolumeId = d.pendingRecoveryVolumeId;
    s.recoveryPreviousVolumeId = d.recoveryPreviousVolumeId;
    s.recoveryPreviousVolumeCleanupAfter = d.recoveryPreviousVolumeCleanupAfter;
    s.lastRecoveryErrorMessage = d.lastRecoveryErrorMessage;
    s.lastRecoveryErrorAt = d.lastRecoveryErrorAt;
    s.lastBoundMachineRecoveryAt = d.lastBoundMachineRecoveryAt;
    s.instanceFeatures = d.instanceFeatures;
    s.gmailNotificationsEnabled = d.gmailNotificationsEnabled;
    s.gmailLastHistoryId = d.gmailLastHistoryId;
    s.gmailPushOidcEmail = d.gmailPushOidcEmail;
    s.execSecurity = d.execSecurity;
    s.execAsk = d.execAsk;
    s.botName = d.botName;
    s.botNature = d.botNature;
    s.botVibe = d.botVibe;
    s.botEmoji = d.botEmoji;
    s.previousVolumeId = d.previousVolumeId;
    s.restoreStartedAt = d.restoreStartedAt;
    s.preRestoreStatus = d.preRestoreStatus;
    s.pendingRestoreVolumeId = d.pendingRestoreVolumeId;
    // Legacy instances pre-dating this field treat absence as already-sent
    // to avoid spurious emails after deploy.
    s.instanceReadyEmailSent = 'instanceReadyEmailSent' in raw ? d.instanceReadyEmailSent : true;
    s.customSecretMeta = d.customSecretMeta;
    s.streamChatApiKey = d.streamChatApiKey;
    s.streamChatBotUserId = d.streamChatBotUserId;
    s.streamChatBotUserToken = d.streamChatBotUserToken;
    s.streamChatChannelId = d.streamChatChannelId;
    s.vectorMemoryEnabled = d.vectorMemoryEnabled;
    s.vectorMemoryModel = d.vectorMemoryModel;
    s.dreamingEnabled = d.dreamingEnabled;
  } else {
    const hasAnyData = entries.size > 0;
    if (hasAnyData) {
      console.warn(
        '[DO] Persisted state failed validation, treating as fresh. Errors:',
        parsed.error.flatten().fieldErrors
      );
    }
  }

  s.loaded = true;
}

/**
 * Reset all cached state back to defaults. Called after deleteAll().
 */
export function resetMutableState(s: InstanceMutableState): void {
  s.userId = null;
  s.sandboxId = null;
  s.orgId = null;
  s.provider = 'fly';
  s.providerState = null;
  s.status = null;
  s.envVars = null;
  s.encryptedSecrets = null;
  s.kilocodeApiKey = null;
  s.kilocodeApiKeyExpiresAt = null;
  s.kilocodeDefaultModel = null;
  s.userTimezone = null;
  s.userLocation = null;
  s.kiloExaSearchMode = null;
  s.channels = null;
  s.googleCredentials = null;
  s.googleOAuthConnection = null;
  s.googleWorkspaceToolsEnabled = false;
  s.googleWorkspaceConfigSyncPending = false;
  s.googleWorkspaceConfigSyncError = null;
  s.googleWorkspaceConfigSyncedAt = null;
  s.provisionedAt = null;
  s.startingAt = null;
  s.restartingAt = null;
  s.recoveryStartedAt = null;
  s.restartUpdateSent = false;
  s.lastStartedAt = null;
  s.lastStoppedAt = null;
  s.flyAppName = null;
  s.flyMachineId = null;
  s.flyVolumeId = null;
  s.flyRegion = null;
  s.machineSize = null;
  s.healthCheckFailCount = 0;
  s.pendingDestroyMachineId = null;
  s.pendingDestroyVolumeId = null;
  s.pendingPostgresMarkOnFinalize = false;
  s.lastMetadataRecoveryAt = null;
  s.openclawVersion = null;
  s.imageVariant = null;
  s.trackedImageTag = null;
  s.trackedImageDigest = null;
  s.lastDestroyErrorOp = null;
  s.lastDestroyErrorStatus = null;
  s.lastDestroyErrorMessage = null;
  s.lastDestroyErrorAt = null;
  s.lastStartErrorMessage = null;
  s.lastStartErrorAt = null;
  s.lastRestartErrorMessage = null;
  s.lastRestartErrorAt = null;
  s.pendingRecoveryVolumeId = null;
  s.recoveryPreviousVolumeId = null;
  s.recoveryPreviousVolumeCleanupAfter = null;
  s.lastRecoveryErrorMessage = null;
  s.lastRecoveryErrorAt = null;
  s.lastBoundMachineRecoveryAt = null;
  s.instanceFeatures = [];
  s.gmailNotificationsEnabled = false;
  s.gmailLastHistoryId = null;
  s.gmailPushOidcEmail = null;
  s.execSecurity = null;
  s.execAsk = null;
  s.botName = null;
  s.botNature = null;
  s.botVibe = null;
  s.botEmoji = null;
  s.previousVolumeId = null;
  s.restoreStartedAt = null;
  s.preRestoreStatus = null;
  s.pendingRestoreVolumeId = null;
  s.instanceReadyEmailSent = false;
  s.streamChatApiKey = null;
  s.streamChatBotUserId = null;
  s.streamChatBotUserToken = null;
  s.streamChatChannelId = null;
  s.vectorMemoryEnabled = false;
  s.vectorMemoryModel = null;
  s.dreamingEnabled = false;
  s.lastLiveCheckAt = null;
  s.restartingAt = null;
  s.loaded = false;
}

/**
 * Create a fresh InstanceMutableState with default values.
 */
export function createMutableState(): InstanceMutableState {
  return {
    loaded: false,
    userId: null,
    sandboxId: null,
    orgId: null,
    provider: 'fly',
    providerState: null,
    status: null,
    envVars: null,
    encryptedSecrets: null,
    kilocodeApiKey: null,
    kilocodeApiKeyExpiresAt: null,
    kilocodeDefaultModel: null,
    userTimezone: null,
    userLocation: null,
    kiloExaSearchMode: null,
    channels: null,
    googleCredentials: null,
    googleOAuthConnection: null,
    googleWorkspaceToolsEnabled: false,
    googleWorkspaceConfigSyncPending: false,
    googleWorkspaceConfigSyncError: null,
    googleWorkspaceConfigSyncedAt: null,
    provisionedAt: null,
    startingAt: null,
    restartingAt: null,
    recoveryStartedAt: null,
    restartUpdateSent: false,
    lastStartedAt: null,
    lastStoppedAt: null,
    flyAppName: null,
    flyMachineId: null,
    flyVolumeId: null,
    flyRegion: null,
    machineSize: null,
    healthCheckFailCount: 0,
    pendingDestroyMachineId: null,
    pendingDestroyVolumeId: null,
    pendingPostgresMarkOnFinalize: false,
    lastMetadataRecoveryAt: null,
    openclawVersion: null,
    imageVariant: null,
    trackedImageTag: null,
    trackedImageDigest: null,
    lastDestroyErrorOp: null,
    lastDestroyErrorStatus: null,
    lastDestroyErrorMessage: null,
    lastDestroyErrorAt: null,
    lastStartErrorMessage: null,
    lastStartErrorAt: null,
    lastRestartErrorMessage: null,
    lastRestartErrorAt: null,
    pendingRecoveryVolumeId: null,
    recoveryPreviousVolumeId: null,
    recoveryPreviousVolumeCleanupAfter: null,
    lastRecoveryErrorMessage: null,
    lastRecoveryErrorAt: null,
    lastBoundMachineRecoveryAt: null,
    instanceFeatures: [],
    gmailNotificationsEnabled: false,
    gmailLastHistoryId: null,
    gmailPushOidcEmail: null,
    execSecurity: null,
    execAsk: null,
    botName: null,
    botNature: null,
    botVibe: null,
    botEmoji: null,
    previousVolumeId: null,
    restoreStartedAt: null,
    preRestoreStatus: null,
    pendingRestoreVolumeId: null,
    instanceReadyEmailSent: false,
    customSecretMeta: null,
    streamChatApiKey: null,
    streamChatBotUserId: null,
    streamChatBotUserToken: null,
    streamChatChannelId: null,
    vectorMemoryEnabled: false,
    vectorMemoryModel: null,
    dreamingEnabled: false,
    lastLiveCheckAt: null,
  };
}
