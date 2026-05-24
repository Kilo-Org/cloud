import type { CallbackTarget, ExecutionCallbackPayload } from './types.js';
import { logger } from '../logger.js';

/** Initial callback delivery plus configured Queue redeliveries. Keep wrangler consumer max_retries in sync. */
export const CALLBACK_DELIVERY_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 60;
const DELIVERY_TIMEOUT_MS = 10_000;

function shouldRetry(status?: number): boolean {
  if (!status) return true;
  if (status === 429) return true;
  return status >= 500;
}

export type DeliveryResult =
  | { type: 'success' }
  | { type: 'retry'; delaySeconds: number }
  | { type: 'failed'; error: string };

async function deliverToTarget(
  target: CallbackTarget,
  payload: ExecutionCallbackPayload
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...target.headers,
  };

  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    logger
      .withFields({
        cloudAgentSessionId: payload.cloudAgentSessionId,
        kiloSessionId: payload.kiloSessionId,
        messageId: payload.messageId,
        status: response.status,
        ok: response.ok,
      })
      .info('Callback HTTP response received');

    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, status: response.status };
  } catch (err) {
    logger
      .withFields({
        cloudAgentSessionId: payload.cloudAgentSessionId,
        kiloSessionId: payload.kiloSessionId,
        messageId: payload.messageId,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
      .error('Callback delivery failed');
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export async function deliverCallbackJob(
  target: CallbackTarget,
  payload: ExecutionCallbackPayload,
  attempts: number
): Promise<DeliveryResult> {
  const result = await deliverToTarget(target, payload);

  if (result.ok) {
    return { type: 'success' };
  }

  if (attempts < CALLBACK_DELIVERY_MAX_ATTEMPTS && shouldRetry(result.status)) {
    const delaySeconds = BASE_BACKOFF_SECONDS * 2 ** (attempts - 1);
    logger
      .withFields({
        cloudAgentSessionId: payload.cloudAgentSessionId,
        kiloSessionId: payload.kiloSessionId,
        messageId: payload.messageId,
        attempts,
        resultType: 'retry',
        status: result.status,
        delaySeconds,
      })
      .warn('Callback delivery classified');
    return { type: 'retry', delaySeconds };
  }

  const errorMsg = result.error ?? `HTTP ${result.status}`;
  logger
    .withFields({
      cloudAgentSessionId: payload.cloudAgentSessionId,
      kiloSessionId: payload.kiloSessionId,
      messageId: payload.messageId,
      attempts,
      resultType: 'failed',
      status: result.status,
    })
    .error('Callback delivery classified');
  return {
    type: 'failed',
    error: `Callback delivery failed after ${attempts} attempts: ${errorMsg}`,
  };
}
