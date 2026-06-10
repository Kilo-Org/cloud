/**
 * Helpers for the Local News briefing section. Pure logic only — the
 * impure call into `webSearch.search()` lives in the `collectLocalNews`
 * function in `index.ts` and consumes the tier list returned by
 * `buildLocalNewsTiers` below.
 *
 * The Local News feature is opt-in via the user's interest topics. When
 * "Local News" is one of the selected topics, `collectLocalNews` runs;
 * otherwise the briefing skips this source entirely.
 *
 * Only an *explicit* user-provided location drives queries. The user's
 * IANA timezone is captured as soft context (so we can mention it in
 * the "no location set" message) but is never used as a query source.
 * Timezone city names like `Los_Angeles` are misleading as a stand-in
 * for "where the user lives" — `America/Los_Angeles` covers the entire
 * US Pacific coast.
 */

/**
 * Interest-topic string that triggers the Local News source. Mirrors
 * the preset constant in
 * `apps/web/src/lib/kiloclaw/morning-briefing-interests.ts`. This file
 * is across the service boundary so we keep our own copy. If the
 * preset label changes there, update this string too.
 */
export const LOCAL_NEWS_INTEREST_LABEL = 'Local News';

/**
 * Minimum number of distinct items the brief wants to surface before
 * stopping the tier escalation. If the first tier returns ≥ this many
 * unique results, we stop there.
 */
export const LOCAL_NEWS_MIN_ITEMS = 3;

/**
 * Hard cap on items rendered in the section. Even if a later tier
 * returns many results, we slice down to this count.
 */
export const LOCAL_NEWS_MAX_ITEMS = 10;

/**
 * Resolved location for the brief. `explicit` is the only kind that
 * drives queries. `none` short-circuits with a nudge message; the
 * optional `timezone` field decorates that message ("your timezone is
 * America/Los_Angeles") to help the user understand what we know vs
 * what we need.
 */
export type LocationContext =
  | { kind: 'explicit'; raw: string; displayLabel: string }
  | { kind: 'none'; timezone: string | null };

/**
 * Resolve the effective location the brief should use. Reads the
 * explicit `KILOCLAW_USER_LOCATION` env var (set during onboarding via
 * the weather-location step). When unset, returns `kind: 'none'` along
 * with the user's IANA timezone (captured separately during onboarding)
 * so the no-location message can reference it for context.
 *
 * Note: timezone is *not* used as a query source. IANA timezone city
 * names (`America/Los_Angeles`, `America/New_York`, `America/Chicago`)
 * span thousands of miles in any direction and would produce news from
 * a location hundreds of miles away from where the user actually lives.
 * Better to ask the user to set a precise location than to pretend.
 */
export function resolveLocationContext(env: NodeJS.ProcessEnv = process.env): LocationContext {
  const raw = env.KILOCLAW_USER_LOCATION?.trim();
  if (raw && raw.length > 0) {
    return { kind: 'explicit', raw, displayLabel: raw };
  }
  const timezone = env.KILOCLAW_USER_TIMEZONE?.trim();
  return {
    kind: 'none',
    timezone: timezone && timezone.length > 0 ? timezone : null,
  };
}

/**
 * Resolve the effective location with an in-process override.
 *
 * Priority (highest to lowest):
 *   1. `storedUserLocation` from the plugin's `config.json`. Written
 *      by the Settings → Morning Briefing → Location editor via the
 *      `/api/plugins/kiloclaw-morning-briefing/user-location` route.
 *      Takes effect on the next brief without needing a container
 *      restart, mirroring how `interestTopics` propagates.
 *   2. The env var `KILOCLAW_USER_LOCATION` (set at provision time
 *      from the onboarding weather step).
 *   3. `kind: 'none'`, with the IANA timezone surfaced as soft
 *      context for the no-location nudge.
 *
 * `storedUserLocation` is trimmed; whitespace-only counts as unset
 * and falls through to the env-var path.
 */
export function resolveLocationContextWithOverride(
  storedUserLocation: string | null,
  env: NodeJS.ProcessEnv = process.env
): LocationContext {
  const trimmed = storedUserLocation?.trim();
  if (trimmed && trimmed.length > 0) {
    return { kind: 'explicit', raw: trimmed, displayLabel: trimmed };
  }
  return resolveLocationContext(env);
}

/**
 * Render the `## Local News (...)` section title based on the source
 * quality. The parenthetical tells the user which location signal was
 * used so they can see at a glance whether the brief is running off
 * their explicit location or has nothing to work with.
 */
export function buildLocalNewsSectionTitle(ctx: LocationContext): string {
  switch (ctx.kind) {
    case 'explicit':
      return `📰 Local News (${ctx.displayLabel})`;
    case 'none':
      return '📰 Local News';
  }
}

/**
 * The query strings issued per retry tier. Only the `explicit` context
 * produces queries; `none` returns an empty list so the caller can
 * short-circuit to the nudge message.
 *
 * Explicit-location tiers carry "within N miles" framing; the search
 * engine may or may not respect it, but it's the strongest hint we
 * can pass through the query string (the `webSearch.search` interface
 * does not expose provider-native location/radius params today).
 */
export function buildLocalNewsTiers(ctx: LocationContext): readonly string[] {
  switch (ctx.kind) {
    case 'explicit': {
      const loc = ctx.raw;
      return [
        `local news in ${loc} within 100 miles from the last 24 hours`,
        `local news in ${loc} within 250 miles from the last 3 days`,
        `local news in ${loc} from the last 7 days`,
        `top news in ${loc} region from the last 7 days`,
      ];
    }
    case 'none':
      return [];
  }
}

/**
 * A single accumulated news item. The result shape mirrors
 * `WebResultSummary` from `web-utils.ts` since both come from the same
 * `webSearch.search()` runtime. The summary field is not rendered
 * inline today (kept for future use) — current line format is just
 * `- [title](url)` like the existing web-search section.
 */
export type LocalNewsItem = {
  title: string;
  url: string;
  summary?: string;
};

/**
 * Dedupe `fresh` against URLs already present in `existing`, returning
 * only the items new to the accumulated set. Mutates neither input.
 * Items with empty URLs are dropped (they're useless as links).
 */
export function dedupeByUrl<T extends { url: string }>(
  fresh: readonly T[],
  existing: readonly T[]
): T[] {
  const seen = new Set(existing.map(item => item.url));
  const result: T[] = [];
  for (const item of fresh) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    result.push(item);
  }
  return result;
}

/** Markdown bullet for a single news item. */
export function formatLocalNewsLine(item: LocalNewsItem): string {
  return `- [${item.title}](${item.url})`;
}

/**
 * Italic one-line empty state for the Local News section when a
 * location is set but no nearby news turned up. Wrapped in `_..._` so
 * it renders italic and survives the channel flattener.
 */
export function buildLocalNewsEmptyLine(ctx: LocationContext): string {
  const where = ctx.kind === 'explicit' ? ctx.displayLabel : 'your area';
  return `_No notable news near ${where} from the last 24h._`;
}

/**
 * Short TL;DR fragment for the briefing header. Returns an empty string
 * when there is nothing to count so the caller can drop it.
 */
export function formatLocalNewsTldr(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 local headline' : `${count} local headlines`;
}

/** Source-status footer summary when no explicit location is set. */
export const LOCAL_NEWS_NO_LOCATION_SUMMARY =
  'No location configured — set one in Settings → Morning Briefing to enable local news';
