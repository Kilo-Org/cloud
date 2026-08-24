import { describe, expect, it, vi } from 'vitest';

import {
  type ClawBillingStatus,
  deriveTrialBannerState,
  formatBillingDate,
  formatRemainingDays,
} from './hooks/use-kiloclaw-billing';

vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'en-GB',
}));

describe('KiloClaw billing trial display', () => {
  it('formats active sub-day trials without saying zero days left', () => {
    expect(formatRemainingDays(0)).toBe('Less than 1 day left');
    expect(formatRemainingDays(1)).toBe('1 day left');
    expect(formatRemainingDays(2)).toBe('2 days left');
  });

  it('treats active zero-day trials as ending soon rather than expired today', () => {
    const trial: NonNullable<ClawBillingStatus['trial']> = {
      startedAt: '2026-05-13T00:00:00.000Z',
      endsAt: '2026-05-14T00:00:00.000Z',
      daysRemaining: 0,
      expired: false,
    };

    expect(deriveTrialBannerState(trial)).toBe('trial_ending_very_soon');
  });

  it('formats billing dates with the resolved language', () => {
    expect(formatBillingDate('2027-03-01T00:00:00+00:00')).toBe('01/03/2027');
  });
});
