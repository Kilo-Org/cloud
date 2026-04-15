/**
 * Kilo-Chat controller proxy (Fly-side).
 *
 * The plugin (running in the same Fly container) hits these routes on
 * localhost with OPENCLAW_GATEWAY_TOKEN. The controller re-sends the same
 * token upstream — it's the per-sandbox HMAC token and the kiloclaw CF
 * Worker verifies it with `deriveGatewayToken(sandboxId, secret)`. From
 * there the worker dispatches to kilo-chat via a trusted service binding.
 *
 *   Plugin ─bearer=gatewayToken──> Controller ─bearer=gatewayToken──> kiloclaw Worker
 *                                                                        │
 *                                                                        │ service binding
 *                                                                        ▼
 *                                                                    kilo-chat Worker
 *
 * No shared secret crosses the Fly→internet boundary. There's no more
 * KILOCHAT_API_TOKEN and the controller no longer sends x-kilo-sandbox-id.
 */

import type { Context, Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import { getBearerToken } from './gateway';

export type KiloChatRouteOptions = {
  /** The controller's per-sandbox gateway token. Plugin must present this. */
  expectedToken: string;
  /** Sandbox identifier. Embedded in the upstream URL path. */
  sandboxId: string;
  /** Base URL of the kiloclaw CF Worker (e.g. https://claw.kilosessions.ai). */
  kiloclawBaseUrl: string;
  fetchImpl?: typeof fetch;
};

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const MAX_SMALL_BODY_BYTES = 8 * 1024;

function guardBodySize(c: Context, limit: number): Response | null {
  const header = c.req.header('content-length');
  if (!header) return null;
  const n = Number(header);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > limit) return c.json({ error: 'Payload too large' }, 413);
  return null;
}

function authorize(c: Context, options: KiloChatRouteOptions): Response | null {
  const token = getBearerToken(c.req.header('authorization'));
  if (!token || !timingSafeTokenEqual(token, options.expectedToken)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

/** Upstream URL for a given sandbox and suffix. */
function upstreamUrl(options: KiloChatRouteOptions, suffix: string): string {
  return `${options.kiloclawBaseUrl}/api/kilo-chat/sandboxes/${encodeURIComponent(options.sandboxId)}${suffix}`;
}

/** Common outbound headers for all routes. */
function outboundHeaders(options: KiloChatRouteOptions, contentType?: string): HeadersInit {
  return {
    'content-type': contentType ?? 'application/json',
    authorization: `Bearer ${options.expectedToken}`,
  };
}

/** Pass through an upstream response verbatim (status + body + content-type). */
async function relay(upstream: Response): Promise<Response> {
  const body = await upstream.text();
  return new Response(body || null, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────

const KILO_CHAT_SEND_PATH = '/_kilo/kilo-chat/send';

export function registerKiloChatSendRoute(app: Hono, options: KiloChatRouteOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  app.post(KILO_CHAT_SEND_PATH, async c => {
    const unauthorized = authorize(c, options);
    if (unauthorized) return unauthorized;
    const oversized = guardBodySize(c, MAX_BODY_BYTES);
    if (oversized) return oversized;

    const rawBody = await c.req.text();
    const upstream = await fetchImpl(upstreamUrl(options, '/messages'), {
      method: 'POST',
      headers: outboundHeaders(options, c.req.header('content-type')),
      body: rawBody,
    });
    return relay(upstream);
  });
}

const KILO_CHAT_EDIT_PATH = '/_kilo/kilo-chat/messages/:messageId';

export function registerKiloChatEditRoute(app: Hono, options: KiloChatRouteOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  app.patch(KILO_CHAT_EDIT_PATH, async c => {
    const unauthorized = authorize(c, options);
    if (unauthorized) return unauthorized;
    const oversized = guardBodySize(c, MAX_BODY_BYTES);
    if (oversized) return oversized;

    const messageId = c.req.param('messageId');
    const rawBody = await c.req.text();
    const upstream = await fetchImpl(
      upstreamUrl(options, `/messages/${encodeURIComponent(messageId)}`),
      {
        method: 'PATCH',
        headers: outboundHeaders(options, c.req.header('content-type')),
        body: rawBody,
      }
    );
    return relay(upstream);
  });
}

export function registerKiloChatDeleteRoute(app: Hono, options: KiloChatRouteOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  app.delete(KILO_CHAT_EDIT_PATH, async c => {
    const unauthorized = authorize(c, options);
    if (unauthorized) return unauthorized;
    const oversized = guardBodySize(c, MAX_SMALL_BODY_BYTES);
    if (oversized) return oversized;

    const messageId = c.req.param('messageId');
    const rawBody = await c.req.text();
    const upstream = await fetchImpl(
      upstreamUrl(options, `/messages/${encodeURIComponent(messageId)}`),
      {
        method: 'DELETE',
        headers: outboundHeaders(options, c.req.header('content-type')),
        body: rawBody || undefined,
      }
    );
    return relay(upstream);
  });
}

const KILO_CHAT_TYPING_PATH = '/_kilo/kilo-chat/typing';

export function registerKiloChatTypingRoute(app: Hono, options: KiloChatRouteOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  app.post(KILO_CHAT_TYPING_PATH, async c => {
    const unauthorized = authorize(c, options);
    if (unauthorized) return unauthorized;
    const oversized = guardBodySize(c, MAX_SMALL_BODY_BYTES);
    if (oversized) return oversized;

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
      upstreamUrl(options, `/conversations/${encodeURIComponent(conversationId)}/typing`),
      { method: 'POST', headers: outboundHeaders(options) }
    );
    return relay(upstream);
  });
}

const KILO_CHAT_REACTIONS_PATH = '/_kilo/kilo-chat/messages/:messageId/reactions';

export function registerKiloChatReactionPostRoute(app: Hono, options: KiloChatRouteOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  app.post(KILO_CHAT_REACTIONS_PATH, async c => {
    const unauthorized = authorize(c, options);
    if (unauthorized) return unauthorized;
    const oversized = guardBodySize(c, MAX_SMALL_BODY_BYTES);
    if (oversized) return oversized;

    const messageId = c.req.param('messageId');
    const rawBody = await c.req.text();
    const upstream = await fetchImpl(
      upstreamUrl(options, `/messages/${encodeURIComponent(messageId)}/reactions`),
      {
        method: 'POST',
        headers: outboundHeaders(options, c.req.header('content-type')),
        body: rawBody,
      }
    );
    return relay(upstream);
  });
}

export function registerKiloChatReactionDeleteRoute(
  app: Hono,
  options: KiloChatRouteOptions
): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  app.delete(KILO_CHAT_REACTIONS_PATH, async c => {
    const unauthorized = authorize(c, options);
    if (unauthorized) return unauthorized;
    const oversized = guardBodySize(c, MAX_SMALL_BODY_BYTES);
    if (oversized) return oversized;

    const messageId = c.req.param('messageId');
    const rawBody = await c.req.text();
    const upstream = await fetchImpl(
      upstreamUrl(options, `/messages/${encodeURIComponent(messageId)}/reactions`),
      {
        method: 'DELETE',
        headers: outboundHeaders(options, c.req.header('content-type')),
        body: rawBody || undefined,
      }
    );
    return relay(upstream);
  });
}
