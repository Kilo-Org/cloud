/**
 * KiloClaw - Multi-tenant OpenClaw runtimes
 *
 * Each authenticated user gets their own provider-backed runtime, managed by the
 * KiloClawInstance Durable Object. The catch-all proxy resolves routing from the
 * DO and forwards HTTP/WebSocket traffic through the active provider target.
 *
 * Auth model:
 * - User routes + catch-all proxy: JWT via authMiddleware (Bearer header or cookie)
 * - Platform routes: x-internal-api-key via internalApiMiddleware
 * - Public routes: no auth (health check only)
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';

import { chatWebhookRpcSchema } from '@kilocode/kilo-chat';
import type { AppEnv, KiloClawEnv, ChatWebhookPayload } from './types';
import type { SnapshotRestoreMessage } from './schemas/snapshot-restore';
import { accessGatewayRoutes, publicRoutes, api, kiloclaw, platform, controller } from './routes';
import { handleSnapshotRestoreQueue } from './queue/snapshot-restore';
import { redactSensitiveParams } from './utils/logging';
import { authMiddleware, internalApiMiddleware } from './auth';
import { deriveGatewayToken } from './auth/gateway-token';
import { sandboxIdFromUserId, userIdFromSandboxId } from './auth/sandbox-id';
import { InstanceIdParam } from './schemas/instance-config';
import {
  isInstanceKeyedSandboxId,
  instanceIdFromSandboxId,
  isValidInstanceId,
} from '@kilocode/worker-utils/instance-id';
import { withDORetry } from '@kilocode/worker-utils';
import { registerVersionIfNeeded } from './lib/image-version';
import { resolveDoKeyForUser } from './lib/instance-routing';
import { startingUpPage } from './pages/starting-up';
import { buildForwardHeaders } from './utils/proxy-headers';
import { KILOCLAW_ACTIVE_INSTANCE_COOKIE } from './config';
import { timingMiddleware } from './middleware/analytics';
import type { RegistryEntry } from './durable-objects/kiloclaw-registry';
import type { ProviderRoutingTarget } from './providers/types';

// Export DOs (match wrangler.jsonc class_name bindings)
export { KiloClawInstance } from './durable-objects/kiloclaw-instance';
export { KiloClawApp } from './durable-objects/kiloclaw-app';
export { KiloClawRegistry } from './durable-objects/kiloclaw-registry';

// =============================================================================
// Helpers
// =============================================================================

function transformErrorMessage(message: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return 'Gateway authentication failed. Please reconnect.';
  }
  return message;
}

/**
 * Sanitize a WebSocket close reason: transform internal error messages and
 * truncate to the 123-char WebSocket spec limit for close reasons.
 */
function sanitizeCloseReason(reason: string): string {
  let r = transformErrorMessage(reason);
  if (r.length > 123) r = r.slice(0, 120) + '...';
  return r;
}

/**
 * Transform a WebSocket message from the container before relaying to the client.
 * Rewrites JSON error payloads that leak internal gateway auth details.
 */
function transformWsMessage(data: string | ArrayBuffer): string | ArrayBuffer {
  if (typeof data !== 'string') return data;
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof (parsed as Record<string, unknown>).error === 'object' &&
      (parsed as Record<string, unknown>).error !== null
    ) {
      const error = (parsed as Record<string, Record<string, unknown>>).error;
      if (typeof error.message === 'string') {
        error.message = transformErrorMessage(error.message);
        return JSON.stringify(parsed);
      }
    }
  } catch {
    // Not JSON — pass through
  }
  return data;
}

/**
 * Safely close a WebSocket, tolerating already-closed sockets and invalid
 * close codes/reasons that the CF Workers runtime rejects.
 *
 * CloseEvent.code can be 1005 (no status), 1006 (abnormal), or 1015 (TLS failure)
 * on abnormal disconnects. These are not valid arguments to WebSocket.close().
 * We normalize to 1000 (normal) on first failure and retry so the relay still
 * tears down cleanly.
 */
function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    try {
      ws.close(1000, reason);
    } catch {
      // Already closed — nothing to do.
    }
  }
}

/**
 * Validate required environment variables.
 * Only checks auth secrets -- AI provider keys are not required at the worker
 * level since users can bring their own keys (BYOK) via encrypted secrets.
 */
function validateRequiredEnv(env: KiloClawEnv): string[] {
  const missing: string[] = [];
  if (!env.NEXTAUTH_SECRET) missing.push('NEXTAUTH_SECRET');
  if (!env.GATEWAY_TOKEN_SECRET) missing.push('GATEWAY_TOKEN_SECRET');
  return missing;
}

function missingGoogleBrokerEnv(env: KiloClawEnv): string[] {
  const missing: string[] = [];
  if (!env.GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY) {
    missing.push('GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY');
  }
  if (!env.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID) {
    missing.push('GOOGLE_WORKSPACE_OAUTH_CLIENT_ID');
  }
  if (!env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET) {
    missing.push('GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET');
  }
  return missing;
}

function routingTargetUrl(target: ProviderRoutingTarget, pathname: string, search = ''): string {
  return `${target.origin}${pathname}${search}`;
}

// =============================================================================
// Named middleware functions
// =============================================================================

async function logRequest(c: Context<AppEnv>, next: Next) {
  const url = new URL(c.req.url);
  const redactedSearch = redactSensitiveParams(url);
  console.log(`[REQ] ${c.req.method} ${url.pathname}${redactedSearch}`);
  await next();
}

/** Platform routes use internalApiMiddleware instead of JWT auth. */
function isPlatformRoute(c: Context<AppEnv>): boolean {
  const path = new URL(c.req.url).pathname;
  return path === '/api/platform' || path.startsWith('/api/platform/');
}

/** Reject early if required secrets are missing. */
async function requireEnvVars(c: Context<AppEnv>, next: Next) {
  // Platform routes need infra bindings but not AI provider keys
  if (isPlatformRoute(c)) {
    const missing: string[] = [];
    if (!c.env.KILOCLAW_INTERNAL_API_SECRET) missing.push('KILOCLAW_INTERNAL_API_SECRET');
    if (!c.env.HYPERDRIVE?.connectionString) missing.push('HYPERDRIVE');
    if (!c.env.NEXTAUTH_SECRET) missing.push('NEXTAUTH_SECRET');
    if (!c.env.GATEWAY_TOKEN_SECRET) missing.push('GATEWAY_TOKEN_SECRET');
    if (missing.length > 0) {
      console.error('[CONFIG] Platform route missing bindings:', missing.join(', '));
      return c.json(
        { error: 'Configuration error' },
        { status: 503, headers: { 'Retry-After': '5' } }
      );
    }
    return next();
  }

  const missingVars = validateRequiredEnv(c.env);
  if (missingVars.length > 0) {
    console.error('[CONFIG] Missing required environment variables:', missingVars.join(', '));
    return c.json(
      { error: 'Configuration error' },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }

  return next();
}

async function requireControllerGoogleEnvVars(c: Context<AppEnv>, next: Next) {
  const missing = missingGoogleBrokerEnv(c.env);
  if (missing.length > 0) {
    console.error('[CONFIG] Controller Google route missing bindings:', missing.join(', '));
    return c.json(
      { error: 'Configuration error' },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }
  return next();
}

/** Authenticate user via JWT (Bearer header or cookie). Skip for platform routes. */
async function authGuard(c: Context<AppEnv>, next: Next) {
  if (isPlatformRoute(c)) {
    return next();
  }
  return authMiddleware(c, next);
}

/**
 * Derive sandboxId from the authenticated userId.
 */
async function deriveSandboxId(c: Context<AppEnv>, next: Next) {
  const userId = c.get('userId');
  if (userId) {
    try {
      c.set('sandboxId', sandboxIdFromUserId(userId));
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('userId too long')) {
        return c.text('Invalid user identifier', 400);
      }
      throw err;
    }
  }
  return next();
}

// =============================================================================
// App assembly
// =============================================================================

export const app = new Hono<AppEnv>();
let didLogGoogleBrokerConfig = false;

// Global middleware (all routes)
app.use('*', timingMiddleware);
app.use('*', logRequest);

// Public routes (no auth)
app.route('/', publicRoutes);
app.route('/', accessGatewayRoutes);

// Google OAuth broker controller routes must have full broker config.
app.use('/api/controller/google', requireControllerGoogleEnvVars);
app.use('/api/controller/google/*', requireControllerGoogleEnvVars);

// Controller check-in routes (machine-to-worker, custom auth)
app.route('/api/controller', controller);

// Debug routes are removed.
app.all('/debug', c => c.notFound());
app.all('/debug/*', c => c.notFound());

// Protected middleware chain
app.use('*', requireEnvVars);
app.use('*', authGuard);
app.use('*', deriveSandboxId);

// API routes (user-facing, JWT auth)
app.route('/api', api);
app.route('/api/kiloclaw', kiloclaw);

// Platform routes (backend-to-backend, x-internal-api-key)
app.use('/api/platform/*', internalApiMiddleware);
app.route('/api/platform', platform);

// =============================================================================
// INSTANCE-ROUTED PROXY: /i/:instanceId/*
// =============================================================================

/**
 * Proxy route for instance-keyed requests.
 * Uses instanceId as the DO key. sandboxId is read from the DO status,
 * NOT derived in middleware — new instances use sandboxIdFromInstanceId.
 *
 * Access check: status.userId === authenticated userId (Option A).
 */
app.all('/i/:instanceId/*', async c => {
  const userId = c.get('userId');
  if (!userId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const rawInstanceId = c.req.param('instanceId');
  const parsed = InstanceIdParam.safeParse(rawInstanceId);
  if (!parsed.success) {
    return c.json({ error: 'Invalid instance ID' }, 400);
  }
  const instanceId = parsed.data;

  if (!c.env.GATEWAY_TOKEN_SECRET) {
    return c.json(
      { error: 'Configuration error' },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }

  const getInstanceStub = () =>
    c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(instanceId));
  const status = await withDORetry(
    getInstanceStub,
    stub => stub.getStatus(),
    'KiloClawInstance.getStatus'
  );

  // Non-existent instance (no userId stored) — return 404 to avoid
  // leaking existence info via 403 vs 404 distinction.
  if (!status.userId) {
    return c.json({ error: 'Instance not found' }, 404);
  }

  // Access check: only the assigned user can proxy to this instance
  if (status.userId !== userId) {
    return c.json({ error: 'Access denied' }, 403);
  }

  if (status.status === 'destroying') {
    return c.json({ error: 'Instance is being destroyed' }, 409);
  }
  if (status.status === 'restoring') {
    return c.json({ error: 'Instance is restoring from a snapshot' }, 409);
  }
  if (status.status === 'recovering') {
    return c.json({ error: 'Instance is recovering from an unexpected stop' }, 409);
  }
  if (!status.runtimeId) {
    return c.json({ error: 'Instance not provisioned' }, 404);
  }
  if (!status.sandboxId) {
    return c.json({ error: 'Instance has no sandboxId' }, 500);
  }

  // Strip the /i/{instanceId} prefix to get the real path
  const url = new URL(c.req.raw.url);
  const prefix = `/i/${instanceId}`;
  const strippedPath = url.pathname.slice(prefix.length) || '/';
  const routingTarget = await withDORetry(
    getInstanceStub,
    stub => stub.getRoutingTarget(),
    'KiloClawInstance.getRoutingTarget'
  );
  if (!routingTarget) {
    return c.json({ error: 'Instance not routable' }, 503);
  }
  const targetUrl = routingTargetUrl(routingTarget, strippedPath, url.search);

  const forwardHeaders = await buildForwardHeaders({
    requestHeaders: c.req.raw.headers,
    sandboxId: status.sandboxId,
    gatewayTokenSecret: c.env.GATEWAY_TOKEN_SECRET,
    providerHeaders: routingTarget.headers,
  });

  console.log(
    '[PROXY /i] Handling request:',
    strippedPath,
    'instance:',
    instanceId,
    'runtime:',
    status.runtimeId
  );

  const isWebSocketRequest = c.req.raw.headers.get('Upgrade')?.toLowerCase() === 'websocket';

  if (isWebSocketRequest) {
    let containerResponse: Response;
    try {
      containerResponse = await fetch(targetUrl, { headers: forwardHeaders });
    } catch (err) {
      console.error('[PROXY /i] Fly Proxy fetch failed:', err);
      return c.json(
        { error: 'Instance not reachable' },
        { status: 503, headers: { 'Retry-After': '5' } }
      );
    }

    if (containerResponse.status === 502) {
      return c.json(
        { error: 'Instance is starting up' },
        { status: 503, headers: { 'Retry-After': '5' } }
      );
    }

    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      return containerResponse;
    }

    const [clientWs, serverWs] = Object.values(new WebSocketPair());
    serverWs.accept();
    containerWs.accept();

    let droppedToContainer = 0;
    let droppedToClient = 0;

    serverWs.addEventListener('message', event => {
      if (containerWs.readyState === WebSocket.OPEN) {
        containerWs.send(event.data as string | ArrayBuffer);
      } else {
        droppedToContainer++;
        if (droppedToContainer === 1) {
          console.warn(
            '[WS /i] First dropped client->container message (readyState:',
            containerWs.readyState,
            ')'
          );
        }
      }
    });
    containerWs.addEventListener('message', event => {
      const data = transformWsMessage(event.data as string | ArrayBuffer);
      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(data);
      } else {
        droppedToClient++;
        if (droppedToClient === 1) {
          console.warn(
            '[WS /i] First dropped container->client message (readyState:',
            serverWs.readyState,
            ')'
          );
        }
      }
    });

    const logDropSummary = () => {
      const totalDropped = droppedToClient + droppedToContainer;
      if (totalDropped > 0) {
        console.warn(
          '[WS /i] Connection closed with',
          totalDropped,
          'dropped messages (toClient:',
          droppedToClient,
          'toContainer:',
          droppedToContainer,
          ')'
        );
      }
    };

    serverWs.addEventListener('close', event => {
      logDropSummary();
      safeClose(containerWs, event.code, event.reason);
    });
    containerWs.addEventListener('close', event => {
      logDropSummary();
      safeClose(serverWs, event.code, sanitizeCloseReason(event.reason));
    });
    serverWs.addEventListener('error', () => safeClose(containerWs, 1011, 'Client error'));
    containerWs.addEventListener('error', () => safeClose(serverWs, 1011, 'Container error'));

    return new Response(null, { status: 101, webSocket: clientWs });
  }

  // HTTP proxy
  const requestBody = c.req.raw.body ? await c.req.raw.arrayBuffer() : null;
  try {
    const httpResponse = await fetch(targetUrl, {
      method: c.req.raw.method,
      headers: forwardHeaders,
      body: requestBody,
    });
    if (httpResponse.status === 502) {
      return startingUpPage();
    }
    return httpResponse;
  } catch (err) {
    console.error('[PROXY /i] HTTP fetch failed:', err);
    return c.json(
      { error: 'Instance not reachable' },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }
});

// =============================================================================
// CATCH-ALL: Proxy to per-user OpenClaw gateway via Fly Proxy
// =============================================================================

/**
 * Resolve the user's default personal instance DO stub via the registry.
 * Returns the stub and its DO key, or null if no instance exists.
 * Triggers lazy migration on first access.
 *
 * Falls back to legacy direct userId-keyed DO lookup if the Registry DO
 * is unavailable (e.g., migration error, transient failure). This ensures
 * proxy access is preserved even when the registry is unhealthy.
 */
async function resolveRegistryEntry(c: Context<AppEnv>) {
  const userId = c.get('userId');
  if (!userId) return null;

  try {
    const registryKey = `user:${userId}`;
    const entries = await withDORetry(
      () => c.env.KILOCLAW_REGISTRY.get(c.env.KILOCLAW_REGISTRY.idFromName(registryKey)),
      stub => stub.listInstances(registryKey),
      'KiloClawRegistry.listInstances'
    );
    if (entries.length === 0) return null;

    const entry = entries[0];
    const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(entry.doKey));
    return { stub, entry };
  } catch (err) {
    console.error(
      '[PROXY] Registry lookup failed, falling back to Postgres-backed DO lookup:',
      err
    );
    const fallbackDoKey =
      (await resolveDoKeyForUser(c.env.HYPERDRIVE?.connectionString, userId).catch(fallbackErr => {
        console.error(
          '[PROXY] Postgres-backed DO lookup failed, falling back to userId:',
          fallbackErr
        );
        return null;
      })) ?? userId;
    const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(fallbackDoKey));
    const fallbackEntry: RegistryEntry = {
      doKey: fallbackDoKey,
      instanceId: '',
      assignedUserId: userId,
      createdAt: '',
      destroyedAt: null,
    };
    return { stub, entry: fallbackEntry };
  }
}

/**
 * Resolve the active provider runtime id, sandboxId, and status for the current user from their DO.
 * Returns null runtimeId if the instance is destroying (blocks proxy during teardown).
 * Routes through the user registry, which triggers lazy migration on first access.
 *
 * The returned sandboxId is the DO's authoritative value — it may differ from the
 * middleware-derived `c.get('sandboxId')` for instance-keyed DOs (which use `ki_` prefix).
 * Callers MUST use the returned sandboxId for gateway token derivation.
 */
async function resolveInstance(c: Context<AppEnv>): Promise<{
  doKey: string | null;
  runtimeId: string | null;
  sandboxId: string | null;
  status: string | null;
}> {
  const resolved = await resolveRegistryEntry(c);
  if (!resolved) return { doKey: null, runtimeId: null, sandboxId: null, status: null };

  const { entry } = resolved;
  const getStub = () =>
    c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(entry.doKey));
  const s = await withDORetry(getStub, stub => stub.getStatus(), 'KiloClawInstance.getStatus');

  if (s.status === 'destroying')
    return { doKey: entry.doKey, runtimeId: null, sandboxId: null, status: 'destroying' };
  if (s.status === 'restoring')
    return { doKey: entry.doKey, runtimeId: null, sandboxId: null, status: 'restoring' };
  if (s.status === 'recovering')
    return { doKey: entry.doKey, runtimeId: null, sandboxId: null, status: 'recovering' };

  return {
    doKey: entry.doKey,
    runtimeId: s.runtimeId,
    sandboxId: s.sandboxId,
    status: s.status,
  };
}

app.all('*', async c => {
  // Auth gate: middleware-derived sandboxId proves the user is authenticated.
  if (!c.get('sandboxId')) {
    return c.json(
      { error: 'Authentication required', hint: 'No active session. Please log in.' },
      401
    );
  }

  // Cookie-based instance routing: when the user opened an instance-keyed
  // instance via the access gateway, the active-instance cookie is set.
  // The OpenClaw Control UI connects WebSockets to `/` (not `/i/{instanceId}/`),
  // so this cookie tells the catch-all which instance to route to.
  const activeInstanceId = getCookie(c, KILOCLAW_ACTIVE_INSTANCE_COOKIE);
  if (activeInstanceId && isValidInstanceId(activeInstanceId)) {
    const userId = c.get('userId');
    if (userId) {
      const getCookieStub = () =>
        c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(activeInstanceId));
      const instanceStatus = await withDORetry(
        getCookieStub,
        stub => stub.getStatus(),
        'KiloClawInstance.getStatus'
      );

      // Ownership mismatch — cookie is stale (e.g. from another user session).
      // Fall through to default personal resolution.
      if (instanceStatus.userId !== userId) {
        // Clear the stale cookie so subsequent requests don't repeat this check
        deleteCookie(c, KILOCLAW_ACTIVE_INSTANCE_COOKIE);
      } else {
        // Cookie points to an instance owned by this user. Return explicit errors
        // for non-proxyable states instead of silently falling through to the
        // personal instance.
        if (instanceStatus.status === 'destroying') {
          return c.json(
            { error: 'Instance is being destroyed', hint: 'This instance is being torn down.' },
            409
          );
        }
        if (instanceStatus.status === 'restoring') {
          return c.json(
            {
              error: 'Instance is restoring',
              hint: 'This instance is being restored from a snapshot. Please wait.',
            },
            409
          );
        }
        if (instanceStatus.status === 'recovering') {
          return c.json(
            {
              error: 'Instance is recovering',
              hint: 'This instance is being recovered after an unexpected stop. Please wait.',
            },
            409
          );
        }
        if (!instanceStatus.runtimeId) {
          return c.json(
            { error: 'Instance not provisioned', hint: 'The instance has no running machine.' },
            404
          );
        }

        const routingTarget = await withDORetry(
          getCookieStub,
          stub => stub.getRoutingTarget(),
          'KiloClawInstance.getRoutingTarget'
        );
        if (!routingTarget) {
          return c.json(
            { error: 'Instance not routable' },
            { status: 503, headers: { 'Retry-After': '5' } }
          );
        }
        if (instanceStatus.sandboxId) {
          console.log(
            '[PROXY] Cookie-routed to instance:',
            activeInstanceId,
            'runtime:',
            instanceStatus.runtimeId
          );
          const request = c.req.raw;
          const url = new URL(request.url);
          const targetUrl = routingTargetUrl(routingTarget, url.pathname, url.search);

          if (!c.env.GATEWAY_TOKEN_SECRET) {
            return c.json(
              { error: 'Configuration error' },
              { status: 503, headers: { 'Retry-After': '5' } }
            );
          }

          const forwardHeaders = await buildForwardHeaders({
            requestHeaders: request.headers,
            sandboxId: instanceStatus.sandboxId,
            gatewayTokenSecret: c.env.GATEWAY_TOKEN_SECRET,
            providerHeaders: routingTarget.headers,
          });

          const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

          if (isWebSocketRequest) {
            let containerResponse: Response;
            try {
              containerResponse = await fetch(targetUrl, { headers: forwardHeaders });
            } catch (err) {
              console.error('[PROXY] Cookie-routed WS fetch failed:', err);
              return c.json(
                { error: 'Instance not reachable' },
                { status: 503, headers: { 'Retry-After': '5' } }
              );
            }

            if (containerResponse.status === 502) {
              return c.json(
                { error: 'Instance is starting up' },
                { status: 503, headers: { 'Retry-After': '5' } }
              );
            }

            const containerWs = containerResponse.webSocket;
            if (!containerWs) {
              return c.json({ error: 'WebSocket upgrade failed' }, 502);
            }
            containerWs.accept();
            const [clientWs, serverWs] = Object.values(new WebSocketPair());
            serverWs.accept();

            let cookieDroppedToContainer = 0;
            let cookieDroppedToClient = 0;

            serverWs.addEventListener('message', event => {
              if (containerWs.readyState === WebSocket.OPEN) {
                containerWs.send(event.data as string | ArrayBuffer);
              } else {
                cookieDroppedToContainer++;
                if (cookieDroppedToContainer === 1) {
                  console.warn(
                    '[WS cookie] First dropped client->container message (readyState:',
                    containerWs.readyState,
                    ')'
                  );
                }
              }
            });
            containerWs.addEventListener('message', event => {
              const data = transformWsMessage(event.data as string | ArrayBuffer);
              if (serverWs.readyState === WebSocket.OPEN) {
                serverWs.send(data);
              } else {
                cookieDroppedToClient++;
                if (cookieDroppedToClient === 1) {
                  console.warn(
                    '[WS cookie] First dropped container->client message (readyState:',
                    serverWs.readyState,
                    ')'
                  );
                }
              }
            });

            const logCookieDropSummary = () => {
              const totalDropped = cookieDroppedToClient + cookieDroppedToContainer;
              if (totalDropped > 0) {
                console.warn(
                  '[WS cookie] Connection closed with',
                  totalDropped,
                  'dropped messages (toClient:',
                  cookieDroppedToClient,
                  'toContainer:',
                  cookieDroppedToContainer,
                  ')'
                );
              }
            };

            serverWs.addEventListener('close', event => {
              logCookieDropSummary();
              safeClose(containerWs, event.code, event.reason);
            });
            containerWs.addEventListener('close', event => {
              logCookieDropSummary();
              safeClose(serverWs, event.code, sanitizeCloseReason(event.reason));
            });
            serverWs.addEventListener('error', () => safeClose(containerWs, 1011, 'Client error'));
            containerWs.addEventListener('error', () =>
              safeClose(serverWs, 1011, 'Container error')
            );
            return new Response(null, { status: 101, webSocket: clientWs });
          }

          // HTTP proxy
          const requestBody = request.body ? await request.arrayBuffer() : null;
          try {
            const httpResponse = await fetch(targetUrl, {
              method: request.method,
              headers: forwardHeaders,
              body: requestBody,
            });
            if (httpResponse.status === 502) {
              return startingUpPage();
            }
            return httpResponse;
          } catch (err) {
            console.error('[PROXY] Cookie-routed HTTP fetch failed:', err);
            return c.json(
              { error: 'Instance not reachable' },
              { status: 503, headers: { 'Retry-After': '5' } }
            );
          }
        }
      }
    }
    // Cookie invalid/stale — fall through to default personal resolution
  }

  const { doKey: resolvedDoKey, runtimeId, sandboxId, status } = await resolveInstance(c);
  if (status === 'destroying') {
    return c.json(
      { error: 'Instance is being destroyed', hint: 'This instance is being torn down.' },
      409
    );
  }
  if (status === 'restoring') {
    return c.json(
      {
        error: 'Instance is restoring',
        hint: 'This instance is being restored from a snapshot. Please wait.',
      },
      409
    );
  }
  if (status === 'recovering') {
    return c.json(
      {
        error: 'Instance is recovering',
        hint: 'Your instance is being recovered after an unexpected stop. Please wait.',
      },
      409
    );
  }
  if (!runtimeId) {
    return c.json(
      {
        error: 'Instance not provisioned',
        hint: 'Your instance has not been created yet. Start it from the dashboard.',
      },
      404
    );
  }
  if (!sandboxId) {
    return c.json({ error: 'Instance has no sandboxId' }, 500);
  }

  if (!resolvedDoKey) {
    return c.json(
      { error: 'Instance not routable' },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }

  const request = c.req.raw;
  const url = new URL(request.url);
  const getResolvedStub = () =>
    c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(resolvedDoKey));
  const routingTarget = await withDORetry(
    getResolvedStub,
    stub => stub.getRoutingTarget(),
    'KiloClawInstance.getRoutingTarget'
  );
  if (!routingTarget) {
    return c.json({ error: 'Instance not routable' }, 503);
  }
  const targetUrl = routingTargetUrl(routingTarget, url.pathname, url.search);

  console.log('[PROXY] Handling request:', url.pathname, 'runtime:', runtimeId);

  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

  if (!c.env.GATEWAY_TOKEN_SECRET) {
    console.error('[CONFIG] Missing required environment variables: GATEWAY_TOKEN_SECRET');
    return c.json(
      { error: 'Configuration error' },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }

  // Use the DO's authoritative sandboxId for gateway token derivation.
  // This is critical: instance-keyed DOs derive sandboxId from instanceId (ki_ prefix),
  // which differs from the middleware-derived value (sandboxIdFromUserId). The gateway
  // token must match what the machine expects.
  const forwardHeaders = await buildForwardHeaders({
    requestHeaders: request.headers,
    sandboxId,
    gatewayTokenSecret: c.env.GATEWAY_TOKEN_SECRET,
    providerHeaders: routingTarget.headers,
  });

  // WebSocket proxy
  if (isWebSocketRequest) {
    console.log('[WS] Proxying WebSocket connection to OpenClaw via Fly Proxy');

    let containerResponse: Response;
    try {
      containerResponse = await fetch(targetUrl, {
        headers: forwardHeaders,
      });
    } catch (err) {
      console.error('[WS] Fly Proxy fetch failed:', err);
      return c.json(
        {
          error: 'Instance not reachable',
          hint: 'Your instance may not be running. Start it from the dashboard.',
        },
        { status: 503, headers: { 'Retry-After': '5' } }
      );
    }
    console.log('[WS] Fly Proxy response status:', containerResponse.status);

    // Gateway not ready yet — return a clear JSON error for WebSocket clients
    if (containerResponse.status === 502) {
      return c.json(
        {
          error: 'Instance is starting up',
          hint: 'The gateway process is still initializing. Please retry shortly.',
        },
        { status: 503, headers: { 'Retry-After': '5' } }
      );
    }

    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      console.error('[WS] No WebSocket in response - returning direct response');
      return containerResponse;
    }

    const [clientWs, serverWs] = Object.values(new WebSocketPair());

    serverWs.accept();
    containerWs.accept();

    let catchAllDroppedToContainer = 0;
    let catchAllDroppedToClient = 0;

    // Client -> Container relay
    serverWs.addEventListener('message', event => {
      if (containerWs.readyState === WebSocket.OPEN) {
        containerWs.send(event.data as string | ArrayBuffer);
      } else {
        catchAllDroppedToContainer++;
        if (catchAllDroppedToContainer === 1) {
          console.warn(
            '[WS] First dropped client->container message (readyState:',
            containerWs.readyState,
            ')'
          );
        }
      }
    });

    // Container -> Client relay with error transformation
    containerWs.addEventListener('message', event => {
      const data = transformWsMessage(event.data as string | ArrayBuffer);
      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(data);
      } else {
        catchAllDroppedToClient++;
        if (catchAllDroppedToClient === 1) {
          console.warn(
            '[WS] First dropped container->client message (readyState:',
            serverWs.readyState,
            ')'
          );
        }
      }
    });

    const logCatchAllDropSummary = () => {
      const totalDropped = catchAllDroppedToClient + catchAllDroppedToContainer;
      if (totalDropped > 0) {
        console.warn(
          '[WS] Connection closed with',
          totalDropped,
          'dropped messages (toClient:',
          catchAllDroppedToClient,
          'toContainer:',
          catchAllDroppedToContainer,
          ')'
        );
      }
    };

    // Close relay
    serverWs.addEventListener('close', event => {
      logCatchAllDropSummary();
      safeClose(containerWs, event.code, event.reason);
    });

    containerWs.addEventListener('close', event => {
      logCatchAllDropSummary();
      safeClose(serverWs, event.code, sanitizeCloseReason(event.reason));
    });

    // Error relay
    serverWs.addEventListener('error', event => {
      console.error('[WS] Client error:', event);
      safeClose(containerWs, 1011, 'Client error');
    });

    containerWs.addEventListener('error', event => {
      console.error('[WS] Container error:', event);
      safeClose(serverWs, 1011, 'Container error');
    });

    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    });
  }

  // HTTP proxy
  // Buffer body upfront so it can be replayed on crash-recovery retry (streams are one-shot).
  const requestBody = request.body ? await request.arrayBuffer() : null;
  console.log('[HTTP] Proxying:', url.pathname + url.search);
  let httpResponse: Response;
  try {
    httpResponse = await fetch(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: requestBody,
    });
  } catch (err) {
    console.error('[HTTP] Fly Proxy fetch failed:', err);
    return c.json(
      {
        error: 'Instance not reachable',
        hint: 'Your instance may not be running. Start it from the dashboard.',
      },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }
  console.log('[HTTP] Response status:', httpResponse.status);

  // Gateway not ready yet — show friendly "starting up" page instead of raw 502
  if (httpResponse.status === 502) {
    return startingUpPage();
  }

  return httpResponse;
});

export default class extends WorkerEntrypoint<KiloClawEnv> {
  fetch(request: Request) {
    if (!didLogGoogleBrokerConfig) {
      const missing = missingGoogleBrokerEnv(this.env);
      if (missing.length > 0) {
        console.warn('[CONFIG] Google OAuth broker env incomplete:', missing.join(', '));
      } else {
        console.log('[CONFIG] Google OAuth broker env ready');
      }
      didLogGoogleBrokerConfig = true;
    }

    // Self-register the current OpenClaw version in KV on deploy.
    // Runs after the response is sent. If the very first request after deploy
    // is a provision(), the KV write races with resolveLatestVersion() —
    // provision may see the previous latest (or null) and fall back to
    // FLY_IMAGE_TAG, which is already correct for the new deploy. This is benign.
    if (this.env.OPENCLAW_VERSION && this.env.FLY_IMAGE_TAG) {
      this.ctx.waitUntil(
        registerVersionIfNeeded(
          this.env.KV_CLAW_CACHE,
          this.env.OPENCLAW_VERSION,
          'default', // variant hardcoded day 1
          this.env.FLY_IMAGE_TAG,
          this.env.FLY_IMAGE_DIGEST ?? null,
          this.env.HYPERDRIVE?.connectionString
        )
      );
    }

    return app.fetch(request, this.env, this.ctx);
  }

  async queue(batch: MessageBatch<SnapshotRestoreMessage>): Promise<void> {
    await handleSnapshotRestoreQueue(batch, this.env);
  }

  /**
   * RPC method called by kilo-chat service via service binding.
   * Routes the webhook payload to the correct kiloclaw Fly machine
   * based on the targetBotId (bot:kiloclaw:{sandboxId}).
   *
   * See resolveChatWebhookDoKey for the two supported sandboxId formats.
   *
   * Load-bearing error strings: the messages thrown below ("has no sandboxId",
   * "No routing target", "Webhook forward failed: <status>") are pattern-matched
   * by `isDefiniteUnreachable` in services/kilo-chat/src/services/bot-status-request.ts
   * to decide whether to flip a bot to offline immediately. Typed errors don't
   * survive the Workers RPC boundary, so kilo-chat does substring matching on
   * `err.message`. If you reword these, update the classifier in lock-step —
   * otherwise the worst case is degrading to "always transient" (UI shows
   * stale-online until staleness inference catches up, ~poll interval).
   */
  async deliverChatWebhook(payload: ChatWebhookPayload): Promise<void> {
    const parsed = chatWebhookRpcSchema.parse(payload);
    const botPrefix = 'bot:kiloclaw:';
    if (!parsed.targetBotId.startsWith(botPrefix)) {
      throw new Error(`Invalid targetBotId: ${parsed.targetBotId}`);
    }
    const sandboxId = parsed.targetBotId.slice(botPrefix.length);

    const { doKey, label } = await this.resolveChatWebhookDoKey(sandboxId);
    const getWebhookStub = () =>
      this.env.KILOCLAW_INSTANCE.get(this.env.KILOCLAW_INSTANCE.idFromName(doKey));

    const status = await withDORetry(
      getWebhookStub,
      stub => stub.getStatus(),
      'KiloClawInstance.getStatus'
    );
    if (!status.sandboxId) {
      throw new Error(`Instance for ${label} has no sandboxId`);
    }

    const routingTarget = await withDORetry(
      getWebhookStub,
      stub => stub.getRoutingTarget(),
      'KiloClawInstance.getRoutingTarget'
    );
    if (!routingTarget) {
      throw new Error(`No routing target for ${label}`);
    }
    const targetUrl = `${routingTarget.origin}/plugins/kilo-chat/webhook`;

    if (!this.env.GATEWAY_TOKEN_SECRET) {
      throw new Error('GATEWAY_TOKEN_SECRET not configured');
    }

    const forwardHeaders = await buildForwardHeaders({
      requestHeaders: new Headers({ 'content-type': 'application/json' }),
      sandboxId: status.sandboxId,
      gatewayTokenSecret: this.env.GATEWAY_TOKEN_SECRET,
      providerHeaders: routingTarget.headers,
    });
    forwardHeaders.set(
      'authorization',
      `Bearer ${await deriveGatewayToken(status.sandboxId, this.env.GATEWAY_TOKEN_SECRET)}`
    );

    // Forward the webhook payload (without targetBotId) to the controller
    const { targetBotId: _, ...webhookPayload } = parsed;
    const body = JSON.stringify(webhookPayload);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(targetUrl, {
        method: 'POST',
        headers: forwardHeaders,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const responseText = await response.text().catch(() => '(could not read body)');
      throw new Error(`Webhook forward failed: ${response.status} ${responseText}`);
    }
  }

  /**
   * Resolve a sandboxId to the KiloClawInstance DO key used for routing the
   * webhook. Instance-keyed sandboxes (`ki_*`) map directly to their instanceId.
   * Legacy base64url(userId) sandboxes walk registry → Postgres → userId as a
   * last resort so webhooks for pre-instance-keyed tenants still land.
   */
  private async resolveChatWebhookDoKey(
    sandboxId: string
  ): Promise<{ doKey: string; label: string }> {
    if (isInstanceKeyedSandboxId(sandboxId)) {
      const instanceId = instanceIdFromSandboxId(sandboxId);
      return { doKey: instanceId, label: `instance ${instanceId}` };
    }

    const userId = userIdFromSandboxId(sandboxId);
    const label = `user ${userId}`;
    try {
      const registryKey = `user:${userId}`;
      const entries = await withDORetry(
        () => this.env.KILOCLAW_REGISTRY.get(this.env.KILOCLAW_REGISTRY.idFromName(registryKey)),
        stub => stub.listInstances(registryKey),
        'KiloClawRegistry.listInstances'
      );
      if (entries.length > 0) return { doKey: entries[0].doKey, label };
      // Fall through to Postgres fallback.
    } catch (err) {
      console.error('[WEBHOOK] Registry lookup failed, falling back to Postgres:', err);
    }

    const pgDoKey = await resolveDoKeyForUser(this.env.HYPERDRIVE?.connectionString, userId).catch(
      err => {
        console.error('[WEBHOOK] Postgres fallback failed, using userId as doKey:', err);
        return null;
      }
    );
    return { doKey: pgDoKey ?? userId, label };
  }
}
