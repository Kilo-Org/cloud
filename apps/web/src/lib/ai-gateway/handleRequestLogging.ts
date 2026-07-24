import { api_request_log, type User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { logExceptInTest } from '@/lib/utils.server';
import { after } from 'next/server';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { detectToolCallArgumentErrors } from '@/lib/ai-gateway/api-request-log-errors';
import { isDynamicallyOptedIntoRequestLogging } from '@/lib/ai-gateway/request-logging-opt-ins';
import { KILO_ORGANIZATION_ID } from '@/lib/organizations/constants';

/**
 * Handle passed to the response pipeline (see `rewriteModelResponse`) so the
 * upstream response body can be captured for request logging while the
 * response is being processed anyway. This way the event stream is only
 * processed once, instead of once for logging and once for rewriting.
 */
export type RequestLogCapture = {
  /** Record the full upstream response body. Called at most once. */
  setBody(text: string): void;
  /** Record that the upstream response body could not be read. Called at most once. */
  setReadError(error: unknown): void;
};

type CapturedResponseBody = { text: string } | { readError: string };

async function isLoggingEnabledForUser(
  user: User | null,
  organizationId: string | null
): Promise<boolean> {
  if (user?.google_user_email.endsWith('@kilo.ai')) return true;
  if (user?.google_user_email.endsWith('@kilocode.ai')) return true;
  if (organizationId === KILO_ORGANIZATION_ID) return true;
  return isDynamicallyOptedIntoRequestLogging({
    accountId: user?.id ?? null,
    organizationId,
  });
}

export async function handleRequestLogging(params: {
  status: number;
  user: User | null;
  organization_id: string | null;
  session_id: string | null;
  vercel_request_id: string | null;
  provider: string;
  model: string;
  request: GatewayRequest;
}): Promise<RequestLogCapture | null> {
  const { status, user, organization_id, session_id, vercel_request_id, provider, model, request } =
    params;
  if (!(await isLoggingEnabledForUser(user, organization_id))) {
    return null;
  }

  let resolveCaptured: (result: CapturedResponseBody) => void = () => {};
  const captured = new Promise<CapturedResponseBody>(resolve => {
    resolveCaptured = resolve;
  });
  let isSettled = false;
  const settleOnce = (result: CapturedResponseBody) => {
    if (!isSettled) {
      isSettled = true;
      resolveCaptured(result);
    }
  };

  after(async () => {
    // Wait until the response pipeline has processed the response body. This
    // resolves when the response stream completes (or fails), which happens
    // before after() callbacks are awaited.
    const result = await captured;
    const response = 'text' in result ? result.text : undefined;
    const responseReadError = 'readError' in result ? result.readError : undefined;
    if (responseReadError !== undefined) {
      logExceptInTest(
        `[handleRequestLogging] failed to read response body (user=${user?.id}, status=${status}, model=${model}): ${responseReadError}`
      );
    }
    try {
      const error =
        response !== undefined
          ? detectToolCallArgumentErrors(response, request)
          : { response_body_read_error: responseReadError };
      const apiRequestLogId = await db
        .insert(api_request_log)
        .values({
          kilo_user_id: user?.id,
          organization_id: organization_id,
          session_id,
          vercel_request_id,
          status_code: status,
          model,
          provider,
          request: request.body,
          response,
          error,
        })
        .returning({ id: api_request_log.id });
      logExceptInTest(
        '[handleRequestLogging] Inserted into api_request_log',
        apiRequestLogId[0].id
      );
    } catch (e) {
      const cause = e instanceof Error ? e.cause : undefined;
      logExceptInTest(
        `[handleRequestLogging] failed to insert api_request_log (user=${user?.id}, status=${status}, model=${model}) cause (truncated): ${String(cause).substring(0, 4000)} error (truncated): ${String(e).substring(0, 4000)}`
      );
    }
  });

  return {
    setBody: text => settleOnce({ text }),
    setReadError: error => settleOnce({ readError: String(error).substring(0, 4000) }),
  };
}
