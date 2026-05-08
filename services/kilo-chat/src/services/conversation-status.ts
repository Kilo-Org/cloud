import type { Context } from 'hono';
import type { AuthContext } from '../auth';
import type { OkResponse } from '@kilocode/kilo-chat';
import { conversationStatusRequestSchema, sandboxIdSchema, ulidSchema } from '@kilocode/kilo-chat';
import { formatError, withDORetry } from '@kilocode/worker-utils';
import { logger } from '../util/logger';
import { extractSandboxId, pushConversationStatus } from './event-push';

type HonoCtx = Context<{ Bindings: Env; Variables: AuthContext }>;

export async function handleConversationStatus(c: HonoCtx): Promise<Response> {
  const sandboxResult = sandboxIdSchema.safeParse(c.req.param('sandboxId'));
  if (!sandboxResult.success) {
    return c.json({ error: 'Invalid sandboxId' }, 400);
  }
  const sandboxId = sandboxResult.data;

  const cvResult = ulidSchema.safeParse(c.req.param('conversationId'));
  if (!cvResult.success) {
    return c.json({ error: 'Invalid conversationId' }, 400);
  }
  const conversationId = cvResult.data;

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const parsed = conversationStatusRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  // Verify the conversation actually belongs to this sandbox (mirrors the
  // prior bot-status check before the route was split).
  const info = await withDORetry(
    () => c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId)),
    stub => stub.getInfo(),
    'ConversationDO.getInfo'
  );
  if (!info) {
    return c.json({ error: 'Unknown conversation' }, 404);
  }
  const botMember = info.members.find(m => m.kind === 'bot');
  const convSandbox = botMember ? extractSandboxId(botMember.id) : null;
  if (convSandbox !== sandboxId) {
    return c.json({ error: 'Conversation does not belong to this sandbox' }, 403);
  }

  try {
    await pushConversationStatus(c.env, sandboxId, conversationId, parsed.data);
  } catch (err) {
    logger.error('Conversation status push failed', formatError(err));
    return c.json({ error: 'Bad Gateway' }, 502);
  }

  return c.json({ ok: true } satisfies OkResponse);
}
