import type { NotFoundHandler } from 'hono';

/**
 * Create a Hono `app.notFound` handler that returns a 404 JSON response.
 */
export function createNotFoundHandler(): NotFoundHandler {
  return c => {
    return c.json({ error: 'Not found' }, 404);
  };
}
