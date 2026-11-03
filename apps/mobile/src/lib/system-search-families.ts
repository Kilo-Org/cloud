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
export const FINDING_HREF_PREFIX = '/(app)/security-agent/';

/**
 * Prefixes of ids the app indexed before a family's route moved. The OS keeps
 * an entry until the app removes it, and a result picked before the next sync
 * is handed back as the id it was indexed with, so an older id must still name
 * the screen it points at now.
 */
const MOVED_HREF_PREFIXES: readonly (readonly [string, string])[] = [
  ['/(app)/(tabs)/(3_profile)/security-agent/', FINDING_HREF_PREFIX],
];

/** An indexed id at the route the app shows today. */
export function canonicalSystemSearchId(id: string): string {
  for (const [from, to] of MOVED_HREF_PREFIXES) {
    if (id.startsWith(from)) {
      return `${to}${id.slice(from.length)}`;
    }
  }
  return id;
}

/** The app-scheme prefix every deeplink carries. */
export const APP_SCHEME = 'kiloapp://';

/** The group segment a deeplink drops: `(app)`. */
const APP_GROUP_PREFIX = '/(app)/';

/** An in-app href with the app-internal group segment dropped. */
export function deeplinkPathFromHref(href: string): string {
  return href.slice(APP_GROUP_PREFIX.length);
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
