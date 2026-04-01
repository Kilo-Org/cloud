import { DurableObject } from 'cloudflare:workers';

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
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
