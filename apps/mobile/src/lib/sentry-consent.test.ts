import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reinitSentryForConsent, sentryOptionsForConsent } from './sentry-consent';

const closeMock = vi.hoisted(() => vi.fn());

vi.mock('@sentry/react-native', () => ({ close: closeMock }));

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

describe('reinitSentryForConsent', () => {
  beforeEach(() => {
    closeMock.mockReset();
  });

  it('awaits Sentry.close() before re-initing with the new consent', async () => {
    const events: string[] = [];
    closeMock.mockImplementation(() => {
      events.push('close');
    });
    const init = vi.fn((consented: boolean) => {
      events.push(`init:${consented}`);
    });

    await reinitSentryForConsent(true, init);

    expect(events).toEqual(['close', 'init:true']);
  });

  it('serializes overlapping consent transitions', async () => {
    const events: string[] = [];
    const firstCloseGate = Promise.withResolvers<null>();
    closeMock.mockImplementationOnce(async () => {
      events.push('close');
      await firstCloseGate.promise;
    });
    closeMock.mockImplementation(() => {
      events.push('close');
    });
    const init = vi.fn((consented: boolean) => {
      events.push(`init:${consented}`);
    });

    void reinitSentryForConsent(true, init);
    const done = reinitSentryForConsent(false, init);

    // The second transition must not start (no second close, no init)
    // while the first close is still pending.
    await vi.waitFor(() => {
      expect(closeMock).toHaveBeenCalledTimes(1);
    });
    expect(init).not.toHaveBeenCalled();

    firstCloseGate.resolve(null);
    await done;

    expect(events).toEqual(['close', 'init:true', 'close', 'init:false']);
  });
});
