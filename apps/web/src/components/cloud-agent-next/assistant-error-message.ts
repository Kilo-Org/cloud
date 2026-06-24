import type { AssistantMessage } from '@/types/opencode.gen';

const fallbackAssistantErrorMessage = 'An error occurred while generating a response';

/**
 * Extract a human-readable error message from an AssistantMessage error field.
 */
export function getAssistantErrorMessage(
  error: NonNullable<AssistantMessage['error']> | unknown
): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error !== 'object' || error === null) return fallbackAssistantErrorMessage;

  const data = 'data' in error ? error.data : undefined;
  if (
    typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string'
  ) {
    return data.message;
  }

  if ('message' in error && typeof error.message === 'string') return error.message;

  return fallbackAssistantErrorMessage;
}
