/**
 * Names a gateway decline that replaced a model answer the gateway already
 * accounted. `x-should-retry` reports the replacement's own condition, such as an
 * output guardrail that was unavailable, not the charge, so a client that must not
 * pay twice reads this marker before it repeats the request.
 *
 * Pure: no `server-only`, so the gateway handler and a calling route share one name.
 */

export const REPLACED_ANSWER_HEADER = 'x-kilo-replaced-answer';

/** Anything that answers a header by name: `Headers`, a request, or a fake in a test. */
export type HeaderReader = { get(name: string): string | null };

/** Whether this decline replaced an answer that the gateway may already have charged. */
export function replacedChargedAnswer(headers: HeaderReader): boolean {
  return headers.get(REPLACED_ANSWER_HEADER) === 'true';
}
