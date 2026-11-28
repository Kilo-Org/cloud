import type { ServiceTokensExecutionContext } from '@kilocode/service-token-client';
import { TRPCError } from '@trpc/server';
import { CLOUD_AGENT_PARENT_AUTHORITY_DENIED } from '../cloud-agent-authority.js';
import type {
  CallbackDeliveryIdentity,
  CallbackTarget,
  ExecutionCallbackPayload,
} from './types.js';
import { logger } from '../logger.js';
import { callbackAuth, type CallbackSenderAuthEnv } from './callback-auth.js';

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

/** Access and input errors cannot recover through redelivery. */
export function classifyCallbackError(
  error: unknown,
  payload: CallbackDeliveryIdentity,
  attempts: number,
  message: string,
  forcePermanent = false
): DeliveryResult {
  const permanent =
    forcePermanent ||
    (error instanceof TRPCError &&
      ['BAD_REQUEST', 'FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'PAYMENT_REQUIRED'].includes(
        error.code
      )) ||
    (error instanceof Error && error.message.includes(CLOUD_AGENT_PARENT_AUTHORITY_DENIED));
  return classifyCallbackDelivery(
    { ok: false, status: permanent ? 403 : 503, error: message },
    payload,
    attempts
  );
}

/** One delivery's outcome. `retryable` marks a refusal that redelivery can fix whatever its status. */
export type TargetResult = { ok: boolean; status?: number; error?: string; retryable?: boolean };

/**
 * The origin a 3xx answer points at, for the log. Only the origin: the path or
 * query of a redirect target can carry tokens. A missing or invalid Location
 * yields nothing.
 */
function redirectOrigin(response: Response, targetUrl: string): string | undefined {
  if (response.status < 300 || response.status >= 400) return undefined;
  const location = response.headers.get('Location');
  if (!location) return undefined;
  try {
    return new URL(location, targetUrl).origin;
  } catch {
    return undefined;
  }
}

async function deliverToTarget(
  target: CallbackTarget,
  payload: ExecutionCallbackPayload,
  headers: Record<string, string>
): Promise<TargetResult> {
  try {
    const requestInit: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      // A redirect would carry the target's headers (service credentials) to
      // another URL, so it counts as a non-2xx answer, never as a hop to follow.
      // Targets must be final https URLs; a moved host must be updated where it
      // is registered.
      redirect: 'manual',
    };
    const response = await fetch(target.url, requestInit);
    const movedTo = redirectOrigin(response, target.url);

    logger
      .withFields({
        cloudAgentSessionId: payload.cloudAgentSessionId,
        kiloSessionId: payload.kiloSessionId,
        messageId: payload.messageId,
        status: response.status,
        ok: response.ok,
        ...(movedTo === undefined ? {} : { redirectOrigin: movedTo }),
      })
      .info('Callback HTTP response received');

    if (response.ok) return { ok: true, status: response.status };
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, status: response.status, error: 'Callback target redirected' };
    }
    // A challenge refuses this Worker's credential (an expired token, a grant or receiver switch
    // not live yet), not the callback itself: redeliver it like a 5xx.
    const challenged =
      (response.status === 401 || response.status === 403) &&
      response.headers.has('www-authenticate');
    return challenged
      ? { ok: false, status: response.status, retryable: true }
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

/**
 * Delivers one execution callback with the headers `callbackAuth` resolves for its target. With no
 * credential under `sts` nothing is sent and the delivery retries like an unanswered request, so
 * a token outage or a switch fix within the retry window still delivers.
 */
export async function deliverCallbackJob(
  target: CallbackTarget,
  payload: ExecutionCallbackPayload,
  attempts: number,
  sender: { env: CallbackSenderAuthEnv; ctx?: ServiceTokensExecutionContext }
): Promise<DeliveryResult> {
  const auth = await callbackAuth(sender.env, target, sender.ctx);
  if (auth.kind === 'unavailable') {
    logger
      .withFields({
        cloudAgentSessionId: payload.cloudAgentSessionId,
        kiloSessionId: payload.kiloSessionId,
        messageId: payload.messageId,
        credentialReason: auth.reason,
        ...(auth.deniedReason === undefined ? {} : { deniedReason: auth.deniedReason }),
      })
      .error('Callback delivery has no credential');
    return classifyCallbackDelivery(
      { ok: false, error: `callback credential unavailable: ${auth.reason}` },
      payload,
      attempts
    );
  }
  const result = await deliverToTarget(target, payload, auth.headers);

  return classifyCallbackDelivery(result, payload, attempts);
}

export function classifyCallbackDelivery(
  result: TargetResult,
  payload: CallbackDeliveryIdentity,
  attempts: number
): DeliveryResult {
  if (result.ok) {
    return { type: 'success' };
  }

  if (
    attempts < CALLBACK_DELIVERY_MAX_ATTEMPTS &&
    (result.retryable === true || shouldRetry(result.status))
  ) {
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
