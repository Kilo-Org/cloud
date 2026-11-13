import { Hono } from 'hono';

import { authorize } from '../auth';
import { getSessionNotificationsDOStub } from '../dos/SessionNotificationsDO';
import type { Env } from '../env';
import { socketTicket } from '../live/protocol';
import { mintTicket, verifyTicket } from '../live/ticket';
import { rateLimit } from '../rate-limit';

export const notifications = new Hono<{ Bindings: Env }>();

notifications.post('/notifications/ticket', async c => {
  const principal = await authorize(c.req.raw, c.env);
  if (principal instanceof Response) return principal;
  const denied = await rateLimit(c.env.USER_REQUEST_LIMITER, principal.userID);
  if (denied) return denied;
  return c.json(await mintTicket(c.req.raw, c.env, principal, 'session-notifications', 'viewer'));
});

notifications.get('/notifications', async c => {
  const token = socketTicket(c.req.raw);
  const ticket = token ? await verifyTicket(token, c.env, 'session-notifications') : undefined;
  if (!ticket)
    return c.json(
      { error: { code: 'invalid_ticket', message: 'A notification ticket is required' } },
      401
    );
  return getSessionNotificationsDOStub(c.env, ticket.userID).fetch(c.req.raw);
});
