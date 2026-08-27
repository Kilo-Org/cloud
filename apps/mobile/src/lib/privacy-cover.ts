/**
 * Whether the active route must be hidden from OS snapshots (Recents / app
 * switcher) and from screen capture. Only the profile tab qualifies: it is the
 * one surface that shows the credit balance and account identity. Everything
 * else — home, agents, KiloClaw, PR review, login — is not worth the cost of a
 * blank Recents card.
 *
 * Consumes the raw tokens from expo-router's `useSegments()`: it reports
 * `(3_profile)`, not `/(3_profile)`, so this is a token match, not a
 * slash-prefixed path match.
 */

const PROFILE_SEGMENT = '(3_profile)';

export function isPrivacyCoverRoute(segments: readonly string[]): boolean {
  return segments.includes(PROFILE_SEGMENT);
}
