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
import type { z } from 'zod';
import { sandboxIdSchema, type chatWebhookSchema } from '@kilocode/kilo-chat';

import type { AppEnv, KiloClawEnv, ChatWebhookPayload } from './types';
import type { SnapshotRestoreMessage } from './schemas/snapshot-restore';
import { accessGatewayRoutes, publicRoutes, api, kiloclaw, platform, controller } from './routes';
import { handleSnapshotRestoreQueue } from './queue/snapshot-restore';
import { runScheduledActionNoticesSweep } from './scheduled/scheduled-action-notices';
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
import {
  hostMatchesInstanceSuffix,
  parseInstanceHost,
  sandboxIdFromHostnameLabel,
} from './auth/hostname-label';
import { WORKER_CONTROLLER_CAPABILITIES_VERSION } from './config';
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
  // Per-instance virtual-hosting config. Canonical values live in
  // wrangler.jsonc `vars`; when unset (e.g. a misconfigured preview),
  // reject requests rather than silently fall back to prod defaults.
  if (!env.KILOCLAW_INSTANCE_HOST_SUFFIX) missing.push('KILOCLAW_INSTANCE_HOST_SUFFIX');
  if (!env.KILOCLAW_INSTANCE_URL_SCHEME) missing.push('KILOCLAW_INSTANCE_URL_SCHEME');
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

/**
 * Forward an HTTP or WebSocket request through to a provider-routed target.
 *
 * Shared by all four catch-all proxy branches (`/i/:instanceId/*`, host-based,
 * cookie-routed, and default personal). `logTag` is prepended to console logs
 * so failing requests can be traced back to their originating branch.
 *
 * Optional `unreachableHint` / `startingUpHint` are attached to the 503 JSON
 * bodies the helper emits when the upstream fetch fails or the container is
 * still booting. Only the default-personal branch surfaces hints today (tests
 * assert the specific strings); branches that prefer the bare error
 * (`{ "error": "Instance not reachable" }`) just omit them.
 */
async function proxyThroughTarget(opts: {
  request: Request;
  targetUrl: string;
  forwardHeaders: Headers;
  logTag: string;
  unreachableHint?: string;
  startingUpHint?: string;
}): Promise<Response> {
  const { request, targetUrl, forwardHeaders, logTag, unreachableHint, startingUpHint } = opts;
  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

  const unreachableBody: Record<string, string> = { error: 'Instance not reachable' };
  if (unreachableHint) unreachableBody.hint = unreachableHint;
  const startingUpBody: Record<string, string> = { error: 'Instance is starting up' };
  if (startingUpHint) startingUpBody.hint = startingUpHint;

  if (isWebSocketRequest) {
    let containerResponse: Response;
    try {
      containerResponse = await fetch(targetUrl, { headers: forwardHeaders });
    } catch (err) {
      console.error(`${logTag} WS fetch failed:`, err);
      return Response.json(unreachableBody, {
        status: 503,
        headers: { 'Retry-After': '5' },
      });
    }

    if (containerResponse.status === 502) {
      return Response.json(startingUpBody, {
        status: 503,
        headers: { 'Retry-After': '5' },
      });
    }

    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      // Upstream returned a non-upgrade response to a WebSocket request.
      // Normalize to 502 JSON rather than leaking the raw upstream body —
      // this path is only hit when the container is in a bad state
      // (gateway crash, proxy misconfig) and the raw response may contain
      // provider/controller error details we don't want to surface to
      // the Control UI.
      console.warn(`${logTag} upstream did not upgrade (status ${containerResponse.status})`);
      return Response.json({ error: 'WebSocket upgrade failed' }, { status: 502 });
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
            `${logTag} First dropped client->container message (readyState:`,
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
            `${logTag} First dropped container->client message (readyState:`,
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
          `${logTag} Connection closed with`,
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

  // HTTP proxy. Buffer body upfront so streams aren't consumed mid-retry.
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
    console.error(`${logTag} HTTP fetch failed:`, err);
    return Response.json(unreachableBody, {
      status: 503,
      headers: { 'Retry-After': '5' },
    });
  }
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

  return proxyThroughTarget({
    request: c.req.raw,
    targetUrl,
    forwardHeaders,
    logTag: '[PROXY /i]',
  });
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

/**
 * Reserved hostname labels under the instance-host suffix that are NOT
 * per-instance virtual hosts. Requests to these land on the worker via
 * the `*.kiloclaw.ai/*` wildcard route but must be served by
 * earlier-registered routes (controller check-in, future platform
 * endpoints) rather than the host-based proxy branch.
 *
 * Keeping this set small and explicit prevents accidental routing: a
 * request to `claw.kiloclaw.ai/someuserpath` will fall through the
 * host-based branch to cookie/default routing instead of 404ing with an
 * "instance not found" that's actually a configuration misunderstanding.
 */
const RESERVED_INSTANCE_HOST_LABELS = new Set<string>(['claw']);

/**
 * Resolve the DO key that a host-routed request should proxy to.
 *
 *   `i-<32hex>.<suffix>` → key the DO by the decoded instanceId (UUID).
 *   `u-<base32hex>.<suffix>` → key the DO by the decoded userId (legacy).
 *
 * Returns null when the label can't be parsed — caller returns 404 so we
 * don't accidentally proxy to something like `marketing.kiloclaw.ai`.
 */
function resolveHostRouteDoKey(label: string): { doKey: string; sandboxId: string } | null {
  const sandboxId = sandboxIdFromHostnameLabel(label);
  if (!sandboxId) return null;
  if (isInstanceKeyedSandboxId(sandboxId)) {
    return { doKey: instanceIdFromSandboxId(sandboxId), sandboxId };
  }
  return { doKey: userIdFromSandboxId(sandboxId), sandboxId };
}

/**
 * Host-based proxy branch. Runs before the cookie check. Returns the final
 * response when the request host matches the configured instance suffix, or
 * `null` to let subsequent routing (cookie/default) handle it.
 *
 * Behaviour:
 *   - host doesn't match suffix → null (fall through to cookie branch)
 *   - label unparseable → 404
 *   - DO resolves to an instance owned by another user → 403
 *   - instance destroyed / restoring / recovering → 409
 *   - instance not provisioned / no runtime → 404
 *   - capability version < current (v1 machines lack the per-instance origin
 *     in their openclaw allowlist, so WS upgrades would fail origin check)
 *     → 404 with a restart hint so the user knows the per-instance host
 *     needs a machine restart; the legacy host keeps working meanwhile
 *   - otherwise → proxy via `proxyThroughTarget`
 */
async function handleHostBasedRoute(c: Context<AppEnv>): Promise<Response | null> {
  const request = c.req.raw;
  const url = new URL(request.url);
  if (!hostMatchesInstanceSuffix(url.host, c.env)) return null;

  // Within the instance-host space. Anything the label parser rejects
  // (bare suffix, multi-label, unparseable label) 404s here rather than
  // falling through to default-personal routing — users on `*.kiloclaw.ai`
  // are bound to a specific instance by the URL.
  const label = parseInstanceHost(url.host, c.env);
  if (!label) {
    return c.json({ error: 'Instance not found' }, 404);
  }

  // Reserved labels (e.g. `claw` for controller check-in, platform health
  // probes) are served by earlier-registered routes. If we've reached the
  // catch-all on a reserved label the path wasn't a controller/platform
  // route — return null so the cookie/default branches handle it rather
  // than 404ing with a misleading "instance not found".
  if (RESERVED_INSTANCE_HOST_LABELS.has(label)) {
    return null;
  }

  const userId = c.get('userId');
  if (!userId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const resolved = resolveHostRouteDoKey(label);
  if (!resolved) {
    return c.json({ error: 'Instance not found' }, 404);
  }

  if (!c.env.GATEWAY_TOKEN_SECRET) {
    return c.json(
      { error: 'Configuration error' },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }

  const getHostStub = () =>
    c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(resolved.doKey));
  const status = await withDORetry(
    getHostStub,
    stub => stub.getStatus(),
    'KiloClawInstance.getStatus'
  );

  // Non-existent instance (DO was never populated) — 404 to avoid leaking
  // existence via 403/404 distinction.
  if (!status.userId) {
    return c.json({ error: 'Instance not found' }, 404);
  }

  if (status.userId !== userId) {
    return c.json({ error: 'Access denied' }, 403);
  }

  // Capability gate. v1 machines don't have `<label>.<suffix>` in their
  // OPENCLAW_ALLOWED_ORIGINS, so WebSocket upgrades from this host would be
  // rejected by openclaw's exact-match origin check. Refuse the request on
  // the per-instance host so broken-at-runtime traffic never reaches the
  // machine; the user can continue via the legacy host
  // (`claw.kilosessions.ai`) and the instance rolls onto v2 on its next
  // restart.
  const version = status.controllerCapabilitiesVersion ?? 1;
  if (version < WORKER_CONTROLLER_CAPABILITIES_VERSION) {
    return c.json(
      {
        error: 'Instance not available on this host',
        hint: 'This instance needs a restart before it can be reached at its per-instance hostname. Use the legacy URL for now.',
      },
      404
    );
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

  const routingTarget = await withDORetry(
    getHostStub,
    stub => stub.getRoutingTarget(),
    'KiloClawInstance.getRoutingTarget'
  );
  if (!routingTarget) {
    return c.json(
      { error: 'Instance not routable' },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }

  const targetUrl = routingTargetUrl(routingTarget, url.pathname, url.search);
  const forwardHeaders = await buildForwardHeaders({
    requestHeaders: request.headers,
    sandboxId: status.sandboxId,
    gatewayTokenSecret: c.env.GATEWAY_TOKEN_SECRET,
    providerHeaders: routingTarget.headers,
  });

  console.log(
    '[PROXY host]',
    'Handling request:',
    url.pathname,
    'label:',
    label,
    'runtime:',
    status.runtimeId
  );

  return proxyThroughTarget({
    request,
    targetUrl,
    forwardHeaders,
    logTag: '[PROXY host]',
  });
}

app.all('*', async c => {
  // Auth gate: middleware-derived sandboxId proves the user is authenticated.
  if (!c.get('sandboxId')) {
    return c.json(
      { error: 'Authentication required', hint: 'No active session. Please log in.' },
      401
    );
  }

  // Host-based routing: when the request arrives on a configured per-instance
  // virtual host (e.g. `i-<hex>.kiloclaw.ai`), resolve the owning DO from the
  // label rather than from the active-instance cookie. Takes precedence over
  // the cookie-based branch — users on `<label>.kiloclaw.ai` are bound to
  // that instance by the URL, not by cookie state.
  const hostRouteResponse = await handleHostBasedRoute(c);
  if (hostRouteResponse) return hostRouteResponse;

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

          return proxyThroughTarget({
            request,
            targetUrl,
            forwardHeaders,
            logTag: '[PROXY cookie]',
          });
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

  return proxyThroughTarget({
    request,
    targetUrl,
    forwardHeaders,
    logTag: '[PROXY default]',
    unreachableHint: 'Your instance may not be running. Start it from the dashboard.',
    startingUpHint: 'The gateway process is still initializing. Please retry shortly.',
  });
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
   * Cron handler. Currently runs the scheduled-action notice sweep
   * (1-minute cadence per wrangler.jsonc). Wrap each sweep call in
   * its own try/catch so a failing sweep doesn't poison subsequent
   * crons or any other handler running on this entrypoint.
   */
  async scheduled(_event: ScheduledController): Promise<void> {
    try {
      const result = await runScheduledActionNoticesSweep(this.env);
      if (result.processed > 0 || result.recovered > 0 || result.voidedStale > 0) {
        console.log(
          `[scheduled] action-notices: processed=${result.processed} sent=${result.sent} failed=${result.failed} recovered=${result.recovered} voidedStale=${result.voidedStale}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[scheduled] action-notices sweep failed:', msg);
    }
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
    const { targetBotId, ...rpcPayload } = payload;
    const webhookPayload = rpcPayload satisfies z.infer<typeof chatWebhookSchema>;
    const botPrefix = 'bot:kiloclaw:';
    if (!targetBotId.startsWith(botPrefix)) {
      throw new Error(`Invalid targetBotId: ${targetBotId}`);
    }
    const sandboxId = targetBotId.slice(botPrefix.length);
    if (!sandboxIdSchema.safeParse(sandboxId).success) {
      throw new Error(`Invalid sandboxId derived from targetBotId: ${targetBotId}`);
    }

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
