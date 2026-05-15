import { describe, expect, it } from 'vitest';
import {
  buildLocalNewsSectionTitle,
  buildLocalNewsTiers,
  dedupeByUrl,
  extractCityFromTimezone,
  formatLocalNewsLine,
  LOCAL_NEWS_NO_LOCATION_LINES,
  LOCAL_NEWS_NO_LOCATION_SUMMARY,
  resolveLocationContext,
} from './local-news-utils';

describe('extractCityFromTimezone', () => {
  it('returns the city portion of a two-segment IANA tz', () => {
    expect(extractCityFromTimezone('America/Los_Angeles')).toBe('Los Angeles');
    expect(extractCityFromTimezone('Europe/London')).toBe('London');
  });

  it('returns the last segment for three-segment IANA tz', () => {
    expect(extractCityFromTimezone('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
  });

  it('returns null for single-segment values like UTC', () => {
    expect(extractCityFromTimezone('UTC')).toBeNull();
  });

  it('returns null for empty / null / undefined / whitespace', () => {
    expect(extractCityFromTimezone(undefined)).toBeNull();
    expect(extractCityFromTimezone(null)).toBeNull();
    expect(extractCityFromTimezone('')).toBeNull();
    expect(extractCityFromTimezone('   ')).toBeNull();
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(extractCityFromTimezone('  America/Chicago  ')).toBe('Chicago');
  });
});

describe('resolveLocationContext', () => {
  it('prefers KILOCLAW_USER_LOCATION when set', () => {
    expect(
      resolveLocationContext({
        KILOCLAW_USER_LOCATION: 'San Francisco, CA',
        KILOCLAW_USER_TIMEZONE: 'America/Los_Angeles',
      })
    ).toEqual({
      kind: 'explicit',
      raw: 'San Francisco, CA',
      displayLabel: 'San Francisco, CA',
    });
  });

  it('falls back to timezone city when location is empty', () => {
    expect(
      resolveLocationContext({
        KILOCLAW_USER_LOCATION: '   ',
        KILOCLAW_USER_TIMEZONE: 'America/Los_Angeles',
      })
    ).toEqual({
      kind: 'timezone-derived',
      timezone: 'America/Los_Angeles',
      cityHint: 'Los Angeles',
      displayLabel: 'Los Angeles area, from timezone',
    });
  });

  it('returns kind=none when neither env var is set', () => {
    expect(resolveLocationContext({})).toEqual({ kind: 'none' });
  });

  it('returns kind=none when timezone is unusable (UTC) and no location', () => {
    expect(resolveLocationContext({ KILOCLAW_USER_TIMEZONE: 'UTC' })).toEqual({ kind: 'none' });
  });
});

describe('buildLocalNewsSectionTitle', () => {
  it('includes explicit location in the parens', () => {
    expect(
      buildLocalNewsSectionTitle({
        kind: 'explicit',
        raw: 'San Francisco, CA',
        displayLabel: 'San Francisco, CA',
      })
    ).toBe('Local News (San Francisco, CA)');
  });

  it('marks timezone-derived sources in the parens', () => {
    expect(
      buildLocalNewsSectionTitle({
        kind: 'timezone-derived',
        timezone: 'America/Los_Angeles',
        cityHint: 'Los Angeles',
        displayLabel: 'Los Angeles area, from timezone',
      })
    ).toBe('Local News (Los Angeles area, from timezone)');
  });

  it('renders bare title when no location is resolvable', () => {
    expect(buildLocalNewsSectionTitle({ kind: 'none' })).toBe('Local News');
  });
});

describe('buildLocalNewsTiers', () => {
  it('issues four tiers with miles language for explicit locations', () => {
    const tiers = buildLocalNewsTiers({
      kind: 'explicit',
      raw: 'San Francisco, CA',
      displayLabel: 'San Francisco, CA',
    });
    expect(tiers).toHaveLength(4);
    expect(tiers[0]).toContain('within 100 miles');
    expect(tiers[0]).toContain('last 24 hours');
    expect(tiers[1]).toContain('within 250 miles');
    expect(tiers[1]).toContain('last 3 days');
    expect(tiers[2]).toContain('last 7 days');
    expect(tiers[3]).toContain('region');
    for (const tier of tiers) {
      expect(tier).toContain('San Francisco, CA');
    }
  });

  it('drops miles language for timezone-derived locations', () => {
    const tiers = buildLocalNewsTiers({
      kind: 'timezone-derived',
      timezone: 'America/Los_Angeles',
      cityHint: 'Los Angeles',
      displayLabel: 'Los Angeles area, from timezone',
    });
    expect(tiers).toHaveLength(4);
    for (const tier of tiers) {
      expect(tier).not.toContain('miles');
      expect(tier).toContain('Los Angeles');
    }
  });

  it('returns an empty list when there is no resolvable location', () => {
    expect(buildLocalNewsTiers({ kind: 'none' })).toEqual([]);
  });
});

describe('dedupeByUrl', () => {
  it('drops items whose URLs are already in the existing set', () => {
    const existing = [{ url: 'https://a.com', title: 'A' }];
    const fresh = [
      { url: 'https://a.com', title: 'A again' },
      { url: 'https://b.com', title: 'B' },
    ];
    expect(dedupeByUrl(fresh, existing)).toEqual([{ url: 'https://b.com', title: 'B' }]);
  });

  it('dedupes within the fresh batch itself', () => {
    const fresh = [
      { url: 'https://a.com', title: 'A1' },
      { url: 'https://a.com', title: 'A2' },
      { url: 'https://b.com', title: 'B' },
    ];
    expect(dedupeByUrl(fresh, [])).toEqual([
      { url: 'https://a.com', title: 'A1' },
      { url: 'https://b.com', title: 'B' },
    ]);
  });

  it('drops items with empty URLs', () => {
    const fresh = [
      { url: '', title: 'No URL' },
      { url: 'https://a.com', title: 'A' },
    ];
    expect(dedupeByUrl(fresh, [])).toEqual([{ url: 'https://a.com', title: 'A' }]);
  });

  it('returns an empty array when fresh is empty', () => {
    expect(dedupeByUrl([], [{ url: 'https://a.com', title: 'A' }])).toEqual([]);
  });
});

describe('formatLocalNewsLine', () => {
  it('renders a markdown bullet with title and URL', () => {
    expect(formatLocalNewsLine({ title: 'Big Story', url: 'https://x.com/y' })).toBe(
      '- [Big Story](https://x.com/y)'
    );
  });
});

describe('no-location copy', () => {
  it('exposes a single-line section body and a status summary', () => {
    expect(LOCAL_NEWS_NO_LOCATION_LINES).toHaveLength(1);
    expect(LOCAL_NEWS_NO_LOCATION_LINES[0]).toContain('Settings');
    expect(LOCAL_NEWS_NO_LOCATION_LINES[0]).toContain('Morning Briefing');
    expect(LOCAL_NEWS_NO_LOCATION_SUMMARY).toContain('No location');
  });
});
