import type { Context, Next } from 'hono';
import type { WastelandEnv } from '../wasteland.worker';
/**
 * Captures a high-resolution start timestamp very early in the request
 * lifecycle. Must be the first middleware registered.
 */
export declare function timingMiddleware(c: Context<WastelandEnv>, next: Next): Promise<void>;
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
export declare function instrumented(c: Context<WastelandEnv>, route: string, handler: () => Promise<Response>): Promise<Response>;
