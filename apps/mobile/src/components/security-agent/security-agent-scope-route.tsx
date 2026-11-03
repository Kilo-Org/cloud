import { type Href, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { parseSecurityScope } from '@/lib/security-agent';

/**
 * The validated `[scope]` segment, read by every route under `[scope]/`.
 *
 * The layout validates too, but a layout keeps the segment it mounted with when
 * a warm link replaces it: a route whose own param is `undefined` (a navigation
 * that lost it) or any other impossible value would then render under a layout
 * that passed, and its queries would reach the organization procedures with a
 * non-uuid owner. Reading the route's own param closes that gap, so an
 * impossible scope always lands on the route's invalid state and never queries.
 */
export function useSecurityAgentScope(): string | null {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return parseSecurityScope(scope);
}

/** The route's own invalid state, for a `[scope]` segment that names no scope. */
export function InvalidSecurityScopeRoute() {
  return <InvalidRouteState backTo={'/(app)/security-agent' as Href} />;
}
