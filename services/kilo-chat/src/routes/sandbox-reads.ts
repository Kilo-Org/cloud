import type { Context, Hono } from 'hono';
import type { AuthContext } from '../auth';
import { sandboxIdSchema, ulidSchema } from '@kilocode/kilo-chat';
import { withDORetry } from '@kilocode/worker-utils';
import { userOwnsSandbox } from '../services/sandbox-ownership';
import { extractSandboxId } from '../services/event-push';
import { handleRequestBotStatus } from '../services/bot-status-request';

type HonoCtx = Context<{ Bindings: Env; Variables: AuthContext }>;

async function handleGetBotStatus(c: HonoCtx): Promise<Response> {
  const parsed = sandboxIdSchema.safeParse(c.req.param('sandboxId'));
  if (!parsed.success) return c.json({ error: 'Invalid sandboxId' }, 400);
  const sandboxId = parsed.data;

  const userId = c.get('callerId');
  const owns = await userOwnsSandbox(c.env, userId, sandboxId);
  if (!owns) return c.json({ error: 'forbidden' }, 403);

  const status = await withDORetry(
    () => c.env.SANDBOX_STATUS_DO.get(c.env.SANDBOX_STATUS_DO.idFromName(sandboxId)),
    stub => stub.getBotStatus(),
    'SandboxStatusDO.getBotStatus'
  );
  return c.json({ status });
}

async function handleGetConversationStatus(c: HonoCtx): Promise<Response> {
  const parsed = ulidSchema.safeParse(c.req.param('conversationId'));
  if (!parsed.success) return c.json({ error: 'Invalid conversationId' }, 400);
  const conversationId = parsed.data;
  const userId = c.get('callerId');

  const info = await withDORetry(
    () => c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId)),
    stub => stub.getInfo(),
    'ConversationDO.getInfo'
  );
  if (!info) return c.json({ error: 'conversation_not_found' }, 404);
  const isMember = info.members.some(m => m.kind === 'user' && m.id === userId);
  if (!isMember) return c.json({ error: 'forbidden' }, 403);
  const botMember = info.members.find(m => m.kind === 'bot');
  const sandboxId = botMember ? extractSandboxId(botMember.id) : null;
  if (!sandboxId) return c.json({ error: 'conversation_not_found' }, 404);

  const status = await withDORetry(
    () => c.env.SANDBOX_STATUS_DO.get(c.env.SANDBOX_STATUS_DO.idFromName(sandboxId)),
    stub => stub.getConversationStatus(conversationId),
    'SandboxStatusDO.getConversationStatus'
  );
  return c.json({ status });
}

export function registerSandboxReadRoutes(
  app: Hono<{ Bindings: Env; Variables: AuthContext }>
): void {
  app.get('/v1/sandboxes/:sandboxId/bot-status', handleGetBotStatus);
  app.post('/v1/sandboxes/:sandboxId/request-bot-status', handleRequestBotStatus);
  app.get('/v1/conversations/:conversationId/conversation-status', handleGetConversationStatus);
}
