import { describe, expect, it } from '@jest/globals';

import { KiloPassCadence } from '@/lib/kilo-pass/enums';

import { formatIsoDateLabel, getNextBonusCreditsDateInlineLabel } from './nextBonusCreditsLabels';

describe('nextBonusCreditsLabels', () => {
  it('formats ISO date labels deterministically when locale+timeZone are provided', () => {
    const result = formatIsoDateLabel({
      iso: '2030-01-01T00:00:00.000Z',
      locale: 'en-US',
      timeZone: 'UTC',
    });

    expect(result).toBe('Jan 1, 2030');
  });

  it('returns an inline date label for yearly cadence', () => {
    const result = getNextBonusCreditsDateInlineLabel({
      cadence: KiloPassCadence.Yearly,
      nextBonusCreditsAt: '2030-01-01T00:00:00.000Z',
      locale: 'en-US',
      timeZone: 'UTC',
    });

    expect(result).toBe('on Jan 1, 2030');
  });

  it('does not return an inline date label for monthly cadence', () => {
    const result = getNextBonusCreditsDateInlineLabel({
      cadence: KiloPassCadence.Monthly,
      nextBonusCreditsAt: '2030-01-01T00:00:00.000Z',
      locale: 'en-US',
      timeZone: 'UTC',
    });

    expect(result).toBeNull();
  });
});
