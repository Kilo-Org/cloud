/**
 * KiloClawApp Durable Object
 *
 * Manages the per-user Fly App lifecycle: creation, IP allocation, env key setup, and deletion.
 * Keyed by userId: env.KILOCLAW_APP.idFromName(userId) — one per user.
 *
 * Separate from KiloClawInstance to support future multi-instance per user,
 * where one Fly App contains multiple instances (machines + volumes).
 *
 * The App DO ensures that each user has a Fly App with allocated IPs and
 * an encryption key before any machines are created. ensureApp() is idempotent:
 * safe to call multiple times, only creates the app + IPs + key on first call.
 *
 * If setup partially fails, the alarm retries.
 */

import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import type { KiloClawEnv } from '../types';
import * as apps from '../fly/apps';
import { setAppSecret } from '../fly/secrets';
import { generateEnvKey } from '../utils/env-encryption';
import { METADATA_KEY_USER_ID } from './kiloclaw-instance';

// -- Persisted state schema --

const AppStateSchema = z.object({
  userId: z.string().default(''),
  flyAppName: z.string().nullable().default(null),
  ipv4Allocated: z.boolean().default(false),
  ipv6Allocated: z.boolean().default(false),
  envKeySet: z.boolean().default(false),
  envKey: z.string().nullable().default(null),
});

type AppState = z.infer<typeof AppStateSchema>;

const STORAGE_KEYS = Object.keys(AppStateSchema.shape);

/** How often to retry incomplete setup (IP allocation / env key failures). */
const RETRY_ALARM_MS = 60 * 1000; // 1 min

/** Name of the Fly app secret that holds the AES encryption key. */
const ENV_KEY_SECRET_NAME = 'KILOCLAW_ENV_KEY';

// -- DO --

export class KiloClawApp extends DurableObject<KiloClawEnv> {
  private loaded = false;
  private userId: string | null = null;
  private flyAppName: string | null = null;
  private ipv4Allocated = false;
  private ipv6Allocated = false;
  private envKeySet = false;
  private envKey: string | null = null;

  private async loadState(): Promise<void> {
    if (this.loaded) return;

    const entries = await this.ctx.storage.get(STORAGE_KEYS);
    const raw = Object.fromEntries(entries.entries());
    const parsed = AppStateSchema.safeParse(raw);

    if (parsed.success) {
      const s = parsed.data;
      this.userId = s.userId || null;
      this.flyAppName = s.flyAppName;
      this.ipv4Allocated = s.ipv4Allocated;
      this.ipv6Allocated = s.ipv6Allocated;
      this.envKeySet = s.envKeySet;
      this.envKey = s.envKey;
    }

    this.loaded = true;
  }

  /** Check if all setup steps are complete. */
  private isSetupComplete(): boolean {
    return this.ipv4Allocated && this.ipv6Allocated && this.envKeySet;
  }

  /**
   * Ensure a Fly App exists for this user with IPs allocated and env key set.
   * Idempotent: creates the app only if it doesn't exist yet.
   * Returns the app name for callers to cache.
   */
  async ensureApp(userId: string): Promise<{ appName: string }> {
    await this.loadState();

    if (this.userId && this.userId !== userId) {
      throw new Error(`userId mismatch: DO has ${this.userId}, caller passed ${userId}`);
    }

    const apiToken = this.env.FLY_API_TOKEN;
    if (!apiToken) throw new Error('FLY_API_TOKEN is not configured');
    const orgSlug = this.env.FLY_ORG_SLUG;
    if (!orgSlug) throw new Error('FLY_ORG_SLUG is not configured');

    // Derive app name (deterministic from userId, with env prefix in dev)
    const prefix = this.env.WORKER_ENV === 'development' ? 'dev' : undefined;
    const appName = this.flyAppName ?? (await apps.appNameFromUserId(userId, prefix));

    // Persist userId + appName early so we can retry on partial failure
    if (!this.userId || !this.flyAppName) {
      this.userId = userId;
      this.flyAppName = appName;
      await this.ctx.storage.put({
        userId,
        flyAppName: appName,
      } satisfies Partial<AppState>);
    }

    try {
      // Step 1: Create app if it doesn't exist
      if (!this.ipv4Allocated || !this.ipv6Allocated) {
        const existing = await apps.getApp({ apiToken }, appName);
        if (!existing) {
          await apps.createApp({ apiToken }, appName, orgSlug, userId, METADATA_KEY_USER_ID);
          console.log('[AppDO] Created Fly App:', appName);
        }
      }

      // Step 2: Allocate IPv6 if not done
      if (!this.ipv6Allocated) {
        await apps.allocateIP(apiToken, appName, 'v6');
        this.ipv6Allocated = true;
        await this.ctx.storage.put({ ipv6Allocated: true } satisfies Partial<AppState>);
        console.log('[AppDO] Allocated IPv6 for:', appName);
      }

      // Step 3: Allocate shared IPv4 if not done
      if (!this.ipv4Allocated) {
        await apps.allocateIP(apiToken, appName, 'shared_v4');
        this.ipv4Allocated = true;
        await this.ctx.storage.put({ ipv4Allocated: true } satisfies Partial<AppState>);
        console.log('[AppDO] Allocated shared IPv4 for:', appName);
      }

      // Step 4: Generate and store env encryption key if not done.
      // Uses the same locked path as ensureEnvKey() to prevent interleaving.
      if (!this.envKeySet) {
        await this.ensureEnvKey(userId);
      }
    } catch (err) {
      // Partial state persisted above — arm a retry alarm so the DO self-heals
      // even if the caller doesn't retry.
      if (!this.isSetupComplete()) {
        await this.ctx.storage.setAlarm(Date.now() + RETRY_ALARM_MS);
        console.error('[AppDO] Partial failure, retry alarm armed for:', appName, err);
      }
      throw err;
    }

    return { appName };
  }

  /**
   * Get the env encryption key for this user's app.
   * Enforces userId match to prevent cross-user key fetches.
   * Returns null if key hasn't been set yet.
   */
  async getEnvKey(userId: string): Promise<string | null> {
    await this.loadState();

    if (this.userId && this.userId !== userId) {
      throw new Error(`userId mismatch: DO has ${this.userId}, caller passed ${userId}`);
    }

    return this.envKey;
  }

  /**
   * Ensure the env encryption key exists, creating it if needed.
   * Always re-sets the Fly app secret (idempotent) to self-heal if the
   * secret was deleted externally.
   *
   * Interleaving safety: the key is generated and persisted to in-memory state
   * + durable storage before the setAppSecret() fetch. Any interleaved call
   * entering during the await will see this.envKey already set and reuse it,
   * so no two calls can generate different keys.
   *
   * Called by Instance DO at machine start time. This ensures legacy apps that
   * were created before the encryption feature get their key on first start.
   */
  async ensureEnvKey(userId: string): Promise<{ key: string; secretsVersion: number }> {
    await this.loadState();

    if (this.userId && this.userId !== userId) {
      throw new Error(`userId mismatch: DO has ${this.userId}, caller passed ${userId}`);
    }

    const apiToken = this.env.FLY_API_TOKEN;
    if (!apiToken) throw new Error('FLY_API_TOKEN is not configured');

    if (!this.flyAppName) {
      throw new Error('Cannot create env key: Fly App not yet created (call ensureApp first)');
    }

    // Persist key before any async I/O so interleaved calls reuse the same key.
    // envKeySet: false means "key generated but not yet confirmed in Fly."
    if (!this.envKey) {
      this.envKey = generateEnvKey();
      await this.ctx.storage.put({
        envKey: this.envKey,
        envKeySet: false,
      } satisfies Partial<AppState>);
    }

    // Always re-set the Fly secret (idempotent) to self-heal if deleted externally.
    // Returns the secrets version for use with min_secrets_version on machine create/update.
    const { version: secretsVersion } = await setAppSecret(
      { apiToken, appName: this.flyAppName },
      ENV_KEY_SECRET_NAME,
      this.envKey
    );

    if (!this.envKeySet) {
      this.envKeySet = true;
      await this.ctx.storage.put({ envKeySet: true } satisfies Partial<AppState>);
      console.log('[AppDO] Set env encryption key for:', this.flyAppName);
    }

    return { key: this.envKey, secretsVersion };
  }

  /**
   * Get the stored app name, or null if not yet created.
   */
  async getAppName(): Promise<string | null> {
    await this.loadState();
    return this.flyAppName;
  }

  /**
   * Delete the Fly App entirely.
   * For future use (e.g. account deletion). Not called on instance destroy.
   */
  async destroyApp(): Promise<void> {
    await this.loadState();

    if (!this.flyAppName) return;

    const apiToken = this.env.FLY_API_TOKEN;
    if (!apiToken) throw new Error('FLY_API_TOKEN is not configured');

    await apps.deleteApp({ apiToken }, this.flyAppName);
    console.log('[AppDO] Deleted Fly App:', this.flyAppName);

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();

    this.userId = null;
    this.flyAppName = null;
    this.ipv4Allocated = false;
    this.ipv6Allocated = false;
    this.envKeySet = false;
    this.envKey = null;
    this.loaded = false;
  }

  /**
   * Alarm: retry incomplete setup (IP allocation + env key).
   */
  override async alarm(): Promise<void> {
    await this.loadState();

    if (!this.userId || !this.flyAppName) return;
    if (this.isSetupComplete()) return;

    console.log('[AppDO] Retrying incomplete setup for:', this.flyAppName);

    try {
      await this.ensureApp(this.userId);
    } catch (err) {
      console.error('[AppDO] Retry failed, rescheduling:', err);
      await this.ctx.storage.setAlarm(Date.now() + RETRY_ALARM_MS);
    }
  }
}
