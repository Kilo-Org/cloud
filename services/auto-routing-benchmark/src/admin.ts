import {
  BenchmarkConfigSchema,
  StartBenchmarkRunRequestSchema,
  type BenchmarkRun,
} from '@kilocode/auto-routing-contracts';
import type { Handler } from 'hono';
import { DEFAULT_BENCHMARK_CONFIG, getBenchmarkConfig, saveBenchmarkConfig } from './config';
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
  return c.json(await startRun(c.env, parsed.data.kind));
};

export const getRoutingTableHandler: Handler<HonoEnv> = async c => {
  const latest = await getLatestRoutingTable(c.env.BENCH_DB);
  return c.json({
    table: latest ? (JSON.parse(latest.table_json) as unknown) : null,
    publishedAt: latest?.published_at ?? null,
  });
};
