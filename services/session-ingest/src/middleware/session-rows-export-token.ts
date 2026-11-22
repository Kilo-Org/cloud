import { timingSafeEqual } from '@kilocode/encryption';
import { createMiddleware } from 'hono/factory';

import type { Env } from '../env';

export const SESSION_ROWS_EXPORT_TOKEN_HEADER = 'X-Session-Rows-Export-Token';

/**
 * Guards the internal raw session row export with a credential of its own.
 *
 * The shared internal API secret authenticates many unrelated internal routes,
 * so it must not open this one, and this route's token must not open any other
 * route. The comparison is constant-time, and a Secrets Store read failure is
 * reported as a service failure rather than as a rejected token.
 */
export const requireSessionRowsExportToken = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const provided = c.req.header(SESSION_ROWS_EXPORT_TOKEN_HEADER);

    let expected: string;
    try {
      expected = await c.env.SESSION_ROWS_EXPORT_TOKEN.get();
    } catch (error) {
      console.error('Auth infrastructure failure', {
        operation: 'session-rows-export-token-get',
        errorClass: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return c.json({ success: false, error: 'Service temporarily unavailable' }, 503);
    }

    if (!provided || !expected || !timingSafeEqual(provided, expected)) {
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }

    return next();
  }
);
