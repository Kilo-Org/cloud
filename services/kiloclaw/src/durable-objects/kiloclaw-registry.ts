import { DurableObject } from 'cloudflare:workers';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, isNull, and } from 'drizzle-orm';
import migrations from '../../drizzle/migrations';
import { registryInstances } from '../db/sqlite-schema';
import { getWorkerDb, getActivePersonalInstance } from '../db';
import type { KiloClawEnv } from '../types';
import { doKeyFromActiveInstance } from '../lib/instance-routing';

export type RegistryEntry = {
  instanceId: string;
  doKey: string;
  assignedUserId: string;
  createdAt: string;
  destroyedAt: string | null;
};

function rowToEntry(row: typeof registryInstances.$inferSelect): RegistryEntry {
  return {
    instanceId: row.instance_id,
    doKey: row.do_key,
    assignedUserId: row.assigned_user_id,
    createdAt: row.created_at,
    destroyedAt: row.destroyed_at,
  };
}

/**
 * KiloClawRegistry DO — SQLite-backed index of instances per owner.
 *
 * Keyed by `user:{userId}` (personal) or `org:{orgId}` (org).
 * Each instance has its own isolated SQLite database. Migrations run
 * per-instance on first access after deploy.
 *
 * Lazy migration: on first listInstances() for a user registry that has
 * no entries, reads the legacy instance row from Postgres via Hyperdrive
 * and backfills a registry entry.
 */
export class KiloClawRegistry extends DurableObject<KiloClawEnv> {
  private db: DrizzleSqliteDODatabase;
  private ownerKey: string | null = null;
  private migrated = false;
  private lastMigrationAttempt = 0;

  /** Cooldown between lazy migration retries when Hyperdrive/Postgres is unavailable. */
  private static MIGRATION_RETRY_COOLDOWN_MS = 60_000;

  constructor(ctx: DurableObjectState, env: KiloClawEnv) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
      this.ownerKey = (await ctx.storage.get<string>('owner_key')) ?? null;
      this.migrated = (await ctx.storage.get<boolean>('migrated')) ?? false;
    });
  }

  // -- Owner key management --------------------------------------------------

  /**
   * Store the owner key on first call. Subsequent calls validate consistency.
   * Every public method receives ownerKey as its first argument; this method
   * is called internally at the top of each.
   */
  private async ensureOwnerKey(ownerKey: string): Promise<void> {
    if (this.ownerKey === ownerKey) return;
    if (this.ownerKey !== null) {
      throw new Error(
        `Registry owner key mismatch: stored="${this.ownerKey}", received="${ownerKey}"`
      );
    }
    this.ownerKey = ownerKey;
    await this.ctx.storage.put('owner_key', ownerKey);
  }

  // -- Public RPC methods ----------------------------------------------------

  async listInstances(ownerKey: string): Promise<RegistryEntry[]> {
    await this.ensureOwnerKey(ownerKey);

    if (!this.migrated) {
      const now = Date.now();
      if (now - this.lastMigrationAttempt >= KiloClawRegistry.MIGRATION_RETRY_COOLDOWN_MS) {
        this.lastMigrationAttempt = now;
        await this.lazyMigrate();
      }
    }

    return this.db
      .select()
      .from(registryInstances)
      .where(isNull(registryInstances.destroyed_at))
      .all()
      .map(rowToEntry);
  }

  /** List all registry entries including destroyed ones, plus migration status (admin). */
  async listAllInstances(
    ownerKey: string
  ): Promise<{ entries: RegistryEntry[]; migrated: boolean }> {
    await this.ensureOwnerKey(ownerKey);

    if (!this.migrated) {
      const now = Date.now();
      if (now - this.lastMigrationAttempt >= KiloClawRegistry.MIGRATION_RETRY_COOLDOWN_MS) {
        this.lastMigrationAttempt = now;
        await this.lazyMigrate();
      }
    }

    const entries = this.db.select().from(registryInstances).all().map(rowToEntry);
    return { entries, migrated: this.migrated };
  }

  async createInstance(
    ownerKey: string,
    assignedUserId: string,
    instanceId: string,
    doKey: string
  ): Promise<void> {
    await this.ensureOwnerKey(ownerKey);

    this.db
      .insert(registryInstances)
      .values({
        instance_id: instanceId,
        do_key: doKey,
        assigned_user_id: assignedUserId,
        created_at: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
  }

  async destroyInstance(ownerKey: string, instanceId: string): Promise<void> {
    await this.ensureOwnerKey(ownerKey);

    this.db
      .update(registryInstances)
      .set({ destroyed_at: new Date().toISOString() })
      .where(
        and(eq(registryInstances.instance_id, instanceId), isNull(registryInstances.destroyed_at))
      )
      .run();
  }

  async resolveDoKey(ownerKey: string, instanceId: string): Promise<string | null> {
    await this.ensureOwnerKey(ownerKey);

    const row = this.db
      .select({ do_key: registryInstances.do_key })
      .from(registryInstances)
      .where(
        and(eq(registryInstances.instance_id, instanceId), isNull(registryInstances.destroyed_at))
      )
      .get();

    return row?.do_key ?? null;
  }

  async findInstancesForUser(ownerKey: string, userId: string): Promise<RegistryEntry[]> {
    await this.ensureOwnerKey(ownerKey);

    return this.db
      .select()
      .from(registryInstances)
      .where(
        and(eq(registryInstances.assigned_user_id, userId), isNull(registryInstances.destroyed_at))
      )
      .all()
      .map(rowToEntry);
  }

  // -- Lazy migration --------------------------------------------------------

  /**
   * Backfill registry from Postgres for user registries.
   *
   * Only runs for `user:{userId}` registries. Org registries have no legacy
   * instances to migrate.
   *
   * Migration reads the active instance row from Postgres via Hyperdrive.
   * If Hyperdrive is unavailable, migration is deferred to the next access.
   */
  private async lazyMigrate(): Promise<void> {
    const ownerKey = this.ownerKey;
    if (!ownerKey?.startsWith('user:')) {
      // Org registries have no legacy instances to migrate
      this.migrated = true;
      await this.ctx.storage.put('migrated', true);
      return;
    }

    const userId = ownerKey.slice('user:'.length);

    const connectionString = this.env.HYPERDRIVE?.connectionString;
    if (!connectionString) {
      // Hyperdrive unavailable — defer migration, next access will retry
      console.warn('[Registry] HYPERDRIVE not configured, deferring lazy migration');
      return;
    }

    try {
      const db = getWorkerDb(connectionString);
      const instance = await getActivePersonalInstance(db, userId);

      if (instance) {
        const doKey = doKeyFromActiveInstance(instance);
        this.db
          .insert(registryInstances)
          .values({
            instance_id: instance.id,
            do_key: doKey,
            assigned_user_id: userId,
            created_at: new Date().toISOString(),
          })
          .onConflictDoNothing()
          .run();
      }
      // No Postgres row means no legacy instance — Postgres is the source of truth.
      // Orphaned DOs (state but no Postgres row) only occur via manual DB deletion
      // and are handled by the resolveRegistryEntry fallback in index.ts.

      this.migrated = true;
      await this.ctx.storage.put('migrated', true);
    } catch (err) {
      // Postgres/Hyperdrive error — defer migration, next access will retry after cooldown
      console.error('[Registry] Lazy migration failed, will retry on next access:', err);
    }
  }
}
