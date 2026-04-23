import { db, readDb } from '@/lib/drizzle';
import {
  usage_rollup_hourly,
  usage_rollup_daily,
  usage_rollup_monthly,
  usage_rollup_hourly_totals,
  usage_rollup_daily_totals,
  usage_rollup_monthly_totals,
  usage_rollup_watermark,
} from '@kilocode/db/schema';
import { sql, lt } from 'drizzle-orm';

export type Granularity = 'hourly' | 'daily' | 'monthly';

export const ROLLUP_RETENTION_DAYS: Record<Granularity, number | null> = {
  hourly: 7,
  daily: 90,
  monthly: null, // forever
};

type WideRollupRow = {
  time_bucket: string;
  kilo_user_id: string;
  organization_id: string | null;
  model: string;
  feature: string;
  mode: string;
  provider: string;
  project_id: string;
  cost_microdollars: string;
  input_tokens: string;
  output_tokens: string;
  cache_write_tokens: string;
  cache_hit_tokens: string;
  request_count: string;
  error_count: string;
  cancelled_count: string;
  free_request_count: string;
  byok_request_count: string;
  total_latency_ms: string;
  total_generation_time_ms: string;
  latency_count: string;
};

type TotalsRollupRow = {
  time_bucket: string;
  kilo_user_id: string;
  organization_id: string | null;
  cost_microdollars: string;
  input_tokens: string;
  output_tokens: string;
  cache_write_tokens: string;
  cache_hit_tokens: string;
  request_count: string;
  error_count: string;
  cancelled_count: string;
  free_request_count: string;
  byok_request_count: string;
  total_latency_ms: string;
  total_generation_time_ms: string;
  latency_count: string;
};

/**
 * Returns a SQL fragment for bucketing `microdollar_usage.created_at`.
 *
 * Safety: this function only ever returns one of three hard-coded string
 * literals, selected via a typed `Granularity` union. The returned value is
 * splicef into SQL via `sql.raw()` downstream, which is safe here because
 * no user input ever reaches this string. Do NOT change this function to
 * interpolate external values without switching to a parameterized
 * representation.
 */
function getTimeBucketSql(granularity: Granularity): string {
  switch (granularity) {
    case 'hourly':
      return `DATE_TRUNC('hour', mu.created_at)`;
    case 'daily':
      return `DATE_TRUNC('day', mu.created_at)::date`;
    case 'monthly':
      return `DATE_TRUNC('month', mu.created_at)::date`;
  }
}

async function computeWideRollup(
  granularity: Granularity,
  startIso: string,
  endIso: string
): Promise<WideRollupRow[]> {
  const timeBucket = getTimeBucketSql(granularity);
  const result = await readDb.execute<WideRollupRow>(sql`
    SELECT
      ${sql.raw(timeBucket)} AS time_bucket,
      mu.kilo_user_id,
      mu.organization_id,
      COALESCE(mu.requested_model, mu.model, 'unknown') AS model,
      COALESCE(f.feature, 'unattributed') AS feature,
      COALESCE(m.mode, 'unknown') AS mode,
      COALESCE(mu.provider, 'unknown') AS provider,
      COALESCE(mu.project_id, 'none') AS project_id,
      SUM(mu.cost) AS cost_microdollars,
      SUM(mu.input_tokens) AS input_tokens,
      SUM(mu.output_tokens) AS output_tokens,
      SUM(mu.cache_write_tokens) AS cache_write_tokens,
      SUM(mu.cache_hit_tokens) AS cache_hit_tokens,
      COUNT(*) AS request_count,
      COUNT(*) FILTER (WHERE mu.has_error = true) AS error_count,
      COUNT(*) FILTER (WHERE meta.cancelled = true) AS cancelled_count,
      COUNT(*) FILTER (WHERE meta.is_free = true) AS free_request_count,
      COUNT(*) FILTER (WHERE meta.is_byok = true) AS byok_request_count,
      COALESCE(SUM((meta.latency * 1000)::bigint) FILTER (WHERE meta.latency IS NOT NULL), 0)
        AS total_latency_ms,
      COALESCE(SUM((meta.generation_time * 1000)::bigint) FILTER (WHERE meta.generation_time IS NOT NULL), 0)
        AS total_generation_time_ms,
      COUNT(*) FILTER (WHERE meta.latency IS NOT NULL) AS latency_count
    FROM microdollar_usage mu
    LEFT JOIN microdollar_usage_metadata meta ON mu.id = meta.id
    LEFT JOIN feature f ON meta.feature_id = f.feature_id
    LEFT JOIN mode m ON meta.mode_id = m.mode_id
    WHERE mu.created_at >= ${startIso}
      AND mu.created_at < ${endIso}
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
  `);
  return result.rows;
}

async function computeTotalsRollup(
  granularity: Granularity,
  startIso: string,
  endIso: string
): Promise<TotalsRollupRow[]> {
  const timeBucket = getTimeBucketSql(granularity);
  const result = await readDb.execute<TotalsRollupRow>(sql`
    SELECT
      ${sql.raw(timeBucket)} AS time_bucket,
      mu.kilo_user_id,
      mu.organization_id,
      SUM(mu.cost) AS cost_microdollars,
      SUM(mu.input_tokens) AS input_tokens,
      SUM(mu.output_tokens) AS output_tokens,
      SUM(mu.cache_write_tokens) AS cache_write_tokens,
      SUM(mu.cache_hit_tokens) AS cache_hit_tokens,
      COUNT(*) AS request_count,
      COUNT(*) FILTER (WHERE mu.has_error = true) AS error_count,
      COUNT(*) FILTER (WHERE meta.cancelled = true) AS cancelled_count,
      COUNT(*) FILTER (WHERE meta.is_free = true) AS free_request_count,
      COUNT(*) FILTER (WHERE meta.is_byok = true) AS byok_request_count,
      COALESCE(SUM((meta.latency * 1000)::bigint) FILTER (WHERE meta.latency IS NOT NULL), 0)
        AS total_latency_ms,
      COALESCE(SUM((meta.generation_time * 1000)::bigint) FILTER (WHERE meta.generation_time IS NOT NULL), 0)
        AS total_generation_time_ms,
      COUNT(*) FILTER (WHERE meta.latency IS NOT NULL) AS latency_count
    FROM microdollar_usage mu
    LEFT JOIN microdollar_usage_metadata meta ON mu.id = meta.id
    WHERE mu.created_at >= ${startIso}
      AND mu.created_at < ${endIso}
    GROUP BY 1, 2, 3
  `);
  return result.rows;
}

export type DayRollupCounts = {
  hourlyWide: number;
  hourlyTotals: number;
  dailyWide: number;
  dailyTotals: number;
};

/**
 * PostgreSQL's wire protocol caps a single query at 65535 parameters
 * (uint16). Wide rollup rows serialize ~21 columns each; totals rows ~16.
 * Chunking at 1000 rows keeps us well under the cap (~21K params worst case)
 * with plenty of headroom for driver overhead.
 */
const INSERT_CHUNK_SIZE = 1000;

type AnyDb = Parameters<typeof db.transaction>[0] extends (tx: infer Tx) => unknown ? Tx : never;

async function insertChunked<T>(
  tx: AnyDb,
  table: Parameters<AnyDb['insert']>[0],
  rows: T[]
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
    await tx.insert(table).values(chunk);
  }
}

function mapWideRow(r: WideRollupRow, timeKey: 'hour' | 'day' | 'month') {
  return {
    [timeKey]: r.time_bucket,
    kilo_user_id: r.kilo_user_id,
    organization_id: r.organization_id,
    model: r.model,
    feature: r.feature,
    mode: r.mode,
    provider: r.provider,
    project_id: r.project_id,
    cost_microdollars: Number(r.cost_microdollars),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    cache_write_tokens: Number(r.cache_write_tokens),
    cache_hit_tokens: Number(r.cache_hit_tokens),
    request_count: Number(r.request_count),
    error_count: Number(r.error_count),
    cancelled_count: Number(r.cancelled_count),
    free_request_count: Number(r.free_request_count),
    byok_request_count: Number(r.byok_request_count),
    total_latency_ms: Number(r.total_latency_ms),
    total_generation_time_ms: Number(r.total_generation_time_ms),
    latency_count: Number(r.latency_count),
  };
}

function mapTotalsRow(r: TotalsRollupRow, timeKey: 'hour' | 'day' | 'month') {
  return {
    [timeKey]: r.time_bucket,
    kilo_user_id: r.kilo_user_id,
    organization_id: r.organization_id,
    cost_microdollars: Number(r.cost_microdollars),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    cache_write_tokens: Number(r.cache_write_tokens),
    cache_hit_tokens: Number(r.cache_hit_tokens),
    request_count: Number(r.request_count),
    error_count: Number(r.error_count),
    cancelled_count: Number(r.cancelled_count),
    free_request_count: Number(r.free_request_count),
    byok_request_count: Number(r.byok_request_count),
    total_latency_ms: Number(r.total_latency_ms),
    total_generation_time_ms: Number(r.total_generation_time_ms),
    latency_count: Number(r.latency_count),
  };
}

/**
 * Process a single day: compute hourly and daily rollups and replace existing
 * rows atomically within a transaction. Does NOT touch the monthly rollup —
 * callers should invoke `processMonth` separately (typically once per month
 * after all days in the month are rolled up, to avoid redundant recomputation).
 *
 * Queries run serially to keep memory pressure low (each aggregate can spawn
 * parallel workers that claim `/dev/shm`).
 */
export async function processDay(dayIso: string): Promise<DayRollupCounts> {
  const dayStart = new Date(`${dayIso}T00:00:00.000Z`).toISOString();
  const dayEnd = new Date(
    new Date(`${dayIso}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000
  ).toISOString();

  const hourlyWideRows = await computeWideRollup('hourly', dayStart, dayEnd);
  const hourlyTotalsRows = await computeTotalsRollup('hourly', dayStart, dayEnd);
  const dailyWideRows = await computeWideRollup('daily', dayStart, dayEnd);
  const dailyTotalsRows = await computeTotalsRollup('daily', dayStart, dayEnd);

  await db.transaction(async tx => {
    // --- Hourly wide ---
    await tx.execute(sql`
      DELETE FROM ${usage_rollup_hourly}
      WHERE hour >= ${dayStart} AND hour < ${dayEnd}
    `);
    await insertChunked(
      tx,
      usage_rollup_hourly,
      hourlyWideRows.map(r => mapWideRow(r, 'hour'))
    );

    // --- Hourly totals ---
    await tx.execute(sql`
      DELETE FROM ${usage_rollup_hourly_totals}
      WHERE hour >= ${dayStart} AND hour < ${dayEnd}
    `);
    await insertChunked(
      tx,
      usage_rollup_hourly_totals,
      hourlyTotalsRows.map(r => mapTotalsRow(r, 'hour'))
    );

    // --- Daily wide ---
    await tx.execute(sql`
      DELETE FROM ${usage_rollup_daily} WHERE day = ${dayIso}
    `);
    await insertChunked(
      tx,
      usage_rollup_daily,
      dailyWideRows.map(r => mapWideRow(r, 'day'))
    );

    // --- Daily totals ---
    await tx.execute(sql`
      DELETE FROM ${usage_rollup_daily_totals} WHERE day = ${dayIso}
    `);
    await insertChunked(
      tx,
      usage_rollup_daily_totals,
      dailyTotalsRows.map(r => mapTotalsRow(r, 'day'))
    );

    // Monthly wide/totals are intentionally NOT written here.
    // Callers should invoke processMonth separately to keep monthly idempotent.
  });

  return {
    hourlyWide: hourlyWideRows.length,
    hourlyTotals: hourlyTotalsRows.length,
    dailyWide: dailyWideRows.length,
    dailyTotals: dailyTotalsRows.length,
  };
}

/**
 * Return the first day of the month (YYYY-MM-01) for a given day ISO (YYYY-MM-DD).
 */
export function monthOfDay(dayIso: string): string {
  return `${dayIso.slice(0, 7)}-01`;
}

/**
 * Compute and replace monthly rollup for an entire month (idempotent).
 */
export async function processMonth(
  monthIsoDate: string
): Promise<{ monthlyWide: number; monthlyTotals: number }> {
  const monthStart = `${monthIsoDate}T00:00:00.000Z`;
  const startDate = new Date(monthStart);
  const nextMonth = new Date(startDate);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthEnd = nextMonth.toISOString();

  const monthlyWideRows = await computeWideRollup('monthly', monthStart, monthEnd);
  const monthlyTotalsRows = await computeTotalsRollup('monthly', monthStart, monthEnd);

  await db.transaction(async tx => {
    await tx.execute(sql`
      DELETE FROM ${usage_rollup_monthly} WHERE month = ${monthIsoDate}
    `);
    await insertChunked(
      tx,
      usage_rollup_monthly,
      monthlyWideRows.map(r => mapWideRow(r, 'month'))
    );

    await tx.execute(sql`
      DELETE FROM ${usage_rollup_monthly_totals} WHERE month = ${monthIsoDate}
    `);
    await insertChunked(
      tx,
      usage_rollup_monthly_totals,
      monthlyTotalsRows.map(r => mapTotalsRow(r, 'month'))
    );
  });

  return { monthlyWide: monthlyWideRows.length, monthlyTotals: monthlyTotalsRows.length };
}

export async function updateWatermark(
  granularity: Granularity,
  lastCompletedIso: string
): Promise<void> {
  await db
    .insert(usage_rollup_watermark)
    .values({
      granularity,
      last_completed: lastCompletedIso,
    })
    .onConflictDoUpdate({
      target: usage_rollup_watermark.granularity,
      set: {
        last_completed: lastCompletedIso,
      },
    });
}

/**
 * Delete rows beyond the retention window for each granularity.
 */
export async function cleanupRetention(): Promise<{
  hourly: number;
  hourlyTotals: number;
  daily: number;
  dailyTotals: number;
}> {
  const hourlyCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Daily cutoff: 90 days ago as a DATE
  const dailyCutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const dailyCutoff = dailyCutoffDate.toISOString().slice(0, 10);

  const hourly = await db
    .delete(usage_rollup_hourly)
    .where(lt(usage_rollup_hourly.hour, hourlyCutoff));
  const hourlyTotals = await db
    .delete(usage_rollup_hourly_totals)
    .where(lt(usage_rollup_hourly_totals.hour, hourlyCutoff));
  const daily = await db.delete(usage_rollup_daily).where(lt(usage_rollup_daily.day, dailyCutoff));
  const dailyTotals = await db
    .delete(usage_rollup_daily_totals)
    .where(lt(usage_rollup_daily_totals.day, dailyCutoff));

  return {
    hourly: hourly.rowCount ?? 0,
    hourlyTotals: hourlyTotals.rowCount ?? 0,
    daily: daily.rowCount ?? 0,
    dailyTotals: dailyTotals.rowCount ?? 0,
  };
}

/**
 * Find the earliest `created_at` in `microdollar_usage`, used for all-time backfill.
 */
export async function getEarliestUsageDate(): Promise<string | null> {
  const result = await readDb.execute<{ min_created_at: string | null }>(sql`
    SELECT MIN(created_at)::text AS min_created_at FROM microdollar_usage
  `);
  return result.rows[0]?.min_created_at ?? null;
}

/**
 * Enumerate day ISO strings (YYYY-MM-DD) in the inclusive range [startIso, endIso].
 */
export function* iterateDays(startIsoDate: string, endIsoDate: string): Generator<string> {
  const current = new Date(`${startIsoDate}T00:00:00.000Z`);
  const end = new Date(`${endIsoDate}T00:00:00.000Z`);
  while (current.getTime() <= end.getTime()) {
    yield current.toISOString().slice(0, 10);
    current.setUTCDate(current.getUTCDate() + 1);
  }
}
