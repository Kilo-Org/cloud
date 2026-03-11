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
  MachineSize,
} from '../../schemas/instance-config';
import { DEFAULT_INSTANCE_FEATURES } from '../../schemas/instance-config';
import type { FlyVolumeSnapshot } from '../../fly/types';
import * as fly from '../../fly/client';
import { sandboxIdFromUserId } from '../../auth/sandbox-id';
import { resolveLatestVersion, resolveVersionByTag } from '../../lib/image-version';
import { lookupCatalogVersion } from '../../lib/catalog-registration';
import { ImageVariantSchema } from '../../schemas/image-version';
import {
  STARTUP_TIMEOUT_SECONDS,
  DEFAULT_VOLUME_SIZE_GB,
  DEFAULT_FLY_REGION,
  LIVE_CHECK_THROTTLE_MS,
  OPENCLAW_BUILTIN_DEFAULT_MODEL,
} from '../../config';
import {
  SECRET_CATALOG,
  FIELD_KEY_TO_ENV_VAR,
  ENV_VAR_TO_FIELD_KEY,
  ALL_SECRET_FIELD_KEYS,
  type SecretFieldKey,
} from '@kilocode/kiloclaw-secret-catalog';
import { parseRegions, shuffleRegions } from '../regions';
import { buildMachineConfig, guestFromSize, volumeNameFromSandboxId } from '../machine-config';
import type { GatewayProcessStatus } from '../gateway-controller-types';

// Domain modules
import type { InstanceMutableState, InstanceStatus, DestroyResult } from './types';
import { getFlyConfig } from './types';
import { createMutableState, loadState, storageUpdate } from './state';
import { reconcileLog, nextAlarmTime } from './log';
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
} from './reconcile';
import { restoreFromPostgres, markDestroyedInPostgresHelper } from './postgres';

// Re-export extracted helpers so existing consumers don't break.
export { parseRegions, shuffleRegions, deprioritizeRegion } from '../regions';
export { selectRecoveryCandidate } from '../machine-recovery';
export { METADATA_KEY_USER_ID } from '../machine-config';

/** Channel env var names — used to exclude channel secrets from secretCount. */
const CHANNEL_ENV_VARS = new Set(
  SECRET_CATALOG.filter(e => e.category === 'channel').flatMap(e => e.fields.map(f => f.envVar))
);

export class KiloClawInstance extends DurableObject<KiloClawEnv> {
  private s: InstanceMutableState = createMutableState();

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

  // ========================================================================
  // Lifecycle methods (called by platform API routes via RPC)
  // ========================================================================

  async provision(userId: string, config: InstanceConfig): Promise<{ sandboxId: string }> {
    await this.loadState();

    if (this.s.status === 'destroying') {
      throw new Error('Cannot provision: instance is being destroyed');
    }

    const sandboxId = sandboxIdFromUserId(userId);
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
      const regions = shuffleRegions(
        parseRegions(config.region ?? this.env.FLY_REGION ?? DEFAULT_FLY_REGION)
      );
      const guest = guestFromSize(config.machineSize ?? null);
      const volume = await fly.createVolumeWithFallback(
        flyConfig,
        {
          name: volumeNameFromSandboxId(sandboxId),
          size_gb: DEFAULT_VOLUME_SIZE_GB,
          compute: guest,
        },
        regions
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
        console.error(
          '[DO] HYPERDRIVE not configured — cannot look up pinned tag in Postgres:',
          config.pinnedImageTag
        );
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
              console.error(
                '[DO] Invalid variant from Postgres catalog, skipping:',
                catalogEntry.variant,
                'for tag:',
                config.pinnedImageTag,
                'error:',
                variantParse.error.flatten()
              );
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
          console.warn(
            '[DO] Failed to look up pinned tag in Postgres:',
            err instanceof Error ? err.message : err
          );
        }
      }

      if (pinned) {
        this.s.openclawVersion = pinned.openclawVersion;
        this.s.imageVariant = pinned.variant;
        this.s.trackedImageTag = pinned.imageTag;
        this.s.trackedImageDigest = pinned.imageDigest;
        console.debug('[DO] Using pinned version:', pinned.openclawVersion, '→', pinned.imageTag);
      } else {
        console.warn(
          '[DO] Pinned tag not found in KV or Postgres, using tag directly:',
          config.pinnedImageTag
        );
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
        })
      : storageUpdate({
          ...configFields,
          ...versionFields,
          instanceFeatures: this.s.instanceFeatures,
        });

    await this.ctx.storage.put(update);

    this.s.userId = userId;
    this.s.sandboxId = sandboxId;
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
    }
    this.s.loaded = true;

    if (isNew) {
      await this.scheduleAlarm();
    }

    if (isNew) {
      await this.start(userId);
    }

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
    patch: Partial<Record<SecretFieldKey, EncryptedEnvelope | null>>
  ): Promise<{ configured: SecretFieldKey[] }> {
    await this.loadState();

    const currentSecrets: Record<string, EncryptedEnvelope | null> = {
      ...(this.s.channels ?? {}),
    };
    const nonCatalogSecrets: Record<string, EncryptedEnvelope> = {};
    if (this.s.encryptedSecrets) {
      for (const [key, value] of Object.entries(this.s.encryptedSecrets)) {
        const fieldKey = ENV_VAR_TO_FIELD_KEY.get(key);
        if (fieldKey) {
          currentSecrets[fieldKey] = value;
        } else {
          nonCatalogSecrets[key] = value;
        }
      }
    }

    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        console.log('[DO] Secret removed', { fieldKey: key, operation: 'remove' });
        delete currentSecrets[key];
      } else {
        console.log('[DO] Secret updated', { fieldKey: key, operation: 'set' });
        currentSecrets[key] = value;
      }
    }

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

    const cleanedSecrets: Record<string, EncryptedEnvelope> = {};
    for (const [key, value] of Object.entries(currentSecrets)) {
      if (value) {
        cleanedSecrets[key] = value;
      }
    }

    const configured = Object.keys(cleanedSecrets).filter((k): k is SecretFieldKey =>
      ALL_SECRET_FIELD_KEYS.has(k)
    );

    const remappedSecrets: Record<string, EncryptedEnvelope> = { ...nonCatalogSecrets };
    for (const [key, value] of Object.entries(cleanedSecrets)) {
      const envName = FIELD_KEY_TO_ENV_VAR.get(key) ?? key;
      remappedSecrets[envName] = value;
    }
    const hasSecrets = Object.keys(remappedSecrets).length > 0;
    this.s.encryptedSecrets = hasSecrets ? remappedSecrets : null;

    await this.ctx.storage.put({
      channels: this.s.channels,
      encryptedSecrets: this.s.encryptedSecrets,
    });

    return { configured };
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

  async start(userId?: string): Promise<void> {
    await this.loadState();

    if (this.s.status === 'destroying') {
      throw new Error('Cannot start: instance is being destroyed');
    }

    if (!this.s.userId || !this.s.sandboxId) {
      const restoreUserId = userId ?? this.s.userId;
      if (restoreUserId) {
        await restoreFromPostgres(this.env, this.ctx, this.s, restoreUserId);
      }
    }

    if (!this.s.userId || !this.s.sandboxId) {
      throw new Error('Instance not provisioned');
    }

    const flyConfig = getFlyConfig(this.env, this.s);

    await flyMachines.ensureVolume(flyConfig, this.ctx, this.s, this.env, 'start');

    // Verify volume region matches cached flyRegion
    if (this.s.flyVolumeId && !this.s.flyMachineId) {
      try {
        const volume = await fly.getVolume(flyConfig, this.s.flyVolumeId);
        if (volume.region !== this.s.flyRegion) {
          console.warn(
            '[DO] flyRegion drift detected:',
            this.s.flyRegion,
            '-> actual:',
            volume.region
          );
          this.s.flyRegion = volume.region;
          await this.persist({ flyRegion: volume.region });
        }
      } catch (err) {
        if (fly.isFlyNotFound(err)) {
          console.warn('[DO] Volume not found during region check, clearing');
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
          // Inline mount reconciliation — reconcileMachineMount is internal to reconcile.ts
          if (this.s.flyVolumeId) {
            const mounts = machine.config?.mounts ?? [];
            const hasCorrectMount = mounts.some(
              m => m.volume === this.s.flyVolumeId && m.path === '/root'
            );
            if (!hasCorrectMount && this.s.flyMachineId) {
              reconcileLog('start', 'repair_mount', {
                machine_id: this.s.flyMachineId,
                volume_id: this.s.flyVolumeId,
              });
              await fly.stopMachineAndWait(flyConfig, this.s.flyMachineId);
              await fly.updateMachine(flyConfig, this.s.flyMachineId, {
                ...machine.config,
                mounts: [{ volume: this.s.flyVolumeId, path: '/root' }],
              });
              await fly.waitForState(
                flyConfig,
                this.s.flyMachineId,
                'started',
                STARTUP_TIMEOUT_SECONDS
              );
            }
          }
          console.log('[DO] Machine already running, mount verified');
          return;
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
      console.error(
        `[DO] Insufficient resources (${code}) in ${this.s.flyRegion ?? 'unknown'}, replacing stranded volume`
      );
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

    this.s.status = 'running';
    this.s.lastStartedAt = Date.now();
    this.s.healthCheckFailCount = 0;
    await this.persist({
      status: 'running',
      lastStartedAt: this.s.lastStartedAt,
      healthCheckFailCount: 0,
      flyMachineId: this.s.flyMachineId,
    });

    await this.scheduleAlarm();
  }

  async stop(): Promise<void> {
    await this.loadState();

    if (!this.s.userId || !this.s.sandboxId) {
      throw new Error('Instance not provisioned');
    }
    if (
      this.s.status === 'stopped' ||
      this.s.status === 'provisioned' ||
      this.s.status === 'destroying'
    ) {
      console.log('[DO] Instance not running (status:', this.s.status, '), no-op');
      return;
    }

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

    await this.scheduleAlarm();
  }

  async destroy(): Promise<DestroyResult> {
    await this.loadState();

    if (!this.s.userId) {
      throw new Error('Instance not provisioned');
    }

    this.s.pendingDestroyMachineId = this.s.flyMachineId;
    this.s.pendingDestroyVolumeId = this.s.flyVolumeId;
    this.s.status = 'destroying';

    await this.persist({
      status: 'destroying',
      pendingDestroyMachineId: this.s.pendingDestroyMachineId,
      pendingDestroyVolumeId: this.s.pendingDestroyVolumeId,
    });

    const flyConfig = getFlyConfig(this.env, this.s);
    await tryDeleteMachine(flyConfig, this.ctx, this.s, 'destroy');
    await tryDeleteVolume(flyConfig, this.ctx, this.s, 'destroy');

    const finalized = await finalizeDestroyIfComplete(this.ctx, this.s, (userId, sandboxId) =>
      markDestroyedInPostgresHelper(this.env, this.ctx, this.s, userId, sandboxId)
    );
    if (!finalized.finalized) {
      console.warn(
        '[DO] Destroy incomplete, alarm will retry. pending machine:',
        this.s.pendingDestroyMachineId,
        'volume:',
        this.s.pendingDestroyVolumeId
      );
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
    };
  }

  async getDebugState(): Promise<{
    userId: string | null;
    sandboxId: string | null;
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
  }> {
    await this.loadState();
    const alarmScheduledAt = await this.ctx.storage.getAlarm();

    return {
      userId: this.s.userId,
      sandboxId: this.s.sandboxId,
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
    };
  }

  async listVolumeSnapshots(): Promise<FlyVolumeSnapshot[]> {
    await this.loadState();
    if (!this.s.flyVolumeId) return [];
    const flyConfig = getFlyConfig(this.env, this.s);
    return fly.listVolumeSnapshots(flyConfig, this.s.flyVolumeId);
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

  async patchConfigOnMachine(patch: Record<string, unknown>): Promise<void> {
    await this.loadState();
    return gateway.patchConfigOnMachine(this.s, this.env, patch);
  }

  // ── Restart gateway (user-facing) ──────────────────────────────────

  async restartGateway(options?: {
    imageTag?: string;
  }): Promise<{ success: boolean; error?: string }> {
    await this.loadState();

    if (this.s.status !== 'running' || !this.s.flyMachineId) {
      return { success: false, error: 'Instance is not running' };
    }

    const action = options?.imageTag
      ? options.imageTag === 'latest'
        ? 'upgrade-to-latest'
        : `pin-to-tag:${options.imageTag}`
      : 'redeploy-same-image';
    console.log(
      '[DO] restartGateway:',
      action,
      '| current trackedImageTag:',
      this.s.trackedImageTag
    );

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

      // Try to stop the machine first for a clean config swap.
      // If the stop times out (e.g. Fly auto-restart races the poll),
      // fall through — updateMachine on a running machine triggers a
      // restart with the new config, which achieves the same result.
      try {
        await fly.stopMachineAndWait(flyConfig, this.s.flyMachineId);
      } catch (stopErr) {
        const isTimeout = stopErr instanceof fly.FlyApiError && stopErr.status === 408;
        if (!isTimeout) throw stopErr;
        console.warn('[DO] restartGateway: stop timed out, will update in-place:', stopErr.message);
      }

      const { envVars, minSecretsVersion } = await buildUserEnvVars(this.env, this.ctx, this.s);
      const guest = guestFromSize(this.s.machineSize);
      const imageTag = resolveImageTag(this.s, this.env);
      console.log('[DO] restartGateway: deploying with imageTag:', imageTag);
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

      await fly.updateMachine(flyConfig, this.s.flyMachineId, machineConfig, {
        minSecretsVersion,
      });
      await fly.waitForState(flyConfig, this.s.flyMachineId, 'started', STARTUP_TIMEOUT_SECONDS);
      await gateway.waitForHealthy(this.s, this.env, flyConfig.appName, this.s.flyMachineId);

      return { success: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  // ========================================================================
  // Alarm (reconciliation loop)
  // ========================================================================

  override async alarm(): Promise<void> {
    await this.loadState();

    if (!this.s.userId || !this.s.status) return;

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
      console.error('[alarm] reconcileWithFly failed:', err);
    }

    if (this.s.status) {
      await this.scheduleAlarm();
    }
  }
}
