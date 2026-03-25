import { PersistedStateSchema, type PersistedState } from '../../schemas/instance-config';
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
    s.status = d.userId ? d.status : null;
    s.envVars = d.envVars;
    s.encryptedSecrets = d.encryptedSecrets;
    s.kilocodeApiKey = d.kilocodeApiKey;
    s.kilocodeApiKeyExpiresAt = d.kilocodeApiKeyExpiresAt;
    s.kilocodeDefaultModel = d.kilocodeDefaultModel;
    s.channels = d.channels;
    s.googleCredentials = d.googleCredentials;
    s.provisionedAt = d.provisionedAt;
    s.startingAt = d.startingAt;
    s.restartingAt = d.restartingAt;
    s.restartUpdateSent = d.restartUpdateSent;
    s.lastStartedAt = d.lastStartedAt;
    s.lastStoppedAt = d.lastStoppedAt;
    s.flyAppName = d.flyAppName;
    s.flyMachineId = d.flyMachineId;
    s.flyVolumeId = d.flyVolumeId;
    s.flyRegion = d.flyRegion;
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
    s.lastBoundMachineRecoveryAt = d.lastBoundMachineRecoveryAt;
    s.instanceFeatures = d.instanceFeatures;
    s.gmailNotificationsEnabled = d.gmailNotificationsEnabled;
    s.gmailLastHistoryId = d.gmailLastHistoryId;
    s.gmailPushOidcEmail = d.gmailPushOidcEmail;
    s.execSecurity = d.execSecurity;
    s.execAsk = d.execAsk;
    // Legacy instances pre-dating this field treat absence as already-sent
    // to avoid spurious emails after deploy.
    s.instanceReadyEmailSent = 'instanceReadyEmailSent' in raw ? d.instanceReadyEmailSent : true;
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
  s.status = null;
  s.envVars = null;
  s.encryptedSecrets = null;
  s.kilocodeApiKey = null;
  s.kilocodeApiKeyExpiresAt = null;
  s.kilocodeDefaultModel = null;
  s.channels = null;
  s.googleCredentials = null;
  s.provisionedAt = null;
  s.startingAt = null;
  s.restartingAt = null;
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
  s.lastBoundMachineRecoveryAt = null;
  s.instanceFeatures = [];
  s.gmailNotificationsEnabled = false;
  s.gmailLastHistoryId = null;
  s.gmailPushOidcEmail = null;
  s.execSecurity = null;
  s.execAsk = null;
  s.instanceReadyEmailSent = false;
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
    status: null,
    envVars: null,
    encryptedSecrets: null,
    kilocodeApiKey: null,
    kilocodeApiKeyExpiresAt: null,
    kilocodeDefaultModel: null,
    channels: null,
    googleCredentials: null,
    provisionedAt: null,
    startingAt: null,
    restartingAt: null,
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
    lastBoundMachineRecoveryAt: null,
    instanceFeatures: [],
    gmailNotificationsEnabled: false,
    gmailLastHistoryId: null,
    gmailPushOidcEmail: null,
    execSecurity: null,
    execAsk: null,
    instanceReadyEmailSent: false,
    lastLiveCheckAt: null,
  };
}
