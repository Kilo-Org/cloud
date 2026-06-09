import { sessionIdSchema } from '@kilocode/session-ingest-contracts';
import { Hono } from 'hono';
import type { Env } from './env';
import { hasValidInternalSecret } from './internal-auth';
import { getSessionExport } from './services/session-export';

export const internalRoutes = new Hono<{ Bindings: Env }>();

internalRoutes.get('/session/:sessionId/export', async c => {
  if (!(await hasValidInternalSecret(c.req.raw, c.env))) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const kiloUserId = c.req.header('X-Kilo-User-Id');
  if (!kiloUserId) return c.json({ success: false, error: 'Missing X-Kilo-User-Id' }, 400);

  const parsed = sessionIdSchema.safeParse(c.req.param('sessionId'));
  if (!parsed.success) return c.json({ success: false, error: 'Invalid sessionId' }, 400);

  const stream = await getSessionExport(c.env, parsed.data, kiloUserId);
  if (stream === null) return c.json({ success: false, error: 'Session not found' }, 404);

  return c.body(stream, 200, { 'content-type': 'application/json; charset=utf-8' });
});
