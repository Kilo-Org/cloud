import { createMiddleware } from 'hono/factory';
import type { Context, Next } from 'hono';
import { TRPCError } from '@trpc/server';
import type { HonoContext } from '../hono-context.js';
import { logger } from '../logger.js';
import { buildTrpcErrorResponse } from '../trpc-error.js';
import { extractProcedureName, BALANCE_REQUIRED_MUTATIONS } from '../balance-validation.js';
import { preflightCloudAgentModelBilling } from '../model-billing-preflight.js';
import { hasInsufficientBalance, INSUFFICIENT_CREDITS_MESSAGE } from '../cloud-agent-admission.js';

function projectBillingPreflightError(error: unknown): { status: number; message: string } {
  if (!(error instanceof TRPCError)) {
    return { status: 500, message: 'Billing admission is temporarily unavailable' };
  }

  switch (error.code) {
    case 'BAD_REQUEST':
      return { status: 400, message: error.message };
    case 'FORBIDDEN':
      return { status: 403, message: error.message };
    case 'NOT_FOUND':
      return { status: 404, message: error.message };
    case 'SERVICE_UNAVAILABLE':
      return { status: 503, message: error.message };
    default:
      return { status: 500, message: 'Billing admission is temporarily unavailable' };
  }
}

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

    let body: unknown;
    try {
      const clonedRequest = c.req.raw.clone();
      body = await clonedRequest.json();
    } catch {
      return buildTrpcErrorResponse(400, 'Invalid request body', procedureName);
    }

    // Auth already validated by authMiddleware, reuse userId/token from context
    const userId = c.get('userId');
    const authToken = c.get('authToken');

    // authMiddleware runs before this, so authToken should always be set for /trpc/* routes
    if (!authToken || !userId) {
      return buildTrpcErrorResponse(401, 'Missing auth token', procedureName);
    }

    let billing;
    try {
      billing = await preflightCloudAgentModelBilling({
        env: c.env,
        userId,
        authToken,
        procedure: procedureName,
        body,
      });
    } catch (error) {
      const response = projectBillingPreflightError(error);
      return buildTrpcErrorResponse(response.status, response.message, procedureName);
    }

    if (billing.validatedSessionAccess) {
      c.set('validatedSessionAccess', billing.validatedSessionAccess);
    }

    if (billing.classification !== 'balance-required') {
      await next();
      return;
    }

    if (hasInsufficientBalance(billing)) {
      logger
        .withFields({ status: 402, procedure: procedureName })
        .warn('Pre-flight balance validation failed for V2 mutation');

      return buildTrpcErrorResponse(402, INSUFFICIENT_CREDITS_MESSAGE, procedureName);
    }

    await next();
  }
);
