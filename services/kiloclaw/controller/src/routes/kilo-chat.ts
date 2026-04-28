/**
 * Kilo-Chat controller proxy (Fly-side).
 *
 * The plugin (running in the same Fly container) hits these routes on
 * localhost with OPENCLAW_GATEWAY_TOKEN. The controller re-sends the same
 * token upstream — it's the per-sandbox HMAC token and the kilo-chat CF
 * Worker verifies it with `deriveGatewayToken(sandboxId, secret)`.
 *
 *   Plugin ─bearer=gatewayToken──> Controller ─bearer=gatewayToken──> kilo-chat Worker
 */

import type { Context, Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import { FetchTimeoutError, fetchWithTimeout } from '../util/fetch-with-timeout';
import { getBearerToken } from './gateway';

export type KiloChatRouteOptions = {
  /** The controller's per-sandbox gateway token. Plugin must present this. */
  expectedToken: string;
  /** Sandbox identifier. Embedded in the upstream URL path. */
  sandboxId: string;
  /** Base URL of the kilo-chat Worker (e.g. https://chat.kiloapps.io). */
  kiloChatBaseUrl: string;
  fetchImpl?: typeof fetch;
  /**
   * Upstream request timeout in milliseconds. Defaults to 30s — long enough
   * for slow kilo-chat DO RPCs but short enough to surface a 504 to the
   * plugin instead of letting it hang on an unresponsive worker.
   */
  upstreamTimeoutMs?: number;
};

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const MAX_SMALL_BODY_BYTES = 8 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

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
  return `${options.kiloChatBaseUrl}/bot/v1/sandboxes/${encodeURIComponent(options.sandboxId)}${suffix}`;
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

/** Append `?search` from the incoming request to the given suffix. */
function withSearch(c: Context, suffix: string): string {
  const { search } = new URL(c.req.url);
  return `${suffix}${search}`;
}

/** Pass through an upstream response verbatim (status + body + content-type). */
function relay(upstream: Response): Response {
  if (upstream.status === 204 || upstream.status === 205) {
    void upstream.body?.cancel().catch(() => {});
    return new Response(null, { status: upstream.status });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    },
  });
}

type RelayConfig = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  upstreamSuffix: (c: Context) => string;
  /**
   * Body handling:
   *  - `{ kind: 'none' }`: do not forward a body (GET/DELETE/no-body POST).
   *  - `{ kind: 'forward', limit }`: stream the request body up to `limit`
   *    bytes and forward it verbatim with the client's content-type.
   *  - `{ kind: 'fixed', body, contentType }`: forward a caller-supplied
   *    string body (e.g. after the route has already parsed+consumed the
   *    inbound request body for routing purposes).
   */
  body:
    | { kind: 'none' }
    | { kind: 'forward'; limit: number }
    | { kind: 'fixed'; body: string | undefined; contentType?: string };
};

/**
 * Shared `fetch upstream → relay` core. Used by `relayRoute` and by routes
 * that need to do their own preprocessing (auth + body parsing) before
 * deciding the upstream URL.
 */
async function relayRequest(
  c: Context,
  options: KiloChatRouteOptions,
  config: RelayConfig
): Promise<Response> {
  let body: string | undefined;
  let contentType: string | undefined;
  if (config.body.kind === 'forward') {
    const read = await readBodyWithLimit(c, config.body.limit);
    if (!read.ok) return read.response;
    body = read.body || undefined;
    contentType = c.req.header('content-type');
  } else if (config.body.kind === 'fixed') {
    body = config.body.body;
    contentType = config.body.contentType;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      upstreamUrl(options, config.upstreamSuffix(c)),
      {
        method: config.method,
        headers: outboundHeaders(options, contentType),
        body,
      },
      timeoutMs,
      fetchImpl
    );
  } catch (err) {
    if (err instanceof FetchTimeoutError) {
      return c.json({ error: 'Gateway Timeout' }, 504);
    }
    return c.json({ error: 'Bad Gateway' }, 502);
  }
  return relay(upstream);
}

/**
 * Shared relay for every `authorize → fetch upstream → relay` route.
 * Body-forwarding and bodyless routes share this path; the only difference
 * is whether we read the incoming body and pass a content-type header
 * through to the upstream request.
 */
async function relayRoute(
  c: Context,
  options: KiloChatRouteOptions,
  config: RelayConfig
): Promise<Response> {
  const unauthorized = authorize(c, options);
  if (unauthorized) return unauthorized;
  return relayRequest(c, options, config);
}

// ──────────────────────────────────────────────────────────────────────────
// Route registrations
// ──────────────────────────────────────────────────────────────────────────

export function registerKiloChatSendRoute(app: Hono, options: KiloChatRouteOptions): void {
  app.post('/_kilo/kilo-chat/send', c =>
    relayRoute(c, options, {
      method: 'POST',
      upstreamSuffix: () => '/messages',
      body: { kind: 'forward', limit: MAX_BODY_BYTES },
    })
  );
}

export function registerKiloChatEditRoute(app: Hono, options: KiloChatRouteOptions): void {
  app.patch('/_kilo/kilo-chat/messages/:messageId', c =>
    relayRoute(c, options, {
      method: 'PATCH',
      upstreamSuffix: ctx => `/messages/${encodeURIComponent(routeParam(ctx, 'messageId'))}`,
      body: { kind: 'forward', limit: MAX_BODY_BYTES },
    })
  );
}

export function registerKiloChatDeleteRoute(app: Hono, options: KiloChatRouteOptions): void {
  app.delete('/_kilo/kilo-chat/messages/:messageId', c =>
    relayRoute(c, options, {
      method: 'DELETE',
      upstreamSuffix: ctx =>
        withSearch(ctx, `/messages/${encodeURIComponent(routeParam(ctx, 'messageId'))}`),
      body: { kind: 'none' },
    })
  );
}

export function registerKiloChatReactionPostRoute(app: Hono, options: KiloChatRouteOptions): void {
  app.post('/_kilo/kilo-chat/messages/:messageId/reactions', c =>
    relayRoute(c, options, {
      method: 'POST',
      upstreamSuffix: ctx =>
        `/messages/${encodeURIComponent(routeParam(ctx, 'messageId'))}/reactions`,
      body: { kind: 'forward', limit: MAX_SMALL_BODY_BYTES },
    })
  );
}

export function registerKiloChatReactionDeleteRoute(
  app: Hono,
  options: KiloChatRouteOptions
): void {
  app.delete('/_kilo/kilo-chat/messages/:messageId/reactions', c =>
    relayRoute(c, options, {
      method: 'DELETE',
      upstreamSuffix: ctx =>
        withSearch(ctx, `/messages/${encodeURIComponent(routeParam(ctx, 'messageId'))}/reactions`),
      body: { kind: 'none' },
    })
  );
}

/**
 * Typing is the odd route: the controller parses the body to derive the
 * upstream URL and forwards with no body of its own.
 */
export function registerKiloChatTypingRoute(app: Hono, options: KiloChatRouteOptions): void {
  const typingRoute = (verb: '' | '/stop') => async (c: Context) => {
    const unauthorized = authorize(c, options);
    if (unauthorized) return unauthorized;

    const convId = await parseConversationId(c);
    if (typeof convId !== 'string') return convId;

    return relayRequest(c, options, {
      method: 'POST',
      upstreamSuffix: () => `/conversations/${encodeURIComponent(convId)}/typing${verb}`,
      body: { kind: 'none' },
    });
  };

  app.post('/_kilo/kilo-chat/typing', typingRoute(''));
  app.post('/_kilo/kilo-chat/typing/stop', typingRoute('/stop'));
}

export function registerKiloChatListMessagesRoute(app: Hono, options: KiloChatRouteOptions): void {
  app.get('/_kilo/kilo-chat/conversations/:conversationId/messages', c =>
    relayRoute(c, options, {
      method: 'GET',
      upstreamSuffix: ctx =>
        withSearch(
          ctx,
          `/conversations/${encodeURIComponent(routeParam(ctx, 'conversationId'))}/messages`
        ),
      body: { kind: 'none' },
    })
  );
}

export function registerKiloChatRenameRoute(app: Hono, options: KiloChatRouteOptions): void {
  app.patch('/_kilo/kilo-chat/conversations/:conversationId', c =>
    relayRoute(c, options, {
      method: 'PATCH',
      upstreamSuffix: ctx =>
        `/conversations/${encodeURIComponent(routeParam(ctx, 'conversationId'))}`,
      body: { kind: 'forward', limit: MAX_SMALL_BODY_BYTES },
    })
  );
}

export function registerKiloChatBotStatusRoute(app: Hono, options: KiloChatRouteOptions): void {
  app.post('/_kilo/kilo-chat/bot-status', c =>
    relayRoute(c, options, {
      method: 'POST',
      upstreamSuffix: () => '/bot-status',
      body: { kind: 'forward', limit: MAX_SMALL_BODY_BYTES },
    })
  );
}

export function registerKiloChatConversationStatusRoute(
  app: Hono,
  options: KiloChatRouteOptions
): void {
  app.post('/_kilo/kilo-chat/conversations/:conversationId/conversation-status', c =>
    relayRoute(c, options, {
      method: 'POST',
      upstreamSuffix: ctx =>
        `/conversations/${encodeURIComponent(routeParam(ctx, 'conversationId'))}/conversation-status`,
      body: { kind: 'forward', limit: MAX_SMALL_BODY_BYTES },
    })
  );
}

export function registerKiloChatCreateConversationRoute(
  app: Hono,
  options: KiloChatRouteOptions
): void {
  app.post('/_kilo/kilo-chat/conversations', c =>
    relayRoute(c, options, {
      method: 'POST',
      upstreamSuffix: () => '/conversations',
      body: { kind: 'forward', limit: MAX_SMALL_BODY_BYTES },
    })
  );
}

export function registerKiloChatListConversationsRoute(
  app: Hono,
  options: KiloChatRouteOptions
): void {
  app.get('/_kilo/kilo-chat/conversations', c =>
    relayRoute(c, options, {
      method: 'GET',
      upstreamSuffix: ctx => withSearch(ctx, '/conversations'),
      body: { kind: 'none' },
    })
  );
}

export function registerKiloChatGetMembersRoute(app: Hono, options: KiloChatRouteOptions): void {
  app.get('/_kilo/kilo-chat/conversations/:conversationId/members', c =>
    relayRoute(c, options, {
      method: 'GET',
      upstreamSuffix: ctx =>
        `/conversations/${encodeURIComponent(routeParam(ctx, 'conversationId'))}/members`,
      body: { kind: 'none' },
    })
  );
}

export function registerKiloChatMessageDeliveryFailedRoute(
  app: Hono,
  options: KiloChatRouteOptions
): void {
  app.post(
    '/_kilo/kilo-chat/conversations/:conversationId/messages/:messageId/delivery-failed',
    c =>
      relayRoute(c, options, {
        method: 'POST',
        upstreamSuffix: ctx =>
          `/conversations/${encodeURIComponent(
            routeParam(ctx, 'conversationId')
          )}/messages/${encodeURIComponent(routeParam(ctx, 'messageId'))}/delivery-failed`,
        body: { kind: 'forward', limit: MAX_SMALL_BODY_BYTES },
      })
  );
}

export function registerKiloChatActionDeliveryFailedRoute(
  app: Hono,
  options: KiloChatRouteOptions
): void {
  app.post('/_kilo/kilo-chat/conversations/:conversationId/actions/:groupId/delivery-failed', c =>
    relayRoute(c, options, {
      method: 'POST',
      upstreamSuffix: ctx =>
        `/conversations/${encodeURIComponent(
          routeParam(ctx, 'conversationId')
        )}/actions/${encodeURIComponent(routeParam(ctx, 'groupId'))}/delivery-failed`,
      body: { kind: 'forward', limit: MAX_SMALL_BODY_BYTES },
    })
  );
}

async function parseConversationId(c: Context): Promise<string | Response> {
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
  return conversationId;
}
