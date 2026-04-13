import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import { getBearerToken } from './gateway';

export type KiloChatRouteOptions = {
  expectedToken: string;
  sandboxId: string;
  apiToken: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

// Back-compat alias:
export type KiloChatSendRouteOptions = KiloChatRouteOptions;

const KILO_CHAT_SEND_PATH = '/_kilo/kilo-chat/send';

export function registerKiloChatSendRoute(app: Hono, options: KiloChatRouteOptions): void {
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

const KILO_CHAT_EDIT_PATH = '/_kilo/kilo-chat/messages/:messageId';

export function registerKiloChatEditRoute(app: Hono, options: KiloChatRouteOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  app.patch(KILO_CHAT_EDIT_PATH, async c => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!token || !timingSafeTokenEqual(token, options.expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const messageId = c.req.param('messageId');
    const rawBody = await c.req.text();

    const upstream = await fetchImpl(
      `${options.baseUrl}/v1/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: {
          'content-type': c.req.header('content-type') ?? 'application/json',
          authorization: `Bearer ${options.apiToken}`,
          'x-kilo-sandbox-id': options.sandboxId,
        },
        body: rawBody,
      }
    );

    const responseBody = await upstream.text();
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  });
}

// Placeholder — implemented in Task 5
export function registerKiloChatDeleteRoute(_app: Hono, _options: KiloChatRouteOptions): void {
  throw new Error('registerKiloChatDeleteRoute not yet implemented');
}
