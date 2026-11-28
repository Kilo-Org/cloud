import { createMiddleware } from 'hono/factory';
import { timingSafeEqual } from '@kilocode/encryption';
import {
  INTERNAL_CALLER_HEADER,
  callerLabel,
  observeInternalAuth,
} from '@kilocode/worker-utils/internal-auth-observation';
import { logger } from './logger';
import { readAiAttributionSecret, requestContext } from '../secrets';
import type { HonoContext } from '../ai-attribution.worker';

const ADMIN_SECRET_HEADER = 'X-Admin-Secret';

export function validateAdminSecret(
  secretHeader: string | null,
  expectedSecret: string
): { success: true } | { success: false; error: string } {
  if (!secretHeader) {
    return { success: false, error: `Missing ${ADMIN_SECRET_HEADER} header` };
  }

  if (!timingSafeEqual(secretHeader, expectedSecret)) {
    return { success: false, error: 'Invalid admin secret' };
  }

  return { success: true };
}

export const adminAuthMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const secretHeader = c.req.header(ADMIN_SECRET_HEADER);
  const expectedSecret = await readAiAttributionSecret(c.env, 'ADMIN_SECRET', requestContext(c));

  const result = validateAdminSecret(secretHeader ?? null, expectedSecret);

  if (!result.success) {
    logger.warn('Admin authentication failed', { error: result.error });
    return c.json({ success: false, error: result.error }, 401);
  }

  logger.info('Admin request authenticated');
  observeInternalAuth(
    'ai-attribution',
    'admin',
    'legacy_shared_secret',
    callerLabel(c.req.header(INTERNAL_CALLER_HEADER) ?? null)
  );

  await next();
});
