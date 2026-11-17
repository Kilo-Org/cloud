/**
 * Copy for the profile size limits.
 *
 * Every `MAX_*_LENGTH`, `MAX_*_SIZE` and `MAX_*_TOTAL` limit here is enforced
 * with `String#length`, which counts UTF-16 code units. That is not a byte
 * count: a non-ASCII document is several times larger on disk than the number
 * shown to the user, so the messages must name characters. The limits that
 * really measure bytes (encoded request bodies, ZIP members, expanded archives)
 * word their own messages.
 */
export const LIMIT_UNIT = 'characters';

/** An over-limit message, worded in one place so the contracts cannot drift. */
export function overLimitMessage(subject: string, limit: number): string {
  return `${subject} exceeds ${limit} ${LIMIT_UNIT}`;
}

/** A message for a running total that passed its own cap. */
export function overTotalMessage(subject: string, total: number, limit: number): string {
  return `${subject} total ${total} ${LIMIT_UNIT}, over the limit of ${limit} ${LIMIT_UNIT}`;
}
