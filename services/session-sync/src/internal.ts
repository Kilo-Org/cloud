import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { withDORetry } from '@kilocode/worker-utils';
import { Hono } from 'hono';
import { userIDSchema } from './protocol';

import { getTenantStub } from './dos/SessionSyncTenantDO';
import type { Env } from './env';

export const internal = new Hono<{ Bindings: Env }>();

internal.post('/users/:userID/erase', async c => {
  const provided = c.req.header('X-Internal-Secret');
  if (!provided) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const binding = c.env.INTERNAL_API_SECRET_PROD;
    const expected = typeof binding === 'string' ? binding : await binding.get();
    if (
      !expected ||
      Buffer.byteLength(provided) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  } catch (error) {
    console.error('session-sync internal auth unavailable', {
      error: error instanceof Error ? error.name : typeof error,
    });
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }
  const userID = userIDSchema.safeParse(c.req.param('userID'));
  if (!userID.success) return c.json({ error: 'Invalid user ID' }, 400);
  const result = await withDORetry(
    () => getTenantStub(c.env, { type: 'user', id: userID.data }),
    async stub => await stub.eraseUser({ userID: userID.data }),
    'SessionSyncTenantDO.eraseUser'
  );
  return result.ok ? c.json({ accepted: true }, 202) : c.json({ error: result.error.code }, 503);
});
