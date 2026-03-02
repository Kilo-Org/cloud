import { api_request_log } from '@kilocode/db/schema';
import type { OpenRouterChatCompletionRequest } from '@kilocode/llm-shared';
import type { WorkerDb } from '../lib/db.js';
import { logger } from '../logger.js';

const KILO_ORGANIZATION_ID = '9d278969-5453-4ae3-a51f-a8d2274a7b56';

function isKiloEmployee(userEmail: string | undefined, organizationId: string | null): boolean {
  if (organizationId === KILO_ORGANIZATION_ID) return true;
  if (!userEmail) return false;
  return userEmail.endsWith('@kilo.ai') || userEmail.endsWith('@kilocode.ai');
}

export async function handleRequestLogging(params: {
  clonedResponse: Response;
  userId: string | undefined;
  userEmail: string | undefined;
  organizationId: string | null;
  provider: string;
  model: string;
  request: OpenRouterChatCompletionRequest;
  db: WorkerDb;
}): Promise<void> {
  const { clonedResponse, userId, userEmail, organizationId, provider, model, request, db } =
    params;

  if (!isKiloEmployee(userEmail, organizationId)) {
    return;
  }

  try {
    const responseText = await clonedResponse.text();
    const result = await db
      .insert(api_request_log)
      .values({
        kilo_user_id: userId,
        organization_id: organizationId,
        status_code: clonedResponse.status,
        model,
        provider,
        request,
        response: responseText,
      })
      .returning({ id: api_request_log.id });

    logger.debug('Inserted into api_request_log', { requestLogId: String(result[0]?.id) });
  } catch (e) {
    logger.error('Failed to insert api_request_log', { error: String(e) });
  }
}
