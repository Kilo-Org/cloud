import { Hono } from 'hono';
import { AUTO_ROUTERS, POLICY_SETTING_KEYS } from '@kilocode/auto-routing-contracts';
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
  publishPlatformRoutingTable,
  sweepStaleRuns,
  syncPlatformRegistry,
  sweepStaleRunsAndDrain,
  type BenchmarkJobMessage,
} from './run';
import { dailyReconcileSubscriptions } from './subscriptions';

// Queue name of the dead-letter queue, matched against batch.queue.
const DLQ_NAME = 'auto-routing-benchmark-dlq';

const PLATFORM_SYNC_CRON = '0 5 * * *';

// Re-exported so the Durable Object class binding (BENCH_RUNNER) can find it.
export { BenchRunnerContainer } from './bench-runner-container';

export const app = new Hono<HonoEnv>();
// Containers cannot hold the backend secret; the paid-execution claim token
// authenticates their result instead, so this route precedes the auth middleware.
app.post('/container/case-result', async c => {
  const accepted = await acceptContainerCaseResult(c.env, await c.req.json().catch(() => null));
  return c.body(null, accepted ? 204 : 404);
});
app.use('*', authMiddleware);
app.get('/health', c => c.json({ status: 'ok', service: 'auto-routing-benchmark' }));

registerAdminRoutes(app);
registerClientEvalRoutes(app);

app.notFound(createNotFoundHandler());
app.onError(createErrorHandler());

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const errors: unknown[] = [];
    const production =
      controller.cron === PLATFORM_SYNC_CRON ? await fetchProductionAutoMetrics(env) : null;
    for (const router of AUTO_ROUTERS) {
      try {
        if (controller.cron !== PLATFORM_SYNC_CRON) {
          const result = await sweepStaleRunsAndDrain(env, router);
          console.log(
            JSON.stringify({
              event: 'benchmark_queue_drain_tick_completed',
              cron: controller.cron,
              router,
              staleRunIds: result.staleRunIds,
              drained: result.drained,
            })
          );
        } else {
          const staleRunIds = await sweepStaleRuns(env);
          await dailyReconcileSubscriptions(env, router).catch(() => {
            console.warn(
              JSON.stringify({
                event: 'benchmark_subscription_daily_failed',
                category: 'daily_reconciliation',
                router,
              })
            );
          });
          const { desiredEntries } = await syncPlatformRegistry(env, fetch, router);
          const computed = await reevaluateSystemOptimalSettings(env, router, production).catch(
            error => {
              console.warn(
                JSON.stringify({
                  event: 'system_optimal_settings_skipped',
                  router,
                  error: error instanceof Error ? error.message : String(error),
                })
              );
              return null;
            }
          );
          if (computed) {
            const computedValues: Record<string, unknown> = {};
            for (const key of POLICY_SETTING_KEYS) {
              const record = computed[key];
              if (record) computedValues[key] = { value: record.value, source: record.source };
            }
            console.log(
              JSON.stringify({
                event: 'system_optimal_settings_computed',
                cron: controller.cron,
                router,
                computed: computedValues,
              })
            );
          }
          const startedRuns = await drainQueues(env, 'both', undefined, router);
          const published = await publishPlatformRoutingTable(env, fetch, router).catch(error => {
            console.warn(
              JSON.stringify({
                event: 'routing_table_publish_skipped',
                router,
                error: error instanceof Error ? error.message : String(error),
              })
            );
            return null;
          });
          console.log(
            JSON.stringify({
              event: 'benchmark_platform_sync_completed',
              cron: controller.cron,
              router,
              staleRunIds,
              platformEntries: desiredEntries,
              startedRuns,
              publishedVersion: published?.version ?? null,
            })
          );
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
  async queue(batch: MessageBatch<BenchmarkJobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (batch.queue === DLQ_NAME) {
          await processDeadLetter(env, message.body);
        } else {
          await processJob(env, message.body);
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
