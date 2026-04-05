/**
 * Rate limiting middleware for login attempts using Cloudflare's native rate limiting API.
 * Uses hono-rate-limiter with Cloudflare RateLimit binding.
 */

import { rateLimiter } from 'hono-rate-limiter';
import type { Env } from '../types';
import { renderLoginForm } from './ui/login-form';

/**
 * Gets the client IP address from the request.
 * Uses CF-Connecting-IP header set by Cloudflare.
 */
export function getClientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

type AuthVariables = {
  workerName: string;
};

/**
 * Creates a rate limiting middleware for login attempts.
 */
export function createLoginRateLimiter() {
  return rateLimiter<{ Bindings: Env; Variables: AuthVariables }>({
    binding: c => c.env.RATE_LIMITER,
    // Key includes worker name to rate limit per-worker, not globally
    keyGenerator: c => {
      const workerName = c.get('workerName');
      const clientIp = getClientIp(c.req.raw);
      return `${workerName}:${clientIp}`;
    },
    handler: c => {
      const workerName = c.get('workerName');
      // Try to get return path from form data or query params
      const returnPath = c.req.query('return') ?? '/';

      return c.html(
        renderLoginForm({
          workerName,
          returnPath,
          error: 'Too many failed attempts. Please try again in a minute.',
        }),
        429
      );
    },
  });
}
