import * as z from 'zod';
import {
  BenchmarkConfigSchema,
  RoutingTableSchema,
  StartBenchmarkRunRequestSchema,
  type BenchmarkRun,
} from '@kilocode/auto-routing-contracts';
import type { Handler } from 'hono';
import { DEFAULT_BENCHMARK_CONFIG, getBenchmarkConfig, saveBenchmarkConfig } from './config';
import { debugRunCli } from './cli-runner';
import { fetchBenchmarkUserToken } from './run';
import { getLatestRoutingTable, listRuns } from './db';
import { startRun } from './run';
import type { HonoEnv } from './hono-env';

export const getConfigHandler: Handler<HonoEnv> = async c =>
  c.json({
    config: await getBenchmarkConfig(c.env.BENCH_DB),
    defaults: DEFAULT_BENCHMARK_CONFIG,
  });

export const putConfigHandler: Handler<HonoEnv> = async c => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = BenchmarkConfigSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid benchmark config' }, 400);
  const updatedBy = c.req.header('x-updated-by') ?? null;
  const saved = await saveBenchmarkConfig(c.env.BENCH_DB, parsed.data, updatedBy);
  return c.json({ config: saved, defaults: DEFAULT_BENCHMARK_CONFIG });
};

export const listRunsHandler: Handler<HonoEnv> = async c => {
  const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 100);
  const runs: BenchmarkRun[] = await listRuns(c.env.BENCH_DB, limit);
  return c.json({ runs });
};

export const startRunHandler: Handler<HonoEnv> = async c => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = StartBenchmarkRunRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid run request' }, 400);
  return c.json(await startRun(c.env, parsed.data.kind, { force: parsed.data.force }));
};

export const getRoutingTableHandler: Handler<HonoEnv> = async c => {
  const latest = await getLatestRoutingTable(c.env.BENCH_DB);
  // Validated at publish time, but re-validate before crossing the contract
  // boundary so a schema change can never surface a stale incompatible table.
  const parsed = latest ? RoutingTableSchema.safeParse(JSON.parse(latest.table_json)) : null;
  return c.json({
    table: parsed?.success ? parsed.data : null,
    publishedAt: parsed?.success ? (latest?.published_at ?? null) : null,
  });
};

const DebugCliRequestSchema = z.object({
  model: z.string().trim().min(1),
  prompt: z.string().min(1),
});

// Runs one ad-hoc prompt through the kilo CLI container and returns raw
// (truncated) stdout lines plus the parsed result. Diagnostic-only.
export const debugCliHandler: Handler<HonoEnv> = async c => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = DebugCliRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid debug request' }, 400);
  const config = await getBenchmarkConfig(c.env.BENCH_DB);
  if (!config.benchmarkUserId) {
    return c.json({ error: 'benchmarkUserId is not configured' }, 400);
  }
  const kiloToken = await fetchBenchmarkUserToken(c.env, config.benchmarkUserId);
  const result = await debugRunCli(c.env, { ...parsed.data, kiloToken });
  return c.json(result);
};
