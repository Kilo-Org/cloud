import { Hono } from 'hono';
import { createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import { authMiddleware } from './auth';
import {
  getConfigHandler,
  putConfigHandler,
  listRunsHandler,
  startRunHandler,
  getRoutingTableHandler,
  debugCliHandler,
} from './admin';
import type { HonoEnv } from './hono-env';
import { processJob, type BenchmarkJobMessage } from './run';

// Re-exported so the Durable Object class binding (BENCH_RUNNER) can find it.
export { BenchRunnerContainer } from './bench-runner-container';

export const app = new Hono<HonoEnv>();
app.use('*', authMiddleware);
app.get('/health', c => c.json({ status: 'ok', service: 'auto-routing-benchmark' }));

app.get('/admin/config', getConfigHandler);
app.put('/admin/config', putConfigHandler);
app.get('/admin/runs', listRunsHandler);
app.post('/admin/runs', startRunHandler);
app.get('/admin/routing-table', getRoutingTableHandler);
app.post('/admin/debug-cli', debugCliHandler);

app.notFound(createNotFoundHandler());
app.onError(createErrorHandler());

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<BenchmarkJobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      // Deliberately no try/catch: a throw from processJob (transient token,
      // D1 or container failures) must skip the ack so the queue retries the
      // whole (run, model, chunk) unit, dead-lettering after max_retries.
      // Case-level failures are recorded as failed rows inside processJob and
      // do not throw. Swallowing the throw here would silently drop chunks.
      await processJob(env, message.body);
      message.ack();
    }
  },
};
