import { DurableObject } from 'cloudflare:workers';
import { query } from '../util/query.util';
import {
  createTableWastelandConfig,
  WastelandConfigRecord,
} from '../db/tables/wasteland-config.table';
import {
  createTableWastelandCredentials,
  WastelandCredentialRecord,
} from '../db/tables/wasteland-credentials.table';
import {
  createTableWastelandMembers,
  WastelandMemberRecord,
} from '../db/tables/wasteland-members.table';

// Sub-modules (plain functions — per AGENTS.md conventions)
import * as configOps from './wasteland/config';
import * as credentialOps from './wasteland/credentials';
import * as memberOps from './wasteland/members';

// Re-export types used by downstream code (tRPC router, ownership checks)
export type { WastelandConfigRecord as WastelandConfigResult };
export type { WastelandCredentialRecord as WastelandCredentialResult };
export type { WastelandMemberRecord as WastelandMemberResult };
export type { InitWastelandInput as InitializeWastelandInput } from './wasteland/config';
export type { UpdateConfigInput as UpdateWastelandConfigInput } from './wasteland/config';

// Re-export types from stub that downstream code may depend on
export type ConnectedTownResult = {
  town_id: string;
  wasteland_id: string;
  connected_by: string;
  connected_at: string;
};

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

const LOG = '[Wasteland.do]';

/**
 * WastelandDO — per-wasteland Durable Object that stores config, members,
 * and credentials in SQLite. Each wasteland gets its own DO instance
 * (keyed by wasteland_id).
 *
 * Sub-module structure:
 * - wasteland/config.ts     — getConfig, initializeWasteland, updateConfig
 * - wasteland/credentials.ts — storeCredential, getCredential, deleteCredential
 * - wasteland/members.ts    — addMember, removeMember, listMembers, getMember
 */
export class WastelandDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private initPromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    void ctx.blockConcurrencyWhile(async () => {
      await this.ensureInitialized();
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeDatabase();
    }
    await this.initPromise;
  }

  private async initializeDatabase(): Promise<void> {
    query(this.sql, createTableWastelandConfig(), []);
    query(this.sql, createTableWastelandCredentials(), []);
    query(this.sql, createTableWastelandMembers(), []);
  }

  // ── Config RPCs ──────────────────────────────────────────────────────

  async getConfig(): Promise<WastelandConfigRecord | null> {
    await this.ensureInitialized();
    return configOps.getConfig(this.sql);
  }

  async initializeWasteland(
    input: configOps.InitWastelandInput
  ): Promise<WastelandConfigRecord> {
    await this.ensureInitialized();
    configOps.initializeWasteland(this.sql, input);
    const config = configOps.getConfig(this.sql);
    if (!config) throw new Error('Failed to initialize wasteland config');
    console.log(`${LOG} initializeWasteland: wasteland_id=${input.wasteland_id}`);
    return config;
  }

  async updateConfig(
    update: configOps.UpdateConfigInput
  ): Promise<WastelandConfigRecord> {
    await this.ensureInitialized();
    configOps.updateConfig(this.sql, update);
    const config = configOps.getConfig(this.sql);
    if (!config) throw new Error('Config not found after update');
    return config;
  }

  // ── Credential RPCs ──────────────────────────────────────────────────

  async storeCredential(
    userId: string,
    encryptedToken: string,
    dolthubOrg: string,
    rigHandle?: string
  ): Promise<WastelandCredentialRecord> {
    await this.ensureInitialized();
    credentialOps.storeCredential(this.sql, userId, encryptedToken, dolthubOrg, rigHandle);
    const credential = credentialOps.getCredential(this.sql, userId);
    if (!credential) throw new Error('Failed to store credential');
    return credential;
  }

  async getCredential(userId: string): Promise<WastelandCredentialRecord | null> {
    await this.ensureInitialized();
    return credentialOps.getCredential(this.sql, userId);
  }

  async deleteCredential(userId: string): Promise<void> {
    await this.ensureInitialized();
    credentialOps.deleteCredential(this.sql, userId);
  }

  // ── Member RPCs ──────────────────────────────────────────────────────

  async addMember(
    userId: string,
    role: string,
    trustLevel: number
  ): Promise<string> {
    await this.ensureInitialized();
    return memberOps.addMember(this.sql, userId, role, trustLevel);
  }

  async removeMember(memberId: string): Promise<void> {
    await this.ensureInitialized();
    memberOps.removeMember(this.sql, memberId);
  }

  async listMembers(): Promise<WastelandMemberRecord[]> {
    await this.ensureInitialized();
    return memberOps.listMembers(this.sql);
  }

  async getMember(userId: string): Promise<WastelandMemberRecord | null> {
    await this.ensureInitialized();
    return memberOps.getMember(this.sql, userId);
  }

  async updateMember(
    memberId: string,
    update: { role?: string; trust_level?: number }
  ): Promise<WastelandMemberRecord | null> {
    await this.ensureInitialized();
    return memberOps.updateMember(this.sql, memberId, update);
  }

  // ── Connected Towns RPCs ─────────────────────────────────────────────
  // Placeholder — will be implemented in a later phase with a dedicated
  // connected_towns table and sub-module.

  async connectTown(_townId: string, _userId: string): Promise<ConnectedTownResult> {
    throw new Error('Connected towns not yet implemented');
  }

  async disconnectTown(_townId: string): Promise<void> {
    throw new Error('Connected towns not yet implemented');
  }

  async listConnectedTowns(): Promise<ConnectedTownResult[]> {
    throw new Error('Connected towns not yet implemented');
  }

  // ── Wanted Board RPCs ───────────────────────────────────────────────
  // Placeholder — will be implemented in Phase 2 task 6 with DoltHub
  // polling via the alarm handler.

  async getWantedBoard(): Promise<WantedItemResult[]> {
    return [];
  }

  async refreshWantedBoard(): Promise<WantedItemResult[]> {
    return [];
  }

  // ── Alarm ────────────────────────────────────────────────────────────
  // Placeholder for wanted board polling (Phase 2 task 6).

  async alarm(): Promise<void> {
    console.log(`${LOG} alarm: tick (no-op placeholder)`);
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
