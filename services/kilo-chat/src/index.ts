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
import { decodeConversationCursor, type ConversationCursor } from '@kilocode/kilo-chat';
import { registerConversationRoutes } from './routes/conversations';
import {
  handleAddReaction,
  handleCreateMessage,
  handleDeleteMessage,
  handleEditMessage,
  handleExecuteAction,
  handleListMessages,
  handleRemoveReaction,
  handleSetTyping,
  handleStopTyping,
} from './routes/handler';
import { registerBotRoutes } from './routes/bot-messages';
import { registerSandboxReadRoutes } from './routes/sandbox-reads';
export { MembershipDO } from './do/membership-do';
export { ConversationDO } from './do/conversation-do';
export { SandboxStatusDO } from './do/sandbox-status-do';

const ALLOWED_ORIGINS = ['https://kilo.ai', 'https://app.kilo.ai', 'http://localhost:3000'];

const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

app.use(
  '/v1/*',
  cors({
    origin: origin => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
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
registerSandboxReadRoutes(app);

// Messages
app.post('/v1/messages', handleCreateMessage);
app.get('/v1/conversations/:conversationId/messages', handleListMessages);
app.patch('/v1/messages/:messageId', handleEditMessage);
app.delete('/v1/messages/:messageId', handleDeleteMessage);
app.post(
  '/v1/conversations/:conversationId/messages/:messageId/execute-action',
  handleExecuteAction
);

// Reactions
app.post('/v1/messages/:messageId/reactions', handleAddReaction);
app.delete('/v1/messages/:messageId/reactions', handleRemoveReaction);

// Typing
app.post('/v1/conversations/:conversationId/typing', handleSetTyping);
app.post('/v1/conversations/:conversationId/typing/stop', handleStopTyping);

// Bot HTTP routes — gateway-token auth, called directly by Fly controllers.
app.use('/bot/v1/sandboxes/:sandboxId/*', botAuthMiddleware);
registerBotRoutes(app);

export class KiloChatService extends WorkerEntrypoint<Env> {
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
    let cursor: ConversationCursor | null = null;
    while (true) {
      const page = await withDORetry(
        () => this.env.MEMBERSHIP_DO.get(this.env.MEMBERSHIP_DO.idFromName(botId)),
        stub => stub.listConversations({ sandboxId, limit: PAGE_SIZE, cursor }),
        'MembershipDO.listConversations'
      );
      for (const c of page.conversations) {
        allConversationIds.push(c.conversationId);
      }
      if (!page.hasMore || !page.nextCursor) break;
      cursor = decodeConversationCursor(page.nextCursor);
      if (!cursor) break;
    }

    // Fan out with concurrency limit: for each conversation, clean up
    // member MembershipDOs then destroy ConversationDO.
    const limit = pLimit(10);
    const failedConversations: string[] = [];
    const results = await Promise.allSettled(
      allConversationIds.map(conversationId =>
        limit(async () => {
          // Not wrapped in withDORetry: destroyAndReturnMembers mutates then
          // returns the member list, so a retry after a successful first call
          // would observe an empty DO and skip the human MembershipDO cleanup
          // below. On transport failure we let Promise.allSettled record this
          // conversation as failed so the caller can retry the whole sandbox
          // sweep (which is itself idempotent — already-destroyed DOs just
          // report no members and the final bot-membership sweep still runs).
          const stub = this.env.CONVERSATION_DO.get(
            this.env.CONVERSATION_DO.idFromName(conversationId)
          );
          const destroyed = await stub.destroyAndReturnMembers();

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

    // Wipe persisted bot + conversation status for this sandbox.
    await withDORetry(
      () => this.env.SANDBOX_STATUS_DO.get(this.env.SANDBOX_STATUS_DO.idFromName(sandboxId)),
      stub => stub.destroy(),
      'SandboxStatusDO.destroy'
    );

    return {
      ok: failedConversations.length === 0,
      conversationsDeleted: allConversationIds.length - failedConversations.length,
      failedConversations,
    };
  }
}

export default KiloChatService;
