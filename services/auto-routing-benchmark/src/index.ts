import { Hono } from 'hono';
import { createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import { registerAdminRoutes } from './admin';
import { authMiddleware } from './auth';
import { syncAutoDeciderModels } from './auto-decider-sync';
import type { HonoEnv } from './hono-env';
import {
  processDeadLetter,
  processJob,
  sweepStaleRunsAndDrain,
  type BenchmarkJobMessage,
} from './run';

// Queue name of the dead-letter queue, matched against batch.queue.
const DLQ_NAME = 'auto-routing-benchmark-dlq';

// Daily platform cadence: refresh auto decider candidates and start a platform
// run when they changed. Every other cron tick only drains profile work.
const PLATFORM_SYNC_CRON = '0 5 * * *';

// Re-exported so the Durable Object class binding (BENCH_RUNNER) can find it.
export { BenchRunnerContainer } from './bench-runner-container';

export const app = new Hono<HonoEnv>();
app.use('*', authMiddleware);
app.get('/health', c => c.json({ status: 'ok', service: 'auto-routing-benchmark' }));

registerAdminRoutes(app);

app.notFound(createNotFoundHandler());
app.onError(createErrorHandler());

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // Each queue holds its own slot and container budget, so the frequent tick
    // starts pending registry work without waiting for the platform cadence.
    if (controller.cron !== PLATFORM_SYNC_CRON) {
      const result = await sweepStaleRunsAndDrain(env);
      console.log(
        JSON.stringify({
          event: 'benchmark_queue_drain_tick_completed',
          cron: controller.cron,
          staleRunIds: result.staleRunIds,
          drained: result.drained,
        })
      );
      return;
    }
    const result = await syncAutoDeciderModels(env);
    console.log(
      JSON.stringify({
        event: 'auto_decider_model_sync_completed',
        cron: controller.cron,
        ...result,
      })
    );
  },
  async queue(batch: MessageBatch<BenchmarkJobMessage>, env: Env): Promise<void> {
    // Dead-lettered messages: record the lane death and try to finalize the
    // run. Same retry contract as the jobs branch: a throw (transient D1
    // failure after the death was recorded) skips the ack so the message
    // retries and finalization is re-attempted. A message still failing after
    // max_retries is dropped (the DLQ has no DLQ); the stale sweep remains
    // the backstop for runs that never finalize.
    if (batch.queue === DLQ_NAME) {
      for (const message of batch.messages) {
        await processDeadLetter(env, message.body);
        message.ack();
      }
      return;
    }
    for (const message of batch.messages) {
      // Deliberately no try/catch: a throw from processJob (transient token,
      // D1 or container failures) must skip the ack so the queue retries the
      // whole (run, model, rep, chunk) unit, dead-lettering after max_retries.
      // Case-level failures are recorded as failed rows inside processJob and
      // do not throw. Swallowing the throw here would silently drop chunks.
      await processJob(env, message.body);
      message.ack();
    }
  },
};
