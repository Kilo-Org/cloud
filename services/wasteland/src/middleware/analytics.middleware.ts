import type { Context, Next } from 'hono';
import type { WastelandEnv } from '../wasteland.worker';
import { writeEvent } from '../util/analytics.util';

/**
 * Captures a high-resolution start timestamp very early in the request
 * lifecycle. Must be the first middleware registered.
 */
export async function timingMiddleware(c: Context<WastelandEnv>, next: Next): Promise<void> {
  c.set('requestStartTime', performance.now());
  await next();
}

/**
 * Derive a short event name from an HTTP route pattern.
 *
 * The last non-param segment determines the resource name. When the route
 * ends with a param (e.g. `:wastelandId`), the verb is action-specific;
 * when it ends with a collection, GET maps to "list" instead of "get".
 *
 * Examples:
 *   "POST /api/wastelands/:wastelandId/members"              → "members.create"
 *   "GET  /api/wastelands/:wastelandId/members"               → "members.list"
 *   "GET  /api/wastelands/:wastelandId/members/:memberId"     → "members.get"
 *   "PATCH /api/wastelands/:wastelandId/config"               → "config.update"
 */
function deriveHttpEventName(method: string, routePath: string): string {
  const segments = routePath
    .replace(/^\/api\//, '')
    .split('/')
    .filter(Boolean);

  const parentResources = new Set(['wastelands']);
  const meaningful: string[] = [];
  const endsWithParam = segments.length > 0 && segments[segments.length - 1].startsWith(':');

  for (const seg of segments) {
    if (seg.startsWith(':')) continue;
    if (parentResources.has(seg)) continue;
    meaningful.push(seg);
  }

  const verbMap: Record<string, string> = {
    GET: endsWithParam ? 'get' : 'list',
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
 * Wraps an individual HTTP route handler to emit an analytics event.
 * Applied per-route, not as global middleware,
 * so it has access to the matched route pattern.
 *
 * Usage:
 *   app.post('/api/wastelands',
 *     c => instrumented(c, 'POST /api/wastelands',
 *       () => handleCreateWasteland(c, c.req.param())));
 */
export async function instrumented(
  c: Context<WastelandEnv>,
  route: string,
  handler: () => Promise<Response>
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
    error = err instanceof Error ? err.message : String(err);
    // Sentry capture happens in app.onError() — don't double-report
    throw err;
  } finally {
    const durationMs = performance.now() - startTime;
    const [method] = route.split(' ', 1);
    const routePath = route.slice(method.length + 1);
    writeEvent(c.env, {
      event: deriveHttpEventName(method, routePath),
      delivery: 'http',
      route,
      error,
      userId: c.get('kiloUserId'),
      wastelandId: c.req.param('wastelandId'),
      durationMs,
    });
  }
}
