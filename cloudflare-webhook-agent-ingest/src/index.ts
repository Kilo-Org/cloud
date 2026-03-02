import { Hono } from 'hono';
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

// @ts-expect-error workers-tagged-logger returns Handler typed against an older hono; incompatible with hono 4.12+
app.use('*', useWorkersLogger('webhook-agent'));

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
