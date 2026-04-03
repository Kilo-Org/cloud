import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { query } from '../util/query.util';
import {
  createTableWastelandRegistry,
  wasteland_registry,
  WastelandRegistryRecord,
} from '../db/tables/wasteland-registry.table';

const CountResult = z.object({ cnt: z.coerce.number() });

const LOG = '[WastelandRegistry.do]';

/**
 * WastelandRegistryDO — singleton registry that indexes wasteland ownership.
 *
 * Because each WastelandDO is per-wasteland, we need a central index to
 * answer "which wastelands does user X own?" or "which wastelands belong
 * to org Y?". This singleton (keyed by fixed name 'registry') maintains
 * that mapping.
 *
 * All creates/deletes in the tRPC router update this registry so
 * listWastelands can resolve ownership without scanning every WastelandDO.
 */
export class WastelandRegistryDO extends DurableObject<Env> {
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
    query(this.sql, createTableWastelandRegistry(), []);
  }

  async register(input: {
    wasteland_id: string;
    owner_type: 'user' | 'org';
    owner_user_id: string | null;
    organization_id: string | null;
    name: string;
  }): Promise<void> {
    await this.ensureInitialized();
    const timestamp = new Date().toISOString();
    console.log(
      `${LOG} register: wasteland_id=${input.wasteland_id} owner_type=${input.owner_type}`
    );

    query(
      this.sql,
      /* sql */ `
        INSERT OR REPLACE INTO ${wasteland_registry} (
          ${wasteland_registry.columns.wasteland_id},
          ${wasteland_registry.columns.owner_type},
          ${wasteland_registry.columns.owner_user_id},
          ${wasteland_registry.columns.organization_id},
          ${wasteland_registry.columns.name},
          ${wasteland_registry.columns.created_at}
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        input.wasteland_id,
        input.owner_type,
        input.owner_user_id,
        input.organization_id,
        input.name,
        timestamp,
      ]
    );
  }

  async unregister(wastelandId: string): Promise<void> {
    await this.ensureInitialized();
    console.log(`${LOG} unregister: wasteland_id=${wastelandId}`);

    query(
      this.sql,
      /* sql */ `DELETE FROM ${wasteland_registry} WHERE ${wasteland_registry.wasteland_id} = ?`,
      [wastelandId]
    );
  }

  async listByUser(userId: string): Promise<WastelandRegistryRecord[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${wasteland_registry}
          WHERE ${wasteland_registry.owner_type} = 'user'
            AND ${wasteland_registry.owner_user_id} = ?
          ORDER BY ${wasteland_registry.created_at} DESC
        `,
        [userId]
      ),
    ];
    return WastelandRegistryRecord.array().parse(rows);
  }

  async listByOrg(orgId: string): Promise<WastelandRegistryRecord[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${wasteland_registry}
          WHERE ${wasteland_registry.owner_type} = 'org'
            AND ${wasteland_registry.organization_id} = ?
          ORDER BY ${wasteland_registry.created_at} DESC
        `,
        [orgId]
      ),
    ];
    return WastelandRegistryRecord.array().parse(rows);
  }

  async listAll(): Promise<WastelandRegistryRecord[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${wasteland_registry}
          ORDER BY ${wasteland_registry.created_at} DESC
        `,
        []
      ),
    ];
    return WastelandRegistryRecord.array().parse(rows);
  }

  async countAll(): Promise<number> {
    await this.ensureInitialized();
    const rows = [
      ...query(this.sql, /* sql */ `SELECT COUNT(*) AS cnt FROM ${wasteland_registry}`, []),
    ];
    return CountResult.parse(rows[0]).cnt;
  }
}

export function getWastelandRegistryStub(env: Env) {
  return env.WASTELAND_REGISTRY.get(env.WASTELAND_REGISTRY.idFromName('registry'));
}
