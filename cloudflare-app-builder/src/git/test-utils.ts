/**
 * Test utilities for GitVersionControl unit tests
 *
 * Provides a SqlExecutor implementation backed by better-sqlite3
 * for realistic SQLite testing in Node.js.
 */

import Database, { Database as DatabaseType } from 'better-sqlite3';
import type { SqlExecutor } from '../types';

type SqlExecutorWithClose = SqlExecutor & { close: () => void };

// Track all databases for cleanup
const databases: DatabaseType[] = [];

/**
 * Creates an in-memory SQLite database and returns a SqlExecutor
 * compatible with SqliteFS and GitVersionControl.
 */
export function createTestSqlExecutor(): SqlExecutorWithClose {
  const db = new Database(':memory:');
  databases.push(db);

  const executor = (<T = unknown>(
    query: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] => {
    // Reconstruct the SQL query with placeholders
    let sql = '';
    for (let i = 0; i < query.length; i++) {
      sql += query[i];
      if (i < values.length) {
        sql += '?';
      }
    }

    // Handle statements without return values (CREATE, INSERT, UPDATE, DELETE)
    const trimmedSql = sql.trim().toUpperCase();
    if (
      trimmedSql.startsWith('CREATE') ||
      trimmedSql.startsWith('INSERT') ||
      trimmedSql.startsWith('UPDATE') ||
      trimmedSql.startsWith('DELETE')
    ) {
      db.prepare(sql).run(...values);
      return [] as T[];
    }

    // SELECT statements return rows
    return db.prepare(sql).all(...values) as T[];
  }) as SqlExecutorWithClose;

  executor.close = () => {
    db.close();
  };

  return executor;
}

/**
 * Close all databases opened during tests
 */
export function closeAllDatabases(): void {
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // Ignore - might already be closed
    }
  }
  databases.length = 0;
}
