import { DurableObject } from 'cloudflare:workers';
import * as configOps from './wasteland/config';
import * as memberOps from './wasteland/members';
import * as credentialOps from './wasteland/credentials';
import * as townOps from './wasteland/towns';
import { wasteland_config, WastelandConfigRecord } from '../db/tables/wasteland-config.table';
import { query } from '../util/query.util';

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

export type WastelandMemberResult = {
  member_id: string;
  user_id: string;
  trust_level: number;
  role: 'contributor' | 'maintainer' | 'owner';
  joined_at: string;
};

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

export type WastelandCredentialResult = {
  user_id: string;
  encrypted_token: string;
  dolthub_org: string;
  rig_handle: string | null;
  is_upstream_admin: boolean;
  connected_at: string;
};

export type ConnectedTownResult = {
  town_id: string;
  wasteland_id: string;
  connected_by: string;
  connected_at: string;
};

export class WastelandDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private wastelandId: string | null = null;

  constructor(
    private state: DurableObjectState,
    env: Env
  ) {
    super(state, env);
    this.sql = state.storage.sql;

    void state.blockConcurrencyWhile(async () => {
      this.initializeDatabase();
    });
  }

  private initializeDatabase(): void {
    configOps.initializeDatabase(this.sql);
    memberOps.initializeDatabase(this.sql);
    credentialOps.initializeDatabase(this.sql);
    townOps.initializeDatabase(this.sql);
  }

  async initializeWasteland(input: InitializeWastelandInput): Promise<WastelandConfigResult> {
    this.wastelandId = input.wasteland_id;
    return configOps.initializeWasteland(this.sql, input);
  }

  async getConfig(): Promise<WastelandConfigResult | null> {
    if (this.wastelandId) {
      return configOps.getConfig(this.sql, this.wastelandId);
    }
    const rows = [...query(this.sql, /* sql */ `SELECT * FROM ${wasteland_config} LIMIT 1`, [])];
    if (rows.length === 0) return null;
    const config = WastelandConfigRecord.parse(rows[0]);
    this.wastelandId = config.wasteland_id;
    return config;
  }

  async updateConfig(input: UpdateWastelandConfigInput): Promise<WastelandConfigResult> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) throw new Error('Wasteland not initialized');
    return configOps.updateConfig(this.sql, id, input);
  }

  async listMembers(): Promise<WastelandMemberResult[]> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) return [];
    return memberOps.listMembers(this.sql, id);
  }

  async addMember(userId: string, role: string, trustLevel: number): Promise<string> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) throw new Error('Wasteland not initialized');
    return memberOps.addMember(this.sql, id, userId, role, trustLevel);
  }

  async removeMember(memberId: string): Promise<void> {
    memberOps.removeMember(this.sql, memberId);
  }

  async getMember(userId: string): Promise<WastelandMemberResult | null> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) return null;
    return memberOps.getMember(this.sql, id, userId);
  }

  async updateMember(
    memberId: string,
    update: { role?: string; trust_level?: number }
  ): Promise<WastelandMemberResult | null> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) return null;
    return memberOps.updateMember(this.sql, id, memberId, update);
  }

  async storeCredential(input: {
    userId: string;
    encryptedToken: string;
    dolthubOrg: string;
    rigHandle?: string;
    isUpstreamAdmin?: boolean;
  }): Promise<WastelandCredentialResult> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) throw new Error('Wasteland not initialized');
    return credentialOps.storeCredential(this.sql, id, input.userId, {
      encryptedToken: input.encryptedToken,
      dolthubOrg: input.dolthubOrg,
      rigHandle: input.rigHandle,
      isUpstreamAdmin: input.isUpstreamAdmin,
    });
  }

  async getCredential(userId: string): Promise<WastelandCredentialResult | null> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) return null;
    return credentialOps.getCredential(this.sql, id, userId);
  }

  async setIsUpstreamAdmin(
    userId: string,
    isUpstreamAdmin: boolean
  ): Promise<WastelandCredentialResult | null> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) return null;
    return credentialOps.setIsUpstreamAdmin(this.sql, id, userId, isUpstreamAdmin);
  }

  async deleteCredential(userId: string): Promise<void> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) return;
    credentialOps.deleteCredential(this.sql, id, userId);
  }

  async connectTown(townId: string, userId: string): Promise<ConnectedTownResult> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) throw new Error('Wasteland not initialized');
    return townOps.connectTown(this.sql, id, townId, userId);
  }

  async disconnectTown(townId: string): Promise<void> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) return;
    townOps.disconnectTown(this.sql, id, townId);
  }

  async listConnectedTowns(): Promise<ConnectedTownResult[]> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) return [];
    return townOps.listConnectedTowns(this.sql, id);
  }

  async listConnectedTownsForUser(userId: string): Promise<ConnectedTownResult[]> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) return [];
    return townOps.listConnectedTownsForUser(this.sql, id, userId);
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
