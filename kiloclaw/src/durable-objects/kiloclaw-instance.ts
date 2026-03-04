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
import { deriveGatewayToken } from '../auth/gateway-token';
import { getWorkerDb, getActiveInstance, markInstanceDestroyed } from '../db';
import { buildEnvVars } from '../gateway/env';
import {
  PersistedStateSchema,
  type InstanceConfig,
  type PersistedState,
  type EncryptedEnvelope,
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
  DEFAULT_FLY_REGION,
  LIVE_CHECK_THROTTLE_MS,
  HEALTH_PROBE_TIMEOUT_SECONDS,
  HEALTH_PROBE_INTERVAL_MS,
  STALE_PROVISION_THRESHOLD_MS,
  OPENCLAW_BUILTIN_DEFAULT_MODEL,
} from '../config';
import type { FlyClientConfig } from '../fly/client';
import type {
  FlyMachineConfig,
  FlyMachine,
  FlyMachineState,
  FlyVolumeSnapshot,
} from '../fly/types';
import * as fly from '../fly/client';
import { appNameFromUserId } from '../fly/apps';
import { ENCRYPTED_ENV_PREFIX, encryptEnvValue } from '../utils/env-encryption';
import { z, type ZodType } from 'zod';
import { resolveLatestVersion, resolveVersionByTag } from '../lib/image-version';
import { lookupCatalogVersion } from '../lib/catalog-registration';
import { ImageVariantSchema } from '../schemas/image-version';

type InstanceStatus = PersistedState['status'];

type DestroyResult = {
  finalized: boolean;
  destroyedUserId: string | null;
  destroyedSandboxId: string | null;
};

type GatewayProcessStatus = {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'shutting_down';
  pid: number | null;
  uptime: number;
  restarts: number;
  lastExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
    at: string;
  } | null;
};

const GatewayProcessStatusSchema: ZodType<GatewayProcessStatus> = z.object({
  state: z.enum(['stopped', 'starting', 'running', 'stopping', 'crashed', 'shutting_down']),
  pid: z.number().int().nullable(),
  uptime: z.number(),
  restarts: z.number().int(),
  lastExit: z
    .object({
      code: z.number().int().nullable(),
      signal: z
        .custom<NodeJS.Signals>((value): value is NodeJS.Signals => typeof value === 'string')
        .nullable(),
      at: z.string(),
    })
    .nullable(),
});

const GatewayCommandResponseSchema = z.object({
  ok: z.boolean(),
});

const ConfigRestoreResponseSchema = z.object({
  ok: z.boolean(),
  signaled: z.boolean(),
});

const ControllerVersionResponseSchema = z.object({
  version: z.string(),
  commit: z.string(),
});

class GatewayControllerError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GatewayControllerError';
    this.status = status;
  }
}

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
export const METADATA_KEY_OPENCLAW_VERSION = 'kiloclaw_openclaw_version';
export const METADATA_KEY_IMAGE_VARIANT = 'kiloclaw_image_variant';

// ============================================================================
// Machine config builder
// ============================================================================

type MachineIdentity = {
  userId: string;
  sandboxId: string;
  openclawVersion: string | null;
  imageVariant: string | null;
};

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
    checks: {
      controller: {
        type: 'http',
        port: OPENCLAW_PORT,
        method: 'GET',
        path: '/_kilo/health',
        interval: '30s',
        timeout: '5s',
        grace_period: '120s',
      },
    },
    mounts: flyVolumeId ? [{ volume: flyVolumeId, path: '/root' }] : [],
    metadata: {
      [METADATA_KEY_USER_ID]: identity.userId,
      [METADATA_KEY_SANDBOX_ID]: identity.sandboxId,
      ...(identity.openclawVersion && {
        [METADATA_KEY_OPENCLAW_VERSION]: identity.openclawVersion,
      }),
      ...(identity.imageVariant && { [METADATA_KEY_IMAGE_VARIANT]: identity.imageVariant }),
    },
  };
}

function guestFromSize(machineSize: MachineSize | null): FlyMachineConfig['guest'] {
  if (!machineSize) return DEFAULT_MACHINE_GUEST;
  return {
    cpus: machineSize.cpus,
    memory_mb: machineSize.memory_mb,
    cpu_kind: machineSize.cpu_kind ?? 'shared',
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
// Region helpers
// ============================================================================

/** Split a comma-separated region string into an array. */
export function parseRegions(regionList: string): string[] {
  return regionList
    .split(',')
    .map(r => r.trim())
    .filter(Boolean);
}

/** Fisher-Yates shuffle (in-place). Returns the same array for chaining. */
export function shuffleRegions(regions: string[]): string[] {
  for (let i = regions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = regions[i];
    regions[i] = regions[j];
    regions[j] = tmp;
  }
  return regions;
}

/**
 * Move a failed region to the end of the list so we try other regions first.
 * E.g. deprioritizeRegion(['dfw', 'yyz', 'cdg'], 'dfw') → ['yyz', 'cdg', 'dfw']
 */
export function deprioritizeRegion(regions: string[], failedRegion: string | null): string[] {
  if (!failedRegion) return regions;
  const without = regions.filter(r => r !== failedRegion);
  return without.length < regions.length ? [...without, failedRegion] : regions;
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
const TERMINAL_STOPPED_STATES: ReadonlySet<FlyMachineState> = new Set([
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
  private pendingPostgresMarkOnFinalize = false;
  private lastMetadataRecoveryAt: number | null = null;
  private openclawVersion: string | null = null;
  private imageVariant: string | null = null;
  private trackedImageTag: string | null = null;
  private trackedImageDigest: string | null = null;

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
      this.pendingPostgresMarkOnFinalize = s.pendingPostgresMarkOnFinalize;
      this.lastMetadataRecoveryAt = s.lastMetadataRecoveryAt;
      this.openclawVersion = s.openclawVersion;
      this.imageVariant = s.imageVariant;
      this.trackedImageTag = s.trackedImageTag;
      this.trackedImageDigest = s.trackedImageDigest;
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

    // Create Fly Volume on first provision.
    // Walks the region list and passes a compute hint so Fly picks a host
    // with capacity for both the volume and the expected machine spec.
    if (isNew && !this.flyVolumeId) {
      const flyConfig = this.getFlyConfig();
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
      this.flyVolumeId = volume.id;
      this.flyRegion = volume.region;
      console.log('[DO] Created Fly Volume:', volume.id, 'region:', volume.region);
    }

    // Resolve the image version for this provision.
    // If the user has a pinned image tag, look it up in KV first (fast), then Postgres (authoritative).
    // If not pinned, resolve latest from KV.
    console.debug('[DO] provision: pinnedImageTag from config:', config.pinnedImageTag ?? 'none');
    if (config.pinnedImageTag) {
      // Try KV first (fast, but only has versions registered by the current worker)
      let pinned = await resolveVersionByTag(this.env.KV_CLAW_CACHE, config.pinnedImageTag);

      // Fall back to Postgres catalog (authoritative, has all synced versions)
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
            // Validate variant from Postgres catalog against known variants
            const variantParse = ImageVariantSchema.safeParse(catalogEntry.variant);
            if (!variantParse.success) {
              // Log error but treat as cache miss rather than failing provision
              console.error(
                '[DO] Invalid variant from Postgres catalog, skipping:',
                catalogEntry.variant,
                'for tag:',
                config.pinnedImageTag,
                'error:',
                variantParse.error.flatten()
              );
              // Continue without setting pinned - will fall through to error handling below
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
        this.openclawVersion = pinned.openclawVersion;
        this.imageVariant = pinned.variant;
        this.trackedImageTag = pinned.imageTag;
        this.trackedImageDigest = pinned.imageDigest;
        console.debug('[DO] Using pinned version:', pinned.openclawVersion, '→', pinned.imageTag);
      } else {
        // Pinned tag not found in KV or Postgres — use the tag directly but metadata is unknown.
        // Clear version metadata to avoid stale values from a previous provision.
        console.warn(
          '[DO] Pinned tag not found in KV or Postgres, using tag directly:',
          config.pinnedImageTag
        );
        this.openclawVersion = null;
        this.imageVariant = null;
        this.trackedImageTag = config.pinnedImageTag;
        this.trackedImageDigest = null;
      }
    } else {
      // No pin — resolve latest registered version.
      // If the registry isn't populated yet, fields stay null → fallback to FLY_IMAGE_TAG.
      const variant = 'default'; // hardcoded day 1; future: from config or provision request
      const latest = await resolveLatestVersion(this.env.KV_CLAW_CACHE, variant);
      if (latest) {
        this.openclawVersion = latest.openclawVersion;
        this.imageVariant = latest.variant;
        this.trackedImageTag = latest.imageTag;
        this.trackedImageDigest = latest.imageDigest;
      } else if (isNew) {
        this.openclawVersion = null;
        this.imageVariant = null;
        this.trackedImageTag = null;
        this.trackedImageDigest = null;
      }
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
      channels: config.channels ?? null,
      machineSize: config.machineSize ?? this.machineSize ?? null,
    } satisfies Partial<PersistedState>;

    const versionFields = {
      openclawVersion: this.openclawVersion,
      imageVariant: this.imageVariant,
      trackedImageTag: this.trackedImageTag,
      trackedImageDigest: this.trackedImageDigest,
    };

    const update = isNew
      ? storageUpdate({
          ...configFields,
          ...versionFields,
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
          pendingPostgresMarkOnFinalize: false,
        })
      : storageUpdate({ ...configFields, ...versionFields });

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
    this.channels = config.channels ?? null;
    this.machineSize = config.machineSize ?? this.machineSize ?? null;
    if (isNew) {
      this.provisionedAt = Date.now();
      this.lastStartedAt = null;
      this.lastStoppedAt = null;
      this.healthCheckFailCount = 0;
      this.pendingDestroyMachineId = null;
      this.pendingDestroyVolumeId = null;
      this.pendingPostgresMarkOnFinalize = false;
    }
    this.loaded = true;

    // Schedule reconciliation alarm for new instances
    if (isNew) {
      await this.scheduleAlarm();
    }

    // Auto-start machine after provision so users don't have to click Start
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

    if (Object.keys(pending).length > 0) {
      await this.ctx.storage.put(pending);
    }

    // Hot-patch the running machine's config file if the default model changed.
    // This avoids requiring a full machine restart — OpenClaw watches the config file.
    // When cleared (null), fall back to OpenClaw's built-in default.
    if (patch.kilocodeDefaultModel !== undefined) {
      const model = this.kilocodeDefaultModel ?? OPENCLAW_BUILTIN_DEFAULT_MODEL;
      await this.patchConfigOnMachine({
        agents: { defaults: { model: { primary: model } } },
      });
    }

    return {
      kilocodeApiKey: this.kilocodeApiKey,
      kilocodeApiKeyExpiresAt: this.kilocodeApiKeyExpiresAt,
      kilocodeDefaultModel: this.kilocodeDefaultModel,
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
        return { requests: cached.requests as typeof empty.requests };
      }
    }

    const flyConfig = this.getFlyConfig();

    const result = await fly.execCommand(
      flyConfig,
      flyMachineId,
      ['/usr/bin/env', 'HOME=/root', 'node', '/usr/local/bin/openclaw-pairing-list.js'],
      60
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
      const data = JSON.parse(result.stdout.trim()) as unknown;
      if (data && typeof data === 'object' && 'requests' in data && Array.isArray(data.requests)) {
        pairing = { requests: data.requests as typeof empty.requests };
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
      60
    );

    const success = result.exit_code === 0;

    if (success) {
      const cacheKey = this.pairingCacheKey();
      if (cacheKey) {
        await this.env.KV_CLAW_CACHE.delete(cacheKey);
      }
    }

    if (!success) {
      console.error('[DO] pairing approve failed:', result.stderr || result.stdout);
    }

    return {
      success,
      message: success ? 'Pairing approved' : 'Approval failed',
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Device pairing (Control UI / node device identity)
  // ──────────────────────────────────────────────────────────────────────

  /** KV cache key for device pairing requests, scoped to the specific machine. */
  private devicePairingCacheKey(): string | null {
    const { flyAppName, flyMachineId } = this;
    if (!flyAppName || !flyMachineId) return null;
    return `device-pairing:${flyAppName}:${flyMachineId}`;
  }

  private static DEVICE_PAIRING_CACHE_TTL_SECONDS = 120;

  /**
   * List pending device pairing requests via the openclaw-device-pairing-list.js
   * helper script on the machine.
   * Results are cached in KV for 2 minutes. Pass forceRefresh to bypass cache.
   * Requires the machine to be running.
   */
  async listDevicePairingRequests(forceRefresh = false): Promise<{
    requests: Array<{
      requestId: string;
      deviceId: string;
      role?: string;
      platform?: string;
      clientId?: string;
      ts?: number;
    }>;
  }> {
    await this.loadState();

    const { flyMachineId } = this;
    if (this.status !== 'running' || !flyMachineId) {
      return { requests: [] };
    }

    const cacheKey = this.devicePairingCacheKey();
    if (cacheKey && !forceRefresh) {
      const cached = await this.env.KV_CLAW_CACHE.get(cacheKey, 'json');
      if (
        cached &&
        typeof cached === 'object' &&
        'requests' in cached &&
        Array.isArray(cached.requests)
      ) {
        console.log(`[DO] device pairing list served from KV cache (key=${cacheKey})`);
        return { requests: cached.requests as typeof empty.requests };
      }
    }

    const flyConfig = this.getFlyConfig();

    const result = await fly.execCommand(
      flyConfig,
      flyMachineId,
      ['/usr/bin/env', 'HOME=/root', 'node', '/usr/local/bin/openclaw-device-pairing-list.js'],
      60
    );

    const empty = {
      requests: [] as Array<{
        requestId: string;
        deviceId: string;
        role?: string;
        platform?: string;
        clientId?: string;
        ts?: number;
      }>,
    };

    const logCtx = `sandboxId=${this.sandboxId} appId=${this.flyAppName}`;
    if (result.exit_code !== 0) {
      console.error(`[DO] device pairing list failed: ${result.stderr} ${logCtx}`);
      return empty;
    }

    let pairing = empty;
    try {
      const data = JSON.parse(result.stdout.trim()) as unknown;
      if (data && typeof data === 'object' && 'requests' in data && Array.isArray(data.requests)) {
        pairing = { requests: data.requests as typeof empty.requests };
      }
    } catch {
      console.error(`[DO] device pairing list parse error: ${result.stdout} ${logCtx}`);
    }

    if (cacheKey) {
      await this.env.KV_CLAW_CACHE.put(cacheKey, JSON.stringify(pairing), {
        expirationTtl: KiloClawInstance.DEVICE_PAIRING_CACHE_TTL_SECONDS,
      });
    }

    return pairing;
  }

  /**
   * Approve a pending device pairing request via `openclaw devices approve` on the machine.
   * Busts the device pairing KV cache on success.
   * Requires the machine to be running.
   */
  async approveDevicePairingRequest(
    requestId: string
  ): Promise<{ success: boolean; message: string }> {
    await this.loadState();

    const { flyMachineId } = this;
    if (this.status !== 'running' || !flyMachineId) {
      return { success: false, message: 'Instance is not running' };
    }

    const flyConfig = this.getFlyConfig();

    // Validate requestId as a UUID to prevent command injection
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
      return { success: false, message: 'Invalid request ID' };
    }

    const result = await fly.execCommand(
      flyConfig,
      flyMachineId,
      ['/usr/bin/env', 'HOME=/root', 'openclaw', 'devices', 'approve', requestId],
      60
    );

    const success = result.exit_code === 0;

    if (success) {
      const cacheKey = this.devicePairingCacheKey();
      if (cacheKey) {
        await this.env.KV_CLAW_CACHE.delete(cacheKey);
      }
    }

    if (!success) {
      console.error('[DO] device pairing approve failed:', result.stderr || result.stdout);
    }

    return {
      success,
      message: success ? 'Device pairing approved' : 'Approval failed',
    };
  }

  /**
   * Run `openclaw doctor --fix --non-interactive` on the machine and return the output.
   * Requires the machine to be running.
   */
  async runDoctor(): Promise<{ success: boolean; output: string }> {
    await this.loadState();

    const { flyMachineId } = this;
    if (this.status !== 'running' || !flyMachineId) {
      return { success: false, output: 'Instance is not running' };
    }

    const flyConfig = this.getFlyConfig();

    const result = await fly.execCommand(
      flyConfig,
      flyMachineId,
      ['/usr/bin/env', 'HOME=/root', 'openclaw', 'doctor', '--fix', '--non-interactive'],
      60
    );

    const output = result.stdout + (result.stderr ? '\n' + result.stderr : '');
    return { success: result.exit_code === 0, output };
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

    // When we have a volume but no machine, verify the volume's actual region
    // matches what we have cached. flyRegion can drift after DO restore, manual
    // intervention, or bugs. A mismatch would place the machine in the wrong
    // region, unable to attach the volume.
    if (this.flyVolumeId && !this.flyMachineId) {
      try {
        const volume = await fly.getVolume(flyConfig, this.flyVolumeId);
        if (volume.region !== this.flyRegion) {
          console.warn(
            '[DO] flyRegion drift detected:',
            this.flyRegion,
            '-> actual:',
            volume.region
          );
          this.flyRegion = volume.region;
          await this.ctx.storage.put(storageUpdate({ flyRegion: volume.region }));
        }
      } catch (err) {
        if (fly.isFlyNotFound(err)) {
          // Volume gone — clear it so ensureVolume creates a new one on next call
          console.warn('[DO] Volume not found during region check, clearing');
          this.flyVolumeId = null;
          this.flyRegion = null;
          await this.ctx.storage.put(storageUpdate({ flyVolumeId: null, flyRegion: null }));
          await this.ensureVolume(flyConfig, 'start');
        }
        // Other errors: proceed with cached region, createMachine will fail
        // and the error will surface to the caller
      }
    }

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
    const imageTag = this.resolveImageTag();
    console.log(
      '[DO] startGateway: deploying with imageTag:',
      imageTag,
      'trackedImageTag:',
      this.trackedImageTag,
      'openclawVersion:',
      this.openclawVersion
    );
    const identity = {
      userId: this.userId,
      sandboxId: this.sandboxId,
      openclawVersion: this.openclawVersion,
      imageVariant: this.imageVariant,
    };
    const machineConfig = buildMachineConfig(
      this.getRegistryApp(),
      imageTag,
      envVars,
      guest,
      this.flyVolumeId,
      identity
    );

    try {
      if (this.flyMachineId) {
        await this.startExistingMachine(flyConfig, machineConfig, minSecretsVersion);
      } else {
        await this.createNewMachine(flyConfig, machineConfig, minSecretsVersion);
      }
    } catch (err) {
      if (!fly.isFlyInsufficientResources(err)) throw err;

      // Capacity error (403/409/412): host or region has no room.
      // Replace the volume (fork if user data exists, fresh otherwise)
      // and retry machine creation once.
      // isFlyInsufficientResources guarantees err is FlyApiError
      const code = err instanceof fly.FlyApiError ? err.status : 0;
      console.error(
        `[DO] Insufficient resources (${code}) in ${this.flyRegion ?? 'unknown'}, replacing stranded volume`
      );
      await this.replaceStrandedVolume(flyConfig, `start_${code}_recovery`);

      // Rebuild machine config with new volume ID
      const retryConfig = buildMachineConfig(
        this.getRegistryApp(),
        imageTag,
        envVars,
        guest,
        this.flyVolumeId,
        identity
      );
      await this.createNewMachine(flyConfig, retryConfig, minSecretsVersion);
    }

    // Wait for the gateway process inside the container to be healthy
    if (this.flyMachineId) {
      await this.waitForHealthy(flyConfig.appName, this.flyMachineId);
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
   * 3. Finalize only after pending Fly deletes clear, and for stale auto-destroy
   *    also after Postgres mark-destroyed succeeds
   * 4. If either fails, alarm retries cleanup
   */
  async destroy(): Promise<DestroyResult> {
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
    if (!finalized.finalized) {
      console.warn(
        '[DO] Destroy incomplete, alarm will retry. pending machine:',
        this.pendingDestroyMachineId,
        'volume:',
        this.pendingDestroyVolumeId
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
      machineSize: this.machineSize,
      openclawVersion: this.openclawVersion,
      imageVariant: this.imageVariant,
      trackedImageTag: this.trackedImageTag,
      trackedImageDigest: this.trackedImageDigest,
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
      channels: this.channels ?? undefined,
      machineSize: this.machineSize ?? undefined,
    };
  }

  async listVolumeSnapshots(): Promise<FlyVolumeSnapshot[]> {
    await this.loadState();
    if (!this.flyVolumeId) return [];
    const flyConfig = this.getFlyConfig();
    return fly.listVolumeSnapshots(flyConfig, this.flyVolumeId);
  }

  private requireGatewayControllerContext(): {
    appName: string;
    machineId: string;
    sandboxId: string;
  } {
    if (!this.sandboxId) {
      throw new GatewayControllerError(404, 'Instance not provisioned');
    }
    if (!this.flyMachineId) {
      throw new GatewayControllerError(409, 'Instance has no machine ID');
    }

    const appName = this.flyAppName ?? this.env.FLY_APP_NAME;
    if (!appName) {
      throw new GatewayControllerError(503, 'No Fly app name for this instance');
    }

    return {
      appName,
      machineId: this.flyMachineId,
      sandboxId: this.sandboxId,
    };
  }

  private async callGatewayController<T>(
    path: string,
    method: 'GET' | 'POST',
    responseSchema: ZodType<T>,
    jsonBody?: unknown
  ): Promise<T> {
    const { appName, machineId, sandboxId } = this.requireGatewayControllerContext();

    if (!this.env.GATEWAY_TOKEN_SECRET) {
      throw new GatewayControllerError(503, 'GATEWAY_TOKEN_SECRET is not configured');
    }

    const gatewayToken = await deriveGatewayToken(sandboxId, this.env.GATEWAY_TOKEN_SECRET);
    const url = `https://${appName}.fly.dev${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${gatewayToken}`,
      Accept: 'application/json',
      'fly-force-instance-id': machineId,
    };
    if (jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GatewayControllerError(503, `Gateway controller request failed: ${message}`);
    }

    const rawBody = await response.text();
    let body: unknown = null;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = { error: rawBody };
      }
    }

    if (!response.ok) {
      const errorMessage =
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `Gateway controller request failed (${response.status})`;
      throw new GatewayControllerError(response.status, errorMessage);
    }

    const parsed = responseSchema.safeParse(body ?? {});
    if (!parsed.success) {
      console.warn(
        '[DO] Gateway controller returned invalid response payload',
        JSON.stringify({
          path,
          status: response.status,
          body: rawBody.slice(0, 1024),
          issues: parsed.error.issues.map(issue => ({
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message,
          })),
        })
      );
      throw new GatewayControllerError(
        502,
        `Gateway controller returned invalid response for ${path}`
      );
    }

    return parsed.data;
  }

  async getGatewayProcessStatus(): Promise<GatewayProcessStatus> {
    await this.loadState();
    return this.callGatewayController('/_kilo/gateway/status', 'GET', GatewayProcessStatusSchema);
  }

  async startGatewayProcess(): Promise<{ ok: boolean }> {
    await this.loadState();
    return this.callGatewayController('/_kilo/gateway/start', 'POST', GatewayCommandResponseSchema);
  }

  async stopGatewayProcess(): Promise<{ ok: boolean }> {
    await this.loadState();
    return this.callGatewayController('/_kilo/gateway/stop', 'POST', GatewayCommandResponseSchema);
  }

  async restartGatewayProcess(): Promise<{ ok: boolean }> {
    await this.loadState();
    return this.callGatewayController(
      '/_kilo/gateway/restart',
      'POST',
      GatewayCommandResponseSchema
    );
  }

  async restoreConfig(version: string): Promise<{ ok: boolean; signaled: boolean }> {
    await this.loadState();
    return this.callGatewayController(
      `/_kilo/config/restore/${encodeURIComponent(version)}`,
      'POST',
      ConfigRestoreResponseSchema
    );
  }

  /** Returns null if the controller is too old to have the /_kilo/version endpoint. */
  async getControllerVersion(): Promise<{ version: string; commit: string } | null> {
    await this.loadState();
    try {
      return await this.callGatewayController(
        '/_kilo/version',
        'GET',
        ControllerVersionResponseSchema
      );
    } catch (error) {
      // Controllers that predate the /_kilo/version route: the request falls
      // through to the catch-all proxy which returns 401 (REQUIRE_PROXY_TOKEN)
      // or forwards to the gateway which returns 404 for the unknown path.
      if (
        error instanceof GatewayControllerError &&
        (error.status === 404 || error.status === 401)
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Hot-patch the openclaw.json config on the running machine.
   * The gateway watches the config file and reloads on change.
   * Non-fatal: if the machine isn't running, the patch is silently skipped
   * (the next start will pick up the value from env vars anyway).
   */
  async patchConfigOnMachine(patch: Record<string, unknown>): Promise<void> {
    await this.loadState();
    if (this.status !== 'running' || !this.flyMachineId) return;
    try {
      await this.callGatewayController(
        '/_kilo/config/patch',
        'POST',
        GatewayCommandResponseSchema,
        patch
      );
    } catch (err) {
      // Non-fatal — the config will be applied on next machine start via env vars
      console.warn(
        '[DO] patchConfigOnMachine failed (non-fatal):',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ========================================================================
  // User-facing operations
  // ========================================================================

  async restartGateway(options?: {
    imageTag?: string;
  }): Promise<{ success: boolean; error?: string }> {
    await this.loadState();

    if (this.status !== 'running' || !this.flyMachineId) {
      return { success: false, error: 'Instance is not running' };
    }

    const action = options?.imageTag
      ? options.imageTag === 'latest'
        ? 'upgrade-to-latest'
        : `pin-to-tag:${options.imageTag}`
      : 'redeploy-same-image';
    console.log('[DO] restartGateway:', action, '| current trackedImageTag:', this.trackedImageTag);

    try {
      // If imageTag override requested, resolve and persist before restart
      if (options?.imageTag) {
        if (options.imageTag === 'latest') {
          const variant = 'default';
          const latest = await resolveLatestVersion(this.env.KV_CLAW_CACHE, variant);
          if (latest) {
            this.openclawVersion = latest.openclawVersion;
            this.imageVariant = latest.variant;
            this.trackedImageTag = latest.imageTag;
            this.trackedImageDigest = latest.imageDigest;
          }
          // If KV empty, fall through to existing resolveImageTag() fallback
        } else {
          // Custom tag: clear version metadata since we don't know what version this tag represents
          this.trackedImageTag = options.imageTag;
          this.openclawVersion = null;
          this.imageVariant = null;
          this.trackedImageDigest = null;
        }
        await this.ctx.storage.put(
          storageUpdate({
            openclawVersion: this.openclawVersion,
            imageVariant: this.imageVariant,
            trackedImageTag: this.trackedImageTag,
            trackedImageDigest: this.trackedImageDigest,
          })
        );
      }

      const flyConfig = this.getFlyConfig();

      // Backfill machineSize from live Fly machine config for legacy instances
      // before stopping, so the guest sent to updateMachine matches the actual
      // deployed size instead of the new default.
      if (this.machineSize === null && this.flyMachineId) {
        const machine = await fly.getMachine(flyConfig, this.flyMachineId);
        if (machine.config?.guest) {
          const { cpus, memory_mb, cpu_kind } = machine.config.guest;
          this.machineSize = { cpus, memory_mb, cpu_kind };
          await this.ctx.storage.put(storageUpdate({ machineSize: this.machineSize }));
        }
      }

      await fly.stopMachineAndWait(flyConfig, this.flyMachineId);

      const { envVars, minSecretsVersion } = await this.buildUserEnvVars();
      const guest = guestFromSize(this.machineSize);
      const imageTag = this.resolveImageTag();
      console.log('[DO] restartGateway: deploying with imageTag:', imageTag);
      const identity = {
        userId: this.userId ?? '',
        sandboxId: this.sandboxId ?? '',
        openclawVersion: this.openclawVersion,
        imageVariant: this.imageVariant,
      };
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
      await this.waitForHealthy(flyConfig.appName, this.flyMachineId);

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
    const machineReconciled = await this.reconcileMachine(flyConfig, reason);

    // Auto-destroy stale provisioned instances that never started.
    // Checked AFTER reconcileMachine so metadata recovery has a chance to
    // discover a live Fly machine before we decide the instance is abandoned.
    // Only proceeds when machine reconciliation was conclusive (not skipped
    // due to cooldown or failed due to a transient Fly API error).
    const staleProvisionAge = this.staleProvisionAgeMs();
    if (staleProvisionAge !== null && machineReconciled) {
      reconcileLog(reason, 'auto_destroy_stale_provision', {
        user_id: this.userId,
        provisioned_at: this.provisionedAt,
        age_hours: Math.round(staleProvisionAge / 3600000),
      });
      this.pendingPostgresMarkOnFinalize = true;
      await this.ctx.storage.put(storageUpdate({ pendingPostgresMarkOnFinalize: true }));
      await this.destroy();
      return;
    }

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

  /**
   * @returns true if machine state was conclusively determined (Fly API
   *   responded successfully), false if skipped or inconclusive (transient
   *   error, cooldown). Callers use this to gate destructive decisions
   *   like auto-destroy of stale provisions.
   */
  private async reconcileMachine(flyConfig: FlyClientConfig, reason: string): Promise<boolean> {
    // If we don't have a machine ID, attempt metadata-based recovery
    if (!this.flyMachineId) {
      return this.attemptMetadataRecovery(flyConfig, reason);
    }

    try {
      const machine = await fly.getMachine(flyConfig, this.flyMachineId);
      await this.syncStatusWithFly(machine.state, reason);
      await this.reconcileMachineMount(flyConfig, machine, reason);
      return true;
    } catch (err) {
      if (fly.isFlyNotFound(err)) {
        await this.handleMachineGone(reason);
        return true; // 404 is conclusive: machine is gone
      }
      // Other errors: inconclusive, retry next alarm
      return false;
    }
  }

  /**
   * Attempt to recover machine (and optionally volume) from Fly metadata.
   * Only runs when flyMachineId is null. Respects a cooldown to avoid
   * hammering listMachines when there's genuinely nothing to recover.
   *
   * @returns true if the Fly API responded conclusively (even if no machine
   *   was found), false if skipped (cooldown) or failed (transient error).
   */
  private async attemptMetadataRecovery(
    flyConfig: FlyClientConfig,
    reason: string
  ): Promise<boolean> {
    if (!this.userId) return false;

    // Cooldown: skip if we tried recently
    if (
      this.lastMetadataRecoveryAt &&
      Date.now() - this.lastMetadataRecoveryAt < METADATA_RECOVERY_COOLDOWN_MS
    ) {
      return false;
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
      if (!candidate) return true; // Conclusive: no machine exists on Fly

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
      return true; // Conclusive: machine recovered
    } catch (err) {
      console.error('[reconcile] metadata recovery failed:', err);
      return false; // Inconclusive: transient error
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
    if (!this.flyMachineId) return;

    try {
      const flyConfig = this.getFlyConfig();
      const machine = await fly.getMachine(flyConfig, this.flyMachineId);

      // Backfill machineSize from live Fly machine config for legacy instances
      if (this.machineSize === null && machine.config?.guest) {
        const { cpus, memory_mb, cpu_kind } = machine.config.guest;
        this.machineSize = { cpus, memory_mb, cpu_kind };
        await this.ctx.storage.put(storageUpdate({ machineSize: this.machineSize }));
      }

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
   * If both pending IDs are cleared, finalize destroy.
   * For stale auto-destroy, this includes marking Postgres before wiping DO state.
   * Returns finalization details for callers that need retry behavior.
   */
  private async finalizeDestroyIfComplete(): Promise<DestroyResult> {
    if (this.pendingDestroyMachineId || this.pendingDestroyVolumeId) {
      return {
        finalized: false,
        destroyedUserId: null,
        destroyedSandboxId: null,
      };
    }

    if (!this.userId || !this.sandboxId) {
      return {
        finalized: false,
        destroyedUserId: null,
        destroyedSandboxId: null,
      };
    }

    const destroyedUserId = this.userId;
    const destroyedSandboxId = this.sandboxId;

    if (this.pendingPostgresMarkOnFinalize) {
      const marked = await this.markDestroyedInPostgres(destroyedUserId, destroyedSandboxId);
      if (!marked) {
        return {
          finalized: false,
          destroyedUserId,
          destroyedSandboxId,
        };
      }
    }

    reconcileLog('finalize', 'destroy_complete', {
      user_id: destroyedUserId,
      sandbox_id: destroyedSandboxId,
    });

    await this.clearDestroyedState();

    return {
      finalized: true,
      destroyedUserId,
      destroyedSandboxId,
    };
  }

  private async clearDestroyedState(): Promise<void> {
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
    this.pendingPostgresMarkOnFinalize = false;
    this.lastMetadataRecoveryAt = null;
    this.openclawVersion = null;
    this.imageVariant = null;
    this.trackedImageTag = null;
    this.trackedImageDigest = null;
    this.loaded = false;
  }

  // ========================================================================
  // Infrastructure helpers
  // ========================================================================

  /**
   * Resolve the Docker image tag for this instance.
   * Reads from DO state only — no KV on the hot path.
   * Falls back to FLY_IMAGE_TAG for instances provisioned before tracking was enabled.
   */
  private resolveImageTag(): string {
    if (this.trackedImageTag) {
      return this.trackedImageTag;
    }
    // Fallback for instances provisioned before tracking was enabled
    return this.env.FLY_IMAGE_TAG ?? 'latest';
  }

  /**
   * Shared Docker image registry app name.
   * Images are pushed to this app's registry and referenced by all per-user apps.
   */
  private getRegistryApp(): string {
    return this.env.FLY_REGISTRY_APP ?? this.env.FLY_APP_NAME ?? 'kiloclaw-machines';
  }

  /**
   * Poll the gateway status endpoint until the OpenClaw gateway process
   * reports state === 'running', meaning it's ready to accept WebSocket
   * connections on port 3001.
   *
   * The controller's /_kilo/health returns 200 as soon as the controller
   * itself is up, which is too early — the gateway process spawns after.
   * So we check /_kilo/gateway/status and parse the JSON state field.
   *
   * On timeout, logs a warning but does NOT throw — the caller proceeds
   * anyway (the proxy layer catches lingering 502s with a friendly page).
   */
  private async waitForHealthy(appName: string, machineId: string): Promise<void> {
    const url = `https://${appName}.fly.dev/_kilo/gateway/status`;
    const deadline = Date.now() + HEALTH_PROBE_TIMEOUT_SECONDS * 1000;

    // Derive auth token — gateway controller requires Bearer auth
    let gatewayToken: string | undefined;
    if (this.sandboxId && this.env.GATEWAY_TOKEN_SECRET) {
      gatewayToken = await deriveGatewayToken(this.sandboxId, this.env.GATEWAY_TOKEN_SECRET);
    }

    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, {
          headers: {
            'fly-force-instance-id': machineId,
            ...(gatewayToken && { Authorization: `Bearer ${gatewayToken}` }),
            Accept: 'application/json',
          },
        });
        if (res.ok) {
          const body: { state?: string } = await res.json();
          if (body.state === 'running') {
            // Gateway reports running — verify it's actually serving traffic
            // by probing the root path (controller proxies to gateway on :3001)
            const rootUrl = `https://${appName}.fly.dev/`;
            try {
              const rootRes = await fetch(rootUrl, {
                headers: { 'fly-force-instance-id': machineId },
              });
              if (rootRes.status !== 502) {
                console.log(
                  '[DO] Gateway health probe passed (state: running, root:',
                  rootRes.status,
                  ')'
                );
                return;
              }
              console.log('[DO] Gateway reports running but root returned 502 — retrying');
            } catch {
              console.log('[DO] Gateway reports running but root fetch failed — retrying');
            }
          } else {
            console.log('[DO] Gateway state:', body.state, '— retrying');
          }
        } else {
          console.log('[DO] Gateway status returned', res.status, '— retrying');
        }
      } catch (err) {
        console.log('[DO] Gateway status fetch error — retrying:', err);
      }
      await new Promise(r => setTimeout(r, HEALTH_PROBE_INTERVAL_MS));
    }

    console.warn(
      '[DO] Gateway health probe timed out after',
      HEALTH_PROBE_TIMEOUT_SECONDS,
      's — proceeding anyway'
    );
  }

  /**
   * Returns the age in ms if this instance is a stale abandoned provision
   * (provisioned, never started, no machine, older than threshold), or null.
   */
  private staleProvisionAgeMs(): number | null {
    if (
      this.status === 'provisioned' &&
      !this.flyMachineId &&
      !this.lastStartedAt &&
      this.provisionedAt
    ) {
      const age = Date.now() - this.provisionedAt;
      if (age > STALE_PROVISION_THRESHOLD_MS) return age;
    }
    return null;
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
   * Walks the region list with a compute hint so Fly picks a host with
   * capacity for the expected machine spec. Persists the new volume ID immediately.
   */
  private async ensureVolume(flyConfig: FlyClientConfig, reason: string): Promise<void> {
    if (this.flyVolumeId) return;
    if (!this.sandboxId) return;

    // When flyRegion is set this is a single region — shuffle is a no-op.
    const regions = shuffleRegions(
      parseRegions(this.flyRegion ?? this.env.FLY_REGION ?? DEFAULT_FLY_REGION)
    );
    const volume = await fly.createVolumeWithFallback(
      flyConfig,
      {
        name: volumeNameFromSandboxId(this.sandboxId),
        size_gb: DEFAULT_VOLUME_SIZE_GB,
        compute: guestFromSize(this.machineSize),
      },
      regions
    );

    this.flyVolumeId = volume.id;
    this.flyRegion = volume.region;
    await this.ctx.storage.put(storageUpdate({ flyVolumeId: volume.id, flyRegion: volume.region }));

    reconcileLog(reason, 'create_volume', {
      volume_id: volume.id,
      region: volume.region,
    });
  }

  /**
   * Replace a stranded volume whose host has no capacity (Fly 412).
   *
   * For existing instances (lastStartedAt set): forks the volume to preserve
   * user data. If the fork fails, the error propagates to the caller.
   * For fresh provisions (never started): deletes and creates a new empty volume.
   *
   * Deprioritizes the failed region so we try other regions first, and walks
   * the full region list via createVolumeWithFallback.
   * Also destroys any existing machine (it's stuck on the same host).
   */
  private async replaceStrandedVolume(flyConfig: FlyClientConfig, reason: string): Promise<void> {
    if (!this.sandboxId || !this.flyVolumeId) return;

    const oldVolumeId = this.flyVolumeId;
    const oldRegion = this.flyRegion;
    const hasUserData = this.lastStartedAt !== null;
    const allRegions = shuffleRegions(parseRegions(this.env.FLY_REGION ?? DEFAULT_FLY_REGION));
    const regions = deprioritizeRegion(allRegions, oldRegion);
    const compute = guestFromSize(this.machineSize);

    // Destroy existing machine if any — it's stuck on the constrained host.
    // Only clear flyMachineId on confirmed deletion (success or 404).
    // On transient failures, keep the ID so reconciliation can retry cleanup.
    if (this.flyMachineId) {
      let machineGone = false;
      try {
        await fly.destroyMachine(flyConfig, this.flyMachineId);
        reconcileLog(reason, 'destroy_stranded_machine', { machine_id: this.flyMachineId });
        machineGone = true;
      } catch (err) {
        if (fly.isFlyNotFound(err)) {
          machineGone = true;
        } else {
          console.warn('[DO] Failed to destroy stranded machine:', err);
        }
      }
      if (machineGone) {
        this.flyMachineId = null;
        await this.ctx.storage.put(storageUpdate({ flyMachineId: null }));
      }
    }

    if (hasUserData) {
      // Fork the volume to preserve user data (workspace, config).
      // Walks regions so if one is at capacity, the next is tried.
      const forkedVolume = await fly.createVolumeWithFallback(
        flyConfig,
        {
          name: volumeNameFromSandboxId(this.sandboxId),
          size_gb: DEFAULT_VOLUME_SIZE_GB,
          source_volume_id: oldVolumeId,
          compute,
        },
        regions
      );
      this.flyVolumeId = forkedVolume.id;
      this.flyRegion = forkedVolume.region;
      reconcileLog(reason, 'fork_stranded_volume', {
        old_volume_id: oldVolumeId,
        old_region: oldRegion,
        new_volume_id: forkedVolume.id,
        new_region: forkedVolume.region,
      });
    } else {
      // Fresh provision (never started) — no user data to preserve
      this.flyVolumeId = null;
      this.flyRegion = null;
      await this.ctx.storage.put(storageUpdate({ flyVolumeId: null, flyRegion: null }));

      const freshVolume = await fly.createVolumeWithFallback(
        flyConfig,
        {
          name: volumeNameFromSandboxId(this.sandboxId),
          size_gb: DEFAULT_VOLUME_SIZE_GB,
          compute,
        },
        regions
      );
      this.flyVolumeId = freshVolume.id;
      this.flyRegion = freshVolume.region;
      reconcileLog(reason, 'create_replacement_volume', {
        old_volume_id: oldVolumeId,
        old_region: oldRegion,
        new_volume_id: freshVolume.id,
        new_region: freshVolume.region,
      });
    }

    // Persist new volume state
    await this.ctx.storage.put(
      storageUpdate({ flyVolumeId: this.flyVolumeId, flyRegion: this.flyRegion })
    );

    // Delete old volume (best-effort cleanup)
    try {
      await fly.deleteVolume(flyConfig, oldVolumeId);
      reconcileLog(reason, 'delete_stranded_volume', { volume_id: oldVolumeId });
    } catch (err) {
      if (!fly.isFlyNotFound(err)) {
        console.warn('[DO] Failed to delete stranded volume (will leak):', oldVolumeId, err);
      }
    }
  }

  /**
   * Try to start an existing machine. Falls back to creating a new one if
   * the existing machine is unusable (destroyed, corrupted).
   */
  private async startExistingMachine(
    flyConfig: FlyClientConfig,
    initialMachineConfig: FlyMachineConfig,
    minSecretsVersion?: number
  ): Promise<void> {
    if (!this.flyMachineId) return;

    try {
      const machine = await fly.getMachine(flyConfig, this.flyMachineId);

      // Backfill machineSize from live Fly machine config for legacy instances,
      // then re-derive guest so updateMachine sends the actual deployed size
      // instead of the new default.
      let machineConfig = initialMachineConfig;
      if (this.machineSize === null && machine.config?.guest) {
        const { cpus, memory_mb, cpu_kind } = machine.config.guest;
        this.machineSize = { cpus, memory_mb, cpu_kind };
        await this.ctx.storage.put(storageUpdate({ machineSize: this.machineSize }));
        machineConfig = { ...machineConfig, guest: guestFromSize(this.machineSize) };
      }

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
        // Machine confirmed gone — safe to recreate (new default is correct here)
        console.log('[DO] Machine gone (404), creating new one');
        this.flyMachineId = null;
        await this.ctx.storage.put(storageUpdate({ flyMachineId: null }));
        await this.createNewMachine(flyConfig, initialMachineConfig, minSecretsVersion);
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
      const db = getWorkerDb(connectionString);
      const instance = await getActiveInstance(db, userId);

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
          pendingPostgresMarkOnFinalize: false,
          openclawVersion: null,
          imageVariant: null,
          trackedImageTag: null,
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
      this.pendingPostgresMarkOnFinalize = false;
      this.lastMetadataRecoveryAt = null;
      this.openclawVersion = null;
      this.imageVariant = null;
      this.trackedImageTag = null;
      this.trackedImageDigest = null;
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

  /**
   * Mark the Postgres registry row as destroyed during stale auto-destroy
   * finalization. Returns true when marked (or already marked), false when
   * a retry is needed.
   */
  private async markDestroyedInPostgres(userId: string, sandboxId: string): Promise<boolean> {
    const connectionString = this.env.HYPERDRIVE?.connectionString;
    if (!connectionString) {
      // Hyperdrive not available — skip rather than block finalization forever.
      // The stale Postgres row is harmless; restoreFromPostgres handles it.
      console.warn('[DO] HYPERDRIVE not configured, skipping Postgres mark-destroyed');
      return true;
    }

    try {
      const db = getWorkerDb(connectionString);
      await markInstanceDestroyed(db, userId, sandboxId);
      this.pendingPostgresMarkOnFinalize = false;
      await this.ctx.storage.put(storageUpdate({ pendingPostgresMarkOnFinalize: false }));
      return true;
    } catch (err) {
      console.error('[DO] Failed to mark instance destroyed in Postgres:', err);
      return false;
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
