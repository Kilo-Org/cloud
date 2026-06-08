import { DurableObject } from 'cloudflare:workers';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, isNull, and, inArray } from 'drizzle-orm';
import migrations from '../../drizzle/migrations';
import { registryInstances, registryProvisionReservations } from '../db/sqlite-schema';
import { getWorkerDb, getActivePersonalInstance, hasSubscriptionForInstance } from '../db';
import type { KiloClawEnv } from '../types';
import { doKeyFromActiveInstance } from '../lib/instance-routing';
import { isInstanceKeyedSandboxId } from '@kilocode/worker-utils/instance-id';

export type RegistryEntry = {
  instanceId: string;
  doKey: string;
  assignedUserId: string;
  createdAt: string;
  destroyedAt: string | null;
};

export type ProvisionReservationStatus =
  | 'in_progress'
  | 'completed'
  | 'failed_requires_reconciliation'
  | 'released';

export type ProvisionReservationEntry = {
  instanceId: string;
  doKey: string;
  assignedUserId: string;
  status: ProvisionReservationStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  failureCode: string | null;
  resolutionReason: string | null;
};

export type BeginFreshProvisionResult =
  | { outcome: 'admitted'; reservation: ProvisionReservationEntry }
  | { outcome: 'conflict'; reservation: ProvisionReservationEntry };

export type ReleasableReservationStatus = 'in_progress' | 'failed_requires_reconciliation';

export type AdminReleaseReservationResult =
  | { outcome: 'released'; previousStatus: ReleasableReservationStatus }
  | { outcome: 'not_found' }
  | { outcome: 'status_changed'; status: ProvisionReservationStatus };

function rowToEntry(row: typeof registryInstances.$inferSelect): RegistryEntry {
  return {
    instanceId: row.instance_id,
    doKey: row.do_key,
    assignedUserId: row.assigned_user_id,
    createdAt: row.created_at,
    destroyedAt: row.destroyed_at,
  };
}

function rowToReservation(
  row: typeof registryProvisionReservations.$inferSelect
): ProvisionReservationEntry {
  return {
    instanceId: row.instance_id,
    doKey: row.do_key,
    assignedUserId: row.assigned_user_id,
    status: row.status,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    failureCode: row.failure_code,
    resolutionReason: row.resolution_reason,
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

  /** List all registry entries and fresh-provision admission state for admin inspection. */
  async listAllInstances(ownerKey: string): Promise<{
    entries: RegistryEntry[];
    reservations: ProvisionReservationEntry[];
    migrated: boolean;
  }> {
    await this.ensureOwnerKey(ownerKey);

    if (!this.migrated) {
      const now = Date.now();
      if (now - this.lastMigrationAttempt >= KiloClawRegistry.MIGRATION_RETRY_COOLDOWN_MS) {
        this.lastMigrationAttempt = now;
        await this.lazyMigrate();
      }
    }

    const entries = this.db.select().from(registryInstances).all().map(rowToEntry);
    const reservations = this.db
      .select()
      .from(registryProvisionReservations)
      .all()
      .map(rowToReservation);
    return { entries, reservations, migrated: this.migrated };
  }

  async beginFreshProvision(
    ownerKey: string,
    assignedUserId: string,
    instanceId: string,
    doKey: string
  ): Promise<BeginFreshProvisionResult> {
    await this.ensureOwnerKey(ownerKey);
    const now = new Date().toISOString();

    try {
      const reservation = this.ctx.storage.transactionSync(() => {
        this.db
          .insert(registryProvisionReservations)
          .values({
            instance_id: instanceId,
            do_key: doKey,
            assigned_user_id: assignedUserId,
            status: 'in_progress',
            started_at: now,
            updated_at: now,
          })
          .run();
        const row = this.db
          .select()
          .from(registryProvisionReservations)
          .where(eq(registryProvisionReservations.instance_id, instanceId))
          .get();
        if (!row) throw new Error('Provision reservation missing after insertion');
        return rowToReservation(row);
      });
      return { outcome: 'admitted', reservation };
    } catch (error) {
      const unresolved = this.db
        .select()
        .from(registryProvisionReservations)
        .where(
          and(
            eq(registryProvisionReservations.assigned_user_id, assignedUserId),
            inArray(registryProvisionReservations.status, [
              'in_progress',
              'failed_requires_reconciliation',
            ])
          )
        )
        .get();
      if (unresolved) return { outcome: 'conflict', reservation: rowToReservation(unresolved) };
      throw error;
    }
  }

  async completeFreshProvision(
    ownerKey: string,
    assignedUserId: string,
    instanceId: string,
    doKey: string
  ): Promise<void> {
    await this.ensureOwnerKey(ownerKey);
    this.finalizeFreshProvision(assignedUserId, instanceId, doKey, true);
  }

  async repairCompletedProvision(
    ownerKey: string,
    assignedUserId: string,
    instanceId: string,
    doKey: string
  ): Promise<boolean> {
    await this.ensureOwnerKey(ownerKey);
    return this.finalizeFreshProvision(assignedUserId, instanceId, doKey, false);
  }

  async failFreshProvision(
    ownerKey: string,
    assignedUserId: string,
    instanceId: string,
    failureCode: string
  ): Promise<void> {
    await this.ensureOwnerKey(ownerKey);
    const now = new Date().toISOString();
    this.db
      .update(registryProvisionReservations)
      .set({
        status: 'failed_requires_reconciliation',
        updated_at: now,
        failure_code: failureCode,
      })
      .where(
        and(
          eq(registryProvisionReservations.instance_id, instanceId),
          eq(registryProvisionReservations.assigned_user_id, assignedUserId),
          eq(registryProvisionReservations.status, 'in_progress')
        )
      )
      .run();
  }

  async releaseFreshProvision(
    ownerKey: string,
    assignedUserId: string,
    instanceId: string,
    reason: string
  ): Promise<void> {
    await this.ensureOwnerKey(ownerKey);
    const now = new Date().toISOString();
    this.db
      .update(registryProvisionReservations)
      .set({ status: 'released', updated_at: now, resolution_reason: reason })
      .where(
        and(
          eq(registryProvisionReservations.instance_id, instanceId),
          eq(registryProvisionReservations.assigned_user_id, assignedUserId),
          inArray(registryProvisionReservations.status, [
            'in_progress',
            'completed',
            'failed_requires_reconciliation',
          ])
        )
      )
      .run();
  }

  /**
   * Atomically release a stuck reservation as an explicit admin/operator
   * break-glass action. This is NOT an autonomous safety decision: the caller
   * (an authenticated admin) is asserting they have already confirmed the
   * attempt is dead and any provider resources are cleaned up. The audit log on
   * the route records that assertion.
   *
   * Validation + transition happen in a single `transactionSync` so the read
   * and write cannot be split across RPCs. The release is a compare-and-set on
   * `expectedStatus` — the exact status the caller validated — so a reservation
   * that changed underneath (e.g. a concurrent `completeFreshProvision`) is
   * reported as `status_changed` rather than silently released.
   */
  async adminReleaseStuckReservation(
    ownerKey: string,
    assignedUserId: string,
    instanceId: string,
    expectedStatus: ReleasableReservationStatus,
    reason: string
  ): Promise<AdminReleaseReservationResult> {
    await this.ensureOwnerKey(ownerKey);
    const now = new Date().toISOString();
    return this.ctx.storage.transactionSync(() => {
      const row = this.db
        .select()
        .from(registryProvisionReservations)
        .where(
          and(
            eq(registryProvisionReservations.instance_id, instanceId),
            eq(registryProvisionReservations.assigned_user_id, assignedUserId)
          )
        )
        .get();
      if (!row) return { outcome: 'not_found' };
      if (row.status !== expectedStatus) {
        return { outcome: 'status_changed', status: row.status };
      }
      this.db
        .update(registryProvisionReservations)
        .set({ status: 'released', updated_at: now, resolution_reason: reason })
        .where(
          and(
            eq(registryProvisionReservations.instance_id, instanceId),
            eq(registryProvisionReservations.assigned_user_id, assignedUserId),
            eq(registryProvisionReservations.status, expectedStatus)
          )
        )
        .run();
      return { outcome: 'released', previousStatus: expectedStatus };
    });
  }

  async listProvisionReservations(ownerKey: string): Promise<ProvisionReservationEntry[]> {
    await this.ensureOwnerKey(ownerKey);
    return this.db.select().from(registryProvisionReservations).all().map(rowToReservation);
  }

  private finalizeFreshProvision(
    assignedUserId: string,
    instanceId: string,
    doKey: string,
    reservationRequired: boolean
  ): boolean {
    const now = new Date().toISOString();
    return this.ctx.storage.transactionSync(() => {
      const reservation = this.db
        .select()
        .from(registryProvisionReservations)
        .where(
          and(
            eq(registryProvisionReservations.instance_id, instanceId),
            eq(registryProvisionReservations.assigned_user_id, assignedUserId)
          )
        )
        .get();
      if (!reservation) {
        if (reservationRequired)
          throw new Error('Provision reservation not found during completion');
        return false;
      }
      if (reservation.status === 'released') {
        throw new Error('Cannot complete a released provision reservation');
      }
      // A canonical active row plus subscription is stronger evidence than the
      // transient provider-side failure that originally set reconciliation state.
      // Repair deliberately clears that state only after the Worker has verified
      // canonical success before invoking this method.
      if (
        reservationRequired &&
        reservation.status !== 'in_progress' &&
        reservation.status !== 'completed'
      ) {
        throw new Error(`Cannot complete provision reservation from ${reservation.status}`);
      }

      this.db
        .update(registryProvisionReservations)
        .set({
          status: 'completed',
          updated_at: now,
          completed_at: now,
          failure_code: null,
          resolution_reason: null,
        })
        .where(eq(registryProvisionReservations.instance_id, instanceId))
        .run();
      this.db
        .insert(registryInstances)
        .values({
          instance_id: instanceId,
          do_key: doKey,
          assigned_user_id: assignedUserId,
          created_at: now,
          destroyed_at: null,
        })
        .onConflictDoUpdate({
          target: registryInstances.instance_id,
          set: { do_key: doKey, assigned_user_id: assignedUserId, destroyed_at: null },
        })
        .run();
      return true;
    });
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
        destroyed_at: null,
      })
      .onConflictDoNothing()
      .run();
  }

  async publishRecoveredInstance(
    ownerKey: string,
    assignedUserId: string,
    instanceId: string,
    doKey: string
  ): Promise<boolean> {
    await this.ensureOwnerKey(ownerKey);
    return this.ctx.storage.transactionSync(() => {
      const existing = this.db
        .select()
        .from(registryInstances)
        .where(eq(registryInstances.instance_id, instanceId))
        .get();
      if (existing?.destroyed_at) return false;
      if (!existing) {
        this.db
          .insert(registryInstances)
          .values({
            instance_id: instanceId,
            do_key: doKey,
            assigned_user_id: assignedUserId,
            created_at: new Date().toISOString(),
            destroyed_at: null,
          })
          .run();
      }
      return true;
    });
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

  async finalizeDestroyedInstance(
    ownerKey: string,
    assignedUserId: string,
    instanceId: string,
    doKey: string,
    reason: string
  ): Promise<void> {
    await this.ensureOwnerKey(ownerKey);
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.db
        .insert(registryInstances)
        .values({
          instance_id: instanceId,
          do_key: doKey,
          assigned_user_id: assignedUserId,
          created_at: now,
          destroyed_at: now,
        })
        .onConflictDoUpdate({
          target: registryInstances.instance_id,
          set: { destroyed_at: now },
        })
        .run();
      this.db
        .update(registryProvisionReservations)
        .set({ status: 'released', updated_at: now, resolution_reason: reason })
        .where(
          and(
            eq(registryProvisionReservations.instance_id, instanceId),
            eq(registryProvisionReservations.assigned_user_id, assignedUserId),
            inArray(registryProvisionReservations.status, [
              'in_progress',
              'completed',
              'failed_requires_reconciliation',
            ])
          )
        )
        .run();
    });
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
        const hasSubscription = await hasSubscriptionForInstance(db, instance.id);
        if (!hasSubscription && isInstanceKeyedSandboxId(instance.sandboxId)) {
          // Instance-keyed rows without a subscription are quarantine state.
          // They must not be published through lazy migration, and later
          // subscription recovery is responsible for publishing their route.
          this.migrated = true;
          await this.ctx.storage.put('migrated', true);
          return;
        }
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
      // Legacy user-keyed rows can remain subscription-less until early-bird backfill
      // completes, so they stay routable. New instance-keyed rows without a
      // subscription are quarantine state and must not be published.
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
