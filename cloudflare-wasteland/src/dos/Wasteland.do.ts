import { DurableObject } from 'cloudflare:workers';
import { createTableWastelandConfig } from '../db/tables/wasteland-config.table';
import { createTableWastelandMembers } from '../db/tables/wasteland-members.table';
import { createTableWastelandCredentials } from '../db/tables/wasteland-credentials.table';
import { createTableWastelandConnectedTowns } from '../db/tables/wasteland-connected-towns.table';
import { createTableWastelandWantedCache } from '../db/tables/wasteland-wanted-cache.table';
import { query } from '../util/query.util';
import * as configOps from './wasteland/config';
import * as memberOps from './wasteland/members';
import * as credentialOps from './wasteland/credentials';
import * as connectedTownOps from './wasteland/connected-towns';
import * as wantedCacheOps from './wasteland/wanted-cache';
import type { WastelandConfigRecord } from '../db/tables/wasteland-config.table';
import type { WastelandMemberRecord } from '../db/tables/wasteland-members.table';
import type { WastelandCredentialRecord } from '../db/tables/wasteland-credentials.table';
import type { WastelandConnectedTownRecord } from '../db/tables/wasteland-connected-towns.table';
import type { WastelandWantedItemRecord } from '../db/tables/wasteland-wanted-cache.table';

// Re-export types that downstream consumers (router.ts) need
export type {
  WastelandConfigRecord as WastelandConfigResult,
  WastelandMemberRecord as WastelandMemberResult,
  WastelandCredentialRecord as WastelandCredentialResult,
  WastelandConnectedTownRecord as ConnectedTownResult,
  WastelandWantedItemRecord as WantedItemResult,
};
export type { InitializeWastelandInput, UpdateWastelandConfigInput } from './wasteland/config';

const LOG = '[Wasteland.do]';

/**
 * WastelandDO — per-wasteland Durable Object backed by SQLite.
 *
 * Stores config, members, credentials, connected towns, and a local
 * cache of the wanted board. All business logic is delegated to
 * sub-modules under `wasteland/`.
 */
export class WastelandDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private wastelandId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.initializeDatabase();
    });
  }

  private initializeDatabase(): void {
    query(this.sql, createTableWastelandConfig(), []);
    query(this.sql, createTableWastelandMembers(), []);
    query(this.sql, createTableWastelandCredentials(), []);
    query(this.sql, createTableWastelandConnectedTowns(), []);
    query(this.sql, createTableWastelandWantedCache(), []);

    // Hydrate wastelandId from existing config row if present
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT wasteland_id FROM wasteland_config LIMIT 1`,
        []
      ),
    ];
    if (rows.length > 0) {
      this.wastelandId = String((rows[0] as Record<string, unknown>).wasteland_id);
    }
  }

  // ── Config RPCs ──────────────────────────────────────────────────────

  async initializeWasteland(
    input: configOps.InitializeWastelandInput
  ): Promise<WastelandConfigRecord> {
    console.log(`${LOG} initializeWasteland: wasteland_id=${input.wasteland_id}`);
    this.wastelandId = input.wasteland_id;

    const config = configOps.initializeWasteland(this.sql, input);

    // Auto-register the creating user as owner member
    if (input.owner_user_id) {
      memberOps.addMember(this.sql, input.owner_user_id, 'owner', 3);
    }

    return config;
  }

  async getConfig(): Promise<WastelandConfigRecord | null> {
    if (!this.wastelandId) return null;
    return configOps.getConfig(this.sql, this.wastelandId);
  }

  async updateConfig(
    input: configOps.UpdateWastelandConfigInput
  ): Promise<WastelandConfigRecord> {
    if (!this.wastelandId) {
      throw new Error('Wasteland not initialized');
    }
    console.log(`${LOG} updateConfig: wasteland_id=${this.wastelandId}`);
    return configOps.updateConfig(this.sql, this.wastelandId, input);
  }

  // ── Member RPCs ──────────────────────────────────────────────────────

  async listMembers(): Promise<WastelandMemberRecord[]> {
    return memberOps.listMembers(this.sql);
  }

  async addMember(userId: string, role: string, trustLevel: number): Promise<string> {
    console.log(`${LOG} addMember: userId=${userId} role=${role}`);
    return memberOps.addMember(this.sql, userId, role, trustLevel);
  }

  async removeMember(memberId: string): Promise<void> {
    console.log(`${LOG} removeMember: memberId=${memberId}`);
    memberOps.removeMember(this.sql, memberId);
  }

  async getMember(userId: string): Promise<WastelandMemberRecord | null> {
    return memberOps.getMember(this.sql, userId);
  }

  async updateMember(
    memberId: string,
    update: { role?: string; trust_level?: number }
  ): Promise<WastelandMemberRecord | null> {
    console.log(`${LOG} updateMember: memberId=${memberId}`);
    return memberOps.updateMember(this.sql, memberId, update);
  }

  // ── Credential RPCs ──────────────────────────────────────────────────

  async storeCredential(
    userId: string,
    encryptedToken: string,
    dolthubOrg: string,
    rigHandle?: string
  ): Promise<WastelandCredentialRecord> {
    console.log(`${LOG} storeCredential: userId=${userId}`);
    return credentialOps.storeCredential(this.sql, userId, encryptedToken, dolthubOrg, rigHandle);
  }

  async getCredential(userId: string): Promise<WastelandCredentialRecord | null> {
    return credentialOps.getCredential(this.sql, userId);
  }

  async deleteCredential(userId: string): Promise<void> {
    console.log(`${LOG} deleteCredential: userId=${userId}`);
    credentialOps.deleteCredential(this.sql, userId);
  }

  // ── Connected Town RPCs ──────────────────────────────────────────────

  async connectTown(townId: string, userId: string): Promise<WastelandConnectedTownRecord> {
    if (!this.wastelandId) {
      throw new Error('Wasteland not initialized');
    }
    console.log(`${LOG} connectTown: townId=${townId} userId=${userId}`);
    return connectedTownOps.connectTown(this.sql, this.wastelandId, townId, userId);
  }

  async disconnectTown(townId: string): Promise<void> {
    console.log(`${LOG} disconnectTown: townId=${townId}`);
    connectedTownOps.disconnectTown(this.sql, townId);
  }

  async listConnectedTowns(): Promise<WastelandConnectedTownRecord[]> {
    return connectedTownOps.listConnectedTowns(this.sql);
  }

  // ── Wanted Board RPCs ────────────────────────────────────────────────

  async getWantedBoard(): Promise<WastelandWantedItemRecord[]> {
    return wantedCacheOps.getWantedBoard(this.sql);
  }

  async refreshWantedBoard(): Promise<WastelandWantedItemRecord[]> {
    // For now, return the current cache. Full DoltHub polling is
    // handled by the alarm() cycle when dolthub_upstream is configured.
    // A manual refresh triggers a re-read from the local cache.
    console.log(`${LOG} refreshWantedBoard`);
    return wantedCacheOps.getWantedBoard(this.sql);
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
