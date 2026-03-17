import { DurableObject } from 'cloudflare:workers';
import { createTableOrgTowns, org_towns, OrgTownRecord } from '../db/tables/org-towns.table';
import { createTableUserRigs, user_rigs, UserRigRecord } from '../db/tables/user-rigs.table';
import { query } from '../util/query.util';
import { getTownDOStub } from './Town.do';

const ORG_LOG = '[GastownOrg.do]';

/** Health watchdog interval — check town alarms every 5 minutes */
const WATCHDOG_INTERVAL_MS = 5 * 60_000;

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/**
 * GastownOrgDO — per-org control-plane metadata for towns and rigs.
 *
 * Keying: one DO instance per org (keyed by `orgId`). A single
 * instance stores all towns an org owns plus their rigs.
 *
 * Mirrors GastownUserDO but for org ownership. Towns are created by
 * a specific org member (recorded in created_by_user_id) but owned
 * by the org.
 */
export class GastownOrgDO extends DurableObject<Env> {
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
    query(this.sql, createTableOrgTowns(), []);
    query(this.sql, createTableUserRigs(), []);
    // Arm the watchdog on every initialization so existing orgs (who
    // created towns before the watchdog was added) get health checks.
    await this.armWatchdogIfNeeded();
  }

  // ── Towns ─────────────────────────────────────────────────────────────

  async createTown(input: {
    name: string;
    owner_org_id: string;
    created_by_user_id: string;
  }): Promise<OrgTownRecord> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();
    console.log(
      `${ORG_LOG} createTown: id=${id} name=${input.name} owner_org=${input.owner_org_id} created_by=${input.created_by_user_id}`
    );

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${org_towns} (
          ${org_towns.columns.id},
          ${org_towns.columns.name},
          ${org_towns.columns.owner_org_id},
          ${org_towns.columns.created_by_user_id},
          ${org_towns.columns.created_at},
          ${org_towns.columns.updated_at}
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [id, input.name, input.owner_org_id, input.created_by_user_id, timestamp, timestamp]
    );

    const town = this.getTown(id);
    if (!town) throw new Error('Failed to create town');
    console.log(`${ORG_LOG} createTown: created town id=${town.id}`);

    // Arm the health watchdog so it starts checking this town's alarm
    await this.armWatchdogIfNeeded();

    return town;
  }

  async getTownAsync(townId: string): Promise<OrgTownRecord | null> {
    await this.ensureInitialized();
    return this.getTown(townId);
  }

  private getTown(townId: string): OrgTownRecord | null {
    const rows = [
      ...query(this.sql, /* sql */ `SELECT * FROM ${org_towns} WHERE ${org_towns.columns.id} = ?`, [
        townId,
      ]),
    ];
    if (rows.length === 0) return null;
    return OrgTownRecord.parse(rows[0]);
  }

  async listTowns(): Promise<OrgTownRecord[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${org_towns} ORDER BY ${org_towns.columns.created_at} DESC`,
        []
      ),
    ];
    return OrgTownRecord.array().parse(rows);
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
      `${ORG_LOG} createRig: town_id=${input.town_id} name=${input.name} git_url=${input.git_url} default_branch=${input.default_branch} integration=${input.platform_integration_id ?? 'none'}`
    );

    // Verify town exists
    const town = this.getTown(input.town_id);
    if (!town) {
      console.error(`${ORG_LOG} createRig: town ${input.town_id} not found`);
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
    console.log(`${ORG_LOG} createRig: created rig id=${rig.id}`);
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
    query(this.sql, /* sql */ `DELETE FROM ${org_towns} WHERE ${org_towns.columns.id} = ?`, [
      townId,
    ]);
    return true;
  }

  async ping(): Promise<string> {
    return 'pong';
  }

  // ── Health Watchdog ───────────────────────────────────────────────────

  /**
   * Arm the watchdog alarm if this org has any towns. Called after
   * creating a town to ensure the watchdog runs.
   */
  private async armWatchdogIfNeeded(): Promise<void> {
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm || currentAlarm < Date.now()) {
      const towns = OrgTownRecord.array().parse([
        ...query(this.sql, /* sql */ `SELECT * FROM ${org_towns} LIMIT 1`, []),
      ]);
      if (towns.length > 0) {
        await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
      }
    }
  }

  /**
   * Watchdog alarm: periodically ping each town's TownDO to verify its
   * alarm is firing and re-arm it if not. This is the external observer
   * that catches a silently broken alarm handler.
   *
   * See #442 — replaces the Boot agent's role from local Gastown.
   */
  async alarm(): Promise<void> {
    await this.ensureInitialized();
    const towns = OrgTownRecord.array().parse([
      ...query(this.sql, /* sql */ `SELECT * FROM ${org_towns}`, []),
    ]);

    if (towns.length === 0) return;

    console.log(`${ORG_LOG} watchdog: checking ${towns.length} town(s)`);

    for (const town of towns) {
      try {
        const townStub = getTownDOStub(this.env, town.id);
        const health = await townStub.healthCheck();
        if (!health.alarmSet) {
          console.warn(`${ORG_LOG} watchdog: re-armed alarm for town=${town.id} (was missing)`);
        }
      } catch (err) {
        console.error(`${ORG_LOG} watchdog: healthCheck failed for town=${town.id}:`, err);
      }
    }

    // Re-arm the watchdog
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
  }
}

export function getGastownOrgStub(env: Env, orgId: string) {
  return env.GASTOWN_ORG.get(env.GASTOWN_ORG.idFromName(orgId));
}
