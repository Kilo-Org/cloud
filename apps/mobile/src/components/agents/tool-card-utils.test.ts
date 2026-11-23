import { describe, expect, it } from 'vitest';

import { getFilename, truncateText } from './tool-card-utils';

describe('getFilename', () => {
  it('returns the last path segment', () => {
    expect(getFilename('/workspace/project/report.pdf')).toBe('report.pdf');
    expect(getFilename('readme.txt')).toBe('readme.txt');
  });

  it('returns the input when there is no slash', () => {
    expect(getFilename('plain-name')).toBe('plain-name');
  });
});

describe('truncateText', () => {
  it('returns text no longer than the cap unchanged, with no ellipsis', () => {
    expect(truncateText('a short label', 20)).toBe('a short label');
    expect(truncateText('a'.repeat(20), 20)).toBe('a'.repeat(20));
    expect(truncateText('', 20)).toBe('');
  });

  it('cuts ASCII to exactly the cap plus one ellipsis', () => {
    expect(truncateText('a'.repeat(30), 20)).toBe(`${'a'.repeat(20)}\u2026`);
  });

  it('keeps a surrogate pair whole when the cut lands inside it', () => {
    // The emoji's high surrogate sits at index 4, one before the cap of 5.
    const result = truncateText('abcd\u{1F600}efgh', 5);
    expect(result).toBe('abcd\u{1F600}\u2026');
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('keeps a ZWJ family emoji whole when the cut lands inside it', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const result = truncateText(`ab${family}cd`, 4);
    expect(result).toBe(`ab${family}c\u2026`);
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('keeps a regional-indicator flag whole when the cut lands between its halves', () => {
    const flag = '\u{1F1F7}\u{1F1F8}';
    const result = truncateText(`ab${flag}cd`, 3);
    expect(result).toBe(`ab${flag}\u2026`);
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    // The result carries a whole pair of regional indicators, not one of them.
    const indicators = result.match(/[\u{1F1E6}-\u{1F1FF}]/gu) ?? [];
    expect(indicators.length % 2).toBe(0);
  });

  it('keeps a combining mark with its base character', () => {
    const result = truncateText('ae\u0301b', 2);
    expect(result).toBe('ae\u0301\u2026');
    expect(result).toContain('e\u0301');
  });

  it('keeps a Devanagari conjunct whole', () => {
    const conjunct = '\u0915\u094D\u0937';
    const result = truncateText(`a${conjunct}b`, 2);
    expect(result).toBe(`a${conjunct}\u2026`);
    expect(result).toContain('\u094D');
  });

  it('keeps every character of astral text whose code units exceed the cap', () => {
    const astral = '\u{1F600}'.repeat(10);
    expect(astral.length).toBe(20);
    expect(truncateText(astral, 12)).toBe(astral);
  });

  it('never returns a cluster truncated by the reading probe', () => {
    // A long run of combining marks must not be handed back as whole characters
    // when the probe stops inside it: the cap counts characters, so the cut
    // keeps the run's base letter and drops the run.
    const content = `${'x'.repeat(300)}${'\u0301'.repeat(4000)}tail`;
    const result = truncateText(content, 200);
    expect(result).toBe(`${'x'.repeat(200)}\u2026`);
    expect(/^x+\u2026$/.test(result)).toBe(true);
  });

  it('bounds the read when the label has far fewer characters than the cap', () => {
    // Thirty characters of 1 000 code units each: 30 000 code units in all, so
    // the value holds far fewer than the 60-character cap. Without the probe
    // ceiling the read grows to the whole value, comes back with all 30
    // characters and no ellipsis, and the polyfill on device pays the length
    // squared; the ceiling stops the read after three whole characters.
    const cluster = `a${'\u0301'.repeat(999)}`;
    const value = cluster.repeat(30);
    const result = truncateText(value, 60);
    expect(result.endsWith('\u2026')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(60 * 64 + 1);
    expect(result).toBe(`${cluster.repeat(3)}\u2026`);
  });
});
