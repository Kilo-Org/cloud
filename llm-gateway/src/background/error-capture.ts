import * as Sentry from '@sentry/cloudflare';
import { logger } from '../logger.js';

export async function captureProxyError(params: {
  errorMessage: string;
  userId: string;
  response: Response;
  organizationId: string | undefined;
  model: string;
  trackInSentry: boolean;
}): Promise<void> {
  const { errorMessage, userId, response, organizationId, model, trackInSentry } = params;

  const extraData: Record<string, string | number> = {
    kiloUserId: userId,
    model,
    status: response.status,
    statusText: response.statusText,
    responseContentType: response.headers.get('content-type') || '',
  };

  if (organizationId) {
    extraData.organizationId = organizationId;
  }

  try {
    const cloned = response.clone();
    extraData.first4kOfResponse = (await cloned.text()).slice(0, 4096);
  } catch {
    // ignore
  }

  logger.error(errorMessage, extraData);

  if (trackInSentry) {
    Sentry.captureMessage(errorMessage, {
      level: 'error',
      extra: extraData,
      tags: { source: 'llm-gateway-proxy' },
      user: { id: userId },
    });
  }
}
