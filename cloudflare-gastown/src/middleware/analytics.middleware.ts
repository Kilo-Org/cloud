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
 * Examples:
 *   "POST /api/towns/:townId/rigs/:rigId/beads"        → "bead.create"
 *   "GET  /api/towns/:townId/rigs/:rigId/beads"         → "bead.list"
 *   "GET  /api/towns/:townId/rigs/:rigId/beads/:beadId" → "bead.get"
 *   "POST /api/towns/:townId/mayor/ensure"              → "mayor.ensure"
 */
function deriveHttpEventName(method: string, routePath: string): string {
  // Strip /api prefix and parameter segments
  const stripped = routePath.replace(/^\/api\//, '').replace(/\/:[^/]+/g, '');

  // Get the meaningful tail segments (skip towns/rigs/users prefixes)
  const segments = stripped.split('/').filter(Boolean);

  // Remove common prefix segments
  const prefixes = new Set(['towns', 'rigs', 'users', 'mayor']);
  const meaningful: string[] = [];
  for (const seg of segments) {
    if (!prefixes.has(seg)) meaningful.push(seg);
  }

  const tail = meaningful.join('.');

  // Map HTTP methods to action verbs
  const verbMap: Record<string, string> = {
    GET: 'get',
    POST: 'create',
    PUT: 'update',
    PATCH: 'update',
    DELETE: 'delete',
  };

  const verb = verbMap[method] ?? method.toLowerCase();

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
      townId: c.req.param('townId') as string | undefined,
      rigId: c.req.param('rigId') as string | undefined,
      agentId: c.req.param('agentId') as string | undefined,
      beadId: c.req.param('beadId') as string | undefined,
      durationMs,
    });
  }
}
