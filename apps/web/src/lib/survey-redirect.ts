import type { User } from '@kilocode/db/schema';

/**
 * If the user has not yet completed the customer-source survey,
 * wraps `destinationPath` so the user lands on the survey first,
 * then continues to `destinationPath` after completing it.
 */
export function maybeInterceptWithSurvey(
  user: Pick<User, 'customer_source'>,
  destinationPath: string
): string {
  if (user.customer_source === null && !destinationPath.startsWith('/customer-source-survey')) {
    return `/customer-source-survey?callbackPath=${encodeURIComponent(destinationPath)}`;
  }
  return destinationPath;
}
