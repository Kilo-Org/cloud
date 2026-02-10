/**
 * KiloClawInstance Durable Object
 *
 * Primary source of truth for instance configuration and operational state.
 * API routes are thin wrappers that call into this DO via Workers RPC.
 * The DB (kiloclaw_instances) is a registry mirror for enumeration.
 *
 * Keyed by userId: env.KILOCLAW_INSTANCE.idFromName(userId)
 *
 * Authority model:
 * - Create/destroy: DB write inside DO, must succeed or operation fails
 * - Operational state (start/stop): DO is authoritative, DB mirrored best-effort
 */

import { DurableObject } from 'cloudflare:workers';
import { getSandbox, type Sandbox, type SandboxOptions } from '@cloudflare/sandbox';
import type { KiloClawEnv } from '../types';
import { sandboxIdFromUserId } from '../auth/sandbox-id';
import { createDatabaseConnection, InstanceStore } from '../db';
import { buildEnvVars } from '../gateway/env';
import { mountR2Storage } from '../gateway/r2';
import { ensureOpenClawGateway, findExistingGatewayProcess } from '../gateway/process';
import { syncToR2 } from '../gateway/sync';
import {
  PersistedStateSchema,
  type InstanceConfig,
  type PersistedState,
} from '../schemas/instance-config';

// StopParams from @cloudflare/containers -- not re-exported by @cloudflare/sandbox
type StopParams = {
  exitCode: number;
  reason: 'exit' | 'runtime_signal';
};

type InstanceStatus = 'provisioned' | 'running' | 'stopped';

// DO KV storage keys (match PersistedStateSchema field names exactly)
const KEY_USER_ID = 'userId';
const KEY_SANDBOX_ID = 'sandboxId';
const KEY_STATUS = 'status';
const KEY_ENV_VARS = 'envVars';
const KEY_ENCRYPTED_SECRETS = 'encryptedSecrets';
const KEY_CHANNELS = 'channels';
const KEY_PROVISIONED_AT = 'provisionedAt';
const KEY_LAST_STARTED_AT = 'lastStartedAt';
const KEY_LAST_STOPPED_AT = 'lastStoppedAt';
const KEY_LAST_SYNC_AT = 'lastSyncAt';
const KEY_SYNC_IN_PROGRESS = 'syncInProgress';
const KEY_SYNC_LOCKED_AT = 'syncLockedAt';
const KEY_SYNC_FAIL_COUNT = 'syncFailCount';

const STORAGE_KEYS = [
  KEY_USER_ID,
  KEY_SANDBOX_ID,
  KEY_STATUS,
  KEY_ENV_VARS,
  KEY_ENCRYPTED_SECRETS,
  KEY_CHANNELS,
  KEY_PROVISIONED_AT,
  KEY_LAST_STARTED_AT,
  KEY_LAST_STOPPED_AT,
  KEY_LAST_SYNC_AT,
  KEY_SYNC_IN_PROGRESS,
  KEY_SYNC_LOCKED_AT,
  KEY_SYNC_FAIL_COUNT,
];

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
          await this.ctx.storage.put({
            [KEY_SYNC_IN_PROGRESS]: false,
            [KEY_SYNC_LOCKED_AT]: null,
          });
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
   * Provision a new instance for a user.
   * Generates sandboxId, inserts into DB (must succeed), stores config in DO.
   */
  async provision(userId: string, config: InstanceConfig): Promise<{ sandboxId: string }> {
    await this.loadState();

    // Reject if any instance state exists. A stopped instance should be
    // destroyed before re-provisioning, not silently overwritten.
    if (this.status) {
      throw new Error(`Instance already exists with status '${this.status}'`);
    }

    const sandboxId = sandboxIdFromUserId(userId);

    // DB INSERT in transaction -- must succeed
    const db = createDatabaseConnection(this.env.HYPERDRIVE.connectionString);
    const store = new InstanceStore(db);
    await store.begin(async tx => {
      const txStore = new InstanceStore(tx);
      await txStore.insertProvisioned(userId, sandboxId);
    });

    // Store config + identity in DO SQLite
    await this.ctx.storage.put({
      [KEY_USER_ID]: userId,
      [KEY_SANDBOX_ID]: sandboxId,
      [KEY_STATUS]: 'provisioned' satisfies InstanceStatus,
      [KEY_ENV_VARS]: config.envVars ?? null,
      [KEY_ENCRYPTED_SECRETS]: config.encryptedSecrets ?? null,
      [KEY_CHANNELS]: config.channels ?? null,
      [KEY_PROVISIONED_AT]: Date.now(),
      [KEY_LAST_STARTED_AT]: null,
      [KEY_LAST_STOPPED_AT]: null,
      [KEY_LAST_SYNC_AT]: null,
      [KEY_SYNC_IN_PROGRESS]: false,
      [KEY_SYNC_LOCKED_AT]: null,
      [KEY_SYNC_FAIL_COUNT]: 0,
    });

    // Update cached state
    this.userId = userId;
    this.sandboxId = sandboxId;
    this.status = 'provisioned';
    this.envVars = config.envVars ?? null;
    this.encryptedSecrets = config.encryptedSecrets ?? null;
    this.channels = config.channels ?? null;
    this.provisionedAt = Date.now();
    this.lastStartedAt = null;
    this.lastStoppedAt = null;
    this.lastSyncAt = null;
    this.syncInProgress = false;
    this.syncLockedAt = null;
    this.syncFailCount = 0;
    this.loaded = true;

    return { sandboxId };
  }

  /**
   * Start the sandbox container and gateway.
   */
  async start(): Promise<void> {
    await this.loadState();

    if (!this.userId || !this.sandboxId) {
      throw new Error('Instance not provisioned');
    }
    if (this.status === 'running') {
      console.log('[DO] Instance already running, no-op');
      return;
    }

    const sandbox = this.resolveSandbox();

    // Mount R2 storage
    await mountR2Storage(sandbox, this.env);

    // Build env vars with per-sandbox gateway token + AUTO_APPROVE_DEVICES
    // Merge user-provided env vars first, then build system env vars on top.
    // buildEnvVars sets reserved keys (OPENCLAW_GATEWAY_TOKEN, AUTO_APPROVE_DEVICES)
    // last, so user config cannot override them.
    // PR5 will move this merge into buildEnvVars alongside encrypted secret decryption.
    const userEnv = this.envVars ? { ...this.envVars } : {};
    const envVars = await buildEnvVars(this.env, this.sandboxId, this.env.GATEWAY_TOKEN_SECRET);
    const mergedEnvVars = { ...userEnv, ...envVars };

    await ensureOpenClawGateway(sandbox, this.env, mergedEnvVars);

    // Update state
    this.status = 'running';
    this.lastStartedAt = Date.now();
    this.syncFailCount = 0;
    await this.ctx.storage.put({
      [KEY_STATUS]: 'running' satisfies InstanceStatus,
      [KEY_LAST_STARTED_AT]: this.lastStartedAt,
      [KEY_SYNC_FAIL_COUNT]: 0,
    });

    // Schedule first sync alarm (+10 minutes -- setup may take a while)
    await this.ctx.storage.setAlarm(Date.now() + FIRST_SYNC_DELAY_MS);

    // Mirror to DB (best-effort)
    this.mirrorStatusToDb('running', 'last_started_at');
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

    // Kill gateway process if running
    const existingProcess = await findExistingGatewayProcess(sandbox);
    if (existingProcess) {
      try {
        await existingProcess.kill();
      } catch (err) {
        console.error('[DO] Error killing gateway process:', err);
      }
    }

    // Update state
    this.status = 'stopped';
    this.lastStoppedAt = Date.now();
    await this.ctx.storage.put({
      [KEY_STATUS]: 'stopped' satisfies InstanceStatus,
      [KEY_LAST_STOPPED_AT]: this.lastStoppedAt,
    });

    // Clear sync alarm
    await this.ctx.storage.deleteAlarm();

    // Mirror to DB (best-effort)
    this.mirrorStatusToDb('stopped', 'last_stopped_at');
  }

  /**
   * Destroy the instance. DB soft-delete first (must succeed), then teardown.
   */
  async destroy(deleteData?: boolean): Promise<void> {
    await this.loadState();

    if (!this.userId) {
      throw new Error('Instance not provisioned');
    }

    // DB soft-delete FIRST -- must succeed and affect a row
    const db = createDatabaseConnection(this.env.HYPERDRIVE.connectionString);
    const store = new InstanceStore(db);
    const destroyed = await store.markDestroyed(this.userId);
    if (!destroyed) {
      throw new Error('No active instance found in DB for this user');
    }

    // Teardown (best-effort after DB write)
    if (this.sandboxId) {
      try {
        const sandbox = this.resolveSandbox();
        const existingProcess = await findExistingGatewayProcess(sandbox);
        if (existingProcess) {
          try {
            await existingProcess.kill();
          } catch {
            // best-effort
          }
        }
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
    await this.ctx.storage.put({
      [KEY_STATUS]: 'stopped' satisfies InstanceStatus,
      [KEY_LAST_STOPPED_AT]: this.lastStoppedAt,
    });

    // Clear sync alarm
    await this.ctx.storage.deleteAlarm();

    // Mirror to DB (best-effort)
    this.mirrorStatusToDb('stopped', 'last_stopped_at');
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
      channels: this.channels ?? undefined,
    };
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
    await this.ctx.storage.put(KEY_SYNC_FAIL_COUNT, this.syncFailCount);

    if (this.syncFailCount >= SELF_HEAL_THRESHOLD) {
      console.warn(
        `[sync] Container not healthy after ${this.syncFailCount} checks, marking stopped`
      );
      this.status = 'stopped';
      this.lastStoppedAt = Date.now();
      await this.ctx.storage.put({
        [KEY_STATUS]: 'stopped' satisfies InstanceStatus,
        [KEY_LAST_STOPPED_AT]: this.lastStoppedAt,
        [KEY_SYNC_FAIL_COUNT]: this.syncFailCount,
      });
      this.mirrorStatusToDb('stopped', 'last_stopped_at');
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
    this.syncInProgress = true;
    this.syncLockedAt = Date.now();
    await this.ctx.storage.put({
      [KEY_SYNC_IN_PROGRESS]: true,
      [KEY_SYNC_LOCKED_AT]: this.syncLockedAt,
    });

    try {
      const gatewayProcess = await findExistingGatewayProcess(sandbox);
      if (!gatewayProcess) {
        console.log(`[sync] Gateway not running for ${this.userId}, skipping`);
        this.syncInProgress = false;
        this.syncLockedAt = null;
        await this.ctx.storage.put({
          [KEY_SYNC_IN_PROGRESS]: false,
          [KEY_SYNC_LOCKED_AT]: null,
        });
        await this.scheduleSync();
        return;
      }

      const result = await syncToR2(sandbox, this.env);
      if (result.success) {
        this.lastSyncAt = Date.now();
        this.syncFailCount = 0;
        await this.ctx.storage.put({
          [KEY_LAST_SYNC_AT]: this.lastSyncAt,
          [KEY_SYNC_FAIL_COUNT]: 0,
        });
      } else {
        console.error(`[sync] Failed for ${this.userId}:`, result.error);
        this.syncFailCount++;
        await this.ctx.storage.put(KEY_SYNC_FAIL_COUNT, this.syncFailCount);
      }
    } catch (err) {
      console.error(`[sync] Error for ${this.userId}:`, err);
      this.syncFailCount++;
      await this.ctx.storage.put(KEY_SYNC_FAIL_COUNT, this.syncFailCount);
    }

    this.syncInProgress = false;
    this.syncLockedAt = null;
    await this.ctx.storage.put({
      [KEY_SYNC_IN_PROGRESS]: false,
      [KEY_SYNC_LOCKED_AT]: null,
    });

    if (this.syncFailCount > 0) {
      await this.rescheduleWithBackoff();
    } else {
      await this.scheduleSync();
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────

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
   * Mirror operational status to DB (best-effort).
   * Logs on failure but never throws -- the DO is authoritative.
   */
  private mirrorStatusToDb(
    status: 'running' | 'stopped',
    timestampColumn?: 'last_started_at' | 'last_stopped_at'
  ): void {
    if (!this.userId) return;

    const connectionString = this.env.HYPERDRIVE?.connectionString;
    if (!connectionString) {
      console.warn('[DO] HYPERDRIVE not configured, skipping DB mirror');
      return;
    }
    const userId = this.userId;

    // Fire and forget via waitUntil
    this.ctx.waitUntil(
      (async () => {
        try {
          const db = createDatabaseConnection(connectionString);
          const store = new InstanceStore(db);
          await store.mirrorStatus(userId, status, timestampColumn);
        } catch (err) {
          console.error('[DO] DB mirror failed:', err);
        }
      })()
    );
  }

  /**
   * Delete R2 data for this user. Uses R2 list + delete via the binding.
   */
  private async deleteR2Data(): Promise<void> {
    // R2 prefix is a SHA-256 hash of the userId (see gateway/r2.ts A5.1).
    // For now, we can't easily derive the prefix without the function from A5.1.
    // Defer R2 prefix deletion to PR6 when per-user R2 is implemented.
    console.log('[DO] R2 data deletion deferred to PR6 (per-user R2 prefixes)');
  }
}
