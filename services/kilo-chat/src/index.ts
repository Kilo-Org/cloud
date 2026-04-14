import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { authMiddleware } from './auth';
import type { AuthContext } from './auth';
import { registerConversationRoutes } from './routes/conversations';
import { registerMessageRoutes } from './routes/messages';
import { registerEventsRoutes } from './routes/events';
import { registerTypingRoutes } from './routes/typing';
import { buildWebhookPayload, type WebhookMessage } from './webhook/deliver';

export { MembershipDO } from './do/membership-do';
export { ConversationDO } from './do/conversation-do';

const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

app.get('/health', c => c.json({ ok: true }));

app.use('/v1/*', authMiddleware);
registerConversationRoutes(app);
registerMessageRoutes(app);
registerEventsRoutes(app);
registerTypingRoutes(app);

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  async queue(batch: MessageBatch<WebhookMessage>): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const payload = buildWebhookPayload(msg.body);
        await this.env.KILOCLAW.deliverChatWebhook({
          targetBotId: msg.body.targetBotId,
          ...payload,
        });
        msg.ack();
      } catch (err) {
        console.error('Webhook delivery failed, will retry:', err);
        msg.retry();
      }
    }
  }
}
