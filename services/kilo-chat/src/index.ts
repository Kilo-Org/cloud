import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import pLimit from 'p-limit';
import { withDORetry } from '@kilocode/worker-utils';
import { cors } from 'hono/cors';
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
          const info = await withDORetry(
            () => this.env.CONVERSATION_DO.get(this.env.CONVERSATION_DO.idFromName(conversationId)),
            stub => stub.getInfo(),
            'ConversationDO.getInfo'
          );

          if (info) {
            // Remove this conversation from every member's MembershipDO.
            await Promise.all(
              info.members.map(member =>
                withDORetry(
                  () => this.env.MEMBERSHIP_DO.get(this.env.MEMBERSHIP_DO.idFromName(member.id)),
                  stub => stub.removeConversation(conversationId),
                  'MembershipDO.removeConversation'
                )
              )
            );
          }

          await withDORetry(
            () => this.env.CONVERSATION_DO.get(this.env.CONVERSATION_DO.idFromName(conversationId)),
            stub => stub.destroy(),
            'ConversationDO.destroy'
          );
        })
      )
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        console.error('destroySandboxData: conversation cleanup failed:', results[i].reason);
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
