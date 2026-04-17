import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware } from './auth';
import { botAuthMiddleware } from './auth-bot';
import type { AuthContext } from './auth';
import { registerConversationRoutes } from './routes/conversations';
import { registerMessageRoutes } from './routes/messages';
import { registerEventsRoutes } from './routes/events';
import { registerReactionsRoutes } from './routes/reactions';
import { registerTypingRoutes } from './routes/typing';
import { registerBotRoutes } from './routes/bot-messages';
import { buildWebhookPayload, type WebhookMessage } from './webhook/deliver';

export { MembershipDO } from './do/membership-do';
export { ConversationDO } from './do/conversation-do';

const DEFAULT_ALLOWED_ORIGINS = ['https://kilo.ai', 'https://app.kilo.ai', 'http://localhost:3000'];

const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

app.use(
  '/v1/*',
  cors({
    origin: (origin, c) => {
      const envOrigins = (c.env as { ALLOWED_ORIGINS?: string }).ALLOWED_ORIGINS;
      const allowed = envOrigins
        ? envOrigins.split(',').map(o => o.trim())
        : DEFAULT_ALLOWED_ORIGINS;
      return allowed.includes(origin) ? origin : '';
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // Bots reach the Worker via RPC; HTTP is humans-only with a JWT bearer.
    allowHeaders: ['Content-Type', 'Authorization', 'Last-Event-ID'],
    exposeHeaders: ['Content-Type'],
    maxAge: 86400,
  })
);

app.get('/health', c => c.json({ ok: true }));

app.use('/v1/*', authMiddleware);
registerConversationRoutes(app);
registerMessageRoutes(app);
registerEventsRoutes(app);
registerReactionsRoutes(app);
registerTypingRoutes(app);

// Bot HTTP routes — gateway-token auth, called directly by Fly controllers.
app.use('/bot/v1/sandboxes/:sandboxId/*', botAuthMiddleware);
registerBotRoutes(app);

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  async queue(batch: MessageBatch<WebhookMessage>): Promise<void> {
    if (batch.queue === 'kilo-chat-webhooks-dlq') {
      await this.handleDlq(batch);
      return;
    }
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

  private async handleDlq(batch: MessageBatch<WebhookMessage>): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const { conversationId, messageId, from: senderId } = msg.body;
        console.error(
          `Webhook permanently failed for message ${messageId} in conversation ${conversationId}`
        );
        const stub = this.env.CONVERSATION_DO.get(
          this.env.CONVERSATION_DO.idFromName(conversationId)
        );
        await stub.notifyDeliveryFailed(messageId, senderId);
      } catch (err) {
        console.error('DLQ handler error:', err);
      }
      msg.ack();
    }
  }
}
