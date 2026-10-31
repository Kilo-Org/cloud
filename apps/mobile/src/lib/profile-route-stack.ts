/**
 * Rules for the profile screens' place in a Stack.
 *
 * The profile screens are siblings of one Stack (`profile-management/index`,
 * `profile-management/[profileId]/index`, `profile-management/[profileId]/agents`,
 * …), not a nested navigator, so nothing builds the screens above them. A push
 * from the profiles list always has the list beneath it, and the overview is
 * what pushes a section. A deep link, a relaunch restore, or a link delivered
 * while another app stack screen is open pushes ONE screen: Back then leaves
 * the profile tree at once for whatever happened to be beneath — a session, the
 * new-session composer — instead of stepping through the screens the reader came
 * through on the way in.
 *
 * These rules name the parents a profile screen needs, and mark the pushes that
 * rebuild them so those pushes land without their own transitions.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `profile-route-stack.test.ts`.
 */

import { type Href } from 'expo-router';
import { z } from 'zod';

/**
 * The query parameter a rebuilt push carries.
 *
 * A screen entered this way sets its transition to `none` (the layout reads the
 * same parameter), so rebuilding the stack does not slide three screens past
 * the reader, and a rebuilt screen never rebuilds again: the repairs cannot
 * cascade.
 */
export const PROFILE_STACK_REBUILT_PARAM = 'stackRebuilt';

/**
 * The query parameter that marks a profile screen opened on purpose from a
 * screen outside the profile tree.
 *
 * An agent session opens the profile of its own organization, and the
 * new-session composer opens the repository-to-profile defaults. In both, Back
 * belongs to the screen that opened the form, not to the profiles list the
 * reader never came from, so the marker keeps the stack repair away from them.
 */
const PROFILE_OPENED_FROM_PARAM = 'openedFrom';

/** Who opened a profile screen from outside the profile tree. */
export type ProfileExternalOpener = 'session' | 'composer';

/** The marker's schema: absent, or one of the openers that opt out. */
const openedFromSchema = z.object({
  [PROFILE_OPENED_FROM_PARAM]: z.enum(['session', 'composer']).optional(),
});

/**
 * The opener a profile screen's params name, or null when the profile tree
 * itself opened the screen.
 */
export function profileExternalOpener(params: unknown): ProfileExternalOpener | null {
  const parsed = openedFromSchema.safeParse(params);
  if (!parsed.success) {
    return null;
  }
  return parsed.data[PROFILE_OPENED_FROM_PARAM] ?? null;
}

/** The query fragment that marks a deliberately opened profile screen. */
export function openedFromQuery(opener: ProfileExternalOpener): string {
  return `${PROFILE_OPENED_FROM_PARAM}=${opener}`;
}

/** A route parameter value as the navigator holds it: once, or repeated. */
const routeParamValueSchema = z.union([z.string(), z.array(z.string())]);

/** A rebuilt push's marker, at the shape a route's params really have. */
const rebuiltEntrySchema = z.object({
  [PROFILE_STACK_REBUILT_PARAM]: routeParamValueSchema.optional(),
});

/** A route's href as the app builds it: a path string, or its object form. */
const hrefPathSchema = z.union([
  z.string(),
  z.object({ pathname: z.string() }).transform(value => value.pathname),
]);

/** Whether a route's params say it was pushed while its parents were rebuilt. */
export function isRebuiltProfileEntry(params: unknown): boolean {
  const parsed = rebuiltEntrySchema.safeParse(params);
  if (!parsed.success) {
    return false;
  }
  const value = parsed.data[PROFILE_STACK_REBUILT_PARAM];
  const first = Array.isArray(value) ? value[0] : value;
  return first === '1';
}

/**
 * The href of a screen pushed while its parents are rebuilt.
 *
 * Every profile href this app builds is a path string (`profile-agent-navigation.ts`);
 * the object form is flattened to its pathname, so the parameter always lands
 * in the query.
 */
export function withRebuiltParents(href: Href): Href {
  const path = hrefPathSchema.parse(href);
  const separator = path.includes('?') ? '&' : '?';
  // One assertion, below the parse: the path itself is exactly what the router
  // resolves, and `Href`'s typed-route union is a set of literals the compiler
  // cannot derive from a string built at run time.
  return `${path}${separator}${PROFILE_STACK_REBUILT_PARAM}=1` as Href;
}

/**
 * The screen options a profile route registers in its layout.
 *
 * A push made by the stack repair lands without its own transition, so building
 * the missing parents does not slide three screens past the reader; every other
 * entry keeps the navigator's default animation.
 */
export function profileStackRepairScreenOptions({
  route,
}: Readonly<{ route: { params?: unknown } }>): { animation?: 'none' } {
  return isRebuiltProfileEntry(route.params) ? { animation: 'none' } : {};
}

/**
 * The path a screen's href resolves to, in the form `usePathname()` reports it:
 * without the router's group segments (`(app)`, `(tabs)`) and without the query.
 *
 * The repair compares this with the pathname the router reports for the focused
 * screen, so a screen decides for itself and not for a sibling that happens to
 * sit on the same Stack.
 */
export function profileScreenPath(href: Href): string {
  const path = hrefPathSchema.parse(href);
  const [withoutQuery = ''] = path.split('?');
  const segments = withoutQuery
    .split('/')
    .filter(part => part.length > 0 && !/^\(.+\)$/.test(part));
  return `/${segments.join('/')}`;
}

/**
 * Whether a profile screen is the one the router reports as focused.
 *
 * A route renders before the navigator's state lists it as current, so a screen
 * that repaired from its own first render read the PREVIOUS screen as current
 * and rebuilt the wrong stack. Deciding only once the pathname is this screen's
 * own is what makes the repair act on the right route.
 */
export function isFocusedProfileScreen({
  pathname,
  screenPath,
  currentRouteName,
  profileRouteNames,
  currentParams,
}: Readonly<{
  /** The pathname the router reports for the focused screen. */
  pathname: string;
  /** This screen's own path (`profileScreenPath`). */
  screenPath: string;
  /** The route name at the top of the Stack. */
  currentRouteName: string;
  /** Every route name of the profile tree in this Stack. */
  profileRouteNames: readonly string[];
  /** The top route's params, which carry the repair's own marker. */
  currentParams?: unknown;
}>): boolean {
  return (
    pathname === screenPath &&
    profileRouteNames.includes(currentRouteName) &&
    !isRebuiltProfileEntry(currentParams)
  );
}

/** Which screens must sit beneath a profile screen. */
export type ProfileStackParents = {
  /** The profiles list (`getProfilesPath`). */
  list: boolean;
  /** The profile overview (`getProfileOverviewPath`). */
  overview: boolean;
};

/** The profile screens below the list: they only need the list beneath them. */
export const LIST_CHILD_PARENTS: ProfileStackParents = { list: true, overview: false };

/** The profile overview itself: one parent, the list it is opened from. */
export const OVERVIEW_PARENTS: ProfileStackParents = { list: true, overview: false };

/** The profile sections: the list, then the overview that pushes them. */
export const SECTION_PARENTS: ProfileStackParents = { list: true, overview: true };

/**
 * Which of a screen's parents are missing from the Stack beneath it.
 *
 * A parent counts only when it sits BELOW the screen: the same screen name
 * higher in the stack is the screen the reader moved on from, not a parent.
 */
export function missingProfileStackParents({
  routes,
  currentIndex,
  listRouteName,
  overviewRouteName,
}: Readonly<{
  /** The routes of the Stack this screen is mounted in, bottom first. */
  routes: readonly { readonly name: string }[];
  /** The index of this screen in `routes`. */
  currentIndex: number;
  /** The route name the profiles list registers in this Stack. */
  listRouteName: string;
  /** The route name the profile overview registers in this Stack. */
  overviewRouteName: string;
}>): ProfileStackParents {
  const beneath = routes.slice(0, Math.max(currentIndex, 0));
  return {
    list: !beneath.some(route => route.name === listRouteName),
    overview: !beneath.some(route => route.name === overviewRouteName),
  };
}

/** Which parents the current screen still has to push, in stack order. */
export function parentsToPush(
  required: ProfileStackParents,
  missing: ProfileStackParents
): ProfileStackParents {
  return {
    list: required.list && missing.list,
    overview: required.overview && missing.overview,
  };
}

export function hasParentsToPush(toPush: ProfileStackParents): boolean {
  return toPush.list || toPush.overview;
}

export function profileStackRepair({
  routes,
  currentIndex,
  openedOutsideProfileTree,
  parents,
  listRouteName,
  overviewRouteName,
}: Readonly<{
  routes: readonly { readonly name: string }[];
  currentIndex: number;
  /** Whether an outside screen deliberately opened this route. */
  openedOutsideProfileTree: boolean;
  /** The parents this screen needs. */
  parents: ProfileStackParents;
  listRouteName: string;
  overviewRouteName: string;
}>): ProfileStackParents {
  if (openedOutsideProfileTree) {
    return { list: false, overview: false };
  }
  return parentsToPush(
    parents,
    missingProfileStackParents({ routes, currentIndex, listRouteName, overviewRouteName })
  );
}
