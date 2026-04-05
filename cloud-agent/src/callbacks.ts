/**
 * Callback helper for notifying consumers when sessions complete.
 *
 * This is a platform feature - any cloud agent consumer can provide
 * a callbackUrl that gets called when the session completes or errors.
 */

import { logger } from './logger.js';

export interface CallbackPayload {
  sessionId: string;
  status: 'completed' | 'failed' | 'interrupted';
  errorMessage?: string;
  /** Gate result reported by the agent when gate_threshold is active */
  gateResult?: 'pass' | 'fail';
}

/**
 * Invoke a callback URL with the session completion payload.
 *
 * The session has already completed at this point; the callback is just
 * a notification mechanism.
 */
export async function invokeCallback(
  callbackUrl: string,
  callbackHeaders: Record<string, string> | undefined,
  payload: CallbackPayload
): Promise<void> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...callbackHeaders,
    };

    logger.info('Invoking callback', {
      callbackUrl,
      sessionId: payload.sessionId,
      status: payload.status,
    });

    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000), // 30 second timeout
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => 'Unable to read response');
      logger.warn('Callback returned non-OK status', {
        callbackUrl,
        httpStatus: response.status,
        sessionId: payload.sessionId,
        responseText: responseText.slice(0, 200),
      });
    } else {
      logger.info('Callback succeeded', {
        callbackUrl,
        sessionId: payload.sessionId,
        status: payload.status,
      });
    }
  } catch (error) {
    // Best-effort - log but don't fail the session
    logger.warn('Callback failed', {
      callbackUrl,
      sessionId: payload.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
