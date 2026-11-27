import { createHash, randomUUID } from 'node:crypto';
import { DB_HOST } from './docker';

/** Migration sets and `/apply` bodies for the container suite. */

export const MIGRATIONS = 'packages/db/src/migrations';
const BREAK = '\n--> statement-breakpoint\n';

export function gitBlobSha(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

export type Migration = { tag: string; sql: string; when?: number };

let clock = 1_800_000_000_000;

/** A journal and its files; `when` rises by entry unless given. */
export type MigrationSet = {
  journal: string;
  files: Record<string, string>;
  reviewed: { path: string; blob: string }[];
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
};

export function migrationSet(migrations: readonly Migration[]): MigrationSet {
  const entries = migrations.map((migration, idx) => {
    clock += 1000;
    return {
      idx,
      version: '7',
      when: migration.when ?? clock,
      tag: migration.tag,
      breakpoints: true,
    };
  });
  const files = Object.fromEntries(
    migrations.map(migration => [`${migration.tag}.sql`, migration.sql])
  );
  const reviewed = migrations.map(migration => ({
    path: `${MIGRATIONS}/${migration.tag}.sql`,
    blob: gitBlobSha(migration.sql),
  }));
  return {
    journal: JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
    files,
    reviewed,
    entries,
  };
}

/** The repository's CONCURRENTLY pattern (packages/db/AGENTS.md): out of the transaction and back. */
export function concurrentIndex(table: string, index: string, column: string): string {
  return [
    'COMMIT;',
    'SET statement_timeout = 0;',
    'SET lock_timeout = 0;',
    `DROP INDEX CONCURRENTLY IF EXISTS "${index}";`,
    `CREATE INDEX CONCURRENTLY "${index}" ON "${table}" USING btree ("${column}");`,
    'RESET lock_timeout;',
    'RESET statement_timeout;',
    'BEGIN;',
  ].join(BREAK);
}

export type Login = {
  user: string;
  password: string;
  loginMode: 'member' | 'direct';
  sessionKey: 'label' | 'pid';
};

export function applyBody(
  login: Login,
  database: string,
  set: MigrationSet,
  extra: {
    recordedPairs?: { pid: number; backendStart: string }[];
    reviewed?: { path: string; blob: string }[];
    host?: string;
  } = {}
) {
  return {
    runId: randomUUID(),
    target: { host: extra.host ?? DB_HOST, port: 5432, database },
    ...login,
    recordedPairs: extra.recordedPairs ?? [],
    journal: set.journal,
    files: set.files,
    reviewed: extra.reviewed ?? set.reviewed,
  };
}

/** `(pid, backend_start)` of a session, in the form the container reports. */
export const PAIR_SQL = `SELECT pg_backend_pid() AS pid,
  to_char(backend_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "backendStart"
  FROM pg_stat_activity WHERE pid = pg_backend_pid()`;
