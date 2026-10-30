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
 * Whether the profile scope a route carries belongs to an account the app is no
 * longer showing. Only a route that names an organization can go stale: a
 * personal profile has no organization id and stays readable in every context,
 * exactly as the profiles list shows personal profiles inside an organization
 * context (`profile-owner-model.ts`, `splitProfilesByOwner`). An unresolved
 * selection is never stale — the stored account has not been read yet.
 */
export function isProfileScopeStale({
  isLoaded,
  activeOrganizationId,
  routeOrganizationId,
}: Readonly<{
  isLoaded: boolean;
  activeOrganizationId: string | null;
  routeOrganizationId: string | undefined;
}>): boolean {
  return (
    isLoaded && routeOrganizationId !== undefined && routeOrganizationId !== activeOrganizationId
  );
}

/** How a stale profile screen leaves: to the profiles list, or back one route. */
export type StaleProfileScopeExit = 'profiles-list' | 'back';

/**
 * The way out of a stale profile route.
 *
 * The profiles list is the screen the stale detail was opened from in the
 * Profile tab stack and in both list entries of the root stack, so returning to
 * it truncates the stack with a single pop (`router.dismissTo` dispatches
 * POP_TO over the existing route). When the list is not beneath — a profile
 * detail opened from an agent session in the root stack — the same call would
 * have to remove the current route and insert the list in one commit, the
 * native-stack swap `stack-safe-replace.ts` avoids on Android, so the screen
 * goes back to the route that opened it instead. A detail with nothing beneath
 * it has no pop to make, and the list is the only screen left to show.
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
  if (listBeneath || currentIndex <= 0) {
    return 'profiles-list';
  }
  return 'back';
}
