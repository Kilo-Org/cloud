/**
 * Reads what a fetch double recorded. These doubles are written by this repository's production
 * code, which always sends a JSON string body, so a body of another kind means a broken fixture
 * rather than a value to stringify.
 */
export function readBodyText(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') {
    throw new Error(`Expected the request body to be a string, received ${typeof body}`);
  }
  return body;
}

/** The parsed JSON of a recorded request body, typed so callers narrow it themselves. */
export function readJsonBody(body: BodyInit | null | undefined): unknown {
  return JSON.parse(readBodyText(body));
}

/** The URL a fetch double was called with, as the caller's string. */
export function requestUrlOf(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}
