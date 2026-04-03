/**
 * WastelandDO — Core Durable Object for wasteland metadata, member
 * credentials, and periodic sync coordination.
 *
 * Much simpler than TownDO: no agents, beads, review queues, or convoys.
 * Manages wasteland configuration, encrypted DoltHub token storage,
 * member registry, connected towns, and an alarm loop for periodic
 * wanted board sync.
 */

import { DurableObject } from 'cloudflare:workers';

// Sub-modules (plain functions, not classes — per coding conventions)
import * as configOps from './wasteland/config';
import * as credentialOps from './wasteland/credentials';
import * as memberOps from './wasteland/members';
import * as connectedTownOps from './wasteland/connected-towns';

import type {
  WastelandConfig,
  InitWastelandInput,
  WastelandConfigUpdate,
} from './wasteland/config';
import type { WastelandCredential } from './wasteland/credentials';
import type { WastelandMember } from './wasteland/members';
import type { WastelandConnectedTown } from './wasteland/connected-towns';

// Re-export types for downstream consumers (router, etc.)
export type { WastelandConfig, InitWastelandInput, WastelandConfigUpdate };
export type { WastelandCredential };
export type { WastelandMember };
export type { WastelandConnectedTown };

// Re-export the table record types used by the router under their stub names
export type WastelandConfigResult = WastelandConfig;
export type WastelandMemberResult = WastelandMember;
export type WastelandCredentialResult = WastelandCredential;
export type WastelandConnectedTownResult = WastelandConnectedTown;

export type InitializeWastelandInput = {
  wasteland_id: string;
  name: string;
  owner_type: 'user' | 'org';
  owner_user_id: string | null;
  organization_id: string | null;
  dolthub_upstream: string | null;
  visibility: 'public' | 'private';
};

export type UpdateWastelandConfigInput = {
  name?: string;
  visibility?: 'public' | 'private';
  dolthub_upstream?: string | null;
  status?: 'active' | 'deleted';
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

const WL_LOG = '[Wasteland.do]';

// Alarm interval for periodic wanted board sync
const SYNC_ALARM_INTERVAL_MS = 5 * 60_000; // 5 minutes

export class WastelandDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    void ctx.blockConcurrencyWhile(async () => {
      this.initializeTables();
      await this.armAlarmIfNeeded();
    });
  }

  private initializeTables(): void {
    configOps.initConfigTables(this.sql);
    credentialOps.initCredentialTables(this.sql);
    memberOps.initMemberTables(this.sql);
    connectedTownOps.initConnectedTownTables(this.sql);
  }

  private get wastelandId(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  // ══════════════════════════════════════════════════════════════════
  // HTTP fetch (health + CORS)
  // ══════════════════════════════════════════════════════════════════

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // Configuration
  // ══════════════════════════════════════════════════════════════════

  async getConfig(): Promise<WastelandConfig | null> {
    return configOps.getConfig(this.sql);
  }

  async initializeWasteland(input: InitializeWastelandInput): Promise<WastelandConfig> {
    const existing = configOps.getConfig(this.sql);
    if (existing) {
      throw new Error(`Wasteland already initialized: ${existing.wasteland_id}`);
    }
    const config = configOps.initializeWasteland(this.sql, {
      wasteland_id: input.wasteland_id,
      name: input.name,
      owner_type: input.owner_type,
      owner_user_id: input.owner_user_id,
      organization_id: input.organization_id,
      dolthub_upstream: input.dolthub_upstream,
      visibility: input.visibility,
    });

    // Auto-register the owner as a member with 'owner' role
    if (input.owner_user_id) {
      memberOps.addMember(this.sql, input.owner_user_id, 'owner', 3);
    }

    console.log(`${WL_LOG} initialized wasteland ${input.wasteland_id} "${input.name}"`);
    return config;
  }

  async updateConfig(input: UpdateWastelandConfigInput): Promise<WastelandConfig> {
    const config = configOps.updateConfig(this.sql, input);
    console.log(`${WL_LOG} updated wasteland config`);
    return config;
  }

  // ══════════════════════════════════════════════════════════════════
  // Credentials
  // ══════════════════════════════════════════════════════════════════

  async storeCredential(
    userId: string,
    encryptedToken: string,
    dolthubOrg: string,
    rigHandle?: string
  ): Promise<WastelandCredential> {
    const credential = credentialOps.storeCredential(
      this.sql,
      userId,
      encryptedToken,
      dolthubOrg,
      rigHandle ?? null
    );
    console.log(`${WL_LOG} stored credential for user ${userId}`);
    return credential;
  }

  async getCredential(userId: string): Promise<WastelandCredential | null> {
    return credentialOps.getCredential(this.sql, userId);
  }

  async deleteCredential(userId: string): Promise<void> {
    credentialOps.deleteCredential(this.sql, userId);
    console.log(`${WL_LOG} deleted credential for user ${userId}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // Members
  // ══════════════════════════════════════════════════════════════════

  async addMember(userId: string, role: string, trustLevel: number): Promise<string> {
    const memberId = memberOps.addMember(this.sql, userId, role, trustLevel);
    console.log(`${WL_LOG} added member ${memberId} (user=${userId}, role=${role})`);
    return memberId;
  }

  async removeMember(memberId: string): Promise<void> {
    memberOps.removeMember(this.sql, memberId);
    console.log(`${WL_LOG} removed member ${memberId}`);
  }

  async getMember(userId: string): Promise<WastelandMember | null> {
    return memberOps.getMemberByUserId(this.sql, userId);
  }

  async updateMember(
    memberId: string,
    update: { role?: string; trust_level?: number }
  ): Promise<WastelandMember | null> {
    const member = memberOps.updateMember(this.sql, memberId, update);
    if (member) {
      console.log(`${WL_LOG} updated member ${memberId}`);
    }
    return member;
  }

  async listMembers(): Promise<WastelandMember[]> {
    return memberOps.listMembers(this.sql);
  }

  // ══════════════════════════════════════════════════════════════════
  // Connected Towns
  // ══════════════════════════════════════════════════════════════════

  async connectTown(townId: string, townName: string): Promise<WastelandConnectedTown> {
    const connection = connectedTownOps.connectTown(this.sql, townId, townName);
    console.log(`${WL_LOG} connected town ${townId}`);
    return connection;
  }

  async disconnectTown(townId: string): Promise<void> {
    connectedTownOps.disconnectTown(this.sql, townId);
    console.log(`${WL_LOG} disconnected town ${townId}`);
  }

  async listConnectedTowns(): Promise<WastelandConnectedTown[]> {
    return connectedTownOps.listConnectedTowns(this.sql);
  }

  // ══════════════════════════════════════════════════════════════════
  // Wanted Board (placeholder)
  // ══════════════════════════════════════════════════════════════════

  async getWantedBoard(): Promise<WantedItemResult[]> {
    // Wanted board is populated via the container — returns empty until refreshed
    return [];
  }

  async refreshWantedBoard(): Promise<WantedItemResult[]> {
    // Refresh requires container interaction — returns empty in this layer
    return [];
  }

  // ══════════════════════════════════════════════════════════════════
  // Alarm
  // ══════════════════════════════════════════════════════════════════

  async alarm(): Promise<void> {
    const config = configOps.getConfig(this.sql);
    if (!config || config.status === 'deleted') {
      console.log(`${WL_LOG} alarm: wasteland not active, not re-arming`);
      await this.ctx.storage.deleteAlarm();
      return;
    }

    console.log(`${WL_LOG} alarm: fired for wasteland ${this.wastelandId}`);

    // Placeholder for wanted board polling — will be implemented in Phase 3.
    // The alarm loop will:
    // 1. Fetch the wanted board from DoltHub via the WastelandContainerDO
    // 2. Compare with cached state
    // 3. Emit events for new/changed items

    // Re-arm for next cycle
    await this.armAlarmIfNeeded();
  }

  private async armAlarmIfNeeded(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + SYNC_ALARM_INTERVAL_MS);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════════════

  async destroy(): Promise<void> {
    console.log(`${WL_LOG} destroying wasteland ${this.wastelandId}`);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
