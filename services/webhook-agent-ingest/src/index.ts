import { Hono, type MiddlewareHandler } from 'hono';
import { useWorkersLogger } from 'workers-tagged-logger';
import { TriggerDO } from './dos/TriggerDO';
import { logger } from './util/logger';
import { resError, resSuccess } from '@kilocode/worker-utils';
import { inbound } from './routes/inbound';
import { api } from './routes/api';
import { callbacks } from './routes/callbacks';
import { handleWebhookDeliveryBatch } from './queue-consumer';
import type { WebhookDeliveryMessage } from './util/queue';

export { TriggerDO };

export type HonoContext = {
  Bindings: Env;
  Variables: Record<string, never>; // No user context - internal API only
};

const app = new Hono<HonoContext>();

// TODO: remove cast once workers-tagged-logger publishes a version compiled against hono >=4.12.7
// workers-tagged-logger@1.0.0 was compiled against an older hono whose Handler
// type is structurally incompatible with hono >=4.12.7 (missing [GET_MATCH_RESULT]).
// The runtime middleware is fully compatible; only the .d.ts is stale.
app.use('*', useWorkersLogger('webhook-agent') as unknown as MiddlewareHandler);

app.get('/health', c => {
  return c.json(
    resSuccess({
      status: 'ok',
      service: 'webhook-agent',
      timestamp: new Date().toISOString(),
    })
  );
});

app.route('/inbound', inbound);
app.route('/api', api);
app.route('/api/callbacks', callbacks);

app.notFound(c => {
  return c.json(resError('Not found'), 404);
});

app.onError((err, c) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
  });
  return c.json(resError('Internal server error'), 500);
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<WebhookDeliveryMessage>, env: Env): Promise<void> {
    await handleWebhookDeliveryBatch(batch, env);
  },
};
