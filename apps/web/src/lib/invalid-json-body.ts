/**
 * Sentinel returned by {@link readJsonBody} when the request body cannot be parsed.
 *
 * A unique symbol (rather than `undefined`) keeps parse failure distinguishable from
 * any value a JSON document can produce.
 */
export const INVALID_JSON = Symbol('INVALID_JSON');

type JsonBodyRequest = { json(): Promise<unknown> };

/**
 * Read and parse a JSON request body, returning {@link INVALID_JSON} when parsing fails.
 *
 * Callers compare with the sentinel directly; do not treat the result as a plain value
 * without checking for it first.
 */
export async function readJsonBody(
  request: JsonBodyRequest
): Promise<unknown | typeof INVALID_JSON> {
  try {
    return await request.json();
  } catch {
    return INVALID_JSON;
  }
}
