import type { Context } from 'hono';
import type { z } from 'zod';
import type { AuthContext } from '../auth';
import type { OkResponse } from '@kilocode/kilo-chat';
import { botStatusRequestSchema } from '@kilocode/kilo-chat';
import { formatError, withDORetry } from '@kilocode/worker-utils';
import { logger } from '../util/logger';
import { sandboxIdSchema } from '../routes/schemas';
import { extractSandboxId, pushBotStatusEvent } from './event-push';

type HonoCtx = Context<{ Bindings: Env; Variables: AuthContext }>;

export type BotStatusPayload = z.infer<typeof botStatusRequestSchema>;

export async function handleBotStatus(c: HonoCtx): Promise<Response> {
  const sandboxResult = sandboxIdSchema.safeParse(c.req.param('sandboxId'));
  if (!sandboxResult.success) {
    return c.json({ error: 'Invalid sandboxId' }, 400);
  }
  const sandboxId = sandboxResult.data;

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const parsed = botStatusRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  // When a conversationId is provided, verify it actually belongs to this sandbox.
  const conversationId = parsed.data.conversationId;
  if (conversationId) {
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
  }

  try {
    await pushBotStatusEvent(c.env, sandboxId, {
      ...parsed.data,
      sandboxId,
    });
  } catch (err) {
    logger.error('Bot status push failed', formatError(err));
    return c.json({ error: 'Bad Gateway' }, 502);
  }

  return c.json({ ok: true } satisfies OkResponse);
}
