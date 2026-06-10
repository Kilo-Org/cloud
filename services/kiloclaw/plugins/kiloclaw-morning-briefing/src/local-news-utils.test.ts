import { describe, expect, it } from 'vitest';
import {
  buildLocalNewsEmptyLine,
  buildLocalNewsSectionTitle,
  buildLocalNewsTiers,
  dedupeByUrl,
  formatLocalNewsLine,
  formatLocalNewsTldr,
  LOCAL_NEWS_NO_LOCATION_SUMMARY,
  resolveLocationContext,
} from './local-news-utils';

describe('resolveLocationContext', () => {
  it('returns explicit when KILOCLAW_USER_LOCATION is set', () => {
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

  it('returns kind=none with timezone context when only timezone is set', () => {
    expect(resolveLocationContext({ KILOCLAW_USER_TIMEZONE: 'America/Los_Angeles' })).toEqual({
      kind: 'none',
      timezone: 'America/Los_Angeles',
    });
  });

  it('returns kind=none with null timezone when nothing is set', () => {
    expect(resolveLocationContext({})).toEqual({ kind: 'none', timezone: null });
  });

  it('treats whitespace-only location as unset', () => {
    expect(
      resolveLocationContext({
        KILOCLAW_USER_LOCATION: '   ',
        KILOCLAW_USER_TIMEZONE: 'UTC',
      })
    ).toEqual({ kind: 'none', timezone: 'UTC' });
  });

  it('treats whitespace-only timezone as null', () => {
    expect(resolveLocationContext({ KILOCLAW_USER_TIMEZONE: '  ' })).toEqual({
      kind: 'none',
      timezone: null,
    });
  });
});

describe('buildLocalNewsSectionTitle', () => {
  it('includes explicit location in the parens with the section emoji', () => {
    expect(
      buildLocalNewsSectionTitle({
        kind: 'explicit',
        raw: 'San Francisco, CA',
        displayLabel: 'San Francisco, CA',
      })
    ).toBe('📰 Local News (San Francisco, CA)');
  });

  it('renders bare title when no location is resolvable', () => {
    expect(buildLocalNewsSectionTitle({ kind: 'none', timezone: null })).toBe('📰 Local News');
    expect(buildLocalNewsSectionTitle({ kind: 'none', timezone: 'America/Los_Angeles' })).toBe(
      '📰 Local News'
    );
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

  it('returns an empty list for the no-location context', () => {
    expect(buildLocalNewsTiers({ kind: 'none', timezone: null })).toEqual([]);
    expect(buildLocalNewsTiers({ kind: 'none', timezone: 'America/Los_Angeles' })).toEqual([]);
  });
});

describe('buildLocalNewsEmptyLine', () => {
  it('names the explicit location and wraps the line in italics', () => {
    const line = buildLocalNewsEmptyLine({
      kind: 'explicit',
      raw: 'San Francisco, CA',
      displayLabel: 'San Francisco, CA',
    });
    expect(line).toBe('_No notable news near San Francisco, CA from the last 24h._');
  });

  it('falls back to "your area" when there is no explicit location', () => {
    expect(buildLocalNewsEmptyLine({ kind: 'none', timezone: null })).toBe(
      '_No notable news near your area from the last 24h._'
    );
  });
});

describe('formatLocalNewsTldr', () => {
  it('pluralizes the headline count', () => {
    expect(formatLocalNewsTldr(3)).toBe('3 local headlines');
    expect(formatLocalNewsTldr(1)).toBe('1 local headline');
  });

  it('returns an empty string when there is nothing to count', () => {
    expect(formatLocalNewsTldr(0)).toBe('');
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

describe('LOCAL_NEWS_NO_LOCATION_SUMMARY', () => {
  it('mentions Settings and "no location"', () => {
    expect(LOCAL_NEWS_NO_LOCATION_SUMMARY).toContain('No location');
    expect(LOCAL_NEWS_NO_LOCATION_SUMMARY).toContain('Settings');
  });
});
