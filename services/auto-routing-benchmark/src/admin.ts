import * as z from 'zod';
import {
  AutoRouterSchema,
  DEFAULT_AUTO_ROUTER,
  BenchmarkConfigSchema,
  BenchmarkKindSchema,
  BenchmarkProfileStatusesRequestSchema,
  BenchmarkRunPurposeSchema,
  CustomRoutingTableRequestSchema,
  RegisterBenchmarkProfilesRequestSchema,
  RequeueBenchmarkRegistryRequestSchema,
  type BenchmarkRegistryQueue,
  resolveBenchmarkIdentity,
  StartBenchmarkRunRequestSchema,
  type BenchmarkRun,
} from '@kilocode/auto-routing-contracts';
import { zodJsonValidator } from '@kilocode/worker-utils';
import type { Context, Hono } from 'hono';
import { getBenchmarkConfig, saveBenchmarkConfig } from './config';
import { debugRunCli } from './cli-runner';
import { assembleCustomRoutingTable } from './custom-routing-table';
import {
  lookupProfileStatuses,
  ProfileConfigMissingError,
  ProfileQuotaExceededError,
  ProfileValidationError,
  registerProfiles,
} from './profiles';
import {
  BenchmarkRunConfigError,
  computeEngineIdentity,
  drainQueues,
  fetchBenchmarkUserToken,
  publishPlatformRoutingTable,
  RunAlreadyActiveError,
  startRun,
  sweepStaleRuns,
  syncPlatformRegistry,
} from './run';
import {
  countCurrentProfilesByStatus,
  listCurrentPlatformProfileStatuses,
  getClassifierWinner,
  getLatestRoutingTable,
  listRuns,
  requeueFailedCurrentProfiles,
} from './db';
import type { HonoEnv } from './hono-env';

const DebugCliRequestSchema = z.object({
  model: z.string().trim().min(1),
  prompt: z.string().min(1),
});

function requestRouter(c: Context<HonoEnv>) {
  return AutoRouterSchema.parse(c.req.query('router') ?? DEFAULT_AUTO_ROUTER);
}

export function registerAdminRoutes(app: Hono<HonoEnv>): void {
  app.use('/admin/*', async (c, next) => {
    const router = AutoRouterSchema.safeParse(c.req.query('router') ?? DEFAULT_AUTO_ROUTER);
    if (!router.success) return c.json({ error: 'Invalid router' }, 400);
    if (
      router.data !== DEFAULT_AUTO_ROUTER &&
      (c.req.path.startsWith('/admin/profiles/') || c.req.path === '/admin/custom-routing-table')
    ) {
      return c.json({ error: 'Custom profiles are only supported by the efficient router' }, 400);
    }
    await next();
  });
  app.get('/admin/config', async c =>
    c.json({ config: await getBenchmarkConfig(c.env.BENCH_DB, requestRouter(c)) })
  );

  app.put(
    '/admin/config',
    zodJsonValidator(BenchmarkConfigSchema, { errorMessage: 'Invalid benchmark config' }),
    async c => {
      const updatedBy = c.req.header('x-updated-by') ?? null;
      const router = AutoRouterSchema.parse(c.req.query('router') ?? c.req.valid('json').router);
      const saved = await saveBenchmarkConfig(
        c.env.BENCH_DB,
        { ...c.req.valid('json'), router },
        updatedBy
      );
      await syncPlatformRegistry(c.env, fetch, router);
      await publishPlatformRoutingTable(c.env, fetch, router).catch(error => {
        console.warn(
          JSON.stringify({
            event: 'routing_table_publish_skipped',
            afterConfigSave: true,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      });
      return c.json({ config: saved });
    }
  );

  app.get('/admin/runs', async c => {
    // Sweep stale runs first so a dead/wedged run surfaces as 'failed' (and
    // frees its slot) without needing a new run to be started.
    await sweepStaleRuns(c.env);
    const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 100);
    const kind = BenchmarkKindSchema.safeParse(c.req.query('kind'));
    const purpose = BenchmarkRunPurposeSchema.safeParse(c.req.query('purpose'));
    const runs: BenchmarkRun[] = await listRuns(c.env.BENCH_DB, limit, {
      kind: kind.success ? kind.data : undefined,
      purpose: purpose.success ? purpose.data : undefined,
      router: kind.success && kind.data === 'classifier' ? DEFAULT_AUTO_ROUTER : requestRouter(c),
    });
    return c.json({ runs });
  });

  app.post(
    '/admin/runs',
    zodJsonValidator(StartBenchmarkRunRequestSchema, { errorMessage: 'Invalid run request' }),
    async c => {
      const { kind, force, queue } = c.req.valid('json');
      const router =
        kind === 'classifier'
          ? DEFAULT_AUTO_ROUTER
          : AutoRouterSchema.parse(c.req.query('router') ?? c.req.valid('json').router);
      const config = await getBenchmarkConfig(c.env.BENCH_DB, router);
      if (!config) {
        return c.json(
          { error: 'benchmark config not set: save it in the admin panel before starting a run' },
          400
        );
      }
      // Registry drains reconcile current catalog efforts before claiming the
      // platform queue; an unavailable catalog must not block owner work.
      if (kind === 'decider') {
        const drainErrors: unknown[] = [];
        if (router === 'frontier' && queue === 'user') {
          return c.json(
            { error: 'Custom profiles are only supported by the efficient router' },
            400
          );
        }
        const started = await drainQueues(c.env, queue, drainErrors, router);
        // Drains never throw, so a wedged queue would otherwise return 200 and
        // the panel would report "nothing pending" for work that is stuck.
        // Nothing started at all is a failed request; a queue that failed while
        // another started is reported alongside the run that did start.
        if (started.length === 0 && drainErrors.length > 0) {
          const [first] = drainErrors;
          if (first instanceof BenchmarkRunConfigError) return c.json({ error: first.message }, 400);
          throw first;
        }
        return c.json({
          runId: started[0]?.runId ?? null,
          enqueuedModels: started.reduce((total, run) => total + run.entryCount, 0),
          skippedModels: [],
          startedRuns: started,
          drainErrors: drainErrors.map(error =>
            error instanceof Error ? error.message : String(error)
          ),
        });
      }
      try {
        return c.json({ ...(await startRun(c.env, kind, { force, router })), startedRuns: [] });
      } catch (error) {
        // One active run per kind: surface the conflict as 409 so automated
        // callers don't treat it as a transient 5xx and retry.
        if (error instanceof RunAlreadyActiveError) {
          return c.json({ error: error.message }, 409);
        }
        if (error instanceof BenchmarkRunConfigError) {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }
    }
  );

  // Registry snapshot: what the platform list and owner pools have asked for
  // under the live engine identity, and how far each queue has got.
  app.get('/admin/registry', async c => {
    const router = requestRouter(c);
    const config = await getBenchmarkConfig(c.env.BENCH_DB, router);
    if (!config) {
      return c.json({ error: 'benchmark config not set: save it in the admin panel first' }, 400);
    }
    const current = {
      router,
      engineIdentity: computeEngineIdentity('decider', router),
      repetitions: config.deciderRepetitions,
    };
    const [platform, user, platformEntries] = await Promise.all([
      countCurrentProfilesByStatus(c.env.BENCH_DB, current, 'platform'),
      router === 'frontier'
        ? Promise.resolve([])
        : countCurrentProfilesByStatus(c.env.BENCH_DB, current, 'user'),
      listCurrentPlatformProfileStatuses(c.env.BENCH_DB, current),
    ]);
    const toQueue = (rows: Awaited<ReturnType<typeof countCurrentProfilesByStatus>>) => {
      const queue: BenchmarkRegistryQueue = { pending: 0, running: 0, ready: 0, failed: 0 };
      for (const row of rows) queue[row.status] = row.count;
      return queue;
    };
    return c.json({
      router,
      engineIdentity: current.engineIdentity,
      repetitions: current.repetitions,
      platform: toQueue(platform),
      user: toQueue(user),
      platformEntries,
    });
  });

  // Admin requeue of failed registry rows. Charges no owner quota — an owner's
  // own Retry goes through /admin/profiles/register and is quota-charged there.
  app.post(
    '/admin/registry/requeue',
    zodJsonValidator(RequeueBenchmarkRegistryRequestSchema, {
      errorMessage: 'Invalid requeue request',
    }),
    async c => {
      const router = AutoRouterSchema.parse(c.req.query('router') ?? c.req.valid('json').router);
      if (router === 'frontier' && c.req.valid('json').scope === 'user') {
        return c.json({ error: 'Custom profiles are only supported by the efficient router' }, 400);
      }
      const config = await getBenchmarkConfig(c.env.BENCH_DB, router);
      if (!config) {
        return c.json({ error: 'benchmark config not set: save it in the admin panel first' }, 400);
      }
      const requeued = await requeueFailedCurrentProfiles(
        c.env.BENCH_DB,
        {
          router,
          engineIdentity: computeEngineIdentity('decider', router),
          repetitions: config.deciderRepetitions,
        },
        router === 'frontier' ? 'platform' : c.req.valid('json').scope
      );
      return c.json({ requeued });
    }
  );

  app.get('/admin/routing-table', async c => {
    const latest = await getLatestRoutingTable(c.env.BENCH_DB, requestRouter(c));
    return c.json({
      table: latest?.table ?? null,
      publishedAt: latest?.publishedAt ?? null,
    });
  });

  app.get('/admin/classifier-winner', async c => {
    const winner = await getClassifierWinner(c.env.BENCH_DB, computeEngineIdentity('classifier'));
    return c.json({ winner });
  });

  // Runs one ad-hoc prompt through the kilo CLI container and returns raw
  // (truncated) stdout lines plus the parsed result. Diagnostic-only.
  app.post(
    '/admin/debug-cli',
    zodJsonValidator(DebugCliRequestSchema, { errorMessage: 'Invalid debug request' }),
    async c => {
      const config = await getBenchmarkConfig(c.env.BENCH_DB);
      if (!config) {
        return c.json({ error: 'benchmark config is not configured' }, 400);
      }
      const benchmarkIdentity = resolveBenchmarkIdentity(config);
      const kiloToken = await fetchBenchmarkUserToken(
        c.env,
        benchmarkIdentity.benchmarkUserId,
        benchmarkIdentity.benchmarkOrgId
      );
      const result = await debugRunCli(c.env, {
        ...c.req.valid('json'),
        kiloToken,
        kiloApiUrl: c.env.KILO_CLI_API_URL,
        orgId: benchmarkIdentity.benchmarkOrgId,
      });
      return c.json(result);
    }
  );

  // Atomically admit missing/stale/retried Benchmark profiles for an owner.
  app.post(
    '/admin/profiles/register',
    zodJsonValidator(RegisterBenchmarkProfilesRequestSchema, {
      errorMessage: 'Invalid profile register request',
    }),
    async c => {
      const body = c.req.valid('json');
      if (AutoRouterSchema.parse(c.req.query('router') ?? body.router) !== DEFAULT_AUTO_ROUTER) {
        return c.json({ error: 'Custom profiles are only supported by the efficient router' }, 400);
      }
      const config = await getBenchmarkConfig(c.env.BENCH_DB);
      if (!config) {
        return c.json(
          {
            error:
              'benchmark config not set: save it in the admin panel before registering profiles',
          },
          400
        );
      }
      try {
        const result = await registerProfiles(c.env.BENCH_DB, config, {
          ownerType: body.ownerType,
          ownerId: body.ownerId,
          entries: body.entries,
          retryEntries: body.retryEntries,
        });
        return c.json(result);
      } catch (error) {
        if (error instanceof ProfileQuotaExceededError) {
          return c.json(error.quota, 429);
        }
        if (error instanceof ProfileValidationError || error instanceof ProfileConfigMissingError) {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }
    }
  );

  // Current per-entry Benchmark-profile statuses (may free-admit stale rows).
  app.post(
    '/admin/profiles/status',
    zodJsonValidator(BenchmarkProfileStatusesRequestSchema, {
      errorMessage: 'Invalid profile status request',
    }),
    async c => {
      const body = c.req.valid('json');
      if (AutoRouterSchema.parse(c.req.query('router') ?? body.router) !== DEFAULT_AUTO_ROUTER) {
        return c.json({ error: 'Custom profiles are only supported by the efficient router' }, 400);
      }
      const config = await getBenchmarkConfig(c.env.BENCH_DB);
      if (!config) {
        return c.json(
          {
            error:
              'benchmark config not set: save it in the admin panel before looking up profiles',
          },
          400
        );
      }
      try {
        return c.json(
          await lookupProfileStatuses(c.env.BENCH_DB, config, { entries: body.entries })
        );
      } catch (error) {
        if (error instanceof ProfileValidationError || error instanceof ProfileConfigMissingError) {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }
    }
  );

  // Sparse custom routing table for ready/current pool entries only.
  app.post(
    '/admin/custom-routing-table',
    zodJsonValidator(CustomRoutingTableRequestSchema, {
      errorMessage: 'Invalid custom routing table request',
    }),
    async c => {
      const body = c.req.valid('json');
      if (AutoRouterSchema.parse(c.req.query('router') ?? body.router) !== DEFAULT_AUTO_ROUTER) {
        return c.json({ error: 'Custom profiles are only supported by the efficient router' }, 400);
      }
      const config = await getBenchmarkConfig(c.env.BENCH_DB);
      if (!config) {
        return c.json(
          {
            error:
              'benchmark config not set: save it in the admin panel before assembling a custom routing table',
          },
          400
        );
      }
      try {
        return c.json(
          await assembleCustomRoutingTable(c.env.BENCH_DB, config, body.entries, {
            catalogEnv: c.env,
          })
        );
      } catch (error) {
        if (error instanceof ProfileValidationError || error instanceof ProfileConfigMissingError) {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }
    }
  );
}
