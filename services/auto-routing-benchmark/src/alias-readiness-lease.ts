import { sql, type SQL } from 'drizzle-orm';

/**
 * Dedicated `scheduler_dispatch_lock` row of the alias-promotion readiness fence. Rows 1-3
 * belong to dispatch passes, run initialization and a deploy's intent; this row is only ever
 * written by the promotion that holds it, so neither side waits on the other's token.
 */
export const ALIAS_READINESS_LEASE_ID = 4;

/**
 * SQLite's own clock in epoch milliseconds. It is read once per publication, before the
 * batch, and that one value becomes the cutoff every guard in the batch compares against.
 * Reading the clock inside each statement would let the lease expire between two statements
 * of the same batch — an early skip and a later write, a partial publication.
 */
export const ALIAS_READINESS_DB_NOW_MS_SQL = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

/**
 * True while no unexpired readiness lease is held, as of a fixed cutoff bound to `?1`. A null
 * token is a released row and an expired lease is one nobody holds, so both admit.
 *
 * A lease acquired after the cutoff was sampled has `lease_until > ?1` and therefore blocks
 * the whole batch: the conservative direction, because the promotion's readiness scan cannot
 * have seen this publication. A lease expired before the cutoff admits the whole batch.
 */
export const ALIAS_READINESS_CLEAR_SQL = `NOT EXISTS (
  SELECT 1 FROM scheduler_dispatch_lock
  WHERE id = ${ALIAS_READINESS_LEASE_ID}
    AND token IS NOT NULL
    AND lease_until > ?1
)`;

/** The one clock read a publication makes before its batch. */
export function aliasReadinessSampleClockStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT ${ALIAS_READINESS_DB_NOW_MS_SQL} AS now_ms`);
}

/** {@link ALIAS_READINESS_CLEAR_SQL} for a drizzle WHERE clause, bound to the sampled cutoff. */
export function aliasReadinessClearSql(nowMs: number): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM scheduler_dispatch_lock
    WHERE id = ${ALIAS_READINESS_LEASE_ID}
      AND token IS NOT NULL
      AND lease_until > ${nowMs}
  )`;
}

/** The single-row read a publication batches first: `free` is 1 while it may publish. */
export function aliasReadinessFenceReadStatement(
  db: D1Database,
  nowMs: number
): D1PreparedStatement {
  return db.prepare(`SELECT ${ALIAS_READINESS_CLEAR_SQL} AS free`).bind(nowMs);
}
