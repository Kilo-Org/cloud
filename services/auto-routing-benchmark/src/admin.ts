import * as z from 'zod';
import {
  AUTO_ROUTERS,
  AutoRouterSchema,
  CUSTOM_ROUTER_BLOCKED_MODELS_PATH,
  CUSTOM_ROUTER_EPOCH_PATH,
  CUSTOM_ROUTER_STATUS_PATH,
  CUSTOM_ROUTER_TABLE_PATH,
  CUSTOM_ROUTER_TABLE_VERSION_PATH,
  CustomRouterBenchmarkContextSchema,
  CustomRouterBlockedModelsRequestSchema,
  CustomRouterEpochRequestSchema,
  CustomRouterEpochResponseSchema,
  CustomRouterTableVersionResponseSchema,
  PLATFORM_MEASUREMENTS_PATH,
  PlatformMeasurementsResponseSchema,
  type AutoRouter,
  DEFAULT_AUTO_ROUTER,
  DEFAULT_BENCHMARK_DECIDER_MODEL_IDS,
  BenchmarkConfigSchema,
  BENCHMARK_CONTAINER_BUDGET,
  BenchmarkSchedulerLimitSchema,
  BenchmarkSchedulerOverridesSchema,
  BenchmarkKindSchema,
  BenchmarkProfileStatusesRequestSchema,
  BenchmarkRunPurposeSchema,
  BenchmarkRunCancelResponseSchema,
  CustomRoutingTableRequestSchema,
  PAID_BENCHMARK_ADMIN_PATH,
  PAID_BENCHMARK_ADMIN_PAUSE_PATH,
  PAID_BENCHMARK_ADMIN_PROGRESS_PATH,
  PAID_BENCHMARK_ADMIN_ROUTING_TABLE_PATH,
  PaidBenchmarkAdminPauseRequestSchema,
  PaidBenchmarkAdminPauseResponseSchema,
  PaidBenchmarkAdminRequestStatusSchema,
  PaidBenchmarkAdminRoutingTableRequestSchema,
  PaidBenchmarkIdSchema,
  RegisterBenchmarkProfilesRequestSchema,
  RequeueBenchmarkRegistryRequestSchema,
  SyncBenchmarkSubscriptionsRequestSchema,
  type BenchmarkConfig,
  type BenchmarkConfigAdminResponseConfig,
  type BenchmarkConfigSaveDrain,
  type BenchmarkConfigSaveWarning,
  type BenchmarkRegistryQueue,
  type BenchmarkIdentity,
  resolveBenchmarkIdentity,
  resolvePolicySettings,
  resolveEffectivePolicy,
  StartBenchmarkRunRequestSchema,
  type BenchmarkRun,
  type BenchmarkRunAdminResponseRun,
  type BenchmarkRunsResponse,
  type BenchmarkRunSummariesResponse,
  type BenchmarkSchedulerConfigResponse,
  type BenchmarkSchedulerSetting,
  type BenchmarkRunProgress,
  type BenchmarkRunTotals,
  type CustomRoutingTableResponse,
} from '@kilocode/auto-routing-contracts';
import { formatError, zodJsonValidator } from '@kilocode/worker-utils';
import type { Context, Hono } from 'hono';
import { getBenchmarkConfig, saveBenchmarkConfig } from './config';
import {
  listPaidBenchmarkAdminRequests,
  pausePaidBenchmarkAdminRequest,
  readPaidBenchmarkAdminContext,
  readPaidBenchmarkAdminProgress,
} from './paid-benchmark-admin';
import { registerProfileRefreshRoute } from './admin-profile-refresh';
import { debugRunCli } from './cli-runner';
import { assembleCustomRoutingTable } from './custom-routing-table';
import {
  assembleCustomRouterTable,
  computeCustomRouterReadinessVersion,
  lookupCustomRouterBlockers,
  lookupCustomRouterStatuses,
} from './custom-routers';
import {
  lookupProfileStatuses,
  listReadyPlatformMeasurements,
  ProfileConfigMissingError,
  ProfileQuotaExceededError,
  ProfileValidationError,
  registerProfiles,
} from './profiles';
import {
  BenchmarkRunConfigError,
  cancelPlatformBenchmarkRun,
  computeEngineIdentity,
  drainQueues,
  PLATFORM_SYNC_SCHEDULE,
  publishPlatformRoutingTable,
  resolveRunIdentity,
  RunAlreadyActiveError,
  startRun,
  syncPlatformRegistry,
  type DrainSkipReason,
} from './run';
import {
  countCurrentProfilesByStatus,
  listCurrentFailedProfiles,
  listCurrentPlatformProfileStatuses,
  getClassifierWinner,
  getRunSummariesForRouter,
  listRunModelIds,
  listRunningRunIds,
  listRuns,
  readBenchmarkReadinessEpoch,
  requeueRetryableCurrentProfiles,
} from './db';
import { loadRunProgress } from './run-progress';
import { loadRunModelTotals, loadRunTotals } from './run-totals';
import { loadRoutingTableResponse } from './routing-table-response';
import { getSchedulerOverrides, resolveSchedulerConfig, saveSchedulerOverrides } from './scheduler';
import type { HonoEnv } from './hono-env';
import { fetchBenchmarkUserToken } from './benchmark-token';
import { fetchExecutableBenchmarkModelCatalog } from './executable-models';
import {
  catalogCandidatePrices,
  catalogSupportsBenchmarkPair,
  fetchBenchmarkModelCatalog,
} from './platform-models';
import {
  loadSubscriptionSnapshot,
  mapSubscriptionStatuses,
  PLATFORM_SUBSCRIPTION_OWNER,
  resolveSubscriptionSnapshot,
  servingSubscriptionSnapshot,
  snapshotPairs,
  syncSubscriptionSnapshot,
} from './subscriptions';
import { planPromptTransportRemeasure } from './remeasure';
import { ACTIVE_MEASUREMENT_REVISION } from './measurement-revision';

const RemeasureRequestSchema = z.object({
  router: AutoRouterSchema.optional(),
  action: z.enum(['dry-run', 'request', 'cancel']).default('dry-run'),
  // Exact pairs to measure; absent means every ready pair of the router.
  pairs: z
    .array(
      z.object({
        model: z.string().trim().min(1),
        variant: z.string().trim().min(1).nullable().default(null),
      })
    )
    .min(1)
    .optional(),
});

const DebugCliRequestSchema = z.object({
  model: z.string().trim().min(1),
  prompt: z.string().min(1),
});

function requestRouter(c: Context<HonoEnv>) {
  return AutoRouterSchema.parse(c.req.query('router') ?? DEFAULT_AUTO_ROUTER);
}

/**
 * The previous web release parses this response with a contract that still
 * requires the fixed policy settings (ADR 0003 invariant 7: workers deploy
 * before web promotion). Serve them from the resolved policy, never from the
 * stored row. Remove once that release is promoted.
 */
function withLegacyAdminConfigFields(
  config: BenchmarkConfig | null
): BenchmarkConfigAdminResponseConfig | null {
  if (config === null) return null;
  const policy = resolveEffectivePolicy(config);
  return {
    ...config,
    frontierMinAccuracyDelta: policy.frontierMinAccuracyDelta,
    switchCostFactor: policy.switchCostFactor,
    bestAccuracySwitchThreshold: policy.bestAccuracySwitchThreshold,
    lowConfidenceThreshold: policy.lowConfidenceThreshold,
    classifierRepetitions: policy.classifierRepetitions,
    deciderRepetitions: policy.deciderRepetitions,
    classifierMaxP95LatencyMs: policy.classifierMaxP95LatencyMs,
  };
}

/**
 * The previous web release requires the retired provider limits in this response
 * and sends them on save (ADR 0003 invariant 7). Serve them as the container
 * budget, which no longer binds anything beyond the slots, and accept and ignore
 * them on PUT. Remove both once that release is promoted.
 */
const LEGACY_PROVIDER_LIMIT_SETTING = {
  effective: BENCHMARK_CONTAINER_BUDGET,
  source: 'default',
  override: null,
  fallback: BENCHMARK_CONTAINER_BUDGET,
} satisfies BenchmarkSchedulerSetting;

function withLegacySchedulerSettings(settings: BenchmarkSchedulerConfigResponse['settings']) {
  return {
    ...settings,
    providerConcurrency: LEGACY_PROVIDER_LIMIT_SETTING,
    unknownProviderConcurrency: LEGACY_PROVIDER_LIMIT_SETTING,
  };
}

const SchedulerOverridesRequestSchema = z
  .strictObject({
    ...BenchmarkSchedulerOverridesSchema.shape,
    providerConcurrency: BenchmarkSchedulerLimitSchema.nullable().optional(),
    unknownProviderConcurrency: BenchmarkSchedulerLimitSchema.nullable().optional(),
  })
  .transform(({ slots, modelConcurrency }) => ({ slots, modelConcurrency }));

/**
 * The previous web release parses the run list with a contract that still
 * requires `summaries` on every run (ADR 0003 invariant 7: workers deploy
 * before web promotion). Serve an empty array; the per-run summaries route
 * serves the rows. Remove once that release is promoted.
 */
function withLegacyAdminRunFields(run: BenchmarkRun): BenchmarkRunAdminResponseRun {
  return { ...run, summaries: [] };
}

const RETRY_AFTER_SAVE = `The scheduled platform sync (${PLATFORM_SYNC_SCHEDULE}) retries it; save again to retry now.`;

/**
 * The table inputs a saved config can change. The publish gate treats a policy edit as a
 * reason to rebuild even when pool membership is unchanged, so the comparison must cover
 * every knob the persisted artifact carries — not the four the gate can read cheaply.
 * Repetition and classifier knobs are deliberately absent: they change which cases run,
 * not the table's content.
 */
type RoutingPolicyProjection = {
  minAccuracy: number;
  accuracyNoiseBand: number;
  switchCostFactor: number;
  bestAccuracySwitchThreshold: number;
  productionTokenProfile: string;
  switchHorizonTurns: number | null;
  lowConfidenceThreshold: number | null;
};

function routingPolicyProjection(
  config: BenchmarkConfig,
  router: AutoRouter
): RoutingPolicyProjection {
  const policy = resolveEffectivePolicy(config);
  return {
    // The table stores the router-adjusted threshold, so compare what is stored.
    minAccuracy: Math.min(
      1,
      policy.minAccuracy + (router === 'frontier' ? policy.frontierMinAccuracyDelta : 0)
    ),
    accuracyNoiseBand: policy.accuracyNoiseBand,
    switchCostFactor: policy.switchCostFactor,
    bestAccuracySwitchThreshold: policy.bestAccuracySwitchThreshold,
    productionTokenProfile: JSON.stringify(policy.productionTokenProfile ?? null),
    switchHorizonTurns: policy.switchHorizonTurns,
    lowConfidenceThreshold: policy.lowConfidenceThreshold,
  };
}

/**
 * Whether this save changed a knob the routing table is built from. Compared before and
 * after in the same request, against the complete projection above, so a save that only
 * rewrites an unrelated field reports `false` and stays cache-only.
 */
function configSaveChangedRoutingPolicy(
  before: BenchmarkConfig | null,
  after: BenchmarkConfig,
  router: AutoRouter
): boolean {
  if (before === null) return false;
  const previous = routingPolicyProjection(before, router);
  const next = routingPolicyProjection(after, router);
  return (Object.keys(previous) as (keyof RoutingPolicyProjection)[]).some(
    key => previous[key] !== next[key]
  );
}

/**
 * Registry sync, then routing-table publish, for a config that is already
 * saved. A failed step does not undo the save; it comes back as a warning so
 * the admin learns what did not happen. A failed sync skips the publish.
 */
async function syncRegistryAfterConfigSave(
  env: Env,
  router: AutoRouter,
  policyChanged: boolean
): Promise<BenchmarkConfigSaveWarning[]> {
  try {
    await syncPlatformRegistry(env, fetch, router);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'platform_registry_sync_failed',
        afterConfigSave: true,
        router,
        ...formatError(error),
      })
    );
    return [
      {
        kind: 'registry_sync_failed',
        message: `Platform registry sync failed (${errorMessage(error)}), so newly added decider models have no pending benchmark entries and the routing table was not republished. ${RETRY_AFTER_SAVE}`,
      },
    ];
  }
  try {
    // A save also flushes an unchanged table: an earlier save may have written
    // it but failed the flush, and the version check would otherwise skip it.
    // `policyChanged` is the one signal that lets this admin publish rebuild an
    // unchanged pool: only a save that observed its own policy edit sets it.
    await publishPlatformRoutingTable(env, fetch, router, {
      flushUnchangedTable: true,
      policyChanged,
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'routing_table_publish_skipped',
        afterConfigSave: true,
        error: errorMessage(error),
      })
    );
    return [
      {
        kind: 'routing_table_publish_failed',
        message: `Routing table publish failed (${errorMessage(error)}), so the gateway keeps serving the previous table. ${RETRY_AFTER_SAVE}`,
      },
    ];
  }
  return [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How long a save waits for its platform-queue drain to start a run. The drain
 * is one `startRun` plus its claim; the per-minute scheduler is the backstop, so
 * a slow drain is deferred rather than allowed to extend the save.
 */
const CONFIG_SAVE_DRAIN_DEADLINE_MS = 5_000;

/**
 * Start the platform queue after a save has persisted its config, registry sync
 * and publish, so an admin who adds a model gets a run without pressing Run or
 * waiting for the cron. Best-effort by design: a queue that already holds a run
 * is left to it, and a drain that is slow or throws is reported in `drain`, never
 * in `warnings` — the save itself succeeded, and the per-minute scheduler is the
 * backstop for everything this misses.
 *
 * `keepAlive` is the request's `ctx.waitUntil`. A drain that outlives the
 * deadline is still running when the response goes out, and the runtime may end
 * that work with the request — right between claiming a run and inserting it.
 * Handing the promise over lets it finish and record the run it started.
 */
async function drainPlatformAfterConfigSave(
  env: Env,
  router: AutoRouter,
  keepAlive: (promise: Promise<unknown>) => void
): Promise<BenchmarkConfigSaveDrain> {
  const timedOut = Promise.withResolvers<'timeout'>();
  const timer = setTimeout(() => timedOut.resolve('timeout'), CONFIG_SAVE_DRAIN_DEADLINE_MS);
  // A queue drain reports its own failure here instead of throwing: one wedged
  // queue must not fail the other, and the save must not fail either.
  const drainErrors: unknown[] = [];
  // Why the drain started nothing; `active_run` and `nothing_pending` are
  // different answers for the admin.
  const skipped: DrainSkipReason[] = [];
  const drain = drainQueues(env, 'platform', drainErrors, router, {
    skipPlatformSync: true,
    skipped,
  });
  try {
    const started = await Promise.race([drain, timedOut.promise]);
    if (started === 'timeout') {
      keepAlive(
        drain.catch((error: unknown) => {
          console.warn(
            JSON.stringify({
              event: 'benchmark_config_save_drain_deferred',
              afterConfigSave: true,
              router,
              reason: 'failed_after_response',
              ...formatError(error),
            })
          );
        })
      );
      console.warn(
        JSON.stringify({
          event: 'benchmark_config_save_drain_deferred',
          afterConfigSave: true,
          router,
          reason: 'timeout',
        })
      );
      return { runId: null, entryCount: 0, skipped: 'timeout' };
    }
    const [run] = started;
    if (run) return { runId: run.runId, entryCount: run.entryCount, skipped: null };
    // Nothing started: either the queue already holds a run, nothing was
    // pending, or the drain threw.
    return {
      runId: null,
      entryCount: 0,
      skipped:
        drainErrors.length > 0
          ? 'failed'
          : skipped.includes('active_run')
            ? 'active_run'
            : 'nothing_pending',
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_config_save_drain_deferred',
        afterConfigSave: true,
        router,
        reason: 'failed',
        ...formatError(error),
      })
    );
    return { runId: null, entryCount: 0, skipped: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** Console list query. Statuses arrive comma-separated; an unknown value is a 400. */
const PaidBenchmarkAdminListQuerySchema = z.object({
  router: AutoRouterSchema.default(DEFAULT_AUTO_ROUTER),
  status: z.string().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function registerAdminRoutes(app: Hono<HonoEnv>): void {
  // Every /admin/* route below requires the worker-wide authMiddleware
  // (./auth), which src/index.ts mounts with app.use('*', ...) before it calls
  // registerAdminRoutes(app). Keep the registration in that order.
  app.use('/admin/*', async (c, next) => {
    const router = AutoRouterSchema.safeParse(c.req.query('router') ?? DEFAULT_AUTO_ROUTER);
    if (!router.success) return c.json({ error: 'Invalid router' }, 400);
    await next();
  });
  registerProfileRefreshRoute(app);
  app.get('/admin/config', async c => {
    const config = await getBenchmarkConfig(c.env.BENCH_DB, requestRouter(c));
    return c.json({
      config: withLegacyAdminConfigFields(config),
      policySettings: config ? resolvePolicySettings(config) : null,
    });
  });

  app.get(PLATFORM_MEASUREMENTS_PATH, async c => {
    const baseRouter = requestRouter(c);
    const pairs = await listReadyPlatformMeasurements(c.env.BENCH_DB, baseRouter);
    const models = new Map<string, (string | null)[]>();
    for (const pair of pairs) {
      const variants = models.get(pair.model);
      if (variants) variants.push(pair.variant);
      else models.set(pair.model, [pair.variant]);
    }
    return c.json(
      PlatformMeasurementsResponseSchema.parse({
        baseRouter,
        models: [...models].map(([model, variants]) => ({ model, variants })),
      })
    );
  });

  app.put(
    '/admin/config',
    zodJsonValidator(BenchmarkConfigSchema, { errorMessage: 'Invalid benchmark config' }),
    async c => {
      const updatedBy = c.req.header('x-updated-by') ?? null;
      const body = c.req.valid('json');
      const router = AutoRouterSchema.parse(c.req.query('router') ?? body.router);
      const rawBody: unknown = await c.req.json();
      const hasSelectedPool =
        typeof rawBody === 'object' && rawBody !== null && 'deciderModels' in rawBody;
      const deciderModels = hasSelectedPool
        ? body.deciderModels
        : [{ id: DEFAULT_BENCHMARK_DECIDER_MODEL_IDS[router] }];
      // Read the previous policy before writing: the publish gate needs the save's own
      // before/after, and reading it after the write would compare the row to itself.
      const previousConfig = await getBenchmarkConfig(c.env.BENCH_DB, router);
      const saved = await saveBenchmarkConfig(
        c.env.BENCH_DB,
        { ...body, router, deciderModels },
        updatedBy
      );
      const policyChanged = configSaveChangedRoutingPolicy(previousConfig, saved, router);
      const warnings = await syncRegistryAfterConfigSave(c.env, router, policyChanged);
      // Only a save whose registry sync and publish both landed has new pending
      // rows to start; a failed sync has no rows and a failed publish is already
      // reported, so the cron owns that case.
      const drain =
        warnings.length === 0
          ? await drainPlatformAfterConfigSave(c.env, router, promise =>
              c.executionCtx.waitUntil(promise)
            )
          : undefined;
      return c.json({
        config: withLegacyAdminConfigFields(saved),
        policySettings: resolvePolicySettings(saved),
        warnings,
        ...(drain ? { drain } : {}),
      });
    }
  );

  app.get('/admin/scheduler-config', async c => {
    const { overrides, ...updated } = await getSchedulerOverrides(c.env.BENCH_DB);
    const { settings } = resolveSchedulerConfig(c.env.BENCHMARK_SCHEDULER_CONFIG, overrides);
    return c.json({
      settings: withLegacySchedulerSettings(settings),
      ...updated,
    } satisfies BenchmarkSchedulerConfigResponse);
  });

  app.put(
    '/admin/scheduler-config',
    zodJsonValidator(SchedulerOverridesRequestSchema, {
      errorMessage: 'Invalid scheduler config',
    }),
    async c => {
      const { overrides, ...updated } = await saveSchedulerOverrides(
        c.env.BENCH_DB,
        c.req.valid('json'),
        c.req.header('x-updated-by') ?? null
      );
      const { settings } = resolveSchedulerConfig(c.env.BENCHMARK_SCHEDULER_CONFIG, overrides);
      return c.json({
        settings: withLegacySchedulerSettings(settings),
        ...updated,
      } satisfies BenchmarkSchedulerConfigResponse);
    }
  );

  app.get('/admin/runs', async c => {
    // Reads only: the per-minute cron sweeps stale runs, so listing never writes.
    const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 100);
    const kind = BenchmarkKindSchema.safeParse(c.req.query('kind'));
    const purpose = BenchmarkRunPurposeSchema.safeParse(c.req.query('purpose'));
    const listRouter =
      kind.success && kind.data === 'classifier' ? DEFAULT_AUTO_ROUTER : requestRouter(c);
    const [runs, runningRunIds] = await Promise.all([
      listRuns(c.env.BENCH_DB, limit, {
        kind: kind.success ? kind.data : undefined,
        purpose: purpose.success ? purpose.data : undefined,
        router: listRouter,
      }),
      listRunningRunIds(c.env.BENCH_DB, requestRouter(c)),
    ]);
    // Progress is display-only: a failed count query must not hide the run list.
    const progressByRunId = await loadRunProgress(
      c.env.BENCH_DB,
      runs.filter(run => run.status === 'running').map(run => run.id)
    ).catch((error: unknown) => {
      console.warn(
        JSON.stringify({ event: 'benchmark_run_progress_failed', ...formatError(error) })
      );
      return new Map<string, BenchmarkRunProgress>();
    });
    // Totals are one bounded aggregate per page of runs, never their summaries.
    // A failed aggregate leaves the list intact, without the cost columns.
    const runIds = runs.map(run => run.id);
    const [totalsByRunId, modelsByRunId] = await Promise.all([
      loadRunTotals(c.env.BENCH_DB, runIds).catch((error: unknown) => {
        console.warn(
          JSON.stringify({ event: 'benchmark_run_totals_failed', ...formatError(error) })
        );
        return new Map<string, BenchmarkRunTotals>();
      }),
      listRunModelIds(c.env.BENCH_DB, runIds).catch((error: unknown) => {
        console.warn(
          JSON.stringify({ event: 'benchmark_run_models_failed', ...formatError(error) })
        );
        return new Map<string, string[]>();
      }),
    ]);
    return c.json({
      runs: runs.map(run => {
        const progress = progressByRunId.get(run.id);
        const totals = totalsByRunId.get(run.id);
        const models = modelsByRunId.get(run.id);
        return withLegacyAdminRunFields({
          ...run,
          ...(progress ? { progress } : {}),
          ...(totals ? { totals } : {}),
          ...(models ? { models } : {}),
        });
      }),
      runningRunIds,
    } satisfies BenchmarkRunsResponse);
  });

  app.get('/admin/runs/:runId/summaries', async c => {
    const runId = c.req.param('runId');
    const summaries = await getRunSummariesForRouter(c.env.BENCH_DB, runId, requestRouter(c));
    if (summaries === null) return c.json({ error: 'Run not found' }, 404);
    // The per-pair totals are display-only: a failed aggregate must not hide the
    // route rows, which carry the same run's detail.
    const modelTotals = await loadRunModelTotals(c.env.BENCH_DB, runId).catch((error: unknown) => {
      console.warn(
        JSON.stringify({ event: 'benchmark_run_model_totals_failed', runId, ...formatError(error) })
      );
      return undefined;
    });
    return c.json({
      summaries,
      ...(modelTotals ? { modelTotals } : {}),
    } satisfies BenchmarkRunSummariesResponse);
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
        const started = await drainQueues(c.env, queue, drainErrors, router);
        // Drains never throw, so a wedged queue would otherwise return 200 and
        // the panel would report "nothing pending" for work that is stuck.
        // Nothing started at all is a failed request; a queue that failed while
        // another started is reported alongside the run that did start.
        if (started.length === 0 && drainErrors.length > 0) {
          const [first] = drainErrors;
          if (first instanceof BenchmarkRunConfigError)
            return c.json({ error: first.message }, 400);
          throw first;
        }
        // A started run is `running` once its row exists; the dispatcher reuses prior
        // results and materializes its chunks after this response.
        return c.json(
          {
            runId: started[0]?.runId ?? null,
            enqueuedModels: started.reduce((total, run) => total + run.entryCount, 0),
            skippedModels: [],
            startedRuns: started,
            drainErrors: drainErrors.map(error =>
              error instanceof Error ? error.message : String(error)
            ),
          },
          started.length > 0 ? 202 : 200
        );
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
      repetitions: resolveEffectivePolicy(config).deciderRepetitions,
    };
    const [platform, user, platformEntries, failedEntries] = await Promise.all([
      countCurrentProfilesByStatus(c.env.BENCH_DB, current, 'platform'),
      countCurrentProfilesByStatus(c.env.BENCH_DB, current, 'user'),
      listCurrentPlatformProfileStatuses(c.env.BENCH_DB, current),
      listCurrentFailedProfiles(c.env.BENCH_DB, current),
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
      failedEntries,
    });
  });

  // Re-measure the cases the revision-1 prompt transport measured unreliably, for ready
  // pairs that keep serving their previous run until the new one completes.
  app.post(
    '/admin/registry/remeasure-prompt-transport',
    zodJsonValidator(RemeasureRequestSchema, { errorMessage: 'Invalid re-measure request' }),
    async c => {
      const { router, action, pairs } = c.req.valid('json');
      const catalog = await fetchBenchmarkModelCatalog(c.env).catch(() => null);
      const prices = catalog ? catalogCandidatePrices(catalog) : new Map();
      const reports = [];
      const skippedRouters: AutoRouter[] = [];
      for (const selected of router ? [router] : AUTO_ROUTERS) {
        const config = await getBenchmarkConfig(c.env.BENCH_DB, selected);
        if (!config) {
          skippedRouters.push(selected);
          continue;
        }
        reports.push(
          await planPromptTransportRemeasure(c.env.BENCH_DB, {
            router: selected,
            engineIdentity: computeEngineIdentity('decider', selected),
            repetitions: resolveEffectivePolicy(config).deciderRepetitions,
            revision: ACTIVE_MEASUREMENT_REVISION,
            action,
            prices,
            ...(pairs ? { pairs } : {}),
          })
        );
      }
      return c.json({ action, catalogPrices: catalog !== null, skippedRouters, routers: reports });
    }
  );

  // Admin requeue of retryable failed registry rows whose retry window has passed.
  // Permanent failures are re-admitted one at a time through /admin/registry/refresh.
  // Charges no owner quota — an owner's own Retry goes through
  // /admin/profiles/register and is quota-charged there.
  app.post(
    '/admin/registry/requeue',
    zodJsonValidator(RequeueBenchmarkRegistryRequestSchema, {
      errorMessage: 'Invalid requeue request',
    }),
    async c => {
      const router = AutoRouterSchema.parse(c.req.query('router') ?? c.req.valid('json').router);
      const config = await getBenchmarkConfig(c.env.BENCH_DB, router);
      if (!config) {
        return c.json({ error: 'benchmark config not set: save it in the admin panel first' }, 400);
      }
      const requeued = await requeueRetryableCurrentProfiles(
        c.env.BENCH_DB,
        {
          router,
          engineIdentity: computeEngineIdentity('decider', router),
          repetitions: resolveEffectivePolicy(config).deciderRepetitions,
        },
        c.req.valid('json').scope
      );
      return c.json({ requeued });
    }
  );

  app.get('/admin/routing-table', async c =>
    c.body(await loadRoutingTableResponse(c.env, requestRouter(c)), 200, {
      'Content-Type': 'application/json',
    })
  );

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
      let benchmarkIdentity: BenchmarkIdentity;
      try {
        benchmarkIdentity = resolveRunIdentity(config);
      } catch (error) {
        if (error instanceof BenchmarkRunConfigError) return c.json({ error: error.message }, 400);
        throw error;
      }
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

  app.post(
    '/admin/profiles/register',
    zodJsonValidator(RegisterBenchmarkProfilesRequestSchema, {
      errorMessage: 'Invalid profile register request',
    }),
    async c => {
      const body = c.req.valid('json');
      const router = AutoRouterSchema.parse(c.req.query('router') ?? body.router);
      const config = await getBenchmarkConfig(c.env.BENCH_DB, router);
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
        const owner = { ownerType: body.ownerType, ownerId: body.ownerId };
        const catalog = await fetchExecutableBenchmarkModelCatalog(
          c.env,
          resolveBenchmarkIdentity(config)
        );
        const previous = await loadSubscriptionSnapshot(c.env.BENCH_DB, config.router, owner);
        const snapshot = resolveSubscriptionSnapshot(body.entries, previous, catalog, false, true);
        const pairs = snapshotPairs(snapshot).filter(pair =>
          catalogSupportsBenchmarkPair(catalog, pair)
        );
        const retryModels = new Set((body.retryEntries ?? []).map(entry => entry.model));
        const result =
          pairs.length > 0
            ? await registerProfiles(c.env.BENCH_DB, config, {
                ...owner,
                pairs,
                retryPairs: snapshotPairs(
                  snapshot.filter(entry => retryModels.has(entry.model))
                ).filter(pair => catalogSupportsBenchmarkPair(catalog, pair)),
              })
            : { statuses: [] };
        const saved = await syncSubscriptionSnapshot(c.env, config, owner, body.entries, {
          catalog,
          admit: false,
          retryUnresolved: true,
        });
        return c.json({
          statuses: mapSubscriptionStatuses(saved, result.statuses),
        });
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

  app.post(
    '/admin/profiles/subscriptions',
    zodJsonValidator(SyncBenchmarkSubscriptionsRequestSchema, {
      errorMessage: 'Invalid benchmark subscription request',
    }),
    async c => {
      const body = c.req.valid('json');
      const config = await getBenchmarkConfig(c.env.BENCH_DB);
      if (!config) return c.json({ error: 'Benchmark config is not configured.' }, 400);
      const snapshot = await syncSubscriptionSnapshot(c.env, config, body, body.entries ?? [], {
        restorePrevious: body.restorePrevious,
      });
      const pairs = snapshotPairs(snapshot);
      const result =
        pairs.length > 0
          ? await lookupProfileStatuses(c.env.BENCH_DB, config, { pairs })
          : { statuses: [] };
      return c.json({ statuses: mapSubscriptionStatuses(snapshot, result.statuses) });
    }
  );

  app.post(
    '/admin/profiles/status',
    zodJsonValidator(BenchmarkProfileStatusesRequestSchema, {
      errorMessage: 'Invalid profile status request',
    }),
    async c => {
      const body = c.req.valid('json');
      const router = AutoRouterSchema.parse(c.req.query('router') ?? body.router);
      const config = await getBenchmarkConfig(c.env.BENCH_DB, router);
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
        const owner =
          body.ownerType && body.ownerId
            ? { ownerType: body.ownerType, ownerId: body.ownerId }
            : PLATFORM_SUBSCRIPTION_OWNER;
        const saved = await loadSubscriptionSnapshot(c.env.BENCH_DB, config.router, owner);
        const snapshot = resolveSubscriptionSnapshot(body.entries, saved, null);
        const pairs = snapshotPairs(snapshot);
        const result =
          pairs.length > 0
            ? await lookupProfileStatuses(c.env.BENCH_DB, config, { pairs })
            : { statuses: [] };
        return c.json({
          statuses: mapSubscriptionStatuses(snapshot, result.statuses),
        });
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
      const router = AutoRouterSchema.parse(c.req.query('router') ?? body.router);
      const config = await getBenchmarkConfig(c.env.BENCH_DB, router);
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
        const owner =
          body.ownerType && body.ownerId
            ? { ownerType: body.ownerType, ownerId: body.ownerId }
            : PLATFORM_SUBSCRIPTION_OWNER;
        const snapshot = await servingSubscriptionSnapshot(c.env.BENCH_DB, config, owner);
        const requested = new Set(body.entries.map(entry => entry.model));
        const pairs = snapshotPairs(
          snapshot.filter(entry => requested.has(entry.model)),
          true
        );
        return c.json(
          pairs.length > 0
            ? await assembleCustomRoutingTable(c.env.BENCH_DB, config, pairs, {
                catalogEnv: c.env,
              })
            : { table: null }
        );
      } catch (error) {
        if (error instanceof ProfileValidationError || error instanceof ProfileConfigMissingError) {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }
    }
  );

  app.post(
    CUSTOM_ROUTER_TABLE_PATH,
    zodJsonValidator(CustomRouterBenchmarkContextSchema, {
      errorMessage: 'Invalid custom router table request',
    }),
    async c => {
      const context = c.req.valid('json');
      const config = await getBenchmarkConfig(c.env.BENCH_DB, context.baseRouter);
      if (!config) return c.json({ table: null } satisfies CustomRoutingTableResponse);
      return c.json(
        await assembleCustomRouterTable(c.env.BENCH_DB, config, context, { catalogEnv: c.env })
      );
    }
  );

  app.post(
    CUSTOM_ROUTER_STATUS_PATH,
    zodJsonValidator(CustomRouterBenchmarkContextSchema, {
      errorMessage: 'Invalid custom router status request',
    }),
    async c => {
      const context = c.req.valid('json');
      const config = await getBenchmarkConfig(c.env.BENCH_DB, context.baseRouter);
      if (!config) {
        return c.json(
          { error: `benchmark config not set for the ${context.baseRouter} router` },
          400
        );
      }
      return c.json(
        await lookupCustomRouterStatuses(c.env.BENCH_DB, config, context, { catalogEnv: c.env })
      );
    }
  );

  // Read-only add-time validation for the pool editor: the exact resolved gateway pair and the
  // permanent failure behind it. It reads the registry and never writes or admits a benchmark, so
  // a save can never start spend through this path.
  app.post(
    CUSTOM_ROUTER_BLOCKED_MODELS_PATH,
    zodJsonValidator(CustomRouterBlockedModelsRequestSchema, {
      errorMessage: 'Invalid blocked models request',
    }),
    async c => {
      const request = c.req.valid('json');
      const config = await getBenchmarkConfig(c.env.BENCH_DB, request.router);
      if (!config) return c.json({ router: request.router, blocked: [] });
      return c.json(
        await lookupCustomRouterBlockers(c.env.BENCH_DB, config, request, { catalogEnv: c.env })
      );
    }
  );

  // Operator stop for one platform run. Platform benchmarking is automatic, so this is
  // the only admin stop control; it never touches a paid user request.
  app.post('/admin/runs/:runId/cancel', async c => {
    const router = AutoRouterSchema.safeParse(c.req.query('router') ?? DEFAULT_AUTO_ROUTER);
    if (!router.success) return c.json({ error: 'Invalid router' }, 400);
    const runId = c.req.param('runId');
    if (runId.length === 0) return c.json({ error: 'Invalid run id' }, 400);
    const outcome = await cancelPlatformBenchmarkRun(c.env, router.data, runId);
    return c.json(
      BenchmarkRunCancelResponseSchema.parse({
        status: outcome === 'not_active' ? 'already_finished' : outcome,
      })
    );
  });

  // Cheap canonical version for a pool's table: one indexed profile read, no table build, no
  // writes. The serving Worker polls it to notice a newly ready measurement — from any payer —
  // instead of waiting out its cache TTL.
  app.post(
    CUSTOM_ROUTER_TABLE_VERSION_PATH,
    zodJsonValidator(CustomRouterBenchmarkContextSchema, {
      errorMessage: 'Invalid custom router table version request',
    }),
    async c => {
      const context = c.req.valid('json');
      const config = await getBenchmarkConfig(c.env.BENCH_DB, context.baseRouter);
      if (!config) return c.json({ error: 'Benchmark config is not configured.' }, 400);
      const version = await computeCustomRouterReadinessVersion(c.env.BENCH_DB, config, context, {
        catalogEnv: c.env,
      });
      return c.json(CustomRouterTableVersionResponseSchema.parse({ readinessVersion: version }));
    }
  );

  // One exact-key read of the router's readiness epoch. The serving Worker calls this through the
  // benchmark service binding before it trusts a cached custom routing table: the epoch advances
  // inside the same D1 transaction as every readiness/provenance change, so a match proves the
  // cache was assembled from the current registry state. It reads no catalogue and scans nothing.
  app.post(
    CUSTOM_ROUTER_EPOCH_PATH,
    zodJsonValidator(CustomRouterEpochRequestSchema, {
      errorMessage: 'Invalid custom router epoch request',
    }),
    async c => {
      const { router } = c.req.valid('json');
      try {
        const epoch = await readBenchmarkReadinessEpoch(c.env.BENCH_DB, router);
        return c.json(CustomRouterEpochResponseSchema.parse({ epoch }));
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: 'custom_router_epoch_unavailable',
            router,
            ...formatError(error),
          })
        );
        // Unprovable state is never "unchanged": the caller must re-read the actual table.
        return c.json({ error: 'Readiness epoch is unavailable' }, 503);
      }
    }
  );

  // The admin console manages both benchmark queues: platform work stays automatic, and
  // these routes read the user-paid requests and expose the one control it needs — a
  // pause that stops that request's spend immediately.
  app.get(PAID_BENCHMARK_ADMIN_PATH, async c => {
    const query = PaidBenchmarkAdminListQuerySchema.safeParse({
      router: c.req.query('router') ?? undefined,
      status: c.req.query('status') ?? undefined,
      cursor: c.req.query('cursor') ?? undefined,
      limit: c.req.query('limit') ?? undefined,
    });
    if (!query.success) return c.json({ error: 'Invalid paid request query' }, 400);
    const statuses = (query.data.status ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(value => value.length > 0);
    const parsedStatuses = z.array(PaidBenchmarkAdminRequestStatusSchema).safeParse(statuses);
    if (!parsedStatuses.success) return c.json({ error: 'Unknown paid request status' }, 400);
    try {
      return c.json(
        await listPaidBenchmarkAdminRequests(c.env.BENCH_DB, {
          router: query.data.router,
          statuses: parsedStatuses.data,
          cursor: query.data.cursor,
          limit: query.data.limit,
        })
      );
    } catch (error) {
      // A malformed keyset cursor is a client error, not a worker fault.
      if (error instanceof Error && error.message.includes('cursor')) {
        return c.json({ error: 'Invalid paid request cursor' }, 400);
      }
      throw error;
    }
  });

  app.get(PAID_BENCHMARK_ADMIN_PROGRESS_PATH, async c => {
    const requestId = PaidBenchmarkIdSchema.safeParse(c.req.query('requestId'));
    if (!requestId.success) return c.json({ error: 'Invalid paid request id' }, 400);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .safeParse(c.req.query('limit') ?? undefined);
    if (!limit.success) return c.json({ error: 'Invalid case limit' }, 400);
    const progress = await readPaidBenchmarkAdminProgress(c.env.BENCH_DB, {
      requestId: requestId.data,
      cursor: c.req.query('cursor') ?? undefined,
      limit: limit.data,
    });
    return c.json(progress, progress.status === 'empty' ? 404 : 200);
  });

  app.post(
    PAID_BENCHMARK_ADMIN_PAUSE_PATH,
    zodJsonValidator(PaidBenchmarkAdminPauseRequestSchema, {
      errorMessage: 'Invalid paid request pause',
    }),
    async c => {
      const { requestId } = c.req.valid('json');
      const status = await pausePaidBenchmarkAdminRequest(c.env, requestId);
      return c.json(PaidBenchmarkAdminPauseResponseSchema.parse({ status }));
    }
  );

  // The pool routing result the request's quote was bound to: same ranking as the pool's
  // own routing table, read from the stored context.
  app.post(
    PAID_BENCHMARK_ADMIN_ROUTING_TABLE_PATH,
    zodJsonValidator(PaidBenchmarkAdminRoutingTableRequestSchema, {
      errorMessage: 'Invalid paid request routing table request',
    }),
    async c => {
      const { requestId } = c.req.valid('json');
      const stored = await readPaidBenchmarkAdminContext(c.env.BENCH_DB, requestId);
      if (stored === null) return c.json({ error: 'Paid benchmark request not found' }, 404);
      let rawContext: unknown;
      try {
        rawContext = JSON.parse(stored);
      } catch {
        return c.json({ error: 'Stored pool context is not JSON' }, 400);
      }
      const context = CustomRouterBenchmarkContextSchema.safeParse(rawContext);
      if (!context.success) return c.json({ error: 'Stored pool context is invalid' }, 400);
      const config = await getBenchmarkConfig(c.env.BENCH_DB, context.data.baseRouter);
      if (!config) return c.json({ table: null });
      return c.json(
        await assembleCustomRouterTable(c.env.BENCH_DB, config, context.data, {
          catalogEnv: c.env,
        })
      );
    }
  );
}
