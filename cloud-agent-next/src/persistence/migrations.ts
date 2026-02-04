/**
 * Schema migration system for CloudAgentSession Durable Object.
 *
 * Migrations are versioned and run sequentially using blockConcurrencyWhile()
 * in the DO constructor to ensure consistency.
 *
 * Schema is defined inline below; no separate SQL doc file.
 *
 * ⚠️ IMPORTANT: When modifying table schemas here, also update the corresponding
 * Zod schemas in src/db/tables/ to keep them in sync. The Zod schemas provide
 * type-safe query building and runtime validation for queries using these tables.
 */

// Schema version constants
export const CURRENT_SCHEMA_VERSION = 1;
const SCHEMA_VERSION_KEY = 'schema_version';

type SqlStorage = DurableObjectState['storage']['sql'];

// Migration functions for each version
// Each migration should be idempotent (use IF NOT EXISTS)
const migrations: Record<number, (sql: SqlStorage) => void> = {
  // v1: Initial schema with all tables
  // Creates events, execution_leases, and command_queue tables
  1: sql => {
    // Enable WAL mode for better concurrency
    // Wrapped in try-catch as some test environments may not support PRAGMA
    try {
      sql.exec('PRAGMA journal_mode=WAL');
    } catch (_e) {
      // Ignore PRAGMA errors in test environments
      // WAL mode is a performance optimization, not a correctness requirement
    }

    // Events table: stores all streaming events for replay
    sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        stream_event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);

    // Events indexes for efficient filtering
    sql.exec('CREATE INDEX IF NOT EXISTS idx_events_execution ON events(execution_id)');
    sql.exec('CREATE INDEX IF NOT EXISTS idx_events_type ON events(stream_event_type)');
    sql.exec('CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)');
    sql.exec('CREATE INDEX IF NOT EXISTS idx_events_id_execution ON events(id, execution_id)');

    // Execution leases table: prevents duplicate processing
    sql.exec(`
      CREATE TABLE IF NOT EXISTS execution_leases (
        execution_id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message_id TEXT
      )
    `);

    sql.exec('CREATE INDEX IF NOT EXISTS idx_leases_expires ON execution_leases(lease_expires_at)');

    // Command queue table: stores commands from client to be processed by executor
    sql.exec(`
      CREATE TABLE IF NOT EXISTS command_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    sql.exec('CREATE INDEX IF NOT EXISTS idx_command_queue_session ON command_queue(session_id)');
  },
};

/**
 * Get current schema version from storage.
 * Returns 0 if no version has been set (fresh DO).
 */
export async function getSchemaVersion(state: DurableObjectState): Promise<number> {
  const version = await state.storage.get<number>(SCHEMA_VERSION_KEY);
  return version ?? 0;
}

/**
 * Set schema version in storage.
 */
export async function setSchemaVersion(state: DurableObjectState, version: number): Promise<void> {
  await state.storage.put(SCHEMA_VERSION_KEY, version);
}

/**
 * Run all pending migrations up to CURRENT_SCHEMA_VERSION.
 *
 * This function should be called inside blockConcurrencyWhile() in the DO constructor
 * to ensure migrations are atomic and no concurrent requests see partial state.
 *
 * @example
 * ```ts
 * constructor(state: DurableObjectState, env: Env) {
 *   super(state, env);
 *   state.blockConcurrencyWhile(async () => {
 *     await runMigrations(state);
 *   });
 * }
 * ```
 */
export async function runMigrations(state: DurableObjectState): Promise<void> {
  const currentVersion = await getSchemaVersion(state);

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return; // Already up to date
  }

  const sql = state.storage.sql;

  // Run each migration in order
  for (let version = currentVersion + 1; version <= CURRENT_SCHEMA_VERSION; version++) {
    const migration = migrations[version];
    if (migration) {
      migration(sql);
    }
  }

  await setSchemaVersion(state, CURRENT_SCHEMA_VERSION);
}
