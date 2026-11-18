const PUSH_BODY_MAX_LENGTH = 100;

/**
 * Truncates an Expo push body to the maximum length the notification surface
 * renders, appending an ellipsis when content is cut. The ellipsis counts
 * toward the limit so a truncated body never exceeds it.
 */
export function truncatePushBody(text: string): string {
  if (text.length <= PUSH_BODY_MAX_LENGTH) return text;
  return `${text.slice(0, PUSH_BODY_MAX_LENGTH - 3)}...`;
}
