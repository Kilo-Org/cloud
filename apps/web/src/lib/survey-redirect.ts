import type { User } from '@kilocode/db/schema';

/**
 * Preserves the existing call sites while the customer-source question is
 * presented non-blockingly in the authenticated app shell.
 */
export function maybeInterceptWithSurvey(
  _user: Pick<User, 'customer_source'>,
  destinationPath: string
): string {
  return destinationPath;
}
