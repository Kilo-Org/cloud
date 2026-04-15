import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware } from './auth';
import type { AuthContext } from './auth';
import { registerConversationRoutes } from './routes/conversations';
import { registerMessageRoutes } from './routes/messages';
import { registerEventsRoutes } from './routes/events';
import { registerReactionsRoutes } from './routes/reactions';
import { registerTypingRoutes } from './routes/typing';
import { buildWebhookPayload, type WebhookMessage } from './webhook/deliver';
import {
  createMessageFor,
  deleteMessageFor,
  editMessageFor,
  type ContentBlock,
  type CreateMessageResult,
  type DeleteMessageResult,
  type EditMessageResult,
} from './services/messages';
import {
  addReactionFor,
  removeReactionFor,
  type AddReactionResult,
  type RemoveReactionResult,
} from './services/reactions';
import { setTypingFor, type SetTypingResult } from './services/typing';

export { MembershipDO } from './do/membership-do';
export { ConversationDO } from './do/conversation-do';

// ──────────────────────────────────────────────────────────────────────────
// Bot RPC surface (called by kiloclaw via service binding)
// ──────────────────────────────────────────────────────────────────────────
//
// These methods are only reachable over a CF service binding. Only kiloclaw
// declares that binding, and kiloclaw only invokes them after verifying the
// caller's sandboxId via its own per-sandbox gateway-token HMAC. Bots have
// no public HTTP surface — identity comes from the trusted service binding
// caller, not from any header the bot supplies.

/** Tight sandboxId guard. The upstream kiloclaw proxy already validates, but
 * defense-in-depth is cheap — rejects stray callers that somehow bypass the
 * gateway-token check. */
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function callerIdFromSandbox(sandboxId: string): string | null {
  if (!SANDBOX_ID_PATTERN.test(sandboxId)) return null;
  return `bot:kiloclaw:${sandboxId}`;
}

type BotRejection = { ok: false; code: 'invalid_sandbox'; error: string };
const INVALID_SANDBOX: BotRejection = {
  ok: false,
  code: 'invalid_sandbox',
  error: 'Invalid sandboxId',
};

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
    // Bots use RPC (service binding), not HTTP. Humans use a JWT bearer.
    // x-kilo-sandbox-id is not needed on any public HTTP surface.
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

  // ── Bot RPC surface (called by kiloclaw via service binding) ──

  async botCreateMessage(params: {
    sandboxId: string;
    conversationId: string;
    content: ContentBlock[];
    inReplyToMessageId?: string;
  }): Promise<CreateMessageResult | BotRejection> {
    const callerId = callerIdFromSandbox(params.sandboxId);
    if (!callerId) return INVALID_SANDBOX;
    return createMessageFor(
      this.env,
      callerId,
      {
        conversationId: params.conversationId,
        content: params.content,
        inReplyToMessageId: params.inReplyToMessageId,
      },
      this.ctx
    );
  }

  async botEditMessage(params: {
    sandboxId: string;
    conversationId: string;
    messageId: string;
    content: ContentBlock[];
    version: number;
  }): Promise<EditMessageResult | BotRejection> {
    const callerId = callerIdFromSandbox(params.sandboxId);
    if (!callerId) return INVALID_SANDBOX;
    return editMessageFor(this.env, callerId, {
      conversationId: params.conversationId,
      messageId: params.messageId,
      content: params.content,
      version: params.version,
    });
  }

  async botDeleteMessage(params: {
    sandboxId: string;
    conversationId: string;
    messageId: string;
  }): Promise<DeleteMessageResult | BotRejection> {
    const callerId = callerIdFromSandbox(params.sandboxId);
    if (!callerId) return INVALID_SANDBOX;
    return deleteMessageFor(this.env, callerId, {
      conversationId: params.conversationId,
      messageId: params.messageId,
    });
  }

  async botAddReaction(params: {
    sandboxId: string;
    conversationId: string;
    messageId: string;
    emoji: string;
  }): Promise<AddReactionResult | BotRejection> {
    const callerId = callerIdFromSandbox(params.sandboxId);
    if (!callerId) return INVALID_SANDBOX;
    return addReactionFor(this.env, callerId, {
      conversationId: params.conversationId,
      messageId: params.messageId,
      emoji: params.emoji,
    });
  }

  async botRemoveReaction(params: {
    sandboxId: string;
    conversationId: string;
    messageId: string;
    emoji: string;
  }): Promise<RemoveReactionResult | BotRejection> {
    const callerId = callerIdFromSandbox(params.sandboxId);
    if (!callerId) return INVALID_SANDBOX;
    return removeReactionFor(this.env, callerId, {
      conversationId: params.conversationId,
      messageId: params.messageId,
      emoji: params.emoji,
    });
  }

  async botSendTyping(params: {
    sandboxId: string;
    conversationId: string;
  }): Promise<SetTypingResult | BotRejection> {
    const callerId = callerIdFromSandbox(params.sandboxId);
    if (!callerId) return INVALID_SANDBOX;
    return setTypingFor(this.env, callerId, { conversationId: params.conversationId });
  }
}
