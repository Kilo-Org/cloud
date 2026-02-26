import type { Context, Hono } from 'hono';
import type { Supervisor } from '../supervisor';

export function registerHealthRoute(app: Hono, _supervisor: Supervisor): void {
  const handler = (c: Context) => c.json({ status: 'ok' });

  // Public Fly health probe endpoint. Keep response intentionally minimal.
  app.get('/_kilo/health', handler);
  // Compatibility alias to match the same minimal, public health response.
  app.get('/health', handler);
}
