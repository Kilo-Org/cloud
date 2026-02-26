import { z } from 'zod';
import { SqlStore } from '../SqlStore';
import type { Database, Transaction } from '../database';
import { kiloclaw_instances } from '../tables/kiloclaw-instances.table';

const ActiveInstanceRow = z.object({
  id: z.string(),
  sandbox_id: z.string(),
});

/**
 * Postgres access for the KiloClaw worker.
 * Reads via Hyperdrive. Writes are limited to lifecycle bookkeeping
 * (e.g. marking an instance destroyed) that Next.js cannot observe.
 */
export class InstanceStore extends SqlStore {
  constructor(db: Database | Transaction) {
    super(db);
  }

  /**
   * Read the active instance for a user.
   * Returns null if no active instance exists.
   */
  async getActiveInstance(userId: string): Promise<{
    id: string;
    sandboxId: string;
  } | null> {
    const rows = await this.query(
      /* sql */ `
      SELECT ${kiloclaw_instances.id},
             ${kiloclaw_instances.sandbox_id}
      FROM ${kiloclaw_instances}
      WHERE ${kiloclaw_instances.user_id} = $1
        AND ${kiloclaw_instances.destroyed_at} IS NULL
      LIMIT 1
      `,
      { 1: userId }
    );

    if (rows.length === 0) return null;
    const row = ActiveInstanceRow.parse(rows[0]);
    return { id: row.id, sandboxId: row.sandbox_id };
  }

  /**
   * Mark the active instance row as destroyed.
   * Called by the DO during auto-destroy of stale provisioned instances
   * so the Postgres registry stays consistent with DO state.
   */
  async markDestroyed(userId: string, sandboxId: string): Promise<void> {
    await this.query(
      /* sql */ `
      UPDATE ${kiloclaw_instances}
      SET ${kiloclaw_instances.columns.destroyed_at} = NOW()
      WHERE ${kiloclaw_instances.user_id} = $1
        AND ${kiloclaw_instances.sandbox_id} = $2
        AND ${kiloclaw_instances.destroyed_at} IS NULL
      `,
      { 1: userId, 2: sandboxId }
    );
  }
}
