import { DurableObject } from 'cloudflare:workers';
import { query } from '../util/query.util';
import {
  createTableWastelandConfig,
  wasteland_config,
  WastelandConfigRecord,
} from '../db/tables/wasteland-config.table';
import {
  createTableWastelandMembers,
  wasteland_members,
  WastelandMemberRecord,
} from '../db/tables/wasteland-members.table';
import {
  createTableWastelandCredentials,
  wasteland_credentials,
  WastelandCredentialRecord,
} from '../db/tables/wasteland-credentials.table';
import {
  createTableWastelandConnectedTowns,
  wasteland_connected_towns,
  WastelandConnectedTownRecord,
} from '../db/tables/wasteland-connected-towns.table';

const LOG = '[WastelandDO]';

// ── Exported types (preserved for downstream consumers) ────────────────

export type WastelandConfigResult = WastelandConfigRecord;
export type WastelandMemberResult = WastelandMemberRecord;
export type WastelandCredentialResult = WastelandCredentialRecord;
export type WastelandConnectedTownResult = WastelandConnectedTownRecord;

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

/**
 * WastelandDO — per-wasteland Durable Object with SQLite storage.
 *
 * Stores wasteland config, members, credentials, and connected towns.
 * Wanted board data is currently returned as an empty array (cache placeholder).
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
    query(this.sql, createTableWastelandMembers(), []);
    query(this.sql, createTableWastelandCredentials(), []);
    query(this.sql, createTableWastelandConnectedTowns(), []);
  }

  // ── HTTP fetch (health + CORS) ──────────────────────────────────────

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

  // ── Config RPCs ─────────────────────────────────────────────────────

  async initializeWasteland(input: InitializeWastelandInput): Promise<WastelandConfigResult> {
    await this.ensureInitialized();
    const timestamp = new Date().toISOString();
    console.log(`${LOG} initializeWasteland: ${input.wasteland_id} name=${input.name}`);

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${wasteland_config} (
          ${wasteland_config.columns.wasteland_id},
          ${wasteland_config.columns.name},
          ${wasteland_config.columns.owner_type},
          ${wasteland_config.columns.owner_user_id},
          ${wasteland_config.columns.organization_id},
          ${wasteland_config.columns.dolthub_upstream},
          ${wasteland_config.columns.visibility},
          ${wasteland_config.columns.status},
          ${wasteland_config.columns.created_at},
          ${wasteland_config.columns.updated_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `,
      [
        input.wasteland_id,
        input.name,
        input.owner_type,
        input.owner_user_id,
        input.organization_id,
        input.dolthub_upstream,
        input.visibility,
        timestamp,
        timestamp,
      ]
    );

    // Auto-register the owner as a member with 'owner' role
    if (input.owner_user_id) {
      const memberId = crypto.randomUUID();
      query(
        this.sql,
        /* sql */ `
          INSERT INTO ${wasteland_members} (
            ${wasteland_members.columns.member_id},
            ${wasteland_members.columns.user_id},
            ${wasteland_members.columns.trust_level},
            ${wasteland_members.columns.role},
            ${wasteland_members.columns.joined_at}
          ) VALUES (?, ?, 3, 'owner', ?)
        `,
        [memberId, input.owner_user_id, timestamp]
      );
    }

    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${wasteland_config} WHERE ${wasteland_config.wasteland_id} = ?`,
        [input.wasteland_id]
      ),
    ];
    return WastelandConfigRecord.parse(rows[0]);
  }

  async getConfig(): Promise<WastelandConfigResult | null> {
    await this.ensureInitialized();
    const rows = [...query(this.sql, /* sql */ `SELECT * FROM ${wasteland_config} LIMIT 1`, [])];
    if (rows.length === 0) return null;
    return WastelandConfigRecord.parse(rows[0]);
  }

  async updateConfig(input: UpdateWastelandConfigInput): Promise<WastelandConfigResult> {
    await this.ensureInitialized();
    const timestamp = new Date().toISOString();

    // Build SET clause dynamically based on provided fields
    query(
      this.sql,
      /* sql */ `
        UPDATE ${wasteland_config}
        SET ${wasteland_config.columns.name} = COALESCE(?, ${wasteland_config.columns.name}),
            ${wasteland_config.columns.visibility} = COALESCE(?, ${wasteland_config.columns.visibility}),
            ${wasteland_config.columns.dolthub_upstream} = CASE WHEN ? = 1 THEN ? ELSE ${wasteland_config.columns.dolthub_upstream} END,
            ${wasteland_config.columns.status} = COALESCE(?, ${wasteland_config.columns.status}),
            ${wasteland_config.columns.updated_at} = ?
      `,
      [
        input.name ?? null,
        input.visibility ?? null,
        input.dolthub_upstream !== undefined ? 1 : 0,
        input.dolthub_upstream !== undefined ? input.dolthub_upstream : null,
        input.status ?? null,
        timestamp,
      ]
    );

    const rows = [...query(this.sql, /* sql */ `SELECT * FROM ${wasteland_config} LIMIT 1`, [])];
    return WastelandConfigRecord.parse(rows[0]);
  }

  // ── Member management RPCs ──────────────────────────────────────────

  async listMembers(): Promise<WastelandMemberResult[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${wasteland_members} ORDER BY ${wasteland_members.joined_at} ASC`,
        []
      ),
    ];
    return WastelandMemberRecord.array().parse(rows);
  }

  async addMember(userId: string, role: string, trustLevel: number): Promise<string> {
    await this.ensureInitialized();
    const memberId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    console.log(`${LOG} addMember: userId=${userId} role=${role}`);

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${wasteland_members} (
          ${wasteland_members.columns.member_id},
          ${wasteland_members.columns.user_id},
          ${wasteland_members.columns.trust_level},
          ${wasteland_members.columns.role},
          ${wasteland_members.columns.joined_at}
        ) VALUES (?, ?, ?, ?, ?)
      `,
      [memberId, userId, trustLevel, role, timestamp]
    );

    return memberId;
  }

  async removeMember(memberId: string): Promise<void> {
    await this.ensureInitialized();
    console.log(`${LOG} removeMember: memberId=${memberId}`);
    query(
      this.sql,
      /* sql */ `DELETE FROM ${wasteland_members} WHERE ${wasteland_members.member_id} = ?`,
      [memberId]
    );
  }

  async getMember(userId: string): Promise<WastelandMemberResult | null> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${wasteland_members} WHERE ${wasteland_members.user_id} = ?`,
        [userId]
      ),
    ];
    if (rows.length === 0) return null;
    return WastelandMemberRecord.parse(rows[0]);
  }

  async updateMember(
    memberId: string,
    update: { role?: string; trust_level?: number }
  ): Promise<WastelandMemberResult | null> {
    await this.ensureInitialized();

    query(
      this.sql,
      /* sql */ `
        UPDATE ${wasteland_members}
        SET ${wasteland_members.columns.role} = COALESCE(?, ${wasteland_members.columns.role}),
            ${wasteland_members.columns.trust_level} = COALESCE(?, ${wasteland_members.columns.trust_level})
        WHERE ${wasteland_members.member_id} = ?
      `,
      [update.role ?? null, update.trust_level ?? null, memberId]
    );

    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${wasteland_members} WHERE ${wasteland_members.member_id} = ?`,
        [memberId]
      ),
    ];
    if (rows.length === 0) return null;
    return WastelandMemberRecord.parse(rows[0]);
  }

  // ── Credential management RPCs ──────────────────────────────────────

  async storeCredential(
    userId: string,
    encryptedToken: string,
    dolthubOrg: string,
    rigHandle?: string
  ): Promise<WastelandCredentialResult> {
    await this.ensureInitialized();
    const timestamp = new Date().toISOString();
    console.log(`${LOG} storeCredential: userId=${userId} org=${dolthubOrg}`);

    query(
      this.sql,
      /* sql */ `
        INSERT OR REPLACE INTO ${wasteland_credentials} (
          ${wasteland_credentials.columns.user_id},
          ${wasteland_credentials.columns.encrypted_token},
          ${wasteland_credentials.columns.dolthub_org},
          ${wasteland_credentials.columns.rig_handle},
          ${wasteland_credentials.columns.connected_at}
        ) VALUES (?, ?, ?, ?, ?)
      `,
      [userId, encryptedToken, dolthubOrg, rigHandle ?? null, timestamp]
    );

    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${wasteland_credentials} WHERE ${wasteland_credentials.user_id} = ?`,
        [userId]
      ),
    ];
    return WastelandCredentialRecord.parse(rows[0]);
  }

  async getCredential(userId: string): Promise<WastelandCredentialResult | null> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${wasteland_credentials} WHERE ${wasteland_credentials.user_id} = ?`,
        [userId]
      ),
    ];
    if (rows.length === 0) return null;
    return WastelandCredentialRecord.parse(rows[0]);
  }

  async deleteCredential(userId: string): Promise<void> {
    await this.ensureInitialized();
    console.log(`${LOG} deleteCredential: userId=${userId}`);
    query(
      this.sql,
      /* sql */ `DELETE FROM ${wasteland_credentials} WHERE ${wasteland_credentials.user_id} = ?`,
      [userId]
    );
  }

  // ── Connected towns RPCs ────────────────────────────────────────────

  async connectTown(townId: string, townName: string): Promise<WastelandConnectedTownResult> {
    await this.ensureInitialized();
    const timestamp = new Date().toISOString();
    console.log(`${LOG} connectTown: townId=${townId} name=${townName}`);

    query(
      this.sql,
      /* sql */ `
        INSERT OR REPLACE INTO ${wasteland_connected_towns} (
          ${wasteland_connected_towns.columns.town_id},
          ${wasteland_connected_towns.columns.town_name},
          ${wasteland_connected_towns.columns.connected_at}
        ) VALUES (?, ?, ?)
      `,
      [townId, townName, timestamp]
    );

    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${wasteland_connected_towns}
          WHERE ${wasteland_connected_towns.town_id} = ?
        `,
        [townId]
      ),
    ];
    return WastelandConnectedTownRecord.parse(rows[0]);
  }

  async disconnectTown(townId: string): Promise<void> {
    await this.ensureInitialized();
    console.log(`${LOG} disconnectTown: townId=${townId}`);
    query(
      this.sql,
      /* sql */ `DELETE FROM ${wasteland_connected_towns} WHERE ${wasteland_connected_towns.town_id} = ?`,
      [townId]
    );
  }

  async listConnectedTowns(): Promise<WastelandConnectedTownResult[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${wasteland_connected_towns}
          ORDER BY ${wasteland_connected_towns.connected_at} DESC
        `,
        []
      ),
    ];
    return WastelandConnectedTownRecord.array().parse(rows);
  }

  // ── Wanted board cache RPCs (placeholder) ───────────────────────────

  async getWantedBoard(): Promise<WantedItemResult[]> {
    await this.ensureInitialized();
    // Wanted board is populated via the container — returns empty until refreshed
    return [];
  }

  async refreshWantedBoard(): Promise<WantedItemResult[]> {
    await this.ensureInitialized();
    // Refresh requires container interaction — returns empty in this layer
    return [];
  }
}

export function getWastelandDOStub(env: Env, wastelandId: string) {
  return env.WASTELAND.get(env.WASTELAND.idFromName(wastelandId));
}
