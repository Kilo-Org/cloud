import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import pLimit from 'p-limit';
import { withDORetry } from '@kilocode/worker-utils';
import { cors } from 'hono/cors';
import { useWorkersLogger } from 'workers-tagged-logger';
import type { MiddlewareHandler } from 'hono';
import { logger } from './util/logger';
import { formatError } from '@kilocode/worker-utils';
import { authMiddleware } from './auth';
import { botAuthMiddleware } from './auth-bot';
import type { AuthContext } from './auth';
import { registerConversationRoutes } from './routes/conversations';
import { registerMessageRoutes } from './routes/messages';
import { registerReactionsRoutes } from './routes/reactions';
import { registerTypingRoutes } from './routes/typing';
import { registerBotRoutes } from './routes/bot-messages';
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
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // Bots reach the Worker via RPC; HTTP is humans-only with a JWT bearer.
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Type'],
    maxAge: 86400,
  })
);

// ── Structured logging context ──────────────────────────────────────────
// Establishes AsyncLocalStorage context so all downstream logs are tagged.
// Cast needed: workers-tagged-logger@1.0.0 was built against an older Hono.
app.use('*', useWorkersLogger('kilo-chat') as unknown as MiddlewareHandler);

// Tag URL params early. Auth-derived tags (callerId, callerKind) are set
// by the auth middleware files where those values are established.
const RE_SANDBOX = /\/sandboxes\/(?<sandboxId>[^/]+)/;
const RE_CONVERSATION = /\/conversations\/(?<conversationId>[^/]+)/;
const RE_MESSAGE = /\/messages\/(?<messageId>[^/]+)/;

app.use('*', async (c, next) => {
  const path = c.req.path;
  logger.setTags({
    sandboxId: RE_SANDBOX.exec(path)?.groups?.sandboxId,
    conversationId: RE_CONVERSATION.exec(path)?.groups?.conversationId,
    messageId: RE_MESSAGE.exec(path)?.groups?.messageId,
  });
  await next();
});

app.get('/health', c => c.json({ ok: true }));

app.use('/v1/*', authMiddleware);
registerConversationRoutes(app);
registerMessageRoutes(app);
registerReactionsRoutes(app);
registerTypingRoutes(app);

// Bot HTTP routes — gateway-token auth, called directly by Fly controllers.
app.use('/bot/v1/sandboxes/:sandboxId/*', botAuthMiddleware);
registerBotRoutes(app);

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  async destroySandboxData(
    sandboxId: string
  ): Promise<{ ok: boolean; conversationsDeleted: number; failedConversations: string[] }> {
    const botId = `bot:kiloclaw:${sandboxId}`;
    // Discover all conversations for this sandbox, paginating through all results.
    const allConversationIds: string[] = [];
    const PAGE_SIZE = 100;
    let offset = 0;
    while (true) {
      const page = await withDORetry(
        () => this.env.MEMBERSHIP_DO.get(this.env.MEMBERSHIP_DO.idFromName(botId)),
        stub => stub.listConversations(sandboxId, PAGE_SIZE, offset),
        'MembershipDO.listConversations'
      );
      for (const c of page.conversations) {
        allConversationIds.push(c.conversationId);
      }
      if (!page.hasMore) break;
      offset += PAGE_SIZE;
    }

    // Fan out with concurrency limit: for each conversation, clean up
    // member MembershipDOs then destroy ConversationDO.
    const limit = pLimit(10);
    const failedConversations: string[] = [];
    const results = await Promise.allSettled(
      allConversationIds.map(conversationId =>
        limit(async () => {
          const destroyed = await withDORetry(
            () => this.env.CONVERSATION_DO.get(this.env.CONVERSATION_DO.idFromName(conversationId)),
            stub => stub.destroyAndReturnMembers(),
            'ConversationDO.destroyAndReturnMembers'
          );

          if (destroyed) {
            await Promise.all(
              destroyed.members.map(member =>
                withDORetry(
                  () => this.env.MEMBERSHIP_DO.get(this.env.MEMBERSHIP_DO.idFromName(member.id)),
                  stub => stub.removeConversation(conversationId),
                  'MembershipDO.removeConversation'
                )
              )
            );
          }
        })
      )
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        logger.error('destroySandboxData: conversation cleanup failed', {
          ...formatError(result.reason),
          conversationId: allConversationIds[i],
        });
        failedConversations.push(allConversationIds[i]);
      }
    }

    // Final sweep: bulk-delete any remaining entries in the bot's MembershipDO.
    const botMembership = this.env.MEMBERSHIP_DO.get(this.env.MEMBERSHIP_DO.idFromName(botId));
    await botMembership.removeConversationsBySandbox(sandboxId);

    return {
      ok: failedConversations.length === 0,
      conversationsDeleted: allConversationIds.length - failedConversations.length,
      failedConversations,
    };
  }
}
