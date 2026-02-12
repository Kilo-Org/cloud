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
 */

import { DurableObject } from 'cloudflare:workers';
import { getSandbox, type Sandbox, type SandboxOptions } from '@cloudflare/sandbox';
import type { KiloClawEnv } from '../types';
import { sandboxIdFromUserId } from '../auth/sandbox-id';
import { createDatabaseConnection, InstanceStore } from '../db';
import { buildEnvVars } from '../gateway/env';
import { mountR2Storage, userR2Prefix } from '../gateway/r2';
import { ensureOpenClawGateway, findExistingGatewayProcess } from '../gateway/process';
import { syncToR2, type SyncResult } from '../gateway/sync';
import {
  PersistedStateSchema,
  type InstanceConfig,
  type PersistedState,
  type EncryptedEnvelope,
  type ModelEntry,
} from '../schemas/instance-config';

// StopParams from @cloudflare/containers -- not re-exported by @cloudflare/sandbox
type StopParams = {
  exitCode: number;
  reason: 'exit' | 'runtime_signal';
};

type InstanceStatus = 'provisioned' | 'running' | 'stopped';

// Derived from PersistedStateSchema — single source of truth for DO KV keys.
const STORAGE_KEYS = Object.keys(PersistedStateSchema.shape);

/** Type-checked wrapper for ctx.storage.put() — catches key typos and wrong value types at compile time. */
function storageUpdate(update: Partial<PersistedState>): Partial<PersistedState> {
  return update;
}

// Sync timing constants
const FIRST_SYNC_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes
const SELF_HEAL_THRESHOLD = 5; // consecutive non-healthy checks before marking stopped
const STALE_SYNC_LOCK_MS = 10 * 60 * 1000; // 10 minutes: reset syncInProgress if stale

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
  private lastSyncAt: number | null = null;
  private syncInProgress = false;
  private syncLockedAt: number | null = null;
  private syncFailCount = 0;

  /**
   * Load persisted state from DO KV storage.
   * Called lazily on first method invocation.
   * Uses zod to validate the untyped storage entries at runtime.
   */
  private async loadState(): Promise<void> {
    if (this.loaded) return;

    const entries = await this.ctx.storage.get(STORAGE_KEYS);
    const raw = Object.fromEntries(entries.entries());
    const parsed = PersistedStateSchema.safeParse(raw);

    if (parsed.success) {
      const s = parsed.data;
      // Empty strings mean "no value persisted" (from .default(''))
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
      this.lastSyncAt = s.lastSyncAt;
      this.syncInProgress = s.syncInProgress;
      this.syncLockedAt = s.syncLockedAt;
      this.syncFailCount = s.syncFailCount;

      // Stale sync lock detection: if syncInProgress is true but the lock was
      // acquired longer ago than STALE_SYNC_LOCK_MS, the previous alarm likely
      // crashed mid-sync. Using syncLockedAt (set when acquiring the lock) instead
      // of lastSyncAt avoids a stuck lock on first-ever sync when lastSyncAt is null.
      if (this.syncInProgress && this.syncLockedAt) {
        const elapsed = Date.now() - this.syncLockedAt;
        if (elapsed > STALE_SYNC_LOCK_MS) {
          console.warn('[DO] Resetting stale syncInProgress lock');
          this.syncInProgress = false;
          this.syncLockedAt = null;
          await this.ctx.storage.put(
            storageUpdate({
              syncInProgress: false,
              syncLockedAt: null,
            })
          );
        }
      }
    } else {
      // safeParse failed -- storage contains data in an unexpected shape.
      // With .default() on every field this should only happen if storage
      // contains truly malformed values (e.g. wrong types). Log the error
      // and fall through to defaults (all fields null/false/0).
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

  // ─── Lifecycle methods (called by platform API routes via RPC) ──────────

  /**
   * Provision or update config for a user's instance.
   * The Next.js backend has already written the Postgres row before calling this.
   * This method stores config in DO SQLite. Allows re-provisioning (config update).
   */
  async provision(userId: string, config: InstanceConfig): Promise<{ sandboxId: string }> {
    await this.loadState();

    const sandboxId = sandboxIdFromUserId(userId);
    const isNew = !this.status;

    // Store config + identity in DO SQLite
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
    } satisfies Partial<PersistedState>;

    // Only set initial state on first provision, not on config updates
    const update = isNew
      ? storageUpdate({
          ...configFields,
          provisionedAt: Date.now(),
          lastStartedAt: null,
          lastStoppedAt: null,
          lastSyncAt: null,
          syncInProgress: false,
          syncLockedAt: null,
          syncFailCount: 0,
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
    if (isNew) {
      this.provisionedAt = Date.now();
      this.lastStartedAt = null;
      this.lastStoppedAt = null;
      this.lastSyncAt = null;
      this.syncInProgress = false;
      this.syncLockedAt = null;
      this.syncFailCount = 0;
    }
    this.loaded = true;

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
   * Start the sandbox container and gateway.
   *
   * Idempotent: if status is already 'running', verifies the gateway is
   * actually alive. If it crashed (race with handleContainerStopped), falls
   * through to a full restart. This allows the catch-all proxy to call
   * start() for crash recovery without needing to know the precise state.
   *
   * @param userId - Optional userId hint for restore-from-Postgres if DO SQLite was wiped.
   */
  async start(userId?: string): Promise<void> {
    await this.loadState();

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

    const sandbox = this.resolveSandbox();

    // If status is 'running', verify the gateway is actually alive.
    // handleContainerStopped may not have fired yet after a crash.
    if (this.status === 'running') {
      const gateway = await findExistingGatewayProcess(sandbox);
      if (gateway && (gateway.status === 'running' || gateway.status === 'starting')) {
        console.log('[DO] Instance already running with live gateway, no-op');
        return;
      }
      // Gateway is dead despite status=running. Fall through to full restart.
      console.log('[DO] Status is running but gateway is dead, restarting');
    }

    // Mount R2 storage with per-user prefix
    await mountR2Storage(sandbox, this.env, this.userId);

    const envVars = await this.buildUserEnvVars();
    await this.writeKiloCodeModelsFile();
    await ensureOpenClawGateway(sandbox, this.env, envVars);

    // Update state
    this.status = 'running';
    this.lastStartedAt = Date.now();
    this.syncFailCount = 0;
    await this.ctx.storage.put(
      storageUpdate({
        status: 'running',
        lastStartedAt: this.lastStartedAt,
        syncFailCount: 0,
      })
    );

    // Schedule first sync alarm (+10 minutes -- setup may take a while)
    await this.ctx.storage.setAlarm(Date.now() + FIRST_SYNC_DELAY_MS);
  }

  /**
   * Stop the sandbox container.
   */
  async stop(): Promise<void> {
    await this.loadState();

    if (!this.userId || !this.sandboxId) {
      throw new Error('Instance not provisioned');
    }
    if (this.status === 'stopped' || this.status === 'provisioned') {
      console.log('[DO] Instance not running, no-op');
      return;
    }

    const sandbox = this.resolveSandbox();

    // Kill gateway process tree (pkill to catch child processes)
    await this.killGatewayProcesses(sandbox);

    // Update state
    this.status = 'stopped';
    this.lastStoppedAt = Date.now();
    await this.ctx.storage.put(
      storageUpdate({
        status: 'stopped',
        lastStoppedAt: this.lastStoppedAt,
      })
    );

    // Clear sync alarm
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * Destroy the instance. Tears down sandbox + clears DO state.
   * The Next.js backend has already soft-deleted the Postgres row before calling this.
   */
  async destroy(deleteData?: boolean): Promise<void> {
    await this.loadState();

    if (!this.userId) {
      throw new Error('Instance not provisioned');
    }

    // Teardown sandbox + gateway process
    if (this.sandboxId) {
      try {
        const sandbox = this.resolveSandbox();
        await this.killGatewayProcesses(sandbox);
        await sandbox.destroy();
      } catch (err) {
        console.error('[DO] Sandbox teardown error:', err);
      }
    }

    // Optional: delete R2 data
    if (deleteData && this.userId) {
      await this.deleteR2Data();
    }

    // Clear all DO state + alarm
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();

    // Reset cached state
    this.userId = null;
    this.sandboxId = null;
    this.status = null;
    this.envVars = null;
    this.encryptedSecrets = null;
    this.channels = null;
    this.provisionedAt = null;
    this.lastStartedAt = null;
    this.lastStoppedAt = null;
    this.lastSyncAt = null;
    this.syncInProgress = false;
    this.syncLockedAt = null;
    this.syncFailCount = 0;
    this.loaded = false;
  }

  // ─── Lifecycle hook handler ────────────────────────────────────────────

  /**
   * Called by KiloClawSandbox.onStop() lifecycle hook.
   * Safety net for unexpected container deaths (crash, OOM, runtime signal).
   */
  async handleContainerStopped(params: StopParams): Promise<void> {
    await this.loadState();

    console.log(
      '[DO] handleContainerStopped:',
      this.userId,
      'exitCode:',
      params.exitCode,
      'reason:',
      params.reason
    );

    // Update state
    this.status = 'stopped';
    this.lastStoppedAt = Date.now();
    await this.ctx.storage.put(
      storageUpdate({
        status: 'stopped',
        lastStoppedAt: this.lastStoppedAt,
      })
    );

    // Clear sync alarm
    await this.ctx.storage.deleteAlarm();
  }

  // ─── Read methods ─────────────────────────────────────────────────────

  async getStatus(): Promise<{
    userId: string | null;
    sandboxId: string | null;
    status: InstanceStatus | null;
    lastSyncAt: number | null;
    syncInProgress: boolean;
    provisionedAt: number | null;
    lastStartedAt: number | null;
    lastStoppedAt: number | null;
    envVarCount: number;
    secretCount: number;
    channelCount: number;
  }> {
    await this.loadState();

    return {
      userId: this.userId,
      sandboxId: this.sandboxId,
      status: this.status,
      lastSyncAt: this.lastSyncAt,
      syncInProgress: this.syncInProgress,
      provisionedAt: this.provisionedAt,
      lastStartedAt: this.lastStartedAt,
      lastStoppedAt: this.lastStoppedAt,
      envVarCount: this.envVars ? Object.keys(this.envVars).length : 0,
      secretCount: this.encryptedSecrets ? Object.keys(this.encryptedSecrets).length : 0,
      channelCount: this.channels ? Object.values(this.channels).filter(Boolean).length : 0,
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
    };
  }

  // ─── User-facing operations (called by admin API routes via DO RPC) ──

  /**
   * Trigger a manual sync to R2. Requires a running instance.
   */
  async triggerSync(): Promise<SyncResult> {
    await this.loadState();

    if (this.status !== 'running' || !this.sandboxId || !this.userId) {
      return { success: false, error: 'Instance is not running' };
    }

    const sandbox = this.resolveSandbox();
    return syncToR2(sandbox, this.env, this.userId);
  }

  /**
   * Restart the gateway process (kill existing, start new).
   * Rebuilds env vars from stored config. Requires a running instance.
   */
  async restartGateway(): Promise<{
    success: boolean;
    error?: string;
    previousProcessId?: string;
  }> {
    await this.loadState();

    if (this.status !== 'running' || !this.sandboxId) {
      return { success: false, error: 'Instance is not running' };
    }

    const sandbox = this.resolveSandbox();

    // Kill existing gateway process tree
    const existingProcess = await findExistingGatewayProcess(sandbox);
    const previousProcessId = existingProcess?.id;
    await this.killGatewayProcesses(sandbox);
    // Brief wait for processes to fully terminate
    await new Promise(r => setTimeout(r, 2000));

    // Rebuild env vars and start new gateway
    try {
      const envVars = await this.buildUserEnvVars();
      await this.writeKiloCodeModelsFile();
      await ensureOpenClawGateway(sandbox, this.env, envVars);
      return {
        success: true,
        previousProcessId,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: errorMessage, previousProcessId };
    }
  }

  // ─── Alarm (sync loop) ───────────────────────────────────────────────

  override async alarm(): Promise<void> {
    await this.loadState();

    if (this.status !== 'running' || !this.sandboxId) {
      return;
    }

    const sandbox = this.resolveSandbox();

    const health = await this.checkContainerHealth(sandbox);
    if (health === 'self-healed' || health === 'unhealthy') {
      return;
    }

    if (this.syncInProgress) {
      await this.rescheduleWithBackoff();
      return;
    }

    await this.performSync(sandbox);
  }

  /**
   * Check container health via getState() (reads DO storage only -- no container wake).
   * Increments syncFailCount on non-healthy checks and triggers self-heal after
   * SELF_HEAL_THRESHOLD consecutive failures.
   */
  private async checkContainerHealth(
    sandbox: Sandbox
  ): Promise<'healthy' | 'unhealthy' | 'self-healed'> {
    try {
      const containerState = await sandbox.getState();
      if (containerState.status === 'healthy') {
        return 'healthy';
      }
    } catch (err) {
      console.error('[sync] getState() failed:', err);
    }

    // Not healthy (or getState threw)
    this.syncFailCount++;
    await this.ctx.storage.put(storageUpdate({ syncFailCount: this.syncFailCount }));

    if (this.syncFailCount >= SELF_HEAL_THRESHOLD) {
      console.warn(
        `[sync] Container not healthy after ${this.syncFailCount} checks, marking stopped`
      );
      this.status = 'stopped';
      this.lastStoppedAt = Date.now();
      await this.ctx.storage.put(
        storageUpdate({
          status: 'stopped',
          lastStoppedAt: this.lastStoppedAt,
          syncFailCount: this.syncFailCount,
        })
      );
      return 'self-healed';
    }

    await this.rescheduleWithBackoff();
    return 'unhealthy';
  }

  /**
   * Run the sync operation: check gateway, rsync to R2, update timestamps.
   * Manages the syncInProgress lock and reschedules the next alarm.
   */
  private async performSync(sandbox: Sandbox): Promise<void> {
    if (!this.userId) return;

    this.syncInProgress = true;
    this.syncLockedAt = Date.now();
    await this.ctx.storage.put(
      storageUpdate({
        syncInProgress: true,
        syncLockedAt: this.syncLockedAt,
      })
    );

    try {
      const gatewayProcess = await findExistingGatewayProcess(sandbox);
      if (!gatewayProcess) {
        console.log(`[sync] Gateway not running for ${this.userId}, skipping`);
        this.syncInProgress = false;
        this.syncLockedAt = null;
        await this.ctx.storage.put(
          storageUpdate({
            syncInProgress: false,
            syncLockedAt: null,
          })
        );
        await this.scheduleSync();
        return;
      }

      const result = await syncToR2(sandbox, this.env, this.userId);
      if (result.success) {
        this.lastSyncAt = Date.now();
        this.syncFailCount = 0;
        await this.ctx.storage.put(
          storageUpdate({
            lastSyncAt: this.lastSyncAt,
            syncFailCount: 0,
          })
        );
      } else {
        console.error(`[sync] Failed for ${this.userId}:`, result.error);
        this.syncFailCount++;
        await this.ctx.storage.put(storageUpdate({ syncFailCount: this.syncFailCount }));
      }
    } catch (err) {
      console.error(`[sync] Error for ${this.userId}:`, err);
      this.syncFailCount++;
      await this.ctx.storage.put(storageUpdate({ syncFailCount: this.syncFailCount }));
    }

    this.syncInProgress = false;
    this.syncLockedAt = null;
    await this.ctx.storage.put(
      storageUpdate({
        syncInProgress: false,
        syncLockedAt: null,
      })
    );

    if (this.syncFailCount > 0) {
      await this.rescheduleWithBackoff();
    } else {
      await this.scheduleSync();
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  /**
   * Kill the gateway process and all its children.
   * Uses pkill -f instead of Process.kill() because start-openclaw.sh
   * spawns child processes (the actual openclaw gateway) that survive
   * if only the parent shell PID is killed.
   */
  private async killGatewayProcesses(sandbox: Sandbox): Promise<void> {
    try {
      // Kill anything matching start-openclaw or openclaw gateway
      const proc = await sandbox.startProcess("pkill -f 'start-openclaw|openclaw'");
      // Wait briefly for pkill to complete
      let attempts = 0;
      while (proc.status === 'running' && attempts < 10) {
        await new Promise(r => setTimeout(r, 200));
        attempts++;
      }
      console.log('[DO] pkill completed, status:', proc.status, 'exitCode:', proc.exitCode);
    } catch (err) {
      console.error('[DO] pkill failed:', err);
    }
  }

  /**
   * Restore DO state from Postgres backup if SQLite was wiped.
   * The Next.js backend is the sole writer to Postgres, so this data
   * is the authoritative backup of the instance config.
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

      // Config values are not persisted in Postgres.
      const envVars: Record<string, string> | null = null;
      const encryptedSecrets: Record<string, EncryptedEnvelope> | null = null;
      const channels = null;

      // Write restored state to DO SQLite
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
          lastSyncAt: null,
          syncInProgress: false,
          syncLockedAt: null,
          syncFailCount: 0,
        })
      );

      // Update cached state
      this.userId = userId;
      this.sandboxId = instance.sandboxId;
      this.status = 'provisioned';
      this.envVars = envVars;
      this.encryptedSecrets = encryptedSecrets;
      this.channels = channels;
      this.provisionedAt = Date.now();
      this.lastStartedAt = null;
      this.lastStoppedAt = null;
      this.lastSyncAt = null;
      this.syncInProgress = false;
      this.syncLockedAt = null;
      this.syncFailCount = 0;
      this.loaded = true;

      console.log('[DO] Restored from Postgres: sandboxId =', instance.sandboxId);
    } catch (err) {
      console.error('[DO] Postgres restore failed:', err);
    }
  }

  /**
   * Build env vars from stored user config. Used by start() and restartGateway().
   */
  private async buildUserEnvVars(): Promise<Record<string, string>> {
    if (!this.sandboxId || !this.env.GATEWAY_TOKEN_SECRET) {
      throw new Error('Cannot build env vars: sandboxId or GATEWAY_TOKEN_SECRET missing');
    }
    return buildEnvVars(this.env, this.sandboxId, this.env.GATEWAY_TOKEN_SECRET, {
      envVars: this.envVars ?? undefined,
      encryptedSecrets: this.encryptedSecrets ?? undefined,
      kilocodeApiKey: this.kilocodeApiKey ?? undefined,
      kilocodeDefaultModel: this.kilocodeDefaultModel ?? undefined,
      channels: this.channels ?? undefined,
    });
  }

  private async writeKiloCodeModelsFile(): Promise<void> {
    if (!this.sandboxId) return;
    const sandbox = this.resolveSandbox();
    const content = JSON.stringify(this.kilocodeModels ?? []);
    const escaped = content.replace(/'/g, "'\\''");
    const command = `printf '%s' '${escaped}' > /root/.openclaw/kilocode-models.json`;
    try {
      const proc = await sandbox.startProcess(command);

      let attempts = 0;
      while (attempts < 10) {
        await new Promise(r => setTimeout(r, 100));
        if (proc.status !== 'running') break;
        attempts++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.warn('[DO] Failed to write KiloCode models file:', message);
    }
  }

  private resolveSandbox() {
    if (!this.sandboxId) {
      throw new Error('No sandboxId -- instance not provisioned');
    }
    const options: SandboxOptions = { keepAlive: true };
    return getSandbox(this.env.Sandbox, this.sandboxId, options);
  }

  private async scheduleSync(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
  }

  private async rescheduleWithBackoff(): Promise<void> {
    // Exponential backoff: min(5min * 2^failCount, 30min)
    const delayMs = Math.min(SYNC_INTERVAL_MS * Math.pow(2, this.syncFailCount), MAX_BACKOFF_MS);
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /**
   * Delete R2 data for this user via R2 list + delete.
   * The R2 prefix is derived from userId using the same hash as mountR2Storage.
   * userR2Prefix returns "/users/{hash}" (leading slash for s3fs); R2 keys
   * use no leading slash, so we strip it.
   */
  private async deleteR2Data(): Promise<void> {
    if (!this.userId) return;

    const prefixWithSlash = await userR2Prefix(this.userId);
    // Strip leading '/' -- R2 keys don't use leading slashes
    const r2Prefix = prefixWithSlash.startsWith('/') ? prefixWithSlash.slice(1) : prefixWithSlash;

    console.log('[DO] Deleting R2 data with prefix:', r2Prefix);

    try {
      let cursor: string | undefined;
      let totalDeleted = 0;

      do {
        const listed = await this.env.KILOCLAW_BUCKET.list({
          prefix: r2Prefix,
          cursor,
          limit: 1000,
        });

        if (listed.objects.length > 0) {
          const keys = listed.objects.map(o => o.key);
          await this.env.KILOCLAW_BUCKET.delete(keys);
          totalDeleted += keys.length;
        }

        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);

      console.log(`[DO] Deleted ${totalDeleted} R2 objects for user ${this.userId}`);
    } catch (err) {
      console.error('[DO] R2 data deletion failed:', err);
    }
  }
}
