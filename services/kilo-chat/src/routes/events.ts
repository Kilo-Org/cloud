import type { Hono } from 'hono';
import type { AuthContext } from '../auth';

export function registerEventsRoutes(app: Hono<{ Bindings: Env; Variables: AuthContext }>): void {
  app.get('/v1/conversations/:id/events', async c => {
    const conversationId = c.req.param('id');
    const callerId = c.get('callerId');
    const lastEventId = c.req.header('last-event-id');

    const doId = c.env.CONVERSATION_DO.idFromName(conversationId);
    const stub = c.env.CONVERSATION_DO.get(doId);

    // Forward to DO's fetch handler with memberId as query param
    const url = new URL('https://do/subscribe');
    url.searchParams.set('memberId', callerId);

    const headers = new Headers();
    if (lastEventId) {
      headers.set('last-event-id', lastEventId);
    }

    return stub.fetch(url.toString(), { headers });
  });
}
