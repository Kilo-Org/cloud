import { Hono } from 'hono';
import { z } from 'zod';
import { getUserConnectionDO } from './dos/UserConnectionDO';
import type { Env } from './env';
import { hasValidInternalSecret } from './internal-auth';

const internalIdentitySchema = z.string().trim().min(1).max(256);

export const internalUserEventRoutes = new Hono<{ Bindings: Env }>();

internalUserEventRoutes.get('/user/events', async c => {
  if (!(await hasValidInternalSecret(c.req.raw, c.env))) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ success: false, error: 'WebSocket upgrade required' }, 426);
  }

  const kiloUserId = internalIdentitySchema.safeParse(c.req.header('X-Kilo-User-Id'));
  const url = new URL(c.req.url);
  const connectionIds = url.searchParams.getAll('connectionId');
  const connectionId = internalIdentitySchema.safeParse(connectionIds[0]);
  if (!kiloUserId.success || connectionIds.length !== 1 || !connectionId.success) {
    return c.json({ success: false, error: 'Invalid identity or connectionId' }, 400);
  }

  const target = new URL('/web', url.origin);
  target.searchParams.set('connectionId', connectionId.data);
  const forwardedRequest = new Request(target, c.req.raw);
  forwardedRequest.headers.set('Upgrade', 'websocket');
  return getUserConnectionDO(c.env, { kiloUserId: kiloUserId.data }).fetch(forwardedRequest);
});
