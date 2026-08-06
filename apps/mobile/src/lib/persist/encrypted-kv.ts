import * as Sentry from '@sentry/react-native';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { PERSIST_DB_KEY } from '@/lib/storage-keys';

/**
 * Encrypted key-value store over one SQLCipher database (DEC-01).
 *
 * One database `kilo-persist.db`, keyed by a 32-byte random hex key held in
 * SecureStore. All plaintext lives only inside the encrypted database file;
 * no unencrypted store is created.
 *
 * Opening is single-flight: one module-level open promise, awaited by every
 * caller. A wrong key or a corrupt file fails the `sqlite_master` probe and
 * is recovered by closing, deleting the database, generating a fresh key,
 * and reopening — the loss is accepted (cache and drafts are recoverable
 * losses), startup is never blocked, and the reset is reported to Sentry.
 */

const DATABASE_NAME = 'kilo-persist.db';
const KEY_BYTE_COUNT = 32;

// SQLCipher key format: exactly 64 lowercase hex chars (32 bytes). A stored
// key that does not match is treated as tampered: it must never reach PRAGMA
// interpolation, and the open is routed into delete-and-recreate recovery.
const DB_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** True when `key` is exactly 64 lowercase hex characters (32 bytes). */
export function isValidDbKey(key: string): boolean {
  return DB_KEY_PATTERN.test(key);
}

// The KV schema is part of the DEC-01 contract.
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS kv (
  scope TEXT NOT NULL,
  k TEXT NOT NULL,
  v TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, k)
)`;

const SELECT_ITEM_SQL = 'SELECT v FROM kv WHERE scope = ? AND k = ?';
const UPSERT_ITEM_SQL = `INSERT INTO kv (scope, k, v, bytes, updated_at) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(scope, k) DO UPDATE SET
  v = excluded.v,
  bytes = excluded.bytes,
  updated_at = excluded.updated_at`;
const DELETE_ITEM_SQL = 'DELETE FROM kv WHERE scope = ? AND k = ?';
const DELETE_SCOPE_SQL = 'DELETE FROM kv WHERE scope = ?';
const DELETE_SCOPE_PREFIX_SQL = `DELETE FROM kv WHERE scope LIKE ? || '%'`;
const SCOPE_BYTES_SQL = 'SELECT COALESCE(SUM(bytes), 0) AS total FROM kv WHERE scope = ?';
const LIST_ENTRIES_SQL =
  'SELECT k, bytes, updated_at FROM kv WHERE scope = ? ORDER BY updated_at ASC';
const PROBE_SQL = 'SELECT count(*) FROM sqlite_master';
const CIPHER_VERSION_SQL = 'PRAGMA cipher_version';

/** One entry of {@link listEntries}; values are intentionally not returned. */
export type KVPair = {
  k: string;
  bytes: number;
  updatedAt: number;
};

export function validateScope(scope: string): void {
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new TypeError('encrypted-kv: scope must be a non-empty string');
  }
}

export function validateItemKey(scope: string, k: string): void {
  validateScope(scope);
  if (typeof k !== 'string' || k.length === 0) {
    throw new TypeError('encrypted-kv: key must be a non-empty string');
  }
}

function validateValue(v: string): void {
  if (typeof v !== 'string') {
    throw new TypeError('encrypted-kv: value must be a string');
  }
}

/** UTF-8 byte length of `value`; the `bytes` column records this. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

async function generateHexKey(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(KEY_BYTE_COUNT);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

async function readOrCreateKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(PERSIST_DB_KEY);
  if (existing) {
    return existing;
  }
  const key = await generateHexKey();
  await SecureStore.setItemAsync(PERSIST_DB_KEY, key);
  return key;
}

async function generateAndStoreKey(): Promise<string> {
  const key = await generateHexKey();
  await SecureStore.setItemAsync(PERSIST_DB_KEY, key);
  return key;
}

/**
 * Thrown when the native build has no SQLCipher. Distinct from every other
 * open failure because delete-and-recreate cannot fix it: only a native
 * rebuild can.
 */
export class MissingSQLCipherError extends Error {
  constructor() {
    super('encrypted-kv: the native build has no SQLCipher; refusing to open a plaintext database');
    this.name = 'MissingSQLCipherError';
  }
}

/**
 * Proves SQLCipher is linked into the build before any key is set.
 *
 * Plain SQLite ignores an unrecognized pragma without an error, so a
 * successful `PRAGMA key` proves nothing: on a build without SQLCipher the
 * file would open in plaintext and still pass the `sqlite_master` probe.
 * `PRAGMA cipher_version` returns a row only when SQLCipher is present.
 */
async function assertSQLCipher(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ cipher_version?: string }>(CIPHER_VERSION_SQL);
  if (!row?.cipher_version) {
    throw new MissingSQLCipherError();
  }
}

async function openWithKey(key: string): Promise<SQLite.SQLiteDatabase> {
  if (!isValidDbKey(key)) {
    // A malformed or tampered key never reaches PRAGMA interpolation; the
    // thrown error routes the open into delete-and-recreate recovery.
    throw new TypeError('encrypted-kv: database key must be 64 lowercase hex characters');
  }
  const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
  try {
    await assertSQLCipher(db);
    await db.execAsync(`PRAGMA key = "x'${key}'"`);
    return db;
  } catch (error) {
    // The PRAGMA failed after the handle opened. Close it before rethrowing
    // so the delete-and-recreate recovery never runs with an open handle.
    try {
      await db.closeAsync();
    } catch {
      // Close is best-effort; the delete below still removes the file.
    }
    throw error;
  }
}

async function probeAndCreateSchema(db: SQLite.SQLiteDatabase): Promise<void> {
  // A wrong key or a corrupt file makes this throw (DEC-01 step 3).
  await db.getFirstAsync<Record<string, number>>(PROBE_SQL);
  await db.execAsync(CREATE_TABLE_SQL);
}

async function openEncryptedDatabase(): Promise<SQLite.SQLiteDatabase> {
  const key = await readOrCreateKey();
  let db: SQLite.SQLiteDatabase | undefined = undefined;
  try {
    db = await openWithKey(key);
    await probeAndCreateSchema(db);
    return db;
  } catch (openError) {
    if (openError instanceof MissingSQLCipherError) {
      // Deleting and recreating cannot add SQLCipher to the build, and the
      // existing file may hold the user's drafts. Fail loud, touch nothing.
      Sentry.captureException(openError, {
        level: 'error',
        extra: { database: DATABASE_NAME, reason: 'encrypted-kv build has no SQLCipher' },
      });
      throw openError;
    }
    // Wrong key, corrupt file, or a tampered key: cache and drafts are
    // recoverable losses. Close, delete the file, regenerate the key, and
    // reopen (DEC-01 step 4).
    if (db) {
      try {
        await db.closeAsync();
      } catch {
        // Close is best-effort; the delete below still removes the file.
      }
    }
    await SQLite.deleteDatabaseAsync(DATABASE_NAME);
    const freshKey = await generateAndStoreKey();
    const reopened = await openWithKey(freshKey);
    try {
      await probeAndCreateSchema(reopened);
      Sentry.captureException(openError, {
        level: 'warning',
        extra: { database: DATABASE_NAME, reason: 'encrypted-kv reset after failed probe' },
      });
      return reopened;
    } catch (resetError) {
      // Close the reopened handle before rethrowing so a failed recovery
      // cannot leak it; the delete above already removed the file.
      try {
        await reopened.closeAsync();
      } catch {
        // Close is best-effort.
      }
      Sentry.captureException(resetError, {
        level: 'error',
        extra: { database: DATABASE_NAME, reason: 'encrypted-kv reset failed' },
      });
      throw resetError;
    }
  }
}

let openPromise: Promise<SQLite.SQLiteDatabase> | null = null;

// eslint-disable-next-line require-await, @typescript-eslint/require-await -- single-flight must memoize the open synchronously before any await; the awaits live inside the memoized open chain (same pattern as chainSave in save-chain.ts)
async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  // Single-flight: one module-level open promise, awaited by every caller.
  // A total open failure drops the memo so a later caller can retry.
  openPromise ??= (async () => {
    try {
      return await openEncryptedDatabase();
    } catch (error) {
      openPromise = null;
      throw error;
    }
  })();
  return openPromise;
}

// Test-only: drops the memoized open so a test can force a fresh open
// (the same pattern as `inFlightSaveCount` in save-chain.ts).
export function resetEncryptedKvOpenForTests(): void {
  openPromise = null;
}

/** Reads one value; returns null when the key is absent. */
export async function getItem(scope: string, k: string): Promise<string | null> {
  validateItemKey(scope, k);
  const db = await openDatabase();
  const row = await db.getFirstAsync<{ v: string }>(SELECT_ITEM_SQL, scope, k);
  return row?.v ?? null;
}

/** Writes or overwrites one value, recording its UTF-8 byte length and `Date.now()`. */
export async function setItem(scope: string, k: string, v: string): Promise<void> {
  validateItemKey(scope, k);
  validateValue(v);
  const db = await openDatabase();
  const bytes = utf8ByteLength(v);
  const updatedAt = Date.now();
  await db.runAsync(UPSERT_ITEM_SQL, scope, k, v, bytes, updatedAt);
}

/** Removes one value; a missing key is not an error. */
export async function removeItem(scope: string, k: string): Promise<void> {
  validateItemKey(scope, k);
  const db = await openDatabase();
  await db.runAsync(DELETE_ITEM_SQL, scope, k);
}

/** Removes every entry in exactly one scope. */
export async function clearScope(scope: string): Promise<void> {
  validateScope(scope);
  const db = await openDatabase();
  await db.runAsync(DELETE_SCOPE_SQL, scope);
}

/** Removes every entry whose scope starts with `prefix` (SQL `LIKE prefix || '%'`). */
export async function clearScopePrefix(prefix: string): Promise<void> {
  validateScope(prefix);
  const db = await openDatabase();
  await db.runAsync(DELETE_SCOPE_PREFIX_SQL, prefix);
}

/** Sum of the stored UTF-8 byte lengths in one scope; 0 when the scope is empty. */
export async function scopeBytes(scope: string): Promise<number> {
  validateScope(scope);
  const db = await openDatabase();
  const row = await db.getFirstAsync<{ total: number }>(SCOPE_BYTES_SQL, scope);
  return row?.total ?? 0;
}

/**
 * Lists one scope's entries oldest-first (by `updated_at`), without values —
 * the eviction read path.
 */
export async function listEntries(scope: string): Promise<KVPair[]> {
  validateScope(scope);
  const db = await openDatabase();
  const rows = await db.getAllAsync<{ k: string; bytes: number; updated_at: number }>(
    LIST_ENTRIES_SQL,
    scope
  );
  return rows.map(row => ({ k: row.k, bytes: row.bytes, updatedAt: row.updated_at }));
}
