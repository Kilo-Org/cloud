import type { AssistantMessage } from '@/types/opencode.gen';

/**
 * Extract a human-readable error message from an AssistantMessage error field.
 */
function getAssistantErrorName(
  error: NonNullable<AssistantMessage['error']> | string
): string | undefined {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    return typeof error.name === 'string' ? error.name : undefined;
  }
  return undefined;
}

export function isAssistantInterruptError(
  error: NonNullable<AssistantMessage['error']> | string
): boolean {
  if (getAssistantErrorName(error) === 'MessageAbortedError') return true;
  const message = typeof error === 'string' ? error : getAssistantErrorMessage(error);
  return /messageabortederror|user[_ -]?interrupt|interrupted by the user/i.test(message);
}

export function getAssistantErrorMessage(
  error: NonNullable<AssistantMessage['error']> | string
): string {
  if (typeof error === 'string') return error;

  if ('data' in error && 'message' in error.data && typeof error.data.message === 'string') {
    return error.data.message;
  }
  return 'An error occurred while generating a response';
}
