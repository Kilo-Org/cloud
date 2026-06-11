import { Hono } from 'hono';
import { createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import { authMiddleware } from './auth';
import type { HonoEnv } from './hono-env';

export const app = new Hono<HonoEnv>();
app.use('*', authMiddleware);
app.get('/health', c => c.json({ status: 'ok', service: 'auto-routing-benchmark' }));
app.notFound(createNotFoundHandler());
app.onError(createErrorHandler());

export default {
  fetch: app.fetch,
  // Wired up in later tasks (run orchestration + admin endpoints).
  async scheduled(
    _controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {},
  async queue(
    _batch: MessageBatch<unknown>,
    _env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {},
};
