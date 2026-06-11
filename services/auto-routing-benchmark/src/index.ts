import { Hono } from 'hono';
import { createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import { authMiddleware } from './auth';
import {
  getConfigHandler,
  putConfigHandler,
  listRunsHandler,
  startRunHandler,
  getRoutingTableHandler,
} from './admin';
import type { HonoEnv } from './hono-env';
import { processJob, startRun, type BenchmarkJobMessage } from './run';

export const app = new Hono<HonoEnv>();
app.use('*', authMiddleware);
app.get('/health', c => c.json({ status: 'ok', service: 'auto-routing-benchmark' }));

app.get('/admin/config', getConfigHandler);
app.put('/admin/config', putConfigHandler);
app.get('/admin/runs', listRunsHandler);
app.post('/admin/runs', startRunHandler);
app.get('/admin/routing-table', getRoutingTableHandler);

app.notFound(createNotFoundHandler());
app.onError(createErrorHandler());

const DECIDER_CRON = '10 5 * * 1';

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const kind = controller.cron === DECIDER_CRON ? 'decider' : 'classifier';
    ctx.waitUntil(startRun(env, kind));
  },
  async queue(batch: MessageBatch<BenchmarkJobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processJob(env, message.body);
      message.ack();
    }
  },
};
