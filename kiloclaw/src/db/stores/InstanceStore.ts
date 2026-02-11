import { SqlStore } from '../SqlStore';
import type { Database, Transaction } from '../database';
import { kiloclaw_instances } from '../tables/kiloclaw-instances.table';

/**
 * Read-only Postgres access for the KiloClaw worker.
 * The Next.js backend is the sole writer to kiloclaw_instances.
 *
 * Used for DO restore: if DO SQLite was wiped, read config/channels/vars
 * from Postgres to repopulate the DO state.
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
    channels: string | null;
    vars: string | null;
  } | null> {
    const rows = await this.query(
      /* sql */ `
      SELECT ${kiloclaw_instances.id},
             ${kiloclaw_instances.sandbox_id},
             ${kiloclaw_instances.channels},
             ${kiloclaw_instances.vars}
      FROM ${kiloclaw_instances}
      WHERE ${kiloclaw_instances.user_id} = $1
        AND ${kiloclaw_instances.destroyed_at} IS NULL
      LIMIT 1
      `,
      { 1: userId }
    );

    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: row.id as string,
      sandboxId: row.sandbox_id as string,
      channels: row.channels as string | null,
      vars: row.vars as string | null,
    };
  }
}
