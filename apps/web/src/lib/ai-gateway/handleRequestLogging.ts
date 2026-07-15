import { api_request_log, type User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { logExceptInTest } from '@/lib/utils.server';
import { after } from 'next/server';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { detectToolCallArgumentErrors } from '@/lib/ai-gateway/api-request-log-errors';
import { isDynamicallyOptedIntoRequestLogging } from '@/lib/ai-gateway/request-logging-opt-ins';
import { KILO_ORGANIZATION_ID } from '@/lib/organizations/constants';

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
  clonedResponse: Response;
  user: User | null;
  organization_id: string | null;
  session_id: string | null;
  vercel_request_id: string | null;
  provider: string;
  model: string;
  request: GatewayRequest;
}) {
  const {
    clonedResponse,
    user,
    organization_id,
    session_id,
    vercel_request_id,
    provider,
    model,
    request,
  } = params;
  if (!(await isLoggingEnabledForUser(user, organization_id))) {
    return;
  }
  after(async () => {
    let response: string | undefined;
    try {
      response = await clonedResponse.text();
      const error = detectToolCallArgumentErrors(response, request);
      const apiRequestLogId = await db
        .insert(api_request_log)
        .values({
          kilo_user_id: user?.id,
          organization_id: organization_id,
          session_id,
          vercel_request_id,
          status_code: clonedResponse.status,
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
        `[handleRequestLogging] failed to insert api_request_log (user=${user?.id}, status=${clonedResponse.status}, model=${model}) cause (truncated): ${String(cause).substring(0, 4000)} error (truncated): ${String(e).substring(0, 4000)}`
      );
    }
  });
}
