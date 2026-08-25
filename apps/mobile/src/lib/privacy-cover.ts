/**
 * Whether the active route must be hidden from OS snapshots (Recents / app
 * switcher) and from screen capture. Home and KiloClaw surfaces stay visible;
 * every other sensitive surface (profile, login, agent sessions, PR review,
 * Kilo Pass, device sessions) is covered.
 *
 * Consumes the raw tokens from expo-router's `useSegments()`: it reports
 * `login`, not `/login`, so these are token matches, not slash-prefixed paths.
 */

const KILOCLAW_MARKER = 'kiloclaw';
const HOME_SEGMENT = '(0_home)';
const PROFILE_SEGMENT = '(3_profile)';
const COVERED_TOKENS: ReadonlySet<string> = new Set([
  'login',
  'agent-chat',
  'pr-review',
  'kilo-pass',
  'device-sessions',
]);

export function isPrivacyCoverRoute(segments: readonly string[]): boolean {
  // KiloClaw owns its own snapshots and must never be covered, even when it
  // sits under a profile-like path.
  if (segments.some(segment => segment.includes(KILOCLAW_MARKER))) {
    return false;
  }
  if (segments.includes(HOME_SEGMENT)) {
    return false;
  }
  return (
    segments.includes(PROFILE_SEGMENT) || segments.some(segment => COVERED_TOKENS.has(segment))
  );
}
