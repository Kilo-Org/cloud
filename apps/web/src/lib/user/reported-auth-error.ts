import { getPostgresErrorCode } from '@/lib/db-errors';

/**
 * Replaces a sign-in error with one whose message is fixed, so no provider or
 * credential value can reach a report. The original message and properties are
 * dropped. `cause` keeps a non-sensitive discriminator: the error's SQLSTATE
 * when it has one, otherwise its class name, so a storage failure stays
 * distinguishable from another failure.
 */
export function reportedAuthError(message: string, error: unknown): Error {
  const name = error instanceof Error ? error.name : typeof error;
  const code = getPostgresErrorCode(error);
  return new Error(message, { cause: code ? { code, name } : { name } });
}
