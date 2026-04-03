/**
 * WastelandDO — per-wasteland Durable Object.
 *
 * Manages config, members, credentials, connected towns, and wanted board cache.
 * The alarm loop periodically polls DoltHub for wanted board state and caches
 * results in local SQLite for fast reads.
 */
import { DurableObject } from 'cloudflare:workers';
import * as configOps from './wasteland/config';
import * as memberOps from './wasteland/members';
import * as credentialOps from './wasteland/credentials';
import * as connectedTownOps from './wasteland/connected-towns';
import * as wantedCacheOps from './wasteland/wanted-cache';
import { fetchWantedBoard } from '../util/dolthub-api.util';
import type { WastelandConfigRecord } from '../db/tables/wasteland-config.table';
import type { WastelandMemberRecord } from '../db/tables/wasteland-members.table';
import type { WastelandCredentialRecord } from '../db/tables/wasteland-credentials.table';
import type { ConnectedTownRecord } from '../db/tables/wasteland-connected-towns.table';
import type { WantedCacheRecord } from '../db/tables/wasteland-wanted-cache.table';

// ── Type exports ────────────────────────────────────────────────────────
// These types are used by the tRPC router and other callers.

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

const LOG = '[WastelandDO]';

/** Polling interval for the alarm loop: 5 minutes. */
const ALARM_INTERVAL_MS = 5 * 60 * 1000;

export class WastelandDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    void ctx.blockConcurrencyWhile(async () => {
      this.initializeDatabase();
      await this.armAlarmIfNeeded();
    });
  }

  private initializeDatabase(): void {
    configOps.initConfigTable(this.sql);
    memberOps.initMembersTable(this.sql);
    credentialOps.initCredentialsTable(this.sql);
    connectedTownOps.initConnectedTownsTable(this.sql);
    wantedCacheOps.initWantedCacheTable(this.sql);
  }

  // ── Alarm ───────────────────────────────────────────────────────────

  /**
   * Arm the alarm loop if the wasteland is configured and active.
   * Called after DB init and after config changes that enable polling.
   */
  private async armAlarmIfNeeded(): Promise<void> {
    const config = configOps.getConfig(this.sql);
    if (!config || config.status !== 'active' || !config.dolthub_upstream) {
      return;
    }

    const current = await this.ctx.storage.getAlarm();
    if (!current || current < Date.now()) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  async alarm(): Promise<void> {
    const config = configOps.getConfig(this.sql);
    if (!config || config.status !== 'active' || !config.dolthub_upstream) {
      return; // No polling for inactive or unconfigured wastelands
    }

    try {
      const items = await fetchWantedBoard(config.dolthub_upstream);
      wantedCacheOps.cacheWantedItems(this.sql, items);
    } catch (err) {
      console.error(`${LOG} alarm polling failed`, err);
    }

    // Re-arm: poll again in 5 minutes
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  // ── Config RPCs ─────────────────────────────────────────────────────

  async initializeWasteland(input: InitializeWastelandInput): Promise<WastelandConfigRecord> {
    const config = configOps.insertConfig(this.sql, input);

    // Schedule the first alarm 1s after creation if upstream is configured
    if (input.dolthub_upstream) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }

    return config;
  }

  async getConfig(): Promise<WastelandConfigRecord | null> {
    return configOps.getConfig(this.sql);
  }

  async updateConfig(input: UpdateWastelandConfigInput): Promise<WastelandConfigRecord> {
    const existing = configOps.getConfig(this.sql);
    if (!existing) {
      throw new Error('Wasteland not initialized — cannot update config');
    }
    const config = configOps.updateConfig(this.sql, existing.wasteland_id, input);

    // If dolthub_upstream was just set, ensure alarm is running
    if (input.dolthub_upstream !== undefined) {
      await this.armAlarmIfNeeded();
    }

    return config;
  }

  // ── Member RPCs ─────────────────────────────────────────────────────

  async listMembers(): Promise<WastelandMemberRecord[]> {
    return memberOps.listMembers(this.sql);
  }

  async addMember(userId: string, role: string, trustLevel: number): Promise<string> {
    return memberOps.addMember(this.sql, userId, role, trustLevel);
  }

  async removeMember(memberId: string): Promise<void> {
    memberOps.removeMember(this.sql, memberId);
  }

  async getMember(userId: string): Promise<WastelandMemberRecord | null> {
    return memberOps.getMember(this.sql, userId);
  }

  async updateMember(
    memberId: string,
    update: { role?: string; trust_level?: number }
  ): Promise<WastelandMemberRecord | null> {
    return memberOps.updateMember(this.sql, memberId, update);
  }

  // ── Credential RPCs ────────────────────────────────────────────────

  async storeCredential(
    userId: string,
    encryptedToken: string,
    dolthubOrg: string,
    rigHandle?: string
  ): Promise<WastelandCredentialRecord> {
    return credentialOps.storeCredential(this.sql, userId, encryptedToken, dolthubOrg, rigHandle);
  }

  async getCredential(userId: string): Promise<WastelandCredentialRecord | null> {
    return credentialOps.getCredential(this.sql, userId);
  }

  async deleteCredential(userId: string): Promise<void> {
    credentialOps.deleteCredential(this.sql, userId);
  }

  // ── Connected Towns RPCs ────────────────────────────────────────────

  async connectTown(townId: string, userId: string): Promise<ConnectedTownRecord> {
    const config = configOps.getConfig(this.sql);
    const wastelandId = config?.wasteland_id ?? '';
    return connectedTownOps.connectTown(this.sql, townId, wastelandId, userId);
  }

  async disconnectTown(townId: string): Promise<void> {
    connectedTownOps.disconnectTown(this.sql, townId);
  }

  async listConnectedTowns(): Promise<ConnectedTownRecord[]> {
    return connectedTownOps.listConnectedTowns(this.sql);
  }

  // ── Wanted Board RPCs ──────────────────────────────────────────────

  async getWantedBoard(): Promise<WantedCacheRecord[]> {
    return wantedCacheOps.getCachedWantedItems(this.sql);
  }

  async refreshWantedBoard(): Promise<WantedCacheRecord[]> {
    const config = configOps.getConfig(this.sql);
    if (!config?.dolthub_upstream) {
      return wantedCacheOps.getCachedWantedItems(this.sql);
    }

    const items = await fetchWantedBoard(config.dolthub_upstream);
    wantedCacheOps.cacheWantedItems(this.sql, items);
    return wantedCacheOps.getCachedWantedItems(this.sql);
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
