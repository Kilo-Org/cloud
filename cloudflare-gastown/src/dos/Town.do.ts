import { DurableObject } from 'cloudflare:workers';
import { createTableTowns, towns, TownRecord } from '../db/tables/towns.table';
import { createTableRigs, rigs, RigRecord } from '../db/tables/rigs.table';
import { query } from '../util/query.util';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Town DO — control-plane metadata for towns and rigs.
 *
 * Keying: one DO instance per user (keyed by `owner_user_id`). A single
 * instance therefore stores *all* towns a user owns plus their rigs. The
 * `towns` table can hold multiple rows because a user may create several
 * towns.
 *
 * This is a temporary home — towns/rigs are simple control-plane entities
 * that will move to Postgres once the replication layer lands (Phase 4,
 * #230). The DO is used now so reads don't require Postgres and the
 * worker stays self-contained.
 *
 * Cross-rig coordination will be added in Phase 2 (#215).
 */
export class TownDO extends DurableObject<Env> {
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
    query(this.sql, createTableTowns(), []);
    query(this.sql, createTableRigs(), []);
  }

  // ── Towns ─────────────────────────────────────────────────────────────

  async createTown(input: { name: string; owner_user_id: string }): Promise<TownRecord> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${towns} (
          ${towns.columns.id},
          ${towns.columns.name},
          ${towns.columns.owner_user_id},
          ${towns.columns.created_at},
          ${towns.columns.updated_at}
        ) VALUES (?, ?, ?, ?, ?)
      `,
      [id, input.name, input.owner_user_id, timestamp, timestamp]
    );

    const town = this.getTown(id);
    if (!town) throw new Error('Failed to create town');
    return town;
  }

  async getTownAsync(townId: string): Promise<TownRecord | null> {
    await this.ensureInitialized();
    return this.getTown(townId);
  }

  private getTown(townId: string): TownRecord | null {
    const rows = [
      ...query(this.sql, /* sql */ `SELECT * FROM ${towns} WHERE ${towns.columns.id} = ?`, [
        townId,
      ]),
    ];
    if (rows.length === 0) return null;
    return TownRecord.parse(rows[0]);
  }

  async listTowns(): Promise<TownRecord[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${towns} ORDER BY ${towns.columns.created_at} DESC`,
        []
      ),
    ];
    return TownRecord.array().parse(rows);
  }

  // ── Rigs ──────────────────────────────────────────────────────────────

  async createRig(input: {
    town_id: string;
    name: string;
    git_url: string;
    default_branch: string;
  }): Promise<RigRecord> {
    await this.ensureInitialized();

    // Verify town exists
    const town = this.getTown(input.town_id);
    if (!town) throw new Error(`Town ${input.town_id} not found`);

    const id = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${rigs} (
          ${rigs.columns.id},
          ${rigs.columns.town_id},
          ${rigs.columns.name},
          ${rigs.columns.git_url},
          ${rigs.columns.default_branch},
          ${rigs.columns.created_at},
          ${rigs.columns.updated_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [id, input.town_id, input.name, input.git_url, input.default_branch, timestamp, timestamp]
    );

    const rig = this.getRig(id);
    if (!rig) throw new Error('Failed to create rig');
    return rig;
  }

  async getRigAsync(rigId: string): Promise<RigRecord | null> {
    await this.ensureInitialized();
    return this.getRig(rigId);
  }

  private getRig(rigId: string): RigRecord | null {
    const rows = [
      ...query(this.sql, /* sql */ `SELECT * FROM ${rigs} WHERE ${rigs.columns.id} = ?`, [rigId]),
    ];
    if (rows.length === 0) return null;
    return RigRecord.parse(rows[0]);
  }

  async listRigs(townId: string): Promise<RigRecord[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${rigs}
          WHERE ${rigs.columns.town_id} = ?
          ORDER BY ${rigs.columns.created_at} DESC
        `,
        [townId]
      ),
    ];
    return RigRecord.array().parse(rows);
  }

  async ping(): Promise<string> {
    return 'pong';
  }
}

export function getTownDOStub(env: Env, townId: string) {
  return env.TOWN.get(env.TOWN.idFromName(townId));
}
