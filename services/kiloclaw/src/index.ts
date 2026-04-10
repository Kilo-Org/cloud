/**
 * KiloClaw - Multi-tenant OpenClaw on Fly.io Machines
 *
 * Each authenticated user gets their own Fly Machine, managed by the
 * KiloClawInstance Durable Object. The catch-all proxy resolves the user's
 * flyMachineId from the DO and forwards HTTP/WebSocket traffic via Fly Proxy.
 *
 * Auth model:
 * - User routes + catch-all proxy: JWT via authMiddleware (Bearer header or cookie)
 * - Platform routes: x-internal-api-key via internalApiMiddleware
 * - Public routes: no auth (health check only)
 */

import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';

import type { AppEnv, KiloClawEnv } from './types';
import type { SnapshotRestoreMessage } from './schemas/snapshot-restore';
import { accessGatewayRoutes, publicRoutes, api, kiloclaw, platform, controller } from './routes';
import { handleSnapshotRestoreQueue } from './queue/snapshot-restore';
import { redactSensitiveParams } from './utils/logging';
import { authMiddleware, internalApiMiddleware } from './auth';
import { sandboxIdFromUserId } from './auth/sandbox-id';
import { InstanceIdParam } from './schemas/instance-config';
import { isValidInstanceId } from '@kilocode/worker-utils/instance-id';
import { registerVersionIfNeeded } from './lib/image-version';
import { resolveDoKeyForUser } from './lib/instance-routing';
import { startingUpPage } from './pages/starting-up';
import { buildForwardHeaders } from './utils/proxy-headers';
import { KILOCLAW_ACTIVE_INSTANCE_COOKIE } from './config';
import { timingMiddleware } from './middleware/analytics';
import { writeEvent } from './utils/analytics';
import type { RegistryEntry } from './durable-objects/kiloclaw-registry';

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
  if (!env.FLY_API_TOKEN) missing.push('FLY_API_TOKEN');
  return missing;
}

/**
 * Build the Fly Proxy URL for a given request path.
 */
function flyProxyUrl(appName: string, url: URL): string {
  return `https://${appName}.fly.dev${url.pathname}${url.search}`;
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
    if (!c.env.INTERNAL_API_SECRET) missing.push('INTERNAL_API_SECRET');
    if (!c.env.HYPERDRIVE?.connectionString) missing.push('HYPERDRIVE');
    if (!c.env.NEXTAUTH_SECRET) missing.push('NEXTAUTH_SECRET');
    if (!c.env.GATEWAY_TOKEN_SECRET) missing.push('GATEWAY_TOKEN_SECRET');
    if (!c.env.FLY_API_TOKEN) missing.push('FLY_API_TOKEN');
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

const app = new Hono<AppEnv>();

// Global middleware (all routes)
app.use('*', timingMiddleware);
app.use('*', logRequest);

// Public routes (no auth)
app.route('/', publicRoutes);
app.route('/', accessGatewayRoutes);

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

  const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(instanceId));
  const status = await stub.getStatus();

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
  if (!status.flyMachineId) {
    return c.json({ error: 'Instance not provisioned' }, 404);
  }
  if (!status.sandboxId) {
    return c.json({ error: 'Instance has no sandboxId' }, 500);
  }

  const appName = status.flyAppName ?? c.env.FLY_APP_NAME;
  if (!appName) {
    return c.json({ error: 'No Fly app name for this instance' }, 503);
  }

  // Strip the /i/{instanceId} prefix to get the real path
  const url = new URL(c.req.raw.url);
  const prefix = `/i/${instanceId}`;
  const strippedPath = url.pathname.slice(prefix.length) || '/';
  const targetUrl = `https://${appName}.fly.dev${strippedPath}${url.search}`;

  const forwardHeaders = await buildForwardHeaders({
    requestHeaders: c.req.raw.headers,
    machineId: status.flyMachineId,
    sandboxId: status.sandboxId,
    gatewayTokenSecret: c.env.GATEWAY_TOKEN_SECRET,
  });

  console.log(
    '[PROXY /i] Handling request:',
    strippedPath,
    'instance:',
    instanceId,
    'machine:',
    status.flyMachineId
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
    const registryStub = c.env.KILOCLAW_REGISTRY.get(
      c.env.KILOCLAW_REGISTRY.idFromName(registryKey)
    );
    const entries = await registryStub.listInstances(registryKey);
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
 * Attempt crash recovery: if the user's instance has status 'running' but
 * the machine is dead, call start() to restart it transparently.
 */
async function attemptCrashRecovery(c: Context<AppEnv>): Promise<boolean> {
  const userId = c.get('userId');
  if (!userId) return false;
  const startedAt = performance.now();

  try {
    const resolved = await resolveRegistryEntry(c);
    if (!resolved) return false;
    const { stub } = resolved;
    const status = await stub.getStatus();

    if (status.status !== 'running') {
      return false;
    }

    // Machine dead despite running status -- restart
    console.log('[PROXY] Instance status is running but machine unreachable, restarting');
    const { started } = await stub.start(userId);
    if (started) {
      const freshStatus = await stub.getStatus();
      writeEvent(c.env, {
        event: 'instance.crash_recovery_succeeded',
        delivery: 'http',
        userId,
        sandboxId: freshStatus.sandboxId ?? undefined,
        flyMachineId: freshStatus.flyMachineId ?? undefined,
        flyAppName: freshStatus.flyAppName ?? undefined,
        status: freshStatus.status ?? undefined,
        durationMs: performance.now() - startedAt,
      });
    }
    return true;
  } catch (err) {
    writeEvent(c.env, {
      event: 'instance.crash_recovery_failed',
      delivery: 'http',
      userId,
      sandboxId: c.get('sandboxId') ?? undefined,
      error: err instanceof Error ? err.message : String(err),
      durationMs: performance.now() - startedAt,
    });
    console.error('[PROXY] Crash recovery failed:', err);
  }
  return false;
}

/**
 * Resolve the flyMachineId, flyAppName, sandboxId, and status for the current user from their DO.
 * Returns null machineId if the instance is destroying (blocks proxy during teardown).
 * Routes through the user registry, which triggers lazy migration on first access.
 *
 * The returned sandboxId is the DO's authoritative value — it may differ from the
 * middleware-derived `c.get('sandboxId')` for instance-keyed DOs (which use `ki_` prefix).
 * Callers MUST use the returned sandboxId for gateway token derivation.
 */
async function resolveInstance(c: Context<AppEnv>): Promise<{
  machineId: string | null;
  flyAppName: string | null;
  sandboxId: string | null;
  status: string | null;
}> {
  const resolved = await resolveRegistryEntry(c);
  if (!resolved) return { machineId: null, flyAppName: null, sandboxId: null, status: null };

  const s = await resolved.stub.getStatus();

  if (s.status === 'destroying')
    return { machineId: null, flyAppName: null, sandboxId: null, status: 'destroying' };
  if (s.status === 'restoring')
    return { machineId: null, flyAppName: null, sandboxId: null, status: 'restoring' };
  if (s.status === 'recovering')
    return { machineId: null, flyAppName: null, sandboxId: null, status: 'recovering' };

  return {
    machineId: s.flyMachineId,
    flyAppName: s.flyAppName,
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
      const stub = c.env.KILOCLAW_INSTANCE.get(
        c.env.KILOCLAW_INSTANCE.idFromName(activeInstanceId)
      );
      const instanceStatus = await stub.getStatus();

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
        if (!instanceStatus.flyMachineId) {
          return c.json(
            { error: 'Instance not provisioned', hint: 'The instance has no running machine.' },
            404
          );
        }

        const appName = instanceStatus.flyAppName ?? c.env.FLY_APP_NAME;
        if (appName && instanceStatus.sandboxId) {
          console.log(
            '[PROXY] Cookie-routed to instance:',
            activeInstanceId,
            'machine:',
            instanceStatus.flyMachineId
          );
          const request = c.req.raw;
          const url = new URL(request.url);
          const targetUrl = flyProxyUrl(appName, url);

          if (!c.env.GATEWAY_TOKEN_SECRET) {
            return c.json(
              { error: 'Configuration error' },
              { status: 503, headers: { 'Retry-After': '5' } }
            );
          }

          const forwardHeaders = await buildForwardHeaders({
            requestHeaders: request.headers,
            machineId: instanceStatus.flyMachineId,
            sandboxId: instanceStatus.sandboxId,
            gatewayTokenSecret: c.env.GATEWAY_TOKEN_SECRET,
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

  const { machineId, flyAppName, sandboxId, status } = await resolveInstance(c);
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
  if (!machineId) {
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

  // Per-user app name, with legacy fallback for existing instances
  const appName = flyAppName ?? c.env.FLY_APP_NAME;
  if (!appName) {
    return c.json(
      { error: 'No Fly app name for this instance' },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }

  const request = c.req.raw;
  const url = new URL(request.url);
  const targetUrl = flyProxyUrl(appName, url);

  console.log('[PROXY] Handling request:', url.pathname, 'machine:', machineId);

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
    machineId,
    sandboxId,
    gatewayTokenSecret: c.env.GATEWAY_TOKEN_SECRET,
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

      const recovered = await attemptCrashRecovery(c);
      if (recovered) {
        // Machine may have been recreated — refresh the instance routing header
        const { machineId: newMachineId } = await resolveInstance(c);
        if (!newMachineId) {
          return c.json(
            { error: 'Instance not reachable after restart' },
            { status: 503, headers: { 'Retry-After': '5' } }
          );
        }
        forwardHeaders.set('fly-force-instance-id', newMachineId);

        try {
          containerResponse = await fetch(targetUrl, {
            headers: forwardHeaders,
          });
        } catch (retryErr) {
          console.error('[WS] Retry after recovery failed:', retryErr);
          return c.json(
            { error: 'Instance not reachable after restart attempt' },
            { status: 503, headers: { 'Retry-After': '5' } }
          );
        }
      } else {
        return c.json(
          {
            error: 'Instance not reachable',
            hint: 'Your instance may not be running. Start it from the dashboard.',
          },
          { status: 503, headers: { 'Retry-After': '5' } }
        );
      }
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

    const recovered = await attemptCrashRecovery(c);
    if (recovered) {
      // Machine may have been recreated — refresh the instance routing header
      const { machineId: newMachineId } = await resolveInstance(c);
      if (!newMachineId) {
        return c.json(
          { error: 'Instance not reachable after restart' },
          { status: 503, headers: { 'Retry-After': '5' } }
        );
      }
      forwardHeaders.set('fly-force-instance-id', newMachineId);

      try {
        httpResponse = await fetch(targetUrl, {
          method: request.method,
          headers: forwardHeaders,
          body: requestBody,
        });
      } catch (retryErr) {
        console.error('[HTTP] Retry after recovery failed:', retryErr);
        return c.json(
          { error: 'Instance not reachable after restart attempt' },
          { status: 503, headers: { 'Retry-After': '5' } }
        );
      }
    } else {
      return c.json(
        {
          error: 'Instance not reachable',
          hint: 'Your instance may not be running. Start it from the dashboard.',
        },
        { status: 503, headers: { 'Retry-After': '5' } }
      );
    }
  }
  console.log('[HTTP] Response status:', httpResponse.status);

  // Gateway not ready yet — show friendly "starting up" page instead of raw 502
  if (httpResponse.status === 502) {
    return startingUpPage();
  }

  return httpResponse;
});

export default {
  fetch(request: Request, env: KiloClawEnv, ctx: ExecutionContext) {
    // Self-register the current OpenClaw version in KV on deploy.
    // Runs after the response is sent. If the very first request after deploy
    // is a provision(), the KV write races with resolveLatestVersion() —
    // provision may see the previous latest (or null) and fall back to
    // FLY_IMAGE_TAG, which is already correct for the new deploy. This is benign.
    if (env.OPENCLAW_VERSION && env.FLY_IMAGE_TAG) {
      ctx.waitUntil(
        registerVersionIfNeeded(
          env.KV_CLAW_CACHE,
          env.OPENCLAW_VERSION,
          'default', // variant hardcoded day 1
          env.FLY_IMAGE_TAG,
          env.FLY_IMAGE_DIGEST ?? null,
          env.HYPERDRIVE?.connectionString
        )
      );
    }

    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<SnapshotRestoreMessage>, env: KiloClawEnv): Promise<void> {
    await handleSnapshotRestoreQueue(batch, env);
  },
};
