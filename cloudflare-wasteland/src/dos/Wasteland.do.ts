import { DurableObject } from 'cloudflare:workers';
import type { WastelandConfigRecord } from '../db/tables/wasteland-config.table';
import type { WastelandCredentialRecord } from '../db/tables/wasteland-credentials.table';
import type { WastelandMemberRecord } from '../db/tables/wasteland-members.table';
import type { WastelandConnectedTownRecord } from '../db/tables/wasteland-connected-towns.table';
import type { WastelandWantedItemRecord } from '../db/tables/wasteland-wanted-items.table';
import * as configOps from './wasteland/config';
import * as credentialOps from './wasteland/credentials';
import * as memberOps from './wasteland/members';
import * as connectedTownOps from './wasteland/connected-towns';
import * as wantedBoardOps from './wasteland/wanted-board';

// Re-export types that the stub previously exported, so router.ts / ownership.ts
// can import them from this file instead of the deleted stub.
export type WastelandConfigResult = WastelandConfigRecord;
export type WastelandMemberResult = WastelandMemberRecord;
export type WastelandCredentialResult = WastelandCredentialRecord;
export type ConnectedTownResult = WastelandConnectedTownRecord;
export type WantedItemResult = WastelandWantedItemRecord;
export type InitializeWastelandInput = configOps.InitWastelandInput;
export type UpdateWastelandConfigInput = configOps.UpdateWastelandConfigInput;

/**
 * WastelandDO — per-wasteland Durable Object storing metadata,
 * member credentials, connected towns, and wanted board cache.
 *
 * All table init is synchronous and runs inside `blockConcurrencyWhile`
 * in the constructor, which guarantees initialization completes before
 * any RPC is dispatched.
 */
export class WastelandDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private wastelandId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(() => {
      this.initializeDatabase();
      return Promise.resolve();
    });
  }

  private initializeDatabase(): void {
    configOps.initConfigTable(this.sql);
    credentialOps.initCredentialTable(this.sql);
    memberOps.initMemberTables(this.sql);
    connectedTownOps.initConnectedTownsTable(this.sql);
    wantedBoardOps.initWantedItemsTable(this.sql);

    // Cache the wasteland_id from existing config (if any)
    const existing = configOps.getConfig(this.sql);
    if (existing) {
      this.wastelandId = existing.wasteland_id;
    }
  }

  private getWastelandId(): string {
    if (!this.wastelandId) {
      const config = configOps.getConfig(this.sql);
      if (!config) throw new Error('Wasteland not initialized');
      this.wastelandId = config.wasteland_id;
    }
    return this.wastelandId;
  }

  // ── Config RPCs ──────────────────────────────────────────────────────

  async getConfig(): Promise<WastelandConfigRecord | null> {
    return configOps.getConfig(this.sql);
  }

  async initializeWasteland(
    input: configOps.InitWastelandInput
  ): Promise<WastelandConfigRecord> {
    const result = configOps.initializeWasteland(this.sql, input);
    this.wastelandId = result.wasteland_id;
    return result;
  }

  async updateConfig(
    update: configOps.UpdateWastelandConfigInput
  ): Promise<WastelandConfigRecord> {
    return configOps.updateConfig(this.sql, this.getWastelandId(), update);
  }

  // ── Credential RPCs ──────────────────────────────────────────────────

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

  // ── Member RPCs ──────────────────────────────────────────────────────

  async addMember(userId: string, role: string, trustLevel: number): Promise<string> {
    return memberOps.addMember(this.sql, userId, role, trustLevel);
  }

  async removeMember(memberId: string): Promise<void> {
    memberOps.removeMember(this.sql, memberId);
  }

  async listMembers(): Promise<WastelandMemberRecord[]> {
    return memberOps.listMembers(this.sql);
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

  // ── Connected Towns RPCs ─────────────────────────────────────────────

  async connectTown(townId: string, userId: string): Promise<WastelandConnectedTownRecord> {
    return connectedTownOps.connectTown(this.sql, this.getWastelandId(), townId, userId);
  }

  async disconnectTown(townId: string): Promise<void> {
    connectedTownOps.disconnectTown(this.sql, townId);
  }

  async listConnectedTowns(): Promise<WastelandConnectedTownRecord[]> {
    return connectedTownOps.listConnectedTowns(this.sql);
  }

  // ── Wanted Board RPCs ────────────────────────────────────────────────

  async getWantedBoard(): Promise<WastelandWantedItemRecord[]> {
    return wantedBoardOps.getWantedBoard(this.sql);
  }

  async refreshWantedBoard(): Promise<WastelandWantedItemRecord[]> {
    return wantedBoardOps.refreshWantedBoard(this.sql);
  }

  // ── Alarm ────────────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    // Placeholder for periodic wanted board sync from DoltHub upstream.
    // Schedule the next alarm (e.g., every 5 minutes).
    await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
