import { describe, expect, it } from 'vitest';

import { keepZoneWithDate } from './expiry-zone';

describe('keepZoneWithDate', () => {
  it('holds the ASCII zone to the date with a no-break space and its own direction', () => {
    expect(keepZoneWithDate('Expires 15 Oct 2027 (UTC)')).toBe(
      'Expires 15 Oct 2027\u00A0\u2068(UTC)\u2069'
    );
  });

  it('keeps the Chinese marker glued to the date without inventing a space', () => {
    expect(keepZoneWithDate('2027年10月15日到期（UTC）')).toBe(
      '2027年10月15日到期\u2068（UTC）\u2069'
    );
  });

  it('returns a sentence without a zone marker unchanged', () => {
    const sentence = 'Expires 15 Oct 2027';

    expect(keepZoneWithDate(sentence)).toBe(sentence);
  });

  it('keeps an already isolated marker whole instead of dropping characters', () => {
    const painted = keepZoneWithDate('Expires 15 Oct 2027\u00A0\u2068(UTC)\u2069');

    expect(painted.match(/\(UTC\)/g)).toHaveLength(1);
    expect(painted.replaceAll(/[\u2066\u2068\u2069]/g, '')).toBe('Expires 15 Oct 2027\u00A0(UTC)');
  });
});
