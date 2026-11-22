/**
 * The payer balance preflight shared by prompt, command and answer admission.
 * It resolves the payer from the stored session ownership record, the same
 * source the tRPC balance middleware uses, so one session has one payer on
 * every surface. A failed read is repeated within a bound; a read that still
 * fails answers closed, is recorded once, and the caller may retry.
 */
import { TRPCError } from '@trpc/server';
import { logger } from '../logger.js';
import { requireCurrentSessionAccess } from '../session-access.js';
import type { Env } from '../types.js';
import { validateBalanceOnly, type BalanceOnlyResult } from '../balance-validation.js';

function promptPayerScopeFailure(error: unknown): BalanceOnlyResult {
  if (error instanceof TRPCError && error.code === 'FORBIDDEN') {
    return { success: false, status: 404, message: 'Cloud Agent session was not found' };
  }
  return {
    success: false,
    status: 503,
    message: 'Session access is temporarily unavailable; retry the request',
  };
}

/** The payer read is repeated within this attempt count before it reports a failure. */
const PROMPT_PAYER_SCOPE_READ_ATTEMPTS = 2;
/** Pause between attempts. */
const PROMPT_PAYER_SCOPE_RETRY_MS = 50;
/**
 * A failure slower than this may already have spent the pool's connection
 * timeout, so repeating it would double the wait before the answer. Only a fast
 * failure is repeated.
 */
const PROMPT_PAYER_SCOPE_SLOW_FAILURE_MS = 1_000;

/**
 * Reads the payer scope, repeating a quick failure within the attempt bound. A
 * slow failure and a denial are reported at once.
 */
async function readPromptPayerScope(params: {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
}): Promise<string | null> {
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = Date.now();
    try {
      const { organizationId } = await requireCurrentSessionAccess({
        env: params.env,
        kiloUserId: params.userId,
        cloudAgentSessionId: params.cloudAgentSessionId,
      });
      return organizationId;
    } catch (error) {
      if (error instanceof TRPCError && error.code === 'FORBIDDEN') throw error;
      if (attempt >= PROMPT_PAYER_SCOPE_READ_ATTEMPTS) throw error;
      if (Date.now() - startedAt >= PROMPT_PAYER_SCOPE_SLOW_FAILURE_MS) throw error;
      const wait = Promise.withResolvers<void>();
      setTimeout(wait.resolve, PROMPT_PAYER_SCOPE_RETRY_MS);
      await wait.promise;
    }
  }
}

/** Records the final failure once, with the identifiers and the underlying error text. */
function logPromptPayerScopeFailure(
  error: unknown,
  params: { userId: string; cloudAgentSessionId: string }
): void {
  const cause = error instanceof TRPCError ? error.cause : undefined;
  logger
    .withFields({
      cloudAgentSessionId: params.cloudAgentSessionId,
      userId: params.userId,
      error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause ?? error),
    })
    .warn('Prompt payer scope read failed');
}

/**
 * The payer balance preflight shared by prompt, command and answer admission.
 * It resolves the payer from the session ownership record, so one session has
 * one payer on every surface.
 */
export async function defaultValidatePromptBalance(params: {
  env: Env;
  authToken: string;
  userId: string;
  cloudAgentSessionId: string;
}): Promise<BalanceOnlyResult> {
  let organizationId: string | null;
  try {
    organizationId = await readPromptPayerScope({
      env: params.env,
      userId: params.userId,
      cloudAgentSessionId: params.cloudAgentSessionId,
    });
  } catch (error) {
    // A denial answers as a missing session and is not recorded.
    if (!(error instanceof TRPCError && error.code === 'FORBIDDEN')) {
      logPromptPayerScopeFailure(error, {
        userId: params.userId,
        cloudAgentSessionId: params.cloudAgentSessionId,
      });
    }
    return promptPayerScopeFailure(error);
  }
  return validateBalanceOnly(params.authToken, organizationId ?? undefined, params.env);
}
