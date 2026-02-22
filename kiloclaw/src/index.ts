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

import type { AppEnv, KiloClawEnv } from './types';
import { accessGatewayRoutes, publicRoutes, api, kiloclaw, platform } from './routes';
import { redactSensitiveParams } from './utils/logging';
import { authMiddleware, internalApiMiddleware } from './auth';
import { sandboxIdFromUserId } from './auth/sandbox-id';
import { registerVersionIfNeeded } from './lib/image-version';

// Export DOs (match wrangler.jsonc class_name bindings)
export { KiloClawInstance } from './durable-objects/kiloclaw-instance';
export { KiloClawApp } from './durable-objects/kiloclaw-app';

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

/** Reject early if required secrets are missing (skip in dev mode). */
async function requireEnvVars(c: Context<AppEnv>, next: Next) {
  if (c.env.DEV_MODE === 'true') {
    return next();
  }

  // Platform routes need infra bindings but not AI provider keys
  if (isPlatformRoute(c)) {
    const missing: string[] = [];
    if (!c.env.INTERNAL_API_SECRET) missing.push('INTERNAL_API_SECRET');
    if (!c.env.HYPERDRIVE?.connectionString) missing.push('HYPERDRIVE');
    if (!c.env.GATEWAY_TOKEN_SECRET) missing.push('GATEWAY_TOKEN_SECRET');
    if (!c.env.FLY_API_TOKEN) missing.push('FLY_API_TOKEN');
    if (missing.length > 0) {
      console.error('[CONFIG] Platform route missing bindings:', missing.join(', '));
      return c.json({ error: 'Configuration error', missing }, 503);
    }
    return next();
  }

  const missingVars = validateRequiredEnv(c.env);
  if (missingVars.length > 0) {
    console.error('[CONFIG] Missing required environment variables:', missingVars.join(', '));
    return c.json(
      {
        error: 'Configuration error',
        message: 'Required environment variables are not configured',
        missing: missingVars,
        hint: 'Set these using: wrangler secret put <VARIABLE_NAME>',
      },
      503
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
    c.set('sandboxId', sandboxIdFromUserId(userId));
  }
  return next();
}

// =============================================================================
// App assembly
// =============================================================================

const app = new Hono<AppEnv>();

// Global middleware (all routes)
app.use('*', logRequest);

// Public routes (no auth)
app.route('/', publicRoutes);
app.route('/', accessGatewayRoutes);

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
// CATCH-ALL: Proxy to per-user OpenClaw gateway via Fly Proxy
// =============================================================================

/**
 * Attempt crash recovery: if the user's instance has status 'running' but
 * the machine is dead, call start() to restart it transparently.
 */
async function attemptCrashRecovery(c: Context<AppEnv>): Promise<boolean> {
  const userId = c.get('userId');
  if (!userId) return false;

  try {
    const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(userId));
    const status = await stub.getStatus();

    if (status.status !== 'running') {
      return false;
    }

    // Machine dead despite running status -- restart
    console.log('[PROXY] Instance status is running but machine unreachable, restarting');
    await stub.start(userId);
    return true;
  } catch (err) {
    console.error('[PROXY] Crash recovery failed:', err);
  }
  return false;
}

/**
 * Resolve the flyMachineId, flyAppName, and status for the current user from their DO.
 * Returns null machineId if the instance is destroying (blocks proxy during teardown).
 */
async function resolveInstance(c: Context<AppEnv>): Promise<{
  machineId: string | null;
  flyAppName: string | null;
  status: string | null;
}> {
  const userId = c.get('userId');
  if (!userId) return { machineId: null, flyAppName: null, status: null };

  const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(userId));
  const s = await stub.getStatus();

  if (s.status === 'destroying') return { machineId: null, flyAppName: null, status: 'destroying' };

  return { machineId: s.flyMachineId, flyAppName: s.flyAppName, status: s.status };
}

app.all('*', async c => {
  const sandboxId = c.get('sandboxId');
  if (!sandboxId) {
    return c.json(
      { error: 'Authentication required', hint: 'No active session. Please log in.' },
      401
    );
  }

  const { machineId, flyAppName, status } = await resolveInstance(c);
  if (status === 'destroying') {
    return c.json(
      { error: 'Instance is being destroyed', hint: 'This instance is being torn down.' },
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

  // Per-user app name, with legacy fallback for existing instances
  const appName = flyAppName ?? c.env.FLY_APP_NAME;
  if (!appName) {
    return c.json({ error: 'No Fly app name for this instance' }, 503);
  }

  const request = c.req.raw;
  const url = new URL(request.url);
  const targetUrl = flyProxyUrl(appName, url);

  console.log('[PROXY] Handling request:', url.pathname, 'machine:', machineId);

  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

  // Build headers to forward, adding the fly-force-instance-id header
  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.set('fly-force-instance-id', machineId);
  // Remove hop-by-hop headers that shouldn't be forwarded
  forwardHeaders.delete('host');

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
          return c.json({ error: 'Instance not reachable after restart' }, 503);
        }
        forwardHeaders.set('fly-force-instance-id', newMachineId);

        try {
          containerResponse = await fetch(targetUrl, {
            headers: forwardHeaders,
          });
        } catch (retryErr) {
          console.error('[WS] Retry after recovery failed:', retryErr);
          return c.json({ error: 'Instance not reachable after restart attempt' }, 503);
        }
      } else {
        return c.json(
          {
            error: 'Instance not reachable',
            hint: 'Your instance may not be running. Start it from the dashboard.',
          },
          503
        );
      }
    }
    console.log('[WS] Fly Proxy response status:', containerResponse.status);

    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      console.error('[WS] No WebSocket in response - returning direct response');
      return containerResponse;
    }

    const [clientWs, serverWs] = Object.values(new WebSocketPair());

    serverWs.accept();
    containerWs.accept();

    // Client -> Container relay
    serverWs.addEventListener('message', event => {
      if (containerWs.readyState === WebSocket.OPEN) {
        containerWs.send(event.data);
      }
    });

    // Container -> Client relay with error transformation
    containerWs.addEventListener('message', event => {
      let data = event.data;

      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error?.message) {
            parsed.error.message = transformErrorMessage(parsed.error.message);
            data = JSON.stringify(parsed);
          }
        } catch {
          // Not JSON -- pass through
        }
      }

      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(data);
      }
    });

    // Close relay
    serverWs.addEventListener('close', event => {
      containerWs.close(event.code, event.reason);
    });

    containerWs.addEventListener('close', event => {
      let reason = transformErrorMessage(event.reason);
      if (reason.length > 123) {
        reason = reason.slice(0, 120) + '...';
      }
      serverWs.close(event.code, reason);
    });

    // Error relay
    serverWs.addEventListener('error', event => {
      console.error('[WS] Client error:', event);
      containerWs.close(1011, 'Client error');
    });

    containerWs.addEventListener('error', event => {
      console.error('[WS] Container error:', event);
      serverWs.close(1011, 'Container error');
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
        return c.json({ error: 'Instance not reachable after restart' }, 503);
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
        return c.json({ error: 'Instance not reachable after restart attempt' }, 503);
      }
    } else {
      return c.json(
        {
          error: 'Instance not reachable',
          hint: 'Your instance may not be running. Start it from the dashboard.',
        },
        503
      );
    }
  }
  console.log('[HTTP] Response status:', httpResponse.status);
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
          env.FLY_IMAGE_TAG
        )
      );
    }

    return app.fetch(request, env, ctx);
  },
};
