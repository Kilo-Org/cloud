import { SqlStore } from '../SqlStore';
import type { Database, Transaction } from '../database';
import {
  kiloclaw_instances,
  type KiloClawInstanceRecord,
} from '../tables/kiloclaw-instances.table';

export class InstanceStore extends SqlStore {
  constructor(db: Database | Transaction) {
    super(db);
  }

  /**
   * Insert a new provisioned instance. Must succeed or provision fails.
   * Partial unique index enforces one active instance per user.
   */
  async insertProvisioned(userId: string, sandboxId: string): Promise<void> {
    await this.query(
      /* sql */ `
      INSERT INTO ${kiloclaw_instances} (
        ${kiloclaw_instances.columns.user_id},
        ${kiloclaw_instances.columns.sandbox_id},
        ${kiloclaw_instances.columns.status}
      ) VALUES ($1, $2, 'provisioned')
      `,
      { 1: userId, 2: sandboxId }
    );
  }

  /**
   * Soft-delete: mark the active instance as destroyed.
   * Returns true if a row was updated, false if no active instance was found.
   */
  async markDestroyed(userId: string): Promise<boolean> {
    const rows = await this.query(
      /* sql */ `
      UPDATE ${kiloclaw_instances}
      SET ${kiloclaw_instances.columns.status} = 'destroyed',
          ${kiloclaw_instances.columns.destroyed_at} = now()
      WHERE ${kiloclaw_instances.user_id} = $1
        AND ${kiloclaw_instances.destroyed_at} IS NULL
      RETURNING ${kiloclaw_instances.id}
      `,
      { 1: userId }
    );
    return rows.length > 0;
  }

  /**
   * Mirror operational status to DB (best-effort).
   * Called fire-and-forget from the DO -- never throws to the caller.
   */
  async mirrorStatus(
    userId: string,
    status: 'running' | 'stopped',
    timestampColumn?: 'last_started_at' | 'last_stopped_at'
  ): Promise<void> {
    if (timestampColumn) {
      await this.query(
        /* sql */ `
        UPDATE ${kiloclaw_instances}
        SET ${kiloclaw_instances.columns.status} = $2,
            ${timestampColumn} = now()
        WHERE ${kiloclaw_instances.user_id} = $1
          AND ${kiloclaw_instances.destroyed_at} IS NULL
        `,
        { 1: userId, 2: status }
      );
    } else {
      await this.query(
        /* sql */ `
        UPDATE ${kiloclaw_instances}
        SET ${kiloclaw_instances.columns.status} = $2
        WHERE ${kiloclaw_instances.user_id} = $1
          AND ${kiloclaw_instances.destroyed_at} IS NULL
        `,
        { 1: userId, 2: status }
      );
    }
  }

  /**
   * Find active instance for a user.
   */
  async findActiveByUserId(userId: string): Promise<KiloClawInstanceRecord | null> {
    const rows = await this.query(
      /* sql */ `
      SELECT ${kiloclaw_instances.id},
             ${kiloclaw_instances.user_id},
             ${kiloclaw_instances.sandbox_id},
             ${kiloclaw_instances.status},
             ${kiloclaw_instances.created_at},
             ${kiloclaw_instances.last_started_at},
             ${kiloclaw_instances.last_stopped_at},
             ${kiloclaw_instances.destroyed_at}
      FROM ${kiloclaw_instances}
      WHERE ${kiloclaw_instances.user_id} = $1
        AND ${kiloclaw_instances.destroyed_at} IS NULL
      LIMIT 1
      `,
      { 1: userId }
    );

    if (rows.length === 0) return null;
    return rows[0] as KiloClawInstanceRecord;
  }
}
