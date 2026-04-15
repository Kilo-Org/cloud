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

const KILO_CHAT_TYPING_PATH = '/_kilo/kilo-chat/typing';

export function registerKiloChatTypingRoute(app: Hono, options: KiloChatRouteOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  app.post(KILO_CHAT_TYPING_PATH, async c => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!token || !timingSafeTokenEqual(token, options.expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { conversationId?: unknown };
    try {
      body = (await c.req.json()) as { conversationId?: unknown };
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const conversationId = body.conversationId;
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      return c.json({ error: 'conversationId required' }, 400);
    }

    const upstream = await fetchImpl(
      `${options.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/typing`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiToken}`,
          'x-kilo-sandbox-id': options.sandboxId,
        },
      }
    );

    const responseBody = await upstream.text();
    return new Response(responseBody || null, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  });
}

const KILO_CHAT_REACTIONS_PATH = '/_kilo/kilo-chat/messages/:messageId/reactions';

export function registerKiloChatReactionPostRoute(app: Hono, options: KiloChatRouteOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  app.post(KILO_CHAT_REACTIONS_PATH, async c => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!token || !timingSafeTokenEqual(token, options.expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const messageId = c.req.param('messageId');
    const rawBody = await c.req.text();

    const upstream = await fetchImpl(
      `${options.baseUrl}/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: 'POST',
        headers: {
          'content-type': c.req.header('content-type') ?? 'application/json',
          authorization: `Bearer ${options.apiToken}`,
          'x-kilo-sandbox-id': options.sandboxId,
        },
        body: rawBody,
      }
    );

    const responseBody = await upstream.text();
    return new Response(responseBody || null, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  });
}

export function registerKiloChatReactionDeleteRoute(
  app: Hono,
  options: KiloChatRouteOptions
): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  app.delete(KILO_CHAT_REACTIONS_PATH, async c => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!token || !timingSafeTokenEqual(token, options.expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const messageId = c.req.param('messageId');
    const rawBody = await c.req.text();

    const upstream = await fetchImpl(
      `${options.baseUrl}/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: 'DELETE',
        headers: {
          'content-type': c.req.header('content-type') ?? 'application/json',
          authorization: `Bearer ${options.apiToken}`,
          'x-kilo-sandbox-id': options.sandboxId,
        },
        body: rawBody || undefined,
      }
    );

    const responseBody = await upstream.text();
    return new Response(responseBody || null, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  });
}

export function registerKiloChatDeleteRoute(app: Hono, options: KiloChatRouteOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  app.delete(KILO_CHAT_EDIT_PATH, async c => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!token || !timingSafeTokenEqual(token, options.expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const messageId = c.req.param('messageId');
    const rawBody = await c.req.text();

    const upstream = await fetchImpl(
      `${options.baseUrl}/v1/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'DELETE',
        headers: {
          'content-type': c.req.header('content-type') ?? 'application/json',
          authorization: `Bearer ${options.apiToken}`,
          'x-kilo-sandbox-id': options.sandboxId,
        },
        body: rawBody || undefined,
      }
    );

    // DELETE commonly returns 204 no content; still pass through body if any.
    const responseBody = await upstream.text();
    return new Response(responseBody || null, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  });
}
