import { z } from 'zod';
import { SqlStore } from '../SqlStore';
import type { Database, Transaction } from '../database';
import { kiloclaw_access_codes } from '../tables/kiloclaw-access-codes.table';

const AccessCodeRow = z.object({
  id: z.string(),
  kilo_user_id: z.string(),
});

/**
 * Validates and redeems one-time access codes via Hyperdrive.
 * This is the first write path from the worker to Postgres.
 */
export class AccessCodeStore extends SqlStore {
  constructor(db: Database | Transaction) {
    super(db);
  }

  /**
   * Atomically validate and redeem an access code.
   * Returns the userId if valid, null otherwise.
   */
  async validateAndRedeem(code: string, userId: string): Promise<string | null> {
    return this.begin(async tx => {
      const store = new AccessCodeStore(tx);

      const rows = await store.query(
        /* sql */ `
        SELECT ${kiloclaw_access_codes.id}, ${kiloclaw_access_codes.kilo_user_id}
        FROM ${kiloclaw_access_codes}
        WHERE ${kiloclaw_access_codes.code} = $1
          AND ${kiloclaw_access_codes.kilo_user_id} = $2
          AND ${kiloclaw_access_codes.status} = 'active'
          AND ${kiloclaw_access_codes.expires_at} > NOW()
        LIMIT 1
        FOR UPDATE
        `,
        { 1: code, 2: userId }
      );

      if (rows.length === 0) return null;

      const row = AccessCodeRow.parse(rows[0]);

      await store.query(
        /* sql */ `
        UPDATE ${kiloclaw_access_codes}
        SET ${kiloclaw_access_codes.columns.status} = 'redeemed',
            ${kiloclaw_access_codes.columns.redeemed_at} = NOW()
        WHERE ${kiloclaw_access_codes.id} = $1
        `,
        { 1: row.id }
      );

      return row.kilo_user_id;
    });
  }
}
