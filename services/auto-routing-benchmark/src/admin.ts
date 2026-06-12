import * as z from 'zod';
import {
  BenchmarkConfigSchema,
  RoutingTableSchema,
  StartBenchmarkRunRequestSchema,
  type BenchmarkRun,
} from '@kilocode/auto-routing-contracts';
import { zodJsonValidator } from '@kilocode/worker-utils';
import type { Hono } from 'hono';
import { DEFAULT_BENCHMARK_CONFIG, getBenchmarkConfig, saveBenchmarkConfig } from './config';
import { debugRunCli } from './cli-runner';
import { fetchBenchmarkUserToken, startRun } from './run';
import { getLatestRoutingTable, listRuns } from './db';
import type { HonoEnv } from './hono-env';

const DebugCliRequestSchema = z.object({
  model: z.string().trim().min(1),
  prompt: z.string().min(1),
});

export function registerAdminRoutes(app: Hono<HonoEnv>): void {
  app.get('/admin/config', async c =>
    c.json({
      config: await getBenchmarkConfig(c.env.BENCH_DB),
      defaults: DEFAULT_BENCHMARK_CONFIG,
    })
  );

  app.put(
    '/admin/config',
    zodJsonValidator(BenchmarkConfigSchema, { errorMessage: 'Invalid benchmark config' }),
    async c => {
      const updatedBy = c.req.header('x-updated-by') ?? null;
      const saved = await saveBenchmarkConfig(c.env.BENCH_DB, c.req.valid('json'), updatedBy);
      return c.json({ config: saved, defaults: DEFAULT_BENCHMARK_CONFIG });
    }
  );

  app.get('/admin/runs', async c => {
    const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 100);
    const runs: BenchmarkRun[] = await listRuns(c.env.BENCH_DB, limit);
    return c.json({ runs });
  });

  app.post(
    '/admin/runs',
    zodJsonValidator(StartBenchmarkRunRequestSchema, { errorMessage: 'Invalid run request' }),
    async c => {
      const { kind, force } = c.req.valid('json');
      return c.json(await startRun(c.env, kind, { force }));
    }
  );

  app.get('/admin/routing-table', async c => {
    const latest = await getLatestRoutingTable(c.env.BENCH_DB);
    // Validated at publish time, but re-validate before crossing the contract
    // boundary so a schema change can never surface a stale incompatible table.
    const parsed = latest ? RoutingTableSchema.safeParse(JSON.parse(latest.table_json)) : null;
    return c.json({
      table: parsed?.success ? parsed.data : null,
      publishedAt: parsed?.success ? (latest?.published_at ?? null) : null,
    });
  });

  // Runs one ad-hoc prompt through the kilo CLI container and returns raw
  // (truncated) stdout lines plus the parsed result. Diagnostic-only.
  app.post(
    '/admin/debug-cli',
    zodJsonValidator(DebugCliRequestSchema, { errorMessage: 'Invalid debug request' }),
    async c => {
      const config = await getBenchmarkConfig(c.env.BENCH_DB);
      if (!config.benchmarkUserId) {
        return c.json({ error: 'benchmarkUserId is not configured' }, 400);
      }
      const kiloToken = await fetchBenchmarkUserToken(c.env, config.benchmarkUserId);
      const result = await debugRunCli(c.env, { ...c.req.valid('json'), kiloToken });
      return c.json(result);
    }
  );
}
