import { Hono } from 'hono';
import {
  AUTO_ROUTERS,
  type AutoRouter,
  type ProductionAutoMetrics,
} from '@kilocode/auto-routing-contracts';
import { createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import { registerAdminRoutes } from './admin';
import { authMiddleware } from './auth';
import { registerClientEvalRoutes } from './client-eval';
import type { HonoEnv } from './hono-env';
import { fetchProductionAutoMetrics, reevaluateSystemOptimalSettings } from './system-optimal';
import { isRetryableContainerAvailabilityError } from './cli-runner';
import {
  processDeadLetter,
  acceptContainerCaseResult,
  processJob,
  drainQueues,
  PLATFORM_SYNC_CRON,
  publishPlatformRoutingTable,
  sweepStaleRuns,
  syncPlatformRegistry,
  sweepStaleRunsAndDrain,
  type BenchmarkJobMessage,
} from './run';
import { continueDailyReconcile, dailyReconcileSubscriptions } from './subscriptions';
import { registerCaseInferenceRoutes } from './case-inference';
import {
  reconcilePaidBenchmarkRequests,
  reconcilePaidUsageReceipts,
  registerPaidBenchmarkRoutes,
} from './paid-benchmark';

// Queue name of the dead-letter queue, matched against batch.queue.
const DLQ_NAME = 'auto-routing-benchmark-dlq';

// Re-exported so the Durable Object class binding (BENCH_RUNNER) can find it.
export { BenchRunnerContainer } from './bench-runner-container';

type StepResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Runs one router's daily branch with every step isolated. A failed registry sync, drain or
 * publish still lets the others run, and the alias sync reports its own outcome instead of
 * throwing, so one D1 error cannot discard the day's detection, queueing and publication.
 * The summary event carries each step's outcome; a step that fails is also collected for the
 * scheduled handler's aggregate error.
 */
async function runDailyPlatformSync(
  cron: string,
  env: Env,
  router: AutoRouter,
  production: ProductionAutoMetrics | null,
  errors: unknown[]
): Promise<void> {
  const step = async <T>(name: string, run: () => Promise<T>): Promise<StepResult<T>> => {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        JSON.stringify({
          event: 'benchmark_daily_step_failed',
          cron,
          router,
          step: name,
          error: message,
        })
      );
      errors.push(new Error(`${router} ${name}: ${message}`));
      return { ok: false, error: message };
    }
  };

  const sweep = await step('sweep', () => sweepStaleRuns(env));
  const aliases = await step('subscriptions', () => dailyReconcileSubscriptions(env, router));
  if (aliases.ok && aliases.value.platform.status === 'failed')
    errors.push(new Error(`${router} alias resolution: ${aliases.value.platform.error}`));
  const registry = await step('registrySync', () => syncPlatformRegistry(env, fetch, router));
  const optimal = await step('systemOptimal', () =>
    reevaluateSystemOptimalSettings(env, router, production)
  );
  if (optimal.ok && optimal.value) {
    const computedValues: Record<string, unknown> = {};
    for (const [key, record] of Object.entries(optimal.value)) {
      computedValues[key] = { value: record.value, source: record.source };
    }
    console.log(
      JSON.stringify({
        event: 'system_optimal_settings_computed',
        cron,
        router,
        computed: computedValues,
      })
    );
  }
  const drain = await step('drain', () => drainQueues(env, 'both', undefined, router));
  const publish = await step('publish', () => publishPlatformRoutingTable(env, fetch, router));

  console.log(
    JSON.stringify({
      event: 'benchmark_daily_sync_summary',
      cron,
      router,
      day: aliases.ok ? aliases.value.day : null,
      steps: {
        sweep: sweep.ok
          ? { status: 'ok', staleRunIds: sweep.value.length }
          : { status: 'failed', error: sweep.error },
        subscriptions: aliases.ok
          ? { platform: aliases.value.platform, owners: aliases.value.owners }
          : { status: 'failed', error: aliases.error },
        registrySync: registry.ok
          ? { status: 'ok', desiredEntries: registry.value.desiredEntries }
          : { status: 'failed', error: registry.error },
        systemOptimal: optimal.ok ? { status: 'ok' } : { status: 'failed', error: optimal.error },
        drain: drain.ok
          ? { status: 'ok', startedRuns: drain.value.length }
          : { status: 'failed', error: drain.error },
        publish: publish.ok
          ? { status: 'ok', publishedVersion: publish.value?.version ?? null }
          : { status: 'failed', error: publish.error },
      },
    })
  );
  console.log(
    JSON.stringify({
      event: 'benchmark_platform_sync_completed',
      cron,
      router,
      staleRunIds: sweep.ok ? sweep.value : [],
      platformEntries: registry.ok ? registry.value.desiredEntries : null,
      startedRuns: drain.ok ? drain.value : [],
      publishedVersion: publish.ok ? (publish.value?.version ?? null) : null,
    })
  );
}

export const app = new Hono<HonoEnv>();

// Containers cannot hold the backend secret; the paid-execution claim token
// authenticates their result instead, so this route precedes the auth middleware.
app.post('/container/case-result', async c => {
  const accepted = await acceptContainerCaseResult(c.env, await c.req.json().catch(() => null));
  return c.body(null, accepted ? 204 : 404);
});
// The same is true of inference: the case capability (an HMAC over the exact paid
// generation) is its credential, so these routes also precede the backend-secret middleware.
registerCaseInferenceRoutes(app);
app.use('*', authMiddleware);
app.get('/health', c => c.json({ status: 'ok', service: 'auto-routing-benchmark' }));

registerAdminRoutes(app);
registerClientEvalRoutes(app);
registerPaidBenchmarkRoutes(app);

app.notFound(createNotFoundHandler());
app.onError(createErrorHandler());

export default {
  fetch: app.fetch,
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx?: ExecutionContext
  ): Promise<void> {
    const errors: unknown[] = [];
    const production =
      controller.cron === PLATFORM_SYNC_CRON ? await fetchProductionAutoMetrics(env, ctx) : null;
    // Paid benchmarks: stage the next bounded slices, activate fully staged requests, settle
    // finished ones, and deliver the durable pin notifications. Never starts a request.
    try {
      const reconciled = await reconcilePaidBenchmarkRequests(env, { ctx });
      const receipts = await reconcilePaidUsageReceipts(env, { ctx });
      if (
        receipts.recorded > 0 ||
        reconciled.completed.length > 0 ||
        reconciled.failed.length > 0 ||
        reconciled.closed.length > 0
      )
        console.log(
          JSON.stringify({
            event: 'benchmark_paid_tick_completed',
            cron: controller.cron,
            reconciled,
            receipts,
          })
        );
    } catch (error) {
      errors.push(error);
      console.error(
        JSON.stringify({
          event: 'benchmark_paid_tick_failed',
          cron: controller.cron,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
    for (const router of AUTO_ROUTERS) {
      try {
        if (controller.cron !== PLATFORM_SYNC_CRON) {
          const result = await sweepStaleRunsAndDrain(env, router);
          const aliases = await continueDailyReconcile(env, router).catch(error => {
            console.warn(
              JSON.stringify({
                event: 'benchmark_daily_alias_continued_failed',
                cron: controller.cron,
                router,
                error: error instanceof Error ? error.message : String(error),
              })
            );
            return null;
          });
          console.log(
            JSON.stringify({
              event: 'benchmark_queue_drain_tick_completed',
              cron: controller.cron,
              router,
              staleRunIds: result.staleRunIds,
              drained: result.drained,
              ...(aliases && {
                dailyAliasSync: { platform: aliases.platform, owners: aliases.owners },
              }),
            })
          );
        } else {
          await runDailyPlatformSync(controller.cron, env, router, production, errors);
        }
      } catch (error) {
        errors.push(error);
        console.error(
          JSON.stringify({
            event: 'benchmark_scheduled_router_failed',
            cron: controller.cron,
            router,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Benchmark scheduled routers failed');
  },
  async queue(
    batch: MessageBatch<BenchmarkJobMessage>,
    env: Env,
    ctx?: ExecutionContext
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (batch.queue === DLQ_NAME) {
          await processDeadLetter(env, message.body);
        } else {
          await processJob(env, message.body, ctx);
        }
        message.ack();
      } catch (error) {
        if (batch.queue !== DLQ_NAME && isRetryableContainerAvailabilityError(error)) {
          try {
            await env.BENCH_QUEUE.send(message.body, { delaySeconds: 30 });
            message.ack();
            continue;
          } catch (dispatchError) {
            console.error(
              JSON.stringify({
                event: 'benchmark_capacity_requeue_failed',
                runId: message.body.runId,
                kind: message.body.kind,
                model: message.body.model,
                variant: message.body.variant ?? null,
                rep: message.body.rep ?? null,
                caseIds: message.body.caseIds ?? null,
                errorType: dispatchError instanceof Error ? dispatchError.name : 'unknown',
              })
            );
          }
        }
        console.error(
          JSON.stringify({
            event: 'benchmark_job_retry',
            runId: message.body.runId,
            kind: message.body.kind,
            model: message.body.model,
            variant: message.body.variant ?? null,
            rep: message.body.rep ?? null,
            caseIds: message.body.caseIds ?? null,
            recoverOutput: message.body.recoverOutput ?? false,
            errorType: error instanceof Error ? error.name : 'unknown',
          })
        );
        // Explicit retry preserves redelivery without reducing Queue consumer concurrency.
        message.retry();
      }
    }
  },
};
