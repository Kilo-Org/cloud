/**
 * The route families the phone's own search indexes, as the app href prefixes
 * and the `kiloapp://` link shapes that name them.
 *
 * Pure and dependency-free on purpose: `deep-link-launch.ts` reads
 * `isSystemSearchFamilyLink` at module scope, where importing a document
 * builder would pull React Native into the pending slot's unit-test graph.
 * `system-search-entries.ts` owns the id patterns and the builders and imports
 * the prefixes from here, so the two views of "an indexed route" cannot drift.
 */

/** The in-app route prefix of each indexed family, in read-back order. */
export const SESSION_HREF_PREFIX = '/(app)/agent-chat/';
export const PULL_REQUEST_HREF_PREFIX = '/(app)/pr-review/';
export const FINDING_HREF_PREFIX = '/(app)/(tabs)/(3_profile)/security-agent/';

/** The app-scheme prefix every deeplink carries. */
export const APP_SCHEME = 'kiloapp://';

/** The group segments a deeplink drops: `(app)` and the profile tab group. */
const APP_GROUP_PREFIX = '/(app)/';
const PROFILE_TABS_GROUP_PREFIX = '(tabs)/(3_profile)/';

/** An in-app href with the app-internal group segments dropped. */
export function deeplinkPathFromHref(href: string): string {
  const withoutAppGroup = href.slice(APP_GROUP_PREFIX.length);
  return withoutAppGroup.startsWith(PROFILE_TABS_GROUP_PREFIX)
    ? withoutAppGroup.slice(PROFILE_TABS_GROUP_PREFIX.length)
    : withoutAppGroup;
}

/** The deeplink path of each indexed family, in the id order. */
export const INDEXED_LINK_PREFIXES: readonly string[] = [
  deeplinkPathFromHref(SESSION_HREF_PREFIX),
  deeplinkPathFromHref(PULL_REQUEST_HREF_PREFIX),
  deeplinkPathFromHref(FINDING_HREF_PREFIX),
];

/**
 * Whether a raw app-scheme URL names one of the families the phone's own
 * search indexes.
 *
 * Android delivers a tap on an indexed result as the entry's `kiloapp://`
 * link, so the app scheme is the transport a system-search result arrives on:
 * an app-scheme URL that names an indexed family is the identifier of a result
 * the app itself indexed, and it belongs to the session that indexed it, not
 * to whichever account happens to be signed in when it opens.
 */
export function isSystemSearchFamilyLink(url: string): boolean {
  if (!url.startsWith(APP_SCHEME)) {
    return false;
  }
  const path = url.slice(APP_SCHEME.length).replace(/^\/+/, '');
  return INDEXED_LINK_PREFIXES.some(prefix => path.startsWith(prefix));
}
