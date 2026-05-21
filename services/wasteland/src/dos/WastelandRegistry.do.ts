import { DurableObject } from 'cloudflare:workers';
import * as registryOps from './wasteland-registry/registry-ops';
import { getWastelandDOStub } from './Wasteland.do';
import type { WastelandRegistryRecord } from '../db/tables/wasteland-registry.table';

const LOG = '[WastelandRegistry.do]';

/**
 * WastelandRegistryDO — singleton registry that indexes wasteland ownership.
 *
 * Because each WastelandDO is per-wasteland, we need a central index to
 * answer "which wastelands does user X own?" or "which wastelands belong
 * to org Y?". This singleton (keyed by fixed name 'registry') maintains
 * that mapping.
 *
 * The class is intentionally thin: every RPC method delegates to a plain
 * function in `./wasteland-registry/registry-ops.ts`. The Node vitest
 * pool can't load `cloudflare:workers`, so all SQL behaviour is tested
 * against the sub-module with a fake `SqlStorage`.
 *
 * `dolthub_upstream` is the `<owner>/<repo>` slug for the upstream
 * DoltHub repo. It powers `findByOwnerRepo` so the apps/web routes
 * `/wasteland/:owner/:repo` can resolve to a `wastelandId` without an
 * extra round-trip per UUID-keyed procedure call.
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
      this.initPromise = Promise.resolve().then(() => {
        registryOps.initialize(this.sql);
      });
    }
    await this.initPromise;
  }

  async register(input: {
    wasteland_id: string;
    owner_type: 'user' | 'org';
    owner_user_id: string | null;
    organization_id: string | null;
    name: string;
    dolthub_upstream?: string | null;
  }): Promise<void> {
    await this.ensureInitialized();
    console.log(
      `${LOG} register: wasteland_id=${input.wasteland_id} owner_type=${input.owner_type} dolthub_upstream=${input.dolthub_upstream ?? 'null'}`
    );
    registryOps.register(
      this.sql,
      {
        wasteland_id: input.wasteland_id,
        owner_type: input.owner_type,
        owner_user_id: input.owner_user_id,
        organization_id: input.organization_id,
        name: input.name,
        dolthub_upstream: input.dolthub_upstream ?? null,
      },
      new Date().toISOString()
    );
  }

  async unregister(wastelandId: string): Promise<void> {
    await this.ensureInitialized();
    console.log(`${LOG} unregister: wasteland_id=${wastelandId}`);
    registryOps.unregister(this.sql, wastelandId);
  }

  async setDolthubUpstream(wastelandId: string, dolthubUpstream: string | null): Promise<void> {
    await this.ensureInitialized();
    console.log(
      `${LOG} setDolthubUpstream: wasteland_id=${wastelandId} dolthub_upstream=${dolthubUpstream ?? 'null'}`
    );
    registryOps.setDolthubUpstream(this.sql, wastelandId, dolthubUpstream);
  }

  async listByUser(userId: string): Promise<WastelandRegistryRecord[]> {
    await this.ensureInitialized();
    return registryOps.listByUser(this.sql, userId);
  }

  async listByOrg(orgId: string): Promise<WastelandRegistryRecord[]> {
    await this.ensureInitialized();
    return registryOps.listByOrg(this.sql, orgId);
  }

  async listAll(): Promise<WastelandRegistryRecord[]> {
    await this.ensureInitialized();
    return registryOps.listAll(this.sql);
  }

  /** Return the total number of registered (active) wastelands. */
  async countAll(): Promise<number> {
    await this.ensureInitialized();
    return registryOps.countAll(this.sql);
  }

  /**
   * Look up a wasteland by its `<owner>/<repo>` upstream slug. Returns
   * the registry record (including ownership fields) so callers can
   * decide how to authorise the lookup. Comparison is case-insensitive.
   */
  async findByOwnerRepo(owner: string, repo: string): Promise<WastelandRegistryRecord | null> {
    await this.ensureInitialized();
    return registryOps.findByOwnerRepo(this.sql, owner, repo);
  }

  /**
   * One-off backfill: walk every registered wasteland, read its
   * per-wasteland `wasteland_config.dolthub_upstream`, and copy it onto
   * the registry row. Idempotent — runs `setDolthubUpstream` for every
   * row regardless of current state, so re-running the backfill always
   * converges to the per-wasteland config truth.
   *
   * Returns counts so the caller can report progress. Does NOT throw on
   * a single wasteland's failure — logs and continues — to keep a
   * partial dev/staging dataset from blocking the whole run.
   */
  async backfillDolthubUpstream(): Promise<{
    total: number;
    updated: number;
    cleared: number;
    failed: number;
  }> {
    await this.ensureInitialized();
    const all = registryOps.listAll(this.sql);
    let updated = 0;
    let cleared = 0;
    let failed = 0;
    for (const entry of all) {
      try {
        const stub = getWastelandDOStub(this.env, entry.wasteland_id);
        const config = await stub.getConfig();
        const upstream = config?.dolthub_upstream ?? null;
        registryOps.setDolthubUpstream(this.sql, entry.wasteland_id, upstream);
        if (upstream === null) {
          cleared += 1;
        } else {
          updated += 1;
        }
      } catch (err) {
        failed += 1;
        console.warn(
          `${LOG} backfill failed for wasteland_id=${entry.wasteland_id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    console.log(
      `${LOG} backfillDolthubUpstream complete: total=${all.length} updated=${updated} cleared=${cleared} failed=${failed}`
    );
    return { total: all.length, updated, cleared, failed };
  }
}

export function getWastelandRegistryStub(env: Env) {
  return env.WASTELAND_REGISTRY.get(env.WASTELAND_REGISTRY.idFromName('registry'));
}
