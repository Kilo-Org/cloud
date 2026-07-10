import { describe, expect, it } from 'vitest';

import { sentryOptionsForConsent } from './sentry-consent';

describe('sentryOptionsForConsent', () => {
  it('disables replay, screenshots, and view-hierarchy when consent is declined', () => {
    expect(sentryOptionsForConsent(false)).toEqual({
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      attachScreenshot: false,
      attachViewHierarchy: false,
    });
  });

  it('enables replay, screenshots, and view-hierarchy when consent is accepted', () => {
    const options = sentryOptionsForConsent(true);

    expect(options.attachScreenshot).toBe(true);
    expect(options.attachViewHierarchy).toBe(true);
    expect(options.replaysSessionSampleRate).toBeGreaterThan(0);
    expect(options.replaysOnErrorSampleRate).toBeGreaterThan(0);
  });
});
