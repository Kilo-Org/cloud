import { createMiddleware } from 'hono/factory';
import type { Context, Next } from 'hono';
import type { HonoContext } from '../hono-context.js';
import { logger } from '../logger.js';
import { buildTrpcErrorResponse } from '../trpc-error.js';
import {
  validateBalanceOnly,
  extractProcedureName,
  fetchOrgIdForSession,
  BALANCE_REQUIRED_MUTATIONS,
} from '../balance-validation.js';

/**
 * Middleware that validates user balance for mutations that require it.
 * Must run after authMiddleware since it relies on userId/authToken being set.
 */
export const balanceMiddleware = createMiddleware<HonoContext>(
  async (c: Context<HonoContext>, next: Next) => {
    const url = new URL(c.req.url);
    const procedureName = extractProcedureName(url.pathname);
    if (!procedureName || !BALANCE_REQUIRED_MUTATIONS.has(procedureName)) {
      await next();
      return;
    }

    const skipBalanceCheck = c.req.header('x-skip-balance-check') === 'true';

    if (skipBalanceCheck) {
      logger.withFields({ procedure: procedureName }).info('Skipping balance check per header');
      await next();
      return;
    }

    let orgId: string | undefined;
    let sessionId: string | undefined;
    try {
      const clonedRequest = c.req.raw.clone();
      const body = await clonedRequest.json();
      if (body && typeof body === 'object') {
        if ('kilocodeOrganizationId' in body && typeof body.kilocodeOrganizationId === 'string') {
          orgId = body.kilocodeOrganizationId;
        }
        if ('cloudAgentSessionId' in body && typeof body.cloudAgentSessionId === 'string') {
          sessionId = body.cloudAgentSessionId;
        }
      }
    } catch {
      return buildTrpcErrorResponse(400, 'Invalid request body', procedureName);
    }

    // Auth already validated by authMiddleware, reuse userId/token from context
    const userId = c.get('userId');
    const authToken = c.get('authToken');

    // authMiddleware runs before this, so authToken should always be set for /trpc/* routes
    if (!authToken) {
      return buildTrpcErrorResponse(401, 'Missing auth token', procedureName);
    }

    if (
      (procedureName === 'sendMessageV2' || procedureName === 'initiateFromKilocodeSessionV2') &&
      !orgId &&
      sessionId &&
      userId
    ) {
      orgId = await fetchOrgIdForSession(c.env, userId, sessionId);
    }

    // Use balance-only validation since auth was already done by authMiddleware
    const validationResult = await validateBalanceOnly(authToken, orgId, c.env);
    if (!validationResult.success) {
      logger
        .withFields({ status: validationResult.status, procedure: procedureName })
        .warn('Pre-flight balance validation failed for V2 mutation');

      return buildTrpcErrorResponse(
        validationResult.status,
        validationResult.message,
        procedureName
      );
    }

    await next();
  }
);
