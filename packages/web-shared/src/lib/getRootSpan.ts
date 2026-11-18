import { getActiveSpan, getRootSpan } from '@sentry/nextjs';

export function sentryRootSpan() {
  const activeSpan = getActiveSpan();
  return activeSpan ? getRootSpan(activeSpan) : null;
}
