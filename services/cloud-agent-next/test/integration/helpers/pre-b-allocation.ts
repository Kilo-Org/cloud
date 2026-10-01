import { sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/durable-sqlite';
import type { allocation as allocationTable } from '../../../src/control-plane/sandbox/sqlite-schema.js';

type AllocationRow = typeof allocationTable.$inferSelect;

/**
 * Insert a current allocation row into storage migrated only to the first
 * (pre-B) migration. That schema predates later columns such as
 * `create_failures`, which a Drizzle insert would always name, so the row is
 * written with plain SQL and the later migrations add those columns on
 * reconstruction.
 */
export function insertPreBAllocation(db: ReturnType<typeof drizzle>, row: AllocationRow): void {
  const { create_failures: _createFailures, stop_pending, ...rest } = row;
  const values: Record<string, string | number | null> = {
    ...rest,
    stop_pending: stop_pending ? 1 : 0,
  };
  const names = Object.keys(values);
  db.run(
    sql`INSERT INTO allocation (${sql.raw(names.map(name => `\`${name}\``).join(', '))}) VALUES (${sql.join(
      names.map(name => sql`${values[name]}`),
      sql`, `
    )})`
  );
}
