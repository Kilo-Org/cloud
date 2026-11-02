import { createMiddleware } from 'hono/factory';
import type { Context, Next } from 'hono';
import type { HonoContext } from '../hono-context.js';
import { resolveSecret } from '../auth.js';
import { validateKiloToken } from '../validate-kilo-token.js';
import { logger } from '../logger.js';
import { buildTrpcErrorResponse } from '../trpc-error.js';
import { extractProcedureName } from '../balance-validation.js';
import { isCloudAgentManagementPath } from '../cloud-agent-child-management.js';

export const authMiddleware = createMiddleware<HonoContext>(
  async (c: Context<HonoContext>, next: Next) => {
    const authHeader = c.req.header('authorization');
    const nextAuthSecret = await resolveSecret(c.env.NEXTAUTH_SECRET);
    const pathname = new URL(c.req.url).pathname;
    const procedureName = extractProcedureName(pathname);
    const cloudAgentAuthorityAllowed =
      procedureName === 'prepareSession' ||
      (procedureName !== null && isCloudAgentManagementPath(procedureName));
    const result = await validateKiloToken(authHeader ?? null, {
      secret: nextAuthSecret,
      connectionString: c.env.HYPERDRIVE.connectionString,
      ...(cloudAgentAuthorityAllowed ? { allowCloudAgentAuthority: true } : {}),
    });

    if (!result.success) {
      logger.withFields({ error: result.error }).warn('Authentication failed');
      return buildTrpcErrorResponse(401, result.error, procedureName ?? undefined);
    }

    if (result.cloudAgentAuthority && !cloudAgentAuthorityAllowed) {
      return buildTrpcErrorResponse(403, 'Cloud Agent authority only permits scoped procedures');
    }

    c.set('userId', result.userId);
    c.set('authToken', result.token);
    if (result.cloudAgentAuthority) c.set('cloudAgentAuthority', result.cloudAgentAuthority);
    if (result.botId) {
      c.set('botId', result.botId);
    }

    await next();
  }
);
