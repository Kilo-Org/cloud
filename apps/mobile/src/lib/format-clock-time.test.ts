import { beforeEach, describe, expect, it, vi } from 'vitest';

import { formatClockTime } from './format';

/**
 * A device that pads a twelve-hour clock is what the helper answers, and no
 * Node ICU locale does it, so the formatter is the seam here: the fake serves
 * the parts a Gujarati device returns for 2:40 AM, and records the options the
 * helper asked for so the test can see the clock setting it read.
 */
const state = vi.hoisted(() => ({
  parts: [] as { type: string; value: string }[],
  uses24hourClock: null as boolean | null,
  options: [] as Intl.DateTimeFormatOptions[],
}));

vi.mock('@/lib/intl-cache', () => {
  const formatter = {
    format: () => state.parts.map(part => part.value).join(''),
    formatToParts: () => state.parts,
  };
  return {
    dateTimeFormat: (_locale: string | undefined, options: Intl.DateTimeFormatOptions) => {
      state.options.push(options);
      return formatter;
    },
    deviceDecimalSeparator: () => '.',
    deviceUses24hourClock: () => state.uses24hourClock,
    durationFormat: () => formatter,
    listFormat: () => formatter,
    numberFormat: () => ({ format: () => '0' }),
    segmenter: () => formatter,
  };
});

const when = new Date(2026, 0, 1, 2, 40);

beforeEach(() => {
  state.uses24hourClock = null;
  state.options.length = 0;
});

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

  it('asks for a twenty-four-hour clock on a device set to one, and keeps the padded hour', () => {
    state.uses24hourClock = true;
    state.parts = [
      { type: 'hour', value: '02' },
      { type: 'literal', value: ':' },
      { type: 'minute', value: '40' },
    ];

    expect(formatClockTime(when, 'en-US')).toBe('02:40');
    expect(state.options).toEqual([{ hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }]);
  });

  it('asks for a twelve-hour clock on a device set to one, and drops the padded hour', () => {
    state.uses24hourClock = false;
    state.parts = [
      { type: 'hour', value: '02' },
      { type: 'literal', value: ':' },
      { type: 'minute', value: '40' },
      { type: 'literal', value: ' ' },
      { type: 'dayPeriod', value: 'AM' },
    ];

    expect(formatClockTime(when, 'gu')).toBe('2:40 AM');
    expect(state.options).toEqual([{ hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }]);
  });

  it('passes no hour cycle when the device reports no setting', () => {
    state.parts = [{ type: 'minute', value: '40' }];

    formatClockTime(when, 'de');
    expect(state.options[0]).toEqual({ hour: 'numeric', minute: '2-digit' });
    expect(state.options[0]).not.toHaveProperty('hourCycle');
  });
});
