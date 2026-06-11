import type { ClientError } from '@kilocode/worker-utils/client-error';
import type {
  SessionMessageFailureCode,
  SessionMessageFailureStage,
} from './session-message-state.js';

const NON_RETRYABLE_FAILURE_CODES = new Set<SessionMessageFailureCode>([
  'invalid_delivery_request',
  'session_metadata_missing',
  'model_missing',
  'payment_required',
  'user_interrupt',
]);

type TerminalFailureClassification = {
  failureStage?: SessionMessageFailureStage;
  failureCode?: SessionMessageFailureCode;
};

type TerminalErrorProjectionInput = TerminalFailureClassification & {
  status: 'failed' | 'interrupted';
  error?: string;
};

export function isTerminalFailureRetryable(input: TerminalFailureClassification): boolean {
  return input.failureCode === undefined || !NON_RETRYABLE_FAILURE_CODES.has(input.failureCode);
}

export function projectTerminalClientError(input: TerminalErrorProjectionInput): ClientError {
  const fallback =
    input.status === 'failed'
      ? { code: 'EXECUTION_FAILED', message: 'Execution failed' }
      : { code: 'EXECUTION_INTERRUPTED', message: 'Execution interrupted' };

  return {
    code: input.failureCode?.toUpperCase() ?? fallback.code,
    message: input.error || fallback.message,
    retryable: isTerminalFailureRetryable(input),
  };
}
