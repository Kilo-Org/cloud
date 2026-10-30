/**
 * Pure rules for the account scope a pushed profile route carries.
 *
 * A profile route carries the organization that owns its profile as a param
 * (`?organizationId=`, `profile-agent-navigation.ts`), while the account the
 * app shows is the persisted selection (`organization-context.tsx`). Switching
 * accounts does not touch navigation, so a detail pushed under one account
 * outlives the switch unless something compares the two.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `profile-scope-model.test.ts`.
 */

/**
 * Whether the profile route has lost its account: the account the app shows
 * changed away from the one this screen was opened under, and the route names
 * that same account.
 *
 * Only the account's own screen can go stale. A profile route carries the
 * organization it shows, which is not always the persisted selection: an agent
 * session renders and opens the profile of its own organization
 * (`session-detail-content.tsx`), and the new-session composer can carry an
 * organization the selection does not (`new-session-organization.ts`). Those
 * screens were opened for a scope of their own and keep working when an account
 * they never showed changes underneath them; the defect is a screen that shows
 * the previous account's profile.
 *
 * A personal profile carries no organization and stays readable in every
 * context, exactly as the profiles list shows personal profiles inside an
 * organization context (`profile-owner-model.ts`, `splitProfilesByOwner`).
 */
export function isProfileScopeStale({
  isLoaded,
  activeOrganizationId,
  openedUnderOrganizationId,
  routeOrganizationId,
}: Readonly<{
  isLoaded: boolean;
  activeOrganizationId: string | null;
  /** The active account the first time the selection resolved for this screen. */
  openedUnderOrganizationId: string | null | undefined;
  routeOrganizationId: string | undefined;
}>): boolean {
  if (!isLoaded || routeOrganizationId === undefined) {
    return false;
  }
  if (openedUnderOrganizationId === undefined) {
    return false;
  }
  return (
    routeOrganizationId === openedUnderOrganizationId &&
    activeOrganizationId !== openedUnderOrganizationId
  );
}

/** How a stale profile screen leaves: to the profiles list, back, or past a pushed list. */
export type StaleProfileScopeExit = 'profiles-list' | 'back' | 'push-list';

/**
 * The way out of a stale profile route.
 *
 * The profiles list is the screen the stale detail was opened from in the
 * Profile tab stack and in both list entries of the root stack, so returning to
 * it truncates the stack with a single pop (`router.dismissTo` dispatches
 * POP_TO over the existing route) while the list is already beneath.
 *
 * POP_TO with no matching route rewrites the stack in one commit — the vendored
 * `StackRouter` keeps `activeRoutes.slice(0, currentIndex)` and appends the
 * list — which is the remove-and-insert shape that crashes the Android native
 * stack (`stack-safe-replace.ts`, KILO-APP-25). So when the list is not beneath,
 * the screen goes back to the route that opened it. A detail with nothing
 * beneath it — restored or deep-linked as the only route of its stack — has
 * neither a pop to make nor a list to reuse: it pushes the list and retires
 * itself after the transition.
 */
export function staleProfileScopeExit({
  routes,
  currentIndex,
  profilesRouteName,
}: Readonly<{
  /** The routes of the Stack this screen is mounted in, bottom first. */
  routes: readonly { readonly name: string }[];
  /** The index of the stale profile route in `routes`. */
  currentIndex: number;
  /** The route name the profiles list registers in this Stack. */
  profilesRouteName: string;
}>): StaleProfileScopeExit {
  const listBeneath = routes
    .slice(0, Math.max(currentIndex, 0))
    .some(route => route.name === profilesRouteName);
  if (listBeneath) {
    return 'profiles-list';
  }
  return currentIndex <= 0 ? 'push-list' : 'back';
}
