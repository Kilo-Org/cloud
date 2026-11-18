/**
 * Pure rules for the account an organization route was opened under.
 *
 * The organization screens resolve the account they show at render time
 * (`useOrgBoundary`), and an account switch only writes that selection
 * (`setOrganizationId`, `organization-context.tsx`): it changes no navigation
 * state. A route opened under one account therefore outlives the switch and
 * silently re-scopes to the next one. The screen then renders whatever the new
 * account may read there — for a plain member the invoices read is refused, so
 * the reader lands on a permanent "access denied" screen instead of the
 * current account's hub.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `organization-scope-model.test.ts`.
 */

/**
 * Whether an organization route lost its account: the account the app shows
 * changed away from the one this route was opened under.
 *
 * Only the account's own screen can go stale. A route that names its own
 * organization — the deep-linked hub (`organization/[org-id].tsx`) and the
 * credit activity opened with `?org=` — is a scope the reader asked for, and
 * it writes that organization as the selection itself (`hub-screen.tsx`,
 * `credit-activity-screen.tsx`). Comparing it against the selection would
 * close the screen the link just opened, so such a route never goes stale.
 *
 * The hubs and the sheets that carry no organization stay open for the same
 * reason the profile list does: the hub re-scopes to the current account on
 * its own, so it stays at the current account's selection.
 */
export function isOrganizationScopeStale({
  isLoaded,
  activeOrganizationId,
  openedUnderOrganizationId,
  namesOwnOrganization,
}: Readonly<{
  isLoaded: boolean;
  activeOrganizationId: string | null;
  /** The account the selection resolved to when this route mounted. */
  openedUnderOrganizationId: string | null | undefined;
  /** Whether the route names its own organization and selects it. */
  namesOwnOrganization: boolean;
}>): boolean {
  if (!isLoaded || namesOwnOrganization || openedUnderOrganizationId === undefined) {
    return false;
  }
  return activeOrganizationId !== openedUnderOrganizationId;
}

/** How a stale organization screen leaves: to the hub, back, or past a pushed hub. */
export type StaleOrganizationScopeExit = 'hub' | 'back' | 'push-hub';

/**
 * The way out of a stale organization route.
 *
 * The reader reaches these screens from the hub, so returning to it truncates
 * the organization Stack with a single pop (`router.dismissTo` dispatches
 * POP_TO over the existing route) while the hub is already beneath.
 *
 * POP_TO with no matching route rewrites the stack in one commit — the
 * remove-and-insert shape that crashes the Android native stack
 * (`stack-safe-replace.ts`). So when the hub is not beneath, the screen goes
 * back to the route that opened it. A stale screen with nothing beneath it —
 * restored or linked as the only route of its stack — has neither a pop to
 * make nor a hub to reuse: it pushes the hub and retires itself after the
 * transition.
 */
export function staleOrganizationScopeExit({
  routes,
  currentIndex,
  hubRouteName,
}: Readonly<{
  /** The routes of the Stack this screen is mounted in, bottom first. */
  routes: readonly { readonly name: string }[];
  /** The index of the stale route in `routes`. */
  currentIndex: number;
  /** The route name the hub registers in this Stack. */
  hubRouteName: string;
}>): StaleOrganizationScopeExit {
  const hubBeneath = routes
    .slice(0, Math.max(currentIndex, 0))
    .some(route => route.name === hubRouteName);
  if (hubBeneath) {
    return 'hub';
  }
  return currentIndex <= 0 ? 'push-hub' : 'back';
}
