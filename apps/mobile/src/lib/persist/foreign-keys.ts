/** A connection that runs one statement per call, which every SQLite driver here can do. */
export type PragmaClient = { readonly execSync: (sql: string) => void };

/**
 * Enforces the foreign keys the migrations declare.
 *
 * Call this after the migrator, never before. A drizzle-kit table rebuild emits
 * `PRAGMA foreign_keys = OFF` around its work, and that statement is a no-op
 * inside a transaction, which is where the migrator runs. On a connection that
 * already enforces them, such a rebuild would drop the table and take every
 * cascading row with it.
 */
export function enableForeignKeys(client: PragmaClient): void {
  client.execSync('PRAGMA foreign_keys = ON');
}
