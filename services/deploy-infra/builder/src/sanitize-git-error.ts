/**
 * Sanitize error messages by removing access tokens from URLs.
 * Access tokens may appear in git URLs like: https://x-access-token:TOKEN@github.com/...
 */
export function sanitizeGitError(error: unknown, accessToken: string | undefined): Error {
  if (!accessToken) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  // Replace the access token with [REDACTED] in the error message
  // Using replaceAll instead of regex to avoid issues with special characters in tokens
  const sanitizedMessage = errorMessage.replaceAll(accessToken, '[REDACTED]');

  const sanitizedError = new Error(sanitizedMessage);
  if (error instanceof Error && error.stack) {
    sanitizedError.stack = error.stack.replaceAll(accessToken, '[REDACTED]');
  }
  return sanitizedError;
}
