import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const WastelandRegistryRecord = z.object({
  wasteland_id: z.string(),
  owner_type: z.enum(['user', 'org']),
  owner_user_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  name: z.string(),
  // `<owner>/<repo>` slug stored verbatim (DoltHub slugs are
  // case-insensitive in practice; lookups normalise to lowercase
  // before comparing — see findByOwnerRepo).
  dolthub_upstream: z.string().nullable(),
  created_at: z.string(),
});

export type WastelandRegistryRecord = z.output<typeof WastelandRegistryRecord>;

export const wasteland_registry = getTableFromZodSchema(
  'wasteland_registry',
  WastelandRegistryRecord
);

export function createTableWastelandRegistry(): string {
  return getCreateTableQueryFromTable(wasteland_registry, {
    wasteland_id: `text primary key`,
    owner_type: `text not null check(owner_type in ('user', 'org'))`,
    owner_user_id: `text`,
    organization_id: `text`,
    name: `text not null`,
    dolthub_upstream: `text`,
    created_at: `text not null default (datetime('now'))`,
  });
}

/**
 * Idempotent ALTER statements for upgrading an already-initialised
 * registry. Each runs inside a try/catch by the caller because SQLite
 * rejects `ADD COLUMN` for an existing column with a non-recoverable
 * error code.
 */
export const wastelandRegistryAlterStatements: readonly string[] = [
  `ALTER TABLE ${wasteland_registry} ADD COLUMN ${wasteland_registry.columns.dolthub_upstream} TEXT`,
];

/**
 * Indexes that should always exist after initialisation. Issued via
 * `CREATE INDEX IF NOT EXISTS` so they're idempotent on every boot.
 */
export const wastelandRegistryCreateIndexStatements: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_${wasteland_registry}_dolthub_upstream
     ON ${wasteland_registry} (${wasteland_registry.columns.dolthub_upstream})`,
];
