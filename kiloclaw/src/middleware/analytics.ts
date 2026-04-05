import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';
import { sandboxIdFromUserId } from '../auth/sandbox-id';
import { writeEvent } from '../utils/analytics';

/**
 * Captures a high-resolution start timestamp very early in the request
 * lifecycle. Must be the first middleware registered.
 */
export async function timingMiddleware(c: Context<AppEnv>, next: Next): Promise<void> {
  c.set('requestStartTime', performance.now());
  await next();
}

/**
 * Derive a short event name from an HTTP route pattern.
 *
 * Strips the /api/ prefix, removes :param segments, and joins remaining
 * meaningful segments with dots. The HTTP method maps to a verb suffix.
 *
 * GET defaults to "get". Routes that return collections can be identified
 * by their plural resource name in analytics queries if needed.
 *
 * Examples:
 *   "POST /api/platform/provision"                  → "platform.provision.create"
 *   "GET  /api/platform/status"                     → "platform.status.get"
 *   "POST /api/platform/gateway/restart"            → "platform.gateway.restart.create"
 *   "POST /api/admin/machine/restart"               → "admin.machine.restart.create"
 *   "GET  /api/kiloclaw/config"                     → "kiloclaw.config.get"
 *   "GET  /health"                                  → "health.get"
 */
export function deriveHttpEventName(method: string, routePath: string): string {
  const segments = routePath
    .replace(/^\/api\//, '')
    .replace(/^\//, '')
    .split('/')
    .filter(Boolean);

  const meaningful: string[] = [];

  for (const seg of segments) {
    if (seg.startsWith(':')) continue;
    meaningful.push(seg);
  }

  const verbMap: Record<string, string> = {
    GET: 'get',
    POST: 'create',
    PUT: 'update',
    PATCH: 'update',
    DELETE: 'delete',
  };

  const verb = verbMap[method] ?? method.toLowerCase();
  const tail = meaningful.join('.');

  if (!tail) return `http.${verb}`;
  return `${tail}.${verb}`;
}

/**
 * Per-route analytics wrapper. Emits an analytics event with timing and
 * error capture in a `finally` block so every request is tracked.
 *
 * userId/sandboxId are read from the Hono context (set by authMiddleware +
 * deriveSandboxId). Pass `resolveUserId` to override when userId comes
 * from a different source.
 *
 * Usage:
 *   app.get('/api/kiloclaw/status', c =>
 *     instrumented(c, 'GET /api/kiloclaw/status', () => handleStatus(c)))
 */
export async function instrumented(
  c: Context<AppEnv>,
  route: string,
  handler: () => Promise<Response>,
  resolveUserId?: () => string | undefined
): Promise<Response> {
  const startTime = c.get('requestStartTime') ?? performance.now();
  let error: string | undefined;
  try {
    const response = await handler();
    if (response.status >= 400) {
      error = `HTTP ${response.status}`;
    }
    return response;
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    throw err;
  } finally {
    const durationMs = performance.now() - startTime;
    const [method] = route.split(' ', 1);
    const routePath = route.slice(method.length + 1);

    const userId = resolveUserId?.() ?? c.get('userId') ?? '';
    let sandboxId = '';
    if (userId) {
      try {
        sandboxId = sandboxIdFromUserId(userId);
      } catch {
        // sandboxIdFromUserId can throw on invalid userId — don't let
        // analytics crash the response path
      }
    }

    writeEvent(c.env, {
      event: deriveHttpEventName(method, routePath),
      delivery: 'http',
      route,
      error,
      userId,
      sandboxId,
      durationMs,
    });
  }
}
