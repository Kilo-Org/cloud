import type { Context } from 'hono';

/**
 * Safely parses the request body as JSON, returning null on missing or
 * malformed input instead of throwing (which would bypass Zod validation
 * and produce a 500).
 *
 * Do not call text()/json() on an empty body: in the Workers runtime an
 * empty POST with Content-Type application/json can surface as a Response
 * with status 0, which Hono then rejects as an invalid status (500) before
 * the handler can return 400.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseJsonBody(c: Context<any>): Promise<unknown> {
  try {
    const raw = c.req.raw;
    if (raw.body === null) return null;
    const contentLength = c.req.header('content-length');
    if (contentLength === '0') return null;
    const text = await c.req.text();
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
