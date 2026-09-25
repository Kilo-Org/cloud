import type { Context } from 'hono';

/**
 * Safely parses the request body as JSON, returning null on malformed input
 * instead of throwing (which would bypass Zod validation and produce a 500).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseJsonBody(c: Context<any>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}
