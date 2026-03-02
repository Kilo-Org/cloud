import { DurableObject } from 'cloudflare:workers';
import { createTableUserTowns, user_towns, UserTownRecord } from '../db/tables/user-towns.table';
import { createTableUserRigs, user_rigs, UserRigRecord } from '../db/tables/user-rigs.table';
import { query } from '../util/query.util';

const USER_LOG = '[GastownUser.do]';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/**
 * GastownUserDO — per-user control-plane metadata for towns and rigs.
 *
 * Keying: one DO instance per user (keyed by `owner_user_id`). A single
 * instance stores all towns a user owns plus their rigs.
 *
 * This is a temporary home — towns/rigs are simple control-plane entities
 * that will move to Postgres once the replication layer lands (Phase 4,
 * #230). The DO is used now so reads don't require Postgres and the
 * worker stays self-contained.
 *
 * Cross-rig coordination will be added in Phase 2 (#215).
 */
export class GastownUserDO extends DurableObject<Env> {
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
    query(this.sql, createTableUserTowns(), []);
    query(this.sql, createTableUserRigs(), []);
  }

  // ── Towns ─────────────────────────────────────────────────────────────

  async createTown(input: { name: string; owner_user_id: string }): Promise<UserTownRecord> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();
    console.log(`${USER_LOG} createTown: id=${id} name=${input.name} owner=${input.owner_user_id}`);

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${user_towns} (
          ${user_towns.columns.id},
          ${user_towns.columns.name},
          ${user_towns.columns.owner_user_id},
          ${user_towns.columns.created_at},
          ${user_towns.columns.updated_at}
        ) VALUES (?, ?, ?, ?, ?)
      `,
      [id, input.name, input.owner_user_id, timestamp, timestamp]
    );

    const town = this.getTown(id);
    if (!town) throw new Error('Failed to create town');
    console.log(`${USER_LOG} createTown: created town id=${town.id}`);
    // TODO: Should create the Town DO now, call setTownId, and then some function like ensureContainer
    // In the background, this way the town will likely be ready to go when the user gets to the UI

    return town;
  }

  async getTownAsync(townId: string): Promise<UserTownRecord | null> {
    await this.ensureInitialized();
    return this.getTown(townId);
  }

  private getTown(townId: string): UserTownRecord | null {
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${user_towns} WHERE ${user_towns.columns.id} = ?`,
        [townId]
      ),
    ];
    if (rows.length === 0) return null;
    return UserTownRecord.parse(rows[0]);
  }

  async listTowns(): Promise<UserTownRecord[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${user_towns} ORDER BY ${user_towns.columns.created_at} DESC`,
        []
      ),
    ];
    return UserTownRecord.array().parse(rows);
  }

  // ── Rigs ──────────────────────────────────────────────────────────────

  async createRig(input: {
    town_id: string;
    name: string;
    git_url: string;
    default_branch: string;
    platform_integration_id?: string;
  }): Promise<UserRigRecord> {
    await this.ensureInitialized();
    console.log(
      `${USER_LOG} createRig: town_id=${input.town_id} name=${input.name} git_url=${input.git_url} default_branch=${input.default_branch} integration=${input.platform_integration_id ?? 'none'}`
    );

    // Verify town exists
    const town = this.getTown(input.town_id);
    if (!town) {
      console.error(`${USER_LOG} createRig: town ${input.town_id} not found`);
      throw new Error(`Town ${input.town_id} not found`);
    }

    const id = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${user_rigs} (
          ${user_rigs.columns.id},
          ${user_rigs.columns.town_id},
          ${user_rigs.columns.name},
          ${user_rigs.columns.git_url},
          ${user_rigs.columns.default_branch},
          ${user_rigs.columns.platform_integration_id},
          ${user_rigs.columns.created_at},
          ${user_rigs.columns.updated_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        input.town_id,
        input.name,
        input.git_url,
        input.default_branch,
        input.platform_integration_id ?? null,
        timestamp,
        timestamp,
      ]
    );

    const rig = this.getRig(id);
    if (!rig) throw new Error('Failed to create rig');
    console.log(`${USER_LOG} createRig: created rig id=${rig.id}`);
    return rig;
  }

  async getRigAsync(rigId: string): Promise<UserRigRecord | null> {
    await this.ensureInitialized();
    return this.getRig(rigId);
  }

  private getRig(rigId: string): UserRigRecord | null {
    const rows = [
      ...query(this.sql, /* sql */ `SELECT * FROM ${user_rigs} WHERE ${user_rigs.columns.id} = ?`, [
        rigId,
      ]),
    ];
    if (rows.length === 0) return null;
    return UserRigRecord.parse(rows[0]);
  }

  async listRigs(townId: string): Promise<UserRigRecord[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${user_rigs}
          WHERE ${user_rigs.columns.town_id} = ?
          ORDER BY ${user_rigs.columns.created_at} DESC
        `,
        [townId]
      ),
    ];
    return UserRigRecord.array().parse(rows);
  }

  async deleteRig(rigId: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.getRig(rigId)) return false;
    query(this.sql, /* sql */ `DELETE FROM ${user_rigs} WHERE ${user_rigs.columns.id} = ?`, [
      rigId,
    ]);
    return true;
  }

  async deleteTown(townId: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.getTown(townId)) return false;
    // Cascade: delete all rigs belonging to this town first
    query(this.sql, /* sql */ `DELETE FROM ${user_rigs} WHERE ${user_rigs.columns.town_id} = ?`, [
      townId,
    ]);
    query(this.sql, /* sql */ `DELETE FROM ${user_towns} WHERE ${user_towns.columns.id} = ?`, [
      townId,
    ]);
    return true;
  }

  async ping(): Promise<string> {
    return 'pong';
  }
}

export function getGastownUserStub(env: Env, userId: string) {
  return env.GASTOWN_USER.get(env.GASTOWN_USER.idFromName(userId));
}
