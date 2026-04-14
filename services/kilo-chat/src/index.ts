import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { authMiddleware } from './auth';
import type { AuthContext } from './auth';
import { registerConversationRoutes } from './routes/conversations';
import { registerMessageRoutes } from './routes/messages';
import { registerEventsRoutes } from './routes/events';
import { registerTypingRoutes } from './routes/typing';
import { deliverWebhook, type WebhookMessage } from './webhook/deliver';

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
    let webhookUrl: string | null = null;
    let webhookSecret: string | null = null;
    try {
      webhookUrl = await this.env.KILOCHAT_WEBHOOK_URL.get();
      webhookSecret = await this.env.KILOCHAT_WEBHOOK_SECRET.get();
    } catch {
      // Secrets not configured (e.g. in test/dev environments)
    }
    if (!webhookUrl || !webhookSecret) {
      console.error('Webhook URL or secret not configured, dropping messages');
      for (const msg of batch.messages) msg.ack();
      return;
    }
    for (const msg of batch.messages) {
      try {
        await deliverWebhook(msg.body, webhookUrl, webhookSecret);
        msg.ack();
      } catch (err) {
        console.error('Webhook delivery failed, will retry:', err);
        msg.retry();
      }
    }
  }
}
