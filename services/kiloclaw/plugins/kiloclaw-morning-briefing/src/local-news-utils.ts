/**
 * Helpers for the Local News briefing section. Pure logic only — the
 * impure call into `webSearch.search()` lives in the `collectLocalNews`
 * function in `index.ts` and consumes the tier list returned by
 * `buildLocalNewsTiers` below.
 *
 * The Local News feature is opt-in via the user's interest topics. When
 * "Local News" is one of the selected topics, `collectLocalNews` runs;
 * otherwise the briefing skips this source entirely.
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
 * Effective location the brief is going to query against. The
 * `explicit` source comes straight from `KILOCLAW_USER_LOCATION`
 * (set during onboarding via the weather-location step). The
 * `timezone-derived` source falls back to the city portion of
 * `KILOCLAW_USER_TIMEZONE` (e.g. `America/Los_Angeles` →
 * `Los Angeles`); this is a much coarser hint and the queries are
 * adapted to drop radius language since we don't actually know
 * coordinates. The `none` case happens when neither env var is set;
 * the brief surfaces a "set a location" message in the section
 * instead of running any queries.
 */
export type LocationContext =
  | { kind: 'explicit'; raw: string; displayLabel: string }
  | {
      kind: 'timezone-derived';
      timezone: string;
      cityHint: string;
      displayLabel: string;
    }
  | { kind: 'none' };

/**
 * Extract a human-readable city hint from an IANA timezone string.
 * Returns `null` for malformed inputs or single-segment timezones.
 *
 * - `America/Los_Angeles` → `Los Angeles`
 * - `Europe/London` → `London`
 * - `America/Argentina/Buenos_Aires` → `Buenos Aires` (last segment)
 * - `UTC` → null (single segment, no city)
 * - empty / null → null
 */
export function extractCityFromTimezone(timezone: string | undefined | null): string | null {
  if (!timezone) return null;
  const parts = timezone.trim().split('/');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  if (!last) return null;
  const city = last.replace(/_/g, ' ').trim();
  return city.length > 0 ? city : null;
}

/**
 * Resolve the effective location the brief should use. Reads two env
 * vars in priority order:
 *
 * 1. `KILOCLAW_USER_LOCATION` (free text from onboarding weather step)
 * 2. `KILOCLAW_USER_TIMEZONE` (IANA; fall back to the city portion)
 *
 * Both are plumbed by `services/kiloclaw/src/gateway/env.ts` at
 * provision time. Live edits to user location (post-onboarding) need
 * a gateway env patch to be observed here.
 */
export function resolveLocationContext(env: NodeJS.ProcessEnv = process.env): LocationContext {
  const raw = env.KILOCLAW_USER_LOCATION?.trim();
  if (raw && raw.length > 0) {
    return { kind: 'explicit', raw, displayLabel: raw };
  }

  const timezone = env.KILOCLAW_USER_TIMEZONE?.trim();
  if (timezone) {
    const cityHint = extractCityFromTimezone(timezone);
    if (cityHint) {
      return {
        kind: 'timezone-derived',
        timezone,
        cityHint,
        displayLabel: `${cityHint} area, from timezone`,
      };
    }
  }

  return { kind: 'none' };
}

/**
 * Render the `## Local News (...)` section title based on the source
 * quality. The parenthetical tells the user which location signal was
 * used so they can see at a glance whether the brief is running off
 * their explicit location or just their timezone.
 */
export function buildLocalNewsSectionTitle(ctx: LocationContext): string {
  switch (ctx.kind) {
    case 'explicit':
      return `Local News (${ctx.displayLabel})`;
    case 'timezone-derived':
      return `Local News (${ctx.displayLabel})`;
    case 'none':
      return 'Local News';
  }
}

/**
 * The query strings issued per retry tier. The brief calls
 * `webSearch.search()` with each query in order and accumulates unique
 * results (deduped by URL) until it has `LOCAL_NEWS_MIN_ITEMS` or has
 * exhausted the list.
 *
 * Explicit-location tiers carry "within N miles" framing; the search
 * engine may or may not respect it, but it's the strongest hint we
 * can pass through the query string (the `webSearch.search` interface
 * does not expose provider-native location/radius params today).
 *
 * Timezone-derived tiers drop the radius language because the city
 * hint is only approximate; "within 100 miles" of an IANA timezone
 * city is misleading at best.
 *
 * `none` returns an empty list — the caller short-circuits and emits
 * a "set a location" message instead.
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
    case 'timezone-derived': {
      const loc = ctx.cityHint;
      return [
        `local news in ${loc} from the last 24 hours`,
        `regional news around ${loc} from the last 3 days`,
        `regional news around ${loc} from the last 7 days`,
        `top news in ${loc} area from the last 7 days`,
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
 * The "no location" section body. Surfaced when the user has "Local
 * News" in their interests but neither `KILOCLAW_USER_LOCATION` nor a
 * usable `KILOCLAW_USER_TIMEZONE` is set. Nudges them toward the
 * Settings → Morning Briefing card.
 */
export const LOCAL_NEWS_NO_LOCATION_LINES: readonly string[] = [
  'Set a location in Settings → Morning Briefing to enable local news.',
];

/** Source-status footer summary when no location is resolvable. */
export const LOCAL_NEWS_NO_LOCATION_SUMMARY =
  'No location configured — set one in Settings to enable local news';
