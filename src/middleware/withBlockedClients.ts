import { type NextFetchEvent, NextResponse } from 'next/server';
import type { MiddlewareFactory } from '@/middleware/types';
import type { NextMiddlewareWithAuth, NextRequestWithAuth } from 'next-auth/middleware';

// These client versions had a bug that caused excessive requests.
// Block them at the middleware level so they never reach the app.
const BLOCKED_USER_AGENT_REGEX = /^kilo\/7\.0\.[0-9]+$/;
const BLOCKED_USER_AGENTS = new Set(['kilo/7.1.0', 'kilo/7.1.1', 'kilo/7.1.2', 'kilo/7.1.3']);

function isClientBlocked(userAgent: string | null): boolean {
  if (!userAgent) return false;
  return BLOCKED_USER_AGENT_REGEX.test(userAgent) || BLOCKED_USER_AGENTS.has(userAgent);
}

export const withBlockedClients: MiddlewareFactory = (nextMiddleware: NextMiddlewareWithAuth) => {
  return async (request: NextRequestWithAuth, nextFetchEvent: NextFetchEvent) => {
    if (isClientBlocked(request.headers.get('user-agent'))) {
      return NextResponse.json(
        {
          error: 'upgrade_required',
          message: 'Please upgrade your Kilo extension to the latest version.',
        },
        { status: 426 }
      );
    }
    return nextMiddleware(request, nextFetchEvent);
  };
};
