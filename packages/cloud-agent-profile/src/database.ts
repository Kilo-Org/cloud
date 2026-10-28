import type { LedgerDatabase, LedgerTransaction } from '@kilocode/db/operation-ledger';
import type { ProfileDatabase } from './types';

function isDatabase(
  database: ProfileDatabase
): database is Exclude<LedgerDatabase, LedgerTransaction> {
  return typeof (database as { $client?: unknown }).$client !== 'undefined';
}

/**
 * Runs `work` inside its own transaction, or inline when given an already-open
 * transaction so callers can compose multiple writes atomically.
 */
export async function withProfileTransaction<T>(
  database: ProfileDatabase,
  work: (tx: LedgerTransaction) => Promise<T>
): Promise<T> {
  return isDatabase(database) ? database.transaction(work) : work(database);
}
