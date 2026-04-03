import { DurableObject } from 'cloudflare:workers';
import { createTableWastelandConfig } from '../db/tables/wasteland-config.table';
import { createTableWastelandMembers } from '../db/tables/wasteland-members.table';
import { createTableWastelandCredentials } from '../db/tables/wasteland-credentials.table';
import { createTableWastelandConnectedTowns } from '../db/tables/wasteland-connected-towns.table';
import { createTableWantedCache } from '../db/tables/wanted-cache.table';
import { query } from '../util/query.util';
import { fetchWantedBoard } from '../util/dolthub-api.util';
import * as configOps from './wasteland/config';
import * as memberOps from './wasteland/members';
import * as credentialOps from './wasteland/credentials';
import * as connectedTownOps from './wasteland/connected-towns';
import * as wantedCacheOps from './wasteland/wanted-cache';

const LOG = '[WastelandDO]';

/** Polling interval for the alarm loop: 5 minutes. */
const ALARM_INTERVAL_MS = 5 * 60 * 1000;

// ── Exported types ─────────────────────────────────────────────────────

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

/** Shape returned by WastelandDO connected-town RPCs — matches the wasteland_connected_towns table. */
export type ConnectedTownResult = {
  town_id: string;
  wasteland_id: string;
  connected_by: string;
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

// ── WastelandDO ───────────────────────────────────────────────────────

/**
 * WastelandDO — per-wasteland Durable Object with SQLite storage.
 *
 * Manages wasteland configuration, members, credentials, connected towns,
 * and a wanted board cache. Polls DoltHub periodically via an alarm loop
 * to keep the wanted cache fresh, enabling instant reads without waking
 * the Container.
 */
export class WastelandDO extends DurableObject<Env> {
  private sql: SqlStorage;
  /** The wasteland_id once initialized — cached from config for alarm use. */
  private wastelandId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    void ctx.blockConcurrencyWhile(async () => {
      this.initializeDatabase();
      // Cache the wasteland_id if config exists (for alarm)
      this.loadWastelandId();
    });
  }

  /** Create all SQLite tables. Idempotent via CREATE TABLE IF NOT EXISTS. */
  private initializeDatabase(): void {
    query(this.sql, createTableWastelandConfig(), []);
    query(this.sql, createTableWastelandMembers(), []);
    query(this.sql, createTableWastelandCredentials(), []);
    query(this.sql, createTableWastelandConnectedTowns(), []);
    query(this.sql, createTableWantedCache(), []);
  }

  /** Load the wasteland_id from config (if initialized). */
  private loadWastelandId(): void {
    const rows = [
      ...query(this.sql, /* sql */ `SELECT wasteland_id FROM wasteland_config LIMIT ?`, [1]),
    ];
    if (rows.length > 0) {
      const row = rows[0] as Record<string, unknown>;
      this.wastelandId = String(row.wasteland_id);
    }
  }

  // ── Alarm ─────────────────────────────────────────────────────────

  /**
   * Alarm handler — polls DoltHub for wanted board state and caches locally.
   * Self-rearming: always schedules the next alarm at the end.
   */
  async alarm(): Promise<void> {
    // Load wasteland id if not cached yet
    if (!this.wastelandId) {
      this.loadWastelandId();
    }
    if (!this.wastelandId) {
      console.log(`${LOG} alarm: no wasteland configured, not re-arming`);
      return;
    }

    const config = configOps.getConfig(this.sql, this.wastelandId);
    if (!config || config.status !== 'active' || !config.dolthub_upstream) {
      console.log(`${LOG} alarm: inactive or no upstream, not polling`);
      return;
    }

    try {
      const items = await fetchWantedBoard(config.dolthub_upstream);
      wantedCacheOps.cacheWantedItems(this.sql, items);
      console.log(`${LOG} alarm: cached ${items.length} wanted items`);
    } catch (err) {
      console.error(`${LOG} alarm polling failed`, err);
    }

    // Schedule next alarm
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  // ── Config RPCs ──────────────────────────────────────────────────

  async initializeWasteland(input: InitializeWastelandInput): Promise<WastelandConfigResult> {
    const config = configOps.insertConfig(this.sql, input);
    this.wastelandId = input.wasteland_id;

    // Auto-register the owner as a member
    if (input.owner_user_id) {
      memberOps.addMember(this.sql, input.owner_user_id, 'owner', 3);
    }

    // Start the alarm loop if there's an upstream to poll
    if (input.dolthub_upstream) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }

    return config;
  }

  async getConfig(): Promise<WastelandConfigResult | null> {
    if (!this.wastelandId) {
      this.loadWastelandId();
    }
    if (!this.wastelandId) return null;
    return configOps.getConfig(this.sql, this.wastelandId);
  }

  async updateConfig(input: UpdateWastelandConfigInput): Promise<WastelandConfigResult> {
    if (!this.wastelandId) {
      this.loadWastelandId();
    }
    if (!this.wastelandId) {
      throw new Error('Wasteland not initialized');
    }
    const config = configOps.updateConfig(this.sql, this.wastelandId, input);

    // If dolthub_upstream was set/changed, ensure alarm is armed
    if (input.dolthub_upstream !== undefined && input.dolthub_upstream) {
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (!currentAlarm) {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
      }
    }

    return config;
  }

  // ── Member management RPCs ──────────────────────────────────────────

  async listMembers(): Promise<WastelandMemberResult[]> {
    return memberOps.listMembers(this.sql);
  }

  async addMember(userId: string, role: string, trustLevel: number): Promise<string> {
    return memberOps.addMember(this.sql, userId, role, trustLevel);
  }

  async removeMember(memberId: string): Promise<void> {
    memberOps.removeMember(this.sql, memberId);
  }

  async getMember(userId: string): Promise<WastelandMemberResult | null> {
    return memberOps.getMember(this.sql, userId);
  }

  async updateMember(
    memberId: string,
    update: { role?: string; trust_level?: number }
  ): Promise<WastelandMemberResult | null> {
    return memberOps.updateMember(this.sql, memberId, update);
  }

  // ── Credential management RPCs ──────────────────────────────────────

  async storeCredential(
    userId: string,
    encryptedToken: string,
    dolthubOrg: string,
    rigHandle?: string
  ): Promise<WastelandCredentialResult> {
    return credentialOps.storeCredential(
      this.sql,
      userId,
      encryptedToken,
      dolthubOrg,
      rigHandle
    );
  }

  async getCredential(userId: string): Promise<WastelandCredentialResult | null> {
    return credentialOps.getCredential(this.sql, userId);
  }

  async deleteCredential(userId: string): Promise<void> {
    credentialOps.deleteCredential(this.sql, userId);
  }

  // ── Connected towns RPCs ─────────────────────────────────────────────

  async connectTown(townId: string, userId: string): Promise<ConnectedTownResult> {
    if (!this.wastelandId) {
      this.loadWastelandId();
    }
    if (!this.wastelandId) {
      throw new Error('Wasteland not initialized');
    }
    return connectedTownOps.connectTown(this.sql, townId, this.wastelandId, userId);
  }

  async disconnectTown(townId: string): Promise<void> {
    connectedTownOps.disconnectTown(this.sql, townId);
  }

  async listConnectedTowns(): Promise<ConnectedTownResult[]> {
    return connectedTownOps.listConnectedTowns(this.sql);
  }

  // ── Wanted board cache RPCs ─────────────────────────────────────────

  /** Return cached wanted items for fast reads. */
  async getWantedBoard(): Promise<WantedItemResult[]> {
    const cached = wantedCacheOps.getCachedWantedItems(this.sql);
    return cached.map(toWantedItemResult);
  }

  /**
   * Force-refresh the wanted board cache from DoltHub and return updated items.
   * Falls back to existing cache if the DoltHub fetch fails.
   */
  async refreshWantedBoard(): Promise<WantedItemResult[]> {
    if (!this.wastelandId) {
      this.loadWastelandId();
    }
    if (!this.wastelandId) {
      return [];
    }

    const config = configOps.getConfig(this.sql, this.wastelandId);
    if (!config?.dolthub_upstream) {
      return this.getWantedBoard();
    }

    try {
      const items = await fetchWantedBoard(config.dolthub_upstream);
      wantedCacheOps.cacheWantedItems(this.sql, items);
      console.log(`${LOG} refreshWantedBoard: cached ${items.length} items`);
    } catch (err) {
      console.error(`${LOG} refreshWantedBoard failed, returning stale cache`, err);
    }

    return this.getWantedBoard();
  }
}

/**
 * Map a WantedCacheRecord to the WantedItemResult shape expected by consumers.
 * Fills in defaults for fields that may be null from the cache.
 */
function toWantedItemResult(
  record: wantedCacheOps.WantedItem & { cached_at?: string }
): WantedItemResult {
  return {
    item_id: record.item_id,
    title: record.title,
    description: record.description ?? '',
    status: (record.status === 'open' || record.status === 'claimed' || record.status === 'done'
      ? record.status
      : 'open') as 'open' | 'claimed' | 'done',
    // DoltHub wanted table may not have priority/type columns —
    // default to 'medium' / 'other' when absent.
    priority: 'medium',
    type: 'other',
    claimed_by: record.claimed_by ?? null,
    evidence: record.evidence ?? null,
    created_at: record.created_at ?? new Date().toISOString(),
    updated_at: record.updated_at ?? new Date().toISOString(),
  };
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
