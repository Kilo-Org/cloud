import * as z from 'zod';
import {
  BenchmarkConfigSchema,
  StartBenchmarkRunRequestSchema,
  type BenchmarkRun,
} from '@kilocode/auto-routing-contracts';
import { zodJsonValidator } from '@kilocode/worker-utils';
import type { Hono } from 'hono';
import { getBenchmarkConfig, saveBenchmarkConfig } from './config';
import { debugRunCli } from './cli-runner';
import { fetchBenchmarkUserToken, RunAlreadyActiveError, startRun, sweepStaleRuns } from './run';
import { getClassifierWinner, getLatestRoutingTable, listRuns } from './db';
import type { HonoEnv } from './hono-env';

const DebugCliRequestSchema = z.object({
  model: z.string().trim().min(1),
  prompt: z.string().min(1),
});

export function registerAdminRoutes(app: Hono<HonoEnv>): void {
  app.get('/admin/config', async c => c.json({ config: await getBenchmarkConfig(c.env.BENCH_DB) }));

  app.put(
    '/admin/config',
    zodJsonValidator(BenchmarkConfigSchema, { errorMessage: 'Invalid benchmark config' }),
    async c => {
      const updatedBy = c.req.header('x-updated-by') ?? null;
      const saved = await saveBenchmarkConfig(c.env.BENCH_DB, c.req.valid('json'), updatedBy);
      return c.json({ config: saved });
    }
  );

  app.get('/admin/runs', async c => {
    // Sweep stale runs first so a dead/wedged run surfaces as 'failed' (and
    // frees the one-active-run slot) without needing a new run to be started.
    await sweepStaleRuns(c.env.BENCH_DB);
    const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 100);
    const runs: BenchmarkRun[] = await listRuns(c.env.BENCH_DB, limit);
    return c.json({ runs });
  });

  app.post(
    '/admin/runs',
    zodJsonValidator(StartBenchmarkRunRequestSchema, { errorMessage: 'Invalid run request' }),
    async c => {
      const { kind, force } = c.req.valid('json');
      const config = await getBenchmarkConfig(c.env.BENCH_DB);
      if (!config) {
        return c.json(
          { error: 'benchmark config not set: save it in the admin panel before starting a run' },
          400
        );
      }
      try {
        return c.json(await startRun(c.env, kind, { force }));
      } catch (error) {
        // One active run per kind: surface the conflict as 409 so automated
        // callers don't treat it as a transient 5xx and retry.
        if (error instanceof RunAlreadyActiveError) {
          return c.json({ error: error.message }, 409);
        }
        throw error;
      }
    }
  );

  app.get('/admin/routing-table', async c => {
    const latest = await getLatestRoutingTable(c.env.BENCH_DB);
    return c.json({
      table: latest?.table ?? null,
      publishedAt: latest?.publishedAt ?? null,
    });
  });

  app.get('/admin/classifier-winner', async c => {
    const winner = await getClassifierWinner(c.env.BENCH_DB);
    return c.json({ winner });
  });

  // Runs one ad-hoc prompt through the kilo CLI container and returns raw
  // (truncated) stdout lines plus the parsed result. Diagnostic-only.
  app.post(
    '/admin/debug-cli',
    zodJsonValidator(DebugCliRequestSchema, { errorMessage: 'Invalid debug request' }),
    async c => {
      const config = await getBenchmarkConfig(c.env.BENCH_DB);
      if (!config?.benchmarkUserId) {
        return c.json({ error: 'benchmarkUserId is not configured' }, 400);
      }
      const kiloToken = await fetchBenchmarkUserToken(c.env, config.benchmarkUserId);
      const result = await debugRunCli(c.env, { ...c.req.valid('json'), kiloToken });
      return c.json(result);
    }
  );
}
