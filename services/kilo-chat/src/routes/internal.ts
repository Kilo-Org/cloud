import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AuthContext } from '../auth';
import { logger } from '../util/logger';
import { postMessageAsUser } from '../services/post-message-as-user';

const postMessageAsUserBodySchema = z.object({
  userId: z.string().min(1),
  sandboxId: z.string().min(1),
  message: z.string().min(1),
  source: z.string().min(1).max(64),
  autoCreateConversation: z.boolean().optional(),
  correlation: z
    .object({
      triggerId: z.string().optional(),
      webhookRequestId: z.string().optional(),
      reason: z.string().optional(),
    })
    .optional(),
});

/**
 * HTTP wrapper around the `postMessageAsUser` RPC primitive, for callers
 * that don't run on Cloudflare Workers (e.g. the Next.js cloud web app).
 * Mounted under `/internal/v1/*` behind `internalApiMiddleware`.
 */
export function registerInternalRoutes(app: Hono<{ Bindings: Env; Variables: AuthContext }>) {
  app.post('/internal/v1/post-message-as-user', async c => {
    const raw = await c.req.json().catch(() => null);
    const parsed = postMessageAsUserBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ ok: false, code: 'invalid_request', error: parsed.error.message }, 400);
    }

    const result = await postMessageAsUser(
      c.env,
      { waitUntil: p => c.executionCtx.waitUntil(p) },
      parsed.data
    );

    if (result.ok) return c.json(result, 200);

    const statusFromCode: Record<typeof result.code, ContentfulStatusCode> = {
      invalid_request: 400,
      forbidden: 403,
      no_conversation: 404,
      internal: 500,
    };
    logger.warn('internal post-message-as-user failed', {
      code: result.code,
      source: parsed.data.source,
    });
    return c.json(result, statusFromCode[result.code]);
  });
}
