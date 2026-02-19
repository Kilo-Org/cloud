/**
 * KiloClawInstance Durable Object
 *
 * Primary source of truth for instance configuration and operational state.
 * API routes are thin wrappers that call into this DO via Workers RPC.
 *
 * Keyed by userId: env.KILOCLAW_INSTANCE.idFromName(userId)
 *
 * Authority model:
 * - Postgres is written by the Next.js backend (sole writer). The worker reads only.
 * - Postgres is a registry + config backup. Operational state lives here in the DO.
 * - If DO SQLite is wiped, start() restores config from Postgres via Hyperdrive.
 *
 * Compute backend: Fly.io Machines API.
 * Each user gets a dedicated Fly Machine + Fly Volume for persistence.
 *
 * Reconciliation:
 * - The alarm() loop calls reconcileWithFly() to fix drift between DO state and Fly reality.
 * - Alarm runs for ALL live instances (provisioned, running, stopped, destroying).
 * - Destroying instances only retry pending deletes; never recreate resources.
 * - Two-phase destroy: IDs are persisted until Fly confirms deletion.
 */

import { DurableObject } from 'cloudflare:workers';
import type { KiloClawEnv } from '../types';
import { sandboxIdFromUserId } from '../auth/sandbox-id';
import { createDatabaseConnection, InstanceStore } from '../db';
import { buildEnvVars } from '../gateway/env';
import {
  PersistedStateSchema,
  type InstanceConfig,
  type PersistedState,
  type EncryptedEnvelope,
  type ModelEntry,
  type MachineSize,
} from '../schemas/instance-config';
import {
  OPENCLAW_PORT,
  STARTUP_TIMEOUT_SECONDS,
  DEFAULT_MACHINE_GUEST,
  DEFAULT_VOLUME_SIZE_GB,
  ALARM_INTERVAL_RUNNING_MS,
  ALARM_INTERVAL_DESTROYING_MS,
  ALARM_INTERVAL_IDLE_MS,
  ALARM_JITTER_MS,
  SELF_HEAL_THRESHOLD,
  LIVE_CHECK_THROTTLE_MS,
} from '../config';
import type { FlyClientConfig } from '../fly/client';
import type { FlyMachineConfig, FlyMachine, FlyMachineState } from '../fly/types';
import * as fly from '../fly/client';
import { appNameFromUserId } from '../fly/apps';
import { ENCRYPTED_ENV_PREFIX, encryptEnvValue } from '../utils/env-encryption';

type InstanceStatus = PersistedState['status'];

// Derived from PersistedStateSchema -- single source of truth for DO KV keys.
const STORAGE_KEYS = Object.keys(PersistedStateSchema.shape);

/** Type-checked wrapper for ctx.storage.put(). */
function storageUpdate(update: Partial<PersistedState>): Partial<PersistedState> {
  return update;
}

// ============================================================================
// Structured reconciliation logging
// ============================================================================

function reconcileLog(reason: string, action: string, details: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      tag: 'reconcile',
      reason,
      action,
      ...details,
    })
  );
}

// ============================================================================
// Alarm interval selection
// ============================================================================

function alarmIntervalForStatus(status: InstanceStatus): number {
  switch (status) {
    case 'running':
      return ALARM_INTERVAL_RUNNING_MS;
    case 'destroying':
      return ALARM_INTERVAL_DESTROYING_MS;
    case 'provisioned':
    case 'stopped':
      return ALARM_INTERVAL_IDLE_MS;
  }
}

function nextAlarmTime(status: InstanceStatus): number {
  return Date.now() + alarmIntervalForStatus(status) + Math.random() * ALARM_JITTER_MS;
}

// ============================================================================
// Metadata keys set on every Fly Machine for recovery/orphan detection.
// Avoid fly_* keys — those are reserved by Fly.
// ============================================================================

export const METADATA_KEY_USER_ID = 'kiloclaw_user_id';
export const METADATA_KEY_SANDBOX_ID = 'kiloclaw_sandbox_id';

// ============================================================================
// Machine config builder
// ============================================================================

type MachineIdentity = { userId: string; sandboxId: string };

function buildMachineConfig(
  registryApp: string,
  imageTag: string,
  envVars: Record<string, string>,
  guest: FlyMachineConfig['guest'],
  flyVolumeId: string | null,
  identity: MachineIdentity
): FlyMachineConfig {
  return {
    image: `registry.fly.io/${registryApp}:${imageTag}`,
    env: envVars,
    guest,
    services: [
      {
        ports: [{ port: 443, handlers: ['tls', 'http'] }],
        internal_port: OPENCLAW_PORT,
        protocol: 'tcp' as const,
        autostart: false,
        autostop: 'off',
      },
    ],
    mounts: flyVolumeId ? [{ volume: flyVolumeId, path: '/root' }] : [],
    metadata: {
      [METADATA_KEY_USER_ID]: identity.userId,
      [METADATA_KEY_SANDBOX_ID]: identity.sandboxId,
    },
  };
}

function guestFromSize(machineSize: MachineSize | null): FlyMachineConfig['guest'] {
  if (!machineSize) return DEFAULT_MACHINE_GUEST;
  return {
    cpus: machineSize.cpus,
    memory_mb: machineSize.memory_mb,
    cpu_kind: machineSize.cpu_kind,
  };
}

// ============================================================================
// Volume name helper
// ============================================================================

function volumeNameFromSandboxId(sandboxId: string): string {
  return `kiloclaw_${sandboxId}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 30);
}

// ============================================================================
// Machine recovery: deterministic selection from metadata query results
// ============================================================================

/** Cooldown between metadata recovery attempts (1 alarm cycle at idle cadence). */
const METADATA_RECOVERY_COOLDOWN_MS = ALARM_INTERVAL_IDLE_MS;

/** States that indicate the machine is dead and should be ignored for recovery. */
const DEAD_STATES: ReadonlySet<FlyMachineState> = new Set(['destroyed', 'destroying']);

/** Terminal non-running states for live check. Transitional states (starting, stopping, replacing)
 *  are intentionally excluded to avoid UI flicker during normal operations. */
const TERMINAL_STOPPED_STATES: ReadonlySet<string> = new Set([
  'stopped',
  'created',
  'destroyed',
  'suspended',
]);

/**
 * Priority order for picking a machine to recover.
 * Lower index = higher preference. `started` is best, then `starting`, etc.
 */
const STATE_PRIORITY: ReadonlyMap<FlyMachineState, number> = new Map([
  ['started', 0],
  ['starting', 1],
  ['stopped', 2],
  ['created', 3],
  ['stopping', 4],
  ['replacing', 5],
]);

/**
 * Given a list of machines from Fly's metadata query, pick the best candidate
 * for recovery. Returns null if no live machines found.
 *
 * Selection rules:
 * 1. Ignore destroyed/destroying machines.
 * 2. Prefer started > starting > stopped > created > others.
 * 3. Tie-break by newest updated_at.
 */
export function selectRecoveryCandidate(machines: FlyMachine[]): FlyMachine | null {
  const live = machines.filter(m => !DEAD_STATES.has(m.state));
  if (live.length === 0) return null;

  live.sort((a, b) => {
    const pa = STATE_PRIORITY.get(a.state) ?? 99;
    const pb = STATE_PRIORITY.get(b.state) ?? 99;
    if (pa !== pb) return pa - pb;
    // Tie-break: newest updated_at first
    return b.updated_at.localeCompare(a.updated_at);
  });

  return live[0];
}

/**
 * Extract the volume ID from a machine's mount config at /root, if present.
 */
function volumeIdFromMachine(machine: FlyMachine): string | null {
  const rootMount = (machine.config?.mounts ?? []).find(m => m.path === '/root');
  return rootMount?.volume ?? null;
}

// ============================================================================
// KiloClawInstance DO
// ============================================================================

export class KiloClawInstance extends DurableObject<KiloClawEnv> {
  // Cached state (loaded from DO SQLite on first access)
  private loaded = false;
  private userId: string | null = null;
  private sandboxId: string | null = null;
  private status: InstanceStatus | null = null;
  private envVars: PersistedState['envVars'] = null;
  private encryptedSecrets: PersistedState['encryptedSecrets'] = null;
  private kilocodeApiKey: PersistedState['kilocodeApiKey'] = null;
  private kilocodeApiKeyExpiresAt: PersistedState['kilocodeApiKeyExpiresAt'] = null;
  private kilocodeDefaultModel: PersistedState['kilocodeDefaultModel'] = null;
  private kilocodeModels: PersistedState['kilocodeModels'] = null;
  private channels: PersistedState['channels'] = null;
  private provisionedAt: number | null = null;
  private lastStartedAt: number | null = null;
  private lastStoppedAt: number | null = null;
  private flyAppName: string | null = null;
  private flyMachineId: string | null = null;
  private flyVolumeId: string | null = null;
  private flyRegion: string | null = null;
  private machineSize: MachineSize | null = null;
  private healthCheckFailCount = 0;
  private pendingDestroyMachineId: string | null = null;
  private pendingDestroyVolumeId: string | null = null;
  private lastMetadataRecoveryAt: number | null = null;

  // In-memory only (not persisted to SQLite) — throttles live Fly checks in getStatus()
  private lastLiveCheckAt: number | null = null;

  // ---- State loading ----

  private async loadState(): Promise<void> {
    if (this.loaded) return;

    const entries = await this.ctx.storage.get(STORAGE_KEYS);
    const raw = Object.fromEntries(entries.entries());
    const parsed = PersistedStateSchema.safeParse(raw);

    if (parsed.success) {
      const s = parsed.data;
      this.userId = s.userId || null;
      this.sandboxId = s.sandboxId || null;
      this.status = s.userId ? s.status : null;
      this.envVars = s.envVars;
      this.encryptedSecrets = s.encryptedSecrets;
      this.kilocodeApiKey = s.kilocodeApiKey;
      this.kilocodeApiKeyExpiresAt = s.kilocodeApiKeyExpiresAt;
      this.kilocodeDefaultModel = s.kilocodeDefaultModel;
      this.kilocodeModels = s.kilocodeModels;
      this.channels = s.channels;
      this.provisionedAt = s.provisionedAt;
      this.lastStartedAt = s.lastStartedAt;
      this.lastStoppedAt = s.lastStoppedAt;
      this.flyAppName = s.flyAppName;
      this.flyMachineId = s.flyMachineId;
      this.flyVolumeId = s.flyVolumeId;
      this.flyRegion = s.flyRegion;
      this.machineSize = s.machineSize;
      this.healthCheckFailCount = s.healthCheckFailCount;
      this.pendingDestroyMachineId = s.pendingDestroyMachineId;
      this.pendingDestroyVolumeId = s.pendingDestroyVolumeId;
      this.lastMetadataRecoveryAt = s.lastMetadataRecoveryAt;
    } else {
      const hasAnyData = entries.size > 0;
      if (hasAnyData) {
        console.warn(
          '[DO] Persisted state failed validation, treating as fresh. Errors:',
          parsed.error.flatten().fieldErrors
        );
      }
    }

    this.loaded = true;
  }

  // ========================================================================
  // Lifecycle methods (called by platform API routes via RPC)
  // ========================================================================

  /**
   * Provision or update config for a user's instance.
   * Creates a Fly Volume on first provision. Allows re-provisioning (config update).
   */
  async provision(userId: string, config: InstanceConfig): Promise<{ sandboxId: string }> {
    await this.loadState();

    if (this.status === 'destroying') {
      throw new Error('Cannot provision: instance is being destroyed');
    }

    const sandboxId = sandboxIdFromUserId(userId);
    const isNew = !this.status;

    // Ensure per-user Fly App exists on first provision only.
    // Legacy instances (flyAppName = null with existing flyMachineId/flyVolumeId)
    // must NOT be reassigned: their resources live in the legacy FLY_APP_NAME app.
    // They get a per-user app only after a full destroy + fresh provision cycle.
    if (isNew && !this.flyAppName) {
      const appStub = this.env.KILOCLAW_APP.get(this.env.KILOCLAW_APP.idFromName(userId));
      const { appName } = await appStub.ensureApp(userId);
      this.flyAppName = appName;
      await this.ctx.storage.put(storageUpdate({ flyAppName: appName }));
      console.log('[DO] Per-user Fly App ensured:', appName);
    }

    // Create Fly Volume on first provision
    if (isNew && !this.flyVolumeId) {
      const flyConfig = this.getFlyConfig();
      const region = config.region ?? this.env.FLY_REGION ?? 'us,eu';
      const volume = await fly.createVolume(flyConfig, {
        name: volumeNameFromSandboxId(sandboxId),
        region,
        size_gb: DEFAULT_VOLUME_SIZE_GB,
      });
      this.flyVolumeId = volume.id;
      this.flyRegion = volume.region;
      console.log('[DO] Created Fly Volume:', volume.id, 'region:', volume.region);
    }

    const configFields = {
      userId,
      sandboxId,
      status: (this.status ?? 'provisioned') satisfies InstanceStatus,
      envVars: config.envVars ?? null,
      encryptedSecrets: config.encryptedSecrets ?? null,
      kilocodeApiKey: config.kilocodeApiKey ?? null,
      kilocodeApiKeyExpiresAt: config.kilocodeApiKeyExpiresAt ?? null,
      kilocodeDefaultModel: config.kilocodeDefaultModel ?? null,
      kilocodeModels: config.kilocodeModels ?? null,
      channels: config.channels ?? null,
      machineSize: config.machineSize ?? this.machineSize ?? null,
    } satisfies Partial<PersistedState>;

    const update = isNew
      ? storageUpdate({
          ...configFields,
          provisionedAt: Date.now(),
          lastStartedAt: null,
          lastStoppedAt: null,
          flyAppName: this.flyAppName,
          flyMachineId: this.flyMachineId,
          flyVolumeId: this.flyVolumeId,
          flyRegion: this.flyRegion,
          healthCheckFailCount: 0,
          pendingDestroyMachineId: null,
          pendingDestroyVolumeId: null,
        })
      : storageUpdate(configFields);

    await this.ctx.storage.put(update);

    // Update cached state
    this.userId = userId;
    this.sandboxId = sandboxId;
    this.status = this.status ?? 'provisioned';
    this.envVars = config.envVars ?? null;
    this.encryptedSecrets = config.encryptedSecrets ?? null;
    this.kilocodeApiKey = config.kilocodeApiKey ?? null;
    this.kilocodeApiKeyExpiresAt = config.kilocodeApiKeyExpiresAt ?? null;
    this.kilocodeDefaultModel = config.kilocodeDefaultModel ?? null;
    this.kilocodeModels = config.kilocodeModels ?? null;
    this.channels = config.channels ?? null;
    this.machineSize = config.machineSize ?? this.machineSize ?? null;
    if (isNew) {
      this.provisionedAt = Date.now();
      this.lastStartedAt = null;
      this.lastStoppedAt = null;
      this.healthCheckFailCount = 0;
      this.pendingDestroyMachineId = null;
      this.pendingDestroyVolumeId = null;
    }
    this.loaded = true;

    // Schedule reconciliation alarm for new instances
    if (isNew) {
      await this.scheduleAlarm();
    }

    return { sandboxId };
  }

  async updateKiloCodeConfig(patch: {
    kilocodeApiKey?: string | null;
    kilocodeApiKeyExpiresAt?: string | null;
    kilocodeDefaultModel?: string | null;
    kilocodeModels?: ModelEntry[] | null;
  }): Promise<{
    kilocodeApiKey: string | null;
    kilocodeApiKeyExpiresAt: string | null;
    kilocodeDefaultModel: string | null;
    kilocodeModels: ModelEntry[] | null;
  }> {
    await this.loadState();

    const pending: Partial<PersistedState> = {};

    if (patch.kilocodeApiKey !== undefined) {
      this.kilocodeApiKey = patch.kilocodeApiKey;
      pending.kilocodeApiKey = this.kilocodeApiKey;
    }
    if (patch.kilocodeApiKeyExpiresAt !== undefined) {
      this.kilocodeApiKeyExpiresAt = patch.kilocodeApiKeyExpiresAt;
      pending.kilocodeApiKeyExpiresAt = this.kilocodeApiKeyExpiresAt;
    }
    if (patch.kilocodeDefaultModel !== undefined) {
      this.kilocodeDefaultModel = patch.kilocodeDefaultModel;
      pending.kilocodeDefaultModel = this.kilocodeDefaultModel;
    }
    if (patch.kilocodeModels !== undefined) {
      this.kilocodeModels = patch.kilocodeModels;
      pending.kilocodeModels = this.kilocodeModels;
    }

    if (Object.keys(pending).length > 0) {
      await this.ctx.storage.put(pending);
    }

    return {
      kilocodeApiKey: this.kilocodeApiKey,
      kilocodeApiKeyExpiresAt: this.kilocodeApiKeyExpiresAt,
      kilocodeDefaultModel: this.kilocodeDefaultModel,
      kilocodeModels: this.kilocodeModels,
    };
  }

  /**
   * Update channel tokens (e.g. Telegram bot token).
   * Merges incoming channels with existing ones — pass null for a token to remove it.
   * Does NOT restart the machine; the caller should prompt the user to restart.
   */
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
    await this.loadState();

    const merged = this.channels ? { ...this.channels } : {};

    if (patch.telegramBotToken !== undefined) {
      if (patch.telegramBotToken === null) {
        delete merged.telegramBotToken;
      } else {
        merged.telegramBotToken = patch.telegramBotToken;
      }
    }
    if (patch.discordBotToken !== undefined) {
      if (patch.discordBotToken === null) {
        delete merged.discordBotToken;
      } else {
        merged.discordBotToken = patch.discordBotToken;
      }
    }
    if (patch.slackBotToken !== undefined) {
      if (patch.slackBotToken === null) {
        delete merged.slackBotToken;
      } else {
        merged.slackBotToken = patch.slackBotToken;
      }
    }
    if (patch.slackAppToken !== undefined) {
      if (patch.slackAppToken === null) {
        delete merged.slackAppToken;
      } else {
        merged.slackAppToken = patch.slackAppToken;
      }
    }

    const hasAny = Object.values(merged).some(Boolean);
    this.channels = hasAny ? merged : null;
    await this.ctx.storage.put({ channels: this.channels });

    return {
      telegram: !!this.channels?.telegramBotToken,
      discord: !!this.channels?.discordBotToken,
      slackBot: !!this.channels?.slackBotToken,
      slackApp: !!this.channels?.slackAppToken,
    };
  }

  /** KV cache key for pairing requests, scoped to the specific machine. */
  private pairingCacheKey(): string | null {
    const { flyAppName, flyMachineId } = this;
    if (!flyAppName || !flyMachineId) return null;
    return `pairing:${flyAppName}:${flyMachineId}`;
  }

  private static PAIRING_CACHE_TTL_SECONDS = 120;

  /**
   * List pending channel pairing requests across all configured channels.
   * Uses the openclaw-pairing-list.js helper script on the machine.
   * Results are cached in KV for 2 minutes. Pass forceRefresh to bypass cache.
   * Requires the machine to be running.
   */
  async listPairingRequests(forceRefresh = false): Promise<{
    requests: Array<{
      code: string;
      id: string;
      channel: string;
      meta?: unknown;
      createdAt?: string;
    }>;
  }> {
    await this.loadState();

    const { flyMachineId } = this;
    if (this.status !== 'running' || !flyMachineId) {
      return { requests: [] };
    }

    const cacheKey = this.pairingCacheKey();
    if (cacheKey && !forceRefresh) {
      const cached = await this.env.KV_CLAW_CACHE.get(cacheKey, 'json');
      if (
        cached &&
        typeof cached === 'object' &&
        'requests' in cached &&
        Array.isArray(cached.requests)
      ) {
        console.log(`[DO] pairing list served from KV cache (key=${cacheKey})`);
        return { requests: cached.requests };
      }
    }

    const flyConfig = this.getFlyConfig();

    const result = await fly.execCommand(
      flyConfig,
      flyMachineId,
      ['/usr/bin/env', 'HOME=/root', 'node', '/usr/local/bin/openclaw-pairing-list.js'],
      20
    );

    const empty = {
      requests: [] as Array<{
        code: string;
        id: string;
        channel: string;
        meta?: unknown;
        createdAt?: string;
      }>,
    };

    if (result.exit_code !== 0) {
      console.error('[DO] pairing list failed:', result.stderr);
      return empty;
    }

    let pairing = empty;
    try {
      const data = JSON.parse(result.stdout.trim());
      if (Array.isArray(data.requests)) {
        pairing = { requests: data.requests };
      }
    } catch {
      console.error('[DO] pairing list parse error:', result.stdout);
    }

    if (cacheKey) {
      await this.env.KV_CLAW_CACHE.put(cacheKey, JSON.stringify(pairing), {
        expirationTtl: KiloClawInstance.PAIRING_CACHE_TTL_SECONDS,
      });
    }

    return pairing;
  }

  /**
   * Approve a pending channel pairing request via `openclaw pairing approve` on the machine.
   * Busts the pairing KV cache on success.
   * Requires the machine to be running.
   */
  async approvePairingRequest(
    channel: string,
    code: string
  ): Promise<{ success: boolean; message: string }> {
    await this.loadState();

    const { flyMachineId } = this;
    if (this.status !== 'running' || !flyMachineId) {
      return { success: false, message: 'Instance is not running' };
    }

    const flyConfig = this.getFlyConfig();

    // Validate inputs to prevent command injection — channel and code
    // come from user input and are interpolated into a shell command.
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(channel)) {
      return { success: false, message: 'Invalid channel name' };
    }
    if (!/^[A-Za-z0-9]{1,32}$/.test(code)) {
      return { success: false, message: 'Invalid pairing code' };
    }

    const result = await fly.execCommand(
      flyConfig,
      flyMachineId,
      ['/usr/bin/env', 'HOME=/root', 'openclaw', 'pairing', 'approve', channel, code, '--notify'],
      15
    );

    const success = result.exit_code === 0;

    if (success) {
      const cacheKey = this.pairingCacheKey();
      if (cacheKey) {
        await this.env.KV_CLAW_CACHE.delete(cacheKey);
      }
    }

    return {
      success,
      message: success ? 'Pairing approved' : result.stderr || result.stdout || 'Approval failed',
    };
  }

  /**
   * Start the Fly Machine.
   */
  async start(userId?: string): Promise<void> {
    await this.loadState();

    if (this.status === 'destroying') {
      throw new Error('Cannot start: instance is being destroyed');
    }

    // If DO SQLite was wiped, attempt restore from Postgres backup
    if (!this.userId || !this.sandboxId) {
      const restoreUserId = userId ?? this.userId;
      if (restoreUserId) {
        await this.restoreFromPostgres(restoreUserId);
      }
    }

    if (!this.userId || !this.sandboxId) {
      throw new Error('Instance not provisioned');
    }

    const flyConfig = this.getFlyConfig();

    // Ensure a volume exists
    await this.ensureVolume(flyConfig, 'start');

    // If status is 'running', verify the machine is actually alive.
    // Check BEFORE building env vars — buildUserEnvVars calls ensureEnvKey
    // which writes to the Fly secrets API and could fail on transient errors.
    if (this.status === 'running' && this.flyMachineId) {
      try {
        const machine = await fly.getMachine(flyConfig, this.flyMachineId);
        if (machine.state === 'started') {
          await this.reconcileMachineMount(flyConfig, machine, 'start');
          console.log('[DO] Machine already running, mount verified');
          return;
        }
        console.log('[DO] Status is running but machine state is:', machine.state, '-- restarting');
      } catch (err) {
        console.log('[DO] Failed to get machine state, will recreate:', err);
      }
    }

    const { envVars, minSecretsVersion } = await this.buildUserEnvVars();
    const guest = guestFromSize(this.machineSize);
    const imageTag = this.env.FLY_IMAGE_TAG ?? 'latest';
    const identity = { userId: this.userId, sandboxId: this.sandboxId };
    const machineConfig = buildMachineConfig(
      this.getRegistryApp(),
      imageTag,
      envVars,
      guest,
      this.flyVolumeId,
      identity
    );

    if (this.flyMachineId) {
      await this.startExistingMachine(flyConfig, machineConfig, minSecretsVersion);
    } else {
      await this.createNewMachine(flyConfig, machineConfig, minSecretsVersion);
    }

    // Update state
    this.status = 'running';
    this.lastStartedAt = Date.now();
    this.healthCheckFailCount = 0;
    await this.ctx.storage.put(
      storageUpdate({
        status: 'running',
        lastStartedAt: this.lastStartedAt,
        healthCheckFailCount: 0,
        flyMachineId: this.flyMachineId,
      })
    );

    await this.scheduleAlarm();
  }

  /**
   * Stop the Fly Machine.
   */
  async stop(): Promise<void> {
    await this.loadState();

    if (!this.userId || !this.sandboxId) {
      throw new Error('Instance not provisioned');
    }
    if (
      this.status === 'stopped' ||
      this.status === 'provisioned' ||
      this.status === 'destroying'
    ) {
      console.log('[DO] Instance not running (status:', this.status, '), no-op');
      return;
    }

    if (this.flyMachineId) {
      const flyConfig = this.getFlyConfig();
      try {
        await fly.stopMachineAndWait(flyConfig, this.flyMachineId);
      } catch (err) {
        if (!fly.isFlyNotFound(err)) {
          // Real error — don't write 'stopped' when we don't know the actual state
          throw err;
        }
        // 404 = machine already gone, safe to mark stopped
        console.log('[DO] Machine already gone (404), marking stopped');
      }
    }

    this.status = 'stopped';
    this.lastStoppedAt = Date.now();
    await this.ctx.storage.put(
      storageUpdate({
        status: 'stopped',
        lastStoppedAt: this.lastStoppedAt,
      })
    );

    // Keep alarm running for idle reconciliation
    await this.scheduleAlarm();
  }

  /**
   * Two-phase destroy.
   *
   * 1. Persist pendingDestroy IDs + status='destroying'
   * 2. Attempt Fly deletions
   * 3. Only deleteAll() when BOTH are confirmed deleted
   * 4. If either fails, alarm retries cleanup
   */
  async destroy(): Promise<void> {
    await this.loadState();

    if (!this.userId) {
      throw new Error('Instance not provisioned');
    }

    // Phase 1: Persist intent before attempting any Fly operations
    this.pendingDestroyMachineId = this.flyMachineId;
    this.pendingDestroyVolumeId = this.flyVolumeId;
    this.status = 'destroying';

    await this.ctx.storage.put(
      storageUpdate({
        status: 'destroying',
        pendingDestroyMachineId: this.pendingDestroyMachineId,
        pendingDestroyVolumeId: this.pendingDestroyVolumeId,
      })
    );

    // Phase 2: Attempt Fly deletions
    const flyConfig = this.getFlyConfig();
    await this.tryDeleteMachine(flyConfig, 'destroy');
    await this.tryDeleteVolume(flyConfig, 'destroy');

    // Phase 3: Finalize if both cleared, otherwise alarm will retry
    const finalized = await this.finalizeDestroyIfComplete();
    if (!finalized) {
      console.warn(
        '[DO] Destroy incomplete, alarm will retry. pending machine:',
        this.pendingDestroyMachineId,
        'volume:',
        this.pendingDestroyVolumeId
      );
      await this.scheduleAlarm();
    }
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
  }> {
    await this.loadState();

    // Fire-and-forget live check: when DO thinks the machine is running, verify
    // with Fly in the background. Updates in-memory state for the *next* poll.
    // This keeps getStatus() latency consistently low (~0ms) instead of blocking
    // on a Fly API round-trip (~1-5s) every throttle window.
    if (
      this.status === 'running' &&
      this.flyMachineId &&
      (this.lastLiveCheckAt === null || Date.now() - this.lastLiveCheckAt >= LIVE_CHECK_THROTTLE_MS)
    ) {
      this.lastLiveCheckAt = Date.now();
      this.ctx.waitUntil(this.syncStatusFromLiveCheck());
    }

    return {
      userId: this.userId,
      sandboxId: this.sandboxId,
      status: this.status,
      provisionedAt: this.provisionedAt,
      lastStartedAt: this.lastStartedAt,
      lastStoppedAt: this.lastStoppedAt,
      envVarCount: this.envVars ? Object.keys(this.envVars).length : 0,
      secretCount: this.encryptedSecrets ? Object.keys(this.encryptedSecrets).length : 0,
      channelCount: this.channels ? Object.values(this.channels).filter(Boolean).length : 0,
      flyAppName: this.flyAppName,
      flyMachineId: this.flyMachineId,
      flyVolumeId: this.flyVolumeId,
      flyRegion: this.flyRegion,
    };
  }

  async getConfig(): Promise<InstanceConfig> {
    await this.loadState();

    return {
      envVars: this.envVars ?? undefined,
      encryptedSecrets: this.encryptedSecrets ?? undefined,
      kilocodeApiKey: this.kilocodeApiKey ?? undefined,
      kilocodeApiKeyExpiresAt: this.kilocodeApiKeyExpiresAt ?? undefined,
      kilocodeDefaultModel: this.kilocodeDefaultModel ?? undefined,
      kilocodeModels: this.kilocodeModels ?? undefined,
      channels: this.channels ?? undefined,
      machineSize: this.machineSize ?? undefined,
    };
  }

  // ========================================================================
  // User-facing operations
  // ========================================================================

  async restartGateway(): Promise<{ success: boolean; error?: string }> {
    await this.loadState();

    if (this.status !== 'running' || !this.flyMachineId) {
      return { success: false, error: 'Instance is not running' };
    }

    try {
      const flyConfig = this.getFlyConfig();
      await fly.stopMachineAndWait(flyConfig, this.flyMachineId);

      const { envVars, minSecretsVersion } = await this.buildUserEnvVars();
      const guest = guestFromSize(this.machineSize);
      const imageTag = this.env.FLY_IMAGE_TAG ?? 'latest';
      const identity = { userId: this.userId ?? '', sandboxId: this.sandboxId ?? '' };
      const machineConfig = buildMachineConfig(
        this.getRegistryApp(),
        imageTag,
        envVars,
        guest,
        this.flyVolumeId,
        identity
      );

      await fly.updateMachine(flyConfig, this.flyMachineId, machineConfig, { minSecretsVersion });
      await fly.waitForState(flyConfig, this.flyMachineId, 'started', STARTUP_TIMEOUT_SECONDS);

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

    // No instance provisioned — nothing to reconcile
    if (!this.userId || !this.status) return;

    try {
      await this.reconcileWithFly('alarm');
    } catch (err) {
      console.error('[alarm] reconcileWithFly failed:', err);
    }

    // Reschedule unless fully destroyed (status becomes null after deleteAll)
    if (this.status) {
      await this.scheduleAlarm();
    }
  }

  // ========================================================================
  // Reconciliation
  // ========================================================================

  /**
   * Check actual Fly state against DO state and fix drift.
   * Destroying instances only retry pending deletes; never recreate resources.
   */
  private async reconcileWithFly(reason: string): Promise<void> {
    const flyConfig = this.getFlyConfig();

    // Destroying: only retry pending deletes, never recreate anything
    if (this.status === 'destroying') {
      await this.retryPendingDestroy(flyConfig, reason);
      return;
    }

    // Machine first: metadata recovery can recover both machine AND volume IDs.
    // Volume second: only creates a new volume if still missing after machine recovery.
    await this.reconcileMachine(flyConfig, reason);
    await this.reconcileVolume(flyConfig, reason);
  }

  // ---- Volume reconciliation ----

  private async reconcileVolume(flyConfig: FlyClientConfig, reason: string): Promise<void> {
    if (!this.flyVolumeId) {
      await this.ensureVolume(flyConfig, reason);
      return;
    }

    // Verify volume still exists on Fly
    try {
      await fly.getVolume(flyConfig, this.flyVolumeId);
    } catch (err) {
      if (fly.isFlyNotFound(err)) {
        reconcileLog(reason, 'replace_lost_volume', {
          data_loss: true,
          old_volume_id: this.flyVolumeId,
        });
        this.flyVolumeId = null;
        await this.ctx.storage.put(storageUpdate({ flyVolumeId: null }));
        await this.ensureVolume(flyConfig, reason);
      }
      // Other errors: leave as-is, retry next alarm
    }
  }

  // ---- Machine reconciliation ----

  private async reconcileMachine(flyConfig: FlyClientConfig, reason: string): Promise<void> {
    // If we don't have a machine ID, attempt metadata-based recovery
    if (!this.flyMachineId) {
      await this.attemptMetadataRecovery(flyConfig, reason);
      return;
    }

    try {
      const machine = await fly.getMachine(flyConfig, this.flyMachineId);
      await this.syncStatusWithFly(machine.state, reason);
      await this.reconcileMachineMount(flyConfig, machine, reason);
    } catch (err) {
      if (fly.isFlyNotFound(err)) {
        await this.handleMachineGone(reason);
      }
      // Other errors: log and retry next alarm
    }
  }

  /**
   * Attempt to recover machine (and optionally volume) from Fly metadata.
   * Only runs when flyMachineId is null. Respects a cooldown to avoid
   * hammering listMachines when there's genuinely nothing to recover.
   */
  private async attemptMetadataRecovery(flyConfig: FlyClientConfig, reason: string): Promise<void> {
    if (!this.userId) return;

    // Cooldown: skip if we tried recently
    if (
      this.lastMetadataRecoveryAt &&
      Date.now() - this.lastMetadataRecoveryAt < METADATA_RECOVERY_COOLDOWN_MS
    ) {
      return;
    }

    // Record attempt time regardless of outcome
    this.lastMetadataRecoveryAt = Date.now();
    await this.ctx.storage.put(
      storageUpdate({ lastMetadataRecoveryAt: this.lastMetadataRecoveryAt })
    );

    try {
      const machines = await fly.listMachines(flyConfig, {
        [METADATA_KEY_USER_ID]: this.userId,
      });

      if (machines.length > 1) {
        reconcileLog(reason, 'multiple_machines_found', {
          user_id: this.userId,
          count: machines.length,
          machine_ids: machines.map(m => m.id),
        });
      }

      const candidate = selectRecoveryCandidate(machines);
      if (!candidate) return;

      reconcileLog(reason, 'recover_machine_from_metadata', {
        machine_id: candidate.id,
        state: candidate.state,
        region: candidate.region,
      });

      // Recover machine ID
      this.flyMachineId = candidate.id;
      this.flyRegion = candidate.region;

      const updates: Partial<PersistedState> = {
        flyMachineId: candidate.id,
        flyRegion: candidate.region,
      };

      // Sync DO status to Fly reality
      if (candidate.state === 'started') {
        this.status = 'running';
        updates.status = 'running';
      } else if (candidate.state === 'stopped' || candidate.state === 'created') {
        this.status = 'stopped';
        updates.status = 'stopped';
      }

      // Recover volume ID from the machine's mount config
      if (!this.flyVolumeId) {
        const recoveredVolumeId = volumeIdFromMachine(candidate);
        if (recoveredVolumeId) {
          // Verify the volume actually exists before trusting it
          try {
            await fly.getVolume(flyConfig, recoveredVolumeId);
            this.flyVolumeId = recoveredVolumeId;
            updates.flyVolumeId = recoveredVolumeId;
            reconcileLog(reason, 'recover_volume_from_mount', {
              volume_id: recoveredVolumeId,
              machine_id: candidate.id,
            });
          } catch (err) {
            if (fly.isFlyNotFound(err)) {
              reconcileLog(reason, 'recovered_volume_missing', {
                volume_id: recoveredVolumeId,
              });
            }
            // Volume gone or error — ensureVolume will handle on next cycle
          }
        }
      }

      await this.ctx.storage.put(storageUpdate(updates));
    } catch (err) {
      console.error('[reconcile] metadata recovery failed:', err);
    }
  }

  /**
   * Sync DO status to match Fly machine state.
   * Uses health-check fail counting for running → stopped transitions.
   */
  private async syncStatusWithFly(flyState: string, reason: string): Promise<void> {
    if (flyState === 'started' && this.status !== 'running') {
      reconcileLog(reason, 'sync_status', { old_state: this.status, new_state: 'running' });
      this.status = 'running';
      this.healthCheckFailCount = 0;
      await this.ctx.storage.put(storageUpdate({ status: 'running', healthCheckFailCount: 0 }));
      return;
    }

    if (flyState === 'started' && this.status === 'running') {
      // Healthy — reset fail count if needed
      if (this.healthCheckFailCount > 0) {
        this.healthCheckFailCount = 0;
        await this.ctx.storage.put(storageUpdate({ healthCheckFailCount: 0 }));
      }
      return;
    }

    if ((flyState === 'stopped' || flyState === 'created') && this.status === 'running') {
      this.healthCheckFailCount++;
      await this.ctx.storage.put(
        storageUpdate({ healthCheckFailCount: this.healthCheckFailCount })
      );

      if (this.healthCheckFailCount >= SELF_HEAL_THRESHOLD) {
        reconcileLog(reason, 'mark_stopped', {
          old_state: 'running',
          new_state: 'stopped',
          fail_count: this.healthCheckFailCount,
        });
        this.status = 'stopped';
        this.lastStoppedAt = Date.now();
        this.healthCheckFailCount = 0;
        await this.ctx.storage.put(
          storageUpdate({
            status: 'stopped',
            lastStoppedAt: this.lastStoppedAt,
            healthCheckFailCount: 0,
          })
        );
      }
    }
  }

  /**
   * Lightweight live check called from getStatus() via waitUntil (fire-and-forget).
   * Updates in-memory status only — the alarm loop owns persistence.
   * Silently falls back to cached state on transient errors.
   * lastLiveCheckAt is set by the caller before dispatching.
   */
  private async syncStatusFromLiveCheck(): Promise<void> {
    try {
      const flyConfig = this.getFlyConfig();
      const machine = await fly.getMachine(flyConfig, this.flyMachineId!);

      if (machine.state === 'started') {
        // Confirmed running — reset in-memory fail count
        this.healthCheckFailCount = 0;
        return;
      }

      if (TERMINAL_STOPPED_STATES.has(machine.state)) {
        console.log('[DO] Live check: Fly state is', machine.state, '— marking stopped in-memory');
        this.status = 'stopped';
      } else {
        // Transitional state — leave status as running, reset fail count
        this.healthCheckFailCount = 0;
      }
    } catch (err) {
      if (fly.isFlyNotFound(err)) {
        // Machine gone (404) — flip in-memory status to stopped
        console.log('[DO] Live check: machine 404 — marking stopped in-memory');
        this.status = 'stopped';
        return;
      }
      // Transient error — silently fall back to cached state
      console.warn('[DO] Live check failed, using cached status:', err);
    }
  }

  /**
   * Check that a running machine has the correct volume mount.
   * If the mount is wrong/missing, repair via stop → update → start.
   */
  private async reconcileMachineMount(
    flyConfig: FlyClientConfig,
    machine: { state: string; config: FlyMachineConfig },
    reason: string
  ): Promise<void> {
    if (machine.state !== 'started' || !this.flyVolumeId) return;

    const mounts = machine.config?.mounts ?? [];
    const hasCorrectMount = mounts.some(m => m.volume === this.flyVolumeId && m.path === '/root');

    if (hasCorrectMount) return;

    reconcileLog(reason, 'repair_mount', {
      machine_id: this.flyMachineId,
      volume_id: this.flyVolumeId,
    });

    if (!this.flyMachineId) return;

    await fly.stopMachineAndWait(flyConfig, this.flyMachineId);
    await fly.updateMachine(flyConfig, this.flyMachineId, {
      ...machine.config,
      mounts: [{ volume: this.flyVolumeId, path: '/root' }],
    });
    await fly.waitForState(flyConfig, this.flyMachineId, 'started', STARTUP_TIMEOUT_SECONDS);
  }

  /**
   * Machine confirmed gone from Fly (404). Clear the ID and mark stopped.
   */
  private async handleMachineGone(reason: string): Promise<void> {
    reconcileLog(reason, 'clear_stale_machine', {
      old_state: this.status,
      new_state: 'stopped',
      machine_id: this.flyMachineId,
    });
    this.flyMachineId = null;
    this.status = 'stopped';
    this.lastStoppedAt = Date.now();
    this.healthCheckFailCount = 0;
    await this.ctx.storage.put(
      storageUpdate({
        flyMachineId: null,
        status: 'stopped',
        lastStoppedAt: this.lastStoppedAt,
        healthCheckFailCount: 0,
      })
    );
  }

  // ========================================================================
  // Two-phase destroy helpers
  // ========================================================================

  /**
   * Retry deleting pending Fly resources. Called from alarm for destroying instances.
   */
  private async retryPendingDestroy(flyConfig: FlyClientConfig, reason: string): Promise<void> {
    await this.tryDeleteMachine(flyConfig, reason);
    await this.tryDeleteVolume(flyConfig, reason);
    await this.finalizeDestroyIfComplete();
  }

  /**
   * Attempt to delete the pending machine. Clears the ID on success or 404.
   */
  private async tryDeleteMachine(flyConfig: FlyClientConfig, reason: string): Promise<void> {
    if (!this.pendingDestroyMachineId) return;

    try {
      await fly.destroyMachine(flyConfig, this.pendingDestroyMachineId);
      reconcileLog(reason, 'destroy_machine_ok', {
        machine_id: this.pendingDestroyMachineId,
      });
    } catch (err) {
      if (fly.isFlyNotFound(err)) {
        reconcileLog(reason, 'destroy_machine_already_gone', {
          machine_id: this.pendingDestroyMachineId,
        });
      } else {
        reconcileLog(reason, 'destroy_machine_failed', {
          machine_id: this.pendingDestroyMachineId,
          error: err instanceof Error ? err.message : String(err),
        });
        return; // Leave pending, retry next alarm
      }
    }

    // Success or 404: clear
    this.pendingDestroyMachineId = null;
    this.flyMachineId = null;
    await this.ctx.storage.put(
      storageUpdate({ pendingDestroyMachineId: null, flyMachineId: null })
    );
  }

  /**
   * Attempt to delete the pending volume. Clears the ID on success or 404.
   */
  private async tryDeleteVolume(flyConfig: FlyClientConfig, reason: string): Promise<void> {
    if (!this.pendingDestroyVolumeId) return;

    try {
      await fly.deleteVolume(flyConfig, this.pendingDestroyVolumeId);
      reconcileLog(reason, 'destroy_volume_ok', {
        volume_id: this.pendingDestroyVolumeId,
      });
    } catch (err) {
      if (fly.isFlyNotFound(err)) {
        reconcileLog(reason, 'destroy_volume_already_gone', {
          volume_id: this.pendingDestroyVolumeId,
        });
      } else {
        reconcileLog(reason, 'destroy_volume_failed', {
          volume_id: this.pendingDestroyVolumeId,
          error: err instanceof Error ? err.message : String(err),
        });
        return; // Leave pending, retry next alarm
      }
    }

    // Success or 404: clear
    this.pendingDestroyVolumeId = null;
    this.flyVolumeId = null;
    await this.ctx.storage.put(storageUpdate({ pendingDestroyVolumeId: null, flyVolumeId: null }));
  }

  /**
   * If both pending IDs are cleared, atomically wipe all DO state.
   * Returns true if finalized, false if still pending.
   */
  private async finalizeDestroyIfComplete(): Promise<boolean> {
    if (this.pendingDestroyMachineId || this.pendingDestroyVolumeId) {
      return false;
    }

    reconcileLog('finalize', 'destroy_complete', {
      user_id: this.userId,
      sandbox_id: this.sandboxId,
    });

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();

    // Reset all cached state
    this.userId = null;
    this.sandboxId = null;
    this.status = null;
    this.envVars = null;
    this.encryptedSecrets = null;
    this.kilocodeApiKey = null;
    this.kilocodeApiKeyExpiresAt = null;
    this.kilocodeDefaultModel = null;
    this.kilocodeModels = null;
    this.channels = null;
    this.provisionedAt = null;
    this.lastStartedAt = null;
    this.lastStoppedAt = null;
    this.flyAppName = null;
    this.flyMachineId = null;
    this.flyVolumeId = null;
    this.flyRegion = null;
    this.machineSize = null;
    this.healthCheckFailCount = 0;
    this.pendingDestroyMachineId = null;
    this.pendingDestroyVolumeId = null;
    this.lastMetadataRecoveryAt = null;
    this.loaded = false;

    return true;
  }

  // ========================================================================
  // Infrastructure helpers
  // ========================================================================

  /**
   * Shared Docker image registry app name.
   * Images are pushed to this app's registry and referenced by all per-user apps.
   */
  private getRegistryApp(): string {
    return this.env.FLY_REGISTRY_APP ?? this.env.FLY_APP_NAME ?? 'kiloclaw-machines';
  }

  private getFlyConfig(): FlyClientConfig {
    if (!this.env.FLY_API_TOKEN) {
      throw new Error('FLY_API_TOKEN is not configured');
    }
    // Per-user app name, with legacy fallback for existing instances
    const appName = this.flyAppName ?? this.env.FLY_APP_NAME;
    if (!appName) {
      throw new Error('No Fly app name: flyAppName not set and FLY_APP_NAME not configured');
    }
    return {
      apiToken: this.env.FLY_API_TOKEN,
      appName,
    };
  }

  private async scheduleAlarm(): Promise<void> {
    if (!this.status) return;
    await this.ctx.storage.setAlarm(nextAlarmTime(this.status));
  }

  /**
   * Ensure a Fly Volume exists. Creates one if flyVolumeId is null.
   * Persists the new volume ID immediately.
   */
  private async ensureVolume(flyConfig: FlyClientConfig, reason: string): Promise<void> {
    if (this.flyVolumeId) return;
    if (!this.sandboxId) return;

    const region = this.flyRegion ?? this.env.FLY_REGION ?? 'us,eu';
    const volume = await fly.createVolume(flyConfig, {
      name: volumeNameFromSandboxId(this.sandboxId),
      region,
      size_gb: DEFAULT_VOLUME_SIZE_GB,
    });

    this.flyVolumeId = volume.id;
    this.flyRegion = volume.region;
    await this.ctx.storage.put(storageUpdate({ flyVolumeId: volume.id, flyRegion: volume.region }));

    reconcileLog(reason, 'create_volume', {
      volume_id: volume.id,
      region: volume.region,
    });
  }

  /**
   * Try to start an existing machine. Falls back to creating a new one if
   * the existing machine is unusable (destroyed, corrupted).
   */
  private async startExistingMachine(
    flyConfig: FlyClientConfig,
    machineConfig: FlyMachineConfig,
    minSecretsVersion?: number
  ): Promise<void> {
    if (!this.flyMachineId) return;

    try {
      const machine = await fly.getMachine(flyConfig, this.flyMachineId);
      if (machine.state === 'stopped' || machine.state === 'created') {
        await fly.updateMachine(flyConfig, this.flyMachineId, machineConfig, { minSecretsVersion });
        await fly.waitForState(flyConfig, this.flyMachineId, 'started', STARTUP_TIMEOUT_SECONDS);
        console.log('[DO] Machine updated and started:', this.flyMachineId);
      } else if (machine.state === 'started') {
        console.log('[DO] Machine already started');
      } else {
        await fly.waitForState(flyConfig, this.flyMachineId, 'started', STARTUP_TIMEOUT_SECONDS);
      }
    } catch (err) {
      if (fly.isFlyNotFound(err)) {
        // Machine confirmed gone — safe to recreate
        console.log('[DO] Machine gone (404), creating new one');
        this.flyMachineId = null;
        await this.ctx.storage.put(storageUpdate({ flyMachineId: null }));
        await this.createNewMachine(flyConfig, machineConfig, minSecretsVersion);
      } else {
        // Transient error (timeout, 500, network) — don't create a duplicate.
        // Let the caller surface the error; reconciliation will repair later.
        console.error('[DO] Transient error starting existing machine:', err);
        throw err;
      }
    }
  }

  private async createNewMachine(
    flyConfig: FlyClientConfig,
    machineConfig: FlyMachineConfig,
    minSecretsVersion?: number
  ): Promise<void> {
    const machine = await fly.createMachine(flyConfig, machineConfig, {
      name: this.sandboxId ?? undefined,
      region: this.flyRegion ?? this.env.FLY_REGION ?? undefined,
      minSecretsVersion,
    });
    this.flyMachineId = machine.id;

    // Persist immediately so the ID survives even if waitForState fails.
    // The reconciliation alarm will detect and repair a machine stuck in
    // 'created'/'starting' state on the next cycle.
    await this.ctx.storage.put(storageUpdate({ flyMachineId: machine.id }));
    console.log('[DO] Created Fly Machine:', machine.id, 'region:', machine.region);

    await fly.waitForState(flyConfig, machine.id, 'started', STARTUP_TIMEOUT_SECONDS);
    console.log('[DO] Machine started');
  }

  /**
   * Restore DO state from Postgres backup if SQLite was wiped.
   */
  private async restoreFromPostgres(userId: string): Promise<void> {
    const connectionString = this.env.HYPERDRIVE?.connectionString;
    if (!connectionString) {
      console.warn('[DO] HYPERDRIVE not configured, cannot restore from Postgres');
      return;
    }

    try {
      const db = createDatabaseConnection(connectionString);
      const store = new InstanceStore(db);
      const instance = await store.getActiveInstance(userId);

      if (!instance) {
        console.warn('[DO] No active instance found in Postgres for', userId);
        return;
      }

      console.log('[DO] Restoring state from Postgres backup for', userId);

      const envVars: Record<string, string> | null = null;
      const encryptedSecrets: Record<string, EncryptedEnvelope> | null = null;
      const channels = null;

      // Recover flyAppName from the App DO (which persists independently).
      // If the user has a per-user app, the App DO still knows about it.
      // If both DOs were wiped, derive the app name deterministically so
      // restore remains self-healing (the Fly app still exists on Fly's side).
      // For legacy users who never had a per-user app, derivation produces a
      // name that won't exist on Fly, but getFlyConfig() falls back to
      // env.FLY_APP_NAME in that case since the derived app won't route.
      const appStub = this.env.KILOCLAW_APP.get(this.env.KILOCLAW_APP.idFromName(userId));
      const prefix = this.env.WORKER_ENV === 'development' ? 'dev' : undefined;
      const recoveredAppName =
        (await appStub.getAppName()) ?? (await appNameFromUserId(userId, prefix));

      await this.ctx.storage.put(
        storageUpdate({
          userId,
          sandboxId: instance.sandboxId,
          status: 'provisioned',
          envVars,
          encryptedSecrets,
          channels,
          provisionedAt: Date.now(),
          lastStartedAt: null,
          lastStoppedAt: null,
          flyAppName: recoveredAppName,
          flyMachineId: null,
          flyVolumeId: null,
          flyRegion: null,
          machineSize: null,
          healthCheckFailCount: 0,
          pendingDestroyMachineId: null,
          pendingDestroyVolumeId: null,
        })
      );

      this.userId = userId;
      this.sandboxId = instance.sandboxId;
      this.status = 'provisioned';
      this.envVars = envVars;
      this.encryptedSecrets = encryptedSecrets;
      this.channels = channels;
      this.provisionedAt = Date.now();
      this.lastStartedAt = null;
      this.lastStoppedAt = null;
      this.flyAppName = recoveredAppName;
      this.flyMachineId = null;
      this.flyVolumeId = null;
      this.flyRegion = null;
      this.machineSize = null;
      this.healthCheckFailCount = 0;
      this.pendingDestroyMachineId = null;
      this.pendingDestroyVolumeId = null;
      this.lastMetadataRecoveryAt = null;
      this.loaded = true;

      console.log('[DO] Restored from Postgres: sandboxId =', instance.sandboxId);

      // Attempt to recover machine/volume IDs via Fly metadata.
      // The Postgres backup doesn't store Fly IDs, but if the machine
      // was created with metadata tags, we can find it.
      try {
        const flyConfig = this.getFlyConfig();
        await this.attemptMetadataRecovery(flyConfig, 'postgres_restore');
      } catch (err) {
        console.warn('[DO] Metadata recovery after Postgres restore failed:', err);
      }
    } catch (err) {
      console.error('[DO] Postgres restore failed:', err);
    }
  }

  private async buildUserEnvVars(): Promise<{
    envVars: Record<string, string>;
    minSecretsVersion: number;
  }> {
    if (!this.sandboxId || !this.env.GATEWAY_TOKEN_SECRET) {
      throw new Error('Cannot build env vars: sandboxId or GATEWAY_TOKEN_SECRET missing');
    }
    if (!this.userId) {
      throw new Error('Cannot build env vars: userId missing');
    }

    const { env: plainEnv, sensitive } = await buildEnvVars(
      this.env,
      this.sandboxId,
      this.env.GATEWAY_TOKEN_SECRET,
      {
        envVars: this.envVars ?? undefined,
        encryptedSecrets: this.encryptedSecrets ?? undefined,
        kilocodeApiKey: this.kilocodeApiKey ?? undefined,
        kilocodeDefaultModel: this.kilocodeDefaultModel ?? undefined,
        kilocodeModels: this.kilocodeModels ?? undefined,
        channels: this.channels ?? undefined,
      }
    );

    // Get the env encryption key from the App DO, creating it if needed (legacy migration).
    // Also returns the Fly secrets version for min_secrets_version on machine create/update.
    const appStub = this.env.KILOCLAW_APP.get(this.env.KILOCLAW_APP.idFromName(this.userId));
    const { key: envKey, secretsVersion } = await appStub.ensureEnvKey(this.userId);

    // Encrypt sensitive values and prefix their names with KILOCLAW_ENC_
    const result: Record<string, string> = { ...plainEnv };
    for (const [name, value] of Object.entries(sensitive)) {
      result[`${ENCRYPTED_ENV_PREFIX}${name}`] = encryptEnvValue(envKey, value);
    }

    return { envVars: result, minSecretsVersion: secretsVersion };
  }
}
