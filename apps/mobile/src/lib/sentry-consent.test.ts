import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reinitSentryForConsent, sentryOptionsForConsent } from './sentry-consent';

const closeMock = vi.hoisted(() => vi.fn());

vi.mock('@sentry/react-native', () => ({ close: closeMock }));

describe('sentryOptionsForConsent', () => {
  it('disables replay, screenshots, view-hierarchy, and tracing when consent is declined', () => {
    expect(sentryOptionsForConsent(false)).toEqual({
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      tracesSampleRate: 0,
      attachScreenshot: false,
      attachViewHierarchy: false,
    });
  });

  it('disables replay, screenshots, and view-hierarchy even when consent is accepted', () => {
    const options = sentryOptionsForConsent(true);

    expect(options.attachScreenshot).toBe(false);
    expect(options.attachViewHierarchy).toBe(false);
    expect(options.replaysSessionSampleRate).toBe(0);
    expect(options.replaysOnErrorSampleRate).toBe(0);
    expect(options.tracesSampleRate).toBe(0.1);
  });

  it('sets tracesSampleRate to 0 when optional consent is declined', () => {
    expect(sentryOptionsForConsent(false).tracesSampleRate).toBe(0);
  });

  it('sets tracesSampleRate to 0.1 when optional consent is accepted', () => {
    expect(sentryOptionsForConsent(true).tracesSampleRate).toBe(0.1);
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

  it('re-initialises with init(false) when Sentry.close() throws (fail-closed)', async () => {
    closeMock.mockRejectedValueOnce(new Error('close failed'));
    const events: string[] = [];
    const init = vi.fn((consented: boolean) => {
      events.push(`init:${consented}`);
    });
    const onFailure = vi.fn(() => {
      events.push('onFailure');
    });

    await reinitSentryForConsent(true, init, onFailure);

    expect(init).toHaveBeenCalledWith(false);
    expect(onFailure).toHaveBeenCalledOnce();
    // init(false) must run before onFailure.
    expect(events).toEqual(['init:false', 'onFailure']);
  });

  it('reports failure and keeps chain alive when init(false) throws', async () => {
    closeMock.mockRejectedValueOnce(new Error('close failed'));
    const init = vi.fn<(_: boolean) => void>().mockImplementationOnce(() => {
      throw new Error('init(false) failed');
    });
    const onFailure = vi.fn<() => void>();

    await reinitSentryForConsent(true, init, onFailure);

    // onFailure must run even though init(false) threw.
    expect(onFailure).toHaveBeenCalledOnce();
    // init was called with false (fail-closed attempt).
    expect(init).toHaveBeenCalledWith(false);

    // A later consent transition must still run — the chain must not reject.
    closeMock.mockResolvedValue(undefined);
    await reinitSentryForConsent(false, init);
    expect(init).toHaveBeenCalledWith(false);
    expect(init).toHaveBeenCalledTimes(2);
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
