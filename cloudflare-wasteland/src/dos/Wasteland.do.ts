import { DurableObject } from 'cloudflare:workers';
import * as configOps from './wasteland/config';
import * as memberOps from './wasteland/members';
import * as credentialOps from './wasteland/credentials';
import * as townOps from './wasteland/towns';
import * as wantedBoardOps from './wasteland/wanted-board';

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
  connected_at: string;
};

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
    wantedBoardOps.initializeDatabase(this.sql);
  }

  async initializeWasteland(input: InitializeWastelandInput): Promise<WastelandConfigResult> {
    this.wastelandId = input.wasteland_id;
    return configOps.initializeWasteland(this.sql, input);
  }

  async getConfig(): Promise<WastelandConfigResult | null> {
    if (!this.wastelandId) {
      const rows = [
        ...this.sql.exec(
          /* sql */ `SELECT name FROM sqlite_master WHERE type='table' AND name='wasteland_config'`,
          []
        ),
      ];
      if (rows.length === 0) return null;
      const config = configOps.getConfig(this.sql, this.state.id.toString());
      if (config) this.wastelandId = config.wasteland_id;
      return config;
    }
    return configOps.getConfig(this.sql, this.wastelandId);
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

  async storeCredential(
    userId: string,
    encryptedToken: string,
    dolthubOrg: string,
    rigHandle?: string
  ): Promise<WastelandCredentialResult> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) throw new Error('Wasteland not initialized');
    return credentialOps.storeCredential(
      this.sql,
      id,
      userId,
      encryptedToken,
      dolthubOrg,
      rigHandle
    );
  }

  async getCredential(userId: string): Promise<WastelandCredentialResult | null> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) return null;
    return credentialOps.getCredential(this.sql, id, userId);
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

  async getWantedBoard(): Promise<WantedItemResult[]> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) return [];
    return wantedBoardOps.getWantedBoard(this.sql, id);
  }

  async refreshWantedBoard(): Promise<WantedItemResult[]> {
    const id = this.wastelandId ?? (await this.getConfig())?.wasteland_id;
    if (!id) return [];
    return wantedBoardOps.refreshWantedBoard(this.sql, id);
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
