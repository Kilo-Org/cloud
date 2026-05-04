import { Hono } from 'hono';
import type { Env } from './env';
import { api } from './routes/api';

/**
 * Main Hono app. Only mounts `/api/model-eval-ingest/*` — every route
 * under that path is HMAC-gated by the middleware inside `api`.
 *
 * The worker is single-purpose: accept promotions from the bench service
 * and expose lookup endpoints used by the same bench service. It is not
 * reachable from end-user browsers.
 */
export const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', c => c.json({ status: 'ok' }));

app.route('/api/model-eval-ingest', api);

// Catch-all so unknown paths return a structured 404 rather than Hono's
// default HTML response. Keeps logs + callers sane.
app.notFound(c => c.json({ success: false, error: 'Not found' }, 404));
