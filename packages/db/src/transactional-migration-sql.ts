/**
 * Drizzle's node-postgres migrator runs every pending migration inside one
 * `session.transaction` and splits files on `--> statement-breakpoint`.
 * `CREATE/DROP INDEX CONCURRENTLY` cannot run inside a transaction block.
 *
 * Generated migrations wrap those statements in `COMMIT;` / `BEGIN;` (see
 * packages/db/AGENTS.md). A merge that collapses several generated files can
 * drop that wrap. Rewriting at apply time injects the same wrap without
 * editing an already-applied migration file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

const CONCURRENT_INDEX =
  /(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX)\s+CONCURRENTLY/i;

type Journal = { entries: { tag: string }[] };

function executableBody(statement: string): string {
  return statement.replace(/^(?:--[^\n]*\n\s*)+/, '').trim();
}

function isCommit(statement: string): boolean {
  return /^COMMIT\b/i.test(executableBody(statement));
}

function isBegin(statement: string): boolean {
  return /^BEGIN\b/i.test(executableBody(statement));
}

function isConcurrentIndex(statement: string): boolean {
  return CONCURRENT_INDEX.test(executableBody(statement));
}

/**
 * Inject `COMMIT;` / `BEGIN;` around concurrent-index groups that would
 * otherwise run inside the migrator's wrapping transaction. Already-wrapped
 * files are left unchanged.
 */
export function rewriteMigrationSqlForTransactionalMigrator(sql: string): string {
  const statements = sql.split(STATEMENT_BREAKPOINT).map(chunk => chunk.trim());
  const out: string[] = [];
  // The migrator opens one transaction for the whole run, so a file starts
  // inside it.
  let inTransaction = true;
  let concurrentGroup: string[] = [];

  const flushConcurrentGroup = () => {
    if (concurrentGroup.length === 0) {
      return;
    }
    if (inTransaction) {
      out.push('COMMIT;');
    }
    out.push(...concurrentGroup);
    concurrentGroup = [];
    inTransaction = false;
  };

  for (const statement of statements) {
    if (!statement) {
      continue;
    }
    if (isConcurrentIndex(statement)) {
      concurrentGroup.push(statement);
      continue;
    }
    flushConcurrentGroup();
    if (!inTransaction && !isCommit(statement) && !isBegin(statement)) {
      out.push('BEGIN;');
      inTransaction = true;
    }
    out.push(statement);
    if (isCommit(statement)) {
      inTransaction = false;
    } else if (isBegin(statement)) {
      inTransaction = true;
    }
  }
  flushConcurrentGroup();

  // The migrator commits the wrapping transaction itself, so the file must
  // leave it open for the migrations that follow.
  if (!inTransaction) {
    out.push('BEGIN;');
  }

  return out.join(`${STATEMENT_BREAKPOINT}\n`);
}

/** Rewrite each journal SQL file in place. Missing files are skipped. */
export function rewriteMigrationsFolderInPlace(dir: string): void {
  const journal = JSON.parse(
    fs.readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8')
  ) as Journal;
  for (const entry of journal.entries) {
    const sqlPath = path.join(dir, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) {
      continue;
    }
    const sql = fs.readFileSync(sqlPath, 'utf8');
    fs.writeFileSync(sqlPath, rewriteMigrationSqlForTransactionalMigrator(sql));
  }
}

/**
 * Copy a drizzle migrations folder, rewriting each SQL file so concurrent
 * index statements are safe for drizzle-orm's transactional migrator.
 * Snapshots are omitted: migrate() only reads the journal and SQL files.
 */
export function writeTransactionalMigrationsFolder(sourceDir: string, destDir: string): string {
  fs.mkdirSync(path.join(destDir, 'meta'), { recursive: true });
  const journalPath = path.join(sourceDir, 'meta', '_journal.json');
  fs.copyFileSync(journalPath, path.join(destDir, 'meta', '_journal.json'));
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal;
  for (const entry of journal.entries) {
    fs.copyFileSync(path.join(sourceDir, `${entry.tag}.sql`), path.join(destDir, `${entry.tag}.sql`));
  }
  rewriteMigrationsFolderInPlace(destDir);
  return destDir;
}
