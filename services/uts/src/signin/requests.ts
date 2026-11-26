import type { z } from 'zod';
import { jsonResponse } from '../responses';

/**
 * The JSON calls of the sign-in pages. Each is a `fetch` from a page on the issuer origin, so it
 * must carry that exact `Origin` (and, where the browser sends it, `Sec-Fetch-Site:
 * same-origin`) and a JSON body. A form post or a request from another site, including another
 * host of the same registrable domain, which `SameSite=Lax` would let carry the cookie, is
 * refused before any statement runs.
 */
export async function readSameOriginJson<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  maxBytes: number
): Promise<z.output<Schema> | Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  }
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (
    request.headers.get('Origin') !== new URL(request.url).origin ||
    (fetchSite !== null && fetchSite !== 'same-origin')
  ) {
    return jsonResponse({ error: 'forbidden_origin' }, 403);
  }
  const contentType = request.headers.get('Content-Type') ?? '';
  if (contentType.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return jsonResponse({ error: 'invalid_request' }, 415);
  }
  if (Number(request.headers.get('Content-Length') ?? '0') > maxBytes) {
    return jsonResponse({ error: 'invalid_request' }, 413);
  }
  const text = await request.text();
  if (text.length > maxBytes) return jsonResponse({ error: 'invalid_request' }, 413);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'invalid_request' }, 400);
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : jsonResponse({ error: 'invalid_request' }, 400);
}
