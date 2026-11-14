/* eslint-disable import/no-nodejs-modules -- this helper runs the shipped migrations through real SQL under Node, as `encrypted-kv.test.ts` does */
import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import migrations from '../../../drizzle/migrations';
import { enableForeignKeys } from '../persist/foreign-keys';
import { type SqlValue, type SshDatabase } from './database';

/**
 * The ssh tables on a fresh in-memory database, built from the migrations the
 * app ships: this is the same `drizzle/migrations` bundle `encrypted-kv.ts`
 * hands to the migrator, so a migration that moves breaks the suites that use
 * this helper rather than passing against a copy.
 */
export function createSshTestDatabase(): SshDatabase {
  const migrationBundle = z
    .object({
      journal: z.object({ entries: z.array(z.object({ idx: z.number().int(), tag: z.string() })) }),
      migrations: z.record(z.string(), z.string()),
    })
    .parse(migrations);
  const database = new DatabaseSync(':memory:');
  for (const entry of migrationBundle.journal.entries) {
    const sql = migrationBundle.migrations[`m${String(entry.idx).padStart(4, '0')}`];
    if (!sql) {
      throw new Error(`Missing migration: ${entry.tag}`);
    }
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim().length > 0) {
        database.exec(statement);
      }
    }
  }
  // The same order as the app's open path: migrations first, on a connection
  // with enforcement off, then `enableForeignKeys`.
  enableForeignKeys({
    execSync: statement => {
      database.exec(statement);
    },
  });
  return {
    getAllSync: <T>(source: string, params: SqlValue[]): T[] =>
      database.prepare(source).all(...params) as T[],
    runSync: (source: string, params: SqlValue[]) => {
      database.prepare(source).run(...params);
    },
    withTransactionSync: (task: () => void) => {
      database.exec('BEGIN');
      try {
        task();
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
