/* eslint-disable max-lines -- one encrypted store: the key, the open recovery, and every kv query share one module-level open */
import * as Sentry from '@sentry/react-native';
import { and, asc, eq, like, sql } from 'drizzle-orm';
// The `drizzle-orm/expo-sqlite` barrel also pulls in `useLiveQuery`, which
// imports expo-sqlite for change listeners this store never uses; the driver
// subpath is the same `drizzle()` without that.
import { drizzle } from 'drizzle-orm/expo-sqlite/driver';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import * as Crypto from 'expo-crypto';
import * as SecureStore from '@/lib/auth/secure-store';
import * as SQLite from 'expo-sqlite';
import migrations from '../../../drizzle/migrations';
import { readStoredValueWithRetry } from '@/lib/auth/secure-store-read';
import {
  isProtectedDataAvailable,
  ProtectedDataUnavailableError,
  whenProtectedDataAvailable,
} from '@/lib/protected-data';
import { PERSIST_DB_KEY } from '@/lib/storage-keys';
import { kv } from './schema';

/**
 * Encrypted key-value store over one SQLCipher database (DEC-01).
 *
 * One database `kilo-persist.db`, keyed by a 32-byte random hex key held in
 * SecureStore. All plaintext lives only inside the encrypted database file;
 * no unencrypted store is created.
 *
 * Connection setup stays on the raw synchronous expo-sqlite handle: the
 * SQLCipher probe, `PRAGMA key`, and the busy-timeout and journal-mode
 * pragmas must all run before anything reads the schema, and Drizzle would
 * prepare a statement that itself reads it. Once the connection is keyed, the
 * table lives in `./schema.ts`, the `drizzle/` migrations are generated from
 * it, and this module's queries go through Drizzle. Drizzle's expo driver
 * wraps the *synchronous* handle, so the statements themselves block the JS
 * thread; the exported API stays async because opening and keying do not.
 *
 * Opening is single-flight: one module-level open promise, awaited by every
 * caller. A wrong key or a corrupt file fails the `sqlite_master` probe. That
 * failure is recovered by closing, deleting the database, generating a fresh
 * key, and reopening. The reset is reported to Sentry and startup is never
 * blocked. The unreadable file is the trigger. It also holds the durable
 * chats table and the harness SDK's conversation tables, which are lost with
 * it. A failed migration is different. The file opened and keyed correctly,
 * so the failure is reported under the migration operation and rethrown
 * without deleting anything — unless the rejection carries a corruption
 * signal, which means the file is unreadable after all, and the same
 * delete-and-recreate recovery runs. A busy or locked failure is the third
 * case. A lock is evidence about another connection, not about the file, so
 * it is reported under the open operation and rethrown with the file and the
 * key intact — including a lock that surfaces inside the migration, which is
 * reported there under the open operation instead of the migration one. The
 * memo is dropped for it, so the next caller retries the open after the lock
 * clears.
 */

const DATABASE_NAME = 'kilo-persist.db';
const KEY_BYTE_COUNT = 32;

// How long a statement waits for another connection's lock before it fails
// with SQLITE_BUSY. Without it, SQLite's default rollback-journal behaviour
// fails a synchronous write the moment a lock is held, which is the reported
// `database is locked` rejection (KILO-APP-7K / KILO-APP-5J / KILO-APP-5H).
const BUSY_TIMEOUT_MS = 5000;

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
  // A transient keychain rejection must not be read as "no key": retrying it
  // keeps one rejection from failing the open, which is memoized for the rest
  // of the process.
  const existing = await readStoredValueWithRetry(PERSIST_DB_KEY);
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

/**
 * Open failures whose native handle could not be closed. Delete-and-recreate
 * must not run over such a handle, so recovery reports the cause and rethrows
 * it instead of opening a second connection to the same file. The error
 * identity is the signal, so no wrapper type is needed.
 */
const unclosedOpenErrors = new WeakSet<Error>();

/** Closes the native handle, best-effort. The return value is load-bearing: a
 * handle that did not close must not be replaced by a second connection to the
 * same file, because that is the `old connection still open` shape behind the
 * reported `database is locked` rejection. */
async function closeQuietly(client: SQLite.SQLiteDatabase): Promise<boolean> {
  try {
    await client.closeAsync();
    return true;
  } catch {
    // Close is best-effort here; the caller decides whether it can proceed.
    return false;
  }
}

/**
 * Configures the single connection to wait out a lock and to prefer WAL. Both
 * pragmas must run after `PRAGMA key` and before any statement reads the
 * schema, so a concurrent writer waits instead of failing immediately.
 *
 * WAL is a preference, not a precondition. Some engines and files refuse the
 * switch (a held lock, a read-only file, a build without WAL), and a refusal
 * says nothing about whether the database works: the row reports the mode the
 * connection is in after the request, and any supported mode is usable. An
 * open that failed here would be read as a corrupt file, so the store would be
 * deleted and recreated on every launch, losing its cache and drafts. The
 * `sqlite_master` probe that follows is the real usability test.
 */
function configureConnection(client: SQLite.SQLiteDatabase): void {
  client.execSync(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  let journalMode = 'unknown';
  let pragmaFailed = false;
  try {
    const row = client.getFirstSync<{ journal_mode?: string }>('PRAGMA journal_mode = WAL');
    journalMode = row?.journal_mode?.toLowerCase() ?? journalMode;
  } catch {
    // Rejected by the engine (for example SQLITE_BUSY). The connection keeps
    // the mode it already had; nothing about the store is decided here.
    pragmaFailed = true;
  }
  if (!pragmaFailed && journalMode === 'wal') {
    return;
  }
  // A breadcrumb, not an event: it rides on the next captured event, so a
  // device that never reaches WAL does not file an issue on every launch.
  Sentry.addBreadcrumb({
    category: 'encrypted-kv',
    level: 'warning',
    message: pragmaFailed
      ? 'PRAGMA journal_mode = WAL was rejected'
      : 'journal_mode did not switch to WAL',
    data: { journal_mode: journalMode },
  });
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
    configureConnection(client);
    return drizzle(client);
  } catch (error) {
    // The setup failed after the handle opened. Close it before rethrowing so
    // the delete-and-recreate recovery never runs with an open handle. If the
    // handle will not close, mark the error: recovery must not replace it.
    if (!(await closeQuietly(client)) && error instanceof Error) {
      unclosedOpenErrors.add(error);
    }
    throw error;
  }
}

// A failed migration is tagged with this message before it leaves
// `migrateSchema`. The open catch reads the tag: a migration failed on a file
// that opened and keyed correctly, which delete-and-recreate must not touch —
// it would discard a readable file the migration itself did not damage. A
// class would trip the file's one-class lint rule, so the tag travels on a
// plain Error.
const MIGRATION_FAILURE_MESSAGE = 'encrypted-kv: schema migration failed on a keyed database';

// Damage in a non-first page passes the `sqlite_master` count and surfaces
// inside `migrate()` instead. These engine messages mean the file itself is
// unreadable, so the open routes them into the same delete-and-recreate
// recovery as a failed probe. Every other migrate rejection is a migration or
// environment failure on a readable file and keeps the file.
const CORRUPTION_SIGNALS = [
  'SQLITE_CORRUPT',
  'SQLITE_NOTADB',
  'file is not a database',
  'database disk image is malformed',
];

function isCorruptionSignal(error: unknown): boolean {
  // Drizzle wraps a failed statement in its own error and keeps the engine
  // error in `cause`, so the signal can sit one level down.
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const candidate = current;
    if (CORRUPTION_SIGNALS.some(signal => candidate.message.includes(signal))) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

// A lock is transient evidence about another connection, not about the file.
// The engine reports it from the `sqlite_master` probe and from `PRAGMA key`
// alike, and neither says anything about the key or the file's contents, so
// the open must not read them as an unreadable file.
const BUSY_SIGNALS = [
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'database is locked',
  'database table is locked',
];

function isBusySignal(error: unknown): boolean {
  // Same walk as `isCorruptionSignal`: the driver keeps the engine error in
  // `cause`, so the signal can sit one level down.
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const candidate = current;
    if (BUSY_SIGNALS.some(signal => candidate.message.includes(signal))) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function probeSchema(db: KVDatabase): void {
  // A wrong key or a corrupt file makes this throw (DEC-01 step 3).
  db.get(sql`SELECT count(*) FROM sqlite_master`);
}

async function migrateSchema(db: KVDatabase): Promise<void> {
  // Drizzle owns the schema; a recreated (deleted) file has no
  // `__drizzle_migrations` table, so the migrations run again on it. A failure
  // here is a migration error on a file that opened and keyed correctly, not
  // a corrupt file.
  try {
    await migrate(db, migrations);
  } catch (error) {
    // Tag every rejection, including a non-Error throw: the open must route
    // each one through the migration branch, never into the destructive reset.
    throw new Error(MIGRATION_FAILURE_MESSAGE, { cause: error });
  }
}

/**
 * Reports an open failure that could not be recovered, because the previous
 * handle is still open, then rethrows the original error.
 */
function reportAbortedReset(cause: unknown): never {
  Sentry.captureException(cause, {
    level: 'error',
    tags: { 'error.subsystem': 'encrypted-kv', 'error.operation': 'reset' },
  });
  throw cause;
}

async function openEncryptedDatabase(): Promise<KVDatabase> {
  const key = await readOrCreateKey();
  let db: KVDatabase | undefined = undefined;
  try {
    db = await openWithKey(key);
    // The probe throws synchronously, before any await can interleave.
    probeSchema(db);
    await migrateSchema(db);
    return db;
  } catch (openError) {
    // The device locked during the open, so the failure says nothing about the
    // key or the file. Never delete the database for it.
    if (!isProtectedDataAvailable()) {
      if (db) {
        await closeQuietly(db.$client);
      }
      throw new ProtectedDataUnavailableError();
    }
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
    // The file opened and keyed correctly, so the migration failed there. A
    // corruption signal means the file is unreadable after all: route it into
    // the delete-and-recreate recovery below, like a failed probe. Any other
    // rejection is a migration or environment failure on a readable file —
    // report it and rethrow: deleting the file would lose the chats and
    // conversation tables the failure never touched.
    let resetCause = openError;
    if (openError instanceof Error && openError.message === MIGRATION_FAILURE_MESSAGE) {
      if (!isCorruptionSignal(openError.cause)) {
        if (db) {
          await closeQuietly(db.$client);
        }
        // A lock reached through the migration is still a lock: report it
        // under the open operation like every other busy failure, not as a
        // migration error.
        Sentry.captureException(openError.cause, {
          level: isBusySignal(openError.cause) ? 'warning' : 'error',
          tags: {
            'error.subsystem': 'encrypted-kv',
            'error.operation': isBusySignal(openError.cause) ? 'open' : 'migration',
          },
        });
        throw openError.cause;
      }
      // The corruption report rides on the reset report below; a separate
      // capture would file the same unreadable file twice. The close stays
      // with the shared reset block, which closes the handle exactly once.
      resetCause = openError.cause;
    }
    // A lock proves another connection held the file, not that the file or the
    // key is bad. Report it and rethrow with the store intact: deleting it
    // would discard readable data the lock never touched, and the next launch
    // opens the same file again.
    if (isBusySignal(resetCause)) {
      // A handle that will not close is a leaked connection, which the
      // relaunch clears; the failure itself is still the busy one.
      if (db) {
        await closeQuietly(db.$client);
      }
      Sentry.captureException(resetCause, {
        level: 'warning',
        tags: { 'error.subsystem': 'encrypted-kv', 'error.operation': 'open' },
      });
      throw resetCause;
    }
    // Wrong key, corrupt file, or a tampered key: cache and drafts are
    // recoverable losses. Close, delete the file, regenerate the key, and
    // reopen (DEC-01 step 4). This file also holds the durable chats table and
    // the harness SDK's conversation tables. This recovery is the last resort
    // for them, and it runs only when the file cannot be read.
    if (db) {
      // The probe failed after the handle opened. A handle that will not close
      // must not be replaced by a second connection to the same file: abort
      // the reset and report the original open error instead.
      if (!(await closeQuietly(db.$client))) {
        reportAbortedReset(resetCause);
      }
    } else if (resetCause instanceof Error && unclosedOpenErrors.has(resetCause)) {
      // The failed open never returned a handle, and its handle is still open.
      reportAbortedReset(resetCause);
    }
    let reopened: KVDatabase | undefined = undefined;
    try {
      await SQLite.deleteDatabaseAsync(DATABASE_NAME);
      const freshKey = await generateAndStoreKey();
      reopened = await openWithKey(freshKey);
      probeSchema(reopened);
      await migrateSchema(reopened);
      Sentry.captureException(resetCause, {
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

/**
 * The key lives in the keychain, which refuses every call while the device is
 * locked. A background run waits for unlock instead of failing the open, and
 * a lock during the open drops the memo so the next caller opens again.
 */
async function openWhenProtectedDataAvailable(): Promise<KVDatabase> {
  await whenProtectedDataAvailable();
  try {
    return await openEncryptedDatabase();
  } catch (error) {
    // The key read and write sit outside the open's own lock check, and the
    // keychain refuses them with a raw native error, not the typed one. Any
    // failure while locked drops the memo.
    if (error instanceof ProtectedDataUnavailableError || !isProtectedDataAvailable()) {
      openPromise = null;
    }
    // A busy failure is transient: the lock clears, so the next caller must
    // retry the open instead of rejecting for the rest of the process.
    if (isBusySignal(error)) {
      openPromise = null;
    }
    throw error;
  }
}

// eslint-disable-next-line require-await, @typescript-eslint/require-await -- single-flight must memoize the open synchronously before any await; the awaits live inside the memoized open chain (same pattern as chainSave in save-chain.ts)
async function openDatabase(): Promise<KVDatabase> {
  // Single-flight: one module-level open promise, awaited by every caller.
  // The memo is kept on failure too, so every later caller rejects with the
  // same error instead of re-running the open. Retrying would delete the
  // database, regenerate the key, and report to Sentry once per call — and
  // the read cache calls on every query settle. Nothing an open failure hits
  // is transient: a wrong key, a corrupt file, and a build without SQLCipher
  // all need a relaunch or a rebuild. Two exceptions drop the memo and retry
  // on the next call: a locked device (see `openWhenProtectedDataAvailable`)
  // and a busy or locked engine failure, which the same function clears.
  openPromise ??= openWhenProtectedDataAvailable();
  return openPromise;
}

// Test-only: drops the memoized open so a test can force a fresh open
// (the same pattern as `inFlightSaveCount` in save-chain.ts).
export function resetEncryptedKvOpenForTests(): void {
  openPromise = null;
}

/**
 * The encrypted database itself, for a caller that owns tables of its own.
 *
 * The chat store is the one: it hands this handle to the harness SDK, which
 * keeps the conversations in tables of its own on the same file. One file
 * means one key, one SQLCipher probe, and one delete-and-recreate recovery
 * rather than a second copy of all three. The delete runs on a failed probe,
 * or on a migration rejection that carries a corruption signal; every other
 * failed migration reports and rethrows, and the file stays. A busy or locked
 * failure reports and rethrows the same way: a lock says nothing about the
 * file or the key.
 */
export async function encryptedDatabase(): Promise<SQLite.SQLiteDatabase> {
  const db = await openDatabase();
  return db.$client;
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

type KvWrite = { readonly value: string; readonly signal?: AbortSignal };

/** Writes or overwrites one value, recording `Date.now()`. */
export async function setItem(scope: string, k: string, value: string): Promise<void> {
  await setItemWithSignal(scope, k, { value });
}

export async function setItemWithSignal(
  scope: string,
  k: string,
  { value: v, signal }: KvWrite
): Promise<void> {
  validateItemKey(scope, k);
  validateValue(v);
  const db = await openDatabase();
  if (signal?.aborted) {
    throw new Error('The storage operation was cancelled');
  }
  const updatedAt = Date.now();
  db.insert(kv)
    .values({ scope, k, v, updatedAt })
    .onConflictDoUpdate({ target: [kv.scope, kv.k], set: { v, updatedAt } })
    .run();
}

/** Removes one value; a missing key is not an error. */
export async function removeItem(scope: string, k: string, signal?: AbortSignal): Promise<void> {
  validateItemKey(scope, k);
  const db = await openDatabase();
  if (signal?.aborted) {
    throw new Error('The storage operation was cancelled');
  }
  db.delete(kv)
    .where(and(eq(kv.scope, scope), eq(kv.k, k)))
    .run();
}

/**
 * Removes one value only while it still equals `v`, in one statement.
 *
 * A read followed by {@link removeItem} is two store calls, so a newer write
 * under the same key can commit in the gap and be deleted by the stale caller.
 * Comparing the value inside the `DELETE` closes that window: a newer value
 * never matches `v` and survives. Returns `true` when a row was removed.
 */
export async function removeItemIfValue(scope: string, k: string, v: string): Promise<boolean> {
  validateItemKey(scope, k);
  validateValue(v);
  const db = await openDatabase();
  const result = db
    .delete(kv)
    .where(and(eq(kv.scope, scope), eq(kv.k, k), eq(kv.v, v)))
    .run();
  return result.changes > 0;
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

/** Reads one scope's values oldest-first in one statement, for cache hydration. */
export async function listValues(scope: string): Promise<string[]> {
  validateScope(scope);
  const db = await openDatabase();
  return db
    .select({ v: kv.v })
    .from(kv)
    .where(eq(kv.scope, scope))
    .orderBy(asc(kv.updatedAt))
    .all()
    .map(row => row.v);
}
