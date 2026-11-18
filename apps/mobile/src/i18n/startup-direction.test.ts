import { describe, expect, it } from 'vitest';

import { resolveLanguageStartupStep } from './startup-direction';

const ltr = { isRtl: false, shouldBeRtl: false } as const;
const rtlNeeded = { isRtl: false, shouldBeRtl: true } as const;

describe('resolveLanguageStartupStep', () => {
  it('applies in place when the native direction already matches', () => {
    expect(resolveLanguageStartupStep({ ...ltr, language: 'en', lastAttempt: null })).toBe('apply');
    expect(
      resolveLanguageStartupStep({
        isRtl: true,
        shouldBeRtl: true,
        language: 'ar',
        lastAttempt: 'ar',
      })
    ).toBe('apply');
  });

  it('relaunches once for a direction that has not been tried yet', () => {
    expect(resolveLanguageStartupStep({ ...rtlNeeded, language: 'ar', lastAttempt: null })).toBe(
      'reload'
    );
    // A different language's attempt never counts for this one.
    expect(resolveLanguageStartupStep({ ...rtlNeeded, language: 'ur', lastAttempt: 'ar' })).toBe(
      'reload'
    );
  });

  it('falls back instead of relaunching again for the same untaken direction', () => {
    expect(resolveLanguageStartupStep({ ...rtlNeeded, language: 'ar', lastAttempt: 'ar' })).toBe(
      'fallback'
    );
  });

  it('relaunches again when the direction must go back to LTR', () => {
    expect(
      resolveLanguageStartupStep({
        isRtl: true,
        shouldBeRtl: false,
        language: 'en',
        lastAttempt: 'ar',
      })
    ).toBe('reload');
  });
});
