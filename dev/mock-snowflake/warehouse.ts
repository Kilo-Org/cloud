// The dev-only stand-in for `MICRODOLLAR_USAGE_DAILY`, the warehouse table the
// usage dashboard aggregates. It answers the three statements the analytics
// router sends (summary, daily timeseries, breakdown) from JSON fixture rows
// written by `pnpm dev:seed usage:usage-rows`, so the screen can be exercised
// without Snowflake credentials. Nothing here ships: `apps/web` never imports
// this module.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One rolled-up day for one user, one organization and one model/feature pair. */
export type UsageFixtureRow = {
  usage_date: string;
  kilo_user_id: string;
  /** Empty string for personal usage, matching the warehouse's own sentinel. */
  organization_id: string;
  model: string;
  feature: string;
  provider: string;
  mode: string;
  project_id: string;
  request_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_write_tokens: number;
  total_cache_hit_tokens: number;
  error_count: number;
  cancelled_count: number;
  free_request_count: number;
  user_byok_request_count: number;
  total_latency_ms: number;
  total_generation_time_ms: number | null;
  latency_count: number;
  total_tokens: number;
  total_cost_microdollars: number;
  total_market_cost_microdollars: number;
};

export type SnowflakeBinding = { type: string; value: string };

type Fixture = { owner?: string; rows: UsageFixtureRow[] };

/** Every row of every fixture file in `dir`; a missing directory is no rows. */
export function loadFixtureRows(dir: string): UsageFixtureRow[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter(file => file.endsWith('.json'));
  } catch {
    return [];
  }
  const rows: UsageFixtureRow[] = [];
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Fixture;
    rows.push(...(Array.isArray(fixture.rows) ? fixture.rows : []));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Statement conditions
// ---------------------------------------------------------------------------

type Operator = '=' | '>=' | '<' | 'IN' | 'NOT IN';
type Condition = { column: string; op: Operator; values: string[] };

// Every condition the router emits reads `column <op> ?` (or an IN list of
// placeholders), so the text before each placeholder names its column.
const CLAUSE_PATTERN = /([a-z_]+)\s*(>=|<=|<|=|IN\s*\(|NOT\s+IN\s*\()/gi;

function normalizeOperator(raw: string): Operator {
  const op = raw.replaceAll(/\s+/g, ' ').trim().toUpperCase();
  if (op === 'IN (') return 'IN';
  if (op === 'NOT IN (') return 'NOT IN';
  return op as Operator;
}

function parseConditions(
  statement: string,
  bindings: Record<string, SnowflakeBinding>
): Condition[] {
  const [head, ...rest] = statement.split('?');
  const conditions: Condition[] = [];
  let current: Condition | null = null;
  let text = head;

  for (const [index, tail] of rest.entries()) {
    const closest = [...text.matchAll(CLAUSE_PATTERN)].at(-1);
    if (closest) {
      current = {
        column: closest[1].toLowerCase(),
        op: normalizeOperator(closest[2]),
        values: [],
      };
      conditions.push(current);
    }
    if (!current) {
      throw new Error(`the statement's placeholder ${index + 1} has no column binding`);
    }
    current.values.push(bindings[String(index + 1)]?.value ?? '');
    text = tail;
  }

  return conditions;
}

/** A column read by name, for dimensions the fixture row type names only loosely. */
function columnValue(row: UsageFixtureRow, column: string): unknown {
  return (row as unknown as Record<string, unknown>)[column];
}

function matches(row: UsageFixtureRow, condition: Condition): boolean {
  const value = String(columnValue(row, condition.column) ?? '');
  const [first] = condition.values;
  if (condition.op === '=') return value === first;
  if (condition.op === '>=') return value >= first;
  if (condition.op === '<') return value < first;
  if (condition.op === 'IN') return condition.values.includes(value);
  return !condition.values.includes(value);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

type Total = {
  cost: number;
  market: number;
  requests: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheHit: number;
  errors: number;
  cancelled: number;
  free: number;
  byok: number;
  latencyMs: number;
  generationMs: number;
  latencyCount: number;
  tokens: number;
  users: Set<string>;
};

function emptyTotal(): Total {
  return {
    cost: 0,
    market: 0,
    requests: 0,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheHit: 0,
    errors: 0,
    cancelled: 0,
    free: 0,
    byok: 0,
    latencyMs: 0,
    generationMs: 0,
    latencyCount: 0,
    tokens: 0,
    users: new Set(),
  };
}

function addRow(total: Total, row: UsageFixtureRow): void {
  total.cost += row.total_cost_microdollars;
  total.market += row.total_market_cost_microdollars;
  total.requests += row.request_count;
  total.input += row.total_input_tokens;
  total.output += row.total_output_tokens;
  total.cacheWrite += row.total_cache_write_tokens;
  total.cacheHit += row.total_cache_hit_tokens;
  total.errors += row.error_count;
  total.cancelled += row.cancelled_count;
  total.free += row.free_request_count;
  total.byok += row.user_byok_request_count;
  total.latencyMs += row.total_latency_ms;
  total.generationMs += row.total_generation_time_ms ?? 0;
  total.latencyCount += row.latency_count;
  total.tokens += row.total_tokens;
  total.users.add(row.kilo_user_id);
}

/** The warehouse returns every value as a string; the router parses numbers. */
function text(value: number): string {
  return String(Math.round(value));
}

function weekStart(usageDate: string): string {
  const date = new Date(`${usageDate}T00:00:00.000Z`);
  // getUTCDay(): 0 is Sunday, and Snowflake's WEEK starts on Monday.
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function bucketFor(statement: string, usageDate: string): string {
  const expr = statement.slice(0, statement.indexOf('AS bucket'));
  if (expr.includes("DATE_TRUNC('WEEK'")) return weekStart(usageDate);
  if (expr.includes("DATE_TRUNC('MONTH'")) return `${usageDate.slice(0, 7)}-01`;
  return usageDate;
}

/** The metric a timeseries or breakdown statement sums, read from its SELECT list. */
function metricFor(statement: string): (row: UsageFixtureRow) => number {
  const select = statement.slice(0, statement.indexOf('FROM'));
  if (/SUM\(\s*request_count\s*\)/i.test(select)) return row => row.request_count;
  if (/SUM\(\s*total_tokens\s*\)/i.test(select)) return row => row.total_tokens;
  if (/SUM\(\s*total_market_cost_microdollars\s*\)/i.test(select)) {
    return row => row.total_market_cost_microdollars;
  }
  if (/SUM\(\s*total_input_tokens\s*\)/i.test(select)) return row => row.total_input_tokens;
  if (/SUM\(\s*total_output_tokens\s*\)/i.test(select)) return row => row.total_output_tokens;
  return row => row.total_cost_microdollars;
}

function summarize(statement: string, rows: UsageFixtureRow[], today: string): string[][] {
  const total = emptyTotal();
  for (const row of rows) addRow(total, row);

  // The daily tier's generation-time observation count only covers the window
  // the hourly rollups back (the router derives it with DATEADD(day, -7, ...)).
  const recentCutoff = new Date(`${today}T00:00:00.000Z`);
  recentCutoff.setUTCDate(recentCutoff.getUTCDate() - 7);
  const cutoff = recentCutoff.toISOString().slice(0, 10);
  const generationTimeCount = rows.filter(
    row => row.total_generation_time_ms !== null && row.usage_date >= cutoff
  ).length;

  const cost = statement.includes('total_market_cost_microdollars') ? total.market : total.cost;
  return [
    [
      text(cost),
      text(total.requests),
      text(total.input),
      text(total.output),
      text(total.cacheWrite),
      text(total.cacheHit),
      text(total.errors),
      text(total.cancelled),
      text(total.free),
      text(total.byok),
      text(total.latencyMs),
      text(total.generationMs),
      text(total.latencyCount),
      text(generationTimeCount),
      text(total.tokens),
      text(total.users.size),
    ],
  ];
}

function timeseries(statement: string, rows: UsageFixtureRow[]): string[][] {
  const metric = metricFor(statement);
  const splitColumn = /([a-z_]+)\s+AS\s+label/i.exec(statement)?.[1]?.toLowerCase();
  const buckets = new Map<string, number>();
  for (const row of rows) {
    const bucket = bucketFor(statement, row.usage_date);
    const key = splitColumn
      ? `${bucket}\u0000${String(columnValue(row, splitColumn) ?? '')}`
      : bucket;
    buckets.set(key, (buckets.get(key) ?? 0) + metric(row));
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (!splitColumn) return [key, text(value)];
      const [bucket, label] = key.split('\u0000');
      return [bucket, text(value), label];
    });
}

function breakdown(statement: string, rows: UsageFixtureRow[]): string[][] {
  const keyColumn = /([a-z_]+)\s+AS\s+key/i.exec(statement)?.[1]?.toLowerCase() ?? 'model';
  const metric = metricFor(statement);
  const groups = new Map<string, number>();
  for (const row of rows) {
    const key = String(columnValue(row, keyColumn) ?? '');
    groups.set(key, (groups.get(key) ?? 0) + metric(row));
  }
  const limit = Number(/LIMIT\s+(\d+)/i.exec(statement)?.[1] ?? groups.size);
  return [...groups.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([key, value]) => [key, text(value)]);
}

/**
 * Answers one SQL API v2 statement from the fixture rows. Unsupported
 * statements answer zero rows rather than pretending to compute them.
 */
export function answerStatement(
  statement: string,
  bindings: Record<string, SnowflakeBinding>,
  fixtures: UsageFixtureRow[],
  now: Date = new Date()
): string[][] {
  const conditions = parseConditions(statement, bindings);
  const rows = fixtures.filter(row => conditions.every(condition => matches(row, condition)));
  const today = now.toISOString().slice(0, 10);

  if (/AS\s+bucket/i.test(statement)) return timeseries(statement, rows);
  if (/AS\s+key/i.test(statement)) return breakdown(statement, rows);
  if (/COUNT\(DISTINCT/i.test(statement)) return summarize(statement, rows, today);
  return [];
}
