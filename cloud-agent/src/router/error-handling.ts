import { TRPCError } from '@trpc/server';
import { SetupCommandFailedError, InvalidSessionMetadataError } from '../session-service.js';

/**
 * Translates session-related errors into appropriate tRPC errors.
 * This provides consistent error handling across all session endpoints.
 *
 * @param error - The error to translate
 * @param sessionId - Optional session ID to include in error data
 * @throws TRPCError - Always throws a translated error
 */
export function translateSessionError(error: unknown, sessionId?: string): never {
  if (error instanceof SetupCommandFailedError) {
    throw new TRPCError({
      code: 'UNPROCESSABLE_CONTENT',
      message: `Setup command failed: ${error.command} (exit code: ${error.exitCode})`,
      ...(sessionId && { data: { sessionId } }),
    });
  }

  if (error instanceof InvalidSessionMetadataError) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Session metadata is invalid or unavailable. Please re-initiate session ${error.sessionId}.`,
    });
  }

  if (error instanceof TRPCError) {
    throw error;
  }

  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: `Failed to prepare session: ${error instanceof Error ? error.message : String(error)}`,
  });
}
