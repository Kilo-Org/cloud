import { DurableObject } from 'cloudflare:workers';
import { getWastelandContainerStub } from './WastelandContainer.do';
import { writeEvent } from '../util/analytics.util';
import { logger, withLogTags } from '../util/log.util';

/** Shape returned by WastelandDO.getConfig() — matches the wasteland_config table. */
export type WastelandConfigResult = {
  wasteland_id: string;
  name: string;
  owner_type: 'user' | 'org';
  owner_user_id: string | null;
  organization_id: string | null;
  dolthub_upstream: string | null;
  visibility: 'public' | 'private';
  status: 'active' | 'deleted';
  created_at: string;
  updated_at: string;
};

/** Shape returned by WastelandDO member RPCs — matches the wasteland_members table. */
export type WastelandMemberResult = {
  member_id: string;
  user_id: string;
  trust_level: number;
  role: 'contributor' | 'maintainer' | 'owner';
  joined_at: string;
};

/** Input for initializeWasteland — creates the wasteland config row. */
export type InitializeWastelandInput = {
  wasteland_id: string;
  name: string;
  owner_type: 'user' | 'org';
  owner_user_id: string | null;
  organization_id: string | null;
  dolthub_upstream: string | null;
  visibility: 'public' | 'private';
};

/** Partial update fields for updateConfig. */
export type UpdateWastelandConfigInput = {
  name?: string;
  visibility?: 'public' | 'private';
  dolthub_upstream?: string | null;
  status?: 'active' | 'deleted';
};

/** Shape returned by WastelandDO credential RPCs — matches the wasteland_credentials table. */
export type WastelandCredentialResult = {
  user_id: string;
  encrypted_token: string;
  dolthub_org: string;
  rig_handle: string | null;
  connected_at: string;
};

/** Shape for a wanted board item returned from the DoltHub-backed cache. */
export type WantedItemResult = {
  item_id: string;
  title: string;
  description: string;
  status: 'open' | 'claimed' | 'done';
  priority: 'low' | 'medium' | 'high' | 'critical';
  type: 'feature' | 'bug' | 'docs' | 'other';
  claimed_by: string | null;
  evidence: string | null;
  created_at: string;
  updated_at: string;
};

/** Health status returned from the container's /health endpoint. */
export type ContainerHealthResult = {
  status: 'ok' | 'initializing' | 'unreachable' | 'error';
  wl_version?: string;
  wl_configured?: boolean;
  last_operation?: string | null;
  uptime_seconds?: number;
  cold_start_recovery?: boolean;
  join_error?: string | null;
  error?: string;
};

const ALARM_INTERVAL_MS = 5 * 60_000; // 5 minutes
const CONTAINER_HEALTH_TIMEOUT_MS = 10_000;

/**
 * Stub WastelandDO — placeholder until the full implementation lands.
 * Provides the class export that wrangler.jsonc requires for the
 * WASTELAND durable_objects binding, plus RPC method signatures that
 * downstream tRPC code depends on.
 */
export class WastelandDO extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ error: 'WastelandDO not yet implemented' }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async initializeWasteland(_input: InitializeWastelandInput): Promise<WastelandConfigResult> {
    throw new Error('WastelandDO not yet implemented');
  }

  async getConfig(): Promise<WastelandConfigResult | null> {
    throw new Error('WastelandDO not yet implemented');
  }

  async updateConfig(_input: UpdateWastelandConfigInput): Promise<WastelandConfigResult> {
    throw new Error('WastelandDO not yet implemented');
  }

  // ── Member management RPCs ──────────────────────────────────────────

  async listMembers(): Promise<WastelandMemberResult[]> {
    throw new Error('WastelandDO not yet implemented');
  }

  async addMember(_userId: string, _role: string, _trustLevel: number): Promise<string> {
    throw new Error('WastelandDO not yet implemented');
  }

  async removeMember(_memberId: string): Promise<void> {
    throw new Error('WastelandDO not yet implemented');
  }

  async getMember(_userId: string): Promise<WastelandMemberResult | null> {
    throw new Error('WastelandDO not yet implemented');
  }

  async updateMember(
    _memberId: string,
    _update: { role?: string; trust_level?: number }
  ): Promise<WastelandMemberResult | null> {
    throw new Error('WastelandDO not yet implemented');
  }

  // ── Credential management RPCs ──────────────────────────────────────

  async storeCredential(
    _userId: string,
    _encryptedToken: string,
    _dolthubOrg: string,
    _rigHandle?: string
  ): Promise<WastelandCredentialResult> {
    throw new Error('WastelandDO not yet implemented');
  }

  async getCredential(_userId: string): Promise<WastelandCredentialResult | null> {
    throw new Error('WastelandDO not yet implemented');
  }

  async deleteCredential(_userId: string): Promise<void> {
    throw new Error('WastelandDO not yet implemented');
  }

  // ── Wanted board cache RPCs ─────────────────────────────────────────

  async getWantedBoard(): Promise<WantedItemResult[]> {
    throw new Error('WastelandDO not yet implemented');
  }

  async refreshWantedBoard(): Promise<WantedItemResult[]> {
    throw new Error('WastelandDO not yet implemented');
  }

  // ── Alarm: container health monitoring ─────────────────────────────

  /**
   * Arm the periodic alarm. Call this after initialization or when
   * the alarm should be (re-)started. Idempotent — no-ops if an alarm
   * is already scheduled.
   */
  async armAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  /**
   * Alarm handler — runs every 5 minutes. Performs container health
   * checks and reschedules itself.
   */
  async alarm(): Promise<void> {
    await withLogTags({ source: 'WastelandDO.alarm' }, async () => {
      const wastelandId = this.ctx.id.name ?? this.ctx.id.toString();
      logger.setTags({ wastelandId });

      try {
        const health = await this.checkContainerHealth();

        if (health.status === 'unreachable' || health.status === 'error') {
          logger.warn('container health check failed', {
            status: health.status,
            error: health.error,
          });
          writeEvent(this.env, {
            event: 'container.health_check_failed',
            wastelandId,
            error: health.error,
          });
        } else {
          // Track cold-start recoveries
          if (health.cold_start_recovery) {
            logger.info('container recovered from cold start', {
              uptime_seconds: health.uptime_seconds,
              join_error: health.join_error,
            });
            writeEvent(this.env, {
              event: 'container.cold_start_recovery',
              wastelandId,
              label: health.join_error ? 'join_failed' : 'join_succeeded',
            });
          }
        }
      } catch (err) {
        logger.error('alarm: unexpected error during container health check', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Reschedule
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    });
  }

  /**
   * Check the container's health endpoint. Returns a structured result
   * regardless of whether the container is reachable.
   */
  async checkContainerHealth(): Promise<ContainerHealthResult> {
    const wastelandId = this.ctx.id.name ?? this.ctx.id.toString();
    try {
      const container = getWastelandContainerStub(this.env, wastelandId);
      const res = await container.fetch('http://container/health', {
        signal: AbortSignal.timeout(CONTAINER_HEALTH_TIMEOUT_MS),
      });

      if (!res.ok) {
        return {
          status: 'error',
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }

      const body = (await res.json()) as Record<string, unknown>;
      return {
        status: (body.status as string) === 'ok' ? 'ok' : 'initializing',
        wl_version: body.wl_version as string | undefined,
        wl_configured: body.wl_configured as boolean | undefined,
        last_operation: body.last_operation as string | null | undefined,
        uptime_seconds: body.uptime_seconds as number | undefined,
        cold_start_recovery: body.cold_start_recovery as boolean | undefined,
        join_error: body.join_error as string | null | undefined,
      };
    } catch (err) {
      // Container not running or unreachable — not necessarily an error.
      // The container may be sleeping (sleepAfter: 30m) which is expected.
      return {
        status: 'unreachable',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
