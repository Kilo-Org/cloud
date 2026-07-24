/** Max pending programmatic `setNativeProps` values retained for echo matching. */
export const PR_LINK_INPUT_ECHO_FIFO_CAP = 4;

type ConsumePrLinkInputEchoResult =
  | { kind: 'echo'; pending: readonly string[] }
  | { kind: 'edit'; pending: readonly string[] };

/**
 * Record a value about to be written via `setNativeProps`.
 * Drops the oldest entries when the FIFO exceeds `cap` so delayed
 * native echoes remain matchable without unbounded growth.
 */
export function pushPrLinkInputEcho(
  pending: readonly string[],
  text: string,
  cap: number = PR_LINK_INPUT_ECHO_FIFO_CAP
): string[] {
  const next = [...pending, text];
  if (next.length <= cap) {
    return next;
  }
  return next.slice(next.length - cap);
}

/**
 * Classify an `onChangeText` value against pending programmatic writes.
 *
 * - Membership match → programmatic echo: remove that one entry (first match),
 *   leave remaining pending intact so later/out-of-order echoes still match.
 * - No match → real user edit: leave the FIFO unchanged so a delayed echo of an
 *   earlier paste is still consumed and cannot clobber the newer edit.
 */
export function consumePrLinkInputEcho(
  pending: readonly string[],
  value: string
): ConsumePrLinkInputEchoResult {
  const index = pending.indexOf(value);
  if (index === -1) {
    return { kind: 'edit', pending };
  }
  return {
    kind: 'echo',
    pending: [...pending.slice(0, index), ...pending.slice(index + 1)],
  };
}
