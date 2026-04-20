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
  ProviderId,
  ProviderState,
  KiloExaSearchMode,
} from '../../schemas/instance-config';
import { DEFAULT_INSTANCE_FEATURES, ProviderStateSchema } from '../../schemas/instance-config';
import type { FlyVolume, FlyVolumeSnapshot } from '../../fly/types';
import * as fly from '../../fly/client';
import { sandboxIdFromUserId, sandboxIdFromInstanceId } from '../../auth/sandbox-id';
import {
  isInstanceKeyedSandboxId,
  instanceIdFromSandboxId,
} from '@kilocode/worker-utils/instance-id';
import { resolveLatestVersion, resolveVersionByTag } from '../../lib/image-version';
import { lookupCatalogVersion } from '../../lib/catalog-registration';
import { ImageVariantSchema } from '../../schemas/image-version';
import {
  LIVE_CHECK_THROTTLE_MS,
  OPENCLAW_BUILTIN_DEFAULT_MODEL,
  RESTARTING_TIMEOUT_MS,
  STARTING_TIMEOUT_MS,
} from '../../config';
import {
  SECRET_CATALOG,
  FIELD_KEY_TO_ENV_VAR,
  ENV_VAR_TO_FIELD_KEY,
  ALL_SECRET_FIELD_KEYS,
  MAX_CUSTOM_SECRETS,
  type SecretFieldKey,
} from '@kilocode/kiloclaw-secret-catalog';
import * as regionHelpers from '../regions';
import { buildRuntimeSpec } from '../machine-config';
import type { GatewayProcessStatus } from '../gateway-controller-types';

// Domain modules
import type { InstanceMutableState, InstanceStatus, DestroyResult } from './types';
import { getAppKey, getFlyConfig } from './types';
import {
  applyProviderState,
  createMutableState,
  getFlyProviderState,
  getProviderRegion,
  getRuntimeId,
  getStorageId,
  loadState,
  storageUpdate,
  syncProviderStateForStorage,
} from './state';
import { nextAlarmTime, doLog, doError, doWarn, toLoggable, createReconcileContext } from './log';
import { attemptMetadataRecovery } from './reconcile';
import { buildUserEnvVars, resolveImageTag, resolveRuntimeImageRef } from './config';
import * as gateway from './gateway';
import * as pairing from './pairing';
import * as kiloCliRun from './kilo-cli-run';
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
import { legacyDoKeysForIdentity } from '../../lib/instance-routing';
import {
  beginUnexpectedStopRecovery,
  cleanupPendingRecoveryVolumeIfNeeded,
  completeUnexpectedStopRecovery,
  cleanupRecoveryPreviousVolume,
  cleanupRetainedRecoveryVolumeIfDue,
  failUnexpectedStopRecovery,
  runUnexpectedStopRecoveryInBackground,
  type RecoveryRuntime,
} from './recovery';
import {
  setupDefaultStreamChatChannel,
  createShortLivedUserToken,
  deactivateStreamChatUsers,
} from '../../stream-chat/client';
import { writeEvent, safeInstanceIdFromSandboxId } from '../../utils/analytics';
import type { KiloClawEventData, KiloClawEventName } from '../../utils/analytics';
import { getProviderAdapter, resolveDefaultProvider } from '../../providers';
import type {
  ProviderCapabilities,
  ProviderResult,
  ProviderRoutingTarget,
} from '../../providers/types';

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
const BRAVE_SEARCH_FIELD_KEY = 'braveSearchApiKey';

export class KiloClawInstance extends DurableObject<KiloClawEnv> {
  private s: InstanceMutableState = createMutableState();
  private startInProgress = false;

  // Kept as `loadState` for backward compat with tests that cast to access private methods.
  private async loadState(): Promise<void> {
    await loadState(this.ctx, this.s);
  }

  private async persist(patch: Partial<PersistedState>): Promise<void> {
    await this.ctx.storage.put(storageUpdate(syncProviderStateForStorage(this.s, patch)));
  }

  private async scheduleAlarm(): Promise<void> {
    if (!this.s.status) return;
    await this.ctx.storage.setAlarm(nextAlarmTime(this.s.status));
  }

  private recoveryRuntime(): RecoveryRuntime {
    return {
      env: this.env,
      ctx: this.ctx,
      state: this.s,
      loadState: () => this.loadState(),
      persist: patch => this.persist(patch),
      scheduleAlarm: () => this.scheduleAlarm(),
      emitEvent: data => this.emitEvent(data),
    };
  }

  /**
   * Exposed as a private method so tests that cast to access internals
   * can still call `instance.buildUserEnvVars()`.
   */
  private buildUserEnvVars() {
    return buildUserEnvVars(this.env, this.ctx, this.s);
  }

  private provider() {
    return getProviderAdapter(this.env, this.s);
  }

  private applyProviderResult(result: ProviderResult): void {
    applyProviderState(this.s, result.providerState);
    if (result.corePatch?.machineSize !== undefined) {
      this.s.machineSize = result.corePatch.machineSize;
    }
    if (result.corePatch?.restartUpdateSent !== undefined) {
      this.s.restartUpdateSent = result.corePatch.restartUpdateSent;
    }
  }

  private async persistProviderResult(result: ProviderResult): Promise<void> {
    this.applyProviderResult(result);
    await this.persist({
      provider: result.providerState.provider,
      providerState: result.providerState,
      ...(result.corePatch ?? {}),
    });
  }

  private async persistProviderResultWithPatch(
    result: ProviderResult,
    patch: Partial<PersistedState>
  ): Promise<void> {
    this.applyProviderResult(result);
    await this.persist({
      provider: result.providerState.provider,
      providerState: result.providerState,
      ...(result.corePatch ?? {}),
      ...patch,
    });
  }

  private async retryNonFlyDestroy(): Promise<void> {
    if (this.s.provider === 'fly') {
      throw new Error('retryNonFlyDestroy should not be used for Fly providers');
    }

    if (this.s.pendingDestroyMachineId) {
      try {
        const result = await this.provider().destroyRuntime({
          env: this.env,
          state: this.s,
        });
        this.s.pendingDestroyMachineId = null;
        await this.persistProviderResultWithPatch(result, {
          pendingDestroyMachineId: null,
        });
      } catch (err) {
        doWarn(this.s, 'Non-Fly runtime destroy failed, alarm will retry', {
          provider: this.s.provider,
          runtimeId: this.s.pendingDestroyMachineId,
          error: toLoggable(err),
        });
      }
    }

    if (this.s.pendingDestroyVolumeId) {
      try {
        const result = await this.provider().destroyStorage({
          env: this.env,
          state: this.s,
        });
        this.s.pendingDestroyVolumeId = null;
        await this.persistProviderResultWithPatch(result, {
          pendingDestroyVolumeId: null,
        });
      } catch (err) {
        doWarn(this.s, 'Non-Fly storage destroy failed, alarm will retry', {
          provider: this.s.provider,
          storageId: this.s.pendingDestroyVolumeId,
          error: toLoggable(err),
        });
      }
    }
  }

  private async markStartFailedFromProvider(message: string): Promise<void> {
    const now = Date.now();
    this.s.status = 'stopped';
    this.s.startingAt = null;
    this.s.lastStoppedAt = now;
    this.s.lastStartErrorMessage = message;
    this.s.lastStartErrorAt = now;
    await this.persist({
      status: 'stopped',
      startingAt: null,
      lastStoppedAt: now,
      lastStartErrorMessage: message,
      lastStartErrorAt: now,
    });
  }

  private async markRestartFailedFromProvider(message: string): Promise<void> {
    const now = Date.now();
    this.s.status = 'stopped';
    this.s.startingAt = null;
    this.s.restartingAt = null;
    this.s.restartUpdateSent = false;
    this.s.lastStoppedAt = now;
    this.s.lastRestartErrorMessage = message;
    this.s.lastRestartErrorAt = now;
    await this.persist({
      status: 'stopped',
      startingAt: null,
      restartingAt: null,
      restartUpdateSent: false,
      lastStoppedAt: now,
      lastRestartErrorMessage: message,
      lastRestartErrorAt: now,
    });
  }

  private async markNonFlyRunningFromProvider(reason: 'start' | 'runtime'): Promise<void> {
    const startingAt = this.s.startingAt;
    this.s.status = 'running';
    this.s.startingAt = null;
    this.s.restartingAt = null;
    this.s.restartUpdateSent = false;
    if (this.s.lastStartedAt === null) {
      this.s.lastStartedAt = Date.now();
    }
    this.s.healthCheckFailCount = 0;
    this.s.lastStartErrorMessage = null;
    this.s.lastStartErrorAt = null;
    this.s.lastRestartErrorMessage = null;
    this.s.lastRestartErrorAt = null;
    await this.persist({
      status: 'running',
      startingAt: null,
      restartingAt: null,
      restartUpdateSent: false,
      lastStartedAt: this.s.lastStartedAt,
      healthCheckFailCount: 0,
      lastStartErrorMessage: null,
      lastStartErrorAt: null,
      lastRestartErrorMessage: null,
      lastRestartErrorAt: null,
    });

    if (reason === 'start') {
      this.emitEvent({
        event: 'instance.started',
        status: 'running',
        durationMs: startingAt ? Date.now() - startingAt : undefined,
      });
    }
  }

  private async reconcileNonFlyRuntimeFromAlarm(): Promise<void> {
    if (this.s.provider === 'fly') {
      throw new Error('reconcileNonFlyRuntimeFromAlarm should not be used for Fly providers');
    }

    if (!['starting', 'restarting', 'running'].includes(this.s.status ?? '')) {
      return;
    }

    const result = await this.provider().inspectRuntime({
      env: this.env,
      state: this.s,
    });
    await this.persistProviderResult(result);
    const runtimeState = result.observation?.runtimeState ?? 'missing';

    if (runtimeState === 'running') {
      if (this.s.status === 'restarting') {
        await markRestartSuccessful(
          this.ctx,
          this.s,
          createReconcileContext(this.s, this.env, 'alarm_non_fly')
        );
      } else if (this.s.status === 'starting') {
        await this.markNonFlyRunningFromProvider('start');
      }
      return;
    }

    if (this.s.status === 'starting') {
      const timedOut =
        this.s.startingAt !== null && Date.now() - this.s.startingAt > STARTING_TIMEOUT_MS;
      if (timedOut || runtimeState === 'failed') {
        const message = `Provider ${this.s.provider} runtime ${runtimeState} during start`;
        await this.markStartFailedFromProvider(message);
        this.emitProvisioningFailed('provider_runtime_not_running', message);
        return;
      }
      return;
    }

    if (this.s.status === 'restarting') {
      const timedOut =
        this.s.restartingAt !== null && Date.now() - this.s.restartingAt > RESTARTING_TIMEOUT_MS;
      if (timedOut || runtimeState === 'failed' || runtimeState === 'missing') {
        await this.markRestartFailedFromProvider(
          `Provider ${this.s.provider} runtime ${runtimeState} during restart`
        );
        return;
      }
      return;
    }

    if (this.s.status === 'running' && runtimeState !== 'starting') {
      const now = Date.now();
      this.s.status = 'stopped';
      this.s.lastStoppedAt = now;
      await this.persist({
        status: 'stopped',
        lastStoppedAt: now,
      });
      this.emitEvent({
        event: 'instance.stopped',
        status: 'stopped',
        label: `provider_runtime_${runtimeState}`,
      });
    }
  }

  async getRoutingTarget(): Promise<ProviderRoutingTarget | null> {
    await this.loadState();

    if (
      this.s.status === 'destroying' ||
      this.s.status === 'restoring' ||
      this.s.status === 'recovering'
    ) {
      return null;
    }

    try {
      return await this.provider().getRoutingTarget({
        env: this.env,
        state: this.s,
      });
    } catch (err) {
      doWarn(this.s, 'getRoutingTarget failed, returning null', {
        provider: this.s.provider,
        error: toLoggable(err),
      });
      return null;
    }
  }

  async getProviderMetadata(): Promise<{
    provider: ProviderId;
    capabilities: ProviderCapabilities;
  }> {
    await this.loadState();

    return {
      provider: this.s.provider,
      capabilities: this.provider().capabilities,
    };
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
      | 'orgId'
      | 'instanceId'
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
      orgId: this.s.orgId ?? undefined,
      instanceId: safeInstanceIdFromSandboxId(this.s.sandboxId ?? undefined),
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
    opts?: { orgId?: string | null; instanceId?: string; provider?: ProviderId }
  ): Promise<{ sandboxId: string }> {
    const provisionStart = performance.now();
    await this.loadState();

    if (this.s.status === 'destroying') {
      throw new Error('Cannot provision: instance is being destroyed');
    }
    if (this.s.status === 'recovering') {
      throw new Error('Cannot provision: instance is recovering from an unexpected stop');
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
    if (!isNew && opts?.provider && opts.provider !== this.s.provider) {
      throw Object.assign(
        new Error(`Cannot change provider from ${this.s.provider} to ${opts.provider}`),
        { status: 409 }
      );
    }
    const providerId =
      opts?.provider ?? (isNew ? resolveDefaultProvider(this.env) : this.s.provider);
    const orgId = opts?.orgId ?? null;
    const provider = getProviderAdapter(this.env, { provider: providerId });
    const provisioningState = {
      ...this.s,
      userId,
      sandboxId,
      provider: providerId,
      orgId,
    } satisfies InstanceMutableState;

    const provisioning = await provider.ensureProvisioningResources({
      env: this.env,
      state: provisioningState,
      orgId,
      machineSize: config.machineSize ?? null,
      region: config.region,
    });
    this.s.userId = userId;
    this.s.sandboxId = sandboxId;
    this.s.provider = providerId;
    this.s.orgId = orgId;
    await this.persistProviderResult(provisioning);

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

    const userTimezone =
      config.userTimezone === undefined ? (this.s.userTimezone ?? null) : config.userTimezone;

    const configFields = {
      userId,
      sandboxId,
      orgId: opts?.orgId ?? null,
      provider: this.s.provider,
      status: (this.s.status ?? 'provisioned') satisfies InstanceStatus,
      envVars: config.envVars ?? null,
      encryptedSecrets: config.encryptedSecrets ?? null,
      kilocodeApiKey: config.kilocodeApiKey ?? null,
      kilocodeApiKeyExpiresAt: config.kilocodeApiKeyExpiresAt ?? null,
      kilocodeDefaultModel: config.kilocodeDefaultModel ?? null,
      userTimezone,
      kiloExaSearchMode: config.webSearch?.exaMode ?? this.s.kiloExaSearchMode ?? null,
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
      ? syncProviderStateForStorage(
          this.s,
          storageUpdate({
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
            providerState: this.s.providerState,
            healthCheckFailCount: 0,
            pendingDestroyMachineId: null,
            pendingDestroyVolumeId: null,
            pendingPostgresMarkOnFinalize: false,
            instanceReadyEmailSent: false,
          })
        )
      : syncProviderStateForStorage(
          this.s,
          storageUpdate({
            ...configFields,
            ...versionFields,
            instanceFeatures: this.s.instanceFeatures,
          })
        );

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
    this.s.userTimezone = userTimezone;
    this.s.kiloExaSearchMode = config.webSearch?.exaMode ?? this.s.kiloExaSearchMode ?? null;
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

  async updateWebSearchConfig(patch: {
    exaMode?: KiloExaSearchMode | null;
  }): Promise<{ exaMode: KiloExaSearchMode | null }> {
    await this.loadState();

    const pending: Partial<PersistedState> = {};

    if (patch.exaMode !== undefined) {
      this.s.kiloExaSearchMode = patch.exaMode;
      pending.kiloExaSearchMode = this.s.kiloExaSearchMode;
    }

    if (Object.keys(pending).length > 0) {
      await this.ctx.storage.put(storageUpdate(pending));
    }

    return {
      exaMode: this.s.kiloExaSearchMode,
    };
  }

  async updateBotIdentity(patch: {
    botName?: string | null;
    botNature?: string | null;
    botVibe?: string | null;
    botEmoji?: string | null;
  }): Promise<{
    botName: string | null;
    botNature: string | null;
    botVibe: string | null;
    botEmoji: string | null;
  }> {
    await this.loadState();

    const pending: Partial<PersistedState> = {};

    if (patch.botName !== undefined) {
      this.s.botName = patch.botName;
      pending.botName = patch.botName;
    }
    if (patch.botNature !== undefined) {
      this.s.botNature = patch.botNature;
      pending.botNature = patch.botNature;
    }
    if (patch.botVibe !== undefined) {
      this.s.botVibe = patch.botVibe;
      pending.botVibe = patch.botVibe;
    }
    if (patch.botEmoji !== undefined) {
      this.s.botEmoji = patch.botEmoji;
      pending.botEmoji = patch.botEmoji;
    }

    if (Object.keys(pending).length > 0) {
      await this.ctx.storage.put(pending);
    }

    if (this.s.status === 'running' && Object.keys(pending).length > 0) {
      await gateway.writeBotIdentity(this.s, this.env, {
        botName: this.s.botName,
        botNature: this.s.botNature,
        botVibe: this.s.botVibe,
        botEmoji: this.s.botEmoji,
      });
    }

    return {
      botName: this.s.botName,
      botNature: this.s.botNature,
      botVibe: this.s.botVibe,
      botEmoji: this.s.botEmoji,
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

    if (patch[BRAVE_SEARCH_FIELD_KEY] && this.s.kiloExaSearchMode !== 'disabled') {
      this.s.kiloExaSearchMode = 'disabled';
    }

    await this.ctx.storage.put({
      channels: this.s.channels,
      encryptedSecrets: this.s.encryptedSecrets,
      customSecretMeta: this.s.customSecretMeta,
      kiloExaSearchMode: this.s.kiloExaSearchMode,
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

  // ── Kilo CLI Run ────────────────────────────────────────────────────

  async startKiloCliRun(prompt: string) {
    await this.loadState();
    return kiloCliRun.startKiloCliRun(this.s, this.env, prompt);
  }

  async getKiloCliRunStatus() {
    await this.loadState();
    return kiloCliRun.getKiloCliRunStatus(this.s, this.env);
  }

  async cancelKiloCliRun() {
    await this.loadState();
    return kiloCliRun.cancelKiloCliRun(this.s, this.env);
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
    if (this.s.status === 'recovering') {
      throw new Error('Cannot start: instance is recovering from an unexpected stop');
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
        await restoreFromPostgres(this.env, this.ctx, this.s, restoreUserId, {
          sandboxId: this.s.sandboxId,
        });
      }
    }

    if (!this.s.userId || !this.s.sandboxId) {
      throw Object.assign(new Error('Instance not provisioned'), { status: 404 });
    }

    const isFlyProvider = this.s.provider === 'fly';
    if (isFlyProvider) {
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

      await this.persistProviderResult(
        await this.provider().ensureStorage({
          env: this.env,
          state: this.s,
          reason: 'start',
        })
      );

      // Verify volume region matches cached flyRegion
      let flyState = getFlyProviderState(this.s);
      if (flyState.volumeId) {
        try {
          const volume = await fly.getVolume(flyConfig, flyState.volumeId);
          if (!volume.region) {
            doWarn(this.s, 'Volume region missing during drift check; keeping cached flyRegion', {
              volumeId: flyState.volumeId,
              cachedRegion: flyState.region,
            });
          } else if (volume.region !== flyState.region) {
            doWarn(this.s, 'flyRegion drift detected', {
              cachedRegion: flyState.region,
              actualRegion: volume.region,
            });
            flyState = {
              ...flyState,
              region: volume.region,
            };
            await this.persistProviderResult({ providerState: flyState });
          }
        } catch (err) {
          if (!fly.isFlyNotFound(err)) throw err;

          doWarn(this.s, 'Volume not found during region check, clearing');
          await this.persistProviderResult({
            providerState: {
              ...flyState,
              volumeId: null,
              region: null,
            },
          });
          await this.persistProviderResult(
            await this.provider().ensureStorage({
              env: this.env,
              state: this.s,
              reason: 'start',
            })
          );
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
          console.log(
            '[DO] Status is running but machine state is:',
            machine.state,
            '-- restarting'
          );
        } catch (err) {
          console.log('[DO] Failed to get machine state, will recreate:', err);
        }
      }
    } else {
      await this.persistProviderResult(
        await this.provider().ensureStorage({
          env: this.env,
          state: this.s,
          reason: 'start',
        })
      );
    }

    const { envVars, bootstrapEnv, minSecretsVersion } = await buildUserEnvVars(
      this.env,
      this.ctx,
      this.s
    );
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
      orgId: this.s.orgId,
      openclawVersion: this.s.openclawVersion,
      imageVariant: this.s.imageVariant,
      devCreator: this.env.WORKER_ENV === 'development' ? (this.env.DEV_CREATOR ?? null) : null,
    };
    const runtimeSpec = buildRuntimeSpec(
      resolveRuntimeImageRef(this.s, this.env),
      envVars,
      bootstrapEnv,
      this.s.machineSize,
      identity
    );

    const startResult = await this.provider().startRuntime({
      env: this.env,
      state: this.s,
      runtimeSpec,
      minSecretsVersion,
      preferredRegion: this.env.FLY_REGION,
      onProviderResult: result => this.persistProviderResult(result),
      onCapacityRecovery: async err => {
        const code = err instanceof fly.FlyApiError ? err.status : 0;
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.emitStartCapacityRecovery(errorMessage, this.capacityRecoveryLabel(err));
        doError(this.s, 'Insufficient resources, replacing stranded volume', {
          statusCode: code,
          region: this.s.flyRegion ?? 'unknown',
        });

        if (code === 403 && this.s.flyRegion) {
          await regionHelpers.evictCapacityRegionFromKV(
            this.env.KV_CLAW_CACHE,
            this.env,
            this.s.flyRegion
          );
        }
      },
    });
    await this.persistProviderResult(startResult);

    if (getRuntimeId(this.s)) {
      const healthy = await gateway.waitForHealthy(this.s, this.env);
      if (!healthy) {
        console.warn('[DO] start: gateway health probe timed out, proceeding with running status');
      }
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
   * the full runtime startup sequence.
   */
  async startAsync(userId?: string): Promise<void> {
    await this.loadState();

    if (this.s.status === 'destroying') {
      throw new Error('Cannot start: instance is being destroyed');
    }
    if (this.s.status === 'recovering') {
      throw new Error('Cannot start: instance is recovering from an unexpected stop');
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
        const storedEntries = await this.ctx.storage.get([
          'providerState',
          'flyMachineId',
          'status',
        ]);
        const rawProviderState = storedEntries.get('providerState');
        const parsedProviderState = ProviderStateSchema.safeParse(rawProviderState);
        const storedProviderState: ProviderState | null = parsedProviderState.success
          ? parsedProviderState.data
          : null;
        const storedFlyMachineId = storedEntries.get('flyMachineId');
        const storedFlyMachineIdValue =
          typeof storedFlyMachineId === 'string' ? storedFlyMachineId : null;
        const currentStatus = storedEntries.get('status');
        const storedRuntimeId = getRuntimeId({
          providerState: storedProviderState,
          flyMachineId: storedFlyMachineIdValue,
        });
        const storedProviderId =
          storedProviderState?.provider ?? (storedFlyMachineIdValue ? 'fly' : null);
        let providerStillOwnsRunningRuntime = false;
        if (currentStatus !== 'destroying' && storedProviderId === 'fly') {
          providerStillOwnsRunningRuntime = Boolean(storedRuntimeId || storedFlyMachineIdValue);
        } else if (storedProviderState && currentStatus !== 'destroying') {
          try {
            const inspected = await getProviderAdapter(this.env, {
              provider: storedProviderState.provider,
            }).inspectRuntime({
              env: this.env,
              state: {
                ...this.s,
                provider: storedProviderState.provider,
                providerState: storedProviderState,
                flyMachineId: storedFlyMachineIdValue,
              },
            });
            providerStillOwnsRunningRuntime =
              inspected.observation?.runtimeState === 'running' ||
              inspected.observation?.runtimeState === 'starting';
          } catch (inspectErr) {
            doWarn(this.s, 'startAsync: failed to inspect runtime after start failure', {
              error: toLoggable(inspectErr),
            });
          }
        }

        if (!providerStillOwnsRunningRuntime && currentStatus !== 'destroying') {
          // start() threw before persisting a machine ID. Reconcile cannot
          // distinguish this from "still in progress", so write the terminal
          // state explicitly to avoid the 5-min stuck window.
          // Skip if destroy() has taken ownership — writing 'stopped' would
          // clobber the 'destroying' state and strand cleanup.
          const errorMessage = err instanceof Error ? err.message : String(err);
          await this.markStartFailedFromProvider(errorMessage);
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
      this.s.status === 'recovering' ||
      this.s.status === 'destroying' ||
      this.s.status === 'restoring'
    ) {
      console.log('[DO] Instance not running (status:', this.s.status, '), no-op');
      return;
    }

    const machineUptimeMs = this.s.lastStartedAt ? Date.now() - this.s.lastStartedAt : 0;

    if (getRuntimeId(this.s)) {
      try {
        await this.persistProviderResult(
          await this.provider().stopRuntime({
            env: this.env,
            state: this.s,
          })
        );
      } catch (err) {
        // Non-Fly adapters own provider-specific "already gone" handling; this
        // guard is for Fly APIs that can surface a machine 404 during stop.
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
    if (this.s.status === 'recovering') {
      throw new Error('Cannot destroy: instance is recovering from an unexpected stop');
    }

    const machineUptimeMs = this.s.lastStartedAt ? Date.now() - this.s.lastStartedAt : 0;
    const runtimeId = getRuntimeId(this.s);
    const storageId = getStorageId(this.s);

    this.s.pendingDestroyMachineId = runtimeId;
    this.s.pendingDestroyVolumeId = storageId;
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

    const destroyRctx = createReconcileContext(this.s, this.env, 'destroy');
    if (this.s.provider === 'fly') {
      const flyConfig = getFlyConfig(this.env, this.s);
      await tryDeleteMachine(flyConfig, this.ctx, this.s, destroyRctx);
      await tryDeleteVolume(flyConfig, this.ctx, this.s, destroyRctx);
    } else {
      await this.retryNonFlyDestroy();
    }

    // Capture identity before finalization wipes state
    const preDestroyUserId = this.s.userId;
    const preDestroyOrgId = this.s.orgId;
    const preDestroySandboxId = this.s.sandboxId;

    const finalized = await finalizeDestroyIfComplete(
      this.ctx,
      this.s,
      destroyRctx,
      (userId, sandboxId) =>
        markDestroyedInPostgresHelper(this.env, this.ctx, this.s, userId, sandboxId)
    );

    // Clean up registry entry on finalization. This covers both platform-initiated
    // and alarm-initiated destroys. The platform route's registry cleanup is
    // redundant but harmless (destroyInstance is idempotent on already-destroyed entries).
    if (finalized.finalized && preDestroyUserId && preDestroySandboxId) {
      try {
        const registryInstanceId = isInstanceKeyedSandboxId(preDestroySandboxId)
          ? instanceIdFromSandboxId(preDestroySandboxId)
          : null;

        const registryKeys = [`user:${preDestroyUserId}`];
        if (preDestroyOrgId) registryKeys.push(`org:${preDestroyOrgId}`);

        for (const registryKey of registryKeys) {
          const registryStub = this.env.KILOCLAW_REGISTRY.get(
            this.env.KILOCLAW_REGISTRY.idFromName(registryKey)
          );
          if (registryInstanceId) {
            await registryStub.destroyInstance(registryKey, registryInstanceId);
            console.log('[DO] Registry entry destroyed on finalization:', {
              registryKey,
              instanceId: registryInstanceId,
            });
          } else {
            const legacyDoKeys = legacyDoKeysForIdentity(preDestroyUserId, preDestroySandboxId);
            const entries = await registryStub.listInstances(registryKey);
            const legacyEntry = entries.find(e => legacyDoKeys.includes(e.doKey));
            if (legacyEntry) {
              await registryStub.destroyInstance(registryKey, legacyEntry.instanceId);
              console.log('[DO] Registry entry destroyed on finalization (legacy):', {
                registryKey,
                instanceId: legacyEntry.instanceId,
                doKeysTried: legacyDoKeys,
                matchedDoKey: legacyEntry.doKey,
              });
            } else {
              console.log(
                '[DO] Registry cleanup: no active entry found (already cleaned or never existed):',
                {
                  registryKey,
                  doKeysTried: legacyDoKeys,
                  activeEntryCount: entries.length,
                }
              );
            }
          }
        }
      } catch (registryErr) {
        console.error('[DO] Registry cleanup on finalization failed (non-fatal):', registryErr);
      }
    }

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
    provider: ProviderId;
    runtimeId: string | null;
    storageId: string | null;
    region: string | null;
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
    botName: string | null;
    botNature: string | null;
    botVibe: string | null;
    botEmoji: string | null;
  }> {
    await this.loadState();

    if (
      this.s.status === 'running' &&
      this.s.provider === 'fly' &&
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
      provider: this.s.provider,
      runtimeId: getRuntimeId(this.s),
      storageId: getStorageId(this.s),
      region: getProviderRegion(this.s),
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
      botName: this.s.botName,
      botNature: this.s.botNature,
      botVibe: this.s.botVibe,
      botEmoji: this.s.botEmoji,
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
    provider: ProviderId;
    runtimeId: string | null;
    storageId: string | null;
    region: string | null;
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
    recoveryStartedAt: number | null;
    pendingRecoveryVolumeId: string | null;
    recoveryPreviousVolumeId: string | null;
    recoveryPreviousVolumeCleanupAfter: number | null;
    lastRecoveryErrorMessage: string | null;
    lastRecoveryErrorAt: number | null;
    previousVolumeId: string | null;
    restoreStartedAt: string | null;
    pendingRestoreVolumeId: string | null;
    instanceReadyEmailSent: boolean;
    // --- env key diagnostics ---
    envKeyAppDOKey: string | null;
    envKeyAppDOFlyAppName: string | null;
    envKeyAppDOKeySet: boolean | null;
  }> {
    await this.loadState();
    const alarmScheduledAt = await this.ctx.storage.getAlarm();

    // Fetch env key diagnostics from the App DO (best-effort, don't fail the whole response).
    let envKeyDiag: {
      flyAppName: string | null;
      envKeySet: boolean;
    } | null = null;
    let envKeyAppDOKey: string | null = null;
    try {
      if (this.s.userId || this.s.sandboxId) {
        envKeyAppDOKey = getAppKey({ userId: this.s.userId, sandboxId: this.s.sandboxId });
        const appStub = this.env.KILOCLAW_APP.get(this.env.KILOCLAW_APP.idFromName(envKeyAppDOKey));
        envKeyDiag = await appStub.getDiagnostics();
      }
    } catch {
      // Swallow — diagnostics are best-effort.
    }

    return {
      userId: this.s.userId,
      sandboxId: this.s.sandboxId,
      orgId: this.s.orgId,
      provider: this.s.provider,
      runtimeId: getRuntimeId(this.s),
      storageId: getStorageId(this.s),
      region: getProviderRegion(this.s),
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
      recoveryStartedAt: this.s.recoveryStartedAt,
      pendingRecoveryVolumeId: this.s.pendingRecoveryVolumeId,
      recoveryPreviousVolumeId: this.s.recoveryPreviousVolumeId,
      recoveryPreviousVolumeCleanupAfter: this.s.recoveryPreviousVolumeCleanupAfter,
      lastRecoveryErrorMessage: this.s.lastRecoveryErrorMessage,
      lastRecoveryErrorAt: this.s.lastRecoveryErrorAt,
      previousVolumeId: this.s.previousVolumeId,
      restoreStartedAt: this.s.restoreStartedAt,
      pendingRestoreVolumeId: this.s.pendingRestoreVolumeId,
      instanceReadyEmailSent: this.s.instanceReadyEmailSent,
      envKeyAppDOKey,
      envKeyAppDOFlyAppName: envKeyDiag?.flyAppName ?? null,
      envKeyAppDOKeySet: envKeyDiag?.envKeySet ?? null,
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
      userTimezone: this.s.userTimezone ?? undefined,
      webSearch: this.s.kiloExaSearchMode
        ? {
            exaMode: this.s.kiloExaSearchMode,
          }
        : undefined,
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

  async cleanupRecoveryPreviousVolume(): Promise<{ ok: true; deletedVolumeId: string | null }> {
    await this.loadState();
    return cleanupRecoveryPreviousVolume(this.recoveryRuntime());
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
    if (this.s.status === 'recovering') {
      throw new Error('Cannot reassociate: instance is recovering from an unexpected stop');
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

  // ── Machine resize (admin) ─────────────────────────────────────────

  async resizeMachine(newSize: MachineSize): Promise<{
    previousSize: MachineSize | null;
    newSize: MachineSize;
  }> {
    await this.loadState();

    if (!this.s.userId) {
      throw new Error('Instance is not provisioned');
    }
    if (this.s.status === 'destroying') {
      throw new Error('Cannot resize: instance is being destroyed');
    }
    if (this.s.status === 'restoring') {
      throw new Error('Cannot resize: instance is restoring from snapshot');
    }
    if (this.s.status === 'recovering') {
      throw new Error('Cannot resize: instance is recovering from an unexpected stop');
    }

    const previousSize = this.s.machineSize;

    this.s.machineSize = newSize;
    await this.persist({ machineSize: newSize });

    console.log(
      `[admin-machine-resize] userId=${this.s.userId} ` +
        `previous=${JSON.stringify(previousSize)} new=${JSON.stringify(newSize)}`
    );

    return { previousSize, newSize };
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
    if (this.s.status === 'recovering') {
      throw new Error('Cannot restore: instance is recovering from an unexpected stop');
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
        instanceId:
          this.s.sandboxId && isInstanceKeyedSandboxId(this.s.sandboxId)
            ? instanceIdFromSandboxId(this.s.sandboxId)
            : undefined,
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

    if (!getRuntimeId(this.s)) {
      return { success: false, error: 'No machine exists' };
    }

    if (
      this.s.status === 'provisioned' ||
      this.s.status === 'destroying' ||
      this.s.status === 'starting' ||
      this.s.status === 'restarting' ||
      this.s.status === 'recovering' ||
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
      if (this.s.provider !== 'fly' && options?.imageTag) {
        return {
          success: false,
          error: `Provider ${this.s.provider} does not support image tag overrides`,
        };
      }

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

      // Backfill machineSize from live machine for legacy instances
      if (this.s.provider === 'fly' && this.s.machineSize === null && this.s.flyMachineId) {
        const flyConfig = getFlyConfig(this.env, this.s);
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

      if (!getRuntimeId(this.s)) {
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

      const { envVars, bootstrapEnv, minSecretsVersion } = await buildUserEnvVars(
        this.env,
        this.ctx,
        this.s
      );
      const imageTag = resolveImageTag(this.s, this.env);
      doLog(this.s, 'restartMachine: deploying update', {
        imageTag,
        flyMachineId: this.s.flyMachineId,
      });
      const identity = {
        userId: this.s.userId ?? '',
        sandboxId: this.s.sandboxId ?? '',
        orgId: this.s.orgId,
        openclawVersion: this.s.openclawVersion,
        imageVariant: this.s.imageVariant,
        devCreator: this.env.WORKER_ENV === 'development' ? (this.env.DEV_CREATOR ?? null) : null,
      };
      const runtimeSpec = buildRuntimeSpec(
        resolveRuntimeImageRef(this.s, this.env),
        envVars,
        bootstrapEnv,
        this.s.machineSize,
        identity
      );

      const restart = await this.provider().restartRuntime({
        env: this.env,
        state: this.s,
        runtimeSpec,
        minSecretsVersion,
        onProviderResult: async result => {
          const currentStatus = await this.ctx.storage.get('status');
          if (currentStatus !== 'restarting') return;
          await this.persistProviderResult(result);
        },
      });
      await this.persistProviderResult(restart);
      const healthy = await gateway.waitForHealthy(this.s, this.env);
      if (!healthy) {
        console.warn(
          '[DO] restartMachine: gateway health probe timed out, proceeding with running status'
        );
      }

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
      if (postStatus === 'restarting' && !isExpectedTimeout) {
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

  private async recoverUnexpectedStopInBackground(): Promise<void> {
    await runUnexpectedStopRecoveryInBackground(this.recoveryRuntime());
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

    if (this.s.status !== 'recovering') {
      await cleanupPendingRecoveryVolumeIfNeeded(
        this.recoveryRuntime(),
        'alarm_pending_recovery_cleanup'
      );
    }
    await cleanupRetainedRecoveryVolumeIfDue(
      this.recoveryRuntime(),
      'alarm_retained_recovery_cleanup'
    );

    try {
      if (this.s.provider !== 'fly') {
        if (this.s.status === 'destroying') {
          await this.retryNonFlyDestroy();
          await finalizeDestroyIfComplete(
            this.ctx,
            this.s,
            createReconcileContext(this.s, this.env, 'alarm_destroy'),
            (userId, sandboxId) =>
              markDestroyedInPostgresHelper(this.env, this.ctx, this.s, userId, sandboxId)
          );
        } else {
          await this.reconcileNonFlyRuntimeFromAlarm();
        }
        if (this.s.status) {
          await this.scheduleAlarm();
        }
        return;
      }

      const flyConfig = getFlyConfig(this.env, this.s);
      const reconcileResult = await reconcileWithFly(
        flyConfig,
        this.ctx,
        this.s,
        this.env,
        'alarm',
        () => this.destroy().then(() => undefined),
        (userId, sandboxId) =>
          markDestroyedInPostgresHelper(this.env, this.ctx, this.s, userId, sandboxId)
      );

      if (reconcileResult.beginUnexpectedStopRecovery && this.s.status === 'running') {
        await beginUnexpectedStopRecovery(
          this.recoveryRuntime(),
          reconcileResult.beginUnexpectedStopRecovery
        );
        this.ctx.waitUntil(this.recoverUnexpectedStopInBackground());
        return;
      }

      if (reconcileResult.completeUnexpectedStopRecovery && this.s.status === 'recovering') {
        try {
          await completeUnexpectedStopRecovery(this.recoveryRuntime());
        } catch (err) {
          doError(this.s, 'completeUnexpectedStopRecovery failed during alarm reconcile', {
            error: toLoggable(err),
          });
          const errorMessage = err instanceof Error ? err.message : String(err);
          await failUnexpectedStopRecovery(
            this.recoveryRuntime(),
            errorMessage,
            'alarm_reconcile_complete'
          );
        }
        return;
      }

      if (reconcileResult.failedUnexpectedStopRecovery && this.s.status === 'recovering') {
        await failUnexpectedStopRecovery(
          this.recoveryRuntime(),
          reconcileResult.failedUnexpectedStopRecovery.errorMessage,
          reconcileResult.failedUnexpectedStopRecovery.label
        );
        await this.scheduleAlarm();
        return;
      }

      if (reconcileResult.timedOutUnexpectedStopRecovery && this.s.status === 'recovering') {
        await failUnexpectedStopRecovery(
          this.recoveryRuntime(),
          reconcileResult.timedOutUnexpectedStopRecovery.errorMessage,
          'alarm_timeout'
        );
        await this.scheduleAlarm();
        return;
      }
    } catch (err) {
      doError(this.s, 'alarm reconcile failed', {
        error: toLoggable(err),
      });
    }

    if (this.s.status) {
      await this.scheduleAlarm();
    }
  }
}
