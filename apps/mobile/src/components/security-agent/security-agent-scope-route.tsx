import { type Href, useLocalSearchParams } from 'expo-router';
import { createContext, type ReactNode, useContext } from 'react';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { parseSecurityScope } from '@/lib/security-agent';

/**
 * The scope the `[scope]` layout validated, for the routes beneath it.
 *
 * A route beneath the layout is not always given the segment itself. Expo
 * Router's `withAnchor` navigation — the relaunch repair uses it to reopen the
 * recorded screen — seeds the layout's `index` anchor as a sibling of the
 * target route, and that seeded route carries no params: measured on Android
 * after a relaunch onto `security-agent/personal/settings`, the layout read
 * `personal` while the `index` route's own `useLocalSearchParams()` was `{}`.
 * Popping the recorded screen focused that sibling, its own scope read was
 * undefined, and Back landed on the "Page not found" state instead of the
 * dashboard. The layout has already validated the segment the branch belongs
 * to, so a route with no param of its own renders under that scope.
 */
const SecurityAgentScopeContext = createContext<string | null>(null);

export function SecurityAgentScopeProvider({
  scope,
  children,
}: Readonly<{ scope: string; children: ReactNode }>) {
  return <SecurityAgentScopeContext value={scope}>{children}</SecurityAgentScopeContext>;
}

/**
 * The validated `[scope]` segment, read by every route under `[scope]/`.
 *
 * The layout validates too, but a layout keeps the segment it mounted with when
 * a warm link replaces it: a route whose own param is `undefined` (a navigation
 * that lost it) or any other impossible value would then render under a layout
 * that passed, and its queries would reach the organization procedures with a
 * non-uuid owner. Reading the route's own param closes that gap, so an
 * impossible scope always lands on the route's invalid state and never queries.
 * An absent param is the anchor-seeded sibling described on the context above,
 * where the layout's validated scope is the only scope there is.
 */
export function useSecurityAgentScope(): string | null {
  const { scope } = useLocalSearchParams<{ scope?: string }>();
  const layoutScope = useContext(SecurityAgentScopeContext);
  if (scope === undefined) {
    return layoutScope;
  }
  return parseSecurityScope(scope);
}

/** The route's own invalid state, for a `[scope]` segment that names no scope. */
export function InvalidSecurityScopeRoute() {
  return <InvalidRouteState backTo={'/(app)/security-agent' as Href} />;
}
