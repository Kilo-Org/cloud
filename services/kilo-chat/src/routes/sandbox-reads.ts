import type { Context, Hono } from 'hono';
import type { AuthContext } from '../auth';
import { sandboxIdSchema, ulidSchema } from '@kilocode/kilo-chat';
import { withDORetry } from '@kilocode/worker-utils';
import { lookupSandboxOwnerUserId } from '../services/sandbox-ownership';
import { extractSandboxId } from '../services/event-push';

type HonoCtx = Context<{ Bindings: Env; Variables: AuthContext }>;

async function handleGetBotStatus(c: HonoCtx): Promise<Response> {
  const parsed = sandboxIdSchema.safeParse(c.req.param('sandboxId'));
  if (!parsed.success) return c.json({ error: 'Invalid sandboxId' }, 400);
  const sandboxId = parsed.data;

  const userId = c.get('callerId');
  const owner = await lookupSandboxOwnerUserId(c.env, sandboxId);
  if (!owner) return c.json({ error: 'sandbox_not_found' }, 404);
  if (owner !== userId) return c.json({ error: 'forbidden' }, 403);

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
  app.get('/v1/conversations/:conversationId/conversation-status', handleGetConversationStatus);
}
