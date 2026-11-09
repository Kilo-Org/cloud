import {
  AutoRouterSchema,
  RefreshBenchmarkProfilesRequestSchema,
  resolveBenchmarkIdentity,
} from '@kilocode/auto-routing-contracts';
import { zodJsonValidator } from '@kilocode/worker-utils';
import type { Hono } from 'hono';
import { getBenchmarkConfig } from './config';
import { fetchExecutableBenchmarkModelCatalog } from './executable-models';
import type { HonoEnv } from './hono-env';
import { ProfileRefreshConflictError, refreshCurrentProfiles } from './profile-refresh';
import { computeEngineIdentity } from './run';

export function registerProfileRefreshRoute(app: Hono<HonoEnv>): void {
  app.post(
    '/admin/registry/refresh',
    zodJsonValidator(RefreshBenchmarkProfilesRequestSchema, {
      errorMessage: 'Invalid profile refresh request',
    }),
    async c => {
      const request = c.req.valid('json');
      const router = AutoRouterSchema.parse(c.req.query('router') ?? request.router);
      const config = await getBenchmarkConfig(c.env.BENCH_DB, router);
      if (!config)
        return c.json({ error: 'Save the benchmark config before refreshing profiles.' }, 400);
      const catalog = await fetchExecutableBenchmarkModelCatalog(
        c.env,
        resolveBenchmarkIdentity(config)
      );
      try {
        return c.json(
          await refreshCurrentProfiles(
            c.env.BENCH_DB,
            {
              router,
              engineIdentity: computeEngineIdentity('decider', router),
              repetitions: config.deciderRepetitions,
              entries: request.entries,
              mode: request.mode,
            },
            catalog
          )
        );
      } catch (error) {
        if (error instanceof ProfileRefreshConflictError) {
          return c.json({ error: error.message }, 409);
        }
        throw error;
      }
    }
  );
}
