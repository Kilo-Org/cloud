import { createMiddleware } from 'hono/factory';
import type { Context, Next } from 'hono';
import type { HonoContext } from '../hono-context.js';
import { validateKiloToken } from '../auth.js';
import { logger } from '../logger.js';
import { buildTrpcErrorResponse } from '../trpc-error.js';
import { extractProcedureName } from '../balance-validation.js';

export const authMiddleware = createMiddleware<HonoContext>(
  async (c: Context<HonoContext>, next: Next) => {
    const authHeader = c.req.header('authorization');
    const result = validateKiloToken(authHeader ?? null, c.env.NEXTAUTH_SECRET);

    if (!result.success) {
      logger.withFields({ error: result.error }).warn('Authentication failed');
      const procedureName = extractProcedureName(new URL(c.req.url).pathname) ?? undefined;
      return buildTrpcErrorResponse(401, result.error, procedureName);
    }

    c.set('userId', result.userId);
    c.set('authToken', result.token);
    if (result.botId) {
      c.set('botId', result.botId);
    }

    await next();
  }
);
