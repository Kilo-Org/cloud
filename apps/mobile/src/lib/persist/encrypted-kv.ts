import * as Sentry from '@sentry/react-native';
import { and, asc, eq, like, sql } from 'drizzle-orm';
// The `drizzle-orm/expo-sqlite` barrel also pulls in `useLiveQuery`, which
// imports expo-sqlite for change listeners this store never uses; the driver
// subpath is the same `drizzle()` without that.
import { drizzle } from 'drizzle-orm/expo-sqlite/driver';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import migrations from '../../../drizzle/migrations';
import { PERSIST_DB_KEY } from '@/lib/storage-keys';
import { kv } from './schema';

/**
 * Encrypted key-value store over one SQLCipher database (DEC-01).
 *
 * One database `kilo-persist.db`, keyed by a 32-byte random hex key held in
 * SecureStore. All plaintext lives only inside the encrypted database file;
 * no unencrypted store is created.
 *
 * Every statement runs through Drizzle: the table lives in `./schema.ts`, the
 * `drizzle/` migrations are generated from it, and the pragmas and probes use
 * Drizzle's `sql` template. Only the database lifecycle (open, close, delete)
 * stays on expo-sqlite, which has no Drizzle equivalent. Drizzle's expo driver
 * wraps the *synchronous* handle, so the statements themselves block the JS
 * thread; the exported API stays async because opening and keying do not.
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

type KVDatabase = ReturnType<typeof drizzle>;

/** One entry of {@link listEntries}; values are intentionally not returned. */
export type KVPair = {
  k: string;
  updatedAt: number;
};

// The empty check is load-bearing, not a type duplicate: an empty scope
// silently widens `clearScopePrefix` to every scope in the database.
export function validateScope(scope: string): void {
  if (scope.length === 0) {
    throw new TypeError('encrypted-kv: scope must be a non-empty string');
  }
}

export function validateItemKey(scope: string, k: string): void {
  validateScope(scope);
  if (k.length === 0) {
    throw new TypeError('encrypted-kv: key must be a non-empty string');
  }
}

function validateValue(v: string): void {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- runtime guard against a non-string call from an untyped JS caller
  if (typeof v !== 'string') {
    throw new TypeError('encrypted-kv: value must be a string');
  }
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
function assertSQLCipher(client: SQLite.SQLiteDatabase): void {
  const row = client.getFirstSync<{ cipher_version?: string }>('PRAGMA cipher_version');
  if (!row?.cipher_version) {
    throw new MissingSQLCipherError();
  }
}

/** Closes the native handle, best-effort: a failed close must not mask the cause. */
async function closeQuietly(client: SQLite.SQLiteDatabase): Promise<void> {
  try {
    await client.closeAsync();
  } catch {
    // Close is best-effort; the delete in the recovery path removes the file.
  }
}

async function openWithKey(key: string): Promise<KVDatabase> {
  if (!isValidDbKey(key)) {
    // A malformed or tampered key never reaches PRAGMA interpolation; the
    // thrown error routes the open into delete-and-recreate recovery.
    throw new TypeError('encrypted-kv: database key must be 64 lowercase hex characters');
  }
  // Connection setup, not a query, so it stays on the raw handle: SQLCipher
  // needs the key before the database header and the schema can be read, and
  // Drizzle would prepare the statement, which itself can read the schema and
  // fail with SQLITE_NOTADB on a real encrypted file. `PRAGMA cipher_version`
  // stays ahead of the key because it reads a compile-time constant and
  // touches no page, so no key is ever set on an unencrypted handle.
  const client = SQLite.openDatabaseSync(DATABASE_NAME);
  try {
    assertSQLCipher(client);
    client.execSync(`PRAGMA key = "x'${key}'"`);
    return drizzle(client);
  } catch (error) {
    // The PRAGMA failed after the handle opened. Close it before rethrowing
    // so the delete-and-recreate recovery never runs with an open handle.
    await closeQuietly(client);
    throw error;
  }
}

async function probeAndMigrate(db: KVDatabase): Promise<void> {
  // A wrong key or a corrupt file makes this throw (DEC-01 step 3).
  db.get(sql`SELECT count(*) FROM sqlite_master`);
  // Drizzle owns the schema; a recreated (deleted) file has no
  // `__drizzle_migrations` table, so the migrations run again on it.
  await migrate(db, migrations);
}

async function openEncryptedDatabase(): Promise<KVDatabase> {
  const key = await readOrCreateKey();
  let db: KVDatabase | undefined = undefined;
  try {
    db = await openWithKey(key);
    await probeAndMigrate(db);
    return db;
  } catch (openError) {
    if (openError instanceof MissingSQLCipherError) {
      // Deleting and recreating cannot add SQLCipher to the build, and the
      // existing file may hold the user's drafts. Fail loud, touch nothing.
      Sentry.captureException(openError, {
        level: 'error',
        tags: { 'error.subsystem': 'encrypted-kv', 'error.operation': 'open' },
        fingerprint: ['encrypted-kv-missing-sqlcipher'],
      });
      throw openError;
    }
    // Wrong key, corrupt file, or a tampered key: cache and drafts are
    // recoverable losses. Close, delete the file, regenerate the key, and
    // reopen (DEC-01 step 4).
    if (db) {
      await closeQuietly(db.$client);
    }
    let reopened: KVDatabase | undefined = undefined;
    try {
      await SQLite.deleteDatabaseAsync(DATABASE_NAME);
      const freshKey = await generateAndStoreKey();
      reopened = await openWithKey(freshKey);
      await probeAndMigrate(reopened);
      Sentry.captureException(openError, {
        level: 'warning',
        tags: { 'error.subsystem': 'encrypted-kv', 'error.operation': 'reset' },
      });
      return reopened;
    } catch (resetError) {
      // The whole recovery is inside this try: a failed delete, key
      // regeneration, or reopen must report too, because the open memo makes
      // one failure reject every caller for the rest of the install.
      // Close the reopened handle before rethrowing so a failed recovery
      // cannot leak it; the delete above already removed the file.
      if (reopened) {
        await closeQuietly(reopened.$client);
      }
      Sentry.captureException(resetError, {
        level: 'error',
        tags: { 'error.subsystem': 'encrypted-kv', 'error.operation': 'reset' },
      });
      throw resetError;
    }
  }
}

let openPromise: Promise<KVDatabase> | null = null;

// eslint-disable-next-line require-await, @typescript-eslint/require-await -- single-flight must memoize the open synchronously before any await; the awaits live inside the memoized open chain (same pattern as chainSave in save-chain.ts)
async function openDatabase(): Promise<KVDatabase> {
  // Single-flight: one module-level open promise, awaited by every caller.
  // The memo is kept on failure too, so every later caller rejects with the
  // same error instead of re-running the open. Retrying would delete the
  // database, regenerate the key, and report to Sentry once per call — and
  // the read cache calls on every query settle. Nothing an open failure hits
  // is transient: a wrong key, a corrupt file, and a build without SQLCipher
  // all need a relaunch or a rebuild.
  openPromise ??= openEncryptedDatabase();
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
  const row = db
    .select({ v: kv.v })
    .from(kv)
    .where(and(eq(kv.scope, scope), eq(kv.k, k)))
    .get();
  return row?.v ?? null;
}

/** Writes or overwrites one value, recording `Date.now()`. */
export async function setItem(scope: string, k: string, v: string): Promise<void> {
  validateItemKey(scope, k);
  validateValue(v);
  const db = await openDatabase();
  const updatedAt = Date.now();
  db.insert(kv)
    .values({ scope, k, v, updatedAt })
    .onConflictDoUpdate({ target: [kv.scope, kv.k], set: { v, updatedAt } })
    .run();
}

/** Removes one value; a missing key is not an error. */
export async function removeItem(scope: string, k: string): Promise<void> {
  validateItemKey(scope, k);
  const db = await openDatabase();
  db.delete(kv)
    .where(and(eq(kv.scope, scope), eq(kv.k, k)))
    .run();
}

/** Removes every entry in exactly one scope. */
export async function clearScope(scope: string): Promise<void> {
  validateScope(scope);
  const db = await openDatabase();
  db.delete(kv).where(eq(kv.scope, scope)).run();
}

/** Removes every entry whose scope starts with `prefix` (SQL `LIKE prefix || '%'`). */
export async function clearScopePrefix(prefix: string): Promise<void> {
  validateScope(prefix);
  const db = await openDatabase();
  db.delete(kv)
    .where(like(kv.scope, sql`${prefix} || '%'`))
    .run();
}

/**
 * Lists one scope's entries oldest-first (by `updated_at`), without values —
 * the eviction read path.
 */
export async function listEntries(scope: string): Promise<KVPair[]> {
  validateScope(scope);
  const db = await openDatabase();
  return db
    .select({ k: kv.k, updatedAt: kv.updatedAt })
    .from(kv)
    .where(eq(kv.scope, scope))
    .orderBy(asc(kv.updatedAt))
    .all();
}
