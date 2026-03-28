/**
 * KiloClawInstance Durable Object
 *
 * Thin orchestration shell — delegates real work to domain modules.
 *
 * Keyed by userId: env.KILOCLAW_INSTANCE.idFromName(userId)
 *
 * See kiloclaw/docs/instance-features.md and ohsobig.md for context.
 */

import { DurableObject } from 'cloudflare:workers';
import type { KiloClawEnv } from '../../types';
import type {
  InstanceConfig,
  PersistedState,
  EncryptedEnvelope,
  GoogleCredentials,
  MachineSize,
  CustomSecretMeta,
} from '../../schemas/instance-config';
import { DEFAULT_INSTANCE_FEATURES } from '../../schemas/instance-config';
import type { FlyVolume, FlyVolumeSnapshot } from '../../fly/types';
import * as fly from '../../fly/client';
import { sandboxIdFromUserId, sandboxIdFromInstanceId } from '../../auth/sandbox-id';
import { resolveLatestVersion, resolveVersionByTag } from '../../lib/image-version';
import { lookupCatalogVersion } from '../../lib/catalog-registration';
import { ImageVariantSchema } from '../../schemas/image-version';
import {
  STARTUP_TIMEOUT_SECONDS,
  DEFAULT_VOLUME_SIZE_GB,
  LIVE_CHECK_THROTTLE_MS,
  OPENCLAW_BUILTIN_DEFAULT_MODEL,
} from '../../config';
import {
  SECRET_CATALOG,
  FIELD_KEY_TO_ENV_VAR,
  ENV_VAR_TO_FIELD_KEY,
  ALL_SECRET_FIELD_KEYS,
  MAX_CUSTOM_SECRETS,
  type SecretFieldKey,
} from '@kilocode/kiloclaw-secret-catalog';
import {
  parseRegions,
  prepareRegions,
  resolveRegions,
  evictCapacityRegionFromKV,
} from '../regions';
import { buildMachineConfig, guestFromSize, volumeNameFromSandboxId } from '../machine-config';
import type { GatewayProcessStatus } from '../gateway-controller-types';

// Domain modules
import type { InstanceMutableState, InstanceStatus, DestroyResult } from './types';
import { getFlyConfig } from './types';
import { createMutableState, loadState, storageUpdate } from './state';
import { nextAlarmTime, doLog, doError, doWarn, toLoggable, createReconcileContext } from './log';
import { attemptMetadataRecovery } from './reconcile';
import { resolveImageTag, getRegistryApp, buildUserEnvVars } from './config';
import * as gateway from './gateway';
import * as pairing from './pairing';
import * as flyMachines from './fly-machines';
import {
  reconcileWithFly,
  syncStatusFromLiveCheck,
  tryDeleteMachine,
  tryDeleteVolume,
  finalizeDestroyIfComplete,
  reconcileMachineMount,
  markRestartSuccessful,
} from './reconcile';
import { restoreFromPostgres, markDestroyedInPostgresHelper } from './postgres';
import {
  setupDefaultStreamChatChannel,
  createShortLivedUserToken,
  deactivateStreamChatUsers,
} from '../../stream-chat/client';
import { writeEvent } from '../../utils/analytics';
import type { KiloClawEventData, KiloClawEventName } from '../../utils/analytics';

// Re-export extracted helpers so existing consumers don't break.
export {
  parseRegions,
  shuffleRegions,
  deprioritizeRegion,
  isMetaRegion,
  prepareRegions,
  resolveRegions,
} from '../regions';
export { selectRecoveryCandidate } from '../machine-recovery';
export { METADATA_KEY_USER_ID } from '../machine-config';

/** Channel env var names — used to exclude channel secrets from secretCount. */
const CHANNEL_ENV_VARS = new Set(
  SECRET_CATALOG.filter(e => e.category === 'channel').flatMap(e => e.fields.map(f => f.envVar))
);

export class KiloClawInstance extends DurableObject<KiloClawEnv> {
  private s: InstanceMutableState = createMutableState();
  private startInProgress = false;

  // Kept as `loadState` for backward compat with tests that cast to access private methods.
  private async loadState(): Promise<void> {
    await loadState(this.ctx, this.s);
  }

  private async persist(patch: Partial<PersistedState>): Promise<void> {
    await this.ctx.storage.put(storageUpdate(patch));
  }

  private async scheduleAlarm(): Promise<void> {
    if (!this.s.status) return;
    await this.ctx.storage.setAlarm(nextAlarmTime(this.s.status));
  }

  /**
   * Exposed as a private method so tests that cast to access internals
   * can still call `instance.buildUserEnvVars()`.
   */
  private buildUserEnvVars() {
    return buildUserEnvVars(this.env, this.ctx, this.s);
  }

  /**
   * Emit an analytics event with common DO dimensions baked in.
   * Follows gastown's Omit<> pattern — callers provide only the
   * event-specific fields; userId, delivery, and machine context
   * are always filled from this.s.
   */
  private emitEvent(
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
  ): void {
    doLog(this.s, data.event, {
      ...(data.status ? { status: data.status } : undefined),
      ...(data.label ? { label: data.label } : undefined),
      ...(data.error ? { error: data.error } : undefined),
      ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : undefined),
      ...(data.value !== undefined ? { value: data.value } : undefined),
    });
    writeEvent(this.env, {
      ...data,
      delivery: 'do',
      userId: this.s.userId ?? undefined,
      sandboxId: this.s.sandboxId ?? undefined,
      flyAppName: this.s.flyAppName ?? undefined,
      flyMachineId: this.s.flyMachineId ?? undefined,
      openclawVersion: this.s.openclawVersion ?? undefined,
      imageTag: this.s.trackedImageTag ?? undefined,
      flyRegion: this.s.flyRegion ?? undefined,
      status: data.status ?? this.s.status ?? undefined,
    });
  }

  private emitProvisioningFailed(label: string, error?: string): void {
    this.emitEvent({
      event: 'instance.provisioning_failed',
      status: 'stopped',
      label,
      error,
    });
  }

  private emitStartCapacityRecovery(error: string, label: string): void {
    this.emitEvent({
      event: 'instance.start_capacity_recovery',
      status: this.s.status ?? undefined,
      label,
      error,
    });
  }

  private capacityRecoveryLabel(err: unknown): string {
    if (!(err instanceof fly.FlyApiError)) {
      return 'fly_capacity_recovery';
    }

    const searchText = `${err.message}\n${err.body}`.toLowerCase();

    if (searchText.includes('insufficient memory')) {
      return `fly_${err.status}_insufficient_memory`;
    }
    if (searchText.includes('no capacity')) {
      return `fly_${err.status}_no_capacity`;
    }
    if (searchText.includes('over the allowed quota')) {
      return `fly_${err.status}_quota_exceeded`;
    }
    if (searchText.includes('insufficient resources')) {
      return `fly_${err.status}_insufficient_resources`;
    }

    return `fly_${err.status}_capacity_recovery`;
  }

  // ========================================================================
  // Lifecycle methods (called by platform API routes via RPC)
  // ========================================================================

  async provision(
    userId: string,
    config: InstanceConfig,
    opts?: { orgId?: string | null; instanceId?: string }
  ): Promise<{ sandboxId: string }> {
    const provisionStart = performance.now();
    await this.loadState();

    if (this.s.status === 'destroying') {
      throw new Error('Cannot provision: instance is being destroyed');
    }
    if (this.s.status === 'restoring') {
      throw new Error('Cannot provision: instance is restoring from snapshot');
    }

    // For instance-keyed DOs (instanceId provided), derive sandboxId from instanceId.
    // For legacy userId-keyed DOs, derive from userId.
    const sandboxId = opts?.instanceId
      ? sandboxIdFromInstanceId(opts.instanceId)
      : sandboxIdFromUserId(userId);
    const isNew = !this.s.status;

    // Ensure per-user Fly App exists on first provision only.
    if (isNew && !this.s.flyAppName) {
      const appStub = this.env.KILOCLAW_APP.get(this.env.KILOCLAW_APP.idFromName(userId));
      const { appName } = await appStub.ensureApp(userId);
      this.s.flyAppName = appName;
      await this.persist({ flyAppName: appName });
      console.log('[DO] Per-user Fly App ensured:', appName);
    }

    // Create Fly Volume on first provision.
    if (isNew && !this.s.flyVolumeId) {
      const flyConfig = getFlyConfig(this.env, this.s);
      const regions = config.region
        ? prepareRegions(parseRegions(config.region))
        : await resolveRegions(this.env.KV_CLAW_CACHE, this.env.FLY_REGION);
      const guest = guestFromSize(config.machineSize ?? null);
      const volume = await fly.createVolumeWithFallback(
        flyConfig,
        {
          name: volumeNameFromSandboxId(sandboxId),
          size_gb: DEFAULT_VOLUME_SIZE_GB,
          compute: guest,
        },
        regions,
        {
          onCapacityError: failedRegion => {
            void evictCapacityRegionFromKV(this.env.KV_CLAW_CACHE, this.env, failedRegion);
          },
        }
      );
      this.s.flyVolumeId = volume.id;
      this.s.flyRegion = volume.region;
      console.log('[DO] Created Fly Volume:', volume.id, 'region:', volume.region);
    }

    // Resolve the image version for this provision.
    console.debug('[DO] provision: pinnedImageTag from config:', config.pinnedImageTag ?? 'none');
    if (config.pinnedImageTag) {
      let pinned = await resolveVersionByTag(this.env.KV_CLAW_CACHE, config.pinnedImageTag);

      if (!pinned && !this.env.HYPERDRIVE?.connectionString) {
        doError(this.s, 'HYPERDRIVE not configured — cannot look up pinned tag in Postgres', {
          pinnedImageTag: config.pinnedImageTag,
        });
      }
      if (!pinned && this.env.HYPERDRIVE?.connectionString) {
        try {
          const catalogEntry = await lookupCatalogVersion(
            this.env.HYPERDRIVE.connectionString,
            config.pinnedImageTag
          );
          if (catalogEntry) {
            const variantParse = ImageVariantSchema.safeParse(catalogEntry.variant);
            if (!variantParse.success) {
              doError(this.s, 'Invalid variant from Postgres catalog, skipping', {
                variant: catalogEntry.variant,
                pinnedImageTag: config.pinnedImageTag,
                validationErrors: variantParse.error.flatten(),
              });
            } else {
              pinned = {
                openclawVersion: catalogEntry.openclawVersion,
                variant: variantParse.data,
                imageTag: catalogEntry.imageTag,
                imageDigest: catalogEntry.imageDigest,
                publishedAt: catalogEntry.publishedAt,
              };
              console.debug(
                '[DO] Resolved pinned tag from Postgres catalog:',
                config.pinnedImageTag
              );
            }
          }
        } catch (err) {
          doWarn(this.s, 'Failed to look up pinned tag in Postgres', {
            error: toLoggable(err),
          });
        }
      }

      if (pinned) {
        this.s.openclawVersion = pinned.openclawVersion;
        this.s.imageVariant = pinned.variant;
        this.s.trackedImageTag = pinned.imageTag;
        this.s.trackedImageDigest = pinned.imageDigest;
        console.debug('[DO] Using pinned version:', pinned.openclawVersion, '→', pinned.imageTag);
      } else {
        doWarn(this.s, 'Pinned tag not found in KV or Postgres, using tag directly', {
          pinnedImageTag: config.pinnedImageTag,
        });
        this.s.openclawVersion = null;
        this.s.imageVariant = null;
        this.s.trackedImageTag = config.pinnedImageTag;
        this.s.trackedImageDigest = null;
      }
    } else {
      const variant = 'default';
      const latest = await resolveLatestVersion(this.env.KV_CLAW_CACHE, variant);
      if (latest) {
        this.s.openclawVersion = latest.openclawVersion;
        this.s.imageVariant = latest.variant;
        this.s.trackedImageTag = latest.imageTag;
        this.s.trackedImageDigest = latest.imageDigest;
      } else if (isNew) {
        this.s.openclawVersion = null;
        this.s.imageVariant = null;
        this.s.trackedImageTag = null;
        this.s.trackedImageDigest = null;
      }
    }

    const configFields = {
      userId,
      sandboxId,
      orgId: opts?.orgId ?? null,
      status: (this.s.status ?? 'provisioned') satisfies InstanceStatus,
      envVars: config.envVars ?? null,
      encryptedSecrets: config.encryptedSecrets ?? null,
      kilocodeApiKey: config.kilocodeApiKey ?? null,
      kilocodeApiKeyExpiresAt: config.kilocodeApiKeyExpiresAt ?? null,
      kilocodeDefaultModel: config.kilocodeDefaultModel ?? null,
      channels: config.channels ?? null,
      machineSize: config.machineSize ?? this.s.machineSize ?? null,
    } satisfies Partial<PersistedState>;

    const versionFields = {
      openclawVersion: this.s.openclawVersion,
      imageVariant: this.s.imageVariant,
      trackedImageTag: this.s.trackedImageTag,
      trackedImageDigest: this.s.trackedImageDigest,
    };

    if (isNew) {
      this.s.instanceFeatures = [...DEFAULT_INSTANCE_FEATURES];
    }

    const update = isNew
      ? storageUpdate({
          ...configFields,
          ...versionFields,
          instanceFeatures: this.s.instanceFeatures,
          provisionedAt: Date.now(),
          lastStartedAt: null,
          lastStoppedAt: null,
          flyAppName: this.s.flyAppName,
          flyMachineId: this.s.flyMachineId,
          flyVolumeId: this.s.flyVolumeId,
          flyRegion: this.s.flyRegion,
          healthCheckFailCount: 0,
          pendingDestroyMachineId: null,
          pendingDestroyVolumeId: null,
          pendingPostgresMarkOnFinalize: false,
          instanceReadyEmailSent: false,
        })
      : storageUpdate({
          ...configFields,
          ...versionFields,
          instanceFeatures: this.s.instanceFeatures,
        });

    await this.ctx.storage.put(update);

    this.s.userId = userId;
    this.s.sandboxId = sandboxId;
    this.s.orgId = opts?.orgId ?? null;
    this.s.status = this.s.status ?? 'provisioned';
    this.s.envVars = config.envVars ?? null;
    this.s.encryptedSecrets = config.encryptedSecrets ?? null;
    this.s.kilocodeApiKey = config.kilocodeApiKey ?? null;
    this.s.kilocodeApiKeyExpiresAt = config.kilocodeApiKeyExpiresAt ?? null;
    this.s.kilocodeDefaultModel = config.kilocodeDefaultModel ?? null;
    this.s.channels = config.channels ?? null;
    this.s.machineSize = config.machineSize ?? this.s.machineSize ?? null;
    if (isNew) {
      this.s.provisionedAt = Date.now();
      this.s.lastStartedAt = null;
      this.s.lastStoppedAt = null;
      this.s.healthCheckFailCount = 0;
      this.s.pendingDestroyMachineId = null;
      this.s.pendingDestroyVolumeId = null;
      this.s.pendingPostgresMarkOnFinalize = false;
      this.s.instanceReadyEmailSent = false;
    }
    this.s.loaded = true;

    // Set up the default Stream Chat channel on first provision (best-effort).
    // The bot and channel are created server-side here so the API secret never
    // reaches the Fly Machine. Failure is non-fatal: the instance will start
    // without the Stream Chat channel rather than blocking provisioning.
    // Set up or backfill the default Stream Chat channel (best-effort).
    // On first provision (isNew) this creates the channel from scratch.
    // On re-provision (!isNew) this backfills instances created before the
    // feature was added. setupDefaultStreamChatChannel is idempotent
    // (upsert users, getOrCreate channel). Failure is non-fatal.
    if (
      !this.s.streamChatApiKey &&
      this.env.STREAM_CHAT_API_KEY &&
      this.env.STREAM_CHAT_API_SECRET
    ) {
      try {
        const streamChat = await setupDefaultStreamChatChannel(
          this.env.STREAM_CHAT_API_KEY,
          this.env.STREAM_CHAT_API_SECRET,
          sandboxId
        );
        this.s.streamChatApiKey = streamChat.apiKey;
        this.s.streamChatBotUserId = streamChat.botUserId;
        this.s.streamChatBotUserToken = streamChat.botUserToken;
        this.s.streamChatChannelId = streamChat.channelId;
        await this.persist({
          streamChatApiKey: streamChat.apiKey,
          streamChatBotUserId: streamChat.botUserId,
          streamChatBotUserToken: streamChat.botUserToken,
          streamChatChannelId: streamChat.channelId,
        });
        console.log(
          `[DO] Stream Chat channel ${isNew ? 'provisioned' : 'backfilled'}:`,
          streamChat.channelId
        );
      } catch (err) {
        doWarn(this.s, 'Stream Chat channel setup failed (non-fatal)', {
          error: toLoggable(err),
        });
      }
    }

    if (isNew) {
      await this.scheduleAlarm();
    }

    if (isNew) {
      await this.startAsync(userId);
    }

    this.emitEvent({
      event: 'instance.provisioned',
      status: 'provisioned',
      durationMs: performance.now() - provisionStart,
    });

    return { sandboxId };
  }

  async updateKiloCodeConfig(patch: {
    kilocodeApiKey?: string | null;
    kilocodeApiKeyExpiresAt?: string | null;
    kilocodeDefaultModel?: string | null;
  }): Promise<{
    kilocodeApiKey: string | null;
    kilocodeApiKeyExpiresAt: string | null;
    kilocodeDefaultModel: string | null;
  }> {
    await this.loadState();

    const pending: Partial<PersistedState> = {};

    if (patch.kilocodeApiKey !== undefined) {
      this.s.kilocodeApiKey = patch.kilocodeApiKey;
      pending.kilocodeApiKey = this.s.kilocodeApiKey;
    }
    if (patch.kilocodeApiKeyExpiresAt !== undefined) {
      this.s.kilocodeApiKeyExpiresAt = patch.kilocodeApiKeyExpiresAt;
      pending.kilocodeApiKeyExpiresAt = this.s.kilocodeApiKeyExpiresAt;
    }
    if (patch.kilocodeDefaultModel !== undefined) {
      this.s.kilocodeDefaultModel = patch.kilocodeDefaultModel;
      pending.kilocodeDefaultModel = this.s.kilocodeDefaultModel;
    }

    if (Object.keys(pending).length > 0) {
      await this.ctx.storage.put(pending);
    }

    if (patch.kilocodeDefaultModel !== undefined) {
      const model = this.s.kilocodeDefaultModel ?? OPENCLAW_BUILTIN_DEFAULT_MODEL;
      await gateway.patchConfigOnMachine(this.s, this.env, {
        agents: { defaults: { model: { primary: model } } },
      });
    }

    return {
      kilocodeApiKey: this.s.kilocodeApiKey,
      kilocodeApiKeyExpiresAt: this.s.kilocodeApiKeyExpiresAt,
      kilocodeDefaultModel: this.s.kilocodeDefaultModel,
    };
  }

  async updateExecPreset(patch: {
    security?: string;
    ask?: string;
  }): Promise<{ execSecurity: string | null; execAsk: string | null }> {
    await this.loadState();

    const pending: Partial<PersistedState> = {};

    if (patch.security !== undefined) {
      this.s.execSecurity = patch.security;
      pending.execSecurity = patch.security;
    }
    if (patch.ask !== undefined) {
      this.s.execAsk = patch.ask;
      pending.execAsk = patch.ask;
    }

    if (Object.keys(pending).length > 0) {
      await this.ctx.storage.put(pending);
    }

    return {
      execSecurity: this.s.execSecurity,
      execAsk: this.s.execAsk,
    };
  }

  async updateChannels(patch: {
    telegramBotToken?: EncryptedEnvelope | null;
    discordBotToken?: EncryptedEnvelope | null;
    slackBotToken?: EncryptedEnvelope | null;
    slackAppToken?: EncryptedEnvelope | null;
  }): Promise<{
    telegram: boolean;
    discord: boolean;
    slackBot: boolean;
    slackApp: boolean;
  }> {
    const secretsPatch: Record<string, EncryptedEnvelope | null> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        secretsPatch[key] = value;
      }
    }

    const { configured } = await this.updateSecrets(secretsPatch);

    return {
      telegram: configured.includes('telegramBotToken'),
      discord: configured.includes('discordBotToken'),
      slackBot: configured.includes('slackBotToken'),
      slackApp: configured.includes('slackAppToken'),
    };
  }

  async updateSecrets(
    patch: Record<string, EncryptedEnvelope | null>,
    meta?: Record<string, CustomSecretMeta>
  ): Promise<{ configured: SecretFieldKey[] }> {
    await this.loadState();

    // Separate catalog secrets (keyed by field key) from custom secrets
    // (keyed directly by env var name).
    const currentSecrets: Record<string, EncryptedEnvelope | null> = {
      ...(this.s.channels ?? {}),
    };
    const customSecrets: Record<string, EncryptedEnvelope> = {};
    if (this.s.encryptedSecrets) {
      for (const [key, value] of Object.entries(this.s.encryptedSecrets)) {
        const fieldKey = ENV_VAR_TO_FIELD_KEY.get(key);
        if (fieldKey) {
          currentSecrets[fieldKey] = value;
        } else {
          customSecrets[key] = value;
        }
      }
    }

    // Apply the patch — catalog field keys go to currentSecrets, custom
    // env var names go directly to customSecrets.
    for (const [key, value] of Object.entries(patch)) {
      const isCatalogKey = ALL_SECRET_FIELD_KEYS.has(key);
      if (value === null) {
        console.log('[DO] Secret removed', { key, operation: 'remove' });
        if (isCatalogKey) {
          delete currentSecrets[key];
        } else {
          delete customSecrets[key];
        }
      } else {
        console.log('[DO] Secret updated', { key, operation: 'set' });
        if (isCatalogKey) {
          currentSecrets[key] = value;
        } else {
          customSecrets[key] = value;
        }
      }
    }

    // Enforce allFieldsRequired for catalog entries (e.g., Slack needs both tokens)
    for (const entry of SECRET_CATALOG) {
      if (!entry.allFieldsRequired) continue;
      const fieldValues = entry.fields.map(f => currentSecrets[f.key]);
      const hasAny = fieldValues.some(v => v != null);
      const hasAll = fieldValues.every(v => v != null);
      if (hasAny && !hasAll) {
        const err = new Error(
          `Invalid secret patch: ${entry.label} requires all fields to be set together`
        );
        (err as Error & { status: number }).status = 400;
        throw err;
      }
    }

    // Enforce custom secret count limit
    const customCount = Object.keys(customSecrets).length;
    if (customCount > MAX_CUSTOM_SECRETS) {
      const err = new Error(
        `Custom secret limit exceeded: ${customCount} secrets (max ${MAX_CUSTOM_SECRETS})`
      );
      (err as Error & { status: number }).status = 400;
      throw err;
    }

    // Backward compat: write channel secrets to legacy channels field
    const channelKeys = new Set(
      SECRET_CATALOG.filter(e => e.category === 'channel').flatMap(e => e.fields.map(f => f.key))
    );
    const channelsSubset: Record<string, EncryptedEnvelope> = {};
    for (const [key, value] of Object.entries(currentSecrets)) {
      if (channelKeys.has(key) && value) {
        channelsSubset[key] = value;
      }
    }

    const hasChannels = Object.keys(channelsSubset).length > 0;
    this.s.channels = hasChannels ? (channelsSubset as PersistedState['channels']) : null;

    // Build cleaned catalog secrets (non-null only)
    const cleanedSecrets: Record<string, EncryptedEnvelope> = {};
    for (const [key, value] of Object.entries(currentSecrets)) {
      if (value) {
        cleanedSecrets[key] = value;
      }
    }

    const configured = Object.keys(cleanedSecrets).filter((k): k is SecretFieldKey =>
      ALL_SECRET_FIELD_KEYS.has(k)
    );

    // Merge catalog secrets (remapped to env var names) with custom secrets
    const remappedSecrets: Record<string, EncryptedEnvelope> = { ...customSecrets };
    for (const [key, value] of Object.entries(cleanedSecrets)) {
      const envName = FIELD_KEY_TO_ENV_VAR.get(key) ?? key;
      remappedSecrets[envName] = value;
    }
    const hasSecrets = Object.keys(remappedSecrets).length > 0;
    this.s.encryptedSecrets = hasSecrets ? remappedSecrets : null;

    // Update custom secret metadata (config paths, etc.)
    // Always clean up metadata for deleted secrets, even without a meta param.
    const currentMeta = { ...(this.s.customSecretMeta ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (ALL_SECRET_FIELD_KEYS.has(key)) continue;
      if (value === null) {
        delete currentMeta[key];
      }
    }
    // Set/update metadata for any keys provided in meta
    if (meta) {
      for (const [key, metaValue] of Object.entries(meta)) {
        if (ALL_SECRET_FIELD_KEYS.has(key)) continue;
        // Reject duplicate config paths — no two secrets may target the same path
        if (metaValue.configPath) {
          for (const [existingKey, existingMeta] of Object.entries(currentMeta)) {
            if (existingKey !== key && existingMeta.configPath === metaValue.configPath) {
              const err = new Error(
                `Config path "${metaValue.configPath}" is already used by secret "${existingKey}"`
              );
              (err as Error & { status: number }).status = 400;
              throw err;
            }
          }
        }
        currentMeta[key] = metaValue;
      }
    }
    const hasMeta = Object.keys(currentMeta).length > 0;
    this.s.customSecretMeta = hasMeta ? currentMeta : null;

    await this.ctx.storage.put({
      channels: this.s.channels,
      encryptedSecrets: this.s.encryptedSecrets,
      customSecretMeta: this.s.customSecretMeta,
    });

    return { configured };
  }

  /**
   * Store encrypted Google credentials (client_secret.json + OAuth tokens).
   * Does NOT restart the machine; the caller should prompt the user to restart.
   */
  async updateGoogleCredentials(
    credentials: GoogleCredentials
  ): Promise<{ googleConnected: boolean }> {
    await this.loadState();

    this.s.googleCredentials = credentials;
    this.s.gmailPushOidcEmail = credentials.gmailPushOidcEmail ?? null;
    this.s.gmailNotificationsEnabled = true;

    await this.ctx.storage.put({
      googleCredentials: this.s.googleCredentials,
      gmailPushOidcEmail: this.s.gmailPushOidcEmail,
      gmailNotificationsEnabled: true,
    });

    return { googleConnected: true };
  }

  /**
   * Clear stored Google credentials.
   * Does NOT restart the machine; the caller should prompt the user to restart.
   * Also disables Gmail notifications to prevent stale state.
   */
  async clearGoogleCredentials(): Promise<{ googleConnected: boolean }> {
    await this.loadState();

    this.s.googleCredentials = null;
    this.s.gmailNotificationsEnabled = false;
    this.s.gmailLastHistoryId = null;
    this.s.gmailPushOidcEmail = null;
    await this.ctx.storage.put({
      googleCredentials: null,
      gmailNotificationsEnabled: false,
      gmailLastHistoryId: null,
      gmailPushOidcEmail: null,
    });

    return { googleConnected: false };
  }

  /**
   * Update the last-seen Gmail history ID.
   * Only writes if the new value is numerically greater than the stored one,
   * preventing out-of-order updates from overwriting newer state.
   */
  async updateGmailHistoryId(historyId: string): Promise<void> {
    await this.loadState();

    const current = this.s.gmailLastHistoryId;
    try {
      const newNum = BigInt(historyId);
      if (current !== null) {
        const currentNum = BigInt(current);
        if (newNum <= currentNum) {
          return;
        }
      }
    } catch {
      return; // invalid input (BigInt throws on non-numeric strings)
    }

    this.s.gmailLastHistoryId = historyId;
    await this.persist({ gmailLastHistoryId: historyId });
  }

  /**
   * Return the stored OIDC service account email for Gmail push validation.
   * Lightweight — no side effects, no Fly checks.
   */
  async getGmailOidcEmail(): Promise<{ gmailPushOidcEmail: string | null }> {
    await this.loadState();
    return { gmailPushOidcEmail: this.s.gmailPushOidcEmail };
  }

  /**
   * Enable or disable Gmail push notifications.
   * Persists the flag — takes effect immediately at the queue consumer level, no restart needed.
   */
  async updateGmailNotifications(
    enabled: boolean
  ): Promise<{ gmailNotificationsEnabled: boolean }> {
    await this.loadState();

    if (!this.s.userId || !this.s.sandboxId) {
      throw new Error('Instance is not provisioned');
    }

    if (enabled && !this.s.googleCredentials) {
      throw new Error('Cannot enable Gmail notifications without a connected Google account');
    }

    this.s.gmailNotificationsEnabled = enabled;
    await this.persist({ gmailNotificationsEnabled: enabled });

    return { gmailNotificationsEnabled: enabled };
  }

  // ── Pairing ─────────────────────────────────────────────────────────

  async listPairingRequests(forceRefresh = false) {
    await this.loadState();
    return pairing.listPairingRequests(this.s, this.env, forceRefresh);
  }

  async approvePairingRequest(channel: string, code: string) {
    await this.loadState();
    return pairing.approvePairingRequest(this.s, this.env, channel, code);
  }

  async listDevicePairingRequests(forceRefresh = false) {
    await this.loadState();
    return pairing.listDevicePairingRequests(this.s, this.env, forceRefresh);
  }

  async approveDevicePairingRequest(requestId: string) {
    await this.loadState();
    return pairing.approveDevicePairingRequest(this.s, this.env, requestId);
  }

  async runDoctor() {
    await this.loadState();
    return pairing.runDoctor(this.s, this.env);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async forceRetryRecovery(): Promise<{ ok: true }> {
    await this.loadState();

    if (this.s.status === 'destroying') {
      throw Object.assign(new Error('Cannot retry recovery: instance is being destroyed'), {
        status: 409,
      });
    }
    if (!this.s.status) {
      throw Object.assign(new Error('Cannot retry recovery: instance has no status'), {
        status: 404,
      });
    }

    doWarn(this.s, 'forceRetryRecovery: admin-initiated cooldown reset', {
      previousLastRecoveryAt: this.s.lastMetadataRecoveryAt,
      status: this.s.status,
    });

    this.s.lastMetadataRecoveryAt = null;
    await this.persist({ lastMetadataRecoveryAt: null });
    await this.ctx.storage.setAlarm(Date.now());

    return { ok: true };
  }

  async start(
    userId?: string,
    options?: { skipCooldown?: boolean }
  ): Promise<{ started: boolean }> {
    // Guard against concurrent start() calls — two overlapping invocations
    // (e.g. startAsync via waitUntil + a direct RPC start) can both see
    // flyMachineId as null and each create a Fly machine, orphaning one.
    if (this.startInProgress) {
      doWarn(this.s, 'start: already in progress, skipping duplicate call');
      return { started: false };
    }
    this.startInProgress = true;

    try {
      return await this._startInner(userId, options);
    } finally {
      this.startInProgress = false;
    }
  }

  private async _startInner(
    userId?: string,
    options?: { skipCooldown?: boolean }
  ): Promise<{ started: boolean }> {
    await this.loadState();

    if (this.s.status === 'destroying') {
      throw new Error('Cannot start: instance is being destroyed');
    }
    if (this.s.status === 'restoring') {
      throw new Error('Cannot start: instance is restoring from snapshot');
    }
    // NOTE: status may be 'starting' here when called from startAsync() via
    // waitUntil. That is intentional — 'starting' is the expected in-flight
    // state and must not be treated as an error or early-return condition.
    // Do not add a guard that rejects non-stopped/provisioned statuses without
    // also explicitly allowing 'starting'.

    if (!this.s.userId || !this.s.sandboxId) {
      const restoreUserId = userId ?? this.s.userId;
      if (restoreUserId) {
        await restoreFromPostgres(this.env, this.ctx, this.s, restoreUserId);
      }
    }

    if (!this.s.userId || !this.s.sandboxId) {
      throw Object.assign(new Error('Instance not provisioned'), { status: 404 });
    }

    const flyConfig = getFlyConfig(this.env, this.s);

    // If the DO has identity but lost its machine ID, try to recover it
    // from Fly metadata before creating a duplicate machine.
    // Skip recovery when the machine was intentionally destroyed for a volume swap
    // (snapshot restore or reassociation). Both paths set previousVolumeId and clear
    // flyMachineId in the same persist call, leaving status === 'stopped'. This triple
    // condition is only true immediately after an intentional destroy — once start()
    // creates a new machine, flyMachineId is no longer null and this won't match.
    const machineIntentionallyDestroyed =
      !this.s.flyMachineId && this.s.previousVolumeId !== null && this.s.status === 'stopped';
    if (!this.s.flyMachineId && !machineIntentionallyDestroyed) {
      const recovered = await attemptMetadataRecovery(
        flyConfig,
        this.ctx,
        this.s,
        createReconcileContext(this.s, this.env, 'start_recovery'),
        options?.skipCooldown
      );
      if (!recovered && !this.s.flyMachineId) {
        throw new Error(
          'Metadata recovery failed; aborting start to avoid creating a duplicate machine'
        );
      }
    }

    await flyMachines.ensureVolume(flyConfig, this.ctx, this.s, this.env, 'start');

    // Verify volume region matches cached flyRegion
    if (this.s.flyVolumeId) {
      try {
        const volume = await fly.getVolume(flyConfig, this.s.flyVolumeId);
        if (volume.region !== this.s.flyRegion) {
          doWarn(this.s, 'flyRegion drift detected', {
            cachedRegion: this.s.flyRegion,
            actualRegion: volume.region,
          });
          this.s.flyRegion = volume.region;
          await this.persist({ flyRegion: volume.region });
        }
      } catch (err) {
        if (fly.isFlyNotFound(err)) {
          doWarn(this.s, 'Volume not found during region check, clearing');
          this.s.flyVolumeId = null;
          this.s.flyRegion = null;
          await this.persist({ flyVolumeId: null, flyRegion: null });
          await flyMachines.ensureVolume(flyConfig, this.ctx, this.s, this.env, 'start');
        }
      }
    }

    // If running, verify machine is actually alive
    if (this.s.status === 'running' && this.s.flyMachineId) {
      try {
        const machine = await fly.getMachine(flyConfig, this.s.flyMachineId);
        if (machine.state === 'started') {
          await reconcileMachineMount(
            flyConfig,
            this.ctx,
            this.s,
            machine,
            createReconcileContext(this.s, this.env, 'start')
          );
          console.log('[DO] Machine already running, mount verified');
          await this.scheduleAlarm();
          return { started: false };
        }
        console.log('[DO] Status is running but machine state is:', machine.state, '-- restarting');
      } catch (err) {
        console.log('[DO] Failed to get machine state, will recreate:', err);
      }
    }

    const { envVars, minSecretsVersion } = await buildUserEnvVars(this.env, this.ctx, this.s);
    const guest = guestFromSize(this.s.machineSize);
    const imageTag = resolveImageTag(this.s, this.env);
    console.log(
      '[DO] startGateway: deploying with imageTag:',
      imageTag,
      'trackedImageTag:',
      this.s.trackedImageTag,
      'openclawVersion:',
      this.s.openclawVersion
    );
    const identity = {
      userId: this.s.userId,
      sandboxId: this.s.sandboxId,
      openclawVersion: this.s.openclawVersion,
      imageVariant: this.s.imageVariant,
    };
    const machineConfig = buildMachineConfig(
      getRegistryApp(this.env),
      imageTag,
      envVars,
      guest,
      this.s.flyVolumeId,
      identity
    );

    try {
      if (this.s.flyMachineId) {
        await flyMachines.startExistingMachine(
          flyConfig,
          this.ctx,
          this.s,
          machineConfig,
          minSecretsVersion,
          this.env.FLY_REGION
        );
      } else {
        await flyMachines.createNewMachine(
          flyConfig,
          this.ctx,
          this.s,
          machineConfig,
          minSecretsVersion,
          this.env.FLY_REGION
        );
      }
    } catch (err) {
      if (!fly.isFlyInsufficientResources(err)) throw err;

      const code = err instanceof fly.FlyApiError ? err.status : 0;
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.emitStartCapacityRecovery(errorMessage, this.capacityRecoveryLabel(err));
      doError(this.s, 'Insufficient resources, replacing stranded volume', {
        statusCode: code,
        region: this.s.flyRegion ?? 'unknown',
      });

      // Evict the current region from KV so future provisions avoid it.
      // Only on 403 (org quota exceeded) — 409 (host memory) is transient.
      // createVolumeWithFallback already evicts on volume-creation failures,
      // but machine-creation 403s bypass that path.
      if (code === 403 && this.s.flyRegion) {
        await evictCapacityRegionFromKV(this.env.KV_CLAW_CACHE, this.env, this.s.flyRegion);
      }

      await flyMachines.replaceStrandedVolume(
        flyConfig,
        this.ctx,
        this.s,
        this.env,
        `start_${code}_recovery`
      );

      const retryConfig = buildMachineConfig(
        getRegistryApp(this.env),
        imageTag,
        envVars,
        guest,
        this.s.flyVolumeId,
        identity
      );
      await flyMachines.createNewMachine(
        flyConfig,
        this.ctx,
        this.s,
        retryConfig,
        minSecretsVersion,
        this.env.FLY_REGION
      );
    }

    if (this.s.flyMachineId) {
      await gateway.waitForHealthy(this.s, this.env, flyConfig.appName, this.s.flyMachineId);
    }

    // Re-check status directly from storage: if the instance was destroyed while
    // start() was running in the background (via startAsync/waitUntil), bail out
    // so teardown wins. We bypass loadState() because it no-ops when already loaded.
    const currentStatus = await this.ctx.storage.get('status');
    if (!currentStatus || currentStatus === 'destroying') {
      doWarn(this.s, 'start: instance was destroyed while starting, aborting');
      return { started: false };
    }

    const startingAt = this.s.startingAt;
    this.s.status = 'running';
    this.s.startingAt = null;
    this.s.lastStartedAt = Date.now();
    this.s.healthCheckFailCount = 0;
    this.s.lastStartErrorMessage = null;
    this.s.lastStartErrorAt = null;
    await this.persist({
      status: 'running',
      startingAt: null,
      lastStartedAt: this.s.lastStartedAt,
      healthCheckFailCount: 0,
      flyMachineId: this.s.flyMachineId,
      lastStartErrorMessage: null,
      lastStartErrorAt: null,
    });

    this.emitEvent({
      event: 'instance.started',
      status: 'running',
      durationMs: startingAt ? Date.now() - startingAt : undefined,
    });

    await this.scheduleAlarm();
    return { started: true };
  }

  /**
   * Non-blocking start: immediately persists status='starting', schedules a fast
   * alarm, then fires start() in the background via waitUntil.
   * Used by provision() so the RPC call returns quickly instead of waiting for
   * the full Fly startup sequence (which can take up to ~60 s).
   */
  async startAsync(userId?: string): Promise<void> {
    await this.loadState();

    if (this.s.status === 'destroying') {
      throw new Error('Cannot start: instance is being destroyed');
    }
    if (this.s.status === 'restarting') {
      throw new Error('Cannot start: instance is restarting');
    }

    // Mark as starting so the UI can show a polling state immediately.
    // Record startingAt so reconcileStarting() can time out after STARTING_TIMEOUT_MS.
    this.s.status = 'starting';
    this.s.startingAt = Date.now();
    await this.persist({ status: 'starting', startingAt: this.s.startingAt });
    await this.scheduleAlarm();

    // Run the actual start in the background; the reconcile alarm will
    // pick up the result and transition to 'running' (or fall back on error).
    this.ctx.waitUntil(
      this.start(userId).catch(async err => {
        doError(this.s, 'startAsync: background start failed', {
          error: toLoggable(err),
        });
        // Read from storage rather than this.s — waitUntil runs after the
        // originating request context completes and other handlers may have
        // mutated in-memory state in the interim.
        const storedMachineId = await this.ctx.storage.get('flyMachineId');
        const currentStatus = await this.ctx.storage.get('status');
        if (!storedMachineId && currentStatus !== 'destroying') {
          // start() threw before persisting a machine ID. Reconcile cannot
          // distinguish this from "still in progress", so write the terminal
          // state explicitly to avoid the 5-min stuck window.
          // Skip if destroy() has taken ownership — writing 'stopped' would
          // clobber the 'destroying' state and strand cleanup.
          const now = Date.now();
          const errorMessage = err instanceof Error ? err.message : String(err);
          this.s.status = 'stopped';
          this.s.startingAt = null;
          this.s.lastStoppedAt = now;
          this.s.lastStartErrorMessage = errorMessage;
          this.s.lastStartErrorAt = now;
          await this.persist({
            status: 'stopped',
            startingAt: null,
            lastStoppedAt: now,
            lastStartErrorMessage: errorMessage,
            lastStartErrorAt: now,
          });
          this.emitProvisioningFailed('no_machine_created', errorMessage);
        }
        // If storedMachineId exists the machine was created — reconcileStarting
        // will pick up its Fly state via getMachine + syncStatusWithFly. Writing
        // 'stopped' here would race with a machine that is still booting.
      })
    );
  }

  async stop(): Promise<void> {
    await this.loadState();

    if (!this.s.userId || !this.s.sandboxId) {
      throw Object.assign(new Error('Instance not provisioned'), { status: 404 });
    }
    if (
      this.s.status === 'stopped' ||
      this.s.status === 'provisioned' ||
      this.s.status === 'starting' ||
      this.s.status === 'restarting' ||
      this.s.status === 'destroying' ||
      this.s.status === 'restoring'
    ) {
      console.log('[DO] Instance not running (status:', this.s.status, '), no-op');
      return;
    }

    const machineUptimeMs = this.s.lastStartedAt ? Date.now() - this.s.lastStartedAt : 0;

    if (this.s.flyMachineId) {
      const flyConfig = getFlyConfig(this.env, this.s);
      try {
        await fly.stopMachineAndWait(flyConfig, this.s.flyMachineId);
      } catch (err) {
        if (!fly.isFlyNotFound(err)) {
          throw err;
        }
        console.log('[DO] Machine already gone (404), marking stopped');
      }
    }

    this.s.status = 'stopped';
    this.s.lastStoppedAt = Date.now();
    await this.persist({
      status: 'stopped',
      lastStoppedAt: this.s.lastStoppedAt,
    });

    this.emitEvent({
      event: 'instance.stopped',
      status: 'stopped',
      value: machineUptimeMs,
    });

    await this.scheduleAlarm();
  }

  async destroy(): Promise<DestroyResult> {
    await this.loadState();

    if (!this.s.userId || !this.s.sandboxId) {
      throw Object.assign(new Error('Instance not provisioned'), { status: 404 });
    }
    if (this.s.status === 'restoring') {
      throw new Error('Cannot destroy: instance is restoring from snapshot');
    }

    const machineUptimeMs = this.s.lastStartedAt ? Date.now() - this.s.lastStartedAt : 0;

    this.s.pendingDestroyMachineId = this.s.flyMachineId;
    this.s.pendingDestroyVolumeId = this.s.flyVolumeId;
    this.s.status = 'destroying';

    await this.persist({
      status: 'destroying',
      pendingDestroyMachineId: this.s.pendingDestroyMachineId,
      pendingDestroyVolumeId: this.s.pendingDestroyVolumeId,
    });

    this.emitEvent({
      event: 'instance.destroy_started',
      status: 'destroying',
      value: machineUptimeMs,
    });

    // Best-effort: deactivate Stream Chat users so any captured tokens become useless.
    // Failure is non-fatal — worst case is the same as pre-deactivation behavior.
    if (this.env.STREAM_CHAT_API_KEY && this.env.STREAM_CHAT_API_SECRET && this.s.sandboxId) {
      try {
        await deactivateStreamChatUsers(
          this.env.STREAM_CHAT_API_KEY,
          this.env.STREAM_CHAT_API_SECRET,
          [this.s.sandboxId, `bot-${this.s.sandboxId}`]
        );
      } catch (err) {
        doWarn(this.s, 'Stream Chat user deactivation failed (non-fatal)', {
          error: toLoggable(err),
        });
      }
    }

    const flyConfig = getFlyConfig(this.env, this.s);
    const destroyRctx = createReconcileContext(this.s, this.env, 'destroy');
    await tryDeleteMachine(flyConfig, this.ctx, this.s, destroyRctx);
    await tryDeleteVolume(flyConfig, this.ctx, this.s, destroyRctx);

    const finalized = await finalizeDestroyIfComplete(
      this.ctx,
      this.s,
      destroyRctx,
      (userId, sandboxId) =>
        markDestroyedInPostgresHelper(this.env, this.ctx, this.s, userId, sandboxId)
    );
    if (!finalized.finalized) {
      doWarn(this.s, 'Destroy incomplete, alarm will retry', {
        pendingMachineId: this.s.pendingDestroyMachineId,
        pendingVolumeId: this.s.pendingDestroyVolumeId,
      });
      await this.scheduleAlarm();
    }

    return finalized;
  }

  // ========================================================================
  // Read methods
  // ========================================================================

  async getStatus(): Promise<{
    userId: string | null;
    sandboxId: string | null;
    orgId: string | null;
    status: InstanceStatus | null;
    provisionedAt: number | null;
    lastStartedAt: number | null;
    lastStoppedAt: number | null;
    envVarCount: number;
    secretCount: number;
    channelCount: number;
    flyAppName: string | null;
    flyMachineId: string | null;
    flyVolumeId: string | null;
    flyRegion: string | null;
    machineSize: MachineSize | null;
    openclawVersion: string | null;
    imageVariant: string | null;
    trackedImageTag: string | null;
    trackedImageDigest: string | null;
    googleConnected: boolean;
    gmailNotificationsEnabled: boolean;
    execSecurity: string | null;
    execAsk: string | null;
  }> {
    await this.loadState();

    if (
      this.s.status === 'running' &&
      this.s.flyMachineId &&
      (this.s.lastLiveCheckAt === null ||
        Date.now() - this.s.lastLiveCheckAt >= LIVE_CHECK_THROTTLE_MS)
    ) {
      this.s.lastLiveCheckAt = Date.now();
      this.ctx.waitUntil(syncStatusFromLiveCheck(this.ctx, this.s, this.env));
    }

    return {
      userId: this.s.userId,
      sandboxId: this.s.sandboxId,
      orgId: this.s.orgId,
      status: this.s.status,
      provisionedAt: this.s.provisionedAt,
      lastStartedAt: this.s.lastStartedAt,
      lastStoppedAt: this.s.lastStoppedAt,
      envVarCount: this.s.envVars ? Object.keys(this.s.envVars).length : 0,
      secretCount: this.s.encryptedSecrets
        ? Object.keys(this.s.encryptedSecrets).filter(k => !CHANNEL_ENV_VARS.has(k)).length
        : 0,
      channelCount: this.s.channels ? Object.values(this.s.channels).filter(Boolean).length : 0,
      flyAppName: this.s.flyAppName,
      flyMachineId: this.s.flyMachineId,
      flyVolumeId: this.s.flyVolumeId,
      flyRegion: this.s.flyRegion,
      machineSize: this.s.machineSize,
      openclawVersion: this.s.openclawVersion,
      imageVariant: this.s.imageVariant,
      trackedImageTag: this.s.trackedImageTag,
      trackedImageDigest: this.s.trackedImageDigest,
      googleConnected: this.s.googleCredentials !== null,
      gmailNotificationsEnabled: this.s.gmailNotificationsEnabled,
      execSecurity: this.s.execSecurity,
      execAsk: this.s.execAsk,
    };
  }

  async getStreamChatCredentials(): Promise<{
    apiKey: string;
    userId: string;
    userToken: string;
    channelId: string;
  } | null> {
    await this.loadState();

    if (
      !this.s.streamChatApiKey ||
      !this.env.STREAM_CHAT_API_SECRET ||
      !this.s.streamChatChannelId ||
      !this.s.sandboxId
    ) {
      return null;
    }

    // Mint a short-lived token on every request so that revoked users lose
    // access when the token expires, without requiring an app-secret rotation.
    const userToken = await createShortLivedUserToken(
      this.env.STREAM_CHAT_API_SECRET,
      this.s.sandboxId
    );

    return {
      apiKey: this.s.streamChatApiKey,
      userId: this.s.sandboxId,
      userToken,
      channelId: this.s.streamChatChannelId,
    };
  }

  async getDebugState(): Promise<{
    userId: string | null;
    sandboxId: string | null;
    orgId: string | null;
    status: InstanceStatus | null;
    provisionedAt: number | null;
    lastStartedAt: number | null;
    lastStoppedAt: number | null;
    envVarCount: number;
    secretCount: number;
    channelCount: number;
    flyAppName: string | null;
    flyMachineId: string | null;
    flyVolumeId: string | null;
    flyRegion: string | null;
    machineSize: MachineSize | null;
    openclawVersion: string | null;
    imageVariant: string | null;
    trackedImageTag: string | null;
    trackedImageDigest: string | null;
    googleConnected: boolean;
    gmailNotificationsEnabled: boolean;
    pendingDestroyMachineId: string | null;
    pendingDestroyVolumeId: string | null;
    pendingPostgresMarkOnFinalize: boolean;
    lastMetadataRecoveryAt: number | null;
    lastLiveCheckAt: number | null;
    alarmScheduledAt: number | null;
    lastDestroyErrorOp: 'machine' | 'volume' | 'recover' | null;
    lastDestroyErrorStatus: number | null;
    lastDestroyErrorMessage: string | null;
    lastDestroyErrorAt: number | null;
    lastStartErrorMessage: string | null;
    lastStartErrorAt: number | null;
    lastRestartErrorMessage: string | null;
    lastRestartErrorAt: number | null;
    previousVolumeId: string | null;
    restoreStartedAt: string | null;
    pendingRestoreVolumeId: string | null;
    instanceReadyEmailSent: boolean;
  }> {
    await this.loadState();
    const alarmScheduledAt = await this.ctx.storage.getAlarm();

    return {
      userId: this.s.userId,
      sandboxId: this.s.sandboxId,
      orgId: this.s.orgId,
      status: this.s.status,
      provisionedAt: this.s.provisionedAt,
      lastStartedAt: this.s.lastStartedAt,
      lastStoppedAt: this.s.lastStoppedAt,
      envVarCount: this.s.envVars ? Object.keys(this.s.envVars).length : 0,
      secretCount: this.s.encryptedSecrets
        ? Object.keys(this.s.encryptedSecrets).filter(k => !CHANNEL_ENV_VARS.has(k)).length
        : 0,
      channelCount: this.s.channels ? Object.values(this.s.channels).filter(Boolean).length : 0,
      flyAppName: this.s.flyAppName,
      flyMachineId: this.s.flyMachineId,
      flyVolumeId: this.s.flyVolumeId,
      flyRegion: this.s.flyRegion,
      machineSize: this.s.machineSize,
      openclawVersion: this.s.openclawVersion,
      imageVariant: this.s.imageVariant,
      trackedImageTag: this.s.trackedImageTag,
      trackedImageDigest: this.s.trackedImageDigest,
      googleConnected: this.s.googleCredentials !== null,
      gmailNotificationsEnabled: this.s.gmailNotificationsEnabled,
      pendingDestroyMachineId: this.s.pendingDestroyMachineId,
      pendingDestroyVolumeId: this.s.pendingDestroyVolumeId,
      pendingPostgresMarkOnFinalize: this.s.pendingPostgresMarkOnFinalize,
      lastMetadataRecoveryAt: this.s.lastMetadataRecoveryAt,
      lastLiveCheckAt: this.s.lastLiveCheckAt,
      alarmScheduledAt,
      lastDestroyErrorOp: this.s.lastDestroyErrorOp,
      lastDestroyErrorStatus: this.s.lastDestroyErrorStatus,
      lastDestroyErrorMessage: this.s.lastDestroyErrorMessage,
      lastDestroyErrorAt: this.s.lastDestroyErrorAt,
      lastStartErrorMessage: this.s.lastStartErrorMessage,
      lastStartErrorAt: this.s.lastStartErrorAt,
      lastRestartErrorMessage: this.s.lastRestartErrorMessage,
      lastRestartErrorAt: this.s.lastRestartErrorAt,
      previousVolumeId: this.s.previousVolumeId,
      restoreStartedAt: this.s.restoreStartedAt,
      pendingRestoreVolumeId: this.s.pendingRestoreVolumeId,
      instanceReadyEmailSent: this.s.instanceReadyEmailSent,
    };
  }

  async getConfig(): Promise<InstanceConfig> {
    await this.loadState();
    return {
      envVars: this.s.envVars ?? undefined,
      encryptedSecrets: this.s.encryptedSecrets ?? undefined,
      kilocodeApiKey: this.s.kilocodeApiKey ?? undefined,
      kilocodeApiKeyExpiresAt: this.s.kilocodeApiKeyExpiresAt ?? undefined,
      kilocodeDefaultModel: this.s.kilocodeDefaultModel ?? undefined,
      channels: this.s.channels ?? undefined,
      machineSize: this.s.machineSize ?? undefined,
      customSecretMeta: this.s.customSecretMeta ?? undefined,
    };
  }

  /**
   * Atomically check-and-set the instance ready flag. Returns shouldNotify: true
   * on the first call per provision lifecycle, false on all subsequent calls.
   * Used by the controller checkin handler to trigger a one-time "instance ready" email.
   */
  async tryMarkInstanceReady(): Promise<{ shouldNotify: boolean; userId: string | null }> {
    await this.loadState();
    if (this.s.instanceReadyEmailSent) {
      return { shouldNotify: false, userId: this.s.userId };
    }

    this.s.instanceReadyEmailSent = true;
    await this.persist({ instanceReadyEmailSent: true });

    // If the instance was provisioned more than 6 hours ago, don't send the email
    if (this.s.provisionedAt && this.s.provisionedAt < Date.now() - 1000 * 60 * 60 * 6) {
      return { shouldNotify: false, userId: this.s.userId };
    }

    return { shouldNotify: true, userId: this.s.userId };
  }

  async listVolumeSnapshots(): Promise<FlyVolumeSnapshot[]> {
    await this.loadState();
    if (!this.s.flyVolumeId) return [];
    const flyConfig = getFlyConfig(this.env, this.s);
    return fly.listVolumeSnapshots(flyConfig, this.s.flyVolumeId);
  }

  // ── Volume reassociation (admin) ───────────────────────────────────

  async listCandidateVolumes(): Promise<{
    currentVolumeId: string | null;
    volumes: (FlyVolume & { isCurrent: boolean })[];
  }> {
    await this.loadState();
    const flyConfig = getFlyConfig(this.env, this.s);
    const allVolumes = await fly.listVolumes(flyConfig);
    // Filter out destroyed/destroying volumes
    const usable = allVolumes.filter(v => v.state !== 'destroyed' && v.state !== 'destroying');
    return {
      currentVolumeId: this.s.flyVolumeId,
      volumes: usable.map(v => ({ ...v, isCurrent: v.id === this.s.flyVolumeId })),
    };
  }

  async reassociateVolume(
    newVolumeId: string,
    reason: string
  ): Promise<{
    previousVolumeId: string | null;
    newVolumeId: string;
    newRegion: string;
  }> {
    await this.loadState();

    if (!this.s.userId) {
      throw new Error('Instance is not provisioned');
    }

    if (this.s.status === 'restoring') {
      throw new Error('Cannot reassociate: instance is restoring from snapshot');
    }
    if (this.s.status !== 'stopped') {
      throw new Error('Instance must be stopped before reassociating volume');
    }

    if (this.s.flyVolumeId === newVolumeId) {
      throw new Error('New volume ID is the same as the current volume');
    }

    // Validate that the volume exists in this app
    const flyConfig = getFlyConfig(this.env, this.s);
    let volume: FlyVolume;
    try {
      volume = await fly.getVolume(flyConfig, newVolumeId);
    } catch {
      throw new Error(`Volume ${newVolumeId} not found in this Fly app`);
    }

    if (volume.state === 'destroyed' || volume.state === 'destroying') {
      throw new Error(`Volume ${newVolumeId} is in state "${volume.state}" and cannot be used`);
    }

    const previousVolumeId = this.s.flyVolumeId;

    console.log(
      `[admin-volume-reassociate] userId=${this.s.userId} ` +
        `previous=${previousVolumeId} new=${newVolumeId} region=${volume.region} ` +
        `reason="${reason}"`
    );

    // Destroy the existing machine so Fly releases the old volume's attached_machine_id.
    // start() will create a fresh machine with the new volume mount.
    if (this.s.flyMachineId) {
      try {
        await fly.destroyMachine(flyConfig, this.s.flyMachineId, true);
        console.log(`[DO] Machine destroyed for reassociation: ${this.s.flyMachineId}`);
      } catch (err) {
        if (!fly.isFlyNotFound(err)) throw err;
        console.log('[DO] Machine already gone during reassociation destroy');
      }
      this.s.flyMachineId = null;
    }

    // Persist the new volume ID, region, previousVolumeId, and cleared machine ID
    this.s.flyVolumeId = newVolumeId;
    this.s.flyRegion = volume.region;
    this.s.previousVolumeId = previousVolumeId;
    await this.persist({
      flyVolumeId: newVolumeId,
      flyRegion: volume.region,
      flyMachineId: null,
      previousVolumeId,
    });

    return {
      previousVolumeId,
      newVolumeId,
      newRegion: volume.region,
    };
  }

  // ── Snapshot restore (admin) ───────────────────────────────────────

  /**
   * Enqueue a snapshot restore job. Sets status to 'restoring' immediately
   * and sends a message to the CF Queue for async orchestration.
   */
  async enqueueSnapshotRestore(
    snapshotId: string
  ): Promise<{ acknowledged: boolean; previousVolumeId: string }> {
    await this.loadState();

    if (!this.s.userId || !this.s.flyVolumeId || !this.s.flyRegion || !this.s.sandboxId) {
      throw new Error('Cannot restore: instance is not provisioned');
    }
    if (this.s.status === 'destroying') {
      throw new Error('Cannot restore: instance is being destroyed');
    }
    if (this.s.status === 'restoring') {
      throw new Error('Cannot restore: instance is already restoring');
    }
    if (this.s.status === 'starting' || this.s.status === 'restarting') {
      throw new Error('Cannot restore: instance is busy (' + this.s.status + ')');
    }

    const previousVolumeId = this.s.flyVolumeId;
    const previousStatus = this.s.status ?? 'stopped';

    // Transition to restoring immediately — blocks all lifecycle methods.
    // Set restoreStartedAt now so the alarm's stuck-restore detection has a timestamp
    // to measure against even if the queue worker never picks up the message.
    const now = new Date().toISOString();
    this.s.status = 'restoring';
    this.s.restoreStartedAt = now;
    this.s.preRestoreStatus = previousStatus;
    await this.persist({
      status: 'restoring',
      restoreStartedAt: now,
      preRestoreStatus: previousStatus,
    });
    await this.scheduleAlarm();

    // Enqueue the restore job for async processing.
    // If the send fails, restore the previous status so the instance isn't stuck
    // in 'restoring' while the machine may still be running.
    if (!this.env.SNAPSHOT_RESTORE_QUEUE) {
      this.s.status = previousStatus;
      this.s.restoreStartedAt = null;
      this.s.preRestoreStatus = null;
      await this.persist({
        status: previousStatus,
        restoreStartedAt: null,
        preRestoreStatus: null,
      });
      throw new Error('Cannot restore: SNAPSHOT_RESTORE_QUEUE binding not configured');
    }
    try {
      await this.env.SNAPSHOT_RESTORE_QUEUE.send({
        userId: this.s.userId,
        snapshotId,
        previousVolumeId,
        region: this.s.flyRegion,
      });
    } catch (err) {
      this.s.status = previousStatus;
      this.s.restoreStartedAt = null;
      this.s.preRestoreStatus = null;
      await this.persist({
        status: previousStatus,
        restoreStartedAt: null,
        preRestoreStatus: null,
      });
      throw err;
    }

    this.emitEvent({
      event: 'instance.restore_enqueued',
      status: 'restoring',
      label: 'admin_snapshot_restore',
    });

    return { acknowledged: true, previousVolumeId };
  }

  /**
   * Called by the queue worker to destroy the machine before starting with a new volume.
   * Fly requires machine destruction to release the old volume's attached_machine_id.
   * Clears flyMachineId so start() will create a fresh machine.
   */
  async destroyMachineForRestore(): Promise<void> {
    await this.loadState();
    if (this.s.status !== 'restoring') {
      throw new Error('Cannot destroy machine: instance is not in restoring state');
    }
    if (this.s.flyMachineId) {
      const flyConfig = getFlyConfig(this.env, this.s);
      try {
        await fly.destroyMachine(flyConfig, this.s.flyMachineId, true);
        console.log(`[DO] Machine destroyed for restore: ${this.s.flyMachineId}`);
      } catch (err) {
        if (!fly.isFlyNotFound(err)) throw err;
        console.log('[DO] Machine already gone during restore destroy');
      }
      this.s.flyMachineId = null;
      // Machine is gone — update preRestoreStatus so failSnapshotRestore() doesn't
      // restore to 'running' when the machine no longer exists.
      this.s.preRestoreStatus = 'stopped';
      await this.persist({ flyMachineId: null, preRestoreStatus: 'stopped' });
    }
  }

  /**
   * Called by the queue worker after creating a new volume, before swapping.
   * Persists the volume ID so retries can reuse it instead of creating another.
   */
  async setPendingRestoreVolumeId(volumeId: string): Promise<void> {
    await this.loadState();
    if (this.s.status !== 'restoring') return;
    this.s.pendingRestoreVolumeId = volumeId;
    await this.persist({ pendingRestoreVolumeId: volumeId });
  }

  /**
   * Called by the queue worker after the new volume is created and ready.
   * Swaps the volume reference and stores the previous volume ID for admin revert.
   */
  async completeSnapshotRestore(newVolumeId: string, newRegion: string): Promise<void> {
    await this.loadState();
    if (this.s.status !== 'restoring') {
      throw new Error('Cannot complete restore: instance is not in restoring state');
    }

    const previousVolumeId = this.s.flyVolumeId;
    const durationMs = this.s.restoreStartedAt
      ? Date.now() - new Date(this.s.restoreStartedAt).getTime()
      : undefined;
    this.s.previousVolumeId = previousVolumeId;
    this.s.flyVolumeId = newVolumeId;
    this.s.flyRegion = newRegion;
    this.s.status = 'stopped';
    this.s.restoreStartedAt = null;
    this.s.preRestoreStatus = null;
    this.s.pendingRestoreVolumeId = null;
    await this.persist({
      previousVolumeId,
      flyVolumeId: newVolumeId,
      flyRegion: newRegion,
      status: 'stopped',
      restoreStartedAt: null,
      preRestoreStatus: null,
      pendingRestoreVolumeId: null,
    });

    this.emitEvent({
      event: 'instance.restore_completed',
      status: 'stopped',
      durationMs,
    });
  }

  /**
   * Called by the queue worker if the restore fails after all retries,
   * or by the alarm if the restore is stuck for >30 min.
   * Restores the pre-restore status so the instance reflects its actual state
   * (e.g., still 'running' if the queue worker never stopped the machine).
   */
  async failSnapshotRestore(): Promise<void> {
    await this.loadState();
    if (this.s.status !== 'restoring') return;

    const restoredStatus = this.s.preRestoreStatus ?? 'stopped';
    if (this.s.pendingRestoreVolumeId) {
      console.warn(
        `[DO] Orphaned restore volume: ${this.s.pendingRestoreVolumeId} (manual cleanup may be needed)`
      );
    }
    this.s.status = restoredStatus;
    this.s.restoreStartedAt = null;
    this.s.preRestoreStatus = null;
    this.s.pendingRestoreVolumeId = null;
    await this.persist({
      status: restoredStatus,
      restoreStartedAt: null,
      preRestoreStatus: null,
      pendingRestoreVolumeId: null,
    });
    await this.scheduleAlarm();

    console.log(`[DO] Snapshot restore failed, status restored to ${restoredStatus}`);
  }

  // ── Gateway controller ─────────────────────────────────────────────

  async getGatewayProcessStatus(): Promise<GatewayProcessStatus> {
    await this.loadState();
    return gateway.getGatewayProcessStatus(this.s, this.env);
  }

  async startGatewayProcess(): Promise<{ ok: boolean }> {
    await this.loadState();
    return gateway.startGatewayProcess(this.s, this.env);
  }

  async stopGatewayProcess(): Promise<{ ok: boolean }> {
    await this.loadState();
    return gateway.stopGatewayProcess(this.s, this.env);
  }

  async restartGatewayProcess(): Promise<{ ok: boolean }> {
    await this.loadState();
    return gateway.restartGatewayProcess(this.s, this.env);
  }

  async restoreConfig(version: string): Promise<{ ok: boolean; signaled: boolean }> {
    await this.loadState();
    return gateway.restoreConfig(this.s, this.env, version);
  }

  async getControllerVersion(): Promise<{
    version: string;
    commit: string;
    openclawVersion?: string | null;
  } | null> {
    await this.loadState();
    return gateway.getControllerVersion(this.s, this.env);
  }

  async getGatewayReady(): Promise<Record<string, unknown> | null> {
    await this.loadState();
    return gateway.getGatewayReady(this.s, this.env);
  }

  async patchConfigOnMachine(patch: Record<string, unknown>): Promise<void> {
    await this.loadState();
    return gateway.patchConfigOnMachine(this.s, this.env, patch);
  }

  async patchOpenclawConfig(patch: Record<string, unknown>): Promise<{ ok: boolean }> {
    await this.loadState();
    return gateway.patchOpenclawConfig(this.s, this.env, patch);
  }

  /** Returns null if the controller is too old to have the /_kilo/config/read endpoint. */
  async getOpenclawConfig(): Promise<{ config: Record<string, unknown>; etag?: string } | null> {
    await this.loadState();
    return gateway.getOpenclawConfig(this.s, this.env);
  }

  /** Returns null if the controller is too old to have the /_kilo/config/replace endpoint. */
  async replaceConfigOnMachine(
    config: Record<string, unknown>,
    etag?: string
  ): Promise<{ ok: boolean } | null> {
    await this.loadState();
    return gateway.replaceConfigOnMachine(this.s, this.env, config, etag);
  }

  async getFileTree() {
    await this.loadState();
    return gateway.getFileTree(this.s, this.env);
  }

  async readFile(filePath: string) {
    await this.loadState();
    return gateway.readFile(this.s, this.env, filePath);
  }

  async writeFile(filePath: string, content: string, etag?: string) {
    await this.loadState();
    return gateway.writeFile(this.s, this.env, filePath, content, etag);
  }

  // ── Restart machine (user-facing) ──────────────────────────────────

  async restartMachine(options?: {
    imageTag?: string;
  }): Promise<{ success: boolean; error?: string }> {
    await this.loadState();

    if (!this.s.flyMachineId) {
      return { success: false, error: 'No machine exists' };
    }

    if (
      this.s.status === 'provisioned' ||
      this.s.status === 'destroying' ||
      this.s.status === 'starting' ||
      this.s.status === 'restarting' ||
      this.s.status === 'restoring'
    ) {
      return { success: false, error: 'Instance is busy' };
    }

    const action = options?.imageTag
      ? options.imageTag === 'latest'
        ? 'upgrade-to-latest'
        : `pin-to-tag:${options.imageTag}`
      : 'redeploy-same-image';
    doLog(this.s, `restartMachine: initiating async restart`, {
      action,
      currentStatus: this.s.status,
      trackedImageTag: this.s.trackedImageTag,
      flyMachineId: this.s.flyMachineId,
    });

    try {
      if (options?.imageTag) {
        if (options.imageTag === 'latest') {
          const variant = 'default';
          const latest = await resolveLatestVersion(this.env.KV_CLAW_CACHE, variant);
          if (latest) {
            this.s.openclawVersion = latest.openclawVersion;
            this.s.imageVariant = latest.variant;
            this.s.trackedImageTag = latest.imageTag;
            this.s.trackedImageDigest = latest.imageDigest;
          }
        } else {
          this.s.trackedImageTag = options.imageTag;
          this.s.openclawVersion = null;
          this.s.imageVariant = null;
          this.s.trackedImageDigest = null;
        }
        await this.persist({
          openclawVersion: this.s.openclawVersion,
          imageVariant: this.s.imageVariant,
          trackedImageTag: this.s.trackedImageTag,
          trackedImageDigest: this.s.trackedImageDigest,
        });
      }

      const flyConfig = getFlyConfig(this.env, this.s);

      // Backfill machineSize from live machine for legacy instances
      if (this.s.machineSize === null && this.s.flyMachineId) {
        const machine = await fly.getMachine(flyConfig, this.s.flyMachineId);
        if (machine.config?.guest) {
          const { cpus, memory_mb, cpu_kind } = machine.config.guest;
          this.s.machineSize = { cpus, memory_mb, cpu_kind };
          await this.persist({ machineSize: this.s.machineSize });
        }
      }

      this.s.status = 'restarting';
      this.s.restartingAt = Date.now();
      this.s.restartUpdateSent = false;
      this.s.lastRestartErrorMessage = null;
      this.s.lastRestartErrorAt = null;
      await this.ctx.storage.put(
        storageUpdate({
          status: 'restarting',
          restartingAt: this.s.restartingAt,
          restartUpdateSent: false,
          lastRestartErrorMessage: null,
          lastRestartErrorAt: null,
        })
      );
      await this.scheduleAlarm();

      this.emitEvent({
        event: 'instance.restarting',
        status: 'restarting',
        label: action,
      });

      this.ctx.waitUntil(this.restartMachineInBackground());
      return { success: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  private async restartMachineInBackground(): Promise<void> {
    try {
      await this.loadState();

      // Bail if the instance was destroyed (or otherwise left 'restarting')
      // while this background task was queued. Reading from storage rather
      // than this.s mirrors the pattern in startAsync's catch handler —
      // waitUntil runs after the originating request context completes and
      // other handlers (e.g. destroy) may have mutated storage in the interim.
      const currentStatus = await this.ctx.storage.get('status');
      if (currentStatus !== 'restarting') {
        console.log(
          '[DO] restartMachine: aborting background restart, status is now',
          currentStatus
        );
        return;
      }

      if (!this.s.flyMachineId) {
        throw new Error('No machine exists');
      }

      // Backfill Stream Chat for instances created before the feature was added.
      // setupDefaultStreamChatChannel is idempotent (upsert users, getOrCreate channel).
      if (
        !this.s.streamChatApiKey &&
        this.env.STREAM_CHAT_API_KEY &&
        this.env.STREAM_CHAT_API_SECRET &&
        this.s.sandboxId
      ) {
        try {
          const streamChat = await setupDefaultStreamChatChannel(
            this.env.STREAM_CHAT_API_KEY,
            this.env.STREAM_CHAT_API_SECRET,
            this.s.sandboxId
          );
          this.s.streamChatApiKey = streamChat.apiKey;
          this.s.streamChatBotUserId = streamChat.botUserId;
          this.s.streamChatBotUserToken = streamChat.botUserToken;
          this.s.streamChatChannelId = streamChat.channelId;
          await this.persist({
            streamChatApiKey: streamChat.apiKey,
            streamChatBotUserId: streamChat.botUserId,
            streamChatBotUserToken: streamChat.botUserToken,
            streamChatChannelId: streamChat.channelId,
          });
          doLog(this.s, 'Stream Chat backfilled on restart', {
            channelId: streamChat.channelId,
          });
        } catch (err) {
          doWarn(this.s, 'Stream Chat backfill failed on restart (non-fatal)', {
            error: toLoggable(err),
          });
        }
      }

      const flyConfig = getFlyConfig(this.env, this.s);

      const { envVars, minSecretsVersion } = await buildUserEnvVars(this.env, this.ctx, this.s);
      const guest = guestFromSize(this.s.machineSize);
      const imageTag = resolveImageTag(this.s, this.env);
      doLog(this.s, 'restartMachine: deploying update', {
        imageTag,
        flyMachineId: this.s.flyMachineId,
      });
      const identity = {
        userId: this.s.userId ?? '',
        sandboxId: this.s.sandboxId ?? '',
        openclawVersion: this.s.openclawVersion,
        imageVariant: this.s.imageVariant,
      };
      const machineConfig = buildMachineConfig(
        getRegistryApp(this.env),
        imageTag,
        envVars,
        guest,
        this.s.flyVolumeId,
        identity
      );

      // updateMachine on a running machine triggers a restart with the new
      // config. On a stopped machine it applies the config without starting,
      // so we explicitly start afterward.
      const updated = await fly.updateMachine(flyConfig, this.s.flyMachineId, machineConfig, {
        minSecretsVersion,
      });

      // Check ownership before writing — destroy() may have cleared storage.
      const midStatus = await this.ctx.storage.get('status');
      if (midStatus !== 'restarting') return;

      this.s.restartUpdateSent = true;
      await this.ctx.storage.put(storageUpdate({ restartUpdateSent: true }));

      // Check if the machine needs an explicit start (e.g. was stopped).
      const machine = await fly.getMachine(flyConfig, this.s.flyMachineId);
      if (machine.state === 'stopped' || machine.state === 'created') {
        doLog(this.s, 'restartMachine: machine not running after update, starting explicitly', {
          flyState: machine.state,
        });
        await fly.startMachine(flyConfig, this.s.flyMachineId);
      }

      // Pass the updated instance_id so waitForState waits for the new
      // version, not a stale pre-update started state.
      await fly.waitForState(
        flyConfig,
        this.s.flyMachineId,
        'started',
        STARTUP_TIMEOUT_SECONDS,
        updated.instance_id
      );
      await gateway.waitForHealthy(this.s, this.env, flyConfig.appName, this.s.flyMachineId);

      // Final ownership check before persisting success.
      const preSuccessStatus = await this.ctx.storage.get('status');
      if (preSuccessStatus !== 'restarting') return;

      await markRestartSuccessful(
        this.ctx,
        this.s,
        createReconcileContext(this.s, this.env, 'restart')
      );
      doLog(this.s, 'restartMachine: background restart completed successfully');
      await this.scheduleAlarm();
    } catch (err) {
      // A waitForState 408 after updateMachine was sent is expected — the
      // machine may take minutes to start. Reconciliation will pick it up.
      const isExpectedTimeout =
        this.s.restartUpdateSent && err instanceof fly.FlyApiError && err.status === 408;

      if (isExpectedTimeout) {
        doWarn(
          this.s,
          'restartMachine: waitForState timed out after update, reconciliation will handle',
          {
            error: toLoggable(err),
          }
        );
      } else {
        doError(this.s, 'restartMachine: background restart failed', {
          error: toLoggable(err),
        });
      }
      // Only persist error if we're still in 'restarting'. If destroy()
      // ran concurrently, storage may have been wiped — writing here would
      // recreate partial state on a destroyed instance.
      const postStatus = await this.ctx.storage.get('status');
      if (postStatus === 'restarting') {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.s.lastRestartErrorMessage = errorMessage;
        this.s.lastRestartErrorAt = Date.now();
        await this.ctx.storage.put(
          storageUpdate({
            lastRestartErrorMessage: errorMessage,
            lastRestartErrorAt: this.s.lastRestartErrorAt,
          })
        );
      }
    }
  }

  // ========================================================================
  // Alarm (reconciliation loop)
  // ========================================================================

  override async alarm(): Promise<void> {
    await this.loadState();

    if (!this.s.userId || !this.s.status) return;

    // Skip reconciliation during restore — the queue worker owns the lifecycle.
    // Detect stuck restores: if restoreStartedAt is set and older than 30 min,
    // the queue worker likely failed permanently. Reset to stopped.
    if (this.s.status === 'restoring') {
      if (this.s.restoreStartedAt) {
        const elapsed = Date.now() - new Date(this.s.restoreStartedAt).getTime();
        if (elapsed > 30 * 60 * 1000) {
          this.emitEvent({
            event: 'instance.restore_failed',
            status: 'restoring',
            label: 'alarm_timeout',
            durationMs: elapsed,
          });
          await this.failSnapshotRestore();
          return;
        }
      }
      await this.scheduleAlarm();
      return;
    }

    try {
      const flyConfig = getFlyConfig(this.env, this.s);
      await reconcileWithFly(
        flyConfig,
        this.ctx,
        this.s,
        this.env,
        'alarm',
        () => this.destroy().then(() => undefined),
        (userId, sandboxId) =>
          markDestroyedInPostgresHelper(this.env, this.ctx, this.s, userId, sandboxId)
      );
    } catch (err) {
      doError(this.s, 'reconcileWithFly failed', {
        error: toLoggable(err),
      });
    }

    if (this.s.status) {
      await this.scheduleAlarm();
    }
  }
}
