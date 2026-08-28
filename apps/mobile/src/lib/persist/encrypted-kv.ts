import * as Sentry from '@sentry/react-native';
import { and, asc, eq, sql } from 'drizzle-orm';
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
 * Opening is single-flight. A failed open stays memoized until explicit nondestructive Retry.
 * Every failure preserves the database and stored key. Drafts are not recoverable cache data.
 * Malformed keys, corrupt files, and missing SQLCipher require specific recovery guidance.
 */

const DATABASE_NAME = 'kilo-persist.db';
const KEY_BYTE_COUNT = 32;

// SQLCipher key format: exactly 64 lowercase hex chars (32 bytes). A stored
// key that does not match stays protected for explicit repair and never reaches PRAGMA interpolation.
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

let pendingNewKey: string | null = null;

async function readOrCreateKey(): Promise<string> {
  let existing: string | null = null;
  try {
    existing = await SecureStore.getItemAsync(PERSIST_DB_KEY);
  } catch {
    throw openFailure({
      status: 'retryable',
      reason: 'secure-store',
      guidance: 'retry',
    });
  }
  // Even an empty stored key is malformed, not evidence that the store is new.
  if (existing !== null) {
    return existing;
  }
  pendingNewKey ??= await generateHexKey();
  try {
    await SecureStore.setItemAsync(PERSIST_DB_KEY, pendingNewKey);
  } catch {
    throw openFailure({
      status: 'retryable',
      reason: 'secure-store',
      guidance: 'retry',
    });
  }
  const key = pendingNewKey;
  pendingNewKey = null;
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
    // Preserve the original failure and the durable file even when closing the handle fails.
  }
}

async function openWithKey(key: string): Promise<KVDatabase> {
  if (!isValidDbKey(key)) {
    // Preserve the file and key for explicit recovery. Never interpolate malformed key bytes.
    throw openFailure({
      status: 'protected',
      reason: 'malformed-key',
      guidance: 'restore-key',
    });
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
    // Close the failed native handle without deleting the file or replacing its key.
    await closeQuietly(client);
    throw error;
  }
}

async function probeAndMigrate(db: KVDatabase): Promise<void> {
  // A wrong key or a corrupt file makes this throw (DEC-01 step 3).
  db.get(sql`SELECT count(*) FROM sqlite_master`);
  // Drizzle applies missing migrations without resetting existing records.
  await migrate(db, migrations);
}

export type EncryptedStoreRecovery = Readonly<{
  status: 'retryable' | 'protected';
  reason:
    | 'secure-store'
    | 'io'
    | 'malformed-key'
    | 'corrupt-database'
    | 'missing-sqlcipher'
    | 'unknown';
  guidance: 'retry' | 'restore-key' | 'repair-database' | 'rebuild' | 'retry-without-reset';
}>;

const openRecoveries = new WeakMap<Error, EncryptedStoreRecovery>();
function openFailure(recovery: EncryptedStoreRecovery): Error {
  const error = new Error(`Encrypted store open failed: ${recovery.reason}`);
  openRecoveries.set(error, Object.freeze(recovery));
  return error;
}

export function encryptedStoreRecovery(error: unknown): EncryptedStoreRecovery {
  const known = error instanceof Error ? openRecoveries.get(error) : undefined;
  if (known) {
    return known;
  }
  if (error instanceof MissingSQLCipherError) {
    return { status: 'protected', reason: 'missing-sqlcipher', guidance: 'rebuild' };
  }
  // Drizzle wraps native SQLite errors. Classify the native cause without logging its SQL text.
  const native = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const message = native instanceof Error ? native.message : '';
  if (
    /file is not a database|database disk image is malformed|SQLITE_(NOTADB|CORRUPT)/i.test(message)
  ) {
    return { status: 'protected', reason: 'corrupt-database', guidance: 'repair-database' };
  }
  if (
    /SQLITE_(BUSY|LOCKED|IOERR|CANTOPEN)|disk I\/O error|database is (locked|busy)|unable to open database file/i.test(
      message
    )
  ) {
    return { status: 'retryable', reason: 'io', guidance: 'retry' };
  }
  return { status: 'protected', reason: 'unknown', guidance: 'retry-without-reset' };
}

async function openEncryptedDatabase(): Promise<KVDatabase> {
  let db: KVDatabase | undefined = undefined;
  try {
    const key = await readOrCreateKey();
    db = await openWithKey(key);
    await probeAndMigrate(db);
    return db;
  } catch (error) {
    if (db) {
      await closeQuietly(db.$client);
    }
    const failure =
      error instanceof MissingSQLCipherError ? error : openFailure(encryptedStoreRecovery(error));
    // Never report native SQL text: a failing key pragma can contain the encryption key.
    Sentry.captureException(failure, {
      level: 'error',
      tags: { 'error.subsystem': 'encrypted-kv', 'error.operation': 'open' },
      ...(error instanceof MissingSQLCipherError
        ? { fingerprint: ['encrypted-kv-missing-sqlcipher'] }
        : {}),
    });
    throw failure;
  }
}

type OpenAttempt = { promise: Promise<KVDatabase>; failed: boolean };
let openAttempt: OpenAttempt | null = null;

async function recordOpenFailure(attempt: OpenAttempt): Promise<void> {
  try {
    await attempt.promise;
  } catch {
    // Mutate only this settled attempt, never the memo for a newer attempt.
    attempt.failed = true;
  }
}

// eslint-disable-next-line require-await, @typescript-eslint/require-await -- memoize before any caller can start a second open
async function openDatabase(): Promise<KVDatabase> {
  if (!openAttempt) {
    openAttempt = { promise: openEncryptedDatabase(), failed: false };
    void recordOpenFailure(openAttempt);
  }
  return openAttempt.promise;
}

/** Explicit, nondestructive Retry. Pending attempts coalesce; successful handles remain open. */
export async function retryEncryptedKvOpen(): Promise<void> {
  if (openAttempt?.failed) {
    openAttempt = null;
  }
  await openDatabase();
}

export function resetEncryptedKvOpenForTests(): void {
  openAttempt = null;
  pendingNewKey = null;
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

/** Check the captured owner again after the asynchronous open, immediately before the SQL write. */
// eslint-disable-next-line max-params -- the optional owner fence preserves the KV API
export async function setItem(
  scope: string,
  k: string,
  v: string,
  isCurrent?: () => boolean
): Promise<void> {
  validateItemKey(scope, k);
  validateValue(v);
  if (isCurrent && !isCurrent()) {
    return;
  }
  const db = await openDatabase();
  if (isCurrent && !isCurrent()) {
    return;
  }
  const updatedAt = Date.now();
  db.insert(kv)
    .values({ scope, k, v, updatedAt })
    .onConflictDoUpdate({ target: [kv.scope, kv.k], set: { v, updatedAt } })
    .run();
}

export async function removeItem(
  scope: string,
  k: string,
  isCurrent?: () => boolean
): Promise<void> {
  validateItemKey(scope, k);
  if (isCurrent && !isCurrent()) {
    return;
  }
  const db = await openDatabase();
  if (isCurrent && !isCurrent()) {
    return;
  }
  db.delete(kv)
    .where(and(eq(kv.scope, scope), eq(kv.k, k)))
    .run();
}

export async function clearScope(scope: string, isCurrent?: () => boolean): Promise<void> {
  validateScope(scope);
  if (isCurrent && !isCurrent()) {
    return;
  }
  const db = await openDatabase();
  if (isCurrent && !isCurrent()) {
    return;
  }
  db.delete(kv).where(eq(kv.scope, scope)).run();
}

/** Match a literal prefix: arbitrary user IDs can contain SQL LIKE wildcards. */
export async function clearScopePrefix(
  prefix: string,
  isCurrent?: () => boolean,
  numericSuffixOnly = false
): Promise<void> {
  validateScope(prefix);
  if (isCurrent && !isCurrent()) {
    return;
  }
  const db = await openDatabase();
  if (isCurrent && !isCurrent()) {
    return;
  }
  // Version-only suffixes prevent user a's cleanup from matching user a:b's cache scopes.
  const suffix = sql`substr(${kv.scope}, length(${prefix}) + 1)`;
  db.delete(kv)
    .where(
      and(
        sql`substr(${kv.scope}, 1, length(${prefix})) = ${prefix}`,
        numericSuffixOnly ? sql`length(${suffix}) > 0 AND ${suffix} NOT GLOB '*[^0-9]*'` : undefined
      )
    )
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
