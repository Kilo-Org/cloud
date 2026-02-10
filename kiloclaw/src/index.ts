/**
 * KiloClaw - Multi-tenant OpenClaw in Cloudflare Sandbox containers
 *
 * This Worker runs OpenClaw personal AI assistant instances in Cloudflare Sandbox containers.
 * It proxies all requests to the OpenClaw Gateway's web UI and WebSocket endpoint.
 *
 * Auth model:
 * - User routes: JWT via authMiddleware (Bearer header or kilo-worker-auth cookie)
 * - Platform routes: x-internal-api-key via internalApiMiddleware (PR4+)
 * - Public routes: no auth (health check only)
 */

import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions } from '@cloudflare/sandbox';

import type { AppEnv, KiloClawEnv } from './types';
import { OPENCLAW_PORT } from './config';
import { ensureOpenClawGateway, findExistingGatewayProcess, syncToR2 } from './gateway';
import { publicRoutes, api, debug } from './routes';
import { redactSensitiveParams } from './utils/logging';
import { authMiddleware } from './auth';
import { sandboxIdFromUserId } from './auth/sandbox-id';
import { debugRoutesGate } from './auth/debug-gate';

// Re-export Sandbox as KiloClawSandbox to match wrangler.jsonc class_name.
// PR4 will replace this with a custom subclass that adds lifecycle hooks.
export { Sandbox as KiloClawSandbox };

// =============================================================================
// Helpers
// =============================================================================

function transformErrorMessage(message: string, host: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
  }
  return message;
}

/**
 * Validate required environment variables.
 * Returns an array of missing variable descriptions, or empty array if all are set.
 */
function validateRequiredEnv(env: KiloClawEnv): string[] {
  const missing: string[] = [];

  if (!env.NEXTAUTH_SECRET) {
    missing.push('NEXTAUTH_SECRET');
  }
  if (!env.GATEWAY_TOKEN_SECRET) {
    missing.push('GATEWAY_TOKEN_SECRET');
  }

  const hasCloudflareGateway = !!(
    env.CLOUDFLARE_AI_GATEWAY_API_KEY &&
    env.CF_AI_GATEWAY_ACCOUNT_ID &&
    env.CF_AI_GATEWAY_GATEWAY_ID
  );
  const hasLegacyGateway = !!(env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL);
  const hasAnthropicKey = !!env.ANTHROPIC_API_KEY;
  const hasOpenAIKey = !!env.OPENAI_API_KEY;

  if (!hasCloudflareGateway && !hasLegacyGateway && !hasAnthropicKey && !hasOpenAIKey) {
    missing.push(
      'ANTHROPIC_API_KEY, OPENAI_API_KEY, or CLOUDFLARE_AI_GATEWAY_API_KEY + CF_AI_GATEWAY_ACCOUNT_ID + CF_AI_GATEWAY_GATEWAY_ID'
    );
  }

  return missing;
}

function buildSandboxOptions(env: KiloClawEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }
  return { sleepAfter };
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

async function initSandbox(c: Context<AppEnv>, next: Next) {
  const options = buildSandboxOptions(c.env);
  const sandbox = getSandbox(c.env.Sandbox, 'kiloclaw', options);
  c.set('sandbox', sandbox);
  await next();
}

/** Debug routes bypass env validation and auth -- gated by DEBUG_ROUTES + secret. */
function isDebugRoute(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).pathname.startsWith('/debug');
}

/** Reject early if required secrets are missing (skip for debug routes and dev mode). */
async function requireEnvVars(c: Context<AppEnv>, next: Next) {
  if (isDebugRoute(c) || c.env.DEV_MODE === 'true') {
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

/** Authenticate user via JWT (Bearer header or cookie). */
async function authGuard(c: Context<AppEnv>, next: Next) {
  if (isDebugRoute(c)) {
    return next();
  }
  return authMiddleware(c, next);
}

/**
 * Derive sandboxId from the authenticated userId.
 * PR2: derives sandboxId only. Does NOT call getSandbox() -- that would create
 * containers without a provisioned record. getSandbox() per-user is deferred to PR4.
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
app.use('*', initSandbox);

// Public routes (no auth)
app.route('/', publicRoutes);

// Protected middleware chain
app.use('*', requireEnvVars);
app.use('*', authGuard);
app.use('*', deriveSandboxId);

// API routes
app.route('/api', api);

// Debug routes (gated by env flag)
app.use('/debug/*', debugRoutesGate);
app.route('/debug', debug);

// =============================================================================
// CATCH-ALL: Proxy to OpenClaw gateway
// =============================================================================

app.all('*', async c => {
  const sandbox = c.get('sandbox');
  const request = c.req.raw;
  const url = new URL(request.url);

  console.log('[PROXY] Handling request:', url.pathname);

  // Check if gateway is already running
  const existingProcess = await findExistingGatewayProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';

  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

  if (!isGatewayReady && !isWebSocketRequest) {
    try {
      await ensureOpenClawGateway(sandbox, c.env);
    } catch (error) {
      console.error('[PROXY] Failed to start OpenClaw:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      let hint = 'Check worker logs with: wrangler tail';
      if (!c.env.ANTHROPIC_API_KEY) {
        hint = 'ANTHROPIC_API_KEY is not set. Run: wrangler secret put ANTHROPIC_API_KEY';
      } else if (errorMessage.includes('heap out of memory') || errorMessage.includes('OOM')) {
        hint = 'Gateway ran out of memory. Try again or check for memory leaks.';
      }

      return c.json(
        {
          error: 'OpenClaw gateway failed to start',
          details: errorMessage,
          hint,
        },
        503
      );
    }
  }

  if (!isGatewayReady) {
    try {
      await ensureOpenClawGateway(sandbox, c.env);
    } catch (error) {
      console.error('[PROXY] Failed to start OpenClaw:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json(
        {
          error: 'OpenClaw gateway failed to start',
          details: errorMessage,
        },
        503
      );
    }
  }

  // WebSocket proxy with message interception
  if (isWebSocketRequest) {
    const debugLogs = c.env.DEBUG_ROUTES === 'true';
    const redactedSearch = redactSensitiveParams(url);

    console.log('[WS] Proxying WebSocket connection to OpenClaw');
    if (debugLogs) {
      console.log('[WS] URL:', url.pathname + redactedSearch);
    }

    const containerResponse = await sandbox.wsConnect(request, OPENCLAW_PORT);
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
            parsed.error.message = transformErrorMessage(parsed.error.message, url.host);
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
      let reason = transformErrorMessage(event.reason, url.host);
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
  const httpResponse = await sandbox.containerFetch(request, OPENCLAW_PORT);
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

// =============================================================================
// Scheduled handler (dead code -- cron trigger removed in PR1, handler removed in PR6)
// =============================================================================

async function scheduled(
  _event: ScheduledEvent,
  env: KiloClawEnv,
  _ctx: ExecutionContext
): Promise<void> {
  const options = buildSandboxOptions(env);
  const sandbox = getSandbox(env.Sandbox, 'kiloclaw', options);

  const gatewayProcess = await findExistingGatewayProcess(sandbox);
  if (!gatewayProcess) {
    console.log('[cron] Gateway not running yet, skipping sync');
    return;
  }

  console.log('[cron] Starting backup sync to R2...');
  const result = await syncToR2(sandbox, env);

  if (result.success) {
    console.log('[cron] Backup sync completed successfully at', result.lastSync);
  } else {
    console.error('[cron] Backup sync failed:', result.error, result.details || '');
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
