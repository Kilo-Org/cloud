import { Hono } from 'hono';
import { createErrorHandler, createNotFoundHandler, formatError } from '@kilocode/worker-utils';
import { registerAdminRoutes } from './admin';
import { authMiddleware } from './auth';
import { syncAutoDeciderModels } from './auto-decider-sync';
import type { HonoEnv } from './hono-env';
import { processDeadLetter, processJob, type BenchmarkJobMessage } from './run';

// Queue name of the dead-letter queue, matched against batch.queue.
const DLQ_NAME = 'auto-routing-benchmark-dlq';

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
    // run. Never throw — a poison DLQ message retrying forever would wedge the
    // run again; the stale sweep remains the backstop.
    if (batch.queue === DLQ_NAME) {
      for (const message of batch.messages) {
        await processDeadLetter(env, message.body).catch(error => {
          console.warn(
            JSON.stringify({
              event: 'benchmark_deadletter_handler_error',
              ...formatError(error),
            })
          );
        });
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
