/**
 * KiloClawApp Durable Object
 *
 * Manages the per-user Fly App lifecycle: creation, IP allocation, and deletion.
 * Keyed by userId: env.KILOCLAW_APP.idFromName(userId) — one per user.
 *
 * Separate from KiloClawInstance to support future multi-instance per user,
 * where one Fly App contains multiple instances (machines + volumes).
 *
 * The App DO ensures that each user has a Fly App with allocated IPs before
 * any machines are created. ensureApp() is idempotent: safe to call multiple
 * times, only creates the app + IPs on first call.
 *
 * If allocation partially fails, the alarm retries.
 */

import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import type { KiloClawEnv } from '../types';
import * as apps from '../fly/apps';

// -- Persisted state schema --

const AppStateSchema = z.object({
  userId: z.string().default(''),
  flyAppName: z.string().nullable().default(null),
  ipv4Allocated: z.boolean().default(false),
  ipv6Allocated: z.boolean().default(false),
});

type AppState = z.infer<typeof AppStateSchema>;

const STORAGE_KEYS = Object.keys(AppStateSchema.shape);

/** How often to retry incomplete setup (IP allocation failures). */
const RETRY_ALARM_MS = 60 * 1000; // 1 min

// -- DO --

export class KiloClawApp extends DurableObject<KiloClawEnv> {
  private loaded = false;
  private userId: string | null = null;
  private flyAppName: string | null = null;
  private ipv4Allocated = false;
  private ipv6Allocated = false;

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
    }

    this.loaded = true;
  }

  /**
   * Ensure a Fly App exists for this user with IPs allocated.
   * Idempotent: creates the app only if it doesn't exist yet.
   * Returns the app name for callers to cache.
   */
  async ensureApp(userId: string): Promise<{ appName: string }> {
    await this.loadState();

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
          await apps.createApp({ apiToken }, appName, orgSlug);
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
    } catch (err) {
      // Partial state persisted above — arm a retry alarm so the DO self-heals
      // even if the caller doesn't retry.
      if (!this.ipv4Allocated || !this.ipv6Allocated) {
        await this.ctx.storage.setAlarm(Date.now() + RETRY_ALARM_MS);
        console.error('[AppDO] Partial failure, retry alarm armed for:', appName, err);
      }
      throw err;
    }

    return { appName };
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
    this.loaded = false;
  }

  /**
   * Alarm: retry incomplete IP allocation.
   */
  override async alarm(): Promise<void> {
    await this.loadState();

    if (!this.userId || !this.flyAppName) return;
    if (this.ipv4Allocated && this.ipv6Allocated) return;

    console.log('[AppDO] Retrying incomplete setup for:', this.flyAppName);

    try {
      await this.ensureApp(this.userId);
    } catch (err) {
      console.error('[AppDO] Retry failed, rescheduling:', err);
      await this.ctx.storage.setAlarm(Date.now() + RETRY_ALARM_MS);
    }
  }
}
