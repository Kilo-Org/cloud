import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import { getBearerToken } from './gateway';

export type KiloChatSendRouteOptions = {
  expectedToken: string;
  sandboxId: string;
  apiToken: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

const KILO_CHAT_SEND_PATH = '/_kilo/kilo-chat/send';

export function registerKiloChatSendRoute(
  app: Hono,
  options: KiloChatSendRouteOptions
): void {
  const fetchImpl = options.fetchImpl ?? fetch;

  app.post(KILO_CHAT_SEND_PATH, async c => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!token || !timingSafeTokenEqual(token, options.expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const rawBody = await c.req.text();

    const upstream = await fetchImpl(`${options.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': c.req.header('content-type') ?? 'application/json',
        authorization: `Bearer ${options.apiToken}`,
        'x-kilo-sandbox-id': options.sandboxId,
      },
      body: rawBody,
    });

    const responseBody = await upstream.text();
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  });
}
