import { createMiddleware } from 'hono/factory';
import { resError } from '@kilocode/worker-utils';
import type { HonoContext } from '../ai-attribution.worker';

/**
 * Charges the per-organization and the per-user attribution budgets. It is mounted after
 * the bearer is verified, so both counters key on the claimed identity, and before any
 * database lookup, so the budgets bound what one caller can cost the service.
 */
export const attributionRateLimitMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  // Each key keeps its own counter because a Rate Limit binding counts per key within a
  // location.
  const [organizationOutcome, userOutcome] = await Promise.all([
    c.env.ATTRIBUTION_TRACK_ORG_RATE_LIMITER.limit({ key: c.get('organization_id') }),
    c.env.ATTRIBUTION_TRACK_USER_RATE_LIMITER.limit({ key: c.get('user_id') }),
  ]);
  if (!organizationOutcome.success || !userOutcome.success) {
    return c.json(resError('Too many attribution requests, slow down'), 429);
  }
  return next();
});
