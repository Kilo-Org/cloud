import { createMiddleware } from 'hono/factory';
import type { Context, Next } from 'hono';
import { timingSafeEqual } from '@kilocode/encryption';
import type { HonoContext } from '../hono-context.js';
import type { ValidatedSessionAccess } from '../types.js';
import { logger } from '../logger.js';
import { buildTrpcErrorResponse } from '../trpc-error.js';
import {
  validateBalanceOnly,
  extractProcedureName,
  extractProcedureNames,
  extractBalanceRequestScope,
  readTrpcCalls,
  BALANCE_REQUIRED_MUTATIONS,
  type BalanceOnlyResult,
} from '../balance-validation.js';
import { projectSessionAccessHttpError, requireCurrentSessionAccess } from '../session-access.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import { withDORetry } from '../utils/do-retry.js';
import { CLOUD_AGENT_PARENT_AUTHORITY_DENIED } from '../cloud-agent-authority.js';

const SKIP_BALANCE_CHECK_HEADER = 'x-skip-balance-check';
const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';

const SESSION_SCOPED_MUTATIONS = new Set([
  'sendMessageV2',
  'initiateFromKilocodeSessionV2',
  'send',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasValidInternalApiKey(c: Context<HonoContext>): boolean {
  const provided = c.req.header(INTERNAL_API_KEY_HEADER);
  const expected = c.env.INTERNAL_API_SECRET;
  return Boolean(provided && expected && timingSafeEqual(provided, expected));
}

/**
 * Middleware that validates user balance for mutations that require it.
 * Must run after authMiddleware since it relies on userId/authToken being set.
 *
 * Balance is enforced per tRPC call, not per HTTP request. A batch can contain
 * several procedures with different organization or personal scopes, and each
 * input must be checked against the scope it will actually use.
 *
 * The client-supplied skip header is honored only for authenticated internal
 * callers presenting the internal API secret. Public requests carrying it are
 * rejected instead of being allowed to select a cheaper balance scope.
 */
export const balanceMiddleware = createMiddleware<HonoContext>(
  async (c: Context<HonoContext>, next: Next) => {
    const url = new URL(c.req.url);
    const isBatch = url.searchParams.get('batch') === '1';
    const procedures = extractProcedureNames(url.pathname, isBatch);

    if (procedures === null) {
      return buildTrpcErrorResponse(
        400,
        'Invalid request path',
        extractProcedureName(url.pathname) ?? undefined
      );
    }

    if (!procedures.some(procedure => BALANCE_REQUIRED_MUTATIONS.has(procedure))) {
      await next();
      return;
    }

    const parsed = await readTrpcCalls(c.req.raw, url);
    if (!parsed.success) {
      return buildTrpcErrorResponse(
        400,
        parsed.message,
        extractProcedureName(url.pathname) ?? undefined
      );
    }

    const balanceCalls = parsed.calls.filter(call =>
      BALANCE_REQUIRED_MUTATIONS.has(call.procedure)
    );
    const procedureLabel = balanceCalls.map(call => call.procedure).join(',');
    const skipBalanceCheck = c.req.header(SKIP_BALANCE_CHECK_HEADER) === 'true';

    if (skipBalanceCheck) {
      if (!hasValidInternalApiKey(c)) {
        logger
          .withFields({ procedure: procedureLabel })
          .warn('Rejected client-supplied balance bypass header');
        return buildTrpcErrorResponse(400, 'Balance bypass is not supported', procedureLabel);
      }

      logger
        .withFields({ procedure: procedureLabel })
        .info('Skipping balance check per internal request');
      await next();
      return;
    }

    // Auth already validated by authMiddleware, reuse userId/token from context.
    const userId = c.get('userId');
    const authToken = c.get('authToken');
    if (!authToken || !userId) {
      return buildTrpcErrorResponse(401, 'Missing auth token', procedureLabel);
    }
    const cloudAgentAuthority = c.get('cloudAgentAuthority');

    const validationCache = new Map<string, Promise<BalanceOnlyResult>>();
    const validateScope = (
      token: string,
      orgId: string | undefined,
      tokenScope: 'user' | 'parent'
    ): Promise<BalanceOnlyResult> => {
      const key = `${tokenScope}:${orgId ?? ''}`;
      const cached = validationCache.get(key);
      if (cached) return cached;
      const pending = validateBalanceOnly(token, orgId, c.env);
      validationCache.set(key, pending);
      return pending;
    };

    let validatedSessionAccess: ValidatedSessionAccess | undefined;
    let sessionAccessCount = 0;

    for (const call of balanceCalls) {
      if (!isRecord(call.input)) {
        return buildTrpcErrorResponse(400, 'Invalid request body', call.procedure);
      }

      const authority =
        cloudAgentAuthority !== undefined && call.procedure === 'sendMessageV2'
          ? cloudAgentAuthority
          : undefined;
      const scopedFollowUp = authority !== undefined;
      if (authority !== undefined && userId !== authority.ownerId) {
        return buildTrpcErrorResponse(403, 'Cloud Agent parent binding mismatch', call.procedure);
      }

      const scope = extractBalanceRequestScope(call.procedure, call.input);
      let orgId = scope.orgId;

      if (SESSION_SCOPED_MUTATIONS.has(call.procedure)) {
        if (!scope.sessionId) {
          return buildTrpcErrorResponse(400, 'Invalid request body', call.procedure);
        }

        try {
          const access = await requireCurrentSessionAccess({
            env: c.env,
            kiloUserId: userId,
            cloudAgentSessionId: scope.sessionId,
            expectedOrganizationId: authority === undefined ? orgId : authority.organizationId,
          });
          sessionAccessCount += 1;
          validatedSessionAccess = {
            kiloUserId: userId,
            cloudAgentSessionId: scope.sessionId,
            ...access,
          };
          orgId = access.organizationId ?? undefined;
        } catch (error) {
          const response = projectSessionAccessHttpError(error);
          return buildTrpcErrorResponse(response.status, await response.text(), call.procedure);
        }
      }

      let token = authToken;
      if (authority !== undefined) {
        try {
          token = await withDORetry(
            () => getSandboxSessionStub(c.env, userId, authority.parentSessionId),
            stub => stub.getCloudAgentSpawnRuntimeToken(authority),
            'getCloudAgentSpawnRuntimeToken'
          );
        } catch (error) {
          const denied =
            error instanceof Error && error.message.includes(CLOUD_AGENT_PARENT_AUTHORITY_DENIED);
          return buildTrpcErrorResponse(
            denied ? 403 : 503,
            denied
              ? 'Cloud Agent parent authorization unavailable'
              : 'Cloud Agent parent authorization is temporarily unavailable',
            call.procedure
          );
        }
        orgId = authority.organizationId ?? undefined;
      }

      const validationResult = await validateScope(
        token,
        orgId,
        scopedFollowUp ? 'parent' : 'user'
      );
      if (!validationResult.success) {
        logger
          .withFields({ status: validationResult.status, procedure: call.procedure })
          .warn('Pre-flight balance validation failed');

        return buildTrpcErrorResponse(
          validationResult.status,
          validationResult.message,
          call.procedure
        );
      }
    }

    // A batch can resolve several sessions; only a single non-batch call can
    // safely reuse one validated access record in the shared tRPC context.
    if (!parsed.isBatch && sessionAccessCount === 1 && validatedSessionAccess) {
      c.set('validatedSessionAccess', validatedSessionAccess);
    }

    await next();
  }
);
