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

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function authorize(c: Context, options: KiloChatRouteOptions): Response | null {
  const token = getBearerToken(c.req.header('authorization'));
  if (!token || !timingSafeTokenEqual(token, options.expectedToken)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

function upstreamUrl(options: KiloChatRouteOptions, suffix: string): string {
  return `${options.kiloclawBaseUrl}/api/kilo-chat/sandboxes/${encodeURIComponent(options.sandboxId)}${suffix}`;
}

function outboundHeaders(options: KiloChatRouteOptions, contentType?: string): HeadersInit {
  return {
    'content-type': contentType ?? 'application/json',
    authorization: `Bearer ${options.expectedToken}`,
  };
}

/**
 * Read the request body while enforcing a hard byte cap — streams the body
 * with a running counter so a missing / lying `Content-Length` (chunked
 * transfer, client omission) still can't push unbounded bytes into memory.
 */
async function readBodyWithLimit(
  c: Context,
  limit: number
): Promise<{ ok: true; body: string } | { ok: false; response: Response }> {
  // Early reject when the client is honest about an oversized body.
  const header = c.req.header('content-length');
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n) && n > limit) {
      return { ok: false, response: c.json({ error: 'Payload too large' }, 413) };
    }
  }

  const stream = c.req.raw.body;
  if (!stream) return { ok: true, body: '' };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => {});
          return { ok: false, response: c.json({ error: 'Payload too large' }, 413) };
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: new TextDecoder().decode(merged) };
}

/**
 * Pull a path parameter Hono has already matched. The route only fires when
 * the param is present, so the `??` is a type-narrowing formality.
 */
function routeParam(c: Context, name: string): string {
  return c.req.param(name) ?? '';
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

/**
 * Shared relay for routes that forward the plugin's body verbatim to the
 * kiloclaw worker. The 5 body-forwarding routes (send / edit / delete /
 * reaction add / reaction remove) are all this shape.
 */
async function relayBodyRoute(
  c: Context,
  options: KiloChatRouteOptions,
  config: {
    method: 'POST' | 'PATCH' | 'DELETE';
    upstreamSuffix: (c: Context) => string;
    bodyLimit: number;
  }
): Promise<Response> {
  const unauthorized = authorize(c, options);
  if (unauthorized) return unauthorized;

  const read = await readBodyWithLimit(c, config.bodyLimit);
  if (!read.ok) return read.response;

  const fetchImpl = options.fetchImpl ?? fetch;
  const upstream = await fetchImpl(upstreamUrl(options, config.upstreamSuffix(c)), {
    method: config.method,
    headers: outboundHeaders(options, c.req.header('content-type')),
    body: read.body || undefined,
  });
  return relay(upstream);
}

// ──────────────────────────────────────────────────────────────────────────
// Route registrations
// ──────────────────────────────────────────────────────────────────────────

export function registerKiloChatSendRoute(app: Hono, options: KiloChatRouteOptions): void {
  app.post('/_kilo/kilo-chat/send', c =>
    relayBodyRoute(c, options, {
      method: 'POST',
      upstreamSuffix: () => '/messages',
      bodyLimit: MAX_BODY_BYTES,
    })
  );
}

export function registerKiloChatEditRoute(app: Hono, options: KiloChatRouteOptions): void {
  app.patch('/_kilo/kilo-chat/messages/:messageId', c =>
    relayBodyRoute(c, options, {
      method: 'PATCH',
      upstreamSuffix: ctx => `/messages/${encodeURIComponent(routeParam(ctx, 'messageId'))}`,
      bodyLimit: MAX_BODY_BYTES,
    })
  );
}

export function registerKiloChatDeleteRoute(app: Hono, options: KiloChatRouteOptions): void {
  app.delete('/_kilo/kilo-chat/messages/:messageId', c =>
    relayBodyRoute(c, options, {
      method: 'DELETE',
      upstreamSuffix: ctx => `/messages/${encodeURIComponent(routeParam(ctx, 'messageId'))}`,
      bodyLimit: MAX_SMALL_BODY_BYTES,
    })
  );
}

export function registerKiloChatReactionPostRoute(app: Hono, options: KiloChatRouteOptions): void {
  app.post('/_kilo/kilo-chat/messages/:messageId/reactions', c =>
    relayBodyRoute(c, options, {
      method: 'POST',
      upstreamSuffix: ctx =>
        `/messages/${encodeURIComponent(routeParam(ctx, 'messageId'))}/reactions`,
      bodyLimit: MAX_SMALL_BODY_BYTES,
    })
  );
}

export function registerKiloChatReactionDeleteRoute(
  app: Hono,
  options: KiloChatRouteOptions
): void {
  app.delete('/_kilo/kilo-chat/messages/:messageId/reactions', c =>
    relayBodyRoute(c, options, {
      method: 'DELETE',
      upstreamSuffix: ctx =>
        `/messages/${encodeURIComponent(routeParam(ctx, 'messageId'))}/reactions`,
      bodyLimit: MAX_SMALL_BODY_BYTES,
    })
  );
}

/**
 * Typing is the odd route: the controller parses the body to derive the
 * upstream URL and forwards with no body of its own.
 */
export function registerKiloChatTypingRoute(app: Hono, options: KiloChatRouteOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  app.post('/_kilo/kilo-chat/typing', async c => {
    const unauthorized = authorize(c, options);
    if (unauthorized) return unauthorized;

    const read = await readBodyWithLimit(c, MAX_SMALL_BODY_BYTES);
    if (!read.ok) return read.response;

    let body: { conversationId?: unknown };
    try {
      body = JSON.parse(read.body) as { conversationId?: unknown };
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
