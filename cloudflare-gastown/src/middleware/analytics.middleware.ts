import type { Context, Next } from 'hono';
import type { GastownEnv } from '../gastown.worker';
import { writeEvent } from '../util/analytics.util';

/**
 * Captures a high-resolution start timestamp very early in the request
 * lifecycle. Must be the first middleware registered.
 */
export async function timingMiddleware(c: Context<GastownEnv>, next: Next): Promise<void> {
  c.set('requestStartTime', performance.now());
  await next();
}

/**
 * Derive a short event name from an HTTP route pattern.
 *
 * The last non-param segment determines the resource name. When the route
 * ends with a param (e.g. `:beadId`), the verb is action-specific; when
 * it ends with a collection, GET maps to "list" instead of "get".
 *
 * Examples:
 *   "POST /api/towns/:townId/rigs/:rigId/beads"              → "beads.create"
 *   "GET  /api/towns/:townId/rigs/:rigId/beads"               → "beads.list"
 *   "GET  /api/towns/:townId/rigs/:rigId/beads/:beadId"       → "beads.get"
 *   "DELETE /api/towns/:townId/rigs/:rigId/beads/:beadId"     → "beads.delete"
 *   "POST /api/towns/:townId/mayor/ensure"                    → "mayor.ensure"
 *   "PATCH /api/towns/:townId/rigs/:rigId/beads/:beadId/status" → "beads.status.update"
 */
function deriveHttpEventName(method: string, routePath: string): string {
  const segments = routePath
    .replace(/^\/api\//, '')
    .split('/')
    .filter(Boolean);

  // Collect non-param segments after stripping common parent resources
  const parentResources = new Set(['towns', 'rigs', 'users']);
  const meaningful: string[] = [];
  const endsWithParam = segments.length > 0 && segments[segments.length - 1].startsWith(':');

  for (const seg of segments) {
    if (seg.startsWith(':')) continue; // skip params
    if (parentResources.has(seg)) continue; // skip parent resource names
    meaningful.push(seg);
  }

  // Map HTTP methods to action verbs
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
 * Wraps an individual HTTP route handler to emit an analytics event and
 * capture errors to Sentry. Applied per-route, not as global middleware,
 * so it has access to the matched route pattern.
 *
 * Usage:
 *   app.post('/api/towns/:townId/rigs/:rigId/beads',
 *     c => instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/beads',
 *       () => handleCreateBead(c, c.req.param())));
 */
export async function instrumented(
  c: Context<GastownEnv>,
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
      userId: c.get('kiloUserId') || c.get('agentJWT')?.userId,
      townId: c.req.param('townId'),
      rigId: c.req.param('rigId'),
      agentId: c.req.param('agentId'),
      beadId: c.req.param('beadId'),
      durationMs,
    });
  }
}
