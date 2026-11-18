import { describe, expect, it, vi } from 'vitest';

import { formatClockTime } from './format';

/**
 * A device that pads a twelve-hour clock is what the helper answers, and no
 * Node ICU locale does it, so the formatter is the seam here: the fake serves
 * the parts a Gujarati device returns for 2:40 AM.
 */
const state = vi.hoisted(() => ({
  parts: [] as { type: string; value: string }[],
}));

vi.mock('@/lib/intl-cache', () => {
  const formatter = {
    format: () => state.parts.map(part => part.value).join(''),
    formatToParts: () => state.parts,
  };
  return {
    dateTimeFormat: () => formatter,
    deviceDecimalSeparator: () => '.',
    durationFormat: () => formatter,
    listFormat: () => formatter,
    numberFormat: () => ({ format: () => '0' }),
    segmenter: () => formatter,
  };
});

const when = new Date(2026, 0, 1, 2, 40);

describe('formatClockTime', () => {
  it('drops the leading zero of a padded twelve-hour hour', () => {
    state.parts = [
      { type: 'hour', value: '02' },
      { type: 'literal', value: ':' },
      { type: 'minute', value: '40' },
      { type: 'literal', value: ' ' },
      { type: 'dayPeriod', value: 'AM' },
    ];

    expect(formatClockTime(when, 'gu')).toBe('2:40 AM');
  });

  it('keeps a two-digit hour as it is', () => {
    state.parts = [
      { type: 'hour', value: '11' },
      { type: 'literal', value: ':' },
      { type: 'minute', value: '40' },
      { type: 'literal', value: ' ' },
      { type: 'dayPeriod', value: 'PM' },
    ];

    expect(formatClockTime(when, 'gu')).toBe('11:40 PM');
  });

  it('keeps the padded hour of a twenty-four-hour clock', () => {
    state.parts = [
      { type: 'hour', value: '02' },
      { type: 'literal', value: ':' },
      { type: 'minute', value: '40' },
    ];

    expect(formatClockTime(when, 'de')).toBe('02:40');
  });
});
