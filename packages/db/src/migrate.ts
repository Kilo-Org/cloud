/**
 * Applies pending Drizzle migrations with lock safety.
 *
 * `drizzle-kit migrate` cannot do this: it builds its own `pg.Pool` and
 * zod-strips unknown `dbCredentials` keys, so `lock_timeout` cannot be injected
 * through `drizzle.config.ts`. It also discards failures — a deadlocked
 * migration prints `applying migrations...undefined` and nothing else.
 *
 * Two behaviours matter against a database that is serving traffic:
 *
 * 1. `lock_timeout` is set below the server's `deadlock_timeout`. DDL needing
 *    `ACCESS EXCLUSIVE` on a busy table would otherwise sit in the lock queue
 *    until PostgreSQL's deadlock detector fires, and the detector aborts
 *    whichever party notices the cycle — in practice user requests rather than
 *    the migration. Timing out first makes the migration the only casualty.
 * 2. A lock failure is retried with backoff, so a transient collision costs
 *    seconds instead of failing the deploy and re-firing on every later merge.
 *
 * Run it with `pnpm drizzle:migrate-safely` (entry point: `migrate-cli.ts`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as z from 'zod';

import { computeDatabaseUrl, getDatabaseClientConfig } from './database-url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(SCRIPT_DIR, 'migrations');
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..');

const DEFAULT_LOCK_TIMEOUT = '500ms';
const DEFAULT_MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 15_000;
const MAX_LOGGED_TAGS = 10;

/** deadlock_detected, lock_not_available, serialization_failure. */
export const RETRYABLE_ERROR_CODES = new Set(['40P01', '55P03', '40001']);

const journalSchema = z.object({
  entries: z.array(z.object({ tag: z.string(), when: z.number() })),
});

const ledgerRowSchema = z.object({ max_created_at: z.string().nullable() });

const lockSettingsSchema = z.object({
  lock_timeout_ms: z.number(),
  deadlock_timeout_ms: z.number(),
});

const postgresErrorSchema = z.object({
  code: z.string(),
  detail: z.string().optional(),
  hint: z.string().optional(),
  where: z.string().optional(),
  table: z.string().optional(),
  constraint: z.string().optional(),
  message: z.string().optional(),
});

export type PostgresErrorFields = z.infer<typeof postgresErrorSchema>;
export type PendingMigration = { tag: string; sql: string };
type SqlRunner = (sql: string) => Promise<{ rows: unknown[] }>;

/** A refusal to start, rather than a migration failure. Reported without a stack. */
export class MigrationSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationSafetyError';
  }
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}

/** Unwraps DrizzleQueryError to reach the underlying pg error fields. */
export function findPostgresError(error: unknown): PostgresErrorFields | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    const parsed = postgresErrorSchema.safeParse(current);
    if (parsed.success) return parsed.data;
    current = current.cause;
  }
  return undefined;
}

/** Reads the failing SQL that DrizzleQueryError carries alongside the cause. */
export function findFailingQuery(error: unknown): string | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    if ('query' in current && typeof current.query === 'string') return current.query;
    current = current.cause;
  }
  return undefined;
}

/**
 * Migrations that break out of the migrator's transaction with a bare `COMMIT;`
 * (the workaround for `CREATE INDEX CONCURRENTLY`) cannot be replayed: a
 * failure after that commit leaves earlier statements applied but unrecorded.
 */
export function findTransactionBreakingMigrations(pending: PendingMigration[]): string[] {
  return pending
    .filter(migration =>
      migration.sql
        .split('--> statement-breakpoint')
        .some(statement => /^\s*COMMIT\s*;?\s*$/im.test(statement))
    )
    .map(migration => migration.tag);
}

export function backoffMs(attempt: number): number {
  return Math.min(1_000 * attempt, MAX_BACKOFF_MS) + Math.floor(Math.random() * 500);
}

export function reportFailure(error: unknown): void {
  if (error instanceof MigrationSafetyError) {
    console.error(`[migrate] refusing to run: ${error.message}`);
    return;
  }

  const postgresError = findPostgresError(error);
  if (!postgresError) {
    console.error('[migrate] migration failed');
    console.error(error);
    return;
  }

  // drizzle-kit discards every field below, which is why a deadlocked deploy
  // only ever printed "applying migrations...undefined".
  console.error(`[migrate] migration failed: ${postgresError.code}`);
  for (const [label, value] of [
    ['message', postgresError.message],
    ['detail', postgresError.detail],
    ['hint', postgresError.hint],
    ['where', postgresError.where],
    ['table', postgresError.table],
    ['constraint', postgresError.constraint],
  ] as const) {
    if (value) console.error(`[migrate]   ${label}: ${value}`);
  }

  const failingQuery = findFailingQuery(error);
  if (failingQuery) console.error(`[migrate]   failing statement: ${failingQuery}`);
}

/**
 * Retries only lock-acquisition failures. Everything else is a real migration
 * bug and must fail on the first attempt.
 */
export async function applyWithRetries(
  apply: () => Promise<void>,
  maxAttempts: number,
  sleep: (ms: number) => Promise<void> = ms => new Promise(done => setTimeout(done, ms))
): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      await apply();
      return attempt;
    } catch (error) {
      const code = findPostgresError(error)?.code;
      const isRetryable = code !== undefined && RETRYABLE_ERROR_CODES.has(code);

      if (!isRetryable) throw error;
      if (attempt >= maxAttempts) {
        console.error(
          `[migrate] gave up after ${attempt} attempt(s); a conflicting lock was held every time`
        );
        throw error;
      }

      const delay = backoffMs(attempt);
      console.warn(
        `[migrate] attempt ${attempt}/${maxAttempts} hit ${code}, retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
}

/**
 * Fails loudly when the session cannot lose the lock race, because that is the
 * property this runner exists to guarantee.
 */
async function assertLockTimeoutIsSafe(run: SqlRunner): Promise<void> {
  const result = await run(`
    select
      (select setting::int from pg_settings where name = 'lock_timeout') as lock_timeout_ms,
      (select setting::int from pg_settings where name = 'deadlock_timeout') as deadlock_timeout_ms
  `);
  const settings = lockSettingsSchema.parse(result.rows[0]);

  if (settings.lock_timeout_ms === 0) {
    throw new MigrationSafetyError(
      'lock_timeout is disabled on the migration session, so DDL would wait in the lock queue until the deadlock detector aborts a user query'
    );
  }
  if (settings.lock_timeout_ms >= settings.deadlock_timeout_ms) {
    throw new MigrationSafetyError(
      `lock_timeout (${settings.lock_timeout_ms}ms) must be below deadlock_timeout ` +
        `(${settings.deadlock_timeout_ms}ms), otherwise the deadlock detector can abort user queries first`
    );
  }

  console.log(
    `[migrate] lock_timeout=${settings.lock_timeout_ms}ms deadlock_timeout=${settings.deadlock_timeout_ms}ms`
  );
}

/**
 * Mirrors the migrator's own pending check: it compares each journal entry
 * against `max(created_at)`, so an entry older than the newest applied
 * migration is skipped even when it is absent from the ledger.
 */
async function readPendingMigrations(run: SqlRunner): Promise<PendingMigration[]> {
  const journalPath = resolve(MIGRATIONS_FOLDER, 'meta/_journal.json');
  const journal = journalSchema.parse(JSON.parse(readFileSync(journalPath, 'utf8')));

  let appliedThrough = 0;
  try {
    const result = await run(
      'select max(created_at)::text as max_created_at from drizzle.__drizzle_migrations'
    );
    const row = ledgerRowSchema.safeParse(result.rows[0]);
    appliedThrough = row.success ? Number(row.data.max_created_at ?? 0) : 0;
  } catch {
    // No ledger yet: this is a fresh database and everything is pending.
  }

  return journal.entries
    .filter(entry => entry.when > appliedThrough)
    .map(entry => ({
      tag: entry.tag,
      sql: readFileSync(resolve(MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8'),
    }));
}

function describeTags(tags: string[]): string {
  if (tags.length <= MAX_LOGGED_TAGS) return tags.join(', ');
  return `${tags.slice(0, MAX_LOGGED_TAGS).join(', ')} (+${tags.length - MAX_LOGGED_TAGS} more)`;
}

export async function runMigrations(): Promise<void> {
  loadEnvFile(resolve(REPO_ROOT, '.env.local'));
  loadEnvFile(resolve(REPO_ROOT, '.env'));

  const lockTimeout = process.env.MIGRATION_LOCK_TIMEOUT || DEFAULT_LOCK_TIMEOUT;
  const requestedAttempts = Number(process.env.MIGRATION_MAX_ATTEMPTS);
  const configuredMaxAttempts =
    Number.isInteger(requestedAttempts) && requestedAttempts > 0
      ? requestedAttempts
      : DEFAULT_MAX_ATTEMPTS;

  // A single Client rather than a Pool: drizzle's migrator runs the whole batch
  // in one transaction on one connection, so `SET lock_timeout` applies to every
  // statement with no pool checkout to race against.
  const client = new pg.Client({
    ...getDatabaseClientConfig(computeDatabaseUrl()),
    connectionTimeoutMillis: 30_000,
  });
  await client.connect();

  try {
    await client.query(`SET lock_timeout = '${lockTimeout}'`);
    await assertLockTimeoutIsSafe(sql => client.query(sql));

    const pending = await readPendingMigrations(sql => client.query(sql));
    if (pending.length === 0) {
      console.log('[migrate] no pending migrations');
      return;
    }
    console.log(
      `[migrate] ${pending.length} pending: ${describeTags(pending.map(migration => migration.tag))}`
    );

    const transactionBreaking = findTransactionBreakingMigrations(pending);
    if (transactionBreaking.length > 0) {
      console.warn(
        `[migrate] retries disabled: ${describeTags(transactionBreaking)} commit mid-migration and cannot be replayed safely`
      );
    }

    const db = drizzle(client);
    const attempts = await applyWithRetries(
      () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }),
      transactionBreaking.length > 0 ? 1 : configuredMaxAttempts
    );
    console.log(`[migrate] applied ${pending.length} migration(s) on attempt ${attempts}`);
  } finally {
    await client.end();
  }
}
