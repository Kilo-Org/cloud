/**
 * KiloClaw - Multi-tenant OpenClaw in Cloudflare Sandbox containers
 *
 * Each authenticated user gets their own sandbox container, managed by the
 * KiloClawInstance Durable Object. The catch-all proxy resolves the user's
 * per-user sandbox from their sandboxId and forwards HTTP/WebSocket traffic.
 *
 * Auth model:
 * - User routes + catch-all proxy: JWT via authMiddleware (Bearer header or cookie)
 * - Platform routes: x-internal-api-key via internalApiMiddleware
 * - Debug routes: internal API key or debug secret via debugRoutesGate
 * - Public routes: no auth (health check only)
 */

import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { getSandbox } from '@cloudflare/sandbox';

import type { AppEnv, KiloClawEnv } from './types';
import { OPENCLAW_PORT } from './config';
import { publicRoutes, api, kiloclaw, debug, platform } from './routes';
import { redactSensitiveParams } from './utils/logging';
import { authMiddleware, internalApiMiddleware } from './auth';
import { sandboxIdFromUserId } from './auth/sandbox-id';
import { debugRoutesGate } from './auth/debug-gate';

// Export the custom Sandbox subclass with lifecycle hooks (matches wrangler.jsonc class_name)
export { KiloClawSandbox } from './sandbox';
// Export the KiloClawInstance DO (matches wrangler.jsonc class_name)
export { KiloClawInstance } from './durable-objects/kiloclaw-instance';

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
  return missing;
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

/** Debug routes bypass env validation and auth -- gated by DEBUG_ROUTES + secret. */
function isDebugRoute(c: Context<AppEnv>): boolean {
  const path = new URL(c.req.url).pathname;
  return path === '/debug' || path.startsWith('/debug/');
}

/** Platform routes use internalApiMiddleware instead of JWT auth. */
function isPlatformRoute(c: Context<AppEnv>): boolean {
  const path = new URL(c.req.url).pathname;
  return path === '/api/platform' || path.startsWith('/api/platform/');
}

/** Reject early if required secrets are missing (skip for debug routes and dev mode). */
async function requireEnvVars(c: Context<AppEnv>, next: Next) {
  if (isDebugRoute(c) || c.env.DEV_MODE === 'true') {
    return next();
  }

  // Platform routes need infra bindings but not AI provider keys
  if (isPlatformRoute(c)) {
    const missing: string[] = [];
    if (!c.env.INTERNAL_API_SECRET) missing.push('INTERNAL_API_SECRET');
    if (!c.env.HYPERDRIVE?.connectionString) missing.push('HYPERDRIVE');
    if (!c.env.GATEWAY_TOKEN_SECRET) missing.push('GATEWAY_TOKEN_SECRET');
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

/** Authenticate user via JWT (Bearer header or cookie). Skip for debug and platform routes. */
async function authGuard(c: Context<AppEnv>, next: Next) {
  if (isDebugRoute(c) || isPlatformRoute(c)) {
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

// Debug routes (gated by env flag + secret/internal key)
app.use('/debug/*', debugRoutesGate);
app.route('/debug', debug);

// =============================================================================
// CATCH-ALL: Proxy to per-user OpenClaw gateway
// =============================================================================

/**
 * Attempt crash recovery: if the user's instance has status 'running' but
 * the container/gateway is dead, call start() to restart it transparently.
 *
 * Only triggers when DO status is 'running' -- this covers the race where
 * the container crashed but handleContainerStopped hasn't fired yet.
 * start() verifies the gateway is actually alive before no-oping, so it
 * correctly restarts in this case.
 *
 * If status is 'stopped' or 'provisioned', the user must explicitly start.
 * This prevents auto-restarting instances the user intentionally stopped.
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

    // Gateway dead despite running status (race: crash before handleContainerStopped)
    console.log('[PROXY] Instance status is running but container unreachable, restarting');
    await stub.start();
    return true;
  } catch (err) {
    console.error('[PROXY] Crash recovery failed:', err);
  }
  return false;
}

app.all('*', async c => {
  const sandboxId = c.get('sandboxId');
  if (!sandboxId) {
    return c.json(
      { error: 'Authentication required', hint: 'No active session. Please log in.' },
      401
    );
  }

  const sandbox = getSandbox(c.env.Sandbox, sandboxId, { keepAlive: true });
  const request = c.req.raw;
  const url = new URL(request.url);

  console.log('[PROXY] Handling request:', url.pathname, 'sandbox:', sandboxId);

  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

  // WebSocket proxy with gateway token injection and message interception
  if (isWebSocketRequest) {
    const debugLogs = c.env.DEBUG_ROUTES === 'true';
    const redactedSearch = redactSensitiveParams(url);

    console.log('[WS] Proxying WebSocket connection to OpenClaw');
    if (debugLogs) {
      console.log('[WS] URL:', url.pathname + redactedSearch);
    }

    // Gateway token auth: the browser sends the token in the WebSocket connect
    // frame (params.auth.token), NOT as a URL query param. The token reaches the
    // browser via the URL fragment set by the Next.js dashboard (B4.2).
    // The worker just relays the WebSocket messages transparently.

    let containerResponse: Response;
    try {
      containerResponse = await sandbox.wsConnect(request, OPENCLAW_PORT);
    } catch (err) {
      console.error('[WS] wsConnect failed:', err);

      // Attempt crash recovery: restart if the instance was supposed to be running
      const recovered = await attemptCrashRecovery(c);
      if (recovered) {
        try {
          containerResponse = await sandbox.wsConnect(request, OPENCLAW_PORT);
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
    console.log('[WS] wsConnect response status:', containerResponse.status);

    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      console.error('[WS] No WebSocket in container response - falling back to direct proxy');
      return containerResponse;
    }

    if (debugLogs) {
      console.log('[WS] Got container WebSocket, setting up interception');
    }

    const [clientWs, serverWs] = Object.values(new WebSocketPair());

    serverWs.accept();
    containerWs.accept();

    if (debugLogs) {
      console.log('[WS] Both WebSockets accepted');
      console.log('[WS] containerWs.readyState:', containerWs.readyState);
      console.log('[WS] serverWs.readyState:', serverWs.readyState);
    }

    // Client -> Container relay
    serverWs.addEventListener('message', event => {
      if (debugLogs) {
        console.log(
          '[WS] Client -> Container:',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 200) : '(binary)'
        );
      }
      if (containerWs.readyState === WebSocket.OPEN) {
        containerWs.send(event.data);
      } else if (debugLogs) {
        console.log('[WS] Container not open, readyState:', containerWs.readyState);
      }
    });

    // Container -> Client relay with error transformation
    containerWs.addEventListener('message', event => {
      if (debugLogs) {
        console.log(
          '[WS] Container -> Client (raw):',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 500) : '(binary)'
        );
      }
      let data = event.data;

      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (debugLogs) {
            console.log('[WS] Parsed JSON, has error.message:', !!parsed.error?.message);
          }
          if (parsed.error?.message) {
            if (debugLogs) {
              console.log('[WS] Original error.message:', parsed.error.message);
            }
            parsed.error.message = transformErrorMessage(parsed.error.message);
            if (debugLogs) {
              console.log('[WS] Transformed error.message:', parsed.error.message);
            }
            data = JSON.stringify(parsed);
          }
        } catch (e) {
          if (debugLogs) {
            console.log('[WS] Not JSON or parse error:', e);
          }
        }
      }

      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(data);
      } else if (debugLogs) {
        console.log('[WS] Server not open, readyState:', serverWs.readyState);
      }
    });

    // Close relay
    serverWs.addEventListener('close', event => {
      if (debugLogs) {
        console.log('[WS] Client closed:', event.code, event.reason);
      }
      containerWs.close(event.code, event.reason);
    });

    containerWs.addEventListener('close', event => {
      if (debugLogs) {
        console.log('[WS] Container closed:', event.code, event.reason);
      }
      let reason = transformErrorMessage(event.reason);
      if (reason.length > 123) {
        reason = reason.slice(0, 120) + '...';
      }
      if (debugLogs) {
        console.log('[WS] Transformed close reason:', reason);
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

    if (debugLogs) {
      console.log('[WS] Returning intercepted WebSocket response');
    }
    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    });
  }

  // HTTP proxy
  console.log('[HTTP] Proxying:', url.pathname + url.search);
  let httpResponse: Response;
  try {
    httpResponse = await sandbox.containerFetch(request, OPENCLAW_PORT);
  } catch (err) {
    console.error('[HTTP] containerFetch failed:', err);

    // Attempt crash recovery: restart if the instance was supposed to be running
    const recovered = await attemptCrashRecovery(c);
    if (recovered) {
      try {
        httpResponse = await sandbox.containerFetch(request, OPENCLAW_PORT);
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

  const newHeaders = new Headers(httpResponse.headers);
  newHeaders.set('X-Worker-Debug', 'proxy-to-openclaw');
  newHeaders.set('X-Debug-Path', url.pathname);

  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: newHeaders,
  });
});

export default {
  fetch: app.fetch,
};
