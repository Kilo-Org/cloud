import type { Context } from 'hono';
import type { z } from 'zod';
import type { AuthContext } from '../auth';
import type { OkResponse } from '@kilocode/kilo-chat';
import { botStatusRequestSchema, sandboxIdSchema } from '@kilocode/kilo-chat';
import { formatError } from '@kilocode/worker-utils';
import { logger } from '../util/logger';
import { pushBotStatus } from './event-push';

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

  try {
    await pushBotStatus(c.env, sandboxId, parsed.data);
  } catch (err) {
    logger.error('Bot status push failed', formatError(err));
    return c.json({ error: 'Bad Gateway' }, 502);
  }

  return c.json({ ok: true } satisfies OkResponse);
}
