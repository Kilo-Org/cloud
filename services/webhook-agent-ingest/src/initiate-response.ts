// Ack the message — the operation succeeded or is idempotently done
export type AckAction = { action: 'ack' };

// Fail the request and ack the message — non-retriable error
export type FailAction = { action: 'fail'; errorMessage: string };

// Throw to trigger queue retry (canRetryInitiate = true)
export type RetryAction = { action: 'retry'; errorMessage: string };

// Throw to trigger queue retry (canRetryInitiate = false, generic 5xx)
export type ThrowAction = { action: 'throw'; errorMessage: string };

export type InitiateResponseAction = AckAction | FailAction | RetryAction | ThrowAction;

/**
 * Classify the response from initiateFromKilocodeSessionV2 into an action.
 *
 * Pure-ish function (only reads the response body) — no env, DO, or message side effects.
 * The caller is responsible for executing the returned action.
 */
export async function classifyInitiateResponse(
  response: Response
): Promise<InitiateResponseAction> {
  if (response.ok) {
    return { action: 'ack' };
  }

  const errorBody = await response.text();

  if (response.status === 400 && errorBody.includes('Session has already been initiated')) {
    return { action: 'ack' };
  }

  if (response.status === 409) {
    // cloud-agent-next returns 409 when execution is already in progress — treat as idempotent success
    return { action: 'ack' };
  }

  if (response.status === 402) {
    return { action: 'fail', errorMessage: errorBody || 'Insufficient balance' };
  }

  if (response.status === 503) {
    // cloud-agent-next returns 503 for retryable sandbox/workspace startup failures — trigger queue retry
    return {
      action: 'retry',
      errorMessage: `initiateFromKilocodeSessionV2 returned retryable 503: ${errorBody}`,
    };
  }

  if (response.status >= 500) {
    return {
      action: 'throw',
      errorMessage: `initiateFromKilocodeSessionV2 failed: ${response.status} - ${errorBody}`,
    };
  }

  // Other 4xx — non-retriable
  return { action: 'fail', errorMessage: errorBody };
}
